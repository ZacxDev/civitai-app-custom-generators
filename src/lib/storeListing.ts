// App Store sub-listings — what this app sends for a generator, how a failure is
// classified, what the author is told, and the once-per-session backfill.
//
// 🔴 BEST-EFFORT, ALWAYS. The store is a second, optional home for a generator
// that is already published in this app's Discover. Nothing here may fail or
// delay the in-app publish/withdraw: callers fire these AFTER the shared-storage
// write has succeeded, do not await them on the publish path, and swallow every
// rejection (see `App.tsx`).
//
// Everything in this file is pure apart from the injected `StoreListings`, so the
// node project covers it without a DOM.

import { StoreListingError } from '../platform/index.js';
import type {
  SharedListItem,
  StoreListingInput,
  StoreListingResult,
  StoreListings,
} from '../platform/index.js';
import type { GeneratorConfig } from '../types.js';
import { isRoutableKey, routeForKey } from './deeplink.js';
import { parsePublishedGenerator } from './generator.js';

/**
 * civitai `APP_SUB_LISTING_TITLE_MAX` / `APP_SUB_LISTING_TAGLINE_MAX`
 * (`src/shared/constants/app-sub-listing.constants.ts`, read at civitai#5511).
 *
 * 🔴 MIRRORED, AND OVER-LONG IS A HARD 400, NOT A CLAMP — the server measures the
 * cleaned string's `.length` (UTF-16 code units) and rejects past these. So this
 * app clamps before sending, measuring the same way, after the same cleanup
 * ({@link cleanStoreText}). A server-side move is not observable from here.
 */
export const STORE_TITLE_MAX = 80;
export const STORE_TAGLINE_MAX = 140;

/**
 * Upserts one backfill run may send.
 *
 * The server allows 30 store writes per user per hour (and 100/day), shared
 * with the author's own publishes, edits and withdraws, and counts a refused
 * upsert too. With {@link BACKFILL_INTERVAL_MS} between runs, ten leaves the
 * author at least two-thirds of any hour for what they do in the app; the next
 * run (after the interval) picks up whatever this one did not reach.
 */
export const RECONCILE_MAX_UPSERTS = 10;

// Control and format characters (bidi overrides, zero-width joiners, soft
// hyphens). Same class the server replaces before measuring (`cleanSubListingText`).
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/gu;

