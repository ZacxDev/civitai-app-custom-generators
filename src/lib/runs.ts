// KEPT RUNS — the app's durable end-state for a generation, over the per-viewer
// App Blocks KV store (`useAppStorage`, scope `apps:storage:write`, already
// granted). Sibling of `lib/drafts.ts`, same store, a different key namespace.
//
// 🔴 WHY THIS EXISTS — the app had no terminal OF ITS OWN. Be precise about what
// was and was not lost, because the app's own reassurance copy is TRUE: the host
// tags every generation submit `'civitai'` (civitai's own
// `src/server/services/orchestrator/workflows.ts`) and the site's generation feed
// reads back on that tag, so the images from a run do outlive the tab — on
// civitai.com, in an undifferentiated stream, stripped of every fact this app
// knows about them. What evaporated was everything the APP held: the Runner's
// output queue documented itself as in-session ("a Back/reload clears it") and
// was guarded by `beforeunload`, so pressing a stranger's button and spending
// real Buzz left the block with no record that it had happened — no way back to
// the image from inside the app, no link between the image and the generator
// that made it, and nothing to come back to the app FOR. This module is the
// app-side record: durable, attributed, and readable where the run happened.
//
// 🔴 WHAT MAKES THE RECORD DURABLE IS THE IMAGE ID, NOT THE URL, and the
// distinction is the whole design. A workflow snapshot's `imageUrls` are
// orchestrator-side artifacts of one generation; persisting one and rendering it
// back days later is storing a URL whose lifetime this app does not control and
// cannot observe. So a run is only ever kept AFTER
// `usePublishGenerationOutputs().publish()` has turned its outputs into real,
// server-scanned civitai `Image` rows, and it is their **ids** that are stored
// here. The url is re-resolved per render through `useGatedImages().getImages`,
// which is also the only sanctioned source of a url in this app (the same rule
// the cover images already follow) and applies the viewer's own moderation clamp
// at read time rather than at write time.
//
// 🔴 THE TEXT STORED HERE IS THE VIEWER'S OWN AND STAYS PRIVATE TO THEM. Per-user
// KV is not the shared board: `constraints §4`'s rule — that user-typed text must
// live in a moderated `title`/`body` and never in an opaque `data` blob — governs
// SHARED storage, where other people read it. `lib/drafts.ts` already persists
// prompt templates and generator names here on exactly that basis. Nothing in
// this module is ever written to shared storage, and nothing here is readable by
// another viewer.
//
// Pure + store-shaped, so it lands in the `node` vitest project with literal
// expectations.

import type { DraftStore } from './drafts.js';

export const KEPT_PREFIX = 'kept:';

/**
 * Rows one `list()` call may return. 🔴 The host's own hard maximum, not a
 * preference: `storage.list` validates `limit` with `.int().min(1).max(200)`
 * (civitai `apps.router`), so a larger value never reaches the query.
 *
 * ⚠️ How it fails, precisely, because a reader will use this to reason about the
 * seam: a BLOCK does not reach that procedure directly. The two hosts clamp
 * first — `Math.min(Math.max(Math.floor(raw.limit), 1), 200)` in both
 * `PageBlockHost.tsx` and `IframeHost.tsx` — so an over-large `limit` sent from
 * here is CLAMPED at the host and the router's `.max(200)` only ever sees a
 * conforming value. 200 is the right number either way; what changes is that
 * asking for more is silently satisfied rather than rejected, so an over-large
 * request is not a mistake this app would find out about.
 */
export const KEPT_PAGE_LIMIT = 200;

/**
 * Hard bound on the forward key walk in {@link listKeptKeys}, so a pathological
 * store can never turn a gallery open into an unbounded request loop.
 *
 * Sized against the host's ceilings rather than a feeling — but the sizing is a
 * claim about ONE of the two states that ceiling has, so read both. Where the
 * per-user gate is LIVE, per-user KV is capped at `USER_ROW_LIMIT = 1_000` rows
 * for an (app, user) pair (civitai `apps.router` `storage.set`), kept runs share
 * that budget with this app's drafts, and a viewer therefore holds at most 1,000
 * `kept:` keys — 5 full pages, with 8 leaving room for the ceiling to move.
 *
 * ⚠️ THAT GATE HAS A DOCUMENTED INERT STATE AND THIS BOUND HAS TO SURVIVE IT.
 * `storage.set` reads the per-user counters through a LEFT JOIN on the
 * `user_quota` relation; on an app whose schema predates that table it catches
 * the `42P01`, reads both per-user counters as 0 and deliberately leaves the
 * per-user gate INERT rather than failing closed. Only the app-wide ceilings
 * then apply — `APP_ROW_LIMIT = 1_000_000` rows and `APP_QUOTA_BYTES = 50 MiB`
 * — and nothing schedules the backfill that ends that state. So on such an app
 * a viewer CAN hold more `kept:` keys than 8 pages enumerate, and this constant
 * IS then the thing that truncates. That is not hidden: a walk stopped here
 * reports {@link KeptRunPage.incomplete}, and nothing downstream calls its
 * result the viewer's newest.
 *
 * ⚠️ This bounds the ENUMERATING pages. A walk that uses all 8 spends at most
 * one further {@link KEPT_LIST_PROBE_LIMIT}-row `list` to tell a store that
 * ended exactly on the boundary from one that continues past it, so the hard
 * ceiling on `list` calls is 9 — still fixed, still independent of store size.
 */
