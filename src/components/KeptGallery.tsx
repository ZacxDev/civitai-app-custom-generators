// THE APP'S OWN GALLERY — the kept images a viewer has made here, resolved back
// through the host's per-viewer moderation gate.
//
// 🔴 THIS IS THE TERMINAL THE APP DID NOT HAVE. Precisely: a run used to end at a
// thumbnail in a queue documented as in-session, and while the images did reach
// the viewer's Civitai feed, the APP retained nothing — no record that the run
// happened, no link from an image to the generator that made it, no way back to
// it from inside the block. A kept run stores durable civitai `Image` ids (see
// lib/runs.ts); this component is where they come back, attributed.
//
// 🔴 IDS IN, URLS RESOLVED PER RENDER — never the other way round. `getImages`
// applies THIS viewer's browsing-level clamp server-side at read time, so a kept
// image whose moderation status later changes is re-evaluated on every view. A
// url cached at keep time would be a snapshot of a permission, which is exactly
// the mistake the cover-image path already refuses to make.
//
// 🔴 THREE OUTCOMES, ALL RENDERED, NONE COLLAPSED. The gate returns `visible`
// (url) or `hidden` (NO url), and OMITS ids it cannot resolve at all — so the
// returned array may be SHORTER than the request and a missing entry is not the
// same fact as a hidden one. `hidden` means "not being served to you right now",
// over FOUR distinct causes the gate deliberately does not distinguish (see
// {@link HIDDEN_CELL_NOTICE}); omitted means "this is gone". Rendering either as
// a broken `<img>` would be a moderation failure in the first case and a lie in
// the second.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { BlockCreatePostResult, BlockGatedImage } from '@civitai/app-sdk/blocks';
import { CreatePostError, useCreatePostFromApp } from '@civitai/blocks-react';
import { Alert, Badge, Button, Group, Modal, Stack, TextInput, Textarea } from '@civitai/blocks-react/ui';
import { Image } from '@civitai/components-react';

import {
  describeCreatePostError,
  isPostableGatedState,
  isRatingPending,
  parseModelVersionId,
  parsePostTags,
  POST_MAX_IMAGES,
  POST_SIGN_IN_NOTICE,
  type PostFailure,
} from '../lib/post.js';
import { chunkImageIds, keptImageFeed, type KeptImageCell, type KeptRun } from '../lib/runs.js';
import { CLASS_LIFT, motionClass, useMotion } from '../motion.js';
import { elevate, metaText, radius, token, type Palette } from '../theme.js';
import { EmptyState } from './EmptyState.js';

/** Cells revealed per "Show more" click. */
export const GALLERY_PAGE_SIZE = 12;

/**
 * 🔴 NO NUMBER, DELIBERATELY. This notice used to open *"Showing 200 kept
 * runs"* — a hardcoded constant rendered over whatever the grid actually had.
 * In the Runner, where the same component renders one generator's runs, that
 * told a viewer with two kept runs they were looking at two hundred; in Browse
 * it overstated whenever malformed rows were dropped. A count the component has
 * not derived from what it rendered is a claim it cannot keep, so there is none:
 * what remains is the one fact `truncated` actually carries.
 *
 * Bounded by what the code can see, and the bound is load-bearing. This sentence
 * is true of a COMPLETE key walk: `lib/runs.ts` walks the viewer's keys to the
 * end of the store and hydrates the TAIL, so "your most recent ones" is exactly
 * what the grid holds and what is missing is older. When the walk is cut short
 * the claim INVERTS — what is missing is then the viewer's newest — so that
 * state renders {@link INCOMPLETE_NOTICE} instead and this sentence is never
 * shown over it. See `KeptRunPage.incomplete` in `lib/runs.ts`.
 */
export const TRUNCATION_NOTICE =
  'Older keeps aren’t shown here — this app loads your most recent ones.';

/**
 * What the notice says when the key walk did not reach the end of the store —
 * `KeptRunPage.incomplete`.
 *
 * 🔴 THE ONE SENTENCE {@link TRUNCATION_NOTICE} CANNOT COVER. In that state the
 * app enumerated a prefix of the viewer's keys and hydrated the tail OF THE
 * PREFIX, so the keeps it is missing are the most recent ones — the opposite of
 * what the other notice asserts, rendered in the very state that would have
 * rendered it. The host's key list is forward-only, so this is disclosed rather
 * than fixed (see `KEPT_LIST_MAX_PAGES` in `lib/runs.ts`); disclosing it is what
 * keeps both sentences definite instead of hedging one into covering both.
 */
export const INCOMPLETE_NOTICE =
  'You’ve kept more than this app can list — your newest keeps may not be shown here.';

