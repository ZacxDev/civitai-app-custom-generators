// The private `kv` collection, driven through the REAL adapter against the SDK's
// own contract fake (`createFakeStorage`) over this repo's `block.manifest.json`.
//
// 🔴 THE LOAD-BEARING CASES ARE THE COPY-SHAPED READS. Existing viewers' rows are
// copied from the legacy KV by a separate, hand-run step that writes ONE document
// per (viewer, key): the SAME key string, data `{ value: <legacy value> }`. Every
// case under "reads what the go-live copy writes" seeds a document in exactly that
// shape — written straight through the store client, NOT through this adapter, so
// a mapping that is wrong in the same way on both sides cannot pass — and reads it
// back through the layer that consumes it in the app.

import { describe, expect, it } from 'vitest';

import { StorageError, type DocumentStorage } from '@civitai/sdk';
import { createFakeStorage } from '@civitai/sdk/testing';

import manifest from '../../block.manifest.json';
import { listDrafts, saveDraft, type StoredDraft } from '../lib/drafts.js';
import { newGenerator } from '../lib/generator.js';
import { listKeptRuns, saveKeptRun, type KeptRun } from '../lib/runs.js';
import { backfillLedgerIn, STORE_BACKFILL_KEY } from '../lib/storeListing.js';
import { createAppStorage } from './appStorage.js';
import { DEFAULT_RATE_LIMIT_RETRY, KV_COLLECTION, type RateLimitRetryPolicy } from './docStore.js';

const ALICE = { username: 'alice', id: 99 };

function setup() {
  const fake = createFakeStorage({ manifest, viewer: ALICE });
  const kv = createAppStorage(() => fake.storage);
  /** The raw collection — the copy's view of the store, bypassing the adapter. */
  const raw = fake.storage.collection<Record<string, unknown>>(KV_COLLECTION);
  return { fake, kv, raw };
}

const DRAFT: StoredDraft = {
  id: 'gen_mgq1x2_3_ab12',
  config: newGenerator({ name: 'Neon' }),
  updatedAt: 1_760_000_000_000,
  publishedKey: '01JABCDEFGHJKMNPQRSTVWXYZ0',
};

const KEPT: KeptRun = {
  id: 'kept_mgq1x2_4_cd34',
  keptAt: 1_760_000_000_500,
  imageIds: [101, 102],
  generatorName: 'Neon',
  generatorKey: '01JABCDEFGHJKMNPQRSTVWXYZ0',
  buttonLabel: 'Glow',
  prompt: 'a cat',
};

describe('kv: the {value} wrapper, written', () => {
  it('stores every value as { value } under the SAME key, for each key family', async () => {
    const { kv, raw } = setup();
    await saveDraft(kv, DRAFT);
    await saveKeptRun(kv, KEPT);
    await backfillLedgerIn(kv).set({ v: 1, lastRunAt: 5, refused: ['k1'] });

    expect((await raw.get(`draft:${DRAFT.id}`))?.data).toEqual({ value: DRAFT });
    expect((await raw.get(`kept:${KEPT.id}`))?.data).toEqual({ value: KEPT });
    expect((await raw.get('store-backfill:v1'))?.data).toEqual({ value: { v: 1, lastRunAt: 5, refused: ['k1'] } });
  });

  it('wraps a value that is not an object too (a document must be one)', async () => {
    const { kv, raw } = setup();
    await kv.set('x:null', null);
    await kv.set('x:arr', [1, 2]);
    await kv.set('x:bool', true);
    expect((await raw.get('x:null'))?.data).toEqual({ value: null });
    expect((await raw.get('x:arr'))?.data).toEqual({ value: [1, 2] });
    expect((await raw.get('x:bool'))?.data).toEqual({ value: true });
  });

  it('round-trips get / set / delete', async () => {
    const { kv } = setup();
    expect(await kv.get('draft:none')).toBeNull();
    await kv.set('draft:a', { n: 1 });
    expect(await kv.get('draft:a')).toEqual({ n: 1 });
    expect(await kv.delete('draft:a')).toEqual({ ok: true, deleted: true });
    expect(await kv.delete('draft:a')).toEqual({ ok: true, deleted: false });
    expect(await kv.get('draft:a')).toBeNull();
  });
});

