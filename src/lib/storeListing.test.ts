// App Store sub-listings — the pure half: what this app sends for a generator,
// how a failure is classified, what the author is told, and the once-per-session
// reconcile that backfills the author's already-published generators.
//
// 🔴 WHAT THIS IS NOT. The store is an injected fake here. These are claims about
// what this app DECIDES and SENDS; whether civitai's sub-listing routes behave as
// their docblocks say is not observable from this repo.

import { describe, expect, it, vi } from 'vitest';

import { StoreListingError } from '../platform/index.js';
import type { MyStoreListing, StoreListingInput, StoreListings, SharedListItem } from '../platform/index.js';
import type { GeneratorData } from '../types.js';
import {
  BACKFILL_INTERVAL_MS,
  type BackfillLedger,
  RECONCILE_MAX_UPSERTS,
  STORE_TAGLINE_MAX,
  STORE_TITLE_MAX,
  clampStoreText,
  classifyStoreFailure,
  reconcileStoreListings,
  storeListingFor,
  storeListingForItem,
  storeNoticeFor,
} from './storeListing.js';

const ME = 99;
const SOMEONE_ELSE = 7;

/** A shared row whose `value` parses as a generator (one button). */
function row(key: string, title: string, authorUserId: number, description = 'A short description'): SharedListItem {
  const data: GeneratorData = {
    v: 1,
    buttons: [
      {
        id: 'b1',
        label: 'Go',
        workflowType: 'txt2img',
        loras: [],
        promptTemplate: 'a {prompt}',
        params: { steps: 20, cfgScale: 7, width: 512, height: 512, quantity: 1 } as never,
      },
    ],
  } as GeneratorData;
  return {
    key,
    authorUserId,
    value: { title, body: description ? `${description}\nButtons:\n• Go: a {prompt}` : 'Buttons:\n• Go: a {prompt}', data },
    count: 0,
    viewerVoted: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function fakeStore(opts: { mine?: MyStoreListing[]; mineError?: unknown; upsertError?: (key: string) => unknown } = {}) {
  const upserts: StoreListingInput[] = [];
  const store: StoreListings = {
    upsert: vi.fn(async (input: StoreListingInput) => {
      upserts.push(input);
      const err = opts.upsertError?.(input.itemKey);
      if (err) throw err;
      return { id: `asl_${input.itemKey}`, status: 'pending' as const, pendingEdit: false };
    }),
    withdraw: vi.fn(async () => ({ withdrawn: true })),
    mine: vi.fn(async () => {
      if (opts.mineError) throw opts.mineError;
      return opts.mine ?? [];
    }),
  };
  return { store, upserts };
}

const NOW = 1_800_000_000_000;

function memoryLedger(initial: BackfillLedger | null) {
  const l = {
    value: initial,
    saved: null as BackfillLedger | null,
    get: async () => l.value,
    set: async (next: BackfillLedger) => {
      l.saved = next;
      l.value = next;
    },
  };
  return l;
}

function listed(itemKey: string, status: MyStoreListing['status'] = 'pending'): MyStoreListing {
  return { id: `asl_${itemKey}`, itemKey, status, title: itemKey, pendingEdit: false };
}

describe('clampStoreText', () => {
  it('leaves text at or under the limit alone (after whitespace cleanup)', () => {
    expect(clampStoreText('  hello   world \n', 140)).toBe('hello world');
    const exact = 'x'.repeat(140);
    expect(clampStoreText(exact, 140)).toBe(exact);
  });

  it('truncates over-long text to AT MOST the limit, ending in an ellipsis', () => {
    // Words of length 9 + a space, so the cut lands mid-word and the word-boundary
    // back-off has something to do. 30 words = 299 chars, far over 140.
    const long = Array.from({ length: 30 }, (_, i) => `word${String(i).padStart(5, '0')}`).join(' ');
    const out = clampStoreText(long, 140);
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith('…')).toBe(true);
    // Backed off to a word boundary: the last kept word is whole.
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
    expect(long.charAt(out.length - 1)).toBe(' ');
  });

  it('truncates a single unbroken run hard (no boundary to back off to)', () => {
    const out = clampStoreText('y'.repeat(500), 80);
    expect(out).toBe(`${'y'.repeat(79)}…`);
  });

  it('never splits a surrogate pair at the cut', () => {
    // 79 ASCII then an astral emoji: a naive slice(0, 79+1) would keep half of it.
    const text = `${'z'.repeat(78)}😀${'z'.repeat(50)}`;
    const out = clampStoreText(text, 80);
    expect(out.length).toBeLessThanOrEqual(80);
    // No lone high surrogate anywhere in the result.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it('turns control and format characters into spaces, as the server does before counting', () => {
    expect(clampStoreText('a​b‮c', 140)).toBe('a b c');
  });
});

describe('storeListingFor', () => {
  it('maps a generator to the g/<key> route, its name as title, its description as tagline', () => {
    expect(
      storeListingFor('01JABCDEF', { name: 'Neon Portraits', description: 'Glowing portraits in one tap.' }),
    ).toEqual({
      itemKey: '01JABCDEF',
      title: 'Neon Portraits',
      tagline: 'Glowing portraits in one tap.',
      subPath: 'g/01JABCDEF',
    });
  });

  it('omits the tagline entirely when there is no description', () => {
    const out = storeListingFor('k1', { name: 'Bare', description: '   ' });
    expect(out).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(out, 'tagline')).toBe(false);
  });

  it('clamps title and tagline to the server limits', () => {
    const out = storeListingFor('k1', { name: 'T'.repeat(200), description: 'D '.repeat(200) })!;
    expect(out.title.length).toBeLessThanOrEqual(STORE_TITLE_MAX);
    expect(out.tagline!.length).toBeLessThanOrEqual(STORE_TAGLINE_MAX);
    expect(STORE_TITLE_MAX).toBe(80);
    expect(STORE_TAGLINE_MAX).toBe(140);
  });

  it('returns null for a key the route cannot carry, or an empty name', () => {
    expect(storeListingFor('has/slash', { name: 'x', description: '' })).toBeNull();
    expect(storeListingFor('k'.repeat(65), { name: 'x', description: '' })).toBeNull();
    expect(storeListingFor('k1', { name: '   ', description: 'd' })).toBeNull();
  });

  it('reads the description back out of a published row (the backfill source)', () => {
    expect(storeListingForItem(row('k9', 'Row Title', ME, 'Row description'))).toEqual({
      itemKey: 'k9',
      title: 'Row Title',
      tagline: 'Row description',
      subPath: 'g/k9',
    });
    // A row whose body has no description line gets no tagline, not "Buttons:".
    const bare = storeListingForItem(row('k8', 'Bare Row', ME, ''))!;
    expect(bare.tagline).toBeUndefined();
  });
});

