// The app-global SHARED board of published generators, over ONE shared collection
// of the App Blocks document store (`records`).
//
// It replaces the legacy shared store (`/api/v1/blocks/shared-storage/*`, scopes
// `apps:storage:shared:read` / `:write`), which is deprecated. Every caller keeps
// the `SharedStorage` shape it had; only this file knows documents exist.
//
// 🔴 THE MAPPING IS FIXED, AND THE PRODUCTION DATA COPY DEPENDS ON IT EXACTLY:
//
//   1. ONE collection, `records`, declared `{ "visibility": "shared", "write":
//      "own", "marks": ["vote"] }` — no counters, no indexes, no `showAuthor`.
//   2. Document key = the legacy shared key (a server-minted ULID), byte-for-byte.
//      Deeplinks (`g/<key>`), share links, a draft's `publishedKey`, a kept run's
//      `generatorKey`, the App Store card's `itemKey` and a submit's
//      `sharedContentKey` all name a row by that key, so a key that moved would
//      orphan every one of them.
//   3. Document data = the legacy value VERBATIM: `{ title, body, data }`. Not
//      wrapped (contrast the private `kv` collection): it is already an object, and
//      the moderation split — viewer-visible text in `title`/`body`, opaque config
//      in `data` — is kept as it was.
//   4. A vote is the `vote` MARK: the tally is `marks.vote`, "did I vote" is
//      `viewer.marks`. A report is the built-in `report` mark (undeclared, never
//      withdrawable, count never exposed).
//   5. Publish = `create` (the server mints the key, as `append` did); edit = `put`
//      on the existing key at the version just read; withdraw = `delete`. `own`
//      lets only a document's author edit or delete it.
//
// 🔴 OWNERSHIP IS `author.isViewer`, NEVER A USER ID. The store does not say who
// wrote a document, so the legacy `authorUserId` has no source. To keep every
// "is this mine?" check (`authorUserId === viewer.id`) unchanged, a row the store
// marks `isViewer` is stamped with the id of the viewer the read was made FOR, and
// every other row gets `null` — which equals no viewer id. A row read for viewer A
// can therefore never count as owned by viewer B; the board re-reads when the
// viewer changes (`App.tsx`'s load effect depends on `viewer`).
//
// Scopes: everything takes `apps:storage` (consent-exempt) except creating and
// editing, which also take `apps:storage:publish` (CONSENT-GATED). Reads work
// signed out; every write needs a signed-in viewer who also clears the store's
// minimum-trust gate.

import type { DocumentStorage, StorageCollection, StorageDocument } from '@civitai/sdk';
import { StorageError } from '@civitai/sdk';

import { publishRefusalMessage, SharedWriteRefusal } from '../lib/storageErrors.js';
import { getSnapshot } from './client.js';
import {
  DEFAULT_RATE_LIMIT_RETRY,
  DOC_LIST_LIMIT_MAX,
  getDocStorage,
  RECORDS_COLLECTION,
  withRateLimitRetry,
  type RateLimitRetryPolicy,
} from './docStore.js';
import type { SharedAppendValue, SharedListItem, SharedListResult, SharedStorage } from './types.js';

/** The declared vote mark. */
export const VOTE_MARK = 'vote';
/** The store's built-in report mark — undeclared, never withdrawable. */
export const REPORT_MARK = 'report';
/**
 * Newest first by KEY, which is what the legacy list returned. Keys are
 * server-minted sortable ids, so key order is creation order — and it stays that
 * for rows the copy carried over, whose keys are the legacy ULIDs while their
 * `createdAt` is the copy's.
 */
export const BOARD_SORT = '-key';

/** The stored document's data: the legacy shared value, verbatim (rule 3). */
export type RecordDocument = SharedAppendValue & Record<string, unknown>;

/** A store document → the row the app reads. The one place a document becomes a row. */
export function toSharedListItem(doc: StorageDocument<RecordDocument>, viewerId: number | null): SharedListItem {
  const mine = doc.author.kind === 'user' && doc.author.isViewer && viewerId != null;
  return {
    key: doc.key,
    authorUserId: mine ? viewerId : null,
    value: doc.data as SharedAppendValue,
    count: doc.marks[VOTE_MARK] ?? 0,
    viewerVoted: doc.viewer?.marks.includes(VOTE_MARK) ?? false,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    version: doc.version,
  };
}

/**
 * Assert a mark reply's `count`. 🔴 ASSERTED, NOT COERCED: `?? 0` would report a
 * vote that did not land as a tally of zero, and the app writes this number
 * straight into the card.
 */
function requireCount(reply: { count?: unknown }, op: string): number {
  if (typeof reply.count !== 'number' || !Number.isFinite(reply.count)) {
    throw new Error(`records ${op}: reply carried no numeric count`);
  }
  return reply.count;
}

/**
 * A failed create/edit → viewer copy (`lib/storageErrors.ts`). 🔴 EVERY failure,
 * not only a `StorageError`: a reply without the store's envelope (a proxy's JSON
 * 502, the SDK's own malformed-reply error) arrives as a plain error whose message
 * is server or SDK text, and the Builder renders `err.message`. Those get the
 * generic retry line; the original stays on `cause`.
 */
