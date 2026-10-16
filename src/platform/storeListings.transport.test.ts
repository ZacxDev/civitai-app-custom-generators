// The App Store sub-listing adapter, read off the wire — through the REAL
// `@civitai/sdk` client (`app.subListings`, 0.15+), which `initialize()` builds
// over the fake's `fetch`. Nothing here mocks the SDK: what it asserts is what
// the SDK actually put on the wire for the input this app built.
//
// civitai's `upsert` body schema is `.strict()`, so an extra key — or a
// `tagline: undefined` that serialises to nothing but a `tagline: ''` that does
// not — is a 400 for every author. What this asserts is the exact JSON the
// adapter SENDS and how it classifies what comes back, against
// `src/platform/testing.tsx`'s fake of those routes. Nothing here has run
// against civitai.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubListingError } from '@civitai/sdk';

import { __configurePlatform } from './client.js';
import { createStoreListings, StoreListingError } from './storeListings.js';
import { createFakeCivitai, SITE_URL, type FakeCivitai, type FakeCivitaiOptions } from './testing.js';
import type { SharedListItem } from './index.js';
import { APPS_STORE_ITEMS_WRITE } from '../scopes.js';
import { type BackfillLedger, classifyStoreFailure, reconcileStoreListings } from '../lib/storeListing.js';
import type { GeneratorData } from '../types.js';

const ME = 99;
/** Distinct from every other number in this suite (ME, statuses, counts). */
const CARD_IMAGE = 52_613;

let fake: FakeCivitai;

function install(opts: FakeCivitaiOptions = {}, fetchOverride?: typeof fetch) {
  fake = createFakeCivitai({
    viewer: { id: ME, username: 'me' },
    scopes: [APPS_STORE_ITEMS_WRITE],
    shared: {
      seed: [
        { key: 'k1', authorUserId: ME, value: { title: 'Mine', body: 'd' } },
        { key: 'k2', authorUserId: 7, value: { title: 'Theirs', body: 'd' } },
      ],
    },
    ...opts,
  });
  __configurePlatform({ transport: fake.transport, fetch: fetchOverride ?? fake.fetch, siteUrl: SITE_URL });
}

beforeEach(() => install());
afterEach(() => __configurePlatform({}));

function callsTo(path: string) {
  return fake.calls.filter((c) => c.path === path);
}

