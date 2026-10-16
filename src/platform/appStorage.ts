// The viewer's own per-app key/value store, over ONE private collection of the
// App Blocks document store (`kv`, scope `apps:storage`).
//
// It replaces the legacy per-viewer KV (`app.storage.get/set/delete/list`, scopes
// `apps:storage:read` / `:write`), which is deprecated. Every caller keeps the
// `DraftStore` shape it had (`lib/drafts.ts`, `lib/runs.ts`, the App Store backfill
// ledger in `lib/storeListing.ts`); only this file knows documents exist.
//
// 🔴 THE MAPPING IS FIXED, AND SOMETHING OUTSIDE THIS REPO DEPENDS ON IT EXACTLY.
// Existing viewers' rows are copied from the legacy KV by a separate, hand-run step
// at go-live, and that copy writes what this module reads. Changing any rule below
// strands every copied row — a viewer's drafts, their kept images and the backfill
// ledger:
//
//   1. ONE collection, `kv`, declared `{ "visibility": "private" }`, no indexes.
//   2. Document key = the legacy key, byte-for-byte: `draft:<id>`, `kept:<id>`,
//      `store-backfill:v1`. Every one matches the store's key rule
//      `^[A-Za-z0-9._:-]{1,128}$` (ids are `newId()`'s `<prefix>_<base36>_<n>_<rand>`).
//   3. Document data = `{ value: <the legacy value> }` — ALWAYS wrapped, for every
//      key. A document's data must be an object; wrapping only the values that need
//      it would make the shape depend on the value, and the copy would have to
//      reproduce that rule.
//
// `src/platform/appStorage.test.ts` pins all three with literal documents against
// `createFakeStorage` (the SDK's own client over an in-memory server enforcing this
// repo's manifest).
//
// 🔴 EVERY FAILURE REJECTS, as the legacy client did — an anonymous viewer gets
// `sign_in_required`, not an empty result. Callers gate on `viewer`; nothing here
// turns a refusal into "nothing stored", which would present a viewer's own saved
// drafts as absent.

import { useMemo } from 'react';

import type { DocumentStorage, StorageCollection } from '@civitai/sdk';

import type { DraftStore, StoreListPage } from '../lib/drafts.js';
import {
  DEFAULT_RATE_LIMIT_RETRY,
  DOC_LIST_LIMIT_MAX,
  getDocStorage,
  KV_COLLECTION,
  withRateLimitRetry,
  type RateLimitRetryPolicy,
} from './docStore.js';

/** The stored document's data. Rule 3 above. */
export interface KvDocument {
  value: unknown;
}

/**
 * Build the KV surface over a document store.
 *
 * `docs` is a thunk so production can hand in "await the client" and tests the
 * SDK fake's `storage`; the façade exists before the handshake lands.
 */
export function createAppStorage(
  docs: () => DocumentStorage | Promise<DocumentStorage> = getDocStorage,
  retry: RateLimitRetryPolicy = DEFAULT_RATE_LIMIT_RETRY,
): DraftStore {
  const kv = async (): Promise<StorageCollection<KvDocument>> =>
    (await docs()).collection<KvDocument>(KV_COLLECTION);

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const doc = await withRateLimitRetry(async () => (await kv()).get(key), retry);
      // A missing key is `null`, as the legacy `get` answered. A document whose data
      // somehow lacks `value` reads as missing too, rather than as `undefined`.
      return (doc?.data.value ?? null) as T | null;
    },
    async set<T = unknown>(key: string, value: T): Promise<{ ok: true }> {
      await withRateLimitRetry(async () => (await kv()).put(key, { value }), retry);
      return { ok: true };
    },
    async delete(key: string): Promise<{ ok: true; deleted: boolean }> {
      const { deleted } = await withRateLimitRetry(async () => (await kv()).delete(key), retry);
      return { ok: true, deleted };
    },
    async list(opts = {}): Promise<StoreListPage> {
      const page = await withRateLimitRetry(
        async () =>
          (await kv()).list({
            ...(opts.prefix !== undefined ? { keyPrefix: opts.prefix } : {}),
            // 🔴 `-key` WHEN ASKED — newest first, because every id this app mints
            // leads with a base-36 `Date.now()` stamp, so key order IS time order.
            // That is what lets `lib/runs.ts` read the viewer's NEWEST kept runs in
            // two pages instead of walking the whole prefix forward.
            ...(opts.newestFirst ? { sort: '-key' } : {}),
            ...(opts.limit !== undefined
              ? { limit: Math.min(Math.max(1, Math.floor(opts.limit)), DOC_LIST_LIMIT_MAX) }
              : {}),
            ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
          }),
        retry,
      );
      return {
        // The page carries every document's value, so a scan never needs a `get`
        // per key — that is what keeps a gallery open inside the store's read rate.
        keys: page.items.map((doc) => ({ key: doc.key, value: doc.data.value ?? null })),
        // 🔴 `nextCursor` is `null` EXACTLY on the last page (the store reads one row
        // past the page), so its absence here is proof the scan reached the end and
        // its presence is proof another row exists. Passed through, never re-derived.
        ...(page.nextCursor !== null ? { nextCursor: page.nextCursor } : {}),
      };
    },
  };
}

/** The hook shape `App.tsx` binds into `deps.drafts`. Memoised for a stable identity. */
export function useKvStorage(): DraftStore {
  return useMemo(() => createAppStorage(), []);
}