function asPublishRefusal(err: unknown): never {
  if (err instanceof SharedWriteRefusal) throw err;
  if (err instanceof StorageError) {
    throw new SharedWriteRefusal(publishRefusalMessage(err), err.code, { cause: err });
  }
  // Logged, so a genuine bug behind the generic copy stays attributable.
  // eslint-disable-next-line no-console
  console.warn('[custom-generators] shared write failed', err);
  throw new SharedWriteRefusal(publishRefusalMessage({ code: 'unknown' }), 'unknown', { cause: err });
}

function viewerIdNow(): number | null {
  try {
    return getSnapshot().viewer?.id ?? null;
  } catch {
    return null;
  }
}

export interface SharedStorageOptions {
  docs?: () => DocumentStorage | Promise<DocumentStorage>;
  /** Who the reads are made for — the id rows the store marks `isViewer` are stamped with. */
  viewerId?: () => number | null;
  retry?: RateLimitRetryPolicy;
}

export function createSharedStorage(options: SharedStorageOptions = {}): SharedStorage {
  const docs = options.docs ?? getDocStorage;
  const viewerId = options.viewerId ?? viewerIdNow;
  const retry = options.retry ?? DEFAULT_RATE_LIMIT_RETRY;
  const records = async (): Promise<StorageCollection<RecordDocument>> =>
    (await docs()).collection<RecordDocument>(RECORDS_COLLECTION);

  return {
    async list(opts = {}): Promise<SharedListResult> {
      const forViewer = viewerId();
      const page = await withRateLimitRetry(
        async () =>
          (await records()).list({
            sort: BOARD_SORT,
            // `list({ mine: true })` was the legacy route's server-side author
            // filter; the store's is `author: 'me'`. An anonymous viewer gets
            // `sign_in_required` for it (the legacy route answered an empty page),
            // which is why `App.tsx` does not make this read for one.
            ...(opts.mine === true ? { author: 'me' as const } : {}),
            ...(opts.limit !== undefined
              ? { limit: Math.min(Math.max(1, Math.floor(opts.limit)), DOC_LIST_LIMIT_MAX) }
              : {}),
            ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
          }),
        retry,
      );
      const result: SharedListResult = { items: page.items.map((d) => toSharedListItem(d, forViewer)) };
      // `null` exactly on the last page — passed through, never re-derived.
      if (page.nextCursor !== null) result.nextCursor = page.nextCursor;
      return result;
    },

    async get(key) {
      const forViewer = viewerId();
      const doc = await withRateLimitRetry(async () => (await records()).get(key), retry);
      // `null` covers a missing key AND a moderator-hidden one.
      return doc ? toSharedListItem(doc, forViewer) : null;
    },

    async append(value) {
      try {
        // 🔴 NOT RETRIED ON A 429: a create's 429 is the author's shared-write
        // budget (a refill every six minutes), which an in-place retry cannot
        // outlast — the viewer gets the copy instead.
        const doc = await (await records()).create(value as RecordDocument);
        return { key: doc.key };
      } catch (err) {
        return asPublishRefusal(err);
      }
    },

    async update(key, value, opts = {}) {
      try {
        const coll = await records();
        if (opts.ifVersion !== undefined) {
          // The caller read the row and built `value` from THAT read: write only
          // if nothing moved since (a missing row is refused too, never created).
          await coll.put(key, value as RecordDocument, { ifVersion: opts.ifVersion });
          return;
        }
        // 🔴 `put` CREATES A MISSING KEY, and the legacy `update` answered 404 for
        // one. Reading first and writing AT that version keeps an edit from
        // resurrecting a row its author withdrew in another tab: a row gone in
        // between makes the conditional write refuse `version_conflict`, and a row
        // already gone is reported as the store reports one, `not_found`. The key
        // and the row's marks are preserved; only the data changes.
        const current = await withRateLimitRetry(() => coll.get(key), retry);
        if (current === null) {
          throw new SharedWriteRefusal(publishRefusalMessage({ code: 'not_found' }), 'not_found');
        }
        await coll.put(key, value as RecordDocument, { ifVersion: current.version });
      } catch (err) {
        asPublishRefusal(err);
      }
    },

    async vote(key) {
      return requireCount(await (await records()).mark(key, VOTE_MARK), 'vote');
    },

    async unvote(key) {
      return requireCount(await (await records()).unmark(key, VOTE_MARK), 'unvote');
    },

    async withdraw(key) {
      // Needs only `apps:storage`: a viewer who withdrew the publish consent can
      // still remove what they published. `deleted: false` = nothing was there.
      const { deleted } = await withRateLimitRetry(async () => (await records()).delete(key), retry);
      return { ok: true as const, deleted };
    },

    async report(key) {
      // Idempotent and permanent. Filing does NOT hide the row — a moderator
      // decides. `ReportButton`'s fixed copy says so.
      await (await records()).mark(key, REPORT_MARK);
    },
  };
}
