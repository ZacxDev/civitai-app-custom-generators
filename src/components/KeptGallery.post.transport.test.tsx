// POSTING A KEPT IMAGE, THROUGH THE REAL BRIDGE — every arm of it.
//
// 🔴 WHY THIS IS A TRANSPORT TEST AND NOT A COMPONENT TEST. `useCreatePostFromApp()`
// is not a seam this app injects: the component holds the hook, so a test that
// mocked `@civitai/blocks-react` or handed in a fake `createPost` would be
// asserting against its own stub. Everything that can actually go wrong on this
// path lives between the component and the host — the outbound
// `CREATE_POST_FROM_APP` payload, the inbound `CREATE_POST_RESULT` validator,
// and the SDK's error wrapping. So this file drives the REAL `App` inside the
// REAL mock host and lets all three run. It is the sibling of
// `Browse.gallery.transport.test.tsx`, written for the same reason: that defect
// lived in exactly the gap two isolated suites left.
//
// 🔴 THE PAYLOAD IS READ, NOT ASSUMED — AND THIS HEADER USED TO CLAIM THAT WHILE
// NOTHING DID IT. The sentence above said this file exercises "the outbound
// `CREATE_POST_FROM_APP` payload shape", and what it actually leaned on was the
// mock host's `sources` gate, which only checks that `sources` is a non-empty
// array. Everything else in the request was unobserved: SIX mutations of the
// `createPost({...})` call — dropping `title`, `detail`, `tags` or
// `modelVersionId`, reversing the image order, and deleting the eligibility
// filter that keeps an ineligible id out of the request — each left a fully
// green 442/442 run. `capturePostRequests()` below taps the mock host's
// `onOutbound` and the first two suites assert the request field by field, so a
// claim about the payload in this header is now a claim the file can keep.
// (What is still NOT asserted: the shapes the app never sends — `workflow`
// sources, several `sources` entries — because nothing here can produce one.)
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

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockCreatePostResult, BlockGatedImage } from '@civitai/app-sdk/blocks';

import { Harness } from '@civitai/blocks-react/testing';

import { App, type AppDeps } from '../App.js';
import type { DraftStore } from '../lib/drafts.js';
import { listKeptRuns, saveKeptRun, type KeptRun } from '../lib/runs.js';
import { fakeShared, memoryDraftStore } from '../test-helpers.js';
import { palette } from '../theme.js';
import { KeptGallery } from './KeptGallery.js';

const VIEWER = { id: 99, username: 'me' };
const RATED_ID = 90_210;
const PENDING_ID = 90_211;
const RATED_B = 90_212;
const RATED_C = 90_213;

/** A kept image something HAS rated — the only shape the post service accepts. */
function ratedImage(imageId: number): BlockGatedImage {
  return {
    imageId,
    status: 'visible',
    nsfwLevel: 1,
    contentRating: 'pg',
    url: `https://image.civitai.com/mock/gated-${imageId}.jpeg`,
    width: 1024,
    height: 1024,
  };
}

const rated: BlockGatedImage = ratedImage(RATED_ID);

/**
 * Tap the mock host's outbound stream and keep every `CREATE_POST_FROM_APP`
 * REQUEST, in send order, with the transport's `requestId` stripped.
 *
 * 🔴 THIS IS THE INSTRUMENT THE FILE WAS MISSING, so it comes with its own
 * controls rather than being trusted. Positive: the first suite below asserts a
 * non-zero capture (`sent` has exactly one entry) before reading anything out of
 * it, so "no fields were wrong" can never be a reading of "nothing was
 * captured" — the reassuring-zero shape. Negative: the last assertion in the
 * blocked-attach suite requires the list to be EMPTY on a path where nothing may
 * be sent, which the same tap would report identically if it were wired to
 * nothing; that is why the empty reading is only ever taken in a test that has
 * a sibling proving the tap fires.
 */
function capturePostRequests() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    onOutbound: (msg: { type: string; payload?: unknown }) => {
      if (msg.type !== 'CREATE_POST_FROM_APP') return;
      const { requestId: _requestId, ...request } = (msg.payload ?? {}) as Record<string, unknown>;
      sent.push(request);
    },
  };
}

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

