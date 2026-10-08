// App Store sub-listings, over two of the routes under
// `/api/v1/blocks/sub-listings/` (civitai/civitai#5511): `upsert` and `mine`.
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
// 🔴 THE UPSERT BODY IS `.strict()` SERVER-SIDE. Only `itemKey, title, tagline?,
// imageId?, subPath, contentRating?` are accepted; an unknown key is a 400 for
// every author. So the body is built key by key below and an absent tagline is
// left OUT, not sent as `undefined` or `''`.
//
// Error contract (civitai `subListingErrorResponse`): a non-2xx carries
// `{ error, code }`. The `code` is what this app branches on; `error` is a
// server sentence and is never rendered. A route miss is Next.js's HTML 404 with
// no code, and a dead network rejects before any status exists — both arrive
// here as a `StoreListingError` too, so every caller handles ONE error type.

import { ApiError } from '@civitai/sdk';

import { getClient } from './client.js';

/** civitai `APP_SUB_LISTING_STATUSES`. */
export type StoreListingStatus = 'pending' | 'approved' | 'hidden' | 'withdrawn';
const STATUSES: ReadonlySet<string> = new Set<StoreListingStatus>(['pending', 'approved', 'hidden', 'withdrawn']);

export interface StoreListingInput {
  /** The generator's shared-storage row key. */
  itemKey: string;
  title: string;
  /** Omitted from the wire when absent. */
  tagline?: string;
  /** Under the app's run route: `g/<key>`. */
  subPath: string;
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
 * `SubListingErrorCode` when the body carried one, else `null` — notably for a
 * route miss, whose body is HTML.
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
  if (err instanceof ApiError) {
    const body = err.body as { code?: unknown } | null | undefined;
    const code = body && typeof body === 'object' && typeof body.code === 'string' ? body.code : null;
    return new StoreListingError(err.status, code, { cause: err });
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

export function createStoreListings(): StoreListings {
  return {
    upsert(input) {
      return guarded(async () => {
        const app = await getClient();
        const body: Record<string, string> = {
          itemKey: input.itemKey,
          title: input.title,
          subPath: input.subPath,
        };
        if (input.tagline) body.tagline = input.tagline;
        const res = await app.site.post<{ id?: unknown; status?: unknown; pendingEdit?: unknown }>(
          'blocks/sub-listings/upsert',
          body,
        );
        if (!res || typeof res.id !== 'string' || !isStatus(res.status)) {
          throw new StoreListingError(null, 'malformed_response');
        }
        return { id: res.id, status: res.status, pendingEdit: res.pendingEdit === true };
      });
    },

    mine() {
      return guarded(async () => {
        const app = await getClient();
        const res = await app.site.get<{ items?: unknown }>('blocks/sub-listings/mine');
        // 🔴 A 2xx without an `items` array is NOT an empty list: read as `[]` it
        // tells the backfill nothing is listed, and it re-upserts every generator.
        // Reject it like a malformed `upsert` reply (classified transient).
        if (!res || !Array.isArray(res.items)) {
          throw new StoreListingError(null, 'malformed_response');
        }
        const out: MyStoreListing[] = [];
        for (const raw of res.items as unknown[]) {
          if (!raw || typeof raw !== 'object') continue;
          const r = raw as Record<string, unknown>;
          if (typeof r.itemKey !== 'string' || !isStatus(r.status)) continue;
          out.push({
            id: typeof r.id === 'string' ? r.id : '',
            itemKey: r.itemKey,
            status: r.status,
            title: typeof r.title === 'string' ? r.title : '',
            pendingEdit: r.pendingEdit === true,
          });
        }
        return out;
      });
    },
  };
}