export const KEPT_LIST_MAX_PAGES = 8;

/**
 * Rows the exhaustion probe in `listKeptKeys` asks for. ONE is the whole point:
 * the probe answers a yes/no — does a key exist past the last enumerated page? —
 * and its keys are deliberately discarded rather than appended, because a walk
 * that needed the probe is one this app has already decided not to widen.
 *
 * Costs a round trip ONLY when the 8th page filled, i.e. only in the state that
 * previously reported {@link KeptRunPage.incomplete} unconditionally. The
 * ordinary gallery open — any viewer under `KEPT_LIST_MAX_PAGES * KEPT_PAGE_LIMIT`
 * keys — never reaches it.
 */
export const KEPT_LIST_PROBE_LIMIT = 1;

/**
 * How many kept runs the gallery actually hydrates and renders — the **newest**
 * this many of whatever the key walk enumerated, which is the viewer's newest
 * whenever that walk reached the end of the store (see
 * {@link KeptRunPage.incomplete} for when it did not).
 * Distinct from {@link KEPT_PAGE_LIMIT}: the walk
 * enumerates KEYS across pages (cheap, `list` returns key + `updatedAt` only),
 * and only this many VALUES are then fetched, so widening the horizon does not
 * cost a `get` per extra row.
 *
 * 🔴 KEY ORDER IS CHRONOLOGICAL ORDER, AND THAT IS WHAT MAKES "NEWEST" REACHABLE.
 * The host lists `ORDER BY key` ascending and pages forward with `key > cursor`
 * (apps router `storage.list`), and `newId('kept')` puts `Date.now().toString(36)`
 * first in the id — a fixed-width base-36 stamp until ~2059 — so a walk that
 * REACHES THE END OF THE STORE ends at the viewer's most recent keep, and
 * {@link listKeptRuns} takes the TAIL of it. A walk cut short at
 * {@link KEPT_LIST_MAX_PAGES} ends in the MIDDLE of the store instead, where the
 * tail is simply the newest of the part that was enumerated; that state is
 * carried as {@link KeptRunPage.incomplete}. The host's list is forward-only
 * (`ORDER BY key` with `key > cursor`, no reverse and no end-seek), so there is
 * no set the walk could take there that WOULD be the viewer's newest — which is
 * why this is disclosed rather than corrected.
 *
 * ⚠️ An earlier version of this module read ONE page and therefore showed the
 * viewer's **oldest** runs, dropping the very keep they had just made; and the
 * PR that shipped it asserted "no forward-only paging recovers them", which was
 * false — forward paging is exactly what recovers them, at the cost of a bounded
 * number of extra `list` round trips. Both claims are retracted, not softened.
 */
export const KEPT_LIST_LIMIT = 200;

export function keptKey(id: string): string {
  return KEPT_PREFIX + id;
}

/** One kept generation: the durable image ids plus what made them. */
export interface KeptRun {
  /** Stable local id; also the KV key suffix. */
  id: string;
  /** Epoch ms the viewer kept it (NOT when it generated). Newest-first sort key. */
  keptAt: number;
  /**
   * Durable civitai `Image` row ids returned by `publish()`. 🔴 Never urls — see
   * the header. Always at least one; a run with none is not a kept run.
   */
  imageIds: number[];
  /** Attribution: the generator's own name (app-owned text, not a person's handle). */
  generatorName: string;
  /** shared_kv key of the published generator, so the gallery can re-open it. */
  generatorKey?: string;
  /** Which button produced it. */
  buttonLabel: string;
  /** What the viewer typed, if the button exposed a prompt box. Private to them. */
  prompt?: string;
}

