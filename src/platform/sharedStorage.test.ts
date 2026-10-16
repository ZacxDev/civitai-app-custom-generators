// The shared `records` collection, driven through the REAL adapter against the
// SDK's own contract fake (`createFakeStorage`) over this repo's manifest — which
// enforces `write: "own"` (`not_author`), the publish scope's consent, marks and
// `viewer.marks`, the trust gate and moderation.
//
// 🔴 THE COPY-SHAPED CASES SEED THROUGH THE STORE CLIENT, NOT THE ADAPTER. The
// go-live copy writes one `records` document per legacy row: the SAME key (a
// ULID), data = the legacy `{ title, body, data }` VERBATIM, authored by the
// row's author. Seeding that shape directly is what lets a mapping that is wrong
// on both sides fail here.

import { describe, expect, it } from 'vitest';

import { StorageError, type DocumentStorage } from '@civitai/sdk';
import { createFakeStorage, FAKE_STORAGE_MODERATION } from '@civitai/sdk/testing';

import manifest from '../../block.manifest.json';
import {
  PUBLISH_CONSENT_MESSAGE,
  PUBLISH_CONTENT_REJECTED_MESSAGE,
  PUBLISH_SIGN_IN_MESSAGE,
  SharedWriteRefusal,
} from '../lib/storageErrors.js';
import { RECORDS_COLLECTION } from './docStore.js';
import { createSharedStorage, type RecordDocument } from './sharedStorage.js';
import type { SharedAppendValue } from './types.js';

const ALICE = { username: 'alice', id: 99 };
const BOB = { username: 'bob', id: 7 };

/** A legacy shared value, exactly as the legacy store held it. */
const LEGACY: SharedAppendValue = {
  title: 'Neon Portraits',
  body: 'Glowing portraits.\nButtons: Glow',
  data: { v: 1, buttons: [{ label: 'Glow', loras: [{ versionId: 2002, weight: 0.8 }] }] },
};

function setup(opts: { scopes?: string[]; viewer?: typeof ALICE | null } = {}) {
  const fake = createFakeStorage({ manifest, viewer: ALICE });
  const viewer = opts.viewer === undefined ? ALICE : opts.viewer;
  const session = fake.as({ viewer, ...(opts.scopes ? { scopes: opts.scopes } : {}) });
  const shared = createSharedStorage({ docs: () => session.storage, viewerId: () => viewer?.id ?? null });
  const as = (who: typeof ALICE | null) => fake.as({ viewer: who }).storage.collection<RecordDocument>(RECORDS_COLLECTION);
  return { fake, shared, as };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof SharedWriteRefusal || e instanceof StorageError ? e.code : String(e)),
  );

describe('records: reads what the go-live copy writes', () => {
  it('a copied row (legacy key → legacy value verbatim) reads back unchanged, with its vote tally', async () => {
    const { shared, as } = setup();
    const key = '01JABCDEFGHJKMNPQRSTVWXYZ0';
    await as(BOB).put(key, LEGACY as RecordDocument);
    await as(ALICE).mark(key, 'vote');

    const [item] = (await shared.list()).items;
    expect(item).toMatchObject({ key, value: LEGACY, count: 1, viewerVoted: true });
    // Someone else's row: no author id is invented for it.
    expect(item!.authorUserId).toBeNull();
    expect(await shared.get(key)).toMatchObject({ key, value: LEGACY });
  });

  it('the viewer’s own copied row is stamped with THEIR id, and only for them', async () => {
    const { fake, as } = setup();
    const key = '01JOWN0000000000000000000000';
    await as(ALICE).put(key, LEGACY as RecordDocument);

    const forAlice = createSharedStorage({ docs: () => fake.as({ viewer: ALICE }).storage, viewerId: () => ALICE.id });
    const forBob = createSharedStorage({ docs: () => fake.as({ viewer: BOB }).storage, viewerId: () => BOB.id });
    expect((await forAlice.get(key))?.authorUserId).toBe(ALICE.id);
    expect((await forBob.get(key))?.authorUserId).toBeNull();
  });
});

