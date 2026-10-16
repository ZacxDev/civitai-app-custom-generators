// App Store sub-listings, over `@civitai/sdk`'s `app.subListings` (0.15.0+),
// which wraps the routes under `/api/v1/blocks/sub-listings/`
// (civitai/civitai#5511). Two of its three methods are used: `upsert` and `mine`.
// The third, `withdraw`, is deliberately unused: civitai's shared-storage
// withdraw already takes the author's store card down server-side, so calling
// it from here would only spend one of the author's store writes.
//
// A parent app may place individual items it contains — here, one published
// generator — into the `/apps` store as their own cards, badged "in Custom
// Generators". The card links to `/apps/run/<slug>/<subPath>?sl=<id>`, built by
// the server; this app only supplies the `subPath` (`g/<key>`, the 0.9.2 host
// route that opens the generator).
//
// Scope: `apps:store:items:write` on both, plus a signed-in subject. The
// parent is the calling app's own listing, taken from the token — never the body.
//
// 🔴 THE UPSERT BODY IS `.strict()` SERVER-SIDE, AND `upsert` REPLACES. The SDK
// sends only `itemKey, title, subPath` and each of `tagline, imageId,
// contentRating` that is non-null, so an unknown key cannot reach the server.
// But a left-out optional is CLEARED on the stored item, so every upsert must
// carry the author's `imageId` again (`lib/storeListing.ts` builds the input from
// the published row, which is why the backfill keeps the card image too).
//
// Error contract: the SDK turns a non-2xx carrying `{ error, code }` into a
// `SubListingError` (an `ApiError` with a typed `code`); a non-2xx with no code —
// notably a route miss, Next.js's HTML 404 — stays a plain `ApiError`; a reply
// the SDK cannot read is a bare `CivitaiError`; and a dead network rejects with
// whatever `fetch` threw. All of them arrive here as ONE type, a
// `StoreListingError`, which is what `lib/storeListing.ts` branches on. The
// server's `error` sentence is never rendered.

import { ApiError, BridgeError, CivitaiError } from '@civitai/sdk';
import type { MySubListing, SubListingStatus } from '@civitai/sdk';

import { getClient } from './client.js';

/** civitai `APP_SUB_LISTING_STATUSES`. */
export type StoreListingStatus = SubListingStatus;
const STATUSES: ReadonlySet<string> = new Set<StoreListingStatus>(['pending', 'approved', 'hidden', 'withdrawn']);

export interface StoreListingInput {
  /** The generator's shared-storage row key. */
  itemKey: string;
  title: string;
  /** Omitted from the wire when absent. */
  tagline?: string;
  /** Under the app's run route: `g/<key>`. */
  subPath: string;
  /**
   * The card image: an `Image` the viewer posted, public and reviewed (else the
   * server answers 400 `image_not_public` / 403 `image_not_yours`). Omitted from
   * the wire when absent — and the server reads an absent `imageId` as "no
   * image", clearing any the card had.
   */
  imageId?: number;
}

export interface StoreListingResult {
  id: string;
  status: StoreListingStatus;
  /** True while an edit to an approved item waits for a moderator. */
  pendingEdit: boolean;
}

export interface MyStoreListing {
  id: string;
  itemKey: string;
  status: StoreListingStatus;
  title: string;
  pendingEdit: boolean;
}

export interface StoreListings {
  upsert(input: StoreListingInput): Promise<StoreListingResult>;
  mine(): Promise<MyStoreListing[]>;
}

/**
 * Any failure of a store call.
 *
 * `status` is the HTTP status, or `null` when there was none (network failure,
 * no host to hand out a token, a malformed 2xx). `code` is the server's
 * `SubListingErrorCode` when the body carried one, `'malformed_response'` for a
 * 2xx this app or the SDK could not read, else `null` — notably for a route miss,
 * whose body is HTML.
 */
export class StoreListingError extends Error {
  override readonly name = 'StoreListingError';
  constructor(
    readonly status: number | null,
    readonly code: string | null,
    options?: { cause?: unknown },
  ) {
    super(`App Store request failed (${status ?? 'no response'}${code ? `, ${code}` : ''})`, options);
  }
}

function toStoreError(err: unknown): StoreListingError {
  if (err instanceof StoreListingError) return err;
  // `SubListingError` is an `ApiError` whose `body.code` is its `code`, so this
  // one branch covers both a coded refusal and a codeless one (a route miss).
  if (err instanceof ApiError) {
    const body = err.body as { code?: unknown } | null | undefined;
    const code = body && typeof body === 'object' && typeof body.code === 'string' ? body.code : null;
    return new StoreListingError(err.status, code, { cause: err });
  }
  // A bare `CivitaiError` (not an HTTP or bridge failure) is the SDK refusing a
  // 2xx it could not read: an `upsert` reply without `id`/`status`/`pendingEdit`,
  // a `mine` reply without an `items` array or with one unreadable row.
  if (err instanceof CivitaiError && !(err instanceof BridgeError)) {
    return new StoreListingError(null, 'malformed_response', { cause: err });
  }
  return new StoreListingError(null, null, { cause: err });
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toStoreError(err);
  }
}

function isStatus(v: unknown): v is StoreListingStatus {
  return typeof v === 'string' && STATUSES.has(v);
}

function toMyStoreListing(row: MySubListing): MyStoreListing {
  return { id: row.id, itemKey: row.itemKey, status: row.status, title: row.title, pendingEdit: row.pendingEdit };
}

export function createStoreListings(): StoreListings {
  return {
    upsert(input) {
      return guarded(async () => {
        const app = await getClient();
        // Named fields, never a spread: the SDK drops unknown keys anyway, but this
        // is the line that decides WHAT the stored item becomes (replace semantics).
        const res = await app.subListings.upsert({
          itemKey: input.itemKey,
          title: input.title,
          subPath: input.subPath,
          tagline: input.tagline || null,
          imageId: input.imageId ?? null,
        });
        // The SDK checks the reply's types, not the status vocabulary. An unknown
        // status is not one `storeNoticeFor` can describe; treat it as unreadable.
        if (!isStatus(res.status)) throw new StoreListingError(null, 'malformed_response');
        return { id: res.id, status: res.status, pendingEdit: res.pendingEdit };
      });
    },

    /**
     * 🔴 ONE UNREADABLE ROW REJECTS THE WHOLE CALL — deliberately. The SDK's
     * `mine()` throws on a malformed row (or a reply without `items`), and this
     * keeps that: it becomes `StoreListingError(null, 'malformed_response')`, which
     * `classifyStoreFailure` reads as `transient`, so the backfill stops before
     * ANY upsert. The app's pre-0.15 adapter skipped bad rows instead, and a
     * skipped row's key then read as "not listed" — the backfill re-upserted it,
     * spending one of the author's store writes on an item that already had a card
     * (the same hazard as reading a missing `items` as `[]`). Failing closed costs
     * only the backfill, and only while such a row exists; a Builder publish still
     * upserts its own generator.
     *
     * A row whose `status` is outside the four known values is KEPT: the backfill
     * treats any listing as "has one", and an unknown status is still a listing.
     */
    mine() {
      return guarded(async () => {
        const app = await getClient();
        const { items } = await app.subListings.mine();
        return items.map(toMyStoreListing);
      });
    },
  };
}
