// The App Store sub-listing adapter, read off the wire.
//
// civitai's `upsert` body schema is `.strict()`, so an extra key — or a
// `tagline: undefined` that serialises to nothing but a `tagline: ''` that does
// not — is a 400 for every author. What this asserts is the exact JSON the
// adapter SENDS and how it classifies what comes back, against
// `src/platform/testing.tsx`'s fake of those routes. Nothing here has run
// against civitai.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __configurePlatform } from './client.js';
import { createStoreListings, StoreListingError } from './storeListings.js';
import { createFakeCivitai, SITE_URL, type FakeCivitai, type FakeCivitaiOptions } from './testing.js';
import type { SharedListItem } from './index.js';
import { APPS_STORE_ITEMS_WRITE } from '../scopes.js';
import { type BackfillLedger, classifyStoreFailure, reconcileStoreListings } from '../lib/storeListing.js';
import type { GeneratorData } from '../types.js';

const ME = 99;

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

  it('drops malformed entries rather than trusting them', async () => {
    install({}, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('sub-listings/mine')) {
        return new Response(
          JSON.stringify({ items: [{ itemKey: 'ok', status: 'pending', id: 'a', title: 't' }, { itemKey: 3 }, null] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return fake.fetch(input, init);
    }) as typeof fetch);
    const items = await createStoreListings().mine();
    expect(items.map((i) => i.itemKey)).toEqual(['ok']);
  });

  /**
   * 🔴 A 2xx WITHOUT AN `items` ARRAY IS NOT "NOTHING LISTED". Read as `[]` it
   * tells the backfill that none of the author's generators has a card, and the
   * backfill re-upserts every one of them — spending the author's store writes
   * on items that may already be listed. It rejects the way a malformed `upsert`
   * reply does, which the backfill classifies as transient and stops on.
   */
  describe.each([
    ['no items key', {}],
    ['a non-array items', { items: { itemKey: 'k1', status: 'approved' } }],
    ['a null body', null],
  ])('a 200 with %s', (_label, body) => {
    const malformedMine = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('sub-listings/mine')) {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return fake.fetch(input, init);
    }) as typeof fetch;

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

/** A shared row of the viewer's whose `value` parses as a one-button generator. */
function generatorRow(key: string): SharedListItem {
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
