// Per-user draft persistence over the viewer's private `kv` collection of the App
// Blocks document store (`platform/appStorage.ts`). A draft is a not-yet-published
// (or published-and-editable) GeneratorConfig owned by the signed-in viewer. Keys
// are namespaced so a prefix list enumerates only this app's drafts.

import type { GeneratorConfig } from '../types.js';

export const DRAFT_PREFIX = 'draft:';

/**
 * Drafts one list page may return — the document store's own ceiling. A larger
 * `limit` is refused, not clamped (the adapter clamps too).
 */
export const DRAFT_PAGE_LIMIT = 100;

/**
 * Hard bound on the draft scan, so a pathological store cannot turn Browse into an
 * unbounded request loop. 20 pages = 2,000 keys, twice the store's default
 * per-viewer document ceiling (1,000, shared with kept runs and published
 * generators) — so a viewer cannot reach it while that ceiling holds.
 */
export const DRAFT_LIST_MAX_PAGES = 20;

export function draftKey(id: string): string {
  return DRAFT_PREFIX + id;
}

export interface StoredDraft {
  id: string;
  config: GeneratorConfig;
  updatedAt: number;
  /** Set once the draft has been published; the `records` key of the row. */
  publishedKey?: string;
}

/** One page of a key listing. */
export interface StoreListPage {
  /** Each key WITH its stored value — the document store's pages carry values. */
  keys: Array<{ key: string; value: unknown }>;
  /** Present exactly when another key exists after this page. */
  nextCursor?: string;
}

/**
 * The per-viewer key/value surface the draft, kept-run and backfill layers need.
 * `platform/appStorage.ts` implements it over the document store; tests pass an
 * in-memory fake with the same paging rule (`test-helpers.ts`).
 */
export interface DraftStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<{ ok: true }>;
  delete(key: string): Promise<{ ok: true; deleted: boolean }>;
  list(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
    /** Descending key order (newest first, for `newId()` keys). Default ascending. */
    newestFirst?: boolean;
  }): Promise<StoreListPage>;
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

function isStoredDraft(d: unknown): d is StoredDraft {
  return !!d && typeof d === 'object' && 'config' in d;
}

/**
 * Enumerate all of the viewer's drafts (newest-first by `updatedAt`).
 *
 * 🔴 VALUES COME OFF THE LIST PAGES — NO `get` PER KEY. The legacy list returned
 * keys only, so this read every draft with its own `get`: one round trip per draft
 * on every Browse open. The store allows 300 reads a minute per viewer, so a viewer
 * with a few hundred drafts would have spent the whole window on one page load.
 * Now a scan costs one read per {@link DRAFT_PAGE_LIMIT} drafts.
 *
 * 🔴 FOLLOWS THE CURSOR. The legacy read took ONE page of 200 and stopped, so a
 * viewer's drafts past the 200th were silently missing. Bounded by
 * {@link DRAFT_LIST_MAX_PAGES}.
 */
export async function listDrafts(store: DraftStore): Promise<StoredDraft[]> {
  const out: StoredDraft[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < DRAFT_LIST_MAX_PAGES; page++) {
    const res = await store.list({ prefix: DRAFT_PREFIX, limit: DRAFT_PAGE_LIMIT, cursor });
    for (const k of res.keys) if (isStoredDraft(k.value)) out.push(k.value);
    if (res.nextCursor === undefined) break;
    cursor = res.nextCursor;
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
