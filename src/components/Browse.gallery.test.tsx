// MY GALLERY — the app's terminal, driven end to end through the REAL App.
//
// 🔴 THIS IS DELIBERATELY A SEAM TEST, NOT A COMPONENT ONE. `Runner.keep.test.tsx`
// proves the keep bridge is called correctly and `runs.test.ts` proves the store
// round-trips; neither builds the COMBINED state, and the whole point of the
// terminal is that a thing made in the Runner is still there from Browse, after
// the Runner has been left. So this walks the actual journey — discover → run →
// keep → back → gallery — through `App` with only the host seams injected.
//
// The store instance is shared across the journey exactly as it is in production
// (one `useAppStorage`), so a keep that does not really persist cannot pass.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BlockGatedImage } from '@civitai/app-sdk/blocks';

import { Harness } from '@civitai/blocks-react/testing';

import { App, type AppDeps } from '../App.js';
import { buildPublishPayload, newButton, newGenerator } from '../lib/generator.js';
import type { DraftStore } from '../lib/drafts.js';
import { KEPT_PREFIX, listKeptRuns } from '../lib/runs.js';
import { TRUNCATION_NOTICE } from './KeptGallery.js';
import { fakeShared, immediateSleep, memoryDraftStore, mockWorkflow } from '../test-helpers.js';
import type { SharedListItem } from '@civitai/blocks-react';

const VIEWER_ID = 99;

const GEN = newGenerator({
  name: 'Neon Portrait Studio',
  description: 'One-click neon portraits.',
  buttons: [
    newButton({
      id: 'b1',
      label: 'Cyberpunk',
      workflowType: 'txt2img',
      checkpoint: { versionId: 1001, modelId: 500, modelName: 'DreamShaper', versionName: '8' },
      promptTemplate: 'cyberpunk {prompt}',
    }),
  ],
});