/**
 * Accept only a shape this app wrote. A KV blob is app-controlled but not
 * app-guaranteed — an older schema, a half-written row, or a hand-edited value
 * all arrive here — and a malformed record must be DROPPED rather than rendered,
 * because every field below is used to build UI that claims provenance.
 *
 * 🔴 `imageIds` must be a non-empty array of finite numbers. A record with an
 * empty or garbage id list renders as a kept run with no images: a card that
 * asserts "you kept this" over nothing.
 */
export function isKeptRun(value: unknown): value is KeptRun {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<KeptRun>;
  if (typeof r.id !== 'string' || r.id.length === 0) return false;
  if (typeof r.keptAt !== 'number' || !Number.isFinite(r.keptAt)) return false;
  if (typeof r.generatorName !== 'string') return false;
  if (typeof r.buttonLabel !== 'string') return false;
  if (!Array.isArray(r.imageIds) || r.imageIds.length === 0) return false;
  return r.imageIds.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * 🔴 THERE IS STILL NO VIEWER-FACING UN-KEEP, AND THIS BLOCK USED TO SAY THE
 * STORE WAS ADD-ONLY FULL STOP. That is no longer true: {@link removeKeptImages}
 * deletes from it, driven by a successful post (the one event that removes an
 * image from this app's grid on the SERVER side, so the record here has to
 * follow). What has not changed is the gap the old wording was really about — a
 * viewer can keep an image and cannot decide, on its own, to un-keep it. That
 * closes when a Remove control ships in `components/KeptGallery.tsx` with a test
 * that drives it, and the check is mechanical — that control exists on `main`,
 * or it does not.
 */
export async function saveKeptRun(store: DraftStore, run: KeptRun): Promise<void> {
  await store.set(keptKey(run.id), run);
}

/**
 * A partial failure of {@link removeKeptImages} — SOME of the store was
 * corrected and some was not, with the runs that are durably true of it
 * attached so the caller can match its screen to the record.
 */
export class KeptRemovalError extends Error {
  /**
   * The kept runs as the store is BELIEVED to hold them, in the order the runs
   * were given: a run whose rewrite RESOLVED appears rewritten, a run whose write
   * REJECTED appears exactly as it was passed in, and a run whose deletion
   * resolved is absent. Assigning this to the caller's state is what keeps the
   * screen and the storage from disagreeing after a partial failure.
   *
   * ⚠️ BELIEVED, NOT KNOWN — A REJECTION IS NOT PROOF THE WRITE DID NOT LAND, and
   * this block used to say flatly that these are "the runs as the STORE now holds
   * them". `useAppStorage()`'s `set`/`delete` are RPCs over the postMessage
   * bridge, so a `RequestTimeoutError` (or a dropped reply) rejects a write that
   * the host may already have applied. In that case this list reports a run as
   * un-pruned while the store has pruned it, and assigning it CAUSES the very
   * disagreement the paragraph above says it prevents. The error is one-sided and
   * benign: the screen over-reports what is kept, the viewer's own sentence
   * already hedges with *"may still be listed"*, and the next kept-runs read
   * corrects it. Same softening as the hydration-horizon bound on
   * {@link removeKeptImages} — a trade, not a proof.
   */
  readonly remaining: KeptRun[];

  constructor(message: string, remaining: KeptRun[]) {
    super(message);
    this.name = 'KeptRemovalError';
    this.remaining = remaining;
  }
}

/**
 * Drop image ids from the viewer's kept runs — IN THE DURABLE STORE, not just on
 * screen — and return the runs that remain, in the order they were given.
 *
 * 🔴 WHY THIS HAS TO EXIST, AND WHY A COMPONENT-LOCAL MASK IS NOT ENOUGH. civitai's
 * app-scoped gated read is conjoined with `postId IS NULL`, so an image that
 * joins a post STOPS RESOLVING for this app — permanently. Masking the ids in
 * `KeptGallery`'s own state hides them for ONE mount: switch tabs, reload, come
 * back tomorrow, and every posted id is back in the grid rendering *"No longer
 * available"* forever, with the tab's own *"N images kept from M runs"* header
 * still counting them. The record has to be corrected where it lives.
 *
 * 🔴 SCOPED TO THE NAMED IDS, NEVER TO THE RUN. A run is several images and a
 * viewer may post one of them, so a run is REWRITTEN with the survivors rather
 * than deleted — the key is deleted only when nothing is left, because
 * {@link isKeptRun} rejects an empty `imageIds` and a row that fails it would be
 * dropped silently on every later read anyway (a permanently-unreadable key,
 * spending the viewer's per-app row quota for nothing).
 *
 * ⚠️ IT ONLY REACHES THE RUNS IT IS HANDED. This takes the caller's loaded set
 * rather than walking the store, so an id living in a run outside
 * {@link KEPT_LIST_LIMIT} is not pruned. Walking the whole store instead would
 * spend a `get` per row to find rows that almost never exist.
 *
 * ⚠️ "ALMOST NEVER", NOT "CANNOT" — THIS PARAGRAPH USED TO CLAIM THE BOUND WAS
 * AIRTIGHT. The old wording was *"the only way an id reaches a post is by being
 * rendered, and the only runs that render are the ones in that set"*, which is
 * true of the run holding the RENDERED id and false of a SECOND run holding the
 * SAME id: the same image can legitimately sit in two kept runs (a re-keep of one
 * output — the reason {@link chunkImageIds} de-duplicates, and a case this
 * module's own suite covers), and the second copy may sit outside the hydration
 * horizon. It then survives the prune and comes back as a dead tile. Reaching it
 * takes more than {@link KEPT_LIST_LIMIT} kept runs AND a re-keep spanning that
 * boundary, so the bound is still the right trade — but it is a trade, not a
 * proof, and the residual is a permanently-unresolvable cell rather than nothing.
 *
 * 🔴 EVERY WRITE IS ATTEMPTED, AND A PARTIAL FAILURE IS REPORTED WITH WHAT
 * DURABLY LANDED. A rejected write used to surface as a bare rejection: the
 * caller learned "something failed" and nothing about WHICH runs were corrected,
 * while the in-flight writes landed anyway — a half-corrected store the caller
 * could not describe, so its screen and its storage silently disagreed. Now the
 * failure carries the best available account of the store
 * ({@link KeptRemovalError.remaining}) — resolved rewrites applied, rejected ones
 * left at their pre-call contents, with the one case that account can still get
 * wrong named on that field — so the caller can at least match the screen to the
 * record and say so. There is no retry here: the write that failed is the
 * viewer's own per-app storage, and a silent retry would hide the one fact worth
 * reporting.
 */

export async function removeKeptImages(
  store: DraftStore,
  runs: readonly KeptRun[],
  imageIds: readonly number[],
): Promise<KeptRun[]> {
  const drop = new Set(imageIds);
  if (drop.size === 0) return [...runs];
  /**
   * One entry per input run, in input order, so a rejected write can be
   * attributed to the run it belongs to rather than merely counted. `next` is
   * what the run becomes if its write lands: the rewritten run, or `null` for a
   * key that is being deleted.
   */
  const plan: Array<{ run: KeptRun; next: KeptRun | null; write?: Promise<unknown> }> = [];
  for (const run of runs) {
    const kept = run.imageIds.filter((id) => !drop.has(id));
    if (kept.length === run.imageIds.length) {
      // Untouched — no write, so an unrelated run is never even rewritten.
      plan.push({ run, next: run });
      continue;
    }
    if (kept.length === 0) {
      plan.push({ run, next: null, write: store.delete(keptKey(run.id)) });
      continue;
    }
    const next: KeptRun = { ...run, imageIds: kept };
    plan.push({ run, next, write: store.set(keptKey(run.id), next) });
  }
  // Settle every write INDIVIDUALLY — a hand-rolled `allSettled` keyed to the
  // run, rather than `Promise.all`. All of them were started before the first
  // `await` either way, so bailing at the first rejection threw away the
  // knowledge of what the others did; it never prevented them from landing.
  const settled = await Promise.all(
    plan.map(async (p) => {
      if (!p.write) return { ok: true as const };
      try {
        await p.write;
        return { ok: true as const };
      } catch (err: unknown) {
        return { ok: false as const, err };
      }
    }),
  );
  const remaining: KeptRun[] = [];
  let failure: unknown;
  settled.forEach((res, i) => {
    const p = plan[i]!;
    if (res.ok) {
      if (p.next) remaining.push(p.next);
      return;
    }
    // The write REJECTED, so report the run as it was passed in. That is the
    // best available reading and not a certainty — see
    // {@link KeptRemovalError.remaining} for the bridge-timeout case where a
    // rejected write may nonetheless have landed.
    if (failure === undefined) failure = res.err;
    remaining.push(p.run);
  });
  if (failure !== undefined) {
    throw new KeptRemovalError(failure instanceof Error ? failure.message : String(failure), remaining);
  }
  return remaining;
}

/**
 * The kept runs the gallery got, plus whether any were left behind.
 *
 * 🔴 `truncated` is now a DEFINITE statement, where the one-page version could
 * only hedge. Enumerating every key tells us exactly how many runs exist, so
 * `true` means "there are kept runs this app did not load" — not "the page
 * filled, which may or may not mean more exist".
 *
 * 🔴 `incomplete` is the SECOND fact, and it used to be folded into the first —
 * which made the UI's "your most recent ones" false in exactly the state that
 * rendered it. The two are not the same claim: a COMPLETE walk that truncated
 * left the viewer's OLDEST runs out, while a walk stopped at
 * {@link KEPT_LIST_MAX_PAGES} left their NEWEST out. They are carried
 * separately so every sentence written about either can be definite.
 */
export interface KeptRunPage {
  runs: KeptRun[];
  /** Kept runs exist that are NOT in {@link KeptRunPage.runs}. */
  truncated: boolean;
  /**
   * The key walk was cut short at {@link KEPT_LIST_MAX_PAGES} **with keys still
   * behind it**, so {@link KeptRunPage.runs} is NOT provably the viewer's most
   * recent — those keys were never enumerated and any of them may be newer.
   *
   * 🔴 STOPPING AT THE BOUND IS NOT ENOUGH TO SET IT, and conflating the two is
   * what once put a false sentence on screen: a store holding exactly
   * `KEPT_LIST_MAX_PAGES * KEPT_PAGE_LIMIT` keys is enumerated IN FULL by a walk
   * that uses every page, so it is `truncated` (older runs fell outside the
   * hydration horizon) and NOT `incomplete`. The walk settles that with one
   * extra row rather than inferring it from the host's cursor — see
   * {@link KEPT_LIST_PROBE_LIMIT}.
   *
   * 🔴 `incomplete` implies `truncated`; the reverse does not hold.
   */
  incomplete: boolean;
}

/**
 * Walk the viewer's `kept:` KEYS forward, to the end of the store or to
 * {@link KEPT_LIST_MAX_PAGES}, whichever comes first — `more` says which.
 *
 * Keys only — `store.list` returns key + `updatedAt`, never values — so this is
 * cheap enough to run to completion, and the expensive per-row `get` is spent
 * only on the tail {@link listKeptRuns} keeps.
 *
 * `more` is true only when keys exist that this walk did NOT enumerate.
 *
 * 🔴 A CURSOR IS NOT EVIDENCE OF A NEXT ROW, AND READING IT AS ONE PUT A FALSE
 * SENTENCE ON SCREEN. The host emits `nextCursor` **iff the page FILLED** —
 * `rows.length === input.limit` in civitai `apps.router` `storage.list` — so a
 * store holding exactly `KEPT_LIST_MAX_PAGES * KEPT_PAGE_LIMIT` keys fills the
 * last enumerable page and hands back a cursor for a store with nothing behind
 * it. `more = "the last page offered a cursor"` therefore reported a COMPLETE
 * enumeration as cut short, and the gallery rendered
 * `INCOMPLETE_NOTICE`'s *"You've kept more than this app can list"* over a grid
 * that held the viewer's newest keep. The {@link KEPT_LIST_PROBE_LIMIT} probe
 * below settles it by asking, rather than by inferring from the cursor.
 */
async function listKeptKeys(store: DraftStore): Promise<{ keys: string[]; more: boolean }> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < KEPT_LIST_MAX_PAGES; page++) {
    const res = await store.list({ prefix: KEPT_PREFIX, limit: KEPT_PAGE_LIMIT, cursor });
    for (const k of res.keys) keys.push(k.key);
    // 🔴 No cursor ⇒ the host has nothing further for this prefix. That is the
    // ONLY clean exit inside the loop: a short page also ends the walk, because
    // the host emits a cursor if and only if the page filled.
    if (res.nextCursor == null) return { keys, more: false };
    cursor = res.nextCursor;
  }
  // The bound was reached with a cursor in hand — the ONE state where the cursor
  // is ambiguous. One cheap row settles it: a key here is a key the walk did not
  // enumerate, and no key means the store ended exactly on the boundary.
  const probe = await store.list({ prefix: KEPT_PREFIX, limit: KEPT_LIST_PROBE_LIMIT, cursor });
  return { keys, more: probe.keys.length > 0 };
}

