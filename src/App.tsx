// Custom Generators — top-level full-page app.
//
// Owns every SDK hook (block context/token, resource picker, image upload,
// generation-resource rehydrate, the Buzz workflow money path, shared + per-user
// storage, consent) and routes between three screens: Browse → Builder / Runner.
// The hooks are collapsed into an injectable `deps` bag so component + e2e tests
// can drive the exact same App with canned picks/uploads/workflows, OR against
// the app's own fake platform (`src/platform/testing.tsx`).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BlockGatedImage,
  BlockGenerationSourceImageInfo,
  BlockPendingImageInfo,
  BlockResourceInfo,
  BlockResourcePickerType,
  BlockWorkflowSnapshot,
  WorkflowBody,
} from '@civitai/app-sdk/blocks';

import {
  useBlockContext,
  useBlockToken,
  useBuzzBalance,
  useBuzzPurchase,
  useCivitaiNavigate,
  useImageUpload,
  useRequestConsent,
  usePublishGenerationOutputs,
  useRequestSignIn,
  useResourcePicker,
  useBuzzWorkflow,
  useGatedImages,
  useGenerationResources,
  useSharedStorage,
  useAppStorage,
  useHostRoute,
  createStoreListings,
} from './platform/index.js';
import type {
  SharedAppendValue,
  SharedListItem,
  SharedListResult,
  StoreListings,
  UseSharedStorage,
} from './platform/index.js';

import { Loader } from './ui/index.js';

import { AI_WRITE_BUDGETED, hasGenerateScope, hasStoreScope } from './scopes.js';
import { palette, pageStyle, contentStyle, metaText } from './theme.js';
import { paintTheme } from './bootTheme.js';
import type { BackgroundScanResult, GeneratorConfig } from './types.js';
import { newGenerator, newId } from './lib/generator.js';
import {
  buildPublishPayload,
  cloneConfigForFork,
  collectVersionIds,
  headerImageRefOf,
  parsePublishedGenerator,
  rehydrateConfig,
} from './lib/generator.js';
import {
  buildRunShareUrl,
  isRoutableKey,
  parseDeeplinkKey,
  parseRouteKey,
  routeForKey,
  stripDeeplinkParam,
} from './lib/deeplink.js';
import blockManifest from '../block.manifest.json';
import { setGeneratorMeta } from './lib/meta.js';
import { backfillLedgerIn, reconcileStoreListings, storeListingFor, storeNoticeFor } from './lib/storeListing.js';
import type { DraftStore, StoredDraft } from './lib/drafts.js';
import { deleteDraft as deleteDraftFn, listDrafts, saveDraft as saveDraftFn } from './lib/drafts.js';
import type { KeptRun } from './lib/runs.js';
import { KeptRemovalError, listKeptRuns, removeKeptImages, runsForGenerator, saveKeptRun } from './lib/runs.js';
import { Browse } from './components/Browse.js';
import { Builder } from './components/Builder.js';
import { Runner } from './components/Runner.js';

/**
 * The slug share links use when the host has not sent one. The manifest's
 * `blockId` is the slug the platform serves this app under
 * (`/apps/run/custom-generators`); the host's own `context.slug` wins when present.
 */
const MANIFEST_SLUG: string = (blockManifest as { blockId: string }).blockId;

/** Outcome of the host Buzz-purchase modal (mirrors `useBuzzPurchase`). */
export interface PurchaseResult {
  purchased: boolean;
  newBalance?: number;
}

export interface AppDeps {
  pickResource: (opts: {
    resourceType: BlockResourcePickerType;
    baseModelGroup?: string;
  }) => Promise<BlockResourceInfo | null>;
  /**
   * DISPLAY upload → an EARLY-RESOLVE pending handle (`{ status:'pending',
   * imageId, url }`): the image is persisted (imageId known) and the host modal
   * has auto-closed, but the moderation scan is still in flight. Used for the
   * cosmetic background (shown to other users); the verdict arrives async via
   * `scanBackground(handle)` and only a `'scanned'` verdict is ever persisted.
   */
  uploadImage: () => Promise<BlockPendingImageInfo | null>;
  /**
   * Resolve the moderation SCAN outcome for the pending DISPLAY background handle
   * returned by `uploadImage()`, AFTER the host modal auto-closed. Lets the
   * builder show inline scan status (scanning → scanned/blocked) WITHOUT blocking
   * the user, and gates persistence fail-closed (only `'scanned'` attaches).
   *
   * Default (see `deps` below): subscribes to the host's async scan verdict via
   * `useImageUpload({ asyncScan: true }).scanStatus(handle)` — re-callable to
   * retry a transient error/timeout.
   */
  scanBackground: (img: BlockPendingImageInfo) => Promise<BackgroundScanResult>;
  /** Fail the inline background scan with a timeout after this long (test seam). */
  bgScanTimeoutMs?: number;
  /**
   * generationSource upload → an UNSCANNED private img2img source image
   * (`{ url, width, height }`; the orchestrator scans it at gen time). Used only
   * for the Runner's img2img source, never for the public background.
   */
  uploadSourceImage: () => Promise<BlockGenerationSourceImageInfo | null>;
  resolveResources: (ids: number[]) => Promise<BlockResourceInfo[]>;
  /**
   * Resolve per-VIEWER MODERATED display data for a list of image ids
   * (`useGatedImages().getImages`). Each result is `visible` (incl. a host-served
   * `url`) or `hidden` (NO url). 🔴 This is the ONLY sanctioned source of a cover
   * url — the stored `headerImageRef.url` is unmoderated and never rendered.
   */
  getImages: (imageIds: number[]) => Promise<BlockGatedImage[]>;
  estimate: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  submit: (body: WorkflowBody, opts?: { idempotencyKey?: string }) => Promise<BlockWorkflowSnapshot>;
  poll: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
  /**
   * KEEP a run's outputs — turn one of THIS app's own workflows' images into
   * durable, server-scanned civitai `Image` rows and resolve with their ids
   * (`usePublishGenerationOutputs().publish`). The app's terminal; see
   * `lib/runs.ts` for why ids rather than urls are what gets stored.
   *
   * 🔴 Needs NO new manifest scope. The host gates this on `ai:write:budgeted`
   * (verified in the deployed router: the same trust boundary as submit/query —
   * "an app authorized to spend the viewer's Buzz on generation can publish the
   * outputs it produced"), which this app already declares and already has
   * granted in `approved_scopes`. That is what lets the whole terminal ship in a
   * submission a moderator can approve without granting anything new.
   */
  keepOutputs: (args: { workflowId: string; imageIndexes?: number[]; title?: string }) => Promise<number[]>;
  shared: UseSharedStorage;
  /**
   * In-place UPDATE of an already-published shared generator (same key, no new
   * row). Kept as an injectable seam so the edit-in-place publish logic is fully
   * built + tested now; the real host wiring (`useSharedStorage().update`) lands
   * with @civitai/blocks-react 0.24 — see the App-level TODO.
   */
  updateSharedGenerator: (key: string, value: SharedAppendValue) => Promise<void>;
  /**
   * The App Store sub-listing routes (`platform/storeListings.ts`). Every call is
   * BEST-EFFORT and fires only after the shared-storage write it mirrors has
   * succeeded — see `lib/storeListing.ts`.
   */
  store: StoreListings;
  drafts: DraftStore;
  requestConsent: (opts: { scopes: string[] }) => void;
  requestSignIn: () => void;
  /** Open the host Buzz-purchase modal (insufficient-Buzz recovery). */
  openPurchaseModal: (suggestedAmount?: number) => Promise<PurchaseResult>;
  /** Re-request the viewer's Buzz balance (after a spend / top-up). */
  refreshBalance: () => void;
  /** Host-mediated navigation within civitai.com (open in the Civitai generator). */
  navigate: (path: string, target?: 'current' | 'new_tab') => void;
  /** Copy text to the clipboard (share link). Injectable so jsdom tests can assert it. */
  copyToClipboard: (text: string) => Promise<void>;
  /** Read the `?g=` deeplink key at mount (default: `window.location.search`). */
  getDeeplinkKey: () => string | null;
  /** The app's current href (for building share links); default `window.location.href`. */
  getHref: () => string;
  /** Test seams for the poll loop. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * How many Discover rows the board RENDERS; defaults to
   * {@link DISCOVER_LIST_LIMIT} (test seam).
   *
   * It exists because the truthfulness of {@link DISCOVER_LIST_LIMIT}'s
   * disclosure is a property of the boundary, and at the production value the
   * only constructible truncated board holds exactly 50 loaded rows — which
   * `PAGE_SIZE` (12) never divides, so a test cannot land `allLoadedShown` on
   * its own `<=` boundary while the board is truncated. Lowering the limit is
   * what keeps those fixtures on their boundaries; it changes no production
   * behaviour, because production never sets it.
   */
  discoverPageLimit?: number;
}

