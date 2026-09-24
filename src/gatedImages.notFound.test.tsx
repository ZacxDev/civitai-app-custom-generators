// WHAT THE APP DOES WHEN `blocks/gated-images` IS NOT DEPLOYED (`civitai#5112`).
//
// 🔴 THIS IS A MEASUREMENT, NOT A DESIGN. The route answers a Next.js HTML 404 in
// production today (probed unauthenticated 2026-09-24: 404 `text/html`, while five
// sibling `blocks/*` routes answer 401 — so it is undeployed, not misprobed). The
// PR body did not enumerate this route's failure mode at all, and the review that
// raised it named only the header/banner surface; neither said whether the app
// DEGRADES or BREAKS. Reading the code suggested it degrades — every call site has a
// `catch` — but "there is a catch" is not the same claim as "the page is usable", so
// this file exercises all three call sites and pins what a viewer actually gets.
//
// 🔴 THE THREE CALL SITES, all reached through `platform/images.ts:66`:
//   1. `App.tsx:550`        — Browse's DISCOVER COVER GRID (every card's cover)
//   2. `App.tsx:632`        — the generator HEADER BANNER in the Runner
//   3. `KeptGallery.tsx:510`— the KEPT-RUNS GALLERY grid
// Only the second had been named. The first is the one a signed-in viewer meets
// first, on the landing view, before touching anything.
//
// 🔴 WHAT THE 404 DOES MECHANICALLY. `@civitai/sdk`'s http layer reads the body,
// fails to `JSON.parse` the HTML, keeps it as text, and — because `!response.ok` —
// throws `ApiError(404, response.statusText, '<!DOCTYPE html>…')`. So `.message`
// is `'Not Found'` and `.body` is untrusted markup. Both are things a careless
// `catch` could render. THAT is the risk this file pins, not the missing image.
//
// 🔴 WHAT THIS FILE DOES AND DOES NOT PIN — mutation-measured, so the sentence
// above cannot drift into a stronger claim than the tests support.
//   KILLED (the file goes red):
//     · the Browse `catch` falling back to the UNMODERATED stored url — though
//       `components/Browse.test.tsx`'s "(a) a forged stored url is NEVER rendered
//       when resolution fails" already owned that rule and died to the same
//       mutation, so this file is not its only guard;
//     · `KeptGallery` swallowing the failed read silently;
//     · `KeptGallery` rendering the `ApiError`'s own `.message` instead of its
//       fixed sentence (the leak this file's helper exists for).
//   SURVIVED (the file stays GREEN — stated because a reader would assume otherwise):
//     · DELETING the `try/catch` at `App.tsx:550` entirely. Without it the gated
//       read rejects out of an async IIFE inside a `useEffect`: React does not treat
//       that as a render error, the board still paints, and the covers are simply
//       never resolved — the same thing a viewer sees WITH the catch. So this file
//       answers "does a 404 break the page?" (it does not) but it is NOT a guard on
//       that catch's existence, and nothing here should be quoted as one.
//
// 🔴 EVERY EXPECTATION IS A LITERAL, never an imported constant.
//
// 🔴 A FAKE PASSING IS EVIDENCE ABOUT THE FAKE. The 404 here is
// `platform/testing.tsx`'s `notFound()`, spelled as the HTML page Next.js really
// returns. Nothing in this file has run against a live civitai server — the
// route's production 404 was observed by probe, not by this suite.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BlockGatedImage } from '@civitai/app-sdk/blocks';

import { Harness } from './platform/testing.js';

import { App, type AppDeps } from './App.js';
import { defaultParams } from './lib/generator.js';
import { saveKeptRun } from './lib/runs.js';
import { fakeShared, immediateSleep, memoryDraftStore, mockWorkflow } from './test-helpers.js';
import type { DraftStore } from './lib/drafts.js';
import type { SharedListItem } from './platform/index.js';

const VIEWER = { id: 99, username: 'me' };
const HEADER_IMAGE_ID = 90_210;
const KEPT_IMAGE_ID = 90_211;
const HEADER_URL = `https://image.civitai.com/mock/gated-${HEADER_IMAGE_ID}.jpeg`;
const KEPT_URL = `https://image.civitai.com/mock/gated-${KEPT_IMAGE_ID}.jpeg`;