describe('upsert', () => {
  it('POSTs exactly the schema keys to blocks/sub-listings/upsert', async () => {
    const res = await createStoreListings().upsert({
      itemKey: 'k1',
      title: 'Mine',
      tagline: 'A tagline',
      subPath: 'g/k1',
    });
    const [call] = callsTo('blocks/sub-listings/upsert');
    expect(call?.method).toBe('POST');
    expect(call?.body).toStrictEqual({ itemKey: 'k1', title: 'Mine', tagline: 'A tagline', subPath: 'g/k1' });
    expect(res).toEqual({ id: expect.stringMatching(/^asl_/), status: 'pending', pendingEdit: false });
  });

  it('sends NO tagline key at all when there is none', async () => {
    await createStoreListings().upsert({ itemKey: 'k1', title: 'Mine', subPath: 'g/k1' });
    const [call] = callsTo('blocks/sub-listings/upsert');
    expect(Object.keys(call!.body as object).sort()).toEqual(['itemKey', 'subPath', 'title']);
  });

  it('sends the chosen imageId, and the fake stores it', async () => {
    install({ subListings: { publicImages: [{ imageId: CARD_IMAGE, userId: ME }] } });
    await createStoreListings().upsert({ itemKey: 'k1', title: 'Mine', subPath: 'g/k1', imageId: CARD_IMAGE });
    expect(callsTo('blocks/sub-listings/upsert')[0]?.body).toStrictEqual({
      itemKey: 'k1',
      title: 'Mine',
      subPath: 'g/k1',
      imageId: CARD_IMAGE,
    });
    expect(fake.subListings().get('k1')?.imageId).toBe(CARD_IMAGE);
  });

  /**
   * 🔴 `upsert` REPLACES THE WHOLE ITEM (server: `body.imageId ?? null`; SDK: a
   * left-out optional is cleared). An edit — here a new title on an APPROVED card,
   * which stages a pending edit — must carry the image again, or the edit itself
   * removes the author's card image.
   */
  it('an edit re-sends imageId, so the card keeps its image (replace semantics)', async () => {
    install({
      subListings: {
        seed: [{ itemKey: 'k1', status: 'approved' }],
        publicImages: [{ imageId: CARD_IMAGE, userId: ME }],
      },
    });
    const store = createStoreListings();
    await store.upsert({ itemKey: 'k1', title: 'Mine', subPath: 'g/k1', imageId: CARD_IMAGE });
    const res = await store.upsert({ itemKey: 'k1', title: 'Mine, renamed', subPath: 'g/k1', imageId: CARD_IMAGE });
    const [, edit] = callsTo('blocks/sub-listings/upsert');
    expect(edit?.body).toStrictEqual({ itemKey: 'k1', title: 'Mine, renamed', subPath: 'g/k1', imageId: CARD_IMAGE });
    expect(fake.subListings().get('k1')).toMatchObject({ title: 'Mine, renamed', imageId: CARD_IMAGE });
    expect(res).toEqual({ id: 'asl_k1', status: 'approved', pendingEdit: true });
  });

  it.each([
    ['no pendingEdit', { id: 'asl_k1', status: 'pending' }],
    ['no id', { status: 'pending', pendingEdit: false }],
    ['a status outside the four', { id: 'asl_k1', status: 'archived', pendingEdit: false }],
    ['an empty body', null],
  ])('a 200 upsert reply with %s is a malformed_response StoreListingError (transient)', async (_label, reply) => {
    install({}, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('sub-listings/upsert')) {
        return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return fake.fetch(input, init);
    }) as typeof fetch);
    const err = (await createStoreListings()
      .upsert({ itemKey: 'k1', title: 'Mine', subPath: 'g/k1' })
      .catch((e: unknown) => e)) as StoreListingError;
    expect(err).toBeInstanceOf(StoreListingError);
    expect(err.status).toBeNull();
    expect(err.code).toBe('malformed_response');
    expect(classifyStoreFailure(err)).toBe('transient');
  });

  it.each([
    ['image_not_public', 400],
    ['image_not_yours', 403],
    ['not_enabled', 403],
    ['insufficient_scope', 403],
  ] as const)('a %s refusal (the SDK’s SubListingError) keeps its status and code', async (code, status) => {
    install({ subListings: { fail: { upsert: { status, code } } } });
    const err = (await createStoreListings()
      .upsert({ itemKey: 'k1', title: 'Mine', subPath: 'g/k1' })
      .catch((e: unknown) => e)) as StoreListingError;
    expect(err).toBeInstanceOf(StoreListingError);
    expect([err.status, err.code]).toEqual([status, code]);
    expect(err.cause).toBeInstanceOf(SubListingError);
  });

  it('turns a non-2xx into a StoreListingError carrying the status and the server code', async () => {
    install({ subListings: { fail: { upsert: { status: 503, code: 'unavailable' } } } });
    const err = await createStoreListings()
      .upsert({ itemKey: 'k1', title: 'Mine', subPath: 'g/k1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreListingError);
    expect((err as StoreListingError).status).toBe(503);
    expect((err as StoreListingError).code).toBe('unavailable');
  });

  it('a route miss (HTML 404) carries status 404 and NO code', async () => {
    install({ subListings: { fail: { upsert: { status: 404, html: true } } } });
    const err = (await createStoreListings()
      .upsert({ itemKey: 'k1', title: 'Mine', subPath: 'g/k1' })
      .catch((e: unknown) => e)) as StoreListingError;
    expect(err).toBeInstanceOf(StoreListingError);
    expect(err.status).toBe(404);
    expect(err.code).toBeNull();
  });

  it('a network failure is a StoreListingError with a null status', async () => {
    install({}, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('sub-listings')) throw new TypeError('Failed to fetch');
      return fake.fetch(input, init);
    }) as typeof fetch);
    const err = (await createStoreListings()
      .upsert({ itemKey: 'k1', title: 'Mine', subPath: 'g/k1' })
      .catch((e: unknown) => e)) as StoreListingError;
    expect(err).toBeInstanceOf(StoreListingError);
    expect(err.status).toBeNull();
  });
});