describe('kv: reads what the go-live copy writes', () => {
  it('a copied draft (draft:<id> → { value }) lists as a draft', async () => {
    const { kv, raw } = setup();
    await raw.put(`draft:${DRAFT.id}`, { value: DRAFT });
    expect(await listDrafts(kv)).toEqual([DRAFT]);
  });

  it('a copied kept run (kept:<id> → { value }) lists as a kept run', async () => {
    const { kv, raw } = setup();
    await raw.put(`kept:${KEPT.id}`, { value: KEPT });
    const page = await listKeptRuns(kv);
    expect(page.runs).toEqual([KEPT]);
    expect(page.truncated).toBe(false);
  });

  /**
   * 🔴 `store-backfill:v1` KEEPS ITS SEMANTICS ACROSS THE COPY. The ledger bounds
   * the App Store backfill to one run per 6 h and remembers refused items. Read
   * back unwrapped, a copied ledger still says when the last run was — so the
   * first page load after go-live does not run the backfill again early, and
   * items the store refused before are still skipped.
   */
  it('a copied backfill ledger (store-backfill:v1 → { value }) reads back as the same ledger', async () => {
    const { kv, raw } = setup();
    const ledger = { v: 1, lastRunAt: 1_760_000_000_000, refused: ['01JREFUSED0000000000000000'] };
    await raw.put(STORE_BACKFILL_KEY, { value: ledger });
    expect(await backfillLedgerIn(kv).get()).toEqual(ledger);
  });

  it('a copied row whose data lacks `value` reads as missing, not as undefined', async () => {
    const { kv, raw } = setup();
    await raw.put('draft:odd', { other: 1 });
    expect(await kv.get('draft:odd')).toBeNull();
  });
});

describe('kv: list', () => {
  it('carries each value on the page, in key order, newest-first on request', async () => {
    const { kv } = setup();
    await kv.set('kept:a', 1);
    await kv.set('kept:c', 3);
    await kv.set('kept:b', 2);
    await kv.set('draft:z', 'other prefix');
    expect((await kv.list({ prefix: 'kept:' })).keys).toEqual([
      { key: 'kept:a', value: 1 },
      { key: 'kept:b', value: 2 },
      { key: 'kept:c', value: 3 },
    ]);
    expect((await kv.list({ prefix: 'kept:', newestFirst: true })).keys.map((k) => k.key)).toEqual([
      'kept:c',
      'kept:b',
      'kept:a',
    ]);
  });

  it('passes the cursor through exactly when another key exists', async () => {
    const { kv } = setup();
    await kv.set('kept:a', 1);
    await kv.set('kept:b', 2);
    const first = await kv.list({ prefix: 'kept:', limit: 1 });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await kv.list({ prefix: 'kept:', limit: 1, cursor: first.nextCursor });
    expect(second.keys.map((k) => k.key)).toEqual(['kept:b']);
    expect('nextCursor' in second).toBe(false);
  });

  /** The store REFUSES a limit above 100; the adapter clamps rather than fail the read. */
  it('clamps a limit above the store ceiling instead of sending it', async () => {
    const { fake, kv } = setup();
    await kv.set('kept:a', 1);
    await expect(kv.list({ prefix: 'kept:', limit: 500 })).resolves.toMatchObject({ keys: [{ key: 'kept:a' }] });
    const listCall = fake.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/kv')).at(-1);
    expect(listCall?.query.limit).toBe('100');
  });

  it('an anonymous viewer is REFUSED, never handed an empty list', async () => {
    const fake = createFakeStorage({ manifest, viewer: null });
    const kv = createAppStorage(() => fake.storage);
    await expect(kv.list({ prefix: 'draft:' })).rejects.toMatchObject({ code: 'sign_in_required' });
    await expect(listDrafts(kv)).rejects.toMatchObject({ code: 'sign_in_required' });
  });
});

