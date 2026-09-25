// The viewer's own per-app key/value store, over `/api/v1/blocks/app-storage/*`.
//
// Replaces the `APP_STORAGE_*` bridge messages and the `useAppStorage` hook. The
// SDK wraps the five routes as `AppClient.storage`, so this file is only the
// binding: await the client, then forward.
//
// It is shaped to satisfy `lib/drafts.ts`'s `DraftStore` interface, which was
// already written as "the subset of the storage API the draft layer needs" — so
// the draft layer itself did not change. `updatedAt` is still revived to a `Date`
// by the SDK client, exactly as the hook did, so `listDrafts`' sort still works.
//
// ⚠️ THE MIGRATION DELTA: AN ANONYMOUS VIEWER NOW GETS A REJECTION WHERE THE
// BRIDGE RESOLVED A READ TO `null`. The routes take `apps:storage:read` /
// `apps:storage:write`, whose binding requires an authenticated subject, so an
// anon call is refused rather than answered empty. 🔴 Gate on `viewer` rather than
// reading an empty result as "nothing stored" — and note that every failure here
// REJECTS: there is no path that resolves to mean "could not read". `App.tsx`
// already only loads drafts for a signed-in viewer, which is why this did not
// change behaviour; do not add a `catch` that turns a refusal into an empty list,
// because that would silently present a viewer's own saved drafts as absent.

import { useMemo } from 'react';

import type { DraftStore } from '../lib/drafts.js';
import { getClient } from './client.js';

/** The storage surface, bound to the initialised client. */
export function createAppStorage(): DraftStore {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const app = await getClient();
      return app.storage.get<T>(key);
    },
    async set<T = unknown>(key: string, value: T): Promise<{ ok: true; sizeBytes?: number }> {
      const app = await getClient();
      return app.storage.set<T>(key, value);
    },
    async delete(key: string): Promise<{ ok: true; deleted: boolean }> {
      const app = await getClient();
      return app.storage.delete(key);
    },
    async list(opts?: { prefix?: string; limit?: number; cursor?: string }) {
      const app = await getClient();
      const res = await app.storage.list(opts);
      // 🔴 `nextCursor` is passed through only when present. The server sets it iff
      // the page it returned was full, so its ABSENCE is what proves a scan
      // completed — `listKeptRuns` treats that as a money decision. Never default
      // it and never re-derive it from `keys.length`.
      return res.nextCursor !== undefined
        ? { keys: res.keys, nextCursor: res.nextCursor }
        : { keys: res.keys };
    },
  };
}

/**
 * The hook shape `App.tsx` binds into `deps.drafts`.
 *
 * Memoised for the same identity reason as `useSharedStorage`.
 */
export function useAppStorage(): DraftStore {
  return useMemo(() => createAppStorage(), []);
}