/**
 * Up to {@link KEPT_LIST_LIMIT} kept runs, newest-kept first — the viewer's most
 * recent ones unless the page comes back {@link KeptRunPage.incomplete}.
 *
 * 🔴 THE TAIL, NOT THE HEAD. Key order is chronological (see
 * {@link KEPT_LIST_LIMIT}), so when the walk reaches the end of the store the
 * newest runs are at the END of it. Taking the tail is what makes the app's own
 * copy true there: press Keep and the run you just made is in the gallery, which
 * was NOT the case while this read took the first page and called it the set.
 *
 * ⚠️ Bounded honestly: that holds of a COMPLETE walk. When the walk stops at
 * {@link KEPT_LIST_MAX_PAGES} the tail is the newest of the enumerated prefix
 * and nothing more, so the page comes back {@link KeptRunPage.incomplete} and
 * the gallery says something true of that state instead. Returning the prefix's
 * tail is still the best available set — the head would be the viewer's oldest
 * runs, which is the defect this function was written to remove.
 *
 * 🔴 Malformed rows are dropped silently and the rest are returned. A single bad
 * blob must not empty the gallery — the failure mode of the alternative is "all
 * your kept images vanished", which is indistinguishable to the viewer from data
 * loss.
 *
 * 🔴 Rejects rather than resolving empty when the store read fails. An empty list
 * and a failed list are different facts and the gallery renders them differently
 * — collapsing them here is what made a failed read say "you haven't kept
 * anything yet", the one sentence this module exists to prevent.
 */
