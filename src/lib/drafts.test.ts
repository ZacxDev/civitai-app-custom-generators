import { describe, expect, it } from 'vitest';

import {
  DRAFT_LIST_MAX_PAGES,
  DRAFT_PAGE_LIMIT,
  DRAFT_PREFIX,
  deleteDraft,
  listDrafts,
  loadDraft,
  saveDraft,
  type DraftStore,
  type StoredDraft,
} from './drafts.js';
import { newGenerator } from './generator.js';
// One fake for the whole repo, built to the document store's list contract.
import { memoryDraftStore } from '../test-helpers.js';

function draft(id: string, name: string, updatedAt: number): StoredDraft {
  return { id, config: newGenerator({ name }), updatedAt };
}

describe('draft store', () => {
  it('saves and loads a draft under the namespaced key', async () => {
    const store = memoryDraftStore();
    await saveDraft(store, draft('g1', 'One', 100));
    const loaded = await loadDraft(store, 'g1');
    expect(loaded?.config.name).toBe('One');
    // stored under the draft: prefix
    const { keys } = await store.list({ prefix: DRAFT_PREFIX });
    expect(keys.map((k) => k.key)).toEqual(['draft:g1']);
  });

  it('lists drafts newest-first', async () => {
    const store = memoryDraftStore();
    await saveDraft(store, draft('g1', 'Old', 100));
    await saveDraft(store, draft('g2', 'New', 200));
    const list = await listDrafts(store);
    expect(list.map((d) => d.config.name)).toEqual(['New', 'Old']);
  });

  it('deletes a draft idempotently', async () => {
    const store = memoryDraftStore();
    await saveDraft(store, draft('g1', 'One', 100));
    expect(await deleteDraft(store, 'g1')).toBe(true);
    expect(await deleteDraft(store, 'g1')).toBe(false);
    expect(await loadDraft(store, 'g1')).toBeNull();
  });
});

/**
 * 🔴 THE READ BUDGET. The document store allows 300 reads a minute per viewer.
 * The legacy scan listed keys and then spent one `get` PER DRAFT, on every Browse
 * open; it also asked for 200 rows a page, which the store refuses outright.
 */
describe('listDrafts over the document store', () => {
  function spy(store: DraftStore) {
    const calls = { list: [] as Array<number | undefined>, get: 0 };
    const wrapped: DraftStore = {
      ...store,
      async get(key) {
        calls.get += 1;
        return store.get(key);
      },
      async list(opts) {
        calls.list.push(opts?.limit);
        return store.list(opts);
      },
    };
    return { wrapped, calls };
  }

  it('reads every value off the list pages and never spends a get per draft', async () => {
    const store = memoryDraftStore();
    for (let i = 0; i < 7; i++) await saveDraft(store, draft(`g${i}`, `D${i}`, i));
    const { wrapped, calls } = spy(store);
    const list = await listDrafts(wrapped);
    expect(list).toHaveLength(7);
    expect(calls.get).toBe(0);
    expect(calls.list).toEqual([DRAFT_PAGE_LIMIT]);
  });

  it('asks for at most the store page ceiling (a larger limit is refused, not clamped)', () => {
    expect(DRAFT_PAGE_LIMIT).toBe(100);
  });

  /**
   * The legacy read took ONE page and stopped, so drafts past it were silently
   * missing. A fixture of `DRAFT_PAGE_LIMIT + 1` puts exactly one draft on a second
   * page — the oldest-keyed one, which a one-page read drops.
   */
  it('follows the cursor past the first page', async () => {
    const store = memoryDraftStore();
    const n = DRAFT_PAGE_LIMIT + 1;
    for (let i = 0; i < n; i++) {
      await saveDraft(store, draft(`g${String(i).padStart(4, '0')}`, `D${i}`, i));
    }
    const { wrapped, calls } = spy(store);
    const list = await listDrafts(wrapped);
    expect(list).toHaveLength(n);
    expect(list.map((d) => d.id)).toContain(`g${String(n - 1).padStart(4, '0')}`);
    expect(calls.list).toHaveLength(2);
  });

  it('is bounded: an endless cursor stops at DRAFT_LIST_MAX_PAGES', async () => {
    let calls = 0;
    const endless: DraftStore = {
      ...memoryDraftStore(),
      async list() {
        calls += 1;
        return { keys: [{ key: `draft:x${calls}`, value: draft(`x${calls}`, 'X', calls) }], nextCursor: 'more' };
      },
    };
    const list = await listDrafts(endless);
    expect(calls).toBe(DRAFT_LIST_MAX_PAGES);
    expect(list).toHaveLength(DRAFT_LIST_MAX_PAGES);
  });

  it('drops a malformed value and keeps the rest', async () => {
    const store = memoryDraftStore();
    await saveDraft(store, draft('good', 'Good', 1));
    await store.set('draft:bad', { nope: true });
    await store.set('draft:null', null);
    expect((await listDrafts(store)).map((d) => d.id)).toEqual(['good']);
  });
});