describe('records: list', () => {
  it('is newest-first by key, and `mine` narrows to the viewer’s own rows server-side', async () => {
    const { shared, as } = setup();
    await as(BOB).put('01J0000000000000000000000A', { title: 'A' } as RecordDocument);
    await as(ALICE).put('01J0000000000000000000000B', { title: 'B' } as RecordDocument);
    await as(BOB).put('01J0000000000000000000000C', { title: 'C' } as RecordDocument);

    expect((await shared.list()).items.map((i) => i.value.title)).toEqual(['C', 'B', 'A']);
    expect((await shared.list({ mine: true })).items.map((i) => i.value.title)).toEqual(['B']);
  });

  it('sends `author=me` for `mine`, and never a legacy `mine` key', async () => {
    const { fake, shared } = setup();
    await shared.list({ mine: true, limit: 100 });
    await shared.list({ limit: 51 });
    const lists = fake.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/records'));
    expect(lists.map((c) => c.query)).toEqual([
      { sort: '-key', author: 'me', limit: '100' },
      { sort: '-key', limit: '51' },
    ]);
  });

  it('clamps a limit above the store ceiling instead of sending it (which the store refuses)', async () => {
    const { shared } = setup();
    await expect(shared.list({ limit: 500 })).resolves.toEqual({ items: [] });
  });

  it('pages with an exact cursor', async () => {
    const { shared, as } = setup();
    await as(BOB).put('01J0000000000000000000000A', { title: 'A' } as RecordDocument);
    await as(BOB).put('01J0000000000000000000000B', { title: 'B' } as RecordDocument);
    const first = await shared.list({ limit: 1 });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await shared.list({ limit: 1, cursor: first.nextCursor });
    expect(second.items.map((i) => i.value.title)).toEqual(['A']);
    expect(second.nextCursor).toBeUndefined();
  });
});