/**
 * What a cell says when the gate returned `hidden`.
 *
 * 🔴 THE DOMINANT CAUSE WAS THE SCAN, NOT THE BROWSING LEVEL, AND THIS LINE USED
 * TO NAME ONLY THE BROWSING LEVEL. `publishGenerationOutputs` creates each row
 * with `createImage` DEFAULT ingestion, which Prisma defaults to `Pending`, and
 * the gate (`block-gated-images.logic.ts`) returned `hidden` for anything not
 * terminally `Scanned` — with NO owner bypass, in its own words *"an
 * unscanned/flagged image is `hidden` for EVERYONE (including its author)"*. So
 * on the ordinary path — press Keep, the gallery mounts below the result and
 * reads within the same second — the viewer's own just-paid-for images came back
 * `hidden`, and *"Not shown at your browsing level"* told them Civitai had
 * withheld their own work from them.
 *
 * ⚠️ THAT OWNER SENTENCE IS NO LONGER TRUE, AND THE CORRECTION IS THE WHOLE
 * REASON THIS COMPONENT BROKE IN PRODUCTION. civitai/civitai#4895 added an
 * owner projection: `classifyGatedImageForViewer` now returns an internal
 * `pending` verdict for "nothing has rated this yet" (a non-terminal ingestion,
 * OR `Scanned` with `nsfwLevel === 0`), and `getBlockGatedImagesByIds` turns
 * that into `visible` + `ratingPending: true` — url, NO rating — **for the
 * image's own author**, and `hidden` for everyone else. This gallery only ever
 * renders the viewer's OWN kept images, so the just-kept case is now the
 * `ratingPending` shape rather than `hidden`. `@civitai/blocks-react` <= 0.50.0
 * rejected that shape in `isValidGatedImage`, which fails the WHOLE
 * `IMAGES_RESULT`, which the transport DROPS — so `getImages()` never resolved
 * and the read below died at the SDK's 30s request timeout, rendering
 * *"Couldn’t load your kept images just now."* over a perfectly good gallery.
 * Fixed by the 0.51.0 / app-sdk 0.42.0 pins (#22) and pinned, at the bridge
 * rather than at the component, by `Browse.gallery.transport.test.tsx`.
 *
 * What remains `hidden` for the AUTHOR is therefore narrower than the four
 * causes enumerated below: the moderation flags and hard block (3), the two
 * TERMINAL scan refusals (`Blocked` / `NotFound`), and the browsing ceiling (4).
 * The enumeration is kept whole because it is the gate's contract for every
 * viewer, and the copy stays soft for the reason given at the end of this block.
 *
 * 🔴 THE GATE HAS FOUR `hidden` CAUSES, NOT TWO, AND THIS BLOCK USED TO SAY
 * "both". Read off `classifyGatedImageForViewer` in order, an image is `hidden`
 * when: (1) `ingestion !== Scanned`; (2) `nsfwLevel === 0`, i.e. rated by
 * nothing yet; (3) ANY moderation flag is set — `needsReview`, `poi`, `minor`,
 * `tosViolation`, `acceptableMinor` or `blockedFor`; or (4) the image's level
 * does not intersect this viewer's browsing ceiling. The gate returns a bare
 * `hidden` for all four, so the component cannot know which applies and must
 * not pick.
 *
 * 🔴 CAUSE (1) IS SIX STATES, NOT FOUR, AND THIS BLOCK NAMED FOUR. Its test is
 * `!== Scanned` against an enum of SEVEN values, so it covers `Pending`,
 * `Error`, `Blocked`, `NotFound`, `PendingManualAssignment` and `Rescan`
 * (`ImageIngestionStatus`, civitai `packages/civitai-db-schema/src/enums.ts` and
 * `prisma/schema.full.prisma`, re-derived at `b441199dc6`). The four-name list
 * came from the gate's own inline comment, which reads *"Pending / Error /
 * Blocked / NotFound all hide"* — narrower than the line beneath it, and NOT the
 * enum. Read the enum, not that comment.
 *
 * 🔴 `Rescan` IS THE ONE THAT CHANGES WHAT THIS COMPONENT CAN PROMISE, AND THE
 * EVIDENCE FOR IT IS NOW A WRITER RATHER THAN AN INFERENCE. A round-4 audit
 * could not demonstrate a `Scanned` → `Rescan` writer and asked for this
 * paragraph to be weakened to "inferred"; re-derived by complete enumeration of
 * every `Rescan` write to `Image.ingestion` at civitai `5549de73`, it should be
 * STRENGTHENED instead. Four writers exist. `rescanArticle`
 * (`src/server/services/article.service.ts:2474-2486`, under a section header
 * reading *"Re-queue already-processed images for rescan"*) and
 * `rescanArticleImage` (`:2606-2614`) both filter candidates on
 * `ingestion !== Pending && !nsfwLevelLocked` and then set
 * `ingestion: Rescan` — so `Scanned` is not merely permitted, it is the
 * dominant member of the written set. `reprocess-exempt-blocked-images.ts:55`
 * writes it with an id-only `WHERE` and no prior-`ingestion` predicate at all.
 * Only the moderator stuck sweep is restricted (`rescanStuckImages`, whose
 * `stuckWhere()` selects `ingestion = 'Pending'`), which is why the weaker
 * "not ONLY from `Scanned`" clause stays. Corroborating, and independent: the
 * outbox trigger fires on
 * `OLD.ingestion != 'Rescan' AND NEW.ingestion = 'Rescan'` for any prior status
 * (`apps/event-engine/scripts/sql/outbox-triggers.sql:146`), and the scan-result
 * handler's `image.ingestion !== 'Rescan'` guard
 * (`src/pages/api/webhooks/image-scan-result.ts:1265`) exists to preserve a
 * `scannedAt` a `Rescan` row already carries.
 *
 * ⚠️ WHAT THAT DOES AND DOES NOT REACH, because the difference decides how
 * often this matters. Every demonstrated `Scanned` → `Rescan` writer selects
 * its rows through an **article** — an `ImageConnection` of type `Article`, or
 * an `Article.coverId` — or, for the admin backfill, through
 * `blockedFor = 'AiNotVerified'` on a profile/cover image. No writer at that ref
 * moves a bare generation-output image out of `Scanned`; the `image.rescan`
 * tRPC procedure, which sounds like it would, stamps `scanRequestedAt` and
 * never touches `ingestion`. So a kept cell goes `hidden` long after the keep
 * only once that image has been attached to an article — reachable, since these
 * are the viewer's own images and an article cover is an ordinary thing to make
 * one, but not something that happens to an untouched gallery. The gate has no
 * carve-out either way.
 *
 * What follows for this component is unchanged by that narrowing: it is
 * `Pending`, not cause (1) as a whole, that is "where a just-kept image lands
 * and resolves itself". {@link GALLERY_RECHECK_MS} is sized for that Pending
 * case and reaches no other: it fires once, on the mount that saw the `hidden`,
 * so a cell that flips to `Rescan` between mounts simply renders the notice
 * until the next scan completes. That is the honest shape of the design, and
 * the fact a maintainer needs when judging whether one re-read is the right
 * amount.
 *
 * ⚠️ The SENTENCE below does not enumerate any of this, and that is the
 * deliberate choice rather than an oversight: it names the two causes that
 * describe the ordinary path — the `Pending` half of (1), and (4) — in wording
 * soft enough not to accuse the viewer of anything in the rest. A flagged image
 * (3) renders a sentence that is not literally true of it; the alternative,
 * naming moderation to every viewer whose own image tripped a flag, is worse,
 * and a copy that recited the gate would be reciting it at someone waiting for a
 * picture. "Still being checked" is true of `Rescan` too, which is the reason
 * the copy survives this correction unchanged. What is fixed here is the
 * docblock's arithmetic, not the copy.
 */