/**
 * Discover rows the board reads and renders in one shot.
 *
 * 🔴 THE READ ASKS FOR ONE MORE THAN THIS, AND THE EXTRA ROW IS THE WHOLE POINT.
 * `discoverTruncated` drives four viewer-facing sentences that each assert the
 * catalog has rows this app did not load, so it has to be a FACT rather than an
 * inference — and the obvious inference is wrong. civitai's `apps.shared.router`
 * `list` emits `nextCursor` **iff the page filled** (`rows.length ===
 * input.limit`, re-derived at `5549de73`), so a board holding exactly this
 * many non-hidden `shared_kv` rows hands back a cursor for a board with nothing
 * behind it: `Boolean(nextCursor)` then told a viewer *"this app loads only part
 * of the catalog at once"* over a catalog it had loaded whole. That is verbatim
 * the class `lib/runs.ts`'s own docblock declares a rule against — A CURSOR IS
 * NOT EVIDENCE OF A NEXT ROW — and it was live on this path.
 *
 * So the read asks for `DISCOVER_LIST_LIMIT + 1`, renders the first
 * `DISCOVER_LIST_LIMIT`, and reads truncation off the ROW COUNT it got back.
 * 49 rows → 49 rendered, silent. 50 → 50 rendered, silent, and the board really
 * is whole. 51 → 50 rendered, disclosed, and there really is a row it did not
 * show.
 *
 * ⚠️ WHY NOT THE {@link listKeptRuns} PROBE, WHICH IS THE SAME FIX ONE FILE
 * OVER. That path enumerates KEYS across up to 8 pages, so there is no single
 * read to widen and it settles the ambiguity with one extra 1-row `list` —
 * costing a round trip only for a viewer holding more than 1,600 keys. This path
 * is ONE read, and its page fills on any board with 50+ published generators,
 * i.e. the ordinary state of a healthy board on every Browse open and every
 * retry. A probe here would be a per-open round trip where over-fetching is a
 * per-open extra ROW. The over-fetch is also ATOMIC — one statement, one
 * snapshot — where a probe answers about a later instant. Same standard (make
 * the claim true, do not hedge it), cheaper instrument.
 *
 * Bounded by the platform: the list route validates `limit` as
 * `.int().min(1).max(SHARED_LIST_LIMIT_MAX)` (100), so 51 passes through
 * unchanged and 99 is the largest value this constant can take before the `+1`
 * exceeds the route's maximum. ⚠️ What happens AT that boundary is a 400, not a
 * clamp — see {@link SHARED_LIST_LIMIT_MAX}, which carries the derivation.
 * Raising this to 100 or beyond therefore does NOT silently restore the
 * truncation defect, as an earlier version of this paragraph claimed: it fails
 * the Discover read outright, and `error` + Retry is what the viewer sees.
 */
export const DISCOVER_LIST_LIMIT = 50;

/**
 * The LARGEST `limit` the shared-storage list route will honour — the EXPORTED
 * `SHARED_LIST_LIMIT_MAX` in civitai
 * `src/server/routers/apps-shared.router.ts`, re-derived at `7ce2adf8`.
 *
 * 🔴 A MIRRORED SERVER CONSTANT WITH NO CLAMP ANYWHERE BEHIND IT, SO BOTH
 * DIRECTIONS OF DRIFT ARE WRONG — differently, which is why neither of them is
 * the safe one. Both surfaces validate `limit` as
 * `.int().min(1).max(SHARED_LIST_LIMIT_MAX)` — the REST adapter this app talks
 * to (civitai `src/pages/api/v1/blocks/shared-storage/list.ts`) and the tRPC
 * input. A zod `.max()` REJECTS; it does not clamp. The REST route answers a
 * failed `safeParse` with `400 Invalid query`. Nothing on this app's own path
 * clamps either: `platform/sharedStorage.ts` spreads `limit` into the query
 * string verbatim. So, concretely:
 *
 *   - a copy here ABOVE the server's number 400s the read that uses it. Today
 *     that is the `mine: true` read, whose rejection is confined to the
 *     "Published by me" panel (see the Browse load effect) — and that panel
 *     renders an empty state which does not distinguish "no rows" from "the
 *     read failed", so the 400 is loud on the wire and silent on screen.
 *   - a copy BELOW the server's number under-fetches with nothing on screen
 *     saying so: the viewer's own rows past the lowered limit go missing, which
 *     is the exact defect this constant exists to prevent.
 *
 * 🔴 WHAT IS GUARDED AND WHAT IS NOT. App-side drift is caught in BOTH
 * directions — `components/Browse.ranking.test.tsx` pins the number as a literal
 * `100` on two surfaces (the opts object handed to `deps.shared`, and the query
 * string on the wire), and moving this constant either way fails both. A
 * SERVER-side move is not observable from this repo at all: the fake list route
 * in `src/platform/testing.tsx` reads `limit` with no maximum check, so no test
 * here can go red when civitai's own number changes. There is no mechanism that
 * will tell you this has gone stale — re-derive it from the export named above.
 *
 * ⚠️ WHY THIS DOCBLOCK ONCE SAID THE ROUTE CLAMPED, recorded so the wrong model
 * does not get re-derived: clamping is what the HOST BRIDGE did. `taste.json`'s
 * record of the Discover decision names `PageBlockHost.tsx` and `IframeHost.tsx`
 * clamping to `[1, 100]` ahead of the router, and that was true of the transport
 * this app used at the time. #28 ported it off that bridge onto `@civitai/sdk`'s
 * direct REST calls; the comment outlived the transport.
 *
 * 🔴 ASKING FOR THE MAX IS WHAT MAKES "Published by me" COMPLETE RATHER THAN
 * MERELY DEEPER, WITHOUT THIS APP KNOWING THE PER-AUTHOR CAP. The server refuses
 * a write once an author holds `SHARED_KV_PER_USER_ROW_CAP` rows — a PRIVATE
 * const, 50 at `7ce2adf8`, which this app cannot import and must not pin. At a
 * limit of this size, that cap would have to DOUBLE before a viewer could hold
 * more rows than one page returns; and it cannot be raised past this number
 * without the list route being widened in the same change, since a per-author cap
 * above the list max would make an author's own rows unreachable in one page for
 * every consumer of the route. So truncation of the viewer's own list is not
 * reachable by a cap change alone, and the app carries no apparatus for it.
 *
 * The server returns at most the cap's worth of rows either way, so asking for
 * this rather than 50 changes no wire payload today.
 */
export const SHARED_LIST_LIMIT_MAX = 100;

export interface AppProps {
  /** Override any hook-backed dependency (component + e2e test seam). */
  deps?: Partial<AppDeps>;
}

type View = 'browse' | 'builder' | 'runner';

interface EditTarget {
  id: string;
  config: GeneratorConfig;
  publishedKey?: string;
}

