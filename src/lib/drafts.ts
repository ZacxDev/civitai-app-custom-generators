// Per-user draft persistence over the App Blocks per-viewer KV store
// (`useAppStorage`). A draft is a not-yet-published (or published-and-editable)
// GeneratorConfig owned by the signed-in viewer. Keys are namespaced so a
// prefix-list enumerates only this app's drafts.

import type { GeneratorConfig } from '../types.js';

export const DRAFT_PREFIX = 'draft:';

export function draftKey(id: string): string {
  return DRAFT_PREFIX + id;
}

export interface StoredDraft {
  id: string;
  config: GeneratorConfig;
  updatedAt: number;
  /** Set once the draft has been published; the shared_kv key of the row. */
  publishedKey?: string;
}

/**
 * The subset of `UseAppStorage` the draft layer needs. Structurally compatible
 * with `useAppStorage()` so the App passes the hook straight in; tests can pass
 * an in-memory fake.
 */
export interface DraftStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<{ ok: true; sizeBytes?: number }>;
  delete(key: string): Promise<{ ok: true; deleted: boolean }>;
  list(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ keys: Array<{ key: string }>; nextCursor?: string }>;
}

export async function saveDraft(store: DraftStore, draft: StoredDraft): Promise<void> {
  await store.set(draftKey(draft.id), draft);
}

export async function loadDraft(store: DraftStore, id: string): Promise<StoredDraft | null> {
  return store.get<StoredDraft>(draftKey(id));
}

export async function deleteDraft(store: DraftStore, id: string): Promise<boolean> {
  const res = await store.delete(draftKey(id));
  return res.deleted;
}

/** Enumerate all of the viewer's drafts (newest-first by `updatedAt`). */
export async function listDrafts(store: DraftStore): Promise<StoredDraft[]> {
  const { keys } = await store.list({ prefix: DRAFT_PREFIX, limit: 200 });
  const drafts = await Promise.all(keys.map((k) => store.get<StoredDraft>(k.key)));
  return drafts
    .filter((d): d is StoredDraft => !!d && typeof d === 'object' && 'config' in d)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
