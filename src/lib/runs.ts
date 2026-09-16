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
 * How many kept runs a single `list()` enumerates. The per-viewer KV is paginated
 * and this app does not page the gallery, so this is a real horizon — and
 * {@link listKeptRuns} reports whether it was reached so the gallery can SAY so
 * rather than silently presenting a prefix as the whole set. Same honesty rule
 * the Discover board already applies to its own one-page read.
 *
 * 🔴 THE PAGE IS KEY-ORDERED, NOT RECENCY-ORDERED, AND THAT IS THE OPPOSITE OF
 * WHAT IT LOOKS LIKE. The host lists `ORDER BY key` ascending and pages forward
 * with `key > cursor` (apps router `storage.list`), and `newId('kept')` puts
 * `Date.now().toString(36)` first in the id — a fixed-width base-36 stamp until
 * ~2059 — so key order IS chronological order, ascending. The one page this app
 * reads is therefore the viewer's **oldest** {@link KEPT_LIST_LIMIT} runs; the
 * `keptAt` sort in {@link listKeptRuns} orders WITHIN that page and cannot
 * recover what the page left out. Past the horizon it is the newest keeps that
 * go missing, which is why the notice must not promise "the newest N" — an
 * earlier version of this docblock did, and nothing in the code supplied it.
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
 * One page of kept runs, plus whether the store had more to give.
 *
 * `truncated` is the host's own signal, not a guess: `list()` returns a
 * `nextCursor` if and only if the page FILLED (apps router `storage.list`), so a
 * cursor means "there may be more", never "there is definitely more" — a store
 * holding exactly {@link KEPT_LIST_LIMIT} runs also fills its page. The UI copy
 * is worded for that: it hedges rather than asserting a count the app cannot see.
 */
export interface KeptRunPage {
  runs: KeptRun[];
  /** The page filled, so runs past {@link KEPT_LIST_LIMIT} may exist unread. */
  truncated: boolean;
}

/**
 * One page of the kept runs this viewer holds, newest-kept first WITHIN the page.
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
  const { keys, nextCursor } = await store.list({ prefix: KEPT_PREFIX, limit: KEPT_LIST_LIMIT });
  const rows = await Promise.all(keys.map((k) => store.get<unknown>(k.key)));
  return {
    runs: rows.filter(isKeptRun).sort((a, b) => b.keptAt - a.keptAt),
    truncated: nextCursor != null,
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