interface RunTarget {
  config: GeneratorConfig;
  sharedContentKey?: string;
  /** Host-resolved MODERATED cover url (from `headerImageRef.imageId`), or null. */
  headerUrl?: string | null;
}

export function App({ deps: depsOverride }: AppProps = {}) {
  const { ready, viewer, theme } = useBlockContext();
  const token = useBlockToken();
  const picker = useResourcePicker();
  // Two purpose-typed upload seams: the moderated DISPLAY upload for the public
  // cosmetic background, and the UNSCANNED generationSource upload for the
  // img2img source image (real intrinsic dims, orchestrator-scanned at gen time).
  const imageUpload = useImageUpload({ asyncScan: true });
  const sourceUpload = useImageUpload({ purpose: 'generationSource' });
  const genResources = useGenerationResources();
  const gatedImages = useGatedImages();
  const workflow = useBuzzWorkflow();
  const sharedHook = useSharedStorage();
  const appStorage = useAppStorage();
  const publishOutputs = usePublishGenerationOutputs();
  const buzz = useBuzzBalance();
  const { requestConsent } = useRequestConsent();
  const { requestSignIn } = useRequestSignIn();
  const { openPurchaseModal } = useBuzzPurchase();
  const { navigate } = useCivitaiNavigate();
  const hostRoute = useHostRoute();

  // A page app fills the frame the host gave it — there is no content-height
  // resize to report, so no resize hook is wired here.
  const c = palette();

  // Assemble the dependency bag (hooks by default; tests override any field).
  const deps: AppDeps = useMemo(
    () => ({
      pickResource: picker.open,
      uploadImage: imageUpload.open,
      // The display upload now EARLY-RESOLVES with a pending handle and the scan
      // verdict streams in async. Subscribe to it via scanStatus and map the
      // host verdict onto the app's fail-closed BackgroundScanResult: 'scanned'
      // persists, 'blocked' rejects inline, any transient error/timeout throws →
      // the app's 'error' phase + Retry (scanStatus is re-callable).
      scanBackground: async (h) => {
        const r = await imageUpload.scanStatus(h);
        if (r.status === 'scanned') return { status: 'scanned' };
        if (r.status === 'blocked') return { status: 'blocked', reason: r.reason };
        throw new Error(r.message ?? 'Image scan failed');
      },
      uploadSourceImage: sourceUpload.open,
      resolveResources: genResources.fetch,
      getImages: gatedImages.getImages,
      estimate: workflow.estimate,
      submit: workflow.submit,
      poll: workflow.poll,
      keepOutputs: publishOutputs.publish,
      shared: sharedHook,
      // In-place UPDATE of the viewer's own published generator (same key, no new
      // row) — the fix for "editing creates a new one". `update` takes the same
      // `{ title, body?, data? }` shape `buildPublishPayload` produces for append,
      // is author-scoped, and reuses the `apps:storage:shared:write` scope.
      updateSharedGenerator: sharedHook.update,
      store: createStoreListings(),
      drafts: appStorage as unknown as DraftStore,
      requestConsent,
      requestSignIn,
      openPurchaseModal,
      refreshBalance: buzz.refetch,
      navigate,
      copyToClipboard: (text: string) =>
        navigator?.clipboard?.writeText
          ? navigator.clipboard.writeText(text)
          : Promise.reject(new Error('Clipboard unavailable')),
      getDeeplinkKey: () => parseDeeplinkKey(window.location.search),
      getHref: () => window.location.href,
      ...depsOverride,
    }),
    // The hook objects are stable across renders (SDK contract); depsOverride is
    // fixed per test. Intentionally not spreading identities into the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [depsOverride],
  );
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const canGenerate = hasGenerateScope(token.scopes);

  /**
   * May this session make App Store calls at all? A signed-in viewer AND the
   * store scope on the token. The scope is consent-exempt, so an approved
   * build's first token carries it; dev, tunnel and review tokens never do,
   * which is why its absence means "make no store call", not "ask".
   *
   * Read through a ref so the publish/withdraw callbacks and the load effect see
   * the live value without re-subscribing.
   */
  const canListInStore = Boolean(viewer) && hasStoreScope(token.scopes);
  const canListInStoreRef = useRef(canListInStore);
  canListInStoreRef.current = canListInStore;
  /** The backfill runs at most once per mount (and per interval — see `lib/storeListing.ts`). */
  const storeReconciledRef = useRef(false);
  /**
   * The store's answer to the LAST publish, as one line under the Builder's
   * success notice — or `null` for nothing (including "store publishing is
   * unavailable", which is not the author's to act on).
   */
  const [storeNotice, setStoreNotice] = useState<string | null>(null);
  /** Which publish the notice belongs to, so a slow answer cannot land on a later one. */
  const storeNoticeSeq = useRef(0);

  // ---- view state ----
  const [view, setView] = useState<View>('browse');
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [running, setRunning] = useState<RunTarget | null>(null);

  // ---- browse data ----
  const [shared, setShared] = useState<SharedListItem[]>([]);
  /**
   * The board has MORE rows than the single page read below, so anything Browse
   * computes over `shared` — the "Popular" ordering, the search filter — covers
   * a prefix of the board rather than the board. Surfaced in the UI; see
   * `discoverTruncated` on <Browse>.
   */
  const [discoverTruncated, setDiscoverTruncated] = useState(false);
  /**
   * The viewer's OWN published rows, from their OWN server-filtered read at
   * {@link SHARED_LIST_LIMIT_MAX} — not a client filter over `shared`.
   *
   * 🔴 WHY A SECOND REQUEST RATHER THAN A FILTER OVER THE DISCOVER PAGE. It used
   * to be `shared.filter((s) => s.authorUserId === viewer.id)` over the one
   * discover page — so a viewer's own generators that had scrolled past the newest
   * {@link DISCOVER_LIST_LIMIT} rows of the WHOLE BOARD were missing from their
   * own list, with nothing on screen saying so. On a healthy board that page fills
   * on any 50+ generators, i.e. the ordinary state, and the panel then rendered "I
   * have published fewer things than I have" — or, when every one of their rows
   * sat past the horizon, "Nothing published". `list` is newest-first with no rank
   * parameter and there was no pagination loop, so no amount of client work could
   * recover the missing rows.
   *
   * The server answers the question directly: `mine=true` narrows the page to rows
   * the VIEWER authored (civitai/civitai#5361). Discover and this are different
   * questions with different completeness requirements — "a page of the board,
   * honestly disclosed as a page" versus "everything you published" — so they are
   * two reads. Folding them into one would have to either break the discover
   * read's `+1` truncation evidence or keep the client filter, and the client
   * filter is the defect.
   *
   * 🔴 NO TRUNCATION APPARATUS, AND ITS ABSENCE IS A CLAIM — see
   * {@link SHARED_LIST_LIMIT_MAX}. Asking for the route's maximum means the
   * server's per-author row cap would have to DOUBLE before this list could be a
   * page rather than the whole thing, and it cannot be raised past that maximum
   * without the route being widened in the same change. There is no `+1`
   * over-fetch here and no disclosure, unlike {@link DISCOVER_LIST_LIMIT}, whose
   * horizon a healthy board crosses every day.
   *
   * ⚠️ `[]` IS OVERLOADED AND NOTHING HERE DISAMBIGUATES IT. The load effect
   * confines a rejected `mine` read to this list rather than failing the whole
   * view, and it does so by setting `[]` — so empty means "published nothing" OR
   * "the read failed", and there is no second piece of state carrying which.
   * `keptError` beside this one is what the resolved version of that looks like;
   * this list has no equivalent yet.
   */
  const [myPublished, setMyPublished] = useState<SharedListItem[]>([]);
  const [myDrafts, setMyDrafts] = useState<StoredDraft[]>([]);
  /**
   * The viewer's KEPT runs — the app's durable end-state (see `lib/runs.ts`).
   *
   * 🔴 Loaded independently of `view`, unlike the board. The Runner needs them to
   * show "Kept from this generator", and the Runner is not the browse view — a
   * load gated on `view === 'browse'` would leave the gallery empty exactly where
   * the terminal is supposed to pay off, and the emptiness would look like the
   * keep having silently failed.
   */
  const [keptRuns, setKeptRuns] = useState<KeptRun[]>([]);
  /**
   * Kept runs exist that `keptRuns` does not contain (see `lib/runs.ts`). When
   * the key walk reaches the end of the store it hydrates the newest
   * `KEPT_LIST_LIMIT` of them, so what is missing is their OLDEST runs — and
   * that "when" is the whole of `keptIncomplete` below, because the sentence is
   * false without it.
   */
  const [keptTruncated, setKeptTruncated] = useState(false);
  /**
   * The key walk did NOT reach the end of the store (`KeptRunPage.incomplete`),
   * so the sentence above inverts: what is missing is the viewer's most RECENT
   * runs, not their oldest. Carried separately so the gallery can say which.
   */
  const [keptIncomplete, setKeptIncomplete] = useState(false);
  /**
   * 🔴 The kept-runs read FAILED — a DIFFERENT fact from "no kept runs", and
   * keeping them apart is the whole point of this state. This catch used to be
   * empty on the reasoning that "the gallery renders its own empty state": it
   * does, and that empty state says *"Nothing kept yet"*, so a viewer whose read
   * failed was told their history was gone. `KeptGallery`'s own `readError`
   * covers a failed `getImages`, not a failed LIST, so nothing downstream could
   * have caught it either.
   */
  const [keptError, setKeptError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  // Non-blocking notice surfaced in the Runner when best-effort resource
  // rehydration failed (names/weights may be stale, but the run still works).
  const [rehydrateNotice, setRehydrateNotice] = useState<string | null>(null);

  // 🔴 Per-viewer MODERATED cover urls for the Discover/Mine cards, keyed by the
  // stored `headerImageRef.imageId`. Resolved via the host `getImages` gate (see
  // the effect below): a `visible` id maps to its host-served url, everything
  // else (hidden / above the viewer's ceiling / unresolved / errored) maps to
  // `null` so a card NEVER falls back to the unmoderated stored `url`.
  const [coverUrls, setCoverUrls] = useState<Record<number, string | null>>({});

  useEffect(() => {
    if (!ready || view !== 'browse') return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // 🔴 ONE MORE THAN WE RENDER — see DISCOVER_LIST_LIMIT. The extra row is
        // the evidence; `nextCursor` is deliberately not read here at all,
        // because it answers "did the page fill", not "is there another row".
        const pageLimit = depsRef.current.discoverPageLimit ?? DISCOVER_LIST_LIMIT;
        // 🔴 A SECOND, PARALLEL READ — NOT A FILTER OVER THE FIRST. See
        // `myPublished` for the defect this replaces. `mine` is a REAL BOOLEAN and
        // is only ever passed when it is true: the route's schema is a
        // `'true' | 'false'` literal union, so a `?mine=` (what any `?? ''`
        // fallback would produce) is a 400, not a default.
        //
        // 🔴 NO `+1` HERE, UNLIKE THE DISCOVER READ ABOVE, AND NO SLICE BELOW.
        // This asks for the route's own maximum (SHARED_LIST_LIMIT_MAX), which the
        // per-author row cap sits far below and cannot pass without the route
        // being widened too — so every row the viewer can hold fits in one page
        // and there is nothing to disclose. The Discover horizon is crossed by any
        // healthy board; this one is not reachable at all.
        //
        // 🔴 SKIPPED ENTIRELY FOR AN ANONYMOUS VIEWER, like the drafts read beside
        // it. An anonymous subject resolves to NULL server-side, so `mine=true`
        // returns an EMPTY PAGE rather than an error or the whole board — the
        // right answer, but one that is indistinguishable from "the store is
        // empty". Not making the request keeps that ambiguity out of the app: the
        // panel's empty state for a signed-out visitor is about having no account,
        // which it already says.
        //
        // 🔴 `allSettled`, NOT `all`, AND ONLY THE `mine` READ IS ALLOWED TO FAIL
        // ALONE. Under `Promise.all` a single rejected promise skipped every
        // setter below, so a failed `mine` read left `shared` at its `[]` initial
        // value and emptied the ENTIRE view — Discover list, cover grid, deeplink
        // open, share, fork and report all went with it. The two panels are
        // separate questions answered by separate requests, so one failing is not
        // evidence about the other.
        //
        // The other two are re-thrown into the catch below, deliberately, and the
        // reasons are not the same for both. The Discover read IS the board: with
        // it gone there is nothing to render, so the view-level `error` + Retry is
        // the honest answer rather than a blank page. The drafts read has no
        // failure state of its own either, so confining it would put "no drafts"
        // over a failed read — trading a visible error for a false statement.
        // Confining `mine` makes that same trade (see `published-empty` in
        // `components/Browse.tsx`, which says "Nothing published yet" whether the
        // read returned zero rows or rejected) and is still worth it, because the
        // alternative it replaces is blanking every other panel too. That empty
        // state is NOT fixed here and remains able to state a falsehood.
        const [sharedSettled, mineSettled, draftsSettled] = await Promise.allSettled([
          depsRef.current.shared.list({ limit: pageLimit + 1 }),
          viewer
            ? depsRef.current.shared.list({ mine: true, limit: SHARED_LIST_LIMIT_MAX })
            : Promise.resolve<SharedListResult>({ items: [] }),
          viewer ? listDrafts(depsRef.current.drafts) : Promise.resolve<StoredDraft[]>([]),
        ]);
        if (cancelled) return;
        if (sharedSettled.status === 'rejected') throw sharedSettled.reason;
        if (draftsSettled.status === 'rejected') throw draftsSettled.reason;
        const sharedRes = sharedSettled.value;
        setShared(sharedRes.items.slice(0, pageLimit));
        // `list` is newest-first and takes no rank parameter, so a row we did NOT
        // render may outrank or match anything that was. A row came back past the
        // horizon ⇒ that is a definite statement, not a hedge off a cursor.
        setDiscoverTruncated(sharedRes.items.length > pageLimit);
        // Reset to `[]` on a rejection rather than left alone: a stale list from a
        // previous successful read would be a wrong answer about the viewer's rows
        // now, and `reloadKey` makes a retry cheap.
        //
        // 🔴 WARN ON THE WAY PAST, because confining this rejection is what makes it
        // invisible: the panel then says "Nothing published yet" and NOTHING else in
        // the app records that a read failed, so the symptom a viewer reports ("my
        // generators vanished") has no attributable signal short of a HAR capture.
        // The request is loud on the wire and silent on screen; this is the one line
        // that keeps it attributable. Same convention as `components/Runner.tsx`'s
        // keep-failed warn. NOT a substitute for surfacing it in the UI — that is
        // `published-empty` in `components/Browse.tsx` and is still open.
        if (mineSettled.status === 'rejected') {
          // eslint-disable-next-line no-console
          console.warn('[custom-generators] my-published read failed', mineSettled.reason);
        }
        setMyPublished(mineSettled.status === 'fulfilled' ? mineSettled.value.items : []);
        setMyDrafts(draftsSettled.value);
        // App Store backfill: list the viewer's already-published generators that
        // have no store card yet. Off the `mine` page this effect just read, so it
        // costs no extra shared-storage request, and only on a FULFILLED read — a
        // failed one says nothing about what the viewer has published, and the
        // next load retries. Once per mount, and at most once per
        // BACKFILL_INTERVAL_MS across page loads (a ledger in the viewer's own app
        // storage); never awaited; never fails the view. A viewer with nothing of
        // their own never reaches the store (`reconcileStoreListings` returns
        // before calling it).
        if (
          mineSettled.status === 'fulfilled' &&
          viewer &&
          canListInStoreRef.current &&
          !storeReconciledRef.current
        ) {
          storeReconciledRef.current = true;
          void reconcileStoreListings({
            viewerId: viewer.id,
            published: mineSettled.value.items,
            store: depsRef.current.store,
            ledger: backfillLedgerIn(depsRef.current.drafts),
          })
            .then((report) => {
              if (report.stoppedBy && report.stoppedBy !== 'unavailable') {
                // eslint-disable-next-line no-console
                console.warn('[custom-generators] App Store backfill stopped early', report);
              }
            })
            .catch((err: unknown) => {
              // eslint-disable-next-line no-console
              console.warn('[custom-generators] App Store backfill failed', err);
            });
        }
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, view, viewer, reloadKey]);

  // Load the viewer's kept runs once the host is ready. Anonymous viewers have
  // none by construction (per-user storage rejects an unauthenticated subject),
  // so the read is skipped rather than made and discarded.
  useEffect(() => {
    if (!ready || !viewer) {
      setKeptRuns([]);
      setKeptTruncated(false);
      setKeptIncomplete(false);
      setKeptError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const page = await listKeptRuns(depsRef.current.drafts);
        if (!cancelled) {
          setKeptRuns(page.runs);
          setKeptTruncated(page.truncated);
          setKeptIncomplete(page.incomplete);
          setKeptError(null);
        }
      } catch {
        // 🔴 Non-fatal but NOT silent. It must not take down Browse or the
        // Runner — hence no `setError` — but the gallery cannot infer this from
        // an empty list, so it is stated. The host's message is deliberately not
        // rendered: it is untrusted text, and the viewer-facing fact is the same
        // either way.
        if (!cancelled) {
          setKeptRuns([]);
          setKeptTruncated(false);
          setKeptIncomplete(false);
          setKeptError('Couldn’t load your kept images just now.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, viewer, reloadKey]);

  /**
   * Record a kept run, then reflect it immediately.
   *
   * 🔴 The store write is awaited and the in-memory list is updated from the SAME
   * record — not re-listed. A re-list here would race the KV's own read-after-write
   * visibility and could return without the row, which the Runner would render as
   * "your keep did not stick" one beat after telling the viewer it had.
   */
  const handleKeepRun = useCallback(async (run: KeptRun) => {
    await saveKeptRun(depsRef.current.drafts, run);
    setKeptRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
  }, []);

  /**
   * Images just joined a POST, so they have left this app's gallery for good —
   * correct the durable record, not only the screen.
   *
   * 🔴 THE HALF `KeptGallery` CANNOT DO. civitai's app-scoped gated read is
   * conjoined with `postId IS NULL`, so a posted id stops resolving for this app
   * permanently. The gallery masks the ids it posted, but that state dies with
   * the mount: without this, switching tabs or reloading brought every posted
   * image back as a *"No longer available"* tile — forever — with the tab header
   * still counting them. `removeKeptImages` rewrites only the affected runs and
   * only the named ids, so a run's other images survive.
   *
   * 🔴 THE IDS ARE THE SERVER'S ECHO, NOT THE SELECTION. What a post is made of
   * is decided by the post call; deleting from a durable store on the strength
   * of what we ASKED for would delete an image the server may not have taken.
   *
   * State is set from what `removeKeptImages` RETURNS rather than by re-listing
   * — the same read-after-write reasoning as `handleKeepRun` above.
   *
   * 🔴 A PARTIAL WRITE FAILURE IS ACTED ON AND STATED, AND IT USED TO BE
   * NEITHER. The old catch was empty, under a comment saying *"the next
   * kept-runs read is authoritative"* — which reassures where it cannot. The
   * writes are fired together, so a rejection leaves a store where SOME runs
   * were corrected and some were not, and the ids that were not are exactly the
   * defect this whole path exists to remove: permanently-dead *"No longer
   * available"* tiles, with nothing said. Two things happen instead. The list is
   * set from {@link KeptRemovalError.remaining} — the best available account of
   * what the store now holds, with the one case it can still get wrong bounded on
   * that field — so the screen and the record do not silently disagree; and the
   * viewer is told, because this is the one outcome where their gallery is about
   * to look broken through no action of theirs. That assignment is load-bearing
   * and is pinned by a MIXED partial failure in
   * `components/KeptGallery.post.transport.test.tsx`: the all-writes-fail fixture
   * cannot see it, because `remaining` comes back byte-equal to the list that went
   * in. NO RETRY: the post itself succeeded and
   * must never be re-sent, and re-attempting the failed STORE write silently
   * would hide the only fact worth reporting. `onRetry` (the alert's own
   * control) re-lists, which is the bounded, viewer-initiated version.
   */
  const keptRunsRef = useRef<KeptRun[]>(keptRuns);
  keptRunsRef.current = keptRuns;
  const handlePostedImages = useCallback((imageIds: number[]) => {
    void (async () => {
      try {
        const next = await removeKeptImages(depsRef.current.drafts, keptRunsRef.current, imageIds);
        setKeptRuns(next);
        setKeptError(null);
      } catch (err: unknown) {
        if (err instanceof KeptRemovalError) setKeptRuns(err.remaining);
        // Names what happened in the viewer's terms: the post is NOT in doubt,
        // the gallery's own record is. The host's message is deliberately not
        // rendered — it is untrusted text, and the viewer-facing fact is the
        // same whatever it says.
        setKeptError(
          'Your post went through, but this app couldn’t update My gallery — some of those images may still be listed here, and won’t load.',
        );
      }
    })();
  }, []);

  // Resolve the MODERATED cover url for every card whose stored data carries a
  // header `imageId` not yet resolved. Batches the ids through the host
  // `getImages` gate; a `visible` id keeps its host-served url, all others map to
  // `null` (never the unmoderated stored url). Failures fail-closed to `null`.
  useEffect(() => {
    const wanted = new Set<number>();
    for (const item of shared) {
      const id = headerImageRefOf(item.value)?.imageId;
      if (typeof id === 'number') wanted.add(id);
    }
    const missing = [...wanted].filter((id) => !(id in coverUrls));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      // Seed every requested id to null first, so an unresolved/omitted id is a
      // definitive "no cover", never a fall-through to the raw url.
      const resolved: Record<number, string | null> = {};
      for (const id of missing) resolved[id] = null;
      try {
        const images = await depsRef.current.getImages(missing);
        for (const img of images) {
          resolved[img.imageId] = img.status === 'visible' ? img.url : null;
        }
      } catch {
        /* fail-closed — leave the seeded nulls (no cover) */
      }
      if (!cancelled) setCoverUrls((prev) => ({ ...prev, ...resolved }));
    })();
    return () => {
      cancelled = true;
    };
  }, [shared, coverUrls]);

  /**
   * This generator's kept runs, for the Runner's "Kept from this generator".
   *
   * 🔴 MEMOISED BECAUSE ITS IDENTITY IS LOAD-BEARING, NOT FOR SPEED. This was
   * called inline in the Runner's JSX, so every App render minted a new array —
   * a new `runs` prop, a new `feed`, a new `wantedIds`, and therefore a re-run of
   * `KeptGallery`'s read effect whose cleanup cancelled whatever gated read was
   * in flight. Paired with that component's own bug (ids marked requested before
   * the await, the result dropped on cancel) it stranded cells at "Loading…"
   * permanently. Both halves are fixed; this is the half that stops the cancel
   * happening at all.
   */
  const runnerKeptRuns = useMemo(
    () => runsForGenerator(keptRuns, running?.sharedContentKey),
    [keptRuns, running?.sharedContentKey],
  );

  // Card cover lookup passed to Browse: the resolved moderated url, or null.
  const coverUrlFor = useCallback(
    (item: SharedListItem): string | null => {
      const id = headerImageRefOf(item.value)?.imageId;
      return typeof id === 'number' ? coverUrls[id] ?? null : null;
    },
    [coverUrls],
  );

  // ---- navigation ----
  const openBuilderNew = useCallback(() => {
    setEditing({ id: newId('gen'), config: newGenerator() });
    setView('builder');
  }, []);

  const openBuilderEdit = useCallback((draft: StoredDraft) => {
    setEditing({ id: draft.id, config: draft.config, publishedKey: draft.publishedKey });
    setView('builder');
  }, []);

  const openConfig = useCallback(
    async (config: GeneratorConfig, sharedContentKey?: string) => {
      let resolved = config;
      setRehydrateNotice(null);
      try {
        const ids = collectVersionIds(config);
        if (ids.length > 0) {
          const infos = await depsRef.current.resolveResources(ids);
          resolved = rehydrateConfig(config, infos);
        }
      } catch {
        // Rehydration is best-effort — open with the stored (already-named)
        // config, but tell the user why some resource names/limits may look off
        // instead of failing silently.
        setRehydrateNotice(
          "Couldn't refresh this generator's model details — names or weight limits may be out of date. You can still run it.",
        );
      }
      // 🔴 Resolve the MODERATED cover url from the stored `imageId` (never the
      // unmoderated stored `url`). Fail-closed to null (no banner) on hidden /
      // unresolved / error.
      let headerUrl: string | null = null;
      const headerId = resolved.headerImageRef?.imageId;
      if (typeof headerId === 'number') {
        try {
          const [img] = await depsRef.current.getImages([headerId]);
          headerUrl = img && img.status === 'visible' ? img.url : null;
        } catch {
          headerUrl = null;
        }
      }
      // Best-effort client-side OG/meta — og:image ONLY from the resolved
      // moderated cover url.
      try {
        setGeneratorMeta(resolved, headerUrl);
      } catch {
        /* meta is cosmetic — never let it block opening the runner. */
      }
      setRunning({ config: resolved, sharedContentKey, headerUrl });
      setView('runner');
    },
    [],
  );

  const openPublished = useCallback(
    (item: SharedListItem) => {
      const config = parsePublishedGenerator(item.value);
      if (!config) {
        setError('This generator could not be opened (unrecognised format).');
        return;
      }
      void openConfig(config, item.key);
    },
    [openConfig],
  );

  const openDraft = useCallback(
    (draft: StoredDraft) => {
      void openConfig(draft.config, draft.publishedKey);
    },
    [openConfig],
  );

  /**
   * Open the generator a KEPT image was made with, by its shared key.
   *
   * 🔴 Resolves against the loaded page only, and returns `false` when it cannot.
   * The board read is ONE page, so a kept image whose generator sits past that
   * page — or was withdrawn since — is not found here. The caller surfaces that;
   * silently doing nothing would read as a dead button.
   *
   * ⚠️ "NO SERVER-SIDE GET-BY-KEY FOR A GENERATOR ROW HERE" IS WHAT THIS BLOCK
   * USED TO SAY, AND IT IS FALSE. `depsRef.current.shared.get(key)` is live
   * (`src/platform/sharedStorage.ts`, over `GET blocks/shared-storage/item`). So
   * the `false` below is a choice this call site has not revisited, not an
   * impossibility — and the "withdrawn since" half would still need handling, since
   * `get` returns `null` for a withdrawn or moderated row too. Changing it is out
   * of scope here on purpose.
   */
  const openPublishedByKey = useCallback(
    (key: string): boolean => {
      const item = shared.find((s) => s.key === key);
      if (!item) return false;
      const config = parsePublishedGenerator(item.value);
      if (!config) return false;
      void openConfig(config, item.key);
      return true;
    },
    [shared, openConfig],
  );

  const backToBrowse = useCallback(() => {
    setView('browse');
    setEditing(null);
    setRunning(null);
    // The store line belongs to the Builder session it was published from; a
    // late answer must not appear in the next one.
    storeNoticeSeq.current += 1;
    setStoreNotice(null);
    reload();
  }, [reload]);

  // ---- persistence ----
  const persistDraft = useCallback(
    async (config: GeneratorConfig, publishedKey?: string): Promise<StoredDraft> => {
      const target = editing;
      const draft: StoredDraft = {
        id: target?.id ?? newId('gen'),
        config,
        updatedAt: Date.now(),
        publishedKey: publishedKey ?? target?.publishedKey,
      };
      await saveDraftFn(depsRef.current.drafts, draft);
      setEditing((e) => (e ? { ...e, config, publishedKey: draft.publishedKey } : e));
      return draft;
    },
    [editing],
  );

  const handleSaveDraft = useCallback(
    async (config: GeneratorConfig) => {
      // The store line describes the last PUBLISH; a draft save is not one.
      storeNoticeSeq.current += 1;
      setStoreNotice(null);
      await persistDraft(config);
      reload();
    },
    [persistDraft, reload],
  );

  /**
   * Mirror a just-published generator into the App Store. Fire-and-forget.
   *
   * 🔴 NOT AWAITED BY THE PUBLISH, AND NEVER THROWS. The shared-storage write has
   * already succeeded when this runs; the store is a second, optional home. So a
   * store call that fails — or never answers — cannot fail, delay or roll back
   * the in-app publish, and the author's "Published!" is true either way. What
   * the store said comes back as one line under it (`storeNotice`).
   */
  const listInStore = useCallback((key: string, config: GeneratorConfig) => {
    const seq = ++storeNoticeSeq.current;
    setStoreNotice(null);
    if (!canListInStoreRef.current) return;
    const input = storeListingFor(key, config);
    if (!input) return;
    const settle = (notice: string | null) => {
      if (seq === storeNoticeSeq.current) setStoreNotice(notice);
    };
    depsRef.current.store.upsert(input).then(
      (result) => settle(storeNoticeFor({ ok: true, result })),
      (error: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[custom-generators] App Store upsert failed', error);
        settle(storeNoticeFor({ ok: false, error }));
      },
    );
  }, []);

  const handlePublish = useCallback(
    async (config: GeneratorConfig) => {
      // Draft first (so it lands in "My generators" even if the publish fails) —
      // upserts the SAME draft id, carrying any existing publishedKey.
      const draft = await persistDraft(config);
      const payload = buildPublishPayload(config);
      let key: string;
      if (draft.publishedKey) {
        // Already published → UPDATE the same shared row in place. This is the
        // fix for "editing creates a new one": never append a duplicate.
        await depsRef.current.updateSharedGenerator(draft.publishedKey, payload);
        key = draft.publishedKey;
      } else {
        // First publish → append, then remember the minted key on the draft so a
        // future edit updates in place instead of duplicating.
        ({ key } = await depsRef.current.shared.append(payload));
        await persistDraft(config, key);
      }
      // Only after the shared write landed: the server refuses a store item that
      // does not exist in shared storage.
      listInStore(key, config);
      reload();
    },
    [persistDraft, reload, listInStore],
  );

  const handleDeleteDraft = useCallback(
    async (draft: StoredDraft) => {
      await deleteDraftFn(depsRef.current.drafts, draft.id);
      reload();
    },
    [reload],
  );

  /**
   * Apply one row-level edit to BOTH board lists, and hand back its rollback.
   *
   * 🔴 THE SEAM TWO LISTS OF THE SAME ROWS CREATE, AND THE ONE PLACE IT IS
   * CLOSED. `myPublished` used to be a `useMemo` over `shared`, so every
   * optimistic edit applied to `shared` reached the "Published by me" panel for
   * free. It is now its own server-filtered read (see the `myPublished` state),
   * and the two lists OVERLAP on every row the viewer authored — which is exactly
   * the set this app lets them mutate.
   *
   * 🔴 THE WITHDRAW DIRECTION IS A MEASURED, USER-VISIBLE DEFECT, NOT A
   * PRECAUTION. Patching only `shared` leaves a generator removed from Discover
   * and still listed under "Published by me" — the panel the Remove button lives
   * on, so the viewer's own action appears to have done nothing. `Browse.test.tsx`
   * ("confirm → calls withdraw(key) and optimistically removes the card") was
   * watched going RED on exactly that state when this second list was introduced,
   * and green once both were patched.
   *
   * ⚠️ THE VOTE DIRECTION IS NOT THE SAME CLAIM, AND THE DIFFERENCE IS WORTH
   * RECORDING. `Browse` keeps its own `voteOverlay` keyed on `item.key` and both
   * panels read counts through it, so a divergence between these two lists is
   * SHADOWED in the UI for as long as that overlay holds. Routing the vote
   * through here keeps the underlying rows coherent — which matters to anything
   * reading `item.count` directly — but no test here demonstrates a visible bug
   * in that direction, and none should claim to.
   *
   * The rollback captures each list's PRE-EDIT value, read when it is called
   * rather than when it is built — the same ordering the single-list version
   * relied on, since a state updater runs after the handler returns.
   */
  const patchBoardRows = useCallback(
    (fn: (list: SharedListItem[]) => SharedListItem[]): (() => void) => {
      let prevShared: SharedListItem[] = [];
      let prevMine: SharedListItem[] = [];
      setShared((list) => {
        prevShared = list;
        return fn(list);
      });
      setMyPublished((list) => {
        prevMine = list;
        return fn(list);
      });
      return () => {
        setShared(prevShared);
        setMyPublished(prevMine);
      };
    },
    [],
  );

  // Withdraw one of the viewer's OWN published generators (the shared_kv row).
  // Optimistically drop it from BOTH lists, then call `withdraw(key)`; on failure
  // restore them and surface the host error. A local draft that pointed at
  // this row keeps its config but is unlinked (the published copy is gone).
  const handleDeletePublished = useCallback(
    async (item: SharedListItem) => {
      const rollback = patchBoardRows((list) => list.filter((s) => s.key !== item.key));
      setError(null);
      try {
        await depsRef.current.shared.withdraw(item.key);
      } catch (e) {
        rollback(); // undo the optimistic removal on BOTH lists
        setError(errMsg(e));
      }
      // No App Store call here: the server's shared withdraw itself takes the
      // author's store card down (it awaits that before answering), so a second
      // call from the app would only spend one of the author's store writes.
    },
    [patchBoardRows],
  );

  // Cast/remove this viewer's up-vote on a published generator. Returns the
  // authoritative post-vote count (the Browse card drives the optimistic update
  // + rollback around this call).
  const handleVote = useCallback(async (item: SharedListItem, nextVoted: boolean): Promise<number> => {
    // Anonymous viewers can't vote (the host rejects the mutation). Prompt a
    // sign-in and reject here instead of letting an optimistic +1 flash and then
    // silently revert with no explanation.
    if (!viewer) {
      depsRef.current.requestSignIn();
      throw new Error('Sign in to vote.');
    }
    const count = nextVoted
      ? await depsRef.current.shared.vote(item.key)
      : await depsRef.current.shared.unvote(item.key);
    // Reflect the authoritative count back into BOTH App lists so a re-render (or
    // a sort-by-popularity) sees it without a full reload. A viewer CAN vote on
    // their own row, so this row is in both lists whenever it is theirs.
    patchBoardRows((list) => list.map((s) => (s.key === item.key ? { ...s, count } : s)));
    return count;
  }, [viewer, patchBoardRows]);

  // File a published generator for PLATFORM moderator review.
  //
  // 🔴 THIS DOES NOT HIDE THE ROW, and nothing here should imply it does.
  // `report` escalates to Civitai moderators, who decide; the row stays on the
  // board meanwhile. We have no owner-side suppression to offer instead —
  // `update`/`withdraw` are author-scoped and reject for anyone but the author —
  // so escalation is genuinely the strongest action available here.
  //
  // 🔴 Rejections PROPAGATE on purpose. The shared ReportButton keeps itself
  // armed and shows its own failure line when this rejects; swallowing the error
  // would settle the control to "Reported for review" for a report that was
  // never filed.
  const handleReport = useCallback(async (item: SharedListItem): Promise<void> => {
    await depsRef.current.shared.report(item.key);
  }, []);

  // "Make a copy" of a published generator into the viewer's own draft so they
  // can remix it. Reuses the same parse path that opens a generator, then drops
  // the publishedKey (a fork is a brand-new, unpublished draft) and opens the
  // Builder on it.
  const handleFork = useCallback(async (item: SharedListItem) => {
    if (!viewer) {
      depsRef.current.requestSignIn();
      return;
    }
    const parsed = parsePublishedGenerator(item.value);
    if (!parsed) {
      setError('This generator could not be copied (unrecognised format).');
      return;
    }
    // Deep-clone so the fork shares NO mutable refs with the source shared row.
    const forked: GeneratorConfig = { ...cloneConfigForFork(parsed), name: `${parsed.name} (copy)`.trim() };
    const id = newId('gen');
    const draft: StoredDraft = { id, config: forked, updatedAt: Date.now() };
    try {
      await saveDraftFn(depsRef.current.drafts, draft);
    } catch (e) {
      setError(errMsg(e));
      return;
    }
    setEditing({ id, config: forked });
    setView('builder');
  }, [viewer]);

  // Copy a shareable link for a published generator. It points at the host
  // route, `https://civitai.com/apps/run/<slug>/g/<key>`, not at the block's own
  // `<slug>.civit.ai` origin (which renders only an "Open on Civitai" landing).
  const shareSlug = hostRoute.slug ?? MANIFEST_SLUG;
  const shareSlugRef = useRef(shareSlug);
  shareSlugRef.current = shareSlug;
  const handleShare = useCallback(async (item: SharedListItem): Promise<boolean> => {
    const url = buildRunShareUrl({
      slug: shareSlugRef.current,
      key: item.key,
      href: depsRef.current.getHref(),
    });
    try {
      await depsRef.current.copyToClipboard(url);
      return true;
    } catch {
      return false;
    }
  }, []);

  // Deep-open a generator from a link. Runs once the shared list has loaded:
  // find the item by key and open it in the Runner. If the key isn't in the
  // loaded page, leave the user on Browse.
  //
  // The key comes from the HOST ROUTE (`g/<key>`) first and the iframe's own
  // `?g=<key>` second — the host route is what the viewer's address bar says, so
  // it wins when both are present. See `lib/deeplink.ts`.
  //
  // ⚠️ THAT FALLBACK IS A DEFECT, NOT A PLATFORM LIMIT, AND THIS COMMENT USED TO
  // SAY OTHERWISE ("the block can't fetch a single shared row by key"). It can:
  // `depsRef.current.shared.get(key)` is live (`src/platform/sharedStorage.ts`,
  // over `GET blocks/shared-storage/item`). This call site does not use it yet —
  // deliberately out of scope here, since changing it is a behaviour change with
  // its own premise to check (what a `get` on a withdrawn or moderated key should
  // do on screen). Same for `openPublishedByKey` above.
  const deeplinkHandled = useRef(false);
  /** The last host `subPath` this app acted on, so each route is handled once. */
  const handledSubPath = useRef<string | null>(null);
  const sharedRef = useRef(shared);
  sharedRef.current = shared;
  useEffect(() => {
    if (deeplinkHandled.current || !ready || loading) return;
    deeplinkHandled.current = true;
    handledSubPath.current = hostRoute.subPath;
    const routeKey = parseRouteKey(hostRoute.subPath);
    const key = routeKey ?? depsRef.current.getDeeplinkKey();
    if (!key) return;
    const item = shared.find((s) => s.key === key);
    if (!item) return; // key not on the loaded page — stay on Browse
    const config = parsePublishedGenerator(item.value);
    if (!config) return;
    if (!routeKey) {
      // Clean the `?g=` off the iframe URL so a reload doesn't re-trigger.
      try {
        window.history?.replaceState?.(null, '', stripDeeplinkParam(depsRef.current.getHref()));
      } catch {
        /* history API may be unavailable — non-fatal. */
      }
    }
    void openConfig(config, item.key);
    // `hostRoute.subPath` is read at the moment the list lands and deliberately
    // not a dependency: a route change AFTER this point is the effect below's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loading, shared, openConfig]);

  // Follow a host route change AFTER the first load: `ROUTE_CHANGED` from the
  // viewer's back/forward, or the echo of this app's own navigate below.
  //   - `g/<key>` opens that generator, unless it is already the one open (the
  //     echo case, which must be a no-op or the two effects would ping-pong).
  //   - `''` (the app root) closes a keyed Runner back to Browse — browser Back
  //     out of a generator. It leaves the Builder and an unkeyed draft Runner
  //     alone: neither is routed, so the root says nothing about them.
  //   - anything else is not a route this app has, and does nothing.
  const viewRef = useRef(view);
  viewRef.current = view;
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    const sub = hostRoute.subPath;
    if (!deeplinkHandled.current || sub === null || sub === handledSubPath.current) return;
    handledSubPath.current = sub;
    const openKey = viewRef.current === 'runner' ? runningRef.current?.sharedContentKey : undefined;
    const key = parseRouteKey(sub);
    if (key) {
      if (key === openKey) return;
      const item = sharedRef.current.find((s) => s.key === key);
      if (!item) return;
      const config = parsePublishedGenerator(item.value);
      if (!config) return;
      void openConfig(config, item.key);
      return;
    }
    if (sub === '' && openKey) backToBrowse();
  }, [hostRoute.subPath, openConfig, backToBrowse]);

  // Mirror the open generator into the host route, so the address bar reads
  // `/apps/run/<slug>/g/<key>` while it is open and the app root otherwise.
  // App-scoped `NAVIGATE` is a shallow host push: the page stays mounted and
  // the change comes back as `ROUTE_CHANGED`, which the effect above ignores
  // because the route then matches what is already on screen.
  //
  // Keyed on `desiredRoute` only, so it fires on an app-side TRANSITION, never
  // on a host-side route change (that would undo the viewer's Back). It waits
  // for the first load, so the route a page was opened at is not overwritten
  // before it has been read. No host (`subPath === null`) means nothing to sync.
  const openRouteKey =
    view === 'runner' && running?.sharedContentKey && isRoutableKey(running.sharedContentKey)
      ? running.sharedContentKey
      : null;
  const desiredRoute = openRouteKey ? routeForKey(openRouteKey) : '';
  const hostSubPathRef = useRef(hostRoute.subPath);
  hostSubPathRef.current = hostRoute.subPath;
  useEffect(() => {
    if (!deeplinkHandled.current) return;
    const current = hostSubPathRef.current;
    if (current === null || current === desiredRoute) return;
    // A route this app does not own (`generate`, a typo) is left as-is by
    // a return to Browse; only a route this app wrote is reset to the root.
    if (desiredRoute === '' && parseRouteKey(current) === null) return;
    depsRef.current.navigate(desiredRoute);
  }, [desiredRoute]);

  const requestGenerateConsent = useCallback(() => {
    if (!viewer) {
      deps.requestSignIn();
      return;
    }
    deps.requestConsent({ scopes: [AI_WRITE_BUDGETED] });
  }, [viewer, deps]);

  const buzzTotal =
    buzz.balance != null ? buzz.balance.blue + buzz.balance.green + buzz.balance.yellow : null;

  // ---- render ----
  if (!ready) {
    return (
      <div data-theme={paintTheme(ready, theme)} style={pageStyle(c)}>
        <div
          style={{ margin: 'auto', display: 'grid', justifyItems: 'center', gap: 12 }}
          data-testid="app-loading"
          role="status"
          aria-live="polite"
        >
          <Loader />
          <span style={metaText}>Loading Custom Generators…</span>
        </div>
      </div>
    );
  }

  return (
    <div data-theme={paintTheme(ready, theme)} style={pageStyle(c)}>
      <div style={contentStyle}>
        {view === 'browse' && (
          <Browse
            discoverTruncated={discoverTruncated}
            c={c}
            loading={loading}
            error={error}
            discover={shared}
            myDrafts={myDrafts}
            myPublished={myPublished}
            viewerId={viewer?.id ?? null}
            onSignIn={deps.requestSignIn}
            onCreate={openBuilderNew}
            onOpenPublished={openPublished}
            onOpenDraft={openDraft}
            onEditDraft={openBuilderEdit}
            onDeleteDraft={handleDeleteDraft}
            onDeletePublished={handleDeletePublished}
            onVote={handleVote}
            onFork={handleFork}
            onShare={handleShare}
            onReport={handleReport}
            coverUrlFor={coverUrlFor}
            keptRuns={keptRuns}
            keptTruncated={keptTruncated}
            keptIncomplete={keptIncomplete}
            keptError={keptError}
            getImages={deps.getImages}
            onOpenGeneratorKey={openPublishedByKey}
            // 🔴 NOT GATED ON THE TOKEN'S SCOPES, and that is deliberate rather
            // than an oversight. `posts:write:self` is SENSITIVE and
            // consent-gated: the host mints the first token without it and adds
            // it only after the viewer grants it, which the host does as part of
            // the post call itself. Hiding the control until the scope appeared
            // would hide it until after a post the viewer could not start. The
            // gallery is already only rendered for a signed-in viewer, and the
            // host's own `sign in to post` refusal is routed below for the case
            // the session lapses mid-session.
            posting={{ onPosted: handlePostedImages }}
            onRequestSignIn={deps.requestSignIn}
            copyToClipboard={async (text) => {
              // Same host-clipboard path as Share, normalised to the true/false
              // the gallery wants: the post url is the only way out of an
              // `allow-scripts allow-forms` iframe, so a silent failure there
              // must be visible.
              try {
                await deps.copyToClipboard(text);
                return true;
              } catch {
                return false;
              }
            }}
            onRetry={reload}
          />
        )}

        {view === 'builder' && editing && (
          <Builder
            initial={editing.config}
            c={c}
            pickResource={deps.pickResource}
            uploadImage={deps.uploadImage}
            scanBackground={deps.scanBackground}
            scanTimeoutMs={deps.bgScanTimeoutMs}
            onSaveDraft={handleSaveDraft}
            onPublish={handlePublish}
            storeNotice={storeNotice}
            onBack={backToBrowse}
          />
        )}

        {view === 'runner' && running && (
          <Runner
            config={running.config}
            sharedContentKey={running.sharedContentKey}
            headerUrl={running.headerUrl}
            c={c}
            canGenerate={canGenerate}
            buzzBalance={buzzTotal}
            onRequestConsent={requestGenerateConsent}
            uploadSourceImage={deps.uploadSourceImage}
            estimate={deps.estimate}
            submit={deps.submit}
            poll={deps.poll}
            onBack={backToBrowse}
            onTopUp={deps.openPurchaseModal}
            onBalanceRefresh={deps.refreshBalance}
            onOpenInGenerator={() => deps.navigate('/generate')}
            onCopyImageLink={async (url) => {
              // Sandbox-legal "save" affordance: copy the image url via the same
              // host-clipboard path Share uses (a file download / new tab is
              // blocked for an unverified block). Resolve true/false, never throw.
              try {
                await deps.copyToClipboard(url);
                return true;
              } catch {
                return false;
              }
            }}
            keepOutputs={deps.keepOutputs}
            onKeepRun={handleKeepRun}
            // Scoped to THIS generator: "kept from this generator" is a claim
            // about provenance, so an unpublished draft (no shared key) correctly
            // shows none rather than borrowing another generator's images. The
            // global `keptTruncated` is deliberately NOT passed — see the prop's
            // docblock in `components/Runner.tsx`.
            keptRuns={runnerKeptRuns}
            getImages={deps.getImages}
            rehydrateNotice={rehydrateNotice}
            pollIntervalMs={deps.pollIntervalMs}
            sleep={deps.sleep}
          />
        )}
      </div>
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}
