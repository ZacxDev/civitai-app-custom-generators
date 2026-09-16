// KEPT RUNS — the app's durable end-state for a generation, over the per-viewer
// App Blocks KV store (`useAppStorage`, scope `apps:storage:write`, already
// granted). Sibling of `lib/drafts.ts`, same store, a different key namespace.
//
// 🔴 WHY THIS EXISTS — the app had no terminal. The Runner's output queue
// documented itself as in-session ("a Back/reload clears it") and was guarded by
// `beforeunload`, so the loop was: press a stranger's button → spend real Buzz →
// get a 120px thumbnail → navigate away → it is gone. Nothing the viewer made
// survived the tab. An app whose entire output evaporates has produced nothing a
// person can come back for, and that is a usefulness defect, not a styling one.
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
 * and this app does not page the gallery, so this is a real horizon: past it, the
 * gallery shows the newest {@link KEPT_LIST_LIMIT} and says so rather than
 * silently presenting a prefix as the whole set — the same honesty rule the
 * Discover board already applies to its own one-page read.
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

export async function saveKeptRun(store: DraftStore, run: KeptRun): Promise<void> {
  await store.set(keptKey(run.id), run);
}

export async function deleteKeptRun(store: DraftStore, id: string): Promise<boolean> {
  const res = await store.delete(keptKey(id));
  return res.deleted;
}

/**
 * Every kept run this viewer holds, newest-kept first.
 *
 * 🔴 Malformed rows are dropped silently and the rest are returned. A single bad
 * blob must not empty the gallery — the failure mode of the alternative is "all
 * your kept images vanished", which is indistinguishable to the viewer from data
 * loss.
 */
export async function listKeptRuns(store: DraftStore): Promise<KeptRun[]> {
  const { keys } = await store.list({ prefix: KEPT_PREFIX, limit: KEPT_LIST_LIMIT });
  const rows = await Promise.all(keys.map((k) => store.get<unknown>(k.key)));
  return rows.filter(isKeptRun).sort((a, b) => b.keptAt - a.keptAt);
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