describe('classifyStoreFailure', () => {
  const e = (status: number | null, code: string | null = null) => new StoreListingError(status, code);
  it.each([
    [e(503, 'unavailable'), 'unavailable'],
    [e(403, 'not_enabled'), 'unavailable'],
    [e(403, 'untrusted'), 'unavailable'],
    [e(403, null), 'unavailable'], // scope missing on the token
    [e(401, 'anonymous'), 'unavailable'],
    [e(404, null), 'unavailable'], // route not deployed (HTML 404)
    [e(429, 'rate_limited'), 'throttled'],
    [e(429, 'author_cap'), 'throttled'],
    [e(404, 'item_not_found'), 'item'],
    [e(403, 'not_your_item'), 'item'],
    [e(400, 'text_rejected'), 'item'],
    [e(409, 'conflict'), 'item'],
    [e(500, null), 'transient'],
    [e(null, null), 'transient'], // network
    [new Error('boom'), 'transient'],
  ] as const)('%o → %s', (err, kind) => {
    expect(classifyStoreFailure(err)).toBe(kind);
  });
});

describe('storeNoticeFor', () => {
  it('says nothing when store publishing is unavailable for this app', () => {
    expect(storeNoticeFor({ ok: false, error: new StoreListingError(503, 'unavailable') })).toBeNull();
    expect(storeNoticeFor({ ok: false, error: new StoreListingError(403, 'not_enabled') })).toBeNull();
  });

  it('tells the author a new item is awaiting review', () => {
    expect(storeNoticeFor({ ok: true, result: { id: 'a', status: 'pending', pendingEdit: false } })).toMatch(
      /moderator/i,
    );
  });

  it('names a staged edit differently from a new item', () => {
    const edit = storeNoticeFor({ ok: true, result: { id: 'a', status: 'approved', pendingEdit: true } });
    const fresh = storeNoticeFor({ ok: true, result: { id: 'a', status: 'pending', pendingEdit: false } });
    expect(edit).toBeTruthy();
    expect(edit).not.toBe(fresh);
  });

  it('reassures that the in-app publish stands on every non-silent failure', () => {
    for (const err of [
      new StoreListingError(429, 'rate_limited'),
      new StoreListingError(429, 'author_cap'),
      new StoreListingError(400, 'text_rejected'),
      new StoreListingError(500, null),
      new StoreListingError(null, null),
    ]) {
      expect(storeNoticeFor({ ok: false, error: err })).toMatch(/still published here/);
    }
  });
});

