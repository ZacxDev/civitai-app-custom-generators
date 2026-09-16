import { describe, expect, it } from 'vitest';

import type { DraftStore } from './drafts.js';
import {
  GATED_READ_MAX_IDS,
  KEPT_PREFIX,
  chunkImageIds,
  deleteKeptRun,
  isKeptRun,
  keptImageCount,
  keptImageFeed,
  keptKey,
  listKeptRuns,
  runsForGenerator,
  saveKeptRun,
  type KeptRun,
} from './runs.js';

/** Minimal in-memory store (mirrors the per-viewer KV contract, as drafts.test does). */
function memoryDraftStore(): DraftStore {
  const map = new Map<string, unknown>();
  return {
    async get(key) {
      return (map.has(key) ? map.get(key) : null) as never;
    },
    async set(key, value) {
      map.set(key, value);
      return { ok: true } as const;
    },
    async delete(key) {
      const had = map.has(key);
      map.delete(key);
      return { ok: true, deleted: had } as const;
    },
    async list(opts) {
      const prefix = opts?.prefix ?? '';
      return { keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

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
    const listed = await listKeptRuns(store);
    expect(listed.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('deletes by id and reports whether anything went', async () => {
    const store = memoryDraftStore();
    await saveKeptRun(store, run({ id: 'a' }));
    expect(await deleteKeptRun(store, 'a')).toBe(true);
    expect(await deleteKeptRun(store, 'a')).toBe(false);
    expect(await listKeptRuns(store)).toEqual([]);
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
    expect(listed.map((r) => r.id)).toEqual(['good']);
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