export async function listKeptRuns(store: DraftStore): Promise<KeptRunPage> {
  const { keys, more } = await listKeptKeys(store);
  const newest = keys.slice(-KEPT_LIST_LIMIT);
  const rows = await Promise.all(newest.map((key) => store.get<unknown>(key)));
  return {
    runs: rows.filter(isKeptRun).sort((a, b) => b.keptAt - a.keptAt),
    truncated: more || keys.length > newest.length,
    incomplete: more,
  };
}

/** The kept runs made with one published generator, newest first. */
export function runsForGenerator(runs: readonly KeptRun[], generatorKey: string | undefined): KeptRun[] {
  if (!generatorKey) return [];
  return runs.filter((r) => r.generatorKey === generatorKey);
}

/** Total kept IMAGES across runs — what the gallery counts, not the run count. */
export function keptImageCount(runs: readonly KeptRun[]): number {
  return runs.reduce((n, r) => n + r.imageIds.length, 0);
}

/**
 * Flatten kept runs into a newest-first image feed, each cell carrying the run
 * that produced it so the gallery can attribute every image without a lookup.
 *
 * 🔴 Order WITHIN a run is the run's own `imageIds` order, which is the order the
 * viewer saw in the result grid and selected against. Re-sorting it would make
 * "the second one" mean something different in the gallery than it did in the
 * queue.
 */
