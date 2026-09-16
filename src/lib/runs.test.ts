import { describe, expect, it } from 'vitest';

import type { DraftStore } from './drafts.js';
import {
  GATED_READ_MAX_IDS,
  KEPT_LIST_LIMIT,
  KEPT_LIST_MAX_PAGES,
  KEPT_PAGE_LIMIT,
  KEPT_PREFIX,
  chunkImageIds,
  isKeptRun,
  keptImageCount,
  keptImageFeed,
  keptKey,
  listKeptRuns,
  runsForGenerator,
  saveKeptRun,
  type KeptRun,
} from './runs.js';
// 🔴 ONE FAKE, SHARED. This file used to carry its own host-faithful copy while
// `test-helpers.ts` served the DOM suites a store that ignored `limit` and
// `cursor` entirely — so the paging contract was modelled in exactly the one
// place that already knew about it, and every integration test ran against a
// store with no horizon at all. The fake's own docblock states the contract it
// mirrors.
import { memoryDraftStore } from '../test-helpers.js';

function run(over: Partial<KeptRun> = {}): KeptRun {
  return {
    id: 'kept_1',
    keptAt: 1_000,
    imageIds: [101],
    generatorName: 'Neon Portrait Studio',
    generatorKey: 'shared:99',
    buttonLabel: 'Cyberpunk',
    ...over,
  };
}