export const HIDDEN_CELL_NOTICE = 'Still being checked, or above your browsing level';

/**
 * How long after a `hidden` verdict the gallery re-reads those ids once.
 *
 * 🔴 A HEURISTIC, NOT A MEASURED SCAN TIME. Nobody here has measured how long
 * `Pending` → `Scanned` takes, and this number is not a claim about it: it buys
 * one extra chance for a freshly-kept image to appear without the viewer having
 * to leave and come back. When the scan is slower, the cell keeps saying what it
 * says — which is true either way — and the next mount re-reads.
 *
 * Exactly ONE re-read per id, tracked in a ref, so a permanently-hidden image
 * (above the viewer's ceiling, flagged) can never become a polling loop.
 *
 * ⚠️ NARROWER THAN IT READS, SINCE civitai/civitai#4895 — see the owner-projection
 * note on {@link HIDDEN_CELL_NOTICE}. The case this delay was sized for (the
 * author's own just-kept, not-yet-scanned image) no longer returns `hidden` to
 * its author at all; it returns `visible` + `ratingPending`, which renders
 * immediately and never reaches this path. What still reaches it is the narrowed
 * `hidden` set — moderation flags, a hard block, a TERMINAL scan refusal, the
 * browsing ceiling — none of which one re-read 20s later is likely to clear.
 * Left in place rather than removed: it is bounded, it costs one request per
 * withheld cell per mount, and removing a mechanism is a behaviour change that
 * does not belong in the release that ships the fix above.
 */
export const GALLERY_RECHECK_MS = 20_000;

/**
 * The one sentence a viewer MUST read before they confirm a post.
 *
 * 🔴 THE IRREVERSIBLE HALF OF THIS FEATURE, AND IT IS NOT A FOOTNOTE. civitai's
 * app-scoped gated read — the read this very grid is built on — is conjoined
 * with `postId IS NULL`, so an image that joins a post STOPS RESOLVING HERE. The
 * SDK states it in capitals: *"an app cannot both keep an image in its shared
 * grid and let the viewer post it."* Nothing about the grid hints at that, the
 * host's own confirm is about what is being published rather than what is being
 * given up, and the loss is discovered only by coming back to My gallery and
 * finding a hole. So it is said here, in the composer, above the button.
 */
export const POST_REMOVES_FROM_GALLERY =
  'Posting moves these images to your Civitai profile — they leave My gallery here, for good.';

/**
 * What a cell says when it cannot be selected because nothing has rated it yet.
 *
 * 🔴 PREVENTING THE REFUSAL, NOT REPORTING IT. `resolveAppPublishedImages`
 * refuses an unrated id — and refuses the WHOLE post with it, since unresolvable
 * ids are refused rather than skipped. One image kept a minute ago would
 * therefore cost a viewer a nineteen-image post, at the confirm, with the
 * server's single deliberately-uninformative sentence (*"an image is not
 * available to post"*, one message for four different causes so the reply cannot
 * be used to probe which). The wait is short and it resolves itself, which is
 * exactly the kind of thing worth saying up front rather than discovering.
 */
export const POST_PENDING_CELL_NOTICE = 'Still being rated — you can post this once that finishes.';

/**
 * What the composer says about tags.
 *
 * ⚠️ AN APP MAY NOT PROMISE THIS. The server resolves tag names against EXISTING
 * tags only: an unmatched name is DROPPED, never minted, and the host's consent
 * screen shows the viewer the RESOLVED list rather than the one typed here. So
 * the field asks, and the confirm answers.
 */
export const POST_TAGS_NOTICE =
  'Only tags that already exist on Civitai can be applied — anything else is dropped. Civitai shows you the final list before posting.';

