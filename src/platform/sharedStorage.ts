// The app-global SHARED store, over the ten routes under
// `/api/v1/blocks/shared-storage/`.
//
// Replaces the `SHARED_*` bridge messages. Every route is a thin adapter over the
// SAME server function the bridge message called — `listSharedRows` and friends —
// so per-app schema isolation, the approved-block and revocation checks, the
// min-trust write gate and the fail-closed kill-switch all hold verbatim, and a
// REST read cannot diverge from the bridge read. That is why `SharedListItem` is
// unchanged and why `Browse` did not move.
//
// Scopes: reads take `apps:storage:shared:read`, writes take
// `apps:storage:shared:write`. Both already existed; neither is new.
//
// ✅ ANONYMOUS READS WORK, and this needed checking rather than assuming.
// `@civitai/sdk`'s BREAKING.md warns that an app declaring
// `apps:storage:shared:write` — which this one does — gets a 403 on anonymous
// READS, because the request-time scope-binding check ran over every scope on the
// token and reached the write scope's "requires authenticated subject" rule. That
// is FIXED (civitai#5063): the binding switch is now scoped to the route's own
// `requiredScope`. `block-scope.middleware.ts` says so in terms, and names this
// exact contradiction as the reason — *"the `apps:storage:shared:read` case says
// anon reads ARE allowed, while the `apps:storage:shared:write` case one below it
// 403s the same anon token on that same read"*. `list.ts`'s own docblock agrees:
// *"ANON IS ALLOWED, deliberately."* Signed-out browsing — this app's whole Browse
// premise — therefore survives the port. BREAKING.md is stale on this point.
//
// 🔴 ANONYMOUS WRITES ARE STILL REFUSED, and authenticated ones must additionally
// clear a minimum-trust gate (account age, paid tier, verified email or a linked
// OAuth account). A signed-in viewer is NOT automatically a permitted writer, so a
// write rejection is an expected outcome to render, not a bug.

import { getClient } from './client.js';
import type {
  SharedAppendValue,
  SharedListItem,
  SharedListResult,
  SharedStorage,
} from './types.js';

/** One row as it arrives on the wire: dates are ISO strings, not `Date`s. */
interface WireSharedItem {
  key: string;
  authorUserId: number;
  value: SharedAppendValue;
  count: number;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
  viewerVoted?: boolean;
}

/**
 * Revive one row.
 *
 * The dates are `Date`s server-side and JSON turns them into ISO strings, so they
 * are revived here — once, at the transport edge — exactly as the bridge hook did.
 * `Browse` sorts on `createdAt` and renders a relative age from it, so a string
 * would sort lexicographically (right by luck for ISO) and then throw on
 * `.getTime()`.
 *
 * `viewerVoted` defaults to `false` rather than `undefined`: it is declared
 * non-optional on `SharedListItem` because the vote button hydrates from it, and
 * an anonymous viewer's rows legitimately omit it.
 */
function reviveItem(raw: WireSharedItem): SharedListItem {
  return {
    key: raw.key,
    authorUserId: raw.authorUserId,
    value: raw.value,
    count: typeof raw.count === 'number' ? raw.count : Number(raw.count ?? 0),
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    viewerVoted: raw.viewerVoted === true,
  };
}

export function createSharedStorage(): SharedStorage {
  return {
    async list(opts = {}) {
      const app = await getClient();
      const res = await app.site.get<{
        items?: WireSharedItem[];
        metadata?: { nextCursor?: string };
      }>('blocks/shared-storage/list', {
        query: {
          ...(opts.prefix !== undefined ? { prefix: opts.prefix } : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
        },
      });
      const result: SharedListResult = { items: (res.items ?? []).map(reviveItem) };
      // 🔴 PASSED THROUGH UNTOUCHED, PRESENT EXACTLY WHEN THE SERVER SENT IT. The
      // server sets it iff the page it returned was FULL, so it is not evidence a
      // next row exists — `App.tsx`'s `DISCOVER_LIST_LIMIT` over-fetches by one and
      // reads truncation off the row count precisely because this cursor lies in
      // that one case. Never default it, never re-derive it from `items.length`.
      if (res.metadata?.nextCursor !== undefined) result.nextCursor = res.metadata.nextCursor;
      return result;
    },

    async get(key) {
      const app = await getClient();
      const res = await app.site.get<{ item?: WireSharedItem | null }>(
        'blocks/shared-storage/item',
        { query: { key } },
      );
      // `null` covers a missing key AND a hidden one — a withdrawn or moderated row
      // is never leaked as "exists but withheld".
      return res.item ? reviveItem(res.item) : null;
    },

    async getCount(key) {
      const counts = await this.getCounts([key]);
      return counts[key] ?? 0;
    },

    async getCounts(keys) {
      if (keys.length === 0) return {};
      const app = await getClient();
      const res = await app.site.get<{ counts?: Record<string, number> }>(
        'blocks/shared-storage/counts',
        // 🔴 REPEATED `keys` PARAMS, not a comma-joined list — this route's schema
        // differs from the two by-id reads (`gated-images`, `generation-resources`),
        // which do take comma lists. A joined string here arrives as ONE key and
        // every real key reads 0.
        { query: { keys } },
      );
      const counts = res.counts ?? {};
      // Keys absent from the reply have no votes; the callers index this map
      // directly, so materialise the zeros rather than leaving holes.
      const out: Record<string, number> = {};
      for (const k of keys) out[k] = counts[k] ?? 0;
      return out;
    },

    async append(value) {
      const app = await getClient();
      return app.site.post<{ key: string }>('blocks/shared-storage/append', { value });
    },

    async update(key, value) {
      const app = await getClient();
      // Author-scoped server-side: 403 when the viewer is not the row's author,
      // 404 when the key is missing or hidden. The key and the row's vote/report
      // totals are preserved — only the contributed value changes.
      await app.site.post('blocks/shared-storage/update', { key, value });
    },

    async vote(key) {
      const app = await getClient();
      const res = await app.site.post<{ count: number }>('blocks/shared-storage/vote', { key });
      return res.count;
    },

    async unvote(key) {
      const app = await getClient();
      const res = await app.site.post<{ count: number }>('blocks/shared-storage/unvote', { key });
      return res.count;
    },

    async withdraw(key) {
      const app = await getClient();
      const res = await app.site.post<{ ok: boolean; deleted: boolean }>(
        'blocks/shared-storage/withdraw',
        { key },
      );
      return { ok: res.ok, deleted: res.deleted };
    },

    async report(key, reason) {
      const app = await getClient();
      // Identical reply whether newly filed or already reported. Filing does NOT
      // hide the row — a moderator decides. `ReportButton`'s fixed copy says so.
      await app.site.post('blocks/shared-storage/report', {
        key,
        ...(reason !== undefined ? { reason } : {}),
      });
    },
  };
}
