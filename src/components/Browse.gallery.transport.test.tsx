// MY GALLERY, THROUGH THE REAL BRIDGE — the one seam every other gallery test
// injects past.
//
// 🔴 WHY THIS FILE EXISTS, AND WHY THE SUITE WAS GREEN WHILE THE LIVE APP WAS
// BROKEN. `Browse.gallery.test.tsx` and `KeptGallery.test.tsx` both hand the
// component a hand-rolled `getImages`, so the gated read never leaves the test
// process: no `GET_IMAGES_BY_IDS` message, no host reply, and — the part that
// mattered — no `IMAGES_RESULT` PAYLOAD VALIDATOR. The defect lived in exactly
// that gap. Every component was verified in isolation and the thing that broke
// was the seam between them.
//
// 🔴 THE DEFECT, AS OBSERVED IN PRODUCTION. Opening "My gallery" showed
// *"Couldn’t load your kept images just now."* on first load; pressing
// "Try again" a moment later worked, on the same ids. Mechanism, end to end:
//
//   1. A kept image is the VIEWER'S OWN (this app publishes it for them). Until
//      something rates it, civitai's gate
//      (`block-gated-images.logic.ts` → `getBlockGatedImagesByIds`) returns it
//      to its author as `visible` WITH a url and WITHOUT `nsfwLevel` /
//      `contentRating`, carrying `ratingPending: true`.
//   2. `@civitai/blocks-react` <= 0.50.0's `isValidGatedImage` REQUIRED both
//      rating fields on every `visible` entry, so that entry failed — and
//      `isValidImagesResult` fails the WHOLE reply on one bad entry.
//   3. `IframeTransport.handleMessage` drops a reply that fails its validator
//      (console.warn, no rejection), so the pending `GET_IMAGES_BY_IDS` is never
//      answered and dies at the SDK's 30s `DEFAULT_REQUEST_TIMEOUT_MS`.
//   4. `KeptGallery`'s catch turns that into the sentence above.
//
// The retry worked because the poison shape is TIME-BOUNDED, not input-bound:
// once the image is rated the same ids produce a reply that validates. That is
// what made it read as a race on unchanged input.
//
// 🔴 WHAT THIS TEST PINS IS A RELATIONSHIP, NOT A VERSION. It does not assert a
// dependency range — it drives the app's own gallery against a host reply in the
// `ratingPending` shape and requires the cell to resolve. Any future SDK, host
// or app change that stops this app rendering an unrated own-image comes back
// through here, whatever the cause.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BlockGatedImage } from '@civitai/app-sdk/blocks';

import { Harness } from '../platform/testing.js';

import { App, type AppDeps } from '../App.js';
import type { DraftStore } from '../lib/drafts.js';
import { saveKeptRun } from '../lib/runs.js';
import { fakeShared, memoryDraftStore } from '../test-helpers.js';

const VIEWER = { id: 99, username: 'me' };
const KEPT_IMAGE_ID = 90_210;
const KEPT_URL = `https://image.civitai.com/mock/gated-${KEPT_IMAGE_ID}.jpeg`;

/**
 * The viewer's OWN image, published by this app and NOT YET RATED — a `visible`
 * entry with a url and no rating claim. This is the dominant shape in the
 * minutes after a Keep, which is exactly when a viewer opens My gallery.
 */
const ratingPendingImage: BlockGatedImage = {
  imageId: KEPT_IMAGE_ID,
  status: 'visible',
  ratingPending: true,
  url: KEPT_URL,
  width: 1024,
  height: 1024,
};

/** The same image once something HAS rated it — the control shape. */
const ratedImage: BlockGatedImage = {
  imageId: KEPT_IMAGE_ID,
  status: 'visible',
  nsfwLevel: 1,
  contentRating: 'pg',
  url: KEPT_URL,
  width: 1024,
  height: 1024,
};

