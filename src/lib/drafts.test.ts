import { describe, expect, it } from 'vitest';

import { DRAFT_PREFIX, deleteDraft, listDrafts, loadDraft, saveDraft, type DraftStore, type StoredDraft } from './drafts.js';
import { newGenerator } from './generator.js';

/** Minimal in-memory DraftStore (mirrors the per-viewer KV contract). */
function memoryStore(): DraftStore {
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
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      return { keys };
    },
  };
}

function draft(id: string, name: string, updatedAt: number): StoredDraft {
  return { id, config: newGenerator({ name }), updatedAt };
}

describe('draft store', () => {
  it('saves and loads a draft under the namespaced key', async () => {
    const store = memoryStore();
    await saveDraft(store, draft('g1', 'One', 100));
    const loaded = await loadDraft(store, 'g1');
    expect(loaded?.config.name).toBe('One');
    // stored under the draft: prefix
    const { keys } = await store.list({ prefix: DRAFT_PREFIX });
    expect(keys.map((k) => k.key)).toEqual(['draft:g1']);
  });

  it('lists drafts newest-first', async () => {
    const store = memoryStore();
    await saveDraft(store, draft('g1', 'Old', 100));
    await saveDraft(store, draft('g2', 'New', 200));
    const list = await listDrafts(store);
    expect(list.map((d) => d.config.name)).toEqual(['New', 'Old']);
  });

  it('deletes a draft idempotently', async () => {
    const store = memoryStore();
    await saveDraft(store, draft('g1', 'One', 100));
    expect(await deleteDraft(store, 'g1')).toBe(true);
    expect(await deleteDraft(store, 'g1')).toBe(false);
    expect(await loadDraft(store, 'g1')).toBeNull();
  });
});