function publishedGenerator(key = 'shared:1'): SharedListItem {
  return {
    key,
    authorUserId: 7, // someone else's → lands in Discover
    value: buildPublishPayload(GEN),
    count: 3,
    viewerVoted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function visible(imageId: number): BlockGatedImage {
  return {
    imageId,
    status: 'visible',
    url: `https://img.example/${imageId}.jpg`,
    nsfwLevel: 1,
    contentRating: 'pg',
    width: 512,
    height: 512,
  };
}

function setup(depsOver: Partial<AppDeps> = {}, viewer: { id: number; username: string } | null = { id: VIEWER_ID, username: 'me' }) {
  const shared = fakeShared([publishedGenerator()]);
  const wf = mockWorkflow({ cost: 12, images: ['res.jpg'], polls: 1 });
  const drafts = memoryDraftStore();
  const keepOutputs = vi.fn(async () => [777]);
  const getImages = vi.fn(async (ids: number[]) => ids.map(visible));
  const deps: Partial<AppDeps> = {
    resolveResources: async () => [],
    shared: shared.shared,
    updateSharedGenerator: shared.update,
    drafts,
    estimate: wf.estimate,
    submit: wf.submit,
    poll: wf.poll,
    keepOutputs,
    getImages,
    pollIntervalMs: 0,
    sleep: immediateSleep,
    ...depsOver,
  };
  render(
    // 🔴 `viewer={null}` is the anonymous case and must be passed explicitly —
    // `undefined` lets the Harness fall back to its own default viewer, which
    // silently turns an anonymous test into a signed-in one.
    <Harness viewer={viewer} theme="dark" consentGranted showLog={false}>
      <App deps={deps} />
    </Harness>,
  );
  return { shared, drafts, keepOutputs, getImages };
}

/** Discover → open the published generator → run a button → succeed → keep it. */
async function runAndKeep() {
  await userEvent.click(await screen.findByTestId('published-open'));
  await screen.findByTestId('runner');
  await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
  await userEvent.click(screen.getByTestId('gen-button'));
  await userEvent.click(await screen.findByTestId('queue-confirm'));
  await screen.findByTestId('queue-results');
  await userEvent.click(screen.getByTestId('result-keep'));
  await screen.findByTestId('result-kept');
}

describe('the terminal, end to end', () => {
  /**
   * 🔴 THE HEADLINE BEHAVIOUR OF THIS PASS. Before it, a run ended at a thumbnail
   * in a queue the Runner documented as in-session — pressing Back cleared it and
   * nothing the viewer made survived. This asserts the opposite: the image is
   * still there from Browse, after the Runner has been left.
   */
  it('a kept image survives leaving the Runner and appears in My gallery, attributed', async () => {
    const { drafts, getImages } = setup();
    await runAndKeep();

    // Leave the Runner entirely — the thing that used to destroy the result.
    await userEvent.click(screen.getByTestId('runner-back'));
    await screen.findByTestId('browse');

    await userEvent.click(await screen.findByTestId('tab-kept'));
    const gallery = await screen.findByTestId('browse-kept-gallery');

    const cell = await within(gallery).findByTestId('kept-cell');
    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'visible'));
    expect(cell).toHaveAttribute('data-image-id', '777');
    // Attribution travels with the image, across generators.
    expect(within(gallery).getByTestId('kept-cell-attribution')).toHaveTextContent('Neon Portrait Studio');
    // …and it was resolved through the gate, by id.
    expect(getImages).toHaveBeenCalledWith([777]);

    // 🔴 It is genuinely PERSISTED, not merely in React state: the same store the
    // app writes through holds a well-formed record.
    const stored = (await listKeptRuns(drafts)).runs;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      imageIds: [777],
      generatorName: 'Neon Portrait Studio',
      generatorKey: 'shared:1',
      buttonLabel: 'Cyberpunk',
      prompt: 'a fox',
    });
  });

  it('counts kept IMAGES on the tab, and summarises runs separately', async () => {
    setup({ keepOutputs: vi.fn(async () => [1, 2, 3]) });
    await runAndKeep();
    await userEvent.click(screen.getByTestId('runner-back'));
    await screen.findByTestId('browse');

    // Three images from one run: the badge counts images, the summary says both.
    expect(await screen.findByTestId('tab-kept-count')).toHaveTextContent('3');
    await userEvent.click(screen.getByTestId('tab-kept'));
    expect(await screen.findByTestId('kept-summary')).toHaveTextContent('3 images kept from 1 run');
  });

  it('offers a way back to the generator that made a kept image', async () => {
    setup();
    await runAndKeep();
    await userEvent.click(screen.getByTestId('runner-back'));
    await userEvent.click(await screen.findByTestId('tab-kept'));

    const cell = await screen.findByTestId('kept-cell');
    await waitFor(() => expect(cell).toBeEnabled());
    await userEvent.click(cell);

    const open = await screen.findByTestId('lightbox-open-generator');
    expect(open).toHaveTextContent('Make another with Neon Portrait Studio');
    await userEvent.click(open);
    // …and it lands back in the Runner for that generator.
    await screen.findByTestId('runner');
    expect(screen.getByTestId('runner-title')).toHaveTextContent('Neon Portrait Studio');
  });

  /**
   * 🔴 The board read is ONE page and there is no get-a-generator-by-key seam, so
   * a kept image whose generator has been withdrawn (or sits past that page)
   * genuinely cannot be reopened. Saying so beats a control that does nothing.
   */
  it('says so when the generator behind a kept image is no longer on the board', async () => {
    const { shared } = setup();
    await runAndKeep();

    // The author withdraws it while the viewer is still in the Runner holding a
    // kept image; leaving re-lists the board, so it is genuinely gone from the
    // loaded page by the time the gallery renders.
    await shared.shared.withdraw('shared:1');

    await userEvent.click(screen.getByTestId('runner-back'));
    await screen.findByTestId('browse');
    await userEvent.click(screen.getByTestId('tab-kept'));
    const cell = await screen.findByTestId('kept-cell');
    await waitFor(() => expect(cell).toBeEnabled());
    await userEvent.click(cell);
    await userEvent.click(await screen.findByTestId('lightbox-open-generator'));

    expect(await screen.findByTestId('kept-open-error')).toHaveTextContent(/isn’t in the list right now/i);
    // The viewer is not stranded in a half-open state.
    expect(screen.queryByTestId('result-lightbox')).not.toBeInTheDocument();
  });

  it('shows an empty gallery honestly, with a route to a generator', async () => {
    setup();
    await userEvent.click(await screen.findByTestId('tab-kept'));
    expect(await screen.findByTestId('browse-kept-gallery-empty')).toHaveTextContent(/nothing kept yet/i);
    await userEvent.click(screen.getByTestId('kept-empty-discover'));
    expect(await screen.findByTestId('discover-list')).toBeInTheDocument();
  });
});

/**
 * 🔴 A FAILED READ IS NOT AN EMPTY GALLERY, AND THE APP USED TO SAY IT WAS. The
 * kept-runs load swallowed every error on the note that "the gallery renders its
 * own empty state" — it does, and that state reads *"Nothing kept yet"*. So the
 * one viewer who must never see that sentence, the one whose keeps exist but
 * could not be read, was the one guaranteed to. `KeptGallery`'s own `readError`
 * does not cover this: it is raised by a failed `getImages`, and a failed LIST
 * never reaches it.
 */