describe('reconcileStoreListings', () => {
  it('upserts ONLY the author’s published items that have no store listing yet', async () => {
    const { store, upserts } = fakeStore({ mine: [listed('k2'), listed('k3', 'withdrawn')] });
    const report = await reconcileStoreListings({
      viewerId: ME,
      published: [row('k1', 'One', ME), row('k2', 'Two', ME), row('k3', 'Three', ME), row('k4', 'Four', ME)],
      store,
    });
    expect(upserts.map((u) => u.itemKey)).toEqual(['k1', 'k4']);
    expect(upserts[0]).toEqual({ itemKey: 'k1', title: 'One', tagline: 'A short description', subPath: 'g/k1' });
    expect(report.upserted).toEqual(['k1', 'k4']);
  });

  it('never touches the store for a viewer with no published items of their own', async () => {
    const { store } = fakeStore();
    const report = await reconcileStoreListings({
      viewerId: ME,
      published: [row('k1', 'Theirs', SOMEONE_ELSE)],
      store,
    });
    expect(store.mine).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
    expect(report.attempted).toBe(false);
  });

  it('ignores rows authored by someone else even if they arrive in the list', async () => {
    const { store, upserts } = fakeStore();
    await reconcileStoreListings({
      viewerId: ME,
      published: [row('k1', 'Mine', ME), row('k2', 'Theirs', SOMEONE_ELSE)],
      store,
    });
    expect(upserts.map((u) => u.itemKey)).toEqual(['k1']);
  });

  it('stops at the first throttle or unavailable answer, but skips past an item-level refusal', async () => {
    const { store, upserts } = fakeStore({
      upsertError: (key) =>
        key === 'k1'
          ? new StoreListingError(400, 'text_rejected')
          : key === 'k2'
            ? new StoreListingError(429, 'rate_limited')
            : null,
    });
    const report = await reconcileStoreListings({
      viewerId: ME,
      published: [row('k1', 'One', ME), row('k2', 'Two', ME), row('k3', 'Three', ME)],
      store,
    });
    expect(upserts.map((u) => u.itemKey)).toEqual(['k1', 'k2']);
    expect(report.stoppedBy).toBe('throttled');
  });

  it('stops before any upsert when `mine` is unavailable (503)', async () => {
    const { store } = fakeStore({ mineError: new StoreListingError(503, 'unavailable') });
    const report = await reconcileStoreListings({ viewerId: ME, published: [row('k1', 'One', ME)], store });
    expect(store.upsert).not.toHaveBeenCalled();
    expect(report.stoppedBy).toBe('unavailable');
  });

  it('🔴 skips the whole run when the ledger says one ran within the interval', async () => {
    const { store } = fakeStore();
    const ledger = memoryLedger({ v: 1, lastRunAt: NOW - BACKFILL_INTERVAL_MS + 60_000, refused: [] });
    const report = await reconcileStoreListings({ viewerId: ME, published: [row('k1', 'One', ME)], store, ledger, now: NOW });
    expect(store.mine).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
    expect(report.attempted).toBe(false);
    // ...and runs again once the interval has passed.
    const stale = memoryLedger({ v: 1, lastRunAt: NOW - BACKFILL_INTERVAL_MS - 1, refused: [] });
    await reconcileStoreListings({ viewerId: ME, published: [row('k1', 'One', ME)], store, ledger: stale, now: NOW });
    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(BACKFILL_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('🔴 does not retry an item the store refused on a previous run, and records new refusals (not 409s)', async () => {
    const { store, upserts } = fakeStore({
      upsertError: (key) =>
        key === 'k2'
          ? new StoreListingError(400, 'text_rejected')
          : key === 'k3'
            ? new StoreListingError(409, 'conflict')
            : null,
    });
    const ledger = memoryLedger({ v: 1, lastRunAt: 0, refused: ['k1', 'kGone'] });
    await reconcileStoreListings({
      viewerId: ME,
      published: [row('k1', 'One', ME), row('k2', 'Two', ME), row('k3', 'Three', ME), row('k4', 'Four', ME)],
      store,
      ledger,
      now: NOW,
    });
    expect(upserts.map((u) => u.itemKey)).toEqual(['k2', 'k3', 'k4']);
    // k1 still refused (still a candidate), k2 newly refused, k3 (a lost race) is
    // retryable, and kGone (no longer published) is dropped.
    expect(ledger.saved?.refused.sort()).toEqual(['k1', 'k2']);
    expect(ledger.saved?.lastRunAt).toBe(NOW);
  });

  it('a ledger that cannot be READ skips the run rather than risk draining the write budget', async () => {
    const { store } = fakeStore();
    const ledger = {
      get: async () => {
        throw new Error('kv down');
      },
      set: vi.fn(async () => {}),
    };
    const report = await reconcileStoreListings({ viewerId: ME, published: [row('k1', 'One', ME)], store, ledger, now: NOW });
    expect(store.mine).not.toHaveBeenCalled();
    expect(report.attempted).toBe(false);
  });

  it('a FINAL ledger write that fails does not fail the run', async () => {
    const { store, upserts } = fakeStore();
    let writes = 0;
    const ledger = {
      get: async () => null,
      set: async () => {
        writes += 1;
        if (writes > 1) throw new Error('kv down');
      },
    };
    const report = await reconcileStoreListings({ viewerId: ME, published: [row('k1', 'One', ME)], store, ledger, now: NOW });
    expect(upserts.map((u) => u.itemKey)).toEqual(['k1']);
    expect(report.upserted).toEqual(['k1']);
    expect(writes).toBe(2);
  });

  it('🔴 stamps the ledger BEFORE the first store call, so a reload mid-run cannot run again', async () => {
    const ledger = memoryLedger({ v: 1, lastRunAt: 0, refused: ['k9'] });
    let stampedBeforeMine: BackfillLedger | null = null;
    const { store } = fakeStore();
    store.mine = vi.fn(async () => {
      stampedBeforeMine = ledger.saved;
      return [];
    });
    await reconcileStoreListings({ viewerId: ME, published: [row('k1', 'One', ME), row('k9', 'Nine', ME)], store, ledger, now: NOW });
    expect(stampedBeforeMine).toEqual({ v: 1, lastRunAt: NOW, refused: ['k9'] });
  });

  it('a pre-run stamp that cannot be written skips the run', async () => {
    const { store } = fakeStore();
    const ledger = {
      get: async () => null,
      set: async () => {
        throw new Error('kv down');
      },
    };
    const report = await reconcileStoreListings({ viewerId: ME, published: [row('k1', 'One', ME)], store, ledger, now: NOW });
    expect(store.mine).not.toHaveBeenCalled();
    expect(report.attempted).toBe(false);
  });

  it('a lastRunAt in the FUTURE (a clock that ran ahead) does not switch the backfill off', async () => {
    const { store } = fakeStore();
    const ledger = memoryLedger({ v: 1, lastRunAt: NOW + 24 * 60 * 60 * 1000, refused: [] });
    await reconcileStoreListings({ viewerId: ME, published: [row('k1', 'One', ME)], store, ledger, now: NOW });
    expect(store.upsert).toHaveBeenCalledTimes(1);
  });

  it('does not remember an invalid_body refusal (a client bug a later build can fix), and forgets keys now listed', async () => {
    const { store } = fakeStore({
      mine: [listed('k1')],
      upsertError: (key) => (key === 'k2' ? new StoreListingError(400, 'invalid_body') : null),
    });
    const ledger = memoryLedger({ v: 1, lastRunAt: 0, refused: ['k1'] });
    await reconcileStoreListings({ viewerId: ME, published: [row('k1', 'One', ME), row('k2', 'Two', ME)], store, ledger, now: NOW });
    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(ledger.saved?.refused).toEqual([]);
  });

  it(`sends at most RECONCILE_MAX_UPSERTS (${RECONCILE_MAX_UPSERTS}) per run, well inside the 30/hour limit`, async () => {
    const { store, upserts } = fakeStore();
    const many = Array.from({ length: 25 }, (_, i) => row(`k${i}`, `G${i}`, ME));
    await reconcileStoreListings({ viewerId: ME, published: many, store });
    // A literal, not the constant: a constant of 0 would make "0 upserts" pass.
    expect(upserts.length).toBe(10);
    expect(RECONCILE_MAX_UPSERTS).toBe(10);
  });
});
