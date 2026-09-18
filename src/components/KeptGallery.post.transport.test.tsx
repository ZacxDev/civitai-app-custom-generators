// POSTING A KEPT IMAGE, THROUGH THE REAL BRIDGE — every arm of it.
//
// 🔴 WHY THIS IS A TRANSPORT TEST AND NOT A COMPONENT TEST. `useCreatePostFromApp()`
// is not a seam this app injects: the component holds the hook, so a test that
// mocked `@civitai/blocks-react` or handed in a fake `createPost` would be
// asserting against its own stub. Everything that can actually go wrong on this
// path lives between the component and the host — the outbound
// `CREATE_POST_FROM_APP` payload shape (the mock host mirrors the real host's
// `sources` gate and refuses an empty array as `no images to post`), the inbound
// `CREATE_POST_RESULT` validator, and the SDK's error wrapping. So this file
// drives the REAL `App` inside the REAL mock host and lets all three run. It is
// the sibling of `Browse.gallery.transport.test.tsx`, written for the same
// reason: that defect lived in exactly the gap two isolated suites left.
//
// 🔴 EVERY EXPECTATION IS A LITERAL, NEVER AN IMPORTED CONSTANT — the house rule
// from `KeptGallery.test.tsx`, and it has a second payoff here: nothing in this
// file imports `lib/post.ts`, so it RUNS against the pre-change tree and fails on
// its assertions rather than dying at module resolution. A suite that cannot
// import reports "no tests", which is indistinguishable from a suite wired to
// nothing (see the repo's own notes on reassuring zeros).
//
// 🔴 WHAT THE MOCK HOST CANNOT PROVE, stated rather than implied. The consent
// dialog is HOST CHROME: the mock settles immediately where the real host waits
// on a click, and what that dialog SHOWS — the server's resolution of the
// request, the tags it actually matched, real thumbnails — has no mock analogue
// at all. `declined` is the only arm of the viewer's confirm that is exercised
// here, and never its timing or its content. Nothing in this file has run
// against the real host.

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockCreatePostResult, BlockGatedImage } from '@civitai/app-sdk/blocks';

import { Harness } from '@civitai/blocks-react/testing';

import { App, type AppDeps } from '../App.js';
import type { DraftStore } from '../lib/drafts.js';
import { saveKeptRun } from '../lib/runs.js';
import { fakeShared, memoryDraftStore } from '../test-helpers.js';
import { palette } from '../theme.js';
import { KeptGallery } from './KeptGallery.js';

const VIEWER = { id: 99, username: 'me' };
const RATED_ID = 90_210;
const PENDING_ID = 90_211;

/** A kept image something HAS rated — the only shape the post service accepts. */
const rated: BlockGatedImage = {
  imageId: RATED_ID,
  status: 'visible',
  nsfwLevel: 1,
  contentRating: 'pg',
  url: `https://image.civitai.com/mock/gated-${RATED_ID}.jpeg`,
  width: 1024,
  height: 1024,
};

/**
 * The viewer's OWN image that nothing has rated yet — `visible`, WITH a url, and
 * with neither `nsfwLevel` nor `contentRating`. This is the dominant shape in
 * the minutes after a Keep, and it is the one civitai's `resolveAppPublishedImages`
 * refuses — taking the WHOLE post down with it, because unresolvable ids are
 * refused rather than skipped.
 */
const ratingPending: BlockGatedImage = {
  imageId: PENDING_ID,
  status: 'visible',
  ratingPending: true,
  url: `https://image.civitai.com/mock/gated-${PENDING_ID}.jpeg`,
  width: 1024,
  height: 1024,
};

const POST: BlockCreatePostResult = {
  postId: 4242,
  url: 'https://civitai.com/posts/4242',
  imageIds: [RATED_ID],
};

async function seededDrafts(imageIds: number[]): Promise<DraftStore> {
  const drafts = memoryDraftStore();
  await saveKeptRun(drafts, {
    id: 'k00001',
    keptAt: 1_000,
    imageIds,
    generatorName: 'Neon Portrait Studio',
    generatorKey: 'shared:1',
    buttonLabel: 'Cyberpunk',
  });
  return drafts;
}