describe('a failed kept-runs read', () => {
  /**
   * Fails the KEPT list for the first `failures` calls; every other operation —
   * drafts included — is untouched, so the rest of the app behaves normally and
   * the assertion below is about the gallery alone.
   */
  function failingKeptList(inner: DraftStore, failures = Number.POSITIVE_INFINITY): DraftStore {
    let calls = 0;
    return {
      ...inner,
      async list(opts) {
        if (opts?.prefix === KEPT_PREFIX) {
          calls += 1;
          if (calls <= failures) throw new Error('kv unavailable');
        }
        return inner.list(opts);
      },
    };
  }

  it('says the load failed and does NOT claim the viewer has kept nothing', async () => {
    setup({ drafts: failingKeptList(memoryDraftStore()) });
    await userEvent.click(await screen.findByTestId('tab-kept'));

    expect(await screen.findByTestId('kept-load-error')).toHaveTextContent(
      /couldn’t load your kept images/i,
    );
    // 🔴 The whole point: the confident wrong sentence is absent, not merely
    // accompanied by a warning.
    expect(screen.queryByTestId('browse-kept-gallery-empty')).not.toBeInTheDocument();
    expect(screen.queryByText(/nothing kept yet/i)).not.toBeInTheDocument();
  });

  it('offers a retry that re-reads the store', async () => {
    setup({ drafts: failingKeptList(memoryDraftStore(), 1) });
    await userEvent.click(await screen.findByTestId('tab-kept'));
    await userEvent.click(await screen.findByTestId('kept-load-retry'));

    // Second read succeeds, so the failure clears and the honest empty state —
    // now actually earned — is what the viewer gets.
    await waitFor(() => expect(screen.queryByTestId('kept-load-error')).not.toBeInTheDocument());
    expect(await screen.findByTestId('browse-kept-gallery-empty')).toBeInTheDocument();
  });

  it('NEGATIVE CONTROL: a store that reads fine raises nothing', async () => {
    setup();
    await userEvent.click(await screen.findByTestId('tab-kept'));
    await screen.findByTestId('browse-kept-gallery-empty');
    expect(screen.queryByTestId('kept-load-error')).not.toBeInTheDocument();
  });
});

/**
 * 🔴 THE ONE-PAGE HORIZON, DISCLOSED. `listKeptRuns` reads a single KV page, so
 * past `KEPT_LIST_LIMIT` the grid is a prefix of the viewer's history presented
 * as the whole of it — and because the page is key-ordered it is their most
 * RECENT keeps that are missing. `runs.test.ts` drives the real fill condition
 * against the host's list contract; this asserts the signal survives the whole
 * chain (`listKeptRuns` → `App` → `Browse` → `KeptGallery`) and reaches a
 * viewer, which no unit test can see.
 */
describe('the kept-runs horizon is disclosed in the gallery', () => {
  /** The host emits `nextCursor` when its page fills; inject that signal directly. */
  function moreToRead(inner: DraftStore): DraftStore {
    return {
      ...inner,
      async list(opts) {
        const res = await inner.list(opts);
        return opts?.prefix === KEPT_PREFIX ? { ...res, nextCursor: 'more' } : res;
      },
    };
  }

  it('says so when the store had more than one page', async () => {
    setup({ drafts: moreToRead(memoryDraftStore()) });
    await runAndKeep();
    await userEvent.click(screen.getByTestId('runner-back'));
    await screen.findByTestId('browse');
    await userEvent.click(await screen.findByTestId('tab-kept'));

    const notice = await screen.findByTestId('browse-kept-gallery-truncated');
    expect(notice).toHaveTextContent(TRUNCATION_NOTICE);
    // 🔴 Alongside the grid, never instead of it — a disclosure that hides the
    // images is a worse answer than the one it replaced.
    expect(await screen.findByTestId('kept-cell')).toBeInTheDocument();
  });

  it('NEGATIVE CONTROL: a single-page store discloses nothing', async () => {
    setup();
    await runAndKeep();
    await userEvent.click(screen.getByTestId('runner-back'));
    await userEvent.click(await screen.findByTestId('tab-kept'));
    await screen.findByTestId('kept-cell');
    expect(screen.queryByTestId('browse-kept-gallery-truncated')).not.toBeInTheDocument();
  });
});

describe('the gallery tab only exists when it can', () => {
  /**
   * 🔴 Kept runs live in PER-USER storage. For an anonymous viewer the tab is not
   * an empty gallery, it is a gallery that cannot exist — and offering it would
   * be offering a dead end.
   */
  it('is absent for an anonymous viewer', async () => {
    setup({}, null);
    await screen.findByTestId('browse');
    expect(screen.queryByTestId('tab-kept')).not.toBeInTheDocument();
    expect(screen.getByTestId('tab-discover')).toBeInTheDocument();
    expect(screen.getByTestId('tab-mine')).toBeInTheDocument();
  });

  /**
   * 🔴 The roving-tabindex navigation walks the VISIBLE tabs. Walking the static
   * list instead would let `End` select a tab that is not in the DOM: the panel
   * would render nothing and the follow-up `.focus()` would find no element — a
   * dead tablist, with no error anywhere.
   */
  it('keyboard navigation never lands on the hidden gallery tab', async () => {
    setup({}, null);
    const discover = await screen.findByTestId('tab-discover');
    discover.focus();

    await userEvent.keyboard('{End}');
    await waitFor(() => expect(screen.getByTestId('tab-mine')).toHaveAttribute('aria-selected', 'true'));
    expect(screen.queryByTestId('tab-kept')).not.toBeInTheDocument();

    // Wrapping forward from the last visible tab returns to the first.
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(screen.getByTestId('tab-discover')).toHaveAttribute('aria-selected', 'true'));
  });

  it('reaches the gallery by keyboard when it IS available', async () => {
    setup();
    const discover = await screen.findByTestId('tab-discover');
    discover.focus();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(screen.getByTestId('tab-kept')).toHaveAttribute('aria-selected', 'true'));
    expect(await screen.findByTestId('kept-list')).toBeInTheDocument();
  });
});