export interface KeptImageCell {
  imageId: number;
  run: KeptRun;
}

export function keptImageFeed(runs: readonly KeptRun[]): KeptImageCell[] {
  const out: KeptImageCell[] = [];
  for (const run of [...runs].sort((a, b) => b.keptAt - a.keptAt)) {
    for (const imageId of run.imageIds) out.push({ imageId, run });
  }
  return out;
}

/**
 * 🔴 A HARD PLATFORM CAP, not a tuning knob. The host's gated-image read
 * (`useGatedImages().getImages` → `blocks.getImagesByIds`) validates its input as
 * `z.number().int().positive().array().min(1).max(100)`, so a request carrying
 * 101 ids is REJECTED OUTRIGHT — not truncated. With {@link KEPT_LIST_LIMIT} runs
 * of up to 4 images each, a viewer's gallery reaches that ceiling long before the
 * store's, and the failure would present as "the whole gallery is broken" rather
 * than as a too-large request.
 */
export const GATED_READ_MAX_IDS = 100;

/**
 * Split ids into request-sized batches, de-duplicated and order-preserving.
 *
 * De-duplication is not tidiness: the same image id can legitimately appear in
 * two kept runs (a re-keep of the same output), and spending cap slots on a
 * repeat would silently push a different image out of the last batch.
 */
export function chunkImageIds(
  ids: readonly number[],
  size: number = GATED_READ_MAX_IDS,
): number[][] {
  const step = Math.max(1, Math.floor(size));
  const seen = new Set<number>();
  const unique: number[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  const out: number[][] = [];
  for (let i = 0; i < unique.length; i += step) out.push(unique.slice(i, i + step));
  return out;
}