/** civitai's `cleanSubListingText`: NFC, invisibles → space, whitespace collapsed. */
export function cleanStoreText(value: string): string {
  return value.normalize('NFC').replace(INVISIBLE_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Clean, then fit within `max` UTF-16 code units.
 *
 * Over-long text is cut to leave room for a trailing `…`, backed off to the last
 * space when that keeps at least 60% of the budget (so a word is not chopped in
 * half), and never between the two halves of a surrogate pair.
 */
export function clampStoreText(value: string, max: number): string {
  const cleaned = cleanStoreText(value);
  if (cleaned.length <= max) return cleaned;
  let cut = max - 1;
  const last = cleaned.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  let head = cleaned.slice(0, cut);
  const space = head.lastIndexOf(' ');
  if (space >= Math.floor(max * 0.6)) head = head.slice(0, space);
  head = head.replace(/[\s.,;:!?-]+$/u, '');
  return `${head}…`;
}

/**
 * The store listing for a published generator, or `null` when it cannot have one.
 *
 * - `subPath` is the 0.9.2 host route `g/<key>`, so the card opens the generator.
 *   A key that route cannot carry has no deep link to give the card, so no card.
 * - `title` is the generator name; `tagline` its description. The description is
 *   the author's one-line pitch; the rest of the moderated `body` (the prompt hint
 *   and the button list) is not tagline material, so there is no fallback to it.
 * - No `imageId`: a generator's cover is a moderated cosmetic upload, not an image
 *   in a published post, and the server refuses anything else (`image_not_public`).
 *   The card shows the parent's cover instead.
 * - No `contentRating`: unset inherits the parent app's rating, which is the
 *   floor the server enforces anyway.
 */
export function storeListingFor(
  key: string,
  config: Pick<GeneratorConfig, 'name' | 'description'>,
): StoreListingInput | null {
  if (!isRoutableKey(key)) return null;
  const title = clampStoreText(config.name ?? '', STORE_TITLE_MAX);
  if (!title) return null;
  const tagline = clampStoreText(config.description ?? '', STORE_TAGLINE_MAX);
  const input: StoreListingInput = { itemKey: key, title, subPath: routeForKey(key) };
  if (tagline) input.tagline = tagline;
  return input;
}

/** {@link storeListingFor} for a row read back from shared storage (the backfill). */
export function storeListingForItem(item: SharedListItem): StoreListingInput | null {
  const config = parsePublishedGenerator(item.value);
  return config ? storeListingFor(item.key, config) : null;
}

/**
 * What a failed store call means for what to do next.
 *
 * - `unavailable` — store publishing is off for this app or this viewer right now:
 *   the feature's tables are not applied (503), the parent is not enabled or the
 *   token lacks the scope (403), the account is below the write-trust bar (403
 *   `untrusted`), the subject is anonymous (401), or the route does not exist
 *   (HTML 404). Nothing the author can act on; stay silent and stop.
 * - `throttled` — 429: the hourly/daily rate limit, or the per-author item cap.
 * - `item` — this one item was refused (not found, not yours, text rejected,
 *   invalid body, a lost write race). Others may still go through.
 * - `transient` — a 5xx, a dead network, a malformed reply.
 */
export type StoreFailureKind = 'unavailable' | 'throttled' | 'item' | 'transient';

const ITEM_CODES_403 = new Set(['not_your_item', 'image_not_yours']);

export function classifyStoreFailure(err: unknown): StoreFailureKind {
  if (!(err instanceof StoreListingError) || err.status == null) return 'transient';
  const { status, code } = err;
  if (status === 429) return 'throttled';
  if (status === 401 || status === 503) return 'unavailable';
  if (status === 403) return code && ITEM_CODES_403.has(code) ? 'item' : 'unavailable';
  if (status === 404) return code === 'item_not_found' ? 'item' : 'unavailable';
  if (status >= 400 && status < 500) return 'item';
  return 'transient';
}

export type StoreOutcome = { ok: true; result: StoreListingResult } | { ok: false; error: unknown };

const STILL_HERE = 'It’s still published here.';

/**
 * The one line the author sees about the store after a publish, or `null` for
 * nothing. Fixed copy only: the server's `error` sentence is never rendered.
 */
export function storeNoticeFor(outcome: StoreOutcome): string | null {
  if (outcome.ok) {
    const { status, pendingEdit } = outcome.result;
    if (status === 'pending') return 'Also sent to the App Store — it appears there once a moderator approves it.';
    if (status === 'approved' && pendingEdit) {
      return 'Your App Store card keeps its current version until a moderator approves these changes.';
    }
    if (status === 'approved') return 'Your App Store card is up to date.';
    if (status === 'hidden') return 'A moderator has hidden this generator from the App Store, so the card wasn’t updated.';
    return null;
  }
  const kind = classifyStoreFailure(outcome.error);
  const code = outcome.error instanceof StoreListingError ? outcome.error.code : null;
  switch (kind) {
    case 'unavailable':
      return null;
    case 'throttled':
      return code === 'author_cap'
        ? `You’ve reached the App Store card limit, so this one wasn’t added there. ${STILL_HERE}`
        : `Too many App Store updates for now — try again later. ${STILL_HERE}`;
    case 'item':
      return code === 'text_rejected'
        ? `The App Store didn’t accept this name or description. ${STILL_HERE}`
        : `Couldn’t add this to the App Store. ${STILL_HERE}`;
    case 'transient':
      return `Couldn’t reach the App Store just now. ${STILL_HERE}`;
  }
}

/**
 * The backfill runs at most once per this interval per viewer, across page loads.
 *
 * 🔴 WHY A PERSISTED INTERVAL AND NOT "ONCE PER MOUNT". A mount is every page
 * load, and the server counts each upsert — refused or not, since the rate
 * limit is checked before the item and text checks — against the author's 30/h
 * and 100/day. Per mount, an author with many unlisted (or refused) generators
 * would spend 10 writes on every open and could exhaust the hour in three,
 * leaving their next real publish throttled. At 10 per 6 h the backfill spends at
 * most 40 writes a day and never more than 10 in an hour.
 */
export const BACKFILL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The viewer's per-app storage key holding the {@link BackfillLedger}. */
export const STORE_BACKFILL_KEY = 'store-backfill:v1';

/**
 * What the backfill remembers between page loads, in the viewer's own app
 * storage: when it last contacted the store, and the item keys the store
 * refused for reasons a retry will not change (`item` failures other than a lost
 * write race). A refused generator is not retried by the backfill; republishing
 * it from the Builder still upserts it, and a success there lists it so it is no
 * longer "missing".
 */
export interface BackfillLedger {
  v: 1;
  lastRunAt: number;
  refused: string[];
}

export interface BackfillLedgerStore {
  get(): Promise<BackfillLedger | null>;
  set(ledger: BackfillLedger): Promise<void>;
}

/** The ledger over the per-viewer KV (`DraftStore`-shaped). A malformed value reads as none. */
export function backfillLedgerIn(kv: {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<unknown>;
}): BackfillLedgerStore {
  return {
    async get() {
      const raw = await kv.get<Partial<BackfillLedger>>(STORE_BACKFILL_KEY);
      if (!raw || raw.v !== 1 || typeof raw.lastRunAt !== 'number' || !Array.isArray(raw.refused)) return null;
      return { v: 1, lastRunAt: raw.lastRunAt, refused: raw.refused.filter((k): k is string => typeof k === 'string') };
    },
    async set(ledger) {
      await kv.set(STORE_BACKFILL_KEY, ledger);
    },
  };
}

export interface ReconcileReport {
  /** Whether the store was consulted at all (false: the viewer has no own items). */
  attempted: boolean;
  /** Item keys upserted, in order. */
  upserted: string[];
  /** Why the run ended early, if it did. */
  stoppedBy: StoreFailureKind | null;
}

/**
 * Backfill: upsert the viewer's published generators that have no store listing.
 *
 * `published` is the viewer's own server-filtered `mine: true` page; rows by
 * anyone else are dropped anyway, since only the author may list an item.
 *
 * 🔴 NON-AUTHORS NEVER REACH THE STORE. With no listable rows of their own the
 * function returns before `mine()` — so the store routes see only people who
 * have something to list.
 *
 * Any existing listing counts as "has one", whatever its status: `withdrawn`
 * means the author took it out (re-listing it is theirs to do, by publishing),
 * and `hidden` is a moderator lock.
 *
 * Sequential, at most `maxUpserts`, and it stops at the first answer that would
 * repeat for every item (`unavailable`, `throttled`, `transient`); an `item`
 * refusal skips only that item, and is remembered in the ledger so later runs do
 * not spend a write on it again.
 *
 * With a `ledger`, a run happens at most once per {@link BACKFILL_INTERVAL_MS}
 * (stamped whenever the store was contacted, including a failed `mine`), and an
 * unreadable ledger skips the run.
 *
 * ⚠️ Known blind spot: the server's `mine` returns an author's OLDEST 200 rows,
 * and withdrawn rows are kept. Past 200 the newest cards are invisible here and
 * the backfill re-upserts them (a no-op server-side, but a write each) — bounded
 * by the per-run cap and the interval.
 */
export async function reconcileStoreListings(args: {
  viewerId: number;
  published: readonly SharedListItem[];
  store: StoreListings;
  maxUpserts?: number;
  /** Cross-page-load memory; without it the run is bounded per call only. */
  ledger?: BackfillLedgerStore;
  now?: number;
}): Promise<ReconcileReport> {
  const report: ReconcileReport = { attempted: false, upserted: [], stoppedBy: null };
  const candidates = args.published
    .filter((item) => item.authorUserId === args.viewerId)
    .map(storeListingForItem)
    .filter((input): input is StoreListingInput => input !== null);
  if (candidates.length === 0) return report;

  const now = args.now ?? Date.now();
  let previouslyRefused = new Set<string>();
  if (args.ledger) {
    let ledger: BackfillLedger | null;
    try {
      ledger = await args.ledger.get();
    } catch {
      // Cannot tell whether a run just happened: skip, rather than risk spending
      // the author's write budget on every page load.
      return report;
    }
    if (ledger && now - ledger.lastRunAt < BACKFILL_INTERVAL_MS) return report;
    previouslyRefused = new Set(ledger?.refused ?? []);
  }

  report.attempted = true;
  const refused = new Set<string>();
  const finish = async () => {
    if (!args.ledger) return;
    const candidateKeys = new Set(candidates.map((c) => c.itemKey));
    // Keep a refusal only while that generator is still published.
    for (const k of previouslyRefused) if (candidateKeys.has(k)) refused.add(k);
    try {
      await args.ledger.set({ v: 1, lastRunAt: now, refused: [...refused] });
    } catch {
      /* best-effort: the next load may run again, still bounded per run */
    }
  };

  let listedKeys: Set<string>;
  try {
    listedKeys = new Set((await args.store.mine()).map((m) => m.itemKey));
  } catch (err) {
    report.stoppedBy = classifyStoreFailure(err);
    await finish();
    return report;
  }

  const budget = args.maxUpserts ?? RECONCILE_MAX_UPSERTS;
  let sent = 0;
  for (const input of candidates) {
    if (listedKeys.has(input.itemKey) || previouslyRefused.has(input.itemKey)) continue;
    if (sent >= budget) break;
    sent += 1;
    try {
      await args.store.upsert(input);
      report.upserted.push(input.itemKey);
    } catch (err) {
      const kind = classifyStoreFailure(err);
      if (kind !== 'item') {
        report.stoppedBy = kind;
        break;
      }
      // A lost write race (409) is worth retrying next time; anything else is not.
      if (!(err instanceof StoreListingError && err.status === 409)) refused.add(input.itemKey);
    }
  }
  await finish();
  return report;
}