async function seededDrafts(): Promise<DraftStore> {
  const drafts = memoryDraftStore();
  await saveKeptRun(drafts, {
    id: 'k00001',
    keptAt: 1_000,
    imageIds: [KEPT_IMAGE_ID],
    generatorName: 'Neon Portrait Studio',
    generatorKey: 'shared:1',
    buttonLabel: 'Cyberpunk',
  });
  return drafts;
}

/**
 * Render the real `App` against the real mock host, with the gated read left
 * ALONE — no `getImages` in `deps`, so `useGatedImages()` → `GET_IMAGES_BY_IDS`
 * → the mock host → `IMAGES_RESULT` → the SDK's payload validator all run. The
 * board is empty on purpose: it keeps this file's only gated read the gallery's.
 */
async function renderGallery(gatedImages: BlockGatedImage[]) {
  const drafts = await seededDrafts();
  const shared = fakeShared([]);
  const deps: Partial<AppDeps> = {
    resolveResources: async () => [],
    shared: shared.shared,
    updateSharedGenerator: shared.update,
    drafts,
  };
  render(
    <Harness
      viewer={VIEWER}
      theme="dark"
      consentGranted
      gatedImages={gatedImages}
      applyUrlToggles={false}
      showLog={false}
    >
      <App deps={deps} />
    </Harness>,
  );
}

describe('the gated read, across the real host bridge', () => {
  /**
   * 🔴 THE REGRESSION. Red on the tree that shipped (`2c4252e`,
   * `@civitai/blocks-react@0.46.0`): the reply is dropped by the validator, the
   * cell never leaves `loading`, and the app is on its way to the 30s timeout
   * that produced the operator's banner.
   */
  it('renders the viewer’s own NOT-YET-RATED kept image instead of failing the load', async () => {
    await renderGallery([ratingPendingImage]);

    await userEvent.click(await screen.findByTestId('tab-kept'));
    const gallery = await screen.findByTestId('browse-kept-gallery');
    const cell = await within(gallery).findByTestId('kept-cell');

    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'visible'));
    expect(within(cell).queryByTestId('kept-cell-placeholder')).not.toBeInTheDocument();

    // The operator-visible symptom, pinned as a whole string so a reword has to
    // come back through this test.
    expect(screen.queryByTestId('browse-kept-gallery-error')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(
      'Couldn’t load your kept images just now.',
    );
  });

  /**
   * 🔴 THE DISCRIMINATING CONTROL, and it is what makes the test above an
   * attribution rather than an observation. This one passes on BOTH trees, so a
   * red run above is a fact about the `ratingPending` SHAPE — not about the
   * harness, the seeding, the tab, or the bridge being wired at all.
   */
  it('CONTROL: the same journey with a RATED image resolves on every tree', async () => {
    await renderGallery([ratedImage]);

    await userEvent.click(await screen.findByTestId('tab-kept'));
    const cell = await screen.findByTestId('kept-cell');
    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'visible'));
  });

  /**
   * 🔴 POSITIVE CONTROL FOR THE ASSERTION ITSELF. The first test asserts an
   * ABSENCE (no error banner); an absence proves nothing until the same wiring
   * has been watched to PRODUCE the thing. A host that answers the gated read
   * with an error must surface exactly the operator's sentence, through the same
   * bridge.
   */
  it('POSITIVE CONTROL: a host-side gated-read failure DOES raise the banner', async () => {
    const drafts = await seededDrafts();
    const shared = fakeShared([]);
    render(
      <Harness
        viewer={VIEWER}
        theme="dark"
        consentGranted
        gatedImagesError="gated images unavailable"
        applyUrlToggles={false}
        showLog={false}
      >
        <App
          deps={{
            resolveResources: async () => [],
            shared: shared.shared,
            updateSharedGenerator: shared.update,
            drafts,
          }}
        />
      </Harness>,
    );

    await userEvent.click(await screen.findByTestId('tab-kept'));
    const alert = await screen.findByTestId('browse-kept-gallery-error');
    expect(alert).toHaveTextContent('Couldn’t load your kept images just now.');
  });
});