/** The image ids the viewer's kept runs still hold, read back from the STORE. */
async function keptImageIdsInStore(drafts: DraftStore): Promise<number[]> {
  const page = await listKeptRuns(drafts);
  return page.runs.flatMap((r) => r.imageIds);
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
  onOutbound?: (msg: { type: string; payload?: unknown }) => void;
  /** Override the App's clipboard seam (default: whatever jsdom provides). */
  copyToClipboard?: (text: string) => Promise<void>;
  /**
   * Make every WRITE to the kept-run store fail, AFTER the seed — the shape a
   * per-app row/byte quota produces. Reads still work, so the test can ask the
   * store what it really holds.
   */
  failStoreWrites?: boolean;
}): Promise<{ drafts: DraftStore }> {
  const seeded = await seededDrafts(opts.keptIds);
  const drafts: DraftStore = opts.failStoreWrites
    ? {
        ...seeded,
        set: async () => {
          throw new Error('quota exceeded');
        },
        delete: async () => {
          throw new Error('quota exceeded');
        },
      }
    : seeded;
  const shared = fakeShared([]);
  const deps: Partial<AppDeps> = {
    resolveResources: async () => [],
    shared: shared.shared,
    updateSharedGenerator: shared.update,
    drafts,
    ...(opts.copyToClipboard ? { copyToClipboard: opts.copyToClipboard } : {}),
  };
  render(
    <Harness
      viewer={VIEWER}
      theme="dark"
      consentGranted
      gatedImages={opts.gatedImages}
      createPostResult={opts.createPostResult}
      createPostError={opts.createPostError}
      onOutbound={opts.onOutbound}
      applyUrlToggles={false}
      showLog={false}
    >
      <App deps={deps} />
    </Harness>,
  );
  return { drafts };
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

  /**
   * 🔴 THE TRADE THIS APP DELIBERATELY TAKES, DRIVEN END TO END. The composer
   * used to carry `maxLength={255}` on the title, which stops the keyboard dead
   * with no sentence attached and goes wrong in the direction nobody can
   * recover from — if civitai ever relaxes the bound (their own comment says it
   * is deliberately STRICTER than the native post schema, which has no `.max()`
   * at all) the field silently refuses text the server would have taken, and
   * there is no message to read and nothing to click. So the field is unbounded
   * and the SERVER's sentence is the mechanism.
   *
   * Both halves are asserted here: a 300-character title is accepted by the
   * control IN FULL (the old `maxLength` would have truncated it to 255, so this
   * assertion is red on the pre-change tree), and the refusal civitai actually
   * sends for it reaches the viewer verbatim, in the composer, next to the field
   * they can now edit.
   */
  it('takes a title past the server bound, then renders the server’s own refusal', async () => {
    const user = userEvent.setup();
    // The literal sentence civitai's `validateBlockPostText` returns.
    const serverMessage = 'title exceeds 255 characters';
    await renderGallery({ gatedImages: [rated], keptIds: [RATED_ID], createPostError: serverMessage });

    const composer = await openComposer(user);
    const title = within(composer).getByTestId('kept-post-title');
    const long = 'n'.repeat(300);
    await user.click(title);
    await user.paste(long);

    // No keyboard stop: the control holds all 300 characters.
    expect(title).toHaveValue(long);

    await user.click(within(composer).getByTestId('kept-post-submit'));

    const err = await screen.findByTestId('kept-post-error');
    expect(err).toHaveAttribute('data-source', 'server');
    expect(err).toHaveTextContent('title exceeds 255 characters');
    // Still in the composer, with the title still there to shorten — the
    // recoverable direction.
    expect(screen.getByTestId('kept-post-composer')).toBeInTheDocument();
    expect(within(composer).getByTestId('kept-post-title')).toHaveValue(long);
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
            posting={{ onPosted: () => {} }}
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

/**
 * 🔴 WHAT ACTUALLY GOES ON THE WIRE — the suite this file's header claimed to be
 * and was not. Six mutations of the `createPost({...})` call survived a fully
 * green 442/442 run, because nothing between the composer and the mock host ever
 * read the request: the mock gates `sources` on being a non-empty array and is
 * indifferent to everything else in it.
 *
 * Read the request FIELD BY FIELD rather than as one `toEqual`, so a mutant
 * fails on the assertion that names the field it removed instead of on a diff a
 * reader has to interpret — and finish on the KEY SET, which is the only thing
 * that can see a field being ADDED.
 */
describe('the outbound CREATE_POST_FROM_APP request', () => {
  /** A run of three, so the pick order can be something other than the grid's. */
  const THREE = [RATED_ID, RATED_B, RATED_C];

  it('carries exactly what the composer collected, in the order the viewer picked', async () => {
    const user = userEvent.setup();
    const cap = capturePostRequests();
    await renderGallery({
      gatedImages: THREE.map(ratedImage),
      keptIds: THREE,
      createPostResult: { postId: 71, url: 'https://civitai.com/posts/71', imageIds: [RATED_C, RATED_ID] },
      onOutbound: cap.onOutbound,
    });

    await user.click(await screen.findByTestId('tab-kept'));
    const gallery = await screen.findByTestId('browse-kept-gallery');
    await waitFor(() => expect(within(gallery).getAllByTestId('kept-cell')).toHaveLength(3));
    await waitFor(() =>
      expect(within(gallery).getAllByTestId('kept-cell')[2]).toHaveAttribute('data-postable', 'true'),
    );
    await user.click(screen.getByTestId('kept-post-start'));

    const cellFor = (id: number) =>
      within(gallery)
        .getAllByTestId('kept-cell')
        .find((el) => el.getAttribute('data-image-id') === String(id))!;

    // 🔴 THIRD, THEN FIRST. Picking in grid order would make a reversed request
    // indistinguishable from a correct one for the first two ids, and picking
    // two adjacent ones would let a sort slip through. The composer says "in the
    // order you picked them", so the order is a claim and has to be asserted
    // against an order the grid does NOT already have.
    await user.click(cellFor(RATED_C));
    await user.click(cellFor(RATED_ID));
    await waitFor(() => expect(screen.getByTestId('kept-post-count')).toHaveTextContent('2 selected'));
    await user.click(screen.getByTestId('kept-post-open'));

    const composer = await screen.findByTestId('kept-post-composer');
    await user.type(within(composer).getByTestId('kept-post-title'), 'Neon run');
    await user.type(within(composer).getByTestId('kept-post-detail'), 'Made with a custom generator.');
    await user.type(within(composer).getByTestId('kept-post-tags'), 'portrait, neon');
    await user.click(within(composer).getByTestId('kept-post-version'));
    await user.paste('https://civitai.com/models/133005?modelVersionId=782002');
    await user.click(within(composer).getByTestId('kept-post-submit'));

    await screen.findByTestId('kept-post-success');

    // POSITIVE CONTROL for the tap itself: a zero here would make every
    // assertion below vacuously true, so the count is read before the content.
    expect(cap.sent).toHaveLength(1);
    const request = cap.sent[0]!;

    // The images, and the order — the two things the viewer chose by clicking.
    expect(request.sources).toEqual([{ kind: 'published', imageIds: [RATED_C, RATED_ID] }]);
    expect(request.title).toBe('Neon run');
    expect(request.detail).toBe('Made with a custom generator.');
    expect(request.tags).toEqual(['portrait', 'neon']);
    expect(request.modelVersionId).toBe(782002);
    // Nothing else — a field this app never means to send (a second source, a
    // `workflow` arm, a stray key) would show up here and nowhere else.
    expect(Object.keys(request).sort()).toEqual([
      'detail',
      'modelVersionId',
      'sources',
      'tags',
      'title',
    ]);
  });

  /**
   * 🔴 THE OPTIONAL FIELDS ARE OMITTED, NOT SENT EMPTY. The SDK forwards any key
   * it is given, and the server treats an empty `title` as a title; the composer
   * trims and drops instead, which is only observable out here.
   */
  it('omits every optional field the viewer left alone', async () => {
    const user = userEvent.setup();
    const cap = capturePostRequests();
    await renderGallery({
      gatedImages: [rated],
      keptIds: [RATED_ID],
      createPostResult: POST,
      onOutbound: cap.onOutbound,
    });

    const composer = await openComposer(user);
    // A title of pure whitespace — the shape that distinguishes "trimmed away"
    // from "never typed".
    await user.type(within(composer).getByTestId('kept-post-title'), '   ');
    await user.click(within(composer).getByTestId('kept-post-submit'));

    await screen.findByTestId('kept-post-success');
    expect(cap.sent).toHaveLength(1);
    expect(Object.keys(cap.sent[0]!)).toEqual(['sources']);
  });

  /**
   * 🔴 THE SAFETY FILTER THAT HAD NO KILLING TEST. `selectedIds` reads the
   * viewer's selection THROUGH the live postable set, because `selected` holds
   * IDS and a cell can stop being postable underneath them. Sending an
   * ineligible id does not cost that image — `resolveAppPublishedImages` refuses
   * unresolvable ids rather than skipping them, so it costs the WHOLE post, with
   * one deliberately-uninformative sentence to explain it.
   *
   * ⚠️ WHAT THIS FIXTURE MODELS, STATED PLAINLY. The `runs` prop changes under
   * the grid — which is what `App` does to it: `setKeptRuns` fires on a re-list,
   * on a fresh keep, and (since `posting.onPosted`) on the prune that follows a
   * post. It does NOT model the second reachable mechanism, a `retryRead` that
   * re-asks the gate and gets a different verdict for an id already on screen;
   * that one needs a failed read on a second page and is not exercised here.
   */
  it('sends only the ids the grid still considers eligible', async () => {
    const user = userEvent.setup();
    const cap = capturePostRequests();
    const twoIds = [RATED_ID, RATED_B];
    const runWith = (imageIds: number[]): KeptRun => ({
      id: 'k00001',
      keptAt: 1_000,
      imageIds,
      generatorName: 'Neon Portrait Studio',
      buttonLabel: 'Cyberpunk',
    });
    const gallery = (runs: KeptRun[]) => (
      <Harness
        viewer={VIEWER}
        theme="dark"
        consentGranted
        createPostResult={{ postId: 72, url: 'https://civitai.com/posts/72', imageIds: [RATED_B] }}
        onOutbound={cap.onOutbound}
        applyUrlToggles={false}
        showLog={false}
      >
        <KeptGallery
          posting={{ onPosted: () => {} }}
          runs={runs}
          c={palette()}
          getImages={async (ids) => ids.map(ratedImage)}
          emptyTitle="Nothing kept yet"
          emptyBody="Keep a generation and it will be here next time."
          onOpenCell={() => {}}
          data-testid="browse-kept-gallery"
        />
      </Harness>
    );

    const { rerender } = render(gallery([runWith(twoIds)]));
    const grid = await screen.findByTestId('browse-kept-gallery');
    await waitFor(() => expect(within(grid).getAllByTestId('kept-cell')).toHaveLength(2));
    await waitFor(() =>
      expect(within(grid).getAllByTestId('kept-cell')[1]).toHaveAttribute('data-postable', 'true'),
    );
    await user.click(screen.getByTestId('kept-post-start'));
    for (const cell of within(grid).getAllByTestId('kept-cell')) await user.click(cell);
    expect(screen.getByTestId('kept-post-count')).toHaveTextContent('2 selected');

    // The kept set loses the first image while it is still SELECTED. Same
    // component, same mount — only the prop moved.
    rerender(gallery([runWith([RATED_B])]));
    await waitFor(() => expect(screen.getByTestId('kept-post-count')).toHaveTextContent('1 selected'));

    await user.click(screen.getByTestId('kept-post-open'));
    const composer = await screen.findByTestId('kept-post-composer');
    await user.click(within(composer).getByTestId('kept-post-submit'));

    await screen.findByTestId('kept-post-success');
    expect(cap.sent).toHaveLength(1);
    // The dropped id is GONE from the request, not merely last in it.
    expect(cap.sent[0]!.sources).toEqual([{ kind: 'published', imageIds: [RATED_B] }]);
  });
});

/**
 * 🔴 AN UNREADABLE ATTACH USED TO PUBLISH THE POST WITHOUT IT. `versionLooksWrong`
 * drove the field's inline error and nothing else: the submit button stayed
 * enabled, `submitPost` omitted the key, and a public post was created with no
 * gallery attach while the images left this app's grid for good. The server
 * cannot save anyone here — it never sees the field.
 */
describe('a model link the app cannot read blocks the post', () => {
  it('sends nothing at all, and publishes nothing', async () => {
    const user = userEvent.setup();
    const cap = capturePostRequests();
    await renderGallery({
      gatedImages: [rated],
      keptIds: [RATED_ID],
      createPostResult: POST,
      onOutbound: cap.onOutbound,
    });

    const composer = await openComposer(user);
    // A real model page url with no `?modelVersionId=` — what the address bar
    // holds before a version is picked, i.e. the likeliest wrong paste.
    await user.click(within(composer).getByTestId('kept-post-version'));
    await user.paste('https://civitai.com/models/133005');

    const submit = within(composer).getByTestId('kept-post-submit');
    expect(submit).toBeDisabled();
    await user.click(submit);

    // Nothing crossed the bridge, so nothing was published and the image is
    // still here to post properly. (The tap is proven to fire by the suite
    // above, which reads a non-zero capture through the same helper.)
    expect(cap.sent).toEqual([]);
    expect(screen.queryByTestId('kept-post-success')).not.toBeInTheDocument();
    expect(screen.getByTestId('kept-cell')).toBeInTheDocument();

    // And the viewer has the sentence that says what to do about it.
    expect(document.body.textContent).toContain(
      'That doesn’t look like a model version. Paste the page link from Civitai — the one with ?modelVersionId= in it.',
    );
  });
});

/**
 * 🔴 THE ONE HOLE IN "EVERY REFUSAL IS NAMED". Cancel was `disabled` while a post
 * was in flight, but `Modal`'s own exits — Escape, the overlay, the ✕ — were
 * not, and `Modal` returns `null` when closed. The `kept-post-error` banner is a
 * CHILD of that modal. So a viewer who pressed Escape while waiting on Civitai
 * got the refusal delivered into a component that no longer existed: no banner,
 * no success, a selection bar still reading "1 selected", and nothing anywhere
 * saying the post had been turned down.
 *
 * Driven by HOLDING the outbound frame rather than by faking `pending`, so the
 * post really is in flight across the real bridge for the duration of the
 * dismissal attempts.
 */
describe('a refusal that arrives after the viewer tries to leave', () => {
  it('still reaches them — the composer refuses to close while the post is in flight', async () => {
    const user = userEvent.setup();
    const serverMessage = 'You can only create 5 posts per hour';
    await renderGallery({ gatedImages: [rated], keptIds: [RATED_ID], createPostError: serverMessage });

    const composer = await openComposer(user);

    // Hold the ONE outbound frame. Same patch as the timeout test, except this
    // one REPLAYS it — so the host's refusal arrives late rather than never.
    const parent = window.parent as unknown as {
      postMessage: (msg: unknown, targetOrigin?: string) => void;
    };
    const send = parent.postMessage;
    let held: { msg: unknown; targetOrigin?: string } | null = null;
    parent.postMessage = (msg: unknown, targetOrigin?: string) => {
      if ((msg as { type?: string } | null)?.type === 'CREATE_POST_FROM_APP') {
        held = { msg, targetOrigin };
        return;
      }
      send.call(parent, msg, targetOrigin);
    };
    try {
      await user.click(within(composer).getByTestId('kept-post-submit'));
      await waitFor(() => expect(screen.getByTestId('kept-post-submit')).toBeDisabled());
      expect(screen.getByTestId('kept-post-submit')).toHaveTextContent('Waiting on Civitai…');

      // All three of `Modal`'s own exits, none of which went through the
      // disabled Cancel button.
      await user.keyboard('{Escape}');
      expect(screen.getByTestId('kept-post-composer')).toBeInTheDocument();

      await user.click(screen.getByLabelText('Close'));
      expect(screen.getByTestId('kept-post-composer')).toBeInTheDocument();

      const overlay = document.querySelector('[data-civitai-ui="modal-overlay"]')!;
      fireEvent.mouseDown(overlay);
      expect(screen.getByTestId('kept-post-composer')).toBeInTheDocument();
    } finally {
      parent.postMessage = send;
    }

    // Release the held frame: the host answers, refusing.
    await act(async () => {
      send.call(parent, held!.msg, held!.targetOrigin);
    });

    const err = await screen.findByTestId('kept-post-error');
    expect(err).toHaveAttribute('data-source', 'server');
    expect(err).toHaveTextContent(serverMessage);
    expect(screen.queryByTestId('kept-post-success')).not.toBeInTheDocument();
    // Still selected, still postable — the recoverable direction.
    expect(screen.getByTestId('kept-post-count')).toHaveTextContent('1 selected');
  });

  /**
   * NEGATIVE CONTROL: the guard is about the IN-FLIGHT window and nothing else.
   * With no post pending, Escape closes the composer exactly as it always did.
   */
  it('closes on Escape when nothing is in flight', async () => {
    const user = userEvent.setup();
    await renderGallery({ gatedImages: [rated], keptIds: [RATED_ID], createPostResult: POST });

    await openComposer(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('kept-post-composer')).not.toBeInTheDocument());
  });
});

/**
 * 🔴 THE SECOND EXIT FROM THE COMPOSER, WHICH THE `onClose` GUARD CANNOT REACH.
 * That guard keeps the Modal mounted against Escape, the overlay and the ✕ — but
 * the Modal, and with it the `kept-post-error` banner, was rendered ONLY in the
 * non-empty return: `if (feed.length === 0) return (…)` rendered the notice, the
 * success panel and `EmptyState`, and nothing else. So a kept set that EMPTIED
 * while a post was in flight unmounted the composer exactly as Escape used to,
 * and the guard could not help because it lived inside the dropped subtree.
 *
 * Reachable, and not exotic: `App` sets `keptRuns` to `[]` whenever `ready` or
 * `viewer` flips false and in the catch arm of a failed re-list, and the
 * in-flight window is up to ten minutes because the request waits on a human.
 * The timeout case in this same file documents hitting exactly that state — the
 * SDK's token housekeeping expiring under a fake clock, flipping `ready` false
 * and emptying the kept list.
 *
 * Driven the same way as the dismissal case above: the outbound frame is HELD,
 * so the post really is in flight across the real bridge while the feed empties.
 */
describe('a refusal that arrives after the grid has emptied', () => {
  it('still reaches them — the composer survives the kept set going empty mid-flight', async () => {
    const user = userEvent.setup();
    const serverMessage = 'You can only create 5 posts per hour';
    const runWith = (imageIds: number[]): KeptRun => ({
      id: 'k00001',
      keptAt: 1_000,
      imageIds,
      generatorName: 'Neon Portrait Studio',
      buttonLabel: 'Cyberpunk',
    });
    const gallery = (runs: KeptRun[]) => (
      <Harness
        viewer={VIEWER}
        theme="dark"
        consentGranted
        createPostError={serverMessage}
        applyUrlToggles={false}
        showLog={false}
      >
        <KeptGallery
          posting={{ onPosted: () => {} }}
          runs={runs}
          c={palette()}
          getImages={async (ids) => ids.map(ratedImage)}
          emptyTitle="Nothing kept yet"
          emptyBody="Keep a generation and it will be here next time."
          onOpenCell={() => {}}
          data-testid="browse-kept-gallery"
        />
      </Harness>
    );

    const { rerender } = render(gallery([runWith([RATED_ID])]));
    const composer = await openComposer(user, { viaTab: false });

    const parent = window.parent as unknown as {
      postMessage: (msg: unknown, targetOrigin?: string) => void;
    };
    const send = parent.postMessage;
    let held: { msg: unknown; targetOrigin?: string } | null = null;
    parent.postMessage = (msg: unknown, targetOrigin?: string) => {
      if ((msg as { type?: string } | null)?.type === 'CREATE_POST_FROM_APP') {
        held = { msg, targetOrigin };
        return;
      }
      send.call(parent, msg, targetOrigin);
    };
    try {
      await user.click(within(composer).getByTestId('kept-post-submit'));
      await waitFor(() => expect(screen.getByTestId('kept-post-submit')).toBeDisabled());

      // The kept set empties underneath the in-flight post — the state `App`
      // reaches by flipping `ready`/`viewer` false, by a failed re-list, or
      // simply by the viewer having posted everything they kept.
      rerender(gallery([]));
      await screen.findByTestId('browse-kept-gallery-empty');
    } finally {
      parent.postMessage = send;
    }

    // Release the held frame: the host answers, refusing.
    await act(async () => {
      send.call(parent, held!.msg, held!.targetOrigin);
    });

    const err = await screen.findByTestId('kept-post-error');
    expect(err).toHaveAttribute('data-source', 'server');
    expect(err).toHaveTextContent(serverMessage);
    // The composer is still there to read it in, and nothing claims a post was
    // made — the two halves the empty branch used to drop on the floor.
    expect(screen.getByTestId('kept-post-composer')).toBeInTheDocument();
    expect(screen.queryByTestId('kept-post-success')).not.toBeInTheDocument();
  });
});

/**
 * 🔴 THE POSTED IMAGES USED TO COME BACK, DEAD, FOREVER. `KeptGallery` dropped
 * the posted ids from its own state and the docblock over that state claimed the
 * drop prevented "cells that the very next mount renders as 'No longer
 * available'". It prevented nothing past the mount: the kept-run STORE still
 * held every posted id, and civitai's app-scoped read is conjoined with
 * `postId IS NULL`, so switching tabs brought them all back as permanent dead
 * tiles with the header still counting them.
 *
 * Two images in one run, one posted — so this also pins that the prune is scoped
 * to the named ids and cannot take the run's other image with it.
 */
describe('a posted image leaves the durable kept-run store', () => {
  it('is gone from storage, and does not come back on a tab round-trip', async () => {
    const user = userEvent.setup();
    const { drafts } = await renderGallery({
      gatedImages: [ratedImage(RATED_ID), ratedImage(RATED_B)],
      keptIds: [RATED_ID, RATED_B],
      createPostResult: { postId: 73, url: 'https://civitai.com/posts/73', imageIds: [RATED_ID] },
    });

    // PRE: both ids are really in the store, so a red assertion below is about
    // the prune rather than about the seeding.
    expect(await keptImageIdsInStore(drafts)).toEqual([RATED_ID, RATED_B]);

    await user.click(await screen.findByTestId('tab-kept'));
    const gallery = await screen.findByTestId('browse-kept-gallery');
    await waitFor(() => expect(within(gallery).getAllByTestId('kept-cell')).toHaveLength(2));
    await waitFor(() =>
      expect(within(gallery).getAllByTestId('kept-cell')[0]).toHaveAttribute('data-postable', 'true'),
    );
    await user.click(screen.getByTestId('kept-post-start'));
    await user.click(
      within(gallery)
        .getAllByTestId('kept-cell')
        .find((el) => el.getAttribute('data-image-id') === String(RATED_ID))!,
    );
    await user.click(screen.getByTestId('kept-post-open'));
    await user.click(within(await screen.findByTestId('kept-post-composer')).getByTestId('kept-post-submit'));
    await screen.findByTestId('kept-post-success');

    // The durable half: the posted id is gone from the store and the run's other
    // image is untouched.
    await waitFor(async () => expect(await keptImageIdsInStore(drafts)).toEqual([RATED_B]));

    // …and the viewer-visible half, which is the thing that was actually broken:
    // leave My gallery and come back. The panel is unmounted and rebuilt, so the
    // component's own session mask cannot be what is hiding the cell.
    await user.click(screen.getByTestId('tab-discover'));
    await waitFor(() => expect(screen.queryByTestId('browse-kept-gallery')).not.toBeInTheDocument());
    await user.click(screen.getByTestId('tab-kept'));

    const returned = await screen.findByTestId('browse-kept-gallery');
    await waitFor(() => expect(within(returned).getAllByTestId('kept-cell')).toHaveLength(1));
    expect(within(returned).getByTestId('kept-cell')).toHaveAttribute('data-image-id', String(RATED_B));
    expect(document.body.textContent).not.toContain('No longer available');
    // The tab's own count follows the store rather than continuing to count a
    // posted image.
    expect(screen.getByTestId('kept-summary')).toHaveTextContent('1 image kept from 1 run.');
  });

  /**
   * 🔴 THE SERVER'S ECHO DECIDES, NOT THE SELECTION — and the two used to be
   * different answers in one component (the grid removal read `selectedIds`, the
   * success sentence read `posted.imageIds`). The mock host's own default result
   * returns ids the block never sent, precisely to expose a block that conflates
   * them. A durable DELETE has to follow the echo: it removes exactly what
   * stopped resolving, never an image on the strength of having asked for it.
   */
  it('removes what the SERVER says joined the post, not what was selected', async () => {
    const user = userEvent.setup();
    const { drafts } = await renderGallery({
      gatedImages: [ratedImage(RATED_ID), ratedImage(RATED_B)],
      keptIds: [RATED_ID, RATED_B],
      // Selected below: RATED_ID. Echoed by the host: RATED_B.
      createPostResult: { postId: 74, url: 'https://civitai.com/posts/74', imageIds: [RATED_B] },
    });

    await user.click(await screen.findByTestId('tab-kept'));
    const gallery = await screen.findByTestId('browse-kept-gallery');
    await waitFor(() => expect(within(gallery).getAllByTestId('kept-cell')).toHaveLength(2));
    await waitFor(() =>
      expect(within(gallery).getAllByTestId('kept-cell')[0]).toHaveAttribute('data-postable', 'true'),
    );
    await user.click(screen.getByTestId('kept-post-start'));
    await user.click(
      within(gallery)
        .getAllByTestId('kept-cell')
        .find((el) => el.getAttribute('data-image-id') === String(RATED_ID))!,
    );
    await user.click(screen.getByTestId('kept-post-open'));
    await user.click(within(await screen.findByTestId('kept-post-composer')).getByTestId('kept-post-submit'));
    await screen.findByTestId('kept-post-success');

    await waitFor(async () => expect(await keptImageIdsInStore(drafts)).toEqual([RATED_ID]));
    await waitFor(() =>
      expect(within(screen.getByTestId('browse-kept-gallery')).getAllByTestId('kept-cell')).toHaveLength(1),
    );
    expect(within(screen.getByTestId('browse-kept-gallery')).getByTestId('kept-cell')).toHaveAttribute(
      'data-image-id',
      String(RATED_ID),
    );
  });

  /**
   * 🔴 WHEN THE PRUNE CANNOT BE WRITTEN, SAY SO — the branch that used to be an
   * EMPTY `catch` under a comment reading *"the next kept-runs read is
   * authoritative"*. It is authoritative about the STORE, which is precisely the
   * thing that did not get corrected: the un-pruned ids come back on the next
   * read as permanently-dead tiles, the exact defect the prune exists to remove,
   * with nothing said to the viewer and nothing reconciling the in-memory list
   * with what storage actually holds.
   *
   * The post itself is NOT in doubt here and the copy must not put it in doubt —
   * the success banner is up, and the sentence is about this app's own record.
   */
  it('says so when the post lands but the kept-run store refuses the prune', async () => {
    const user = userEvent.setup();
    const { drafts } = await renderGallery({
      gatedImages: [ratedImage(RATED_ID), ratedImage(RATED_B)],
      keptIds: [RATED_ID, RATED_B],
      createPostResult: { postId: 75, url: 'https://civitai.com/posts/75', imageIds: [RATED_ID] },
      failStoreWrites: true,
    });

    await user.click(await screen.findByTestId('tab-kept'));
    const gallery = await screen.findByTestId('browse-kept-gallery');
    await waitFor(() => expect(within(gallery).getAllByTestId('kept-cell')).toHaveLength(2));
    await waitFor(() =>
      expect(within(gallery).getAllByTestId('kept-cell')[0]).toHaveAttribute('data-postable', 'true'),
    );
    await user.click(screen.getByTestId('kept-post-start'));
    await user.click(
      within(gallery)
        .getAllByTestId('kept-cell')
        .find((el) => el.getAttribute('data-image-id') === String(RATED_ID))!,
    );
    await user.click(screen.getByTestId('kept-post-open'));
    await user.click(within(await screen.findByTestId('kept-post-composer')).getByTestId('kept-post-submit'));

    // The post SUCCEEDED — that half is unchanged and is said first.
    await screen.findByTestId('kept-post-success');

    const alert = await screen.findByTestId('kept-load-error');
    expect(alert).toHaveTextContent(
      'Your post went through, but this app couldn’t update My gallery — some of those images may still be listed here, and won’t load.',
    );
    // The store genuinely still holds the posted id, and the app's own count
    // agrees with it rather than with the correction it failed to make.
    expect(await keptImageIdsInStore(drafts)).toEqual([RATED_ID, RATED_B]);
    expect(screen.getByTestId('kept-summary')).toHaveTextContent('2 images kept from 1 run.');
  });
});

/**
 * 🔴 A SILENT COPY FAILURE LOOKED EXACTLY LIKE A MISSED CLICK. The post url is
 * the only way out of an `allow-scripts allow-forms` iframe, and
 * `copyToClipboard`'s own docblock says a silent failure there must be visible —
 * while the control answered a `false` by leaving its label at "Copy link".
 */
describe('the one-tap copy says whether it worked', () => {
  it('names the failure and points at the selectable url', async () => {
    const user = userEvent.setup();
    // The App's clipboard seam REJECTS — what `navigator.clipboard.writeText`
    // does in an iframe with no transient activation, and what the production
    // default does when `navigator.clipboard` is absent entirely. The `false`
    // the gallery sees is produced by App's own try/catch wrapper, not injected.
    await renderGallery({
      gatedImages: [rated],
      keptIds: [RATED_ID],
      createPostResult: POST,
      copyToClipboard: async () => {
        throw new Error('Clipboard unavailable');
      },
    });

    const composer = await openComposer(user);
    await user.click(within(composer).getByTestId('kept-post-submit'));
    const success = await screen.findByTestId('kept-post-success');

    await user.click(within(success).getByTestId('kept-post-copy'));

    await waitFor(() =>
      expect(screen.getByTestId('kept-post-copy')).toHaveTextContent('Couldn’t copy'),
    );
    expect(screen.getByTestId('kept-post-copy-failed')).toHaveTextContent(
      'Couldn’t copy it. The link above is selectable — copy it from there.',
    );
    // The url is still on screen to copy by hand, which is what the sentence
    // tells them to do.
    expect(screen.getByTestId('kept-post-url')).toHaveTextContent('https://civitai.com/posts/4242');
  });

  it('CONTROL: a working clipboard says so, and shows no failure line', async () => {
    const user = userEvent.setup();
    await renderGallery({
      gatedImages: [rated],
      keptIds: [RATED_ID],
      createPostResult: POST,
      copyToClipboard: async () => {},
    });

    const composer = await openComposer(user);
    await user.click(within(composer).getByTestId('kept-post-submit'));
    const success = await screen.findByTestId('kept-post-success');

    await user.click(within(success).getByTestId('kept-post-copy'));

    await waitFor(() => expect(screen.getByTestId('kept-post-copy')).toHaveTextContent('Link copied'));
    expect(screen.queryByTestId('kept-post-copy-failed')).not.toBeInTheDocument();
  });
});
