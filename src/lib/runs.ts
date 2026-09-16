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
 */
export const KEPT_LIST_MAX_PAGES = 8;

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
 * 🔴 THE GALLERY IS ADD-ONLY, DELIBERATELY AND KNOWINGLY. There is no
 * `deleteKeptRun` — one existed and was cut in the round-0 audit because its only
 * caller was its own test, and a helper proved out by nothing but itself is not
 * coverage. So a viewer can keep an image and cannot un-keep it. That is a real
 * gap, named here rather than left to be discovered: it closes when a Remove
 * control ships in `components/KeptGallery.tsx` with a test that drives it, and
 * the check is mechanical — that control exists on `main`, or it does not.
 */
export async function saveKeptRun(store: DraftStore, run: KeptRun): Promise<void> {
  await store.set(keptKey(run.id), run);
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
   * The key walk was cut short at {@link KEPT_LIST_MAX_PAGES}, so
   * {@link KeptRunPage.runs} is NOT provably the viewer's most recent — the keys
   * past the bound were never enumerated and any of them may be newer.
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
 * `more` is true only when the walk hit {@link KEPT_LIST_MAX_PAGES} with the host
 * still offering a cursor, i.e. the enumeration itself was cut short.
 */
async function listKeptKeys(store: DraftStore): Promise<{ keys: string[]; more: boolean }> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < KEPT_LIST_MAX_PAGES; page++) {
    const res = await store.list({ prefix: KEPT_PREFIX, limit: KEPT_PAGE_LIMIT, cursor });
    for (const k of res.keys) keys.push(k.key);
    // 🔴 No cursor ⇒ the host has nothing further for this prefix. That is the
    // ONLY clean exit: a short page also ends the walk, because the host emits a
    // cursor if and only if the page filled.
    if (res.nextCursor == null) return { keys, more: false };
    cursor = res.nextCursor;
  }
  return { keys, more: true };
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