/** A published generator carrying a header image ref, so a cover is WANTED. */
function publishedWithCover(key: string, title: string): SharedListItem {
  return {
    key,
    authorUserId: 7,
    value: {
      title,
      body: 'A generator with a cover image.',
      data: {
        v: 1,
        headerImageRef: { imageId: HEADER_IMAGE_ID, url: HEADER_URL },
        buttons: [
          {
            id: 'b1',
            label: 'Glow',
            workflowType: 'txt2img',
            checkpoint: { versionId: 1001, modelId: 500 },
            loras: [],
            promptTemplate: 'neon {prompt}',
            params: defaultParams(),
          },
        ],
      },
    },
    count: 0,
    viewerVoted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function visible(imageId: number, url: string): BlockGatedImage {
  return { imageId, status: 'visible', nsfwLevel: 1, contentRating: 'pg', url, width: 1024, height: 1024 };
}

async function renderApp(opts: { notFound: boolean; kept?: boolean }) {
  const shared = fakeShared([publishedWithCover('shared:cover', 'Covered Generator')]);
  const wf = mockWorkflow({ cost: 12, images: ['https://image.civitai.com/out.jpeg'] });
  const drafts = memoryDraftStore();
  if (opts.kept) {
    await saveKeptRun(drafts as unknown as DraftStore, {
      id: 'k00001',
      keptAt: 1_000,
      imageIds: [KEPT_IMAGE_ID],
      generatorName: 'Covered Generator',
      buttonLabel: 'Glow',
    });
  }
  const deps: Partial<AppDeps> = {
    resolveResources: async () => [],
    shared: shared.shared,
    updateSharedGenerator: shared.update,
    drafts: drafts as unknown as DraftStore,
    estimate: wf.estimate,
    submit: wf.submit,
    poll: wf.poll,
    pollIntervalMs: 0,
    sleep: immediateSleep,
    getDeeplinkKey: () => null,
  };
  render(
    <Harness
      viewer={VIEWER}
      theme="dark"
      consentGranted
      buzzBudget={1000}
      buzz={{ balance: 5000 }}
      buzzBalance={{ blue: 0, green: 0, yellow: 5000 }}
      gatedImages={[visible(HEADER_IMAGE_ID, HEADER_URL), visible(KEPT_IMAGE_ID, KEPT_URL)]}
      gatedImagesNotFound={opts.notFound}
      applyUrlToggles={false}
      showLog={false}
    >
      <App deps={deps} />
    </Harness>,
  );
}

/**
 * The 404 page's own bytes, and the `ApiError`'s fallback message. If ANY of these
 * reach the document the app is leaking server internals onto the screen.
 */
function expectNoServerInternalsOnScreen() {
  const text = document.body.textContent ?? '';
  expect(text).not.toContain('<!DOCTYPE');
  expect(text).not.toContain('DOCTYPE');
  expect(text).not.toContain('blocks/gated-images');
  expect(text).not.toContain('Not Found');
  expect(text).not.toContain('404');
  expect(text).not.toContain('ApiError');
}

describe('the Browse cover grid (App.tsx:550) when the gated-images route 404s', () => {
  /**
   * POSITIVE CONTROL — and the whole file leans on it. Every "no cover is shown"
   * assertion below would pass against an app that never renders a cover at all,
   * or against a fixture whose card carries no header ref. This proves the cover
   * DOES render when the route answers, so its absence is attributable to the 404.
   */
  it('CONTROL: renders the cover when the route ANSWERS', async () => {
    await renderApp({ notFound: false });
    const card = await screen.findByTestId('published-card');
    const cover = await within(card).findByTestId('published-cover');
    expect(cover).toHaveAttribute('src', HEADER_URL);
  });

  it('DEGRADES: the card renders, with no cover and no error, and stays usable', async () => {
    await renderApp({ notFound: true });

    // The board loaded. This is the assertion that separates "degrades" from
    // "breaks": a throw escaping the effect would leave the ErrorBoundary fallback
    // here instead of the card.
    const card = await screen.findByTestId('published-card');
    expect(card).toHaveTextContent('Covered Generator');
    expect(screen.queryByTestId('app-error-boundary')).not.toBeInTheDocument();

    // No cover, and specifically NOT the unmoderated stored `url` from the shared
    // row — the fail-closed rule. `headerImageRef.url` is present in the fixture,
    // so a fall-through would show it.
    await waitFor(() => expect(within(card).queryByTestId('published-cover')).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain(HEADER_URL);

    // The app says NOTHING about the failed read on this surface. Recorded as the
    // measured behaviour, not endorsed: a viewer sees coverless cards and is given
    // no reason. That is a product judgement for the operator, not a crash.
    expectNoServerInternalsOnScreen();

    // Still interactive: the card's primary action works.
    expect(within(card).getByTestId('published-open')).toBeEnabled();
  });
});

describe('the generator header banner (App.tsx:632) when the gated-images route 404s', () => {
  it('CONTROL: renders the banner when the route ANSWERS', async () => {
    await renderApp({ notFound: false });
    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('published-open'));
    const banner = await screen.findByTestId('runner-header-banner');
    expect(banner).toHaveAttribute('src', HEADER_URL);
  });

  it('DEGRADES: the Runner opens and runs, with no banner', async () => {
    await renderApp({ notFound: true });
    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('published-open'));

    // The Runner opened — the failed read did not prevent navigation.
    const runner = await screen.findByTestId('runner');
    expect(within(runner).getByTestId('runner-title')).toHaveTextContent('Covered Generator');
    expect(screen.queryByTestId('runner-header-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-error-boundary')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(HEADER_URL);

    // 🔴 THE GENERATE PATH IS UNAFFECTED. A 404 on a cover read must not disable
    // the thing the viewer came for; this is the assertion that makes "degrades
    // gracefully" a claim about the app's PURPOSE and not just about its chrome.
    //
    // The button starts DISABLED for a reason that has nothing to do with the 404:
    // this generator's template carries a `{prompt}` token, so it is not runnable
    // until the prompt box has content. Typing is therefore part of the assertion,
    // not setup noise — it is what makes "enabled" attributable to the app being
    // healthy rather than to a button that was always enabled.
    const prompt = within(runner).getByTestId('runner-prompt');
    expect(prompt).toBeEnabled();
    await userEvent.type(prompt, 'a fox');
    await waitFor(() => expect(within(runner).getByTestId('gen-button')).toBeEnabled());
    expectNoServerInternalsOnScreen();
  });
});

describe('the kept-runs gallery (KeptGallery.tsx:510) when the gated-images route 404s', () => {
  it('CONTROL: resolves the kept cell when the route ANSWERS', async () => {
    await renderApp({ notFound: false, kept: true });
    await userEvent.click(await screen.findByTestId('tab-kept'));
    const gallery = await screen.findByTestId('browse-kept-gallery');
    const cell = await within(gallery).findByTestId('kept-cell');
    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'visible'));
    expect(within(gallery).queryByTestId('browse-kept-gallery-error')).not.toBeInTheDocument();
  });

  /**
   * 🔴 THIS IS THE ONE SURFACE THAT TELLS THE VIEWER, and the difference is
   * deliberate in `KeptGallery.tsx`: a placeholder in the KEPT grid is
   * indistinguishable from "your image is gone" unless the failure is named, so the
   * read error is surfaced with a retry. On Browse a missing cover is merely a
   * missing cover. Pinned here so the asymmetry is a tested decision rather than an
   * accident of which `catch` happened to set state.
   */
  it('DEGRADES: placeholders plus a NAMED failure and a working retry', async () => {
    await renderApp({ notFound: true, kept: true });
    await userEvent.click(await screen.findByTestId('tab-kept'));
    const gallery = await screen.findByTestId('browse-kept-gallery');

    // The grid renders, the cell is a definitive placeholder, not a perpetual
    // spinner, and the app did not crash.
    const cell = await within(gallery).findByTestId('kept-cell');
    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'missing'));
    expect(screen.queryByTestId('app-error-boundary')).not.toBeInTheDocument();

    // The viewer-facing sentence, pinned WHOLE so a reword comes back through here.
    const err = await within(gallery).findByTestId('browse-kept-gallery-error');
    expect(err).toHaveTextContent('Couldn’t load your kept images just now.');

    // 🔴 And the host's 404 page is NOT what it says. The untrusted body is the
    // thing a naive `catch (e) { setError(e.message) }` would have put here.
    expectNoServerInternalsOnScreen();

    // The retry control is offered and re-asks (it stays failed while the route is
    // still missing — the point is that the ids went back in the pool).
    const retry = within(gallery).getByTestId('browse-kept-gallery-retry');
    expect(retry).toBeEnabled();
    await userEvent.click(retry);
    await waitFor(() =>
      expect(within(gallery).getByTestId('browse-kept-gallery-error')).toHaveTextContent(
        'Couldn’t load your kept images just now.',
      ),
    );
  });
});
