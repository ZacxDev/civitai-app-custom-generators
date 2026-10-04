// Domain types the bridge package used to own.
//
// These came from `@civitai/blocks-react` before the port. They are declared here
// now because the app no longer asks the host for this data — it calls the public
// REST routes through `@civitai/sdk`, which is TRANSPORT-ONLY and ships no domain
// types at all.
//
// 🔴 THE SHAPES ARE UNCHANGED FROM THE BRIDGE CONTRACT, ON PURPOSE. The REST
// routes are thin adapters over the SAME server functions the bridge messages
// called, so the payloads are the same payloads. Keeping the shapes identical is
// what let this port stay a transport swap instead of a rewrite of the board —
// `Browse`, `IntroPanel`, `lib/examples.ts` and four test files consume
// `SharedListItem` and none of them changed.

import type { SharedStorageValue } from '@civitai/app-sdk/blocks';

/**
 * The value a viewer contributes to the SHARED store: a required `title`, an
 * optional long-form `body`, and an optional opaque app-owned `data` blob.
 * `title`/`body` are the MODERATED, user-visible TEXT; `data` is UNMODERATED
 * structured app state (keep all user-visible text in title/body).
 *
 * Still sourced from `@civitai/app-sdk/blocks`, which remains this app's type
 * dependency — only the bridge RUNTIME went away.
 */
export type SharedAppendValue = SharedStorageValue;

/**
 * One SHARED entry as `list()` returns it. `createdAt`/`updatedAt` are real
 * `Date`s — the wire carries ISO strings and the client revives them once, so
 * consumers can do date arithmetic without knowing the transport. `count` is the
 * live vote total; `authorUserId` is the contributing viewer.
 */
export interface SharedListItem {
  key: string;
  authorUserId: number;
  value: SharedAppendValue;
  count: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Whether the current viewer has an active up-vote on this entry — hydrate the
   * vote-button state from this on load instead of guessing. Anonymous viewers
   * are always `false`. Defaults to `false` when the server omits it.
   */
  viewerVoted: boolean;
}

export interface SharedListResult {
  items: SharedListItem[];
  /** Opaque cursor — pass back as `cursor` to page forward. Absent on the last page. */
  nextCursor?: string;
}

/**
 * The shared-storage operations this app uses.
 *
 * Deliberately the same member set and the same signatures as the bridge's
 * `UseSharedStorage`, because `App.tsx` passes this object straight into its
 * `deps.shared` and `Browse` calls five of these methods directly. `getCount` is
 * carried even though only `getCounts` is used on the hot path, because the
 * app's own tests drive both.
 */
export interface SharedStorage {
  list(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
    /**
     * Narrow the page to rows the VIEWER authored — server-side, over the whole
     * board, not a client filter over one page.
     *
     * 🔴 A BOOLEAN, NEVER A USER ID. The author it filters on is the resolved
     * token subject, the same value `viewerVoted` keys on, so no caller-supplied
     * identity enters the path (`listSharedRows`, civitai/civitai#5361).
     *
     * 🔴 AN ANONYMOUS VIEWER GETS AN EMPTY PAGE — not an error, and not the
     * whole board. Server-side `s.author_user_id = $4::int` is UNKNOWN for a NULL
     * subject, so it matches nothing. That is the right answer (an anonymous
     * viewer has authored nothing) but it means an empty result here is NOT
     * evidence the store is empty, so callers skip the request rather than making
     * it and reading the reply as a fact about the board.
     *
     * Leave it UNSET to list the whole board; see the adapter for why unset must
     * mean the key is absent from the query string.
     */
    mine?: boolean;
  }): Promise<SharedListResult>;
  get(key: string): Promise<SharedListItem | null>;
  report(key: string, reason?: string): Promise<void>;
  getCount(key: string): Promise<number>;
  getCounts(keys: string[]): Promise<Record<string, number>>;
  append(value: SharedAppendValue): Promise<{ key: string }>;
  update(key: string, value: SharedAppendValue): Promise<void>;
  vote(key: string): Promise<number>;
  unvote(key: string): Promise<number>;
  withdraw(key: string): Promise<{ ok: boolean; deleted: boolean }>;
}

/**
 * Kept as an alias so the four test files and `App.tsx` that imported
 * `UseSharedStorage` from the bridge package did not have to be renamed as part
 * of a transport change.
 */
export type UseSharedStorage = SharedStorage;
