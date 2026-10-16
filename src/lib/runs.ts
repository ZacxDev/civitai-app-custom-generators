// KEPT RUNS — the app's durable end-state for a generation, over the viewer's
// private `kv` collection of the App Blocks document store
// (`platform/appStorage.ts`, scope `apps:storage`, consent-exempt). Sibling of
// `lib/drafts.ts`, same store, a different key namespace.
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
 * Rows one `list()` call asks for — the document store's hard page ceiling
 * (`limits.listLimitMax`). 🔴 A larger `limit` is REFUSED `invalid_request`, not
 * clamped; the legacy KV allowed 200, and keeping that number would have failed
 * every gallery open.
 */
export const KEPT_PAGE_LIMIT = 100;

/**
 * How many kept runs the gallery hydrates and renders: the viewer's NEWEST this
 * many.
 *
 * 🔴 KEY ORDER IS CHRONOLOGICAL ORDER, AND THE STORE CAN READ IT BACKWARDS. Every
 * kept id is `newId('kept')`, which leads with a fixed-width base-36 `Date.now()`
 * stamp (until ~2059), so descending key order is newest-kept first. The document
 * store sorts a list by `-key`, so the read starts AT the viewer's most recent keep
 * and stops once it has this many — `ceil(KEPT_LIST_LIMIT / KEPT_PAGE_LIMIT)` pages,
 * whatever the store holds.
 *
 * ⚠️ WHAT THIS REPLACED. The legacy KV listed `ORDER BY key` ascending only, so the
 * newest runs sat at the END of the prefix: the read walked every key forward (up
 * to 8 pages of 200, plus a 1-row probe to tell a store that ended on the boundary
 * from one that continued) and kept the tail. A walk cut short at its page bound
 * then ended in the MIDDLE of the store and could not show the viewer's newest —
 * the state `KeptRunPage.incomplete` existed to disclose. Reading newest-first
 * removes that state.
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
 * corrected and some was not, with the runs as the store is BELIEVED to hold
 * them attached so the caller can match its screen to the record.
 *
 * ⚠️ BELIEVED, NOT KNOWN. Read {@link KeptRemovalError.remaining} before acting
 * on this: a rejected write is not proof the write did not land, so `remaining`
 * can report a run as un-pruned that the store has in fact pruned. This
 * paragraph is what an editor hover shows, which is why the caveat is repeated
 * here rather than left to the field below.
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
   * them". The store's `set`/`delete` are HTTP requests, so a lost reply (a
   * dropped connection, a timeout) rejects a write that the server may already
   * have applied. In that case this list reports a run as
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
 * 🔴 `truncated` is a DEFINITE statement: the document store emits a cursor
 * exactly when another key exists, so `true` means "there are kept runs this app
 * did not load" — the viewer's OLDEST ones, since the read is newest-first.
 */
export interface KeptRunPage {
  runs: KeptRun[];
  /** Kept runs exist that are NOT in {@link KeptRunPage.runs} (older ones). */
  truncated: boolean;
  /**
   * The read could not reach the viewer's most recent runs.
   *
   * 🔴 ALWAYS `false` SINCE THE DOCUMENT-STORE PORT, and kept as a field only so
   * the gallery's notice wiring did not have to move with a storage change. The
   * read starts at the newest key (see {@link KEPT_LIST_LIMIT}), so the state this
   * named — a forward walk stopped before the end of the store — cannot occur.
   */
  incomplete: boolean;
}

/**
 * Up to {@link KEPT_LIST_LIMIT} kept runs, newest-kept first.
 *
 * Reads the `kept:` prefix NEWEST-FIRST, values carried on each page (no `get`
 * per key), and stops once it holds {@link KEPT_LIST_LIMIT} keys or the store
 * runs out.
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
  const values: unknown[] = [];
  let cursor: string | undefined;
  let more = false;
  while (values.length < KEPT_LIST_LIMIT) {
    const res = await store.list({
      prefix: KEPT_PREFIX,
      limit: Math.min(KEPT_PAGE_LIMIT, KEPT_LIST_LIMIT - values.length),
      cursor,
      newestFirst: true,
    });
    for (const k of res.keys) values.push(k.value);
    more = res.nextCursor !== undefined;
    if (!more) break;
    cursor = res.nextCursor;
  }
  return {
    runs: values.filter(isKeptRun).sort((a, b) => b.keptAt - a.keptAt),
    truncated: more,
    incomplete: false,
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