describe('kept-run storage', () => {
  it('namespaces keys so a prefix list never picks up drafts', () => {
    expect(keptKey('abc')).toBe('kept:abc');
    expect(KEPT_PREFIX).toBe('kept:');
    expect(keptKey('abc').startsWith('draft:')).toBe(false);
  });

  it('round-trips a run and enumerates it newest-KEPT first', async () => {
    const store = memoryDraftStore();
    await saveKeptRun(store, run({ id: 'a', keptAt: 1 }));
    await saveKeptRun(store, run({ id: 'c', keptAt: 3 }));
    await saveKeptRun(store, run({ id: 'b', keptAt: 2 }));
    const page = await listKeptRuns(store);
    expect(page.runs.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    // A short page is the WHOLE set: nothing to disclose.
    expect(page.truncated).toBe(false);
  });

  /**
   * 🔴 ONE BAD BLOB MUST NOT EMPTY THE GALLERY. A half-written or hand-edited KV
   * row is indistinguishable to the viewer from data loss if it takes the whole
   * list down — "all your kept images vanished" is the worst reading available,
   * and it would be caused by the app, not by the platform.
   */
  it('drops malformed rows and keeps the rest', async () => {
    const store = memoryDraftStore();
    await saveKeptRun(store, run({ id: 'good', keptAt: 2 }));
    await store.set(keptKey('garbage'), { id: 'garbage', nope: true });
    await store.set(keptKey('null'), null);
    await store.set(keptKey('empty'), run({ id: 'empty', imageIds: [] }));
    const listed = await listKeptRuns(store);
    expect(listed.runs.map((r) => r.id)).toEqual(['good']);
  });
});

/**
 * 🔴 THE HORIZON IS THE OLDEST RUNS NOW, AND THAT IS THE WHOLE POINT. This read
 * used to take ONE page. The host lists `ORDER BY key` ascending and
 * `newId('kept')` leads with a base-36 `Date.now()` stamp, so key order IS
 * chronological order — meaning the single page was the viewer's **oldest** N,
 * and the keep they had just made was the first thing missing from the gallery
 * that exists to show it. The PR that shipped that also asserted "no forward-only
 * paging recovers them"; forward paging is exactly what recovers them.
 *
 * So: walk the KEYS forward to the end (cheap — `list` returns no values), hydrate
 * the TAIL, and report whether anything was left outside it.
 */
describe('the gallery reads the viewer NEWEST runs, and reports what it left out', () => {
  /** `n` runs whose KEYS ascend with time, exactly as `newId('kept')` mints them. */
  async function seed(store: DraftStore, n: number) {
    for (let i = 0; i < n; i++) {
      // Zero-padded so lexicographic key order IS chronological order, which is
      // what the real id's leading base-36 `Date.now()` stamp gives us.
      await saveKeptRun(store, run({ id: `k${String(i).padStart(5, '0')}`, keptAt: 1_000 + i }));
    }
  }

  const id = (i: number) => `k${String(i).padStart(5, '0')}`;

  /**
   * 🔴 THE REGRESSION. Past the horizon it is the OLDEST runs that go, and the
   * newest — the one the viewer just kept — is present. A fixture at
   * `KEPT_LIST_LIMIT + 1` puts exactly one run outside the window, so an
   * implementation that takes the head instead of the tail differs on it by
   * exactly the two ids asserted here.
   */
  it('keeps the newest runs and drops the oldest past the horizon', async () => {
    const store = memoryDraftStore();
    await seed(store, KEPT_LIST_LIMIT + 1);
    const { runs, truncated } = await listKeptRuns(store);
    const ids = runs.map((r) => r.id);

    expect(runs).toHaveLength(KEPT_LIST_LIMIT);
    // The most recent keep is there…
    expect(ids).toContain(id(KEPT_LIST_LIMIT));
    expect(ids[0]).toBe(id(KEPT_LIST_LIMIT));
    // …and the very first one is what fell outside.
    expect(ids).not.toContain(id(0));
    expect(truncated).toBe(true);
  });

  /**
   * 🔴 The walk crosses page boundaries, which is the mechanism the old read did
   * not have. `KEPT_PAGE_LIMIT` is the host's per-call maximum, so reaching a run
   * at index 200+ requires a second `list` with the first page's cursor.
   */
  it('crosses page boundaries to reach a run the first page cannot hold', async () => {
    const store = memoryDraftStore();
    await seed(store, KEPT_PAGE_LIMIT + 5);
    const ids = (await listKeptRuns(store)).runs.map((r) => r.id);
    expect(ids).toContain(id(KEPT_PAGE_LIMIT + 4));
    expect(ids).toContain(id(KEPT_PAGE_LIMIT));
  });

  /**
   * 🔴 `truncated` is now a DEFINITE claim, where the one-page version could only
   * hedge: a store holding exactly `KEPT_LIST_LIMIT` runs used to trip the flag
   * because its single page FILLED, so the UI had to say "may not be here" about
   * a set that was complete. Enumerating the keys removes the ambiguity.
   */
  it('reports nothing left out when the store holds exactly the horizon', async () => {
    const store = memoryDraftStore();
    await seed(store, KEPT_LIST_LIMIT);
    const page = await listKeptRuns(store);
    expect(page.runs).toHaveLength(KEPT_LIST_LIMIT);
    expect(page.truncated).toBe(false);

    // NEGATIVE CONTROL at the other side of the boundary: one row more and the
    // flag must go the other way.
    const over = memoryDraftStore();
    await seed(over, KEPT_LIST_LIMIT + 1);
    expect((await listKeptRuns(over)).truncated).toBe(true);
  });

  /**
   * 🔴 THE WALK IS BOUNDED. A store that keeps offering a cursor must not turn a
   * gallery open into an unbounded request loop — so the walk stops at
   * `KEPT_LIST_MAX_PAGES` and REPORTS that it did rather than presenting what it
   * has as the whole set.
   */
  it('stops at the page bound and still reports the truncation', async () => {
    const inner = memoryDraftStore();
    let calls = 0;
    const endless: DraftStore = {
      ...inner,
      async list(opts) {
        calls += 1;
        const res = await inner.list(opts);
        // Always another page, however little it returned.
        return { ...res, nextCursor: res.nextCursor ?? 'a2VwdDp6eno=' };
      },
    };
    await saveKeptRun(inner, run({ id: 'only' }));

    const page = await listKeptRuns(endless);
    expect(calls).toBe(KEPT_LIST_MAX_PAGES);
    expect(page.truncated).toBe(true);
  });

  /**
   * 🔴 THE CUT-SHORT WALK IS NOT THE NEWEST, AND THE PAGE NOW SAYS SO. The test
   * above seeds ONE run, so its tail is trivially correct and it can only prove
   * the walk stops — it cannot see what the stopped walk CONTAINS. This one puts
   * real rows past the bound.
   *
   * `KEPT_LIST_MAX_PAGES * KEPT_PAGE_LIMIT` keys are enumerable; seeding 100 more
   * than that leaves the viewer's 100 most recent keeps outside the walk
   * entirely. The tail of that prefix is therefore the newest of the OLDER part
   * of the store — genuinely not the viewer's most recent — and `incomplete` is
   * the fact that says so. The overshoot is deliberate: at exactly the bound the
   * walk completes and the distinction is unreachable.
   */
  it('reports a cut-short walk as incomplete, because its tail is not the newest', async () => {
    const enumerable = KEPT_LIST_MAX_PAGES * KEPT_PAGE_LIMIT;
    const beyond = 100;
    const store = memoryDraftStore();
    await seed(store, enumerable + beyond);

    const page = await listKeptRuns(store);

    // The walk was cut short: both facts are true and they are DIFFERENT facts.
    expect(page.incomplete).toBe(true);
    expect(page.truncated).toBe(true);

    const ids = page.runs.map((r) => r.id);
    // What it holds is the tail of the ENUMERATED prefix…
    expect(ids[0]).toBe(id(enumerable - 1));
    // …and the viewer's most recent keeps were never enumerated at all. This is
    // the honest, uncomfortable half — asserted rather than papered over.
    expect(ids).not.toContain(id(enumerable + beyond - 1));
  });

  /**
   * NEGATIVE CONTROL for the flag: a walk that reaches the end of the store is
   * complete even when it left older runs outside the hydration horizon. Without
   * this, `incomplete: true` would be indistinguishable from `incomplete:
   * truncated`.
   */
  it('does not call a completed walk incomplete, even when it truncated', async () => {
    const store = memoryDraftStore();
    await seed(store, KEPT_LIST_LIMIT + 1);
    const page = await listKeptRuns(store);
    expect(page.truncated).toBe(true);
    expect(page.incomplete).toBe(false);
  });

  /** The store's own list contract — the thing the walk's exit condition reads. */
  it('asks the host for its maximum page size, never more', async () => {
    const store = memoryDraftStore();
    const limits: Array<number | undefined> = [];
    const spy: DraftStore = {
      ...store,
      async list(opts) {
        limits.push(opts?.limit);
        return store.list(opts);
      },
    };
    await seed(store, 3);
    await listKeptRuns(spy);
    expect(limits).toEqual([KEPT_PAGE_LIMIT]);
    expect(KEPT_PAGE_LIMIT).toBe(200);
  });
});

describe('isKeptRun', () => {
  it('accepts a well-formed run', () => {
    expect(isKeptRun(run())).toBe(true);
  });

  /**
   * 🔴 An empty or garbage id list is the case that matters: such a record renders
   * as a kept run with no images — a card asserting "you kept this" over nothing.
   */
  it('rejects a run carrying no usable image ids', () => {
    expect(isKeptRun(run({ imageIds: [] }))).toBe(false);
    expect(isKeptRun(run({ imageIds: ['101'] as never }))).toBe(false);
    expect(isKeptRun(run({ imageIds: [Number.NaN] }))).toBe(false);
    expect(isKeptRun(run({ imageIds: undefined as never }))).toBe(false);
  });

  it('rejects rows missing any field the UI claims provenance from', () => {
    expect(isKeptRun(run({ id: '' }))).toBe(false);
    expect(isKeptRun(run({ keptAt: Number.NaN }))).toBe(false);
    expect(isKeptRun(run({ generatorName: undefined as never }))).toBe(false);
    expect(isKeptRun(run({ buttonLabel: undefined as never }))).toBe(false);
    expect(isKeptRun(null)).toBe(false);
    expect(isKeptRun('kept')).toBe(false);
  });
});

describe('runsForGenerator — provenance, not a default', () => {
  const runs = [
    run({ id: 'a', generatorKey: 'shared:1' }),
    run({ id: 'b', generatorKey: 'shared:2' }),
    run({ id: 'c', generatorKey: undefined }),
  ];

  it('returns only the runs made with that generator', () => {
    expect(runsForGenerator(runs, 'shared:1').map((r) => r.id)).toEqual(['a']);
    expect(runsForGenerator(runs, 'shared:2').map((r) => r.id)).toEqual(['b']);
  });

  /**
   * 🔴 An unpublished draft has no shared key. Returning everything for a missing
   * key would show one generator's images under another's name — the one failure
   * mode an attribution feature must not have.
   */
  it('returns NOTHING for a generator with no key, never everything', () => {
    expect(runsForGenerator(runs, undefined)).toEqual([]);
    expect(runsForGenerator(runs, '')).toEqual([]);
  });
});

describe('keptImageFeed / keptImageCount', () => {
  it('counts IMAGES, not runs', () => {
    expect(keptImageCount([run({ imageIds: [1, 2, 3] }), run({ imageIds: [4] })])).toBe(4);
    expect(keptImageCount([])).toBe(0);
  });

  it('flattens newest-run-first while preserving each run own image order', () => {
    const feed = keptImageFeed([
      run({ id: 'old', keptAt: 1, imageIds: [10, 11] }),
      run({ id: 'new', keptAt: 9, imageIds: [20, 21] }),
    ]);
    // Newest run first; WITHIN a run the ids keep the order the viewer saw in the
    // result grid, so "the second one" means the same thing in both places.
    expect(feed.map((cell) => cell.imageId)).toEqual([20, 21, 10, 11]);
    expect(feed.map((cell) => cell.run.id)).toEqual(['new', 'new', 'old', 'old']);
  });
});

describe('chunkImageIds — the gated read is capped at 100 ids per request', () => {
  it('matches the platform cap by default', () => {
    expect(GATED_READ_MAX_IDS).toBe(100);
  });

  /**
   * 🔴 The host validates its input as `.array().min(1).max(100)` and REJECTS an
   * over-long request rather than truncating it — so an unchunked read of a large
   * gallery fails entirely, which presents as "the whole gallery is broken".
   *
   * 101 is deliberately one past the boundary: a mutant using `>` instead of `>=`,
   * or an off-by-one batch size, changes this result.
   */
  it('splits past the cap and never emits an over-long batch', () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const batches = chunkImageIds(ids);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(100);
    expect(batches[1]).toEqual([101]);
    expect(batches.every((b) => b.length <= GATED_READ_MAX_IDS)).toBe(true);
    // Nothing is lost or reordered across the split.
    expect(batches.flat()).toEqual(ids);
  });

  it('is a no-op shape for a small list, and empty for none', () => {
    expect(chunkImageIds([1, 2, 3])).toEqual([[1, 2, 3]]);
    expect(chunkImageIds([])).toEqual([]);
  });

  /**
   * 🔴 De-duplication is not tidiness. The same image id can appear in two kept
   * runs (a re-keep of the same output); spending a cap slot on a repeat would
   * silently push a DIFFERENT image out of the final batch.
   */
  it('de-duplicates while preserving first-seen order', () => {
    expect(chunkImageIds([5, 3, 5, 9, 3], 10)).toEqual([[5, 3, 9]]);
  });

  it('never divides by a degenerate size', () => {
    expect(chunkImageIds([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    expect(chunkImageIds([1, 2, 3], -4)).toEqual([[1], [2], [3]]);
  });
});