/**
 * What the composer says about the optional model-version attach.
 *
 * 🔴 IT NAMES THE PASTE, BECAUSE THE NUMBER IS NOT OBTAINABLE FROM IN HERE. A
 * block runs in a sandboxed iframe with no view of the parent page: the only
 * place a viewer ever sees a `modelVersionId` is the query parameter on a
 * civitai model page. Asking for the bare number is asking for a value they have
 * no way to look up, so the field asks for the link they can copy.
 *
 * The attach itself is gated hard server-side (the version must be published and
 * public, and an app may not attach to its own publisher's models), and a
 * refusal comes back as a free-text server message. The control is rendered
 * unconditionally and the refusal is surfaced verbatim — hiding the control when
 * it might be refused would mean guessing a server rule this app cannot see.
 */
export const POST_ATTACH_NOTICE =
  'Paste the link to the model version, or its id. Civitai decides whether the attach is allowed, and will say so if it turns it down.';

/** Shown under the attach field when nothing usable could be read out of it. */
export const POST_ATTACH_UNPARSED =
  'That doesn’t look like a model version. Paste the page link from Civitai — the one with ?modelVersionId= in it.';

/** What the composer says about the host's own confirm, so it is not a surprise. */
export const POST_CONSENT_NOTICE =
  'Civitai shows you exactly what it is about to post — the images, and the tags it actually matched — before anything is published.';

/** What the gate said about one id, or `'missing'` when it said nothing at all. */
export type GatedState = BlockGatedImage | { imageId: number; status: 'missing' };

export interface KeptGalleryProps {
  runs: KeptRun[];
  c: Palette;
  /** Host gated read. Rejections are surfaced, never swallowed into an empty grid. */
  getImages: (imageIds: number[]) => Promise<BlockGatedImage[]>;
  emptyTitle: string;
  emptyBody: string;
  /** Rendered inside the empty panel (e.g. a "run something" CTA). */
  emptyAction?: React.ReactNode;
  /** Open the lightbox on a cell. */
  onOpenCell: (cell: KeptImageCell, url: string | null) => void;
  /** Show each cell's "Made with <generator>" caption (off inside one generator). */
  withAttribution?: boolean;
  /**
   * Kept runs exist that are not in `runs`. Renders {@link TRUNCATION_NOTICE}.
   *
   * 🔴 ONLY MEANINGFUL WHEN `runs` IS THE WHOLE LOADED SET. The flag is global
   * (it describes the viewer's store), so a caller that has FILTERED `runs` —
   * the Runner, which scopes to one generator — must not pass it: the notice
   * would be a global fact rendered as if it described the grid beneath it.
   */
  truncated?: boolean;
  /**
   * The key walk was cut short, so what is missing is the viewer's NEWEST keeps
   * rather than their oldest (`KeptRunPage.incomplete` in `lib/runs.ts`).
   * Selects {@link INCOMPLETE_NOTICE} over {@link TRUNCATION_NOTICE}.
   *
   * 🔴 Same scoping rule as `truncated`, for the same reason: it is a fact about
   * the viewer's STORE, so a caller rendering a FILTERED `runs` must not pass it.
   */
  incomplete?: boolean;
  /**
   * Delay before the single re-read of `hidden` ids. See
   * {@link GALLERY_RECHECK_MS} — it is a heuristic, and tests set it to 0.
   */
  recheckDelayMs?: number;
  /**
   * Offer the multi-select + composer that publishes kept images as a REAL Post
   * on the viewer's profile (`useCreatePostFromApp()`, scope
   * `posts:write:self`).
   *
   * 🔴 OPT-IN, AND OFF BY DEFAULT ON PURPOSE. Posting is not a variation on
   * viewing: it is public, feed-visible, reward-earning content under the
   * viewer's byline, and it REMOVES the image from this grid (see
   * {@link POST_REMOVES_FROM_GALLERY}). A caller that renders a FILTERED slice
   * of the viewer's keeps — the Runner, which scopes to one generator — would be
   * offering that from a surface whose own heading is about something else, so
   * it does not pass this. My gallery, which is the whole set and the place a
   * viewer goes to look at what they made, does.
   *
   * The hook is mounted unconditionally either way: it holds only local state
   * until `createPost` is called, so a gallery with posting off sends nothing
   * and needs no transport.
   */
  posting?: boolean;
  /**
   * Route an anonymous viewer into the host sign-in flow — the correct response
   * to the host's `sign in to post` refusal, which is not an error to render.
   * Absent ⇒ {@link POST_SIGN_IN_NOTICE} is shown instead of routing.
   */
  onRequestSignIn?: () => void;
  /**
   * Copy text to the clipboard; resolves `true` on success. Used to hand the
   * viewer the created post's url.
   *
   * 🔴 THE ONLY SANCTIONED WAY OUT OF THIS IFRAME. The block's sandbox is
   * `allow-scripts allow-forms` — no `allow-popups`, no `allow-downloads` — so
   * `window.open`, `target="_blank"` and a host `navigate(_, 'new_tab')` all
   * silently do nothing. The url is rendered as selectable text regardless;
   * this only adds the one-tap copy, and is omitted rather than faked when the
   * caller has no clipboard path.
   */
  copyToClipboard?: (text: string) => Promise<boolean>;
  'data-testid'?: string;
}