/**
 * Render the real `App` against the real mock host with the post bridge left
 * ALONE — no injected `createPost`, so `useCreatePostFromApp()` →
 * `CREATE_POST_FROM_APP` → the mock host → `CREATE_POST_RESULT` → the SDK's
 * payload validator all run. The board is empty so the only bridge traffic is
 * the gallery's.
 */
async function renderGallery(opts: {
  gatedImages: BlockGatedImage[];
  keptIds: number[];
  createPostResult?: BlockCreatePostResult;
  createPostError?: string;
}) {
  const drafts = await seededDrafts(opts.keptIds);
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
      gatedImages={opts.gatedImages}
      createPostResult={opts.createPostResult}
      createPostError={opts.createPostError}
      applyUrlToggles={false}
      showLog={false}
    >
      <App deps={deps} />
    </Harness>,
  );
}

/** Walk My gallery → selection → composer, stopping just before submit. */
async function openComposer(user: ReturnType<typeof userEvent.setup>, opts: { viaTab?: boolean } = {}) {
  if (opts.viaTab !== false) await user.click(await screen.findByTestId('tab-kept'));
  const gallery = await screen.findByTestId('browse-kept-gallery');
  const cell = await within(gallery).findByTestId('kept-cell');
  await waitFor(() => expect(cell).toHaveAttribute('data-state', 'visible'));
  await user.click(await screen.findByTestId('kept-post-start'));
  await user.click(cell);
  await waitFor(() => expect(screen.getByTestId('kept-post-count')).toHaveTextContent('1 selected'));
  await user.click(screen.getByTestId('kept-post-open'));
  return await screen.findByTestId('kept-post-composer');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('creating a post from My gallery, across the real host bridge', () => {
  it('posts the selected kept image and hands back the post url', async () => {
    const user = userEvent.setup();
    await renderGallery({ gatedImages: [rated], keptIds: [RATED_ID], createPostResult: POST });

    const composer = await openComposer(user);

    // 🔴 THE IRREVERSIBLE CONSEQUENCE, PINNED AS A WHOLE STRING. Posting removes
    // the image from this app's own grid for good (civitai's app-scoped read is
    // conjoined with `postId IS NULL`), and the host's confirm is about what is
    // being published rather than what is being given up. A reword of this
    // sentence has to come back through this test.
    expect(within(composer).getByTestId('kept-post-removal-warning')).toHaveTextContent(
      'Posting moves these images to your Civitai profile — they leave My gallery here, for good.',
    );

    await user.type(within(composer).getByTestId('kept-post-title'), 'Neon run');
    await user.click(within(composer).getByTestId('kept-post-submit'));

    const success = await screen.findByTestId('kept-post-success');
    expect(within(success).getByTestId('kept-post-url')).toHaveTextContent('https://civitai.com/posts/4242');
    expect(screen.queryByTestId('kept-post-error')).not.toBeInTheDocument();

    // The server has already dropped this image from the app's grid; the app
    // says so rather than leaving a cell that the next mount renders as "No
    // longer available".
    await waitFor(() => expect(screen.queryByTestId('kept-cell')).not.toBeInTheDocument());
  });

  it('says NOTHING when the viewer dismisses the host confirm', async () => {
    const user = userEvent.setup();
    await renderGallery({ gatedImages: [rated], keptIds: [RATED_ID], createPostError: 'declined' });

    const composer = await openComposer(user);
    await user.click(within(composer).getByTestId('kept-post-submit'));

    // `declined` is GUARANTEED to mean no post was created — the host takes its
    // consent latch synchronously before the write — so there is nothing to
    // report and nothing to undo. The composer stays open; no banner, no success,
    // and the image is still in the grid.
    await waitFor(() => expect(screen.getByTestId('kept-post-submit')).not.toBeDisabled());
    expect(screen.queryByTestId('kept-post-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kept-post-success')).not.toBeInTheDocument();
    expect(screen.getByTestId('kept-post-composer')).toBeInTheDocument();
    expect(screen.getByTestId('kept-cell')).toBeInTheDocument();
  });

  it('renders a FREE-TEXT server refusal verbatim', async () => {
    const user = userEvent.setup();
    // The shape the real host forwards from the post service: not a member of
    // the closed code set, so it must reach the viewer as written. A `switch`
    // over the union type would treat this as unmatched prose.
    const serverMessage = 'You can only create 5 posts per hour';
    await renderGallery({ gatedImages: [rated], keptIds: [RATED_ID], createPostError: serverMessage });

    const composer = await openComposer(user);
    await user.click(within(composer).getByTestId('kept-post-submit'));

    const err = await screen.findByTestId('kept-post-error');
    expect(err).toHaveTextContent(serverMessage);
    expect(err).toHaveAttribute('data-source', 'server');
    expect(screen.queryByTestId('kept-post-success')).not.toBeInTheDocument();
  });

  it('gives each CLOSED host refusal code its own sentence', async () => {
    const user = userEvent.setup();
    await renderGallery({ gatedImages: [rated], keptIds: [RATED_ID], createPostError: 'review-mode' });

    const composer = await openComposer(user);
    await user.click(within(composer).getByTestId('kept-post-submit'));

    const err = await screen.findByTestId('kept-post-error');
    expect(err).toHaveAttribute('data-source', 'code');
    expect(err).toHaveTextContent(
      'Posting is switched off in moderator review. Open Custom Generators normally and these images will post from there.',
    );
    // Not the raw code, which is a host token and not a sentence.
    expect(err).not.toHaveTextContent('review-mode');
  });

  /**
   * 🔴 THE ORDERING GUARD, DRIVEN THROUGH THE REAL TRANSPORT. A timeout has
   * `code === undefined` exactly like a forwarded server message does, so the
   * natural reading — "no code ⇒ render `.message`" — puts the SDK-internal
   * string `IframeTransport: request "CREATE_POST_FROM_APP" timed out after
   * 600000ms` in front of a viewer. It must instead say that the post MAY HAVE
   * LANDED, because nobody knows that it did not: the reply failed to arrive,
   * and the write is a public post under the viewer's own name.
   *
   * The host is silenced by dropping exactly one outbound message. The mock host
   * does NOT listen for `message` events — it PATCHES `window.parent.postMessage`
   * (an ordinary property on the stub parent it installs), so a capture-phase
   * listener + `stopImmediatePropagation()` silences nothing at all: the first
   * draft did that, and the post cheerfully succeeded. Wrapping the patched
   * function instead drops the `CREATE_POST_FROM_APP` frame and forwards
   * everything else, which is a genuine no-reply — what a timeout IS, rather
   * than a simulated error code.
   *
   * 🔴 THE ONE CASE THAT MOUNTS THE GALLERY DIRECTLY RATHER THAN THROUGH `App`,
   * AND THE REASON IS MEASURED, NOT STYLISTIC. Reaching the ceiling means moving
   * a fake clock ten minutes, and `vi.advanceTimersByTime` fires EVERY pending
   * timer — including the SDK's own token/context housekeeping, which expires
   * out from under `App`, flips `ready` false and empties the kept list. The
   * first draft of this test failed on exactly that: a "Nothing kept yet" panel
   * where the post banner should have been. Mounting the component under the
   * same `<Harness>` keeps the bridge entirely real — real `IframeTransport`,
   * real postMessage, real inbound validator — and removes the only moving part
   * the ten minutes were breaking.
   */
  it('a TRANSPORT TIMEOUT tells the viewer to check their profile, and never shows the SDK string', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let restore: (() => void) | undefined;
    try {
      render(
        <Harness viewer={VIEWER} theme="dark" consentGranted applyUrlToggles={false} showLog={false}>
          <KeptGallery
            posting
            runs={[
              {
                id: 'k00001',
                keptAt: 1_000,
                imageIds: [RATED_ID],
                generatorName: 'Neon Portrait Studio',
                buttonLabel: 'Cyberpunk',
              },
            ]}
            c={palette()}
            getImages={async () => [rated]}
            emptyTitle="Nothing kept yet"
            emptyBody="Keep a generation and it will be here next time."
            onOpenCell={() => {}}
            data-testid="browse-kept-gallery"
          />
        </Harness>,
      );
      const composer = await openComposer(user, { viaTab: false });

      // Drop the ONE outbound frame, leaving the rest of the bridge intact.
      const parent = window.parent as unknown as {
        postMessage: (msg: unknown, targetOrigin?: string) => void;
      };
      const send = parent.postMessage;
      parent.postMessage = (msg: unknown, targetOrigin?: string) => {
        if ((msg as { type?: string } | null)?.type === 'CREATE_POST_FROM_APP') return;
        send.call(parent, msg, targetOrigin);
      };
      restore = () => {
        parent.postMessage = send;
      };
      // POSITIVE CONTROL that the drop is real rather than a no-op: the very
      // same journey against an UNPATCHED host resolves (see the first test in
      // this file), so a timeout here is attributable to the missing reply.
      await user.click(within(composer).getByTestId('kept-post-submit'));

      // HUMAN_INTERACTION_TIMEOUT_MS is 10 minutes — the request waits on a
      // person, so the ceiling only ever bounds an abandoned dialog.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      });

      const err = await screen.findByTestId('kept-post-error');
      expect(err).toHaveAttribute('data-source', 'timeout');
      expect(err).toHaveTextContent(
        'Civitai didn’t answer in time. Your post may still have gone through — check your Civitai profile before posting these again.',
      );
      // 🔴 The whole point of the ordering. Asserted over the document, not the
      // banner, so it also catches the string leaking somewhere else.
      expect(document.body.textContent).not.toContain('IframeTransport');
      expect(document.body.textContent).not.toContain('timed out after');
      expect(screen.queryByTestId('kept-post-success')).not.toBeInTheDocument();
    } finally {
      restore?.();
    }
  });

  /**
   * 🔴 THE REFUSAL THE APP MUST PREVENT RATHER THAN SURFACE. `resolveAppPublishedImages`
   * requires `classifyGatedImageForViewer(...).status === 'visible'` for EVERY
   * named id and refuses unresolvable ids instead of skipping them, so ONE
   * freshly-kept image would fail the entire post at the confirm with a single
   * deliberately-uninformative sentence. The gated read already tells the client
   * which images those are — `ratingPending`, with no rating fields — so they are
   * not selectable in the first place.
   */
  it('will not let a NOT-YET-RATED image be selected, and says why', async () => {
    const user = userEvent.setup();
    await renderGallery({
      gatedImages: [rated, ratingPending],
      keptIds: [RATED_ID, PENDING_ID],
      createPostResult: POST,
    });

    await user.click(await screen.findByTestId('tab-kept'));
    const gallery = await screen.findByTestId('browse-kept-gallery');
    await waitFor(() => expect(within(gallery).getAllByTestId('kept-cell')).toHaveLength(2));
    await user.click(await screen.findByTestId('kept-post-start'));

    const cells = within(gallery).getAllByTestId('kept-cell');
    const pendingCell = cells.find((el) => el.getAttribute('data-image-id') === String(PENDING_ID))!;
    const ratedCell = cells.find((el) => el.getAttribute('data-image-id') === String(RATED_ID))!;

    // Both resolved `visible` WITH a url — the difference is the rating, which is
    // why a `data-state` check would not catch this.
    expect(pendingCell).toHaveAttribute('data-state', 'visible');
    expect(pendingCell).toHaveAttribute('data-postable', 'false');
    expect(pendingCell).toBeDisabled();
    expect(ratedCell).toHaveAttribute('data-postable', 'true');

    await user.click(pendingCell);
    expect(screen.getByTestId('kept-post-count')).toHaveTextContent('0 selected');
    expect(screen.getByTestId('kept-post-open')).toBeDisabled();

    // And the viewer is told, in the cell, rather than left to wonder why it is
    // inert. The wait is short and resolves itself.
    expect(screen.getByTestId('kept-cell-pending')).toHaveTextContent(
      'Still being rated — you can post this once that finishes.',
    );

    // CONTROL: the rated sibling selects normally through the same journey, so a
    // red assertion above is a fact about the RATING, not about selection being
    // broken.
    await user.click(ratedCell);
    expect(screen.getByTestId('kept-post-count')).toHaveTextContent('1 selected');
  });
});
