// Domain types for the shared board.
//
// They predate the document store: `SharedListItem` is the shape `Browse`,
// `lib/examples.ts`, `lib/storeListing.ts` and the tests consume, and
// `platform/sharedStorage.ts` maps each `records` document onto it, so moving the
// storage did not move the board.

import type { SharedStorageValue } from '@civitai/app-sdk/blocks';

/**
 * The value a viewer contributes to the SHARED board: a required `title`, an
 * optional long-form `body`, and an optional opaque app-owned `data` blob.
 * `title`/`body` are the user-visible TEXT; `data` is structured app state (keep
 * all user-visible text in title/body).
 *
 * ⚠️ The document store moderates EVERY string in a shared write — `data`'s
 * leaves included — so `data` is no longer unmoderated. The split still governs
 * where this app puts its own viewer-visible text.
 */
export type SharedAppendValue = SharedStorageValue;

/**
 * One SHARED entry as `list()` returns it. `count` is the live `vote` tally.
 */
export interface SharedListItem {
  key: string;
  /**
   * 🔴 NOT AN AUTHOR ID ANY MORE. The document store never discloses who wrote a
   * document, only whether the READING viewer did (`author.isViewer`). So this is
   * the id of the viewer the read was made for on their own rows, and `null` on
   * every other row — which keeps every `authorUserId === viewer.id` ownership
   * check true exactly on the viewer's own rows. See `platform/sharedStorage.ts`.
   */
  authorUserId: number | null;
  value: SharedAppendValue;
  count: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Whether the current viewer holds a `vote` mark on this entry — the store's
   * `viewer.marks`, so the vote button hydrates from it on load. Always `false`
   * for an anonymous viewer.
   */
  viewerVoted: boolean;
  /**
   * The document's `version` when the row came from the store (absent on rows
   * built by hand). Pass it back as `update`'s `ifVersion` to write only if the
   * row has not changed since THIS read.
   */
  version?: number;
}

export interface SharedListResult {
  items: SharedListItem[];
  /** Opaque cursor — pass back as `cursor` to page forward. Absent exactly on the last page. */
  nextCursor?: string;
}

/** The shared-board operations this app uses. */
export interface SharedStorage {
  list(opts?: {
    limit?: number;
    cursor?: string;
    /**
     * Narrow the page to rows the VIEWER authored — server-side (`author: 'me'`),
     * over the whole board, not a client filter over one page. Needs a signed-in
     * viewer: an anonymous one is refused, so callers skip the read for one.
     */
    mine?: boolean;
  }): Promise<SharedListResult>;
  /** One row by key; `null` for a missing or moderator-hidden one. */
  get(key: string): Promise<SharedListItem | null>;
  /** File the built-in `report` mark. Does not hide the row. */
  report(key: string): Promise<void>;
  /** Publish a new row under a server-minted key. Refusals reject as `SharedWriteRefusal`. */
  append(value: SharedAppendValue): Promise<{ key: string }>;
  /**
   * Replace the viewer's own existing row. Refusals reject as `SharedWriteRefusal`.
   * With `ifVersion`, the write lands only if the row is still at that version
   * (the caller read it); without, the adapter reads the current version itself.
   */
  update(key: string, value: SharedAppendValue, opts?: { ifVersion?: number }): Promise<void>;
  /** Set the viewer's `vote` mark; resolves the new tally. */
  vote(key: string): Promise<number>;
  /** Clear the viewer's `vote` mark; resolves the new tally. */
  unvote(key: string): Promise<number>;
  /** Delete the viewer's own row. `deleted: false` = nothing was there. */
  withdraw(key: string): Promise<{ ok: boolean; deleted: boolean }>;
}

/** Alias kept so the files that imported `UseSharedStorage` did not need renaming. */
export type UseSharedStorage = SharedStorage;