export function KeptGallery({
  runs,
  c,
  getImages,
  emptyTitle,
  emptyBody,
  emptyAction,
  onOpenCell,
  withAttribution = false,
  truncated = false,
  incomplete = false,
  recheckDelayMs = GALLERY_RECHECK_MS,
  posting = false,
  onRequestSignIn,
  copyToClipboard,
  'data-testid': testId = 'kept-gallery',
}: KeptGalleryProps) {
  const motion = useMotion();
  const { createPost, pending: postPending } = useCreatePostFromApp();
  /**
   * Ids that have JOINED A POST this session, dropped from the feed below.
   *
   * 🔴 NOT AN OPTIMISTIC FLOURISH — IT IS WHAT THE SERVER ALREADY DID. The
   * app-scoped read is conjoined with `postId IS NULL`, so these ids stop
   * resolving the moment the post lands: leaving them on screen would show
   * cells that the very next mount renders as "No longer available", which reads
   * as breakage rather than as the thing the composer warned about. Dropping
   * them makes {@link POST_REMOVES_FROM_GALLERY} visibly true instead of merely
   * stated.
   */
  const [postedIds, setPostedIds] = useState<Set<number>>(() => new Set());
  const feed = useMemo(
    () => keptImageFeed(runs).filter((cell) => !postedIds.has(cell.imageId)),
    [runs, postedIds],
  );
  const [visibleCount, setVisibleCount] = useState(GALLERY_PAGE_SIZE);
  const [gated, setGated] = useState<Record<number, GatedState>>({});
  const [readError, setReadError] = useState<string | null>(null);
  /** Bumped to re-run the read effect after a recheck or a manual retry. */
  const [readTick, setReadTick] = useState(0);

  // Ids already requested, so a re-render (or a newly-kept run appended to the
  // list) re-reads only what is genuinely new. A ref rather than state: it must
  // not itself re-trigger the effect it guards.
  const requested = useRef<Set<number>>(new Set());
  /** Ids whose one automatic re-read has been spent. See GALLERY_RECHECK_MS. */
  const rechecked = useRef<Set<number>>(new Set());

  const wantedIds = useMemo(
    () => feed.slice(0, visibleCount).map((cell) => cell.imageId),
    [feed, visibleCount],
  );

  useEffect(() => {
    const missing = wantedIds.filter((id) => !requested.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requested.current.add(id);
    let cancelled = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      // 🔴 Seed EVERY requested id as `missing` first. The gate OMITS ids it
      // cannot resolve, so an id that never comes back would otherwise sit
      // undefined forever and render as a perpetual skeleton — a spinner that
      // means "this is gone" is the worst of both readings.
      const next: Record<number, GatedState> = {};
      for (const id of missing) next[id] = { imageId: id, status: 'missing' };
      try {
        // Chunked: the host rejects a request carrying more than
        // GATED_READ_MAX_IDS ids outright rather than truncating it.
        for (const batch of chunkImageIds(missing)) {
          const images = await getImages(batch);
          for (const img of images) next[img.imageId] = img;
        }
        if (!cancelled) setReadError(null);
      } catch {
        // 🔴 Surfaced, not swallowed. A failed gated read leaves the seeded
        // `missing` states, which render as placeholders — indistinguishable
        // from "these images are gone" unless the failure is stated. The ids go
        // back in the pool so the Try again control below can re-ask for them.
        if (!cancelled) setReadError('Couldn’t load your kept images just now.');
        for (const id of missing) requested.current.delete(id);
      }
      settled = true;
      if (!cancelled) setGated((prev) => ({ ...prev, ...next }));

      // ONE delayed re-read for ids the gate withheld. A just-published image is
      // `Pending` ingestion and therefore `hidden`; this is the only way it
      // becomes visible without the viewer leaving and coming back.
      const stillHidden = missing.filter(
        (id) => next[id]?.status === 'hidden' && !rechecked.current.has(id),
      );
      if (!cancelled && stillHidden.length > 0) {
        timer = setTimeout(() => {
          for (const id of stillHidden) {
            rechecked.current.add(id);
            requested.current.delete(id);
          }
          setReadTick((n) => n + 1);
        }, recheckDelayMs);
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // 🔴 THE FIX FOR A REPRODUCED STRAND. Ids enter `requested` BEFORE the
      // await and a cancelled batch's result is dropped, so without this line a
      // read torn down mid-flight left its cells at "Loading…" for the life of
      // the mount: the result was thrown away and the ids still looked fetched,
      // so nothing could ever ask again. The trigger was ordinary — `App` built
      // the Runner's `runs` array inline in JSX, minting a new identity every
      // render. Releasing them costs one repeat read of a batch already in
      // flight; stranding them costs the image.
      if (!settled) for (const id of missing) requested.current.delete(id);
    };
  }, [wantedIds, getImages, readTick, recheckDelayMs]);

  /** Re-ask the gate for everything on screen. Wired to the failed-read Alert. */
  const retryRead = () => {
    requested.current.clear();
    setReadError(null);
    setReadTick((n) => n + 1);
  };

  // ---- posting ----------------------------------------------------------
  const [selecting, setSelecting] = useState(false);
  /** Selected image ids, in the order the viewer picked them — which is POST ORDER. */
  const [selected, setSelected] = useState<number[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [postTitle, setPostTitle] = useState('');
  const [postDetail, setPostDetail] = useState('');
  const [postTagsText, setPostTagsText] = useState('');
  const [postVersionId, setPostVersionId] = useState('');
  const [postFailure, setPostFailure] = useState<PostFailure | null>(null);
  const [posted, setPosted] = useState<BlockCreatePostResult | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);

  const postable = useMemo(() => {
    const ids = new Set<number>();
    if (!posting) return ids;
    for (const cell of feed) if (isPostableGatedState(gated[cell.imageId])) ids.add(cell.imageId);
    return ids;
  }, [posting, feed, gated]);

  // A cell the viewer had selected can stop being postable underneath them — the
  // one re-read flips a `hidden` cell, or a post drops ids from the feed. Reading
  // the selection THROUGH the live postable set means the composer can never send
  // an id the grid no longer considers eligible.
  const selectedIds = useMemo(() => selected.filter((id) => postable.has(id)), [selected, postable]);
  const atImageCap = selectedIds.length >= POST_MAX_IMAGES;

  const tags = useMemo(() => parsePostTags(postTagsText), [postTagsText]);
  const modelVersionId = parseModelVersionId(postVersionId);
  const versionLooksWrong = postVersionId.trim().length > 0 && modelVersionId === undefined;

  function toggleSelected(imageId: number) {
    setPostFailure(null);
    setSelected((prev) => {
      if (prev.includes(imageId)) return prev.filter((id) => id !== imageId);
      // The cap is enforced at the point of selection rather than at submit so
      // the viewer is stopped before the host's consent dialog, not after.
      if (prev.filter((id) => postable.has(id)).length >= POST_MAX_IMAGES) return prev;
      return [...prev, imageId];
    });
  }

  function leaveSelection() {
    setSelecting(false);
    setSelected([]);
    setComposerOpen(false);
    setPostFailure(null);
  }

  async function submitPost() {
    if (selectedIds.length === 0 || postPending) return;
    setPostFailure(null);
    const detail = postDetail.trim();
    const title = postTitle.trim();
    try {
      const result = await createPost({
        // ONE `published` entry: every id in this grid came back from
        // `usePublishGenerationOutputs()`, which is precisely what that arm
        // names. `workflow` sources are not offered here — a kept run stores
        // image ids rather than a workflow id (see `lib/runs.ts`).
        sources: [{ kind: 'published', imageIds: selectedIds }],
        ...(title.length > 0 ? { title } : {}),
        ...(detail.length > 0 ? { detail } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(modelVersionId !== undefined ? { modelVersionId } : {}),
      });
      setPosted(result);
      setUrlCopied(false);
      // The server has already removed these from this app's grid; mirror it.
      setPostedIds((prev) => new Set([...prev, ...selectedIds]));
      setPostTitle('');
      setPostDetail('');
      setPostTagsText('');
      setPostVersionId('');
      leaveSelection();
    } catch (err: unknown) {
      // 🔴 `timedOut` IS READ OFF THE ERROR, NOT OFF THE MESSAGE. It is set
      // structurally by the SDK (`err instanceof RequestTimeoutError`), and it
      // is the flag that keeps an SDK-internal string off the screen — see
      // `describeCreatePostError`.
      const raw = err instanceof Error ? err.message : String(err);
      const timedOut = err instanceof CreatePostError ? err.timedOut : false;
      const outcome = describeCreatePostError(raw, { timedOut });
      if (outcome.kind === 'declined') {
        // The viewer dismissed the host confirm and NO POST EXISTS. Say nothing;
        // the composer stays open so a second look is one click away.
        return;
      }
      if (outcome.kind === 'sign-in') {
        if (onRequestSignIn) {
          onRequestSignIn();
          setComposerOpen(false);
          return;
        }
        setPostFailure({ kind: 'notice', source: 'code', message: POST_SIGN_IN_NOTICE });
        return;
      }
      setPostFailure(outcome);
    }
  }

  async function copyPostUrl() {
    if (!posted || !copyToClipboard) return;
    try {
      setUrlCopied(await copyToClipboard(posted.url));
    } catch {
      setUrlCopied(false);
    }
  }

  // 🔴 Rendered ALONGSIDE whatever the grid shows, never instead of it — and in
  // the empty branch too. `truncated` with an empty feed means every hydrated row
  // was unparseable while runs the app never loaded still exist, and "nothing
  // kept yet" is the worst available reading of that state.
  // 🔴 `incomplete` wins where both are set, and both ARE set in that state:
  // a cut-short walk is always also truncated (`KeptRunPage`), and only one of
  // the two sentences is true of it.
  const notice = truncated ? (
    <span style={metaText} role="status" data-testid={`${testId}-truncated`}>
      {incomplete ? INCOMPLETE_NOTICE : TRUNCATION_NOTICE}
    </span>
  ) : null;

  /**
   * The created post, and the only way out of the sandbox to reach it.
   *
   * 🔴 RENDERED IN THE EMPTY BRANCH TOO, AND THAT IS NOT DEFENSIVENESS. Posting
   * every remaining kept image is an ordinary thing to do and it EMPTIES this
   * grid — so the one state in which the viewer most needs to be told where
   * their images went is exactly the state that would otherwise replace this
   * panel with "Nothing kept yet".
   *
   * 🔴 SELECTABLE TEXT, NOT A LINK. `allow-scripts allow-forms` and nothing else:
   * `window.open` and `target="_blank"` are inert inside this iframe, so a link
   * here would be a control that silently does nothing. See `copyToClipboard`.
   */
  const postSuccess = posted ? (
    <Alert color="success" data-testid="kept-post-success">
      <Stack gap={8}>
        <span>Posted to your Civitai profile.</span>
        <span
          data-testid="kept-post-url"
          style={{ userSelect: 'all', wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
        >
          {posted.url}
        </span>
        <Group gap={8}>
          {copyToClipboard && (
            <Button size="sm" variant="light" data-testid="kept-post-copy" onClick={copyPostUrl}>
              {urlCopied ? 'Link copied' : 'Copy link'}
            </Button>
          )}
          <Button size="sm" variant="subtle" data-testid="kept-post-dismiss" onClick={() => setPosted(null)}>
            Dismiss
          </Button>
        </Group>
        <span style={metaText}>
          {posted.imageIds.length === 1 ? 'That image has' : 'Those images have'} left My gallery — they live on your
          profile now.
        </span>
      </Stack>
    </Alert>
  ) : null;

  if (feed.length === 0) {
    return (
      <Stack gap={10} data-testid={testId}>
        {notice}
        {postSuccess}
        <EmptyState data-testid={`${testId}-empty`} title={emptyTitle} body={emptyBody} action={emptyAction} />
      </Stack>
    );
  }

  const visible = feed.slice(0, visibleCount);

  return (
    <Stack gap={10} data-testid={testId}>
      {notice}
      {postSuccess}
      {readError && (
        <Alert color="warning" data-testid={`${testId}-error`}>
          <Stack gap={8}>
            <span>{readError}</span>
            <Group>
              <Button size="sm" variant="light" data-testid={`${testId}-retry`} onClick={retryRead}>
                Try again
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      {/* 🔴 GATED ON A POSTABLE CELL EXISTING, not merely on `posting`. Offering
          "Select images to post" over a grid where every cell is hidden, missing
          or still being rated is a control that can only ever refuse — and the
          per-cell notice already explains why. */}
      {posting && postable.size > 0 && !selecting && (
        <Group>
          <Button size="sm" variant="light" data-testid="kept-post-start" onClick={() => setSelecting(true)}>
            Select images to post
          </Button>
        </Group>
      )}
      {posting && selecting && (
        <Stack gap={6} data-testid="kept-post-bar">
          <Group gap={8}>
            <Badge variant="light" data-testid="kept-post-count">
              {selectedIds.length} selected
            </Badge>
            <Button
              size="sm"
              data-testid="kept-post-open"
              disabled={selectedIds.length === 0}
              onClick={() => {
                setPostFailure(null);
                setComposerOpen(true);
              }}
            >
              Post to your profile
            </Button>
            <Button size="sm" variant="subtle" data-testid="kept-post-cancel" onClick={leaveSelection}>
              Cancel
            </Button>
          </Group>
          {atImageCap && (
            <span style={metaText} role="status" data-testid="kept-post-cap">
              That’s the most Civitai takes in one post ({POST_MAX_IMAGES}). Deselect one to swap it out.
            </span>
          )}
        </Stack>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))',
          gap: 10,
        }}
      >
        {visible.map((cell) => {
          const state = gated[cell.imageId];
          const url = state && state.status === 'visible' ? state.url : null;
          const resolved = state != null;
          // 🔴 A `visible` CELL IS NOT AUTOMATICALLY A POSTABLE ONE. An image
          // nothing has rated yet comes back `visible` WITH a url (it is the
          // viewer's own), and the post service refuses it — and the whole post
          // with it. See `isPostableGatedState` and POST_PENDING_CELL_NOTICE.
          const ratingPending = posting && state != null && state.status === 'visible' && isRatingPending(state);
          const canSelect = postable.has(cell.imageId);
          const isSelected = selectedIds.includes(cell.imageId);
          const capBlocked = selecting && canSelect && !isSelected && atImageCap;
          const inert = selecting ? !canSelect || capBlocked : !url;
          return (
            <Stack gap={4} key={`${cell.run.id}-${cell.imageId}`}>
              <div style={{ position: 'relative' }}>
              <button
                type="button"
                data-testid="kept-cell"
                data-image-id={cell.imageId}
                data-state={state?.status ?? 'loading'}
                data-postable={posting ? String(canSelect) : undefined}
                data-selected={selecting ? String(isSelected) : undefined}
                // Only a resolvable cell opens: a `hidden`/`missing` cell has
                // nothing to enlarge, so it is inert rather than a button that
                // opens an empty view. In selection mode the same button selects
                // instead, and an unpostable cell is inert for that reason.
                disabled={inert}
                aria-pressed={selecting && canSelect ? isSelected : undefined}
                aria-label={
                  selecting
                    ? canSelect
                      ? `${isSelected ? 'Deselect' : 'Select'} result from ${cell.run.generatorName}`
                      : `Result from ${cell.run.generatorName} — can’t be posted`
                    : url
                      ? `View result from ${cell.run.generatorName}`
                      : `Result from ${cell.run.generatorName} — not available`
                }
                className={motionClass(motion, !inert ? CLASS_LIFT : undefined)}
                onClick={() => (selecting ? toggleSelected(cell.imageId) : onOpenCell(cell, url))}
                style={{
                  all: 'unset',
                  cursor: inert ? 'default' : 'pointer',
                  display: 'block',
                  width: '100%',
                  aspectRatio: '1 / 1',
                  borderRadius: radius.md,
                  border: `${isSelected ? 2 : 1}px solid ${isSelected ? token.primary : c.border}`,
                  overflow: 'hidden',
                  background: elevate(2),
                  boxSizing: 'border-box',
                  opacity: selecting && !canSelect ? 0.55 : 1,
                }}
              >
                {url ? (
                  <Image
                    src={url}
                    alt={`Result from ${cell.run.generatorName}`}
                    loading="lazy"
                    fallback="Image unavailable"
                    wrapperStyle={{ width: '100%', height: '100%' }}
                  />
                ) : (
                  <span
                    data-testid="kept-cell-placeholder"
                    style={{
                      ...metaText,
                      display: 'grid',
                      placeItems: 'center',
                      height: '100%',
                      padding: 8,
                      textAlign: 'center',
                    }}
                  >
                    {!resolved
                      ? 'Loading…'
                      : state.status === 'hidden'
                        ? HIDDEN_CELL_NOTICE
                        : 'No longer available'}
                  </span>
                )}
              </button>
              {selecting && canSelect && (
                // Aria already carries the state (`aria-pressed`); this is the
                // same fact for eyes, and is hidden from the tree rather than
                // announced twice.
                <span
                  aria-hidden
                  data-testid="kept-cell-mark"
                  style={{
                    position: 'absolute',
                    top: 6,
                    left: 6,
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 12,
                    lineHeight: 1,
                    pointerEvents: 'none',
                    border: `1px solid ${isSelected ? token.primary : c.border}`,
                    background: isSelected ? token.primary : elevate(6),
                    color: isSelected ? token.body : c.muted,
                  }}
                >
                  {isSelected ? '✓' : ''}
                </span>
              )}
              </div>
              {ratingPending && (
                <span style={metaText} data-testid="kept-cell-pending">
                  {POST_PENDING_CELL_NOTICE}
                </span>
              )}
              {withAttribution && (
                <span style={metaText} data-testid="kept-cell-attribution">
                  {cell.run.generatorName}
                </span>
              )}
            </Stack>
          );
        })}
      </div>
      {feed.length > visibleCount && (
        <Group justify="center">
          <Button
            size="sm"
            variant="light"
            data-testid={`${testId}-show-more`}
            onClick={() => setVisibleCount((n) => n + GALLERY_PAGE_SIZE)}
          >
            Show more ({feed.length - visibleCount})
          </Button>
        </Group>
      )}

      {/* THE COMPOSER. Everything it collects is ADVISORY — the SDK's own request
          type says so, the server bounds it, screens it, and resolves tags
          against existing tags only — so NOTHING here mirrors a server bound.
          The server names each of those refusals in plain English and the
          `kept-post-error` banner below renders a free-text refusal verbatim,
          which is a sentence the viewer can act on; a `maxLength` is a silent
          keyboard stop that goes wrong in the direction nobody can recover
          from. The one thing bounded client-side is the image SELECTION, which
          is an affordance rather than a copied validation. */}
      <Modal
        opened={posting && composerOpen}
        onClose={() => setComposerOpen(false)}
        title="Post to your profile"
        size="md"
      >
        <Stack gap={12} data-testid="kept-post-composer">
          <Alert color="warning" data-testid="kept-post-removal-warning">
            {POST_REMOVES_FROM_GALLERY}
          </Alert>
          <span style={metaText} data-testid="kept-post-selected-count">
            {selectedIds.length} image{selectedIds.length === 1 ? '' : 's'}, in the order you picked them.
          </span>
          <TextInput
            label="Title"
            data-testid="kept-post-title"
            value={postTitle}
            description="Optional."
            onChange={(e) => setPostTitle(e.currentTarget.value)}
          />
          <Textarea
            label="Description"
            data-testid="kept-post-detail"
            minRows={3}
            value={postDetail}
            description="Optional."
            onChange={(e) => setPostDetail(e.currentTarget.value)}
          />
          <TextInput
            label="Tags"
            data-testid="kept-post-tags"
            value={postTagsText}
            placeholder="portrait, neon"
            description={`Optional, comma separated. ${POST_TAGS_NOTICE}`}
            onChange={(e) => setPostTagsText(e.currentTarget.value)}
          />
          {tags.length > 0 && (
            <Group gap={6} data-testid="kept-post-tag-preview">
              {tags.map((t) => (
                <Badge key={t} variant="light">
                  {t}
                </Badge>
              ))}
            </Group>
          )}
          <TextInput
            label="Add to a model’s gallery (optional)"
            data-testid="kept-post-version"
            value={postVersionId}
            placeholder="https://civitai.com/models/…?modelVersionId=…"
            description={POST_ATTACH_NOTICE}
            error={versionLooksWrong ? POST_ATTACH_UNPARSED : undefined}
            onChange={(e) => setPostVersionId(e.currentTarget.value)}
          />
          {postFailure && postFailure.kind === 'notice' && (
            <Alert color="warning" data-testid="kept-post-error" data-source={postFailure.source}>
              {postFailure.message}
            </Alert>
          )}
          <span style={metaText}>{POST_CONSENT_NOTICE}</span>
          <Group gap={8}>
            <Button
              data-testid="kept-post-submit"
              disabled={selectedIds.length === 0 || postPending}
              onClick={submitPost}
            >
              {postPending ? 'Waiting on Civitai…' : `Post ${selectedIds.length} image${selectedIds.length === 1 ? '' : 's'}`}
            </Button>
            <Button
              variant="subtle"
              data-testid="kept-post-close"
              disabled={postPending}
              onClick={() => setComposerOpen(false)}
            >
              Cancel
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
