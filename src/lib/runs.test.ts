import { describe, expect, it } from 'vitest';

import type { DraftStore } from './drafts.js';
import {
  GATED_READ_MAX_IDS,
  KEPT_LIST_LIMIT,
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

/**
 * In-memory store built to the HOST's list contract, not to a convenient
 * approximation of it — the truncation behaviour under test is entirely a
 * property of that contract, so a fake that ignores `limit` could only ever
 * confirm what the fake was written to believe. Mirrored from civitai's
 * `apps.router` `storage.list`:
 *   - `ORDER BY key` ascending, paging forward with `key > cursor`;
 *   - `nextCursor` emitted IF AND ONLY IF the page filled (`rows.length ===
 *     limit`), so it means "there may be more", never "there is more".
 */
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
      const after = opts?.cursor ? Buffer.from(opts.cursor, 'base64').toString('utf8') : '';
      const limit = opts?.limit ?? 1000;
      const all = [...map.keys()]
        .filter((k) => k.startsWith(prefix) && k > after)
        .sort();
      const page = all.slice(0, limit);
      return {
        keys: page.map((key) => ({ key })),
        nextCursor:
          page.length === limit
            ? Buffer.from(page[page.length - 1], 'utf8').toString('base64')
            : undefined,
      };
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
 * 🔴 THE HORIZON IS REAL AND THE GALLERY HAS TO SAY SO. The read is ONE page, so
 * past `KEPT_LIST_LIMIT` the grid is a prefix of the viewer's history — and an
 * unlabelled prefix is an authoritative wrong answer about what they made. The
 * docblock on `KEPT_LIST_LIMIT` claimed this was already disclosed for three
 * commits while `listKeptRuns` returned a bare array and threw the signal away.
 */
describe('the one-page horizon is REPORTED, not hidden', () => {
  /** `n` runs whose KEYS ascend with time, exactly as `newId('kept')` mints them. */
  async function seed(store: DraftStore, n: number) {
    for (let i = 0; i < n; i++) {
      // Zero-padded so lexicographic key order IS chronological order, which is
      // what the real id's leading base-36 `Date.now()` stamp gives us.
      await saveKeptRun(store, run({ id: `k${String(i).padStart(5, '0')}`, keptAt: 1_000 + i }));
    }
  }

  it('reports truncated when the page FILLS, and hands back exactly one page', async () => {
    const store = memoryDraftStore();
    await seed(store, KEPT_LIST_LIMIT + 1);
    const page = await listKeptRuns(store);
    expect(page.runs).toHaveLength(KEPT_LIST_LIMIT);
    expect(page.truncated).toBe(true);
  });

  /**
   * 🔴 THE PAGE IS THE OLDEST RUNS, NOT THE NEWEST — which is the exact claim the
   * old docblock made ("shows the newest KEPT_LIST_LIMIT"). The host lists
   * `ORDER BY key` ascending and the id's leading timestamp makes key order
   * chronological, so the run that falls off the page is the viewer's most
   * RECENT one. The `keptAt` sort orders within the page and cannot recover it.
   * This is why the notice hedges instead of promising a recency window.
   */
  it('drops the NEWEST run past the horizon, not the oldest', async () => {
    const store = memoryDraftStore();
    await seed(store, KEPT_LIST_LIMIT + 1);
    const { runs } = await listKeptRuns(store);
    const ids = runs.map((r) => r.id);
    // The last one kept — highest keptAt, highest key — is NOT in the page…
    expect(ids).not.toContain(`k${String(KEPT_LIST_LIMIT).padStart(5, '0')}`);
    // …while the very first one is.
    expect(ids).toContain('k00000');
    // Within the page it IS newest-first, which is the only ordering the sort
    // can deliver.
    expect(ids[0]).toBe(`k${String(KEPT_LIST_LIMIT - 1).padStart(5, '0')}`);
  });

  /**
   * 🔴 The boundary, and the one place the flag's two spellings disagree. The
   * host emits `nextCursor` iff the page FILLED, so a store holding exactly
   * `KEPT_LIST_LIMIT` runs reports truncated with nothing actually missing —
   * which is why the copy says "may not be here" rather than asserting a loss.
   * A fixture one row short of the limit cannot see this at all.
   */
  it('a page that fills EXACTLY still reports truncated — the signal is "may be more"', async () => {
    const store = memoryDraftStore();
    await seed(store, KEPT_LIST_LIMIT);
    const page = await listKeptRuns(store);
    expect(page.runs).toHaveLength(KEPT_LIST_LIMIT);
    expect(page.truncated).toBe(true);

    const short = memoryDraftStore();
    await seed(short, KEPT_LIST_LIMIT - 1);
    // NEGATIVE CONTROL: one row fewer and the flag must go the other way.
    expect((await listKeptRuns(short)).truncated).toBe(false);
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