describe('mine', () => {
  it('GETs blocks/sub-listings/mine and returns the items', async () => {
    install({ subListings: { seed: [{ itemKey: 'k1', status: 'approved' }] } });
    const items = await createStoreListings().mine();
    const [call] = callsTo('blocks/sub-listings/mine');
    expect(call?.method).toBe('GET');
    expect(items.map((i) => [i.itemKey, i.status])).toEqual([['k1', 'approved']]);
  });

  it('keeps a row whose status is outside the four known values — it is still a listing', async () => {
    install({}, mineReplying({ items: [mineRow('odd', { status: 'archived' })] }));
    const items = await createStoreListings().mine();
    expect(items.map((i) => [i.itemKey, i.status])).toEqual([['odd', 'archived']]);
  });

  /**
   * 🔴 A 2xx WITHOUT AN `items` ARRAY IS NOT "NOTHING LISTED". Read as `[]` it
   * tells the backfill that none of the author's generators has a card, and the
   * backfill re-upserts every one of them — spending the author's store writes
   * on items that may already be listed. It rejects the way a malformed `upsert`
   * reply does, which the backfill classifies as transient and stops on.
   *
   * 🔴 AND ONE UNREADABLE ROW REJECTS THE WHOLE CALL (the `@civitai/sdk` 0.15
   * `mine()` contract, kept on purpose). The pre-0.15 adapter skipped such a row,
   * so its key read as "not listed" and the backfill re-upserted an item that
   * already had a card — the same spent write as above, one row at a time.
   */
  describe.each([
    ['no items key', {}],
    ['a non-array items', { items: { itemKey: 'k1', status: 'approved' } }],
    ['a null body', null],
    ['ONE malformed row (non-string itemKey) among good ones', { items: [mineRow('k1'), { ...mineRow('k3'), itemKey: 3 }] }],
    ['ONE null row among good ones', { items: [mineRow('k1'), null] }],
    ['ONE row missing `updatedAt`', { items: [mineRow('k1'), { ...mineRow('k3'), updatedAt: undefined }] }],
  ])('a 200 with %s', (_label, body) => {
    const malformedMine = mineReplying(body);

    it('rejects as a malformed_response StoreListingError with no status', async () => {
      install({}, malformedMine);
      const err = (await createStoreListings()
        .mine()
        .catch((e: unknown) => e)) as StoreListingError;
      expect(err).toBeInstanceOf(StoreListingError);
      expect(err.status).toBeNull();
      expect(err.code).toBe('malformed_response');
      expect(classifyStoreFailure(err)).toBe('transient');
    });

    it('stops the backfill before ANY upsert, and records no new refusals', async () => {
      install({}, malformedMine);
      let saved: BackfillLedger | null = null;
      const ledger = {
        get: async (): Promise<BackfillLedger | null> => ({ v: 1, lastRunAt: 0, refused: ['k2'] }),
        set: async (next: BackfillLedger) => {
          saved = next;
        },
      };
      const report = await reconcileStoreListings({
        viewerId: ME,
        published: [generatorRow('k1'), generatorRow('k2'), generatorRow('k3')],
        store: createStoreListings(),
        ledger,
        now: 1_800_000_000_000,
      });
      // (The `mine` reply is served by the override above, so only the fake's
      // own routes — `upsert` among them — are recorded in `fake.calls`.)
      expect(callsTo('blocks/sub-listings/upsert')).toHaveLength(0);
      expect(report).toEqual({ attempted: true, upserted: [], stoppedBy: 'transient' });
      // Only the refusal it already had (k2, still published) survives.
      expect(saved).toEqual({ v: 1, lastRunAt: 1_800_000_000_000, refused: ['k2'] });
    });
  });
});

describe('the backfill, through the real SDK', () => {
  it('🔴 re-sends a published generator’s stored `storeImageId`, so the backfill cannot clear a card image', async () => {
    install({ subListings: { publicImages: [{ imageId: CARD_IMAGE, userId: ME }] } });
    const report = await reconcileStoreListings({
      viewerId: ME,
      published: [generatorRow('k1', CARD_IMAGE)],
      store: createStoreListings(),
    });
    expect(report.upserted).toEqual(['k1']);
    expect(callsTo('blocks/sub-listings/upsert')[0]?.body).toMatchObject({ itemKey: 'k1', imageId: CARD_IMAGE });
    expect(fake.subListings().get('k1')?.imageId).toBe(CARD_IMAGE);
  });
});

/** A shared row of the viewer's whose `value` parses as a one-button generator. */
function generatorRow(key: string, storeImageId?: number): SharedListItem {
  const data = {
    v: 1,
    buttons: [
      {
        id: 'b1',
        label: 'Go',
        workflowType: 'txt2img',
        loras: [],
        promptTemplate: 'a {prompt}',
        params: { steps: 20, cfgScale: 7, width: 512, height: 512, quantity: 1 },
      },
    ],
    ...(storeImageId !== undefined ? { storeImageId } : {}),
  } as unknown as GeneratorData;
  return {
    key,
    authorUserId: ME,
    value: { title: `Gen ${key}`, body: 'A short description\nButtons:\n• Go: a {prompt}', data },
    count: 0,
    viewerVoted: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** A `mine` row exactly as civitai's `listMySubListings` serialises one. */
function mineRow(itemKey: string, over: Record<string, unknown> = {}) {
  return {
    id: `asl_${itemKey}`,
    itemKey,
    status: 'approved',
    title: `Gen ${itemKey}`,
    pendingEdit: false,
    statusReason: null,
    editRejectionReason: null,
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

/** The fake's fetch, with `blocks/sub-listings/mine` answered 200 with `body`. */
function mineReplying(body: unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('sub-listings/mine')) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
}