/**
 * 🔴 THE 429 RETRY IS BOUNDED IN COUNT AND IN WAIT. A short `Retry-After` (the
 * store's "contention" 429) is retried in place, at most `maxRetries` more times;
 * a long one (a spent per-minute window, `Retry-After: 60`) rejects at once.
 */
describe('kv: rate_limited', () => {
  function limited(retryAfter: number) {
    return new StorageError(429, 'rate_limited', 'rate limited', {}, { retryAfter });
  }

  /** A store whose `get` answers from `script` in order, then succeeds. */
  function scripted(script: Array<StorageError>) {
    let calls = 0;
    const docs = {
      collection: () => ({
        async get() {
          calls += 1;
          const next = script.shift();
          if (next) throw next;
          return { data: { value: 'ok' } };
        },
      }),
    } as unknown as DocumentStorage;
    return { docs, calls: () => calls };
  }

  function policy(): RateLimitRetryPolicy & { waits: number[] } {
    const waits: number[] = [];
    return { ...DEFAULT_RATE_LIMIT_RETRY, sleep: async (ms) => void waits.push(ms), waits };
  }

  it('retries a short 429 after the named wait and then succeeds', async () => {
    const { docs, calls } = scripted([limited(1)]);
    const p = policy();
    expect(await createAppStorage(() => docs, p).get('k')).toBe('ok');
    expect(calls()).toBe(2);
    expect(p.waits).toEqual([1000]);
  });

  it('a PERSISTENT short 429 stops after exactly 1 + maxRetries attempts', async () => {
    const { docs, calls } = scripted(Array.from({ length: 10 }, () => limited(1)));
    const p = policy();
    await expect(createAppStorage(() => docs, p).get('k')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(calls()).toBe(1 + DEFAULT_RATE_LIMIT_RETRY.maxRetries);
    expect(DEFAULT_RATE_LIMIT_RETRY.maxRetries).toBe(2);
  });

  it('a long Retry-After is NOT waited out in place', async () => {
    const { docs, calls } = scripted([limited(60)]);
    const p = policy();
    await expect(createAppStorage(() => docs, p).get('k')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(calls()).toBe(1);
    expect(p.waits).toEqual([]);
  });

  /** The real window, from the contract fake: 300 reads a minute, then `Retry-After: 60`. */
  it('the store’s own read window rejects without an in-place wait', async () => {
    const fake = createFakeStorage({ manifest, viewer: ALICE, enforceRateLimits: true, now: () => 0 });
    const p = policy();
    const kv = createAppStorage(() => fake.storage, p);
    for (let i = 0; i < 300; i++) await kv.get('k');
    await expect(kv.get('k')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(p.waits).toEqual([]);
  });
});

/**
 * INVARIANT GUARD (not a regression test — nothing here ever exceeded it): the
 * store refuses a document nested deeper than 16 (root = 1). The deepest thing
 * this app writes is a draft of a generator with the maximum LoRA stack; it must
 * round-trip through the contract fake, which enforces that depth.
 */
describe('kv: nesting depth', () => {
  function depth(v: unknown): number {
    if (v === null || typeof v !== 'object') return 0;
    const children = Object.values(v as Record<string, unknown>).map(depth);
    return 1 + (children.length ? Math.max(...children) : 0);
  }

  it('the deepest draft this app writes is stored, and sits well under 16', async () => {
    const { kv, raw } = setup();
    const config = newGenerator({ name: 'Deep' });
    const button = config.buttons[0]!;
    button.loras = Array.from({ length: 5 }, (_, i) => ({
      versionId: 2000 + i,
      weight: 0.5,
      modelName: `L${i}`,
      versionName: 'v1',
      minStrength: 0,
      maxStrength: 1,
    }));
    const draft: StoredDraft = { id: 'gen_deep', config, updatedAt: 1 };
    await saveDraft(kv, draft);
    const stored = (await raw.get('draft:gen_deep'))?.data;
    expect(stored).toEqual({ value: draft });
    expect(depth(stored)).toBeLessThanOrEqual(10);
  });
});