describe('records: create / update / withdraw under write: "own"', () => {
  it('append creates the legacy value VERBATIM under a server-minted key', async () => {
    const { shared, as } = setup();
    const { key } = await shared.append(LEGACY);
    expect(key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    const doc = await as(BOB).get(key);
    expect(doc?.data).toEqual(LEGACY);
    expect(doc?.author).toEqual({ kind: 'user', isViewer: false });
  });

  it('update replaces the author’s row in place, keeping its key and its votes', async () => {
    const { shared, as } = setup();
    const { key } = await shared.append(LEGACY);
    await as(BOB).mark(key, 'vote');
    await shared.update(key, { ...LEGACY, title: 'Renamed' });
    const doc = await as(BOB).get(key);
    expect(doc?.data.title).toBe('Renamed');
    expect(doc?.marks.vote).toBe(1);
    expect(doc?.version).toBe(2);
  });

  /**
   * 🔴 `put` CREATES A MISSING KEY. The legacy `update` answered 404 for one, so a
   * plain `put` here would RESURRECT a generator its author withdrew in another
   * tab. The adapter reads first and refuses — and nothing is created.
   */
  it('update of a withdrawn row is refused not_found and does NOT recreate it', async () => {
    const { shared, as } = setup();
    const { key } = await shared.append(LEGACY);
    await shared.withdraw(key);
    expect(await codeOf(shared.update(key, LEGACY))).toBe('not_found');
    expect(await as(BOB).get(key)).toBeNull();
  });

  it('update of someone else’s row is refused not_author, in viewer copy', async () => {
    const { shared, as } = setup();
    await as(BOB).put('01JBOB0000000000000000000000', LEGACY as RecordDocument);
    const err = await shared.update('01JBOB0000000000000000000000', LEGACY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SharedWriteRefusal);
    expect((err as SharedWriteRefusal).code).toBe('not_author');
    expect((err as Error).message).toBe('Only the person who published this generator can change it.');
  });

  it('withdraw deletes the author’s own row; someone else’s is refused', async () => {
    const { shared, as } = setup();
    const { key } = await shared.append(LEGACY);
    expect(await shared.withdraw(key)).toEqual({ ok: true, deleted: true });
    expect(await shared.withdraw(key)).toEqual({ ok: true, deleted: false });
    await as(BOB).put('01JBOB0000000000000000000000', LEGACY as RecordDocument);
    expect(await codeOf(shared.withdraw('01JBOB0000000000000000000000'))).toBe('not_author');
  });

  it('withdraw needs only apps:storage — a viewer without the publish grant can still remove their row', async () => {
    const fake = createFakeStorage({ manifest, viewer: ALICE });
    const { key } = await createSharedStorage({ docs: () => fake.storage, viewerId: () => 99 }).append(LEGACY);
    const ungranted = createSharedStorage({
      docs: () => fake.as({ scopes: ['apps:storage'] }).storage,
      viewerId: () => 99,
    });
    expect(await ungranted.withdraw(key)).toEqual({ ok: true, deleted: true });
  });
});

describe('records: vote and report are marks', () => {
  it('vote / unvote set the `vote` mark and resolve the tally; viewerVoted is viewer.marks', async () => {
    const { shared, as } = setup();
    await as(BOB).put('01JX000000000000000000000000', LEGACY as RecordDocument);
    expect(await shared.vote('01JX000000000000000000000000')).toBe(1);
    expect(await shared.vote('01JX000000000000000000000000')).toBe(1); // idempotent
    expect((await shared.get('01JX000000000000000000000000'))?.viewerVoted).toBe(true);
    expect(await shared.unvote('01JX000000000000000000000000')).toBe(0);
    expect((await shared.get('01JX000000000000000000000000'))?.viewerVoted).toBe(false);
  });

  it('report files the built-in mark and does not hide the row', async () => {
    const { fake, shared, as } = setup();
    await as(BOB).put('01JX000000000000000000000000', LEGACY as RecordDocument);
    await shared.report('01JX000000000000000000000000');
    expect(fake.calls.some((c) => c.method === 'PUT' && c.path.endsWith('/marks/report'))).toBe(true);
    expect(await shared.get('01JX000000000000000000000000')).not.toBeNull();
  });

  it('an anonymous viewer reads the board but cannot vote', async () => {
    const { shared, as } = setup({ viewer: null });
    await as(BOB).put('01JX000000000000000000000000', LEGACY as RecordDocument);
    expect((await shared.list()).items).toHaveLength(1);
    expect(await codeOf(shared.vote('01JX000000000000000000000000'))).toBe('sign_in_required');
  });
});

/**
 * 🔴 REFUSALS REACH THE VIEWER AS FIXED COPY, NEVER AS SERVER PROSE. Each case is
 * the contract fake's own refusal, through the adapter, to the exact sentence.
 */
describe('records: shared-write refusals', () => {
  it('consent_required (token without apps:storage:publish) → the consent copy', async () => {
    const { shared } = setup({ scopes: ['apps:storage'] });
    const err = await shared.append(LEGACY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SharedWriteRefusal);
    expect((err as SharedWriteRefusal).code).toBe('consent_required');
    expect((err as Error).message).toBe(PUBLISH_CONSENT_MESSAGE);
  });

  it('sign_in_required (anonymous) → the sign-in copy', async () => {
    const { shared } = setup({ viewer: null });
    const err = await shared.append(LEGACY).catch((e: unknown) => e);
    expect((err as SharedWriteRefusal).code).toBe('sign_in_required');
    expect((err as Error).message).toBe(PUBLISH_SIGN_IN_MESSAGE);
  });

  it('content_rejected (moderation, in title OR in data) → the content copy', async () => {
    const { shared } = setup();
    for (const value of [
      { ...LEGACY, title: FAKE_STORAGE_MODERATION.blockedText },
      { ...LEGACY, data: { v: 1, buttons: [{ promptTemplate: FAKE_STORAGE_MODERATION.blockedText }] } },
    ]) {
      const err = await shared.append(value).catch((e: unknown) => e);
      expect((err as SharedWriteRefusal).code).toBe('content_rejected');
      expect((err as Error).message).toBe(PUBLISH_CONTENT_REJECTED_MESSAGE);
    }
  });

  it('not_eligible (the trust gate) → copy keyed on details.reason', async () => {
    const fake = createFakeStorage({ manifest, viewer: { username: 'new', id: 5, trusted: false, untrustedReason: 'email_unverified' } });
    const shared = createSharedStorage({ docs: () => fake.storage, viewerId: () => 5 });
    const err = await shared.append(LEGACY).catch((e: unknown) => e);
    expect((err as SharedWriteRefusal).code).toBe('not_eligible');
    expect((err as Error).message).toBe('Verify your email address on Civitai first, then try again.');
  });

  /**
   * A create's 429 is the author's shared-write budget (a refill every six
   * minutes): it is NOT retried in place, even with a short Retry-After.
   */
  it('a rate-limited create is not retried', async () => {
    let creates = 0;
    const docs = {
      collection: () => ({
        async create() {
          creates += 1;
          throw new StorageError(429, 'rate_limited', 'slow down', {}, { retryAfter: 1 });
        },
      }),
    } as unknown as DocumentStorage;
    const shared = createSharedStorage({ docs: () => docs, viewerId: () => 99 });
    expect(await codeOf(shared.append(LEGACY))).toBe('rate_limited');
    expect(creates).toBe(1);
  });
});
