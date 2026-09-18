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
  KeptRemovalError,
  listKeptRuns,
  removeKeptImages,
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
   *
   * The ceiling asserted here is `KEPT_LIST_MAX_PAGES + 1`, not
   * `KEPT_LIST_MAX_PAGES`: a walk that uses every enumerating page then spends
   * ONE `KEPT_LIST_PROBE_LIMIT`-row `list` to tell "the store ended exactly on
   * the boundary" from "there is more behind it" — the state a filled last page
   * cannot distinguish on the cursor alone. The number is still fixed and still
   * independent of how much this store claims to hold, which is the property
   * this test exists to pin.
   */
  it('stops at the page bound and still reports the truncation', async () => {
    const inner = memoryDraftStore();
    let calls = 0;
    // 🔴 GENUINELY ENDLESS, not merely cursor-happy. An earlier version of this
    // fixture wrapped a ONE-ROW store and forced a cursor onto every reply — a
    // store that CLAIMS to continue and does not. The exhaustion probe reads
    // that correctly as exhausted, which is the right answer and the wrong
    // fixture for this test: what is under test here is the bound, so every
    // page must actually FILL and actually have a successor.
    const endless: DraftStore = {
      ...inner,
      async list(opts) {
        calls += 1;
        const limit = opts?.limit ?? KEPT_PAGE_LIMIT;
        return {
          keys: Array.from({ length: limit }, (_, i) => ({ key: `kept:p${calls}_${i}` })),
          nextCursor: 'a2VwdDp6eno=',
        };
      },
    };

    const page = await listKeptRuns(endless);

    // 🔴 THE ONE PROBE-SENSITIVE ASSERTION IN THIS TEST, and the file should say
    // which it is. `calls` pins the BOUND (8 enumerating pages + 1 exhaustion
    // probe: delete the probe and this reads 8). `truncated` pins nothing about
    // the probe — `1,600 enumerated keys > a 200-row horizon` carries it on its
    // own, whatever `more` comes back as. `incomplete` is the only one that
    // moves with the probe's answer, so it is the assertion that makes this a
    // test about the bound rather than about the horizon.
    expect(calls).toBe(KEPT_LIST_MAX_PAGES + 1);
    expect(page.incomplete).toBe(true);
    expect(page.truncated).toBe(true);

    // 🔴 PINNED BECAUSE IT IS SURPRISING, not because the feature needs it: this
    // fixture is KEYS-ONLY. `endless.list` synthesises `kept:pN_i` keys that
    // `inner` was never asked to hold, so every `get` behind them resolves
    // `null` and the hydrated set is empty. An earlier version of this test
    // seeded one real run into `inner` and asserted nothing about it — the
    // replacement fixture had made that line dead (deleting it changed no
    // result), and a reader would reasonably have assumed the grid held a row.
    // The bound is a property of the KEY walk, which is why the test still says
    // what it claims to say with nothing hydrated.
    expect(page.runs).toHaveLength(0);
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

  /**
   * 🔴 EXACTLY AT THE BOUND THE WALK IS COMPLETE, AND SAYING OTHERWISE PUTS A
   * FALSE SENTENCE ON SCREEN. The host emits `nextCursor` if and only if the
   * page FILLED (`rows.length === input.limit`, civitai `apps.router`
   * `storage.list`), so a store holding exactly
   * `KEPT_LIST_MAX_PAGES * KEPT_PAGE_LIMIT` keys fills the last enumerable page
   * and hands back a cursor for a store that has nothing further. A walk that
   * reads "cursor ⇒ more" therefore reported `incomplete` over a set it had
   * enumerated in full — and `INCOMPLETE_NOTICE` opens *"You've kept more than
   * this app can list"*, which is flatly false there, with the newest keep
   * sitting in the grid underneath it.
   *
   * The two assertions are one claim: the flag is false AND the newest keep is
   * present. Asserting only the flag would pass for an implementation that
   * enumerated the wrong set.
   *
   * ⚠️ The test above deliberately overshoots the bound by 100 and notes that
   * "at exactly the bound the walk completes"; it explains that fixture's shape
   * and does NOT cover this state. This is the boundary itself.
   */
  it('does not call the walk incomplete when the store ends exactly at the bound', async () => {
    const exact = KEPT_LIST_MAX_PAGES * KEPT_PAGE_LIMIT;
    const store = memoryDraftStore();
    await seed(store, exact);

    const page = await listKeptRuns(store);

    expect(page.incomplete).toBe(false);
    // The genuinely newest keep IS present — the walk reached the end.
    expect(page.runs[0]?.id).toBe(id(exact - 1));
    // Older keeps still fell outside the hydration horizon, which is the OTHER
    // fact and stays true.
    expect(page.truncated).toBe(true);
  });

  /**
   * NEGATIVE CONTROL at the other side of that boundary: one key PAST the bound
   * and the walk genuinely cannot see the newest, so the flag must go the other
   * way. Without this arm the fix above is indistinguishable from hardcoding
   * `incomplete: false`.
   */
  it('still reports incomplete one key past the bound', async () => {
    const store = memoryDraftStore();
    const beyond = KEPT_LIST_MAX_PAGES * KEPT_PAGE_LIMIT + 1;
    await seed(store, beyond);

    const page = await listKeptRuns(store);

    expect(page.incomplete).toBe(true);
    expect(page.runs.map((r) => r.id)).not.toContain(id(beyond - 1));
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

/**
 * 🔴 THE DELETE PATH THE STORE DID NOT HAVE, AND THE DEFECT IT CLOSES. A posted
 * image stops resolving for this app permanently (civitai's app-scoped gated
 * read is conjoined with `postId IS NULL`), and nothing removed it from the kept
 * runs — so a posted id came back on every later mount as a "No longer
 * available" tile, and the gallery header kept counting it.
 *
 * Every case here is about SCOPE: what this must not take with it.
 */
describe('removing posted images from the kept runs', () => {
  it('drops the named ids and rewrites the run with the survivors', async () => {
    const store = memoryDraftStore();
    const r = run({ id: 'k1', imageIds: [11, 22, 33] });
    await saveKeptRun(store, r);

    const remaining = await removeKeptImages(store, [r], [22]);

    expect(remaining).toEqual([{ ...r, imageIds: [11, 33] }]);
    // …and durably, which is the whole point: the returned value is not the
    // claim, the store is.
    expect(await store.get(keptKey('k1'))).toEqual({ ...r, imageIds: [11, 33] });
  });

  /**
   * A run with no images is not a kept run (`isKeptRun` rejects an empty
   * `imageIds`), so an emptied row would be dropped on every later read anyway —
   * a permanently-unreadable key spending the viewer's per-app row quota.
   */
  it('deletes the key when the run has nothing left', async () => {
    const store = memoryDraftStore();
    const r = run({ id: 'k1', imageIds: [11] });
    await saveKeptRun(store, r);

    expect(await removeKeptImages(store, [r], [11])).toEqual([]);
    expect(await store.get(keptKey('k1'))).toBeNull();
  });

  /**
   * 🔴 THE ONE THAT WOULD BE SILENT DATA LOSS. Posting from one run must not
   * touch another, and an untouched run must not even be REWRITTEN — a needless
   * `set` spends one of the viewer's per-app writes on a row whose contents did
   * not change, and rewrites a blob that was already correct.
   *
   * ⚠️ THE REASON STATED HERE USED TO BE WRONG, AND IT INVITED THE OPPOSITE
   * CONCLUSION. It said a needless `set` "re-stamps `updatedAt`, which is the key
   * order the whole newest-first read depends on" — which would make this guard
   * about ORDERING. Nothing in the kept-run read consults `updatedAt`:
   * `listKeptKeys` takes `k.key` and nothing else, the host lists a prefix in KEY
   * order, and `listKeptRuns` sorts the hydrated rows by their stored `keptAt`.
   * (`updatedAt` IS the ordering input for `listDrafts`, which is a different
   * read over a different prefix — that is where the sentence came from.) So a
   * re-stamp would be harmless to ordering, and a maintainer reading the old
   * reason could have concluded the guard was load-bearing for something it is
   * not. The guard is right; it is about spending a write and rewriting a
   * correct row.
   */
  it('leaves every other run alone, and does not rewrite it', async () => {
    const writes: string[] = [];
    const store = memoryDraftStore();
    const spied: DraftStore = {
      ...store,
      set: (key, value) => {
        writes.push(key);
        return store.set(key, value);
      },
      delete: (key) => {
        writes.push(`delete:${key}`);
        return store.delete(key);
      },
    };
    const a = run({ id: 'k1', keptAt: 1_000, imageIds: [11, 22] });
    const b = run({ id: 'k2', keptAt: 2_000, imageIds: [33, 44] });
    await saveKeptRun(store, a);
    await saveKeptRun(store, b);

    const remaining = await removeKeptImages(spied, [a, b], [22]);

    expect(remaining).toEqual([{ ...a, imageIds: [11] }, b]);
    expect(writes).toEqual([keptKey('k1')]);
    expect(await store.get(keptKey('k2'))).toEqual(b);
  });

  /**
   * The same image id can legitimately sit in two kept runs (a re-keep of one
   * output — the reason `chunkImageIds` de-duplicates). It has one `postId`, so
   * it has to go from both or the second copy is a dead tile.
   */
  it('removes an id that appears in more than one run', async () => {
    const store = memoryDraftStore();
    const a = run({ id: 'k1', imageIds: [11, 99] });
    const b = run({ id: 'k2', imageIds: [99, 22] });
    await saveKeptRun(store, a);
    await saveKeptRun(store, b);

    const remaining = await removeKeptImages(store, [a, b], [99]);

    expect(remaining).toEqual([{ ...a, imageIds: [11] }, { ...b, imageIds: [22] }]);
  });

  it('NEGATIVE CONTROL: an id nobody kept changes nothing, and writes nothing', async () => {
    const writes: string[] = [];
    const store = memoryDraftStore();
    const spied: DraftStore = {
      ...store,
      set: (key, value) => {
        writes.push(key);
        return store.set(key, value);
      },
      delete: (key) => {
        writes.push(`delete:${key}`);
        return store.delete(key);
      },
    };
    const r = run({ id: 'k1', imageIds: [11, 22] });
    await saveKeptRun(store, r);

    expect(await removeKeptImages(spied, [r], [777])).toEqual([r]);
    expect(await removeKeptImages(spied, [r], [])).toEqual([r]);
    expect(writes).toEqual([]);
  });

  /**
   * 🔴 A HALF-CORRECTED STORE IS A FACT THE CALLER HAS TO KNOW. `App` leaves its
   * in-memory list alone when this rejects, because the next read is what the
   * viewer will actually see; swallowing the failure here would put the screen
   * and the storage out of step with nothing to detect it.
   */
  it('rejects when the store write fails', async () => {
    const store = memoryDraftStore();
    const r = run({ id: 'k1', imageIds: [11, 22] });
    await saveKeptRun(store, r);
    const failing: DraftStore = {
      ...store,
      set: async () => {
        throw new Error('quota exceeded');
      },
    };

    await expect(removeKeptImages(failing, [r], [22])).rejects.toThrow('quota exceeded');
  });

  /**
   * 🔴 A PARTIAL FAILURE HAS TO SAY WHAT DURABLY LANDED, because the writes are
   * fired together and the ones that were already in flight land anyway. The old
   * `Promise.all` abandoned that knowledge at the first rejection: the caller got
   * "something failed" and nothing about WHICH runs were corrected, so the only
   * safe thing it could do was leave its whole list alone — putting the screen
   * and the storage out of step in the direction where the next read silently
   * disagrees.
   *
   * Two runs are affected, ONE write is rejected by key, and the assertion is
   * over BOTH: the surviving write really landed in the store, and
   * `KeptRemovalError.remaining` describes the store as it now is — the failed
   * run at its ORIGINAL contents, the succeeded one rewritten.
   */
  it('reports the half that landed when one write fails', async () => {
    const store = memoryDraftStore();
    const a = run({ id: 'k1', keptAt: 1_000, imageIds: [11, 22] });
    const b = run({ id: 'k2', keptAt: 2_000, imageIds: [33, 44] });
    await saveKeptRun(store, a);
    await saveKeptRun(store, b);
    const flaky: DraftStore = {
      ...store,
      set: async (key, value) => {
        if (key === keptKey('k1')) throw new Error('quota exceeded');
        return store.set(key, value);
      },
    };

    const err = await removeKeptImages(flaky, [a, b], [22, 44]).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(KeptRemovalError);
    expect((err as KeptRemovalError).message).toContain('quota exceeded');
    // k1's write was refused, so the store still holds BOTH of its images; k2's
    // landed. `remaining` says exactly that, in the order the runs were given.
    expect((err as KeptRemovalError).remaining).toEqual([a, { ...b, imageIds: [33] }]);
    expect(await store.get(keptKey('k1'))).toEqual(a);
    expect(await store.get(keptKey('k2'))).toEqual({ ...b, imageIds: [33] });
  });

  /**
   * The same accounting for a DELETE that fails — an emptied run whose key could
   * not be removed is still in the store, so it is still in `remaining`.
   */
  it('keeps an un-deletable emptied run in the reported set', async () => {
    const store = memoryDraftStore();
    const a = run({ id: 'k1', keptAt: 1_000, imageIds: [11] });
    const b = run({ id: 'k2', keptAt: 2_000, imageIds: [33, 44] });
    await saveKeptRun(store, a);
    await saveKeptRun(store, b);
    const flaky: DraftStore = {
      ...store,
      delete: async () => {
        throw new Error('storage unavailable');
      },
    };

    const err = await removeKeptImages(flaky, [a, b], [11, 44]).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(KeptRemovalError);
    expect((err as KeptRemovalError).remaining).toEqual([a, { ...b, imageIds: [33] }]);
    expect(await store.get(keptKey('k1'))).toEqual(a);
  });
});
