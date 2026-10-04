// `shared-storage/list`'s QUERY STRING, read off the wire.
//
// 🔴 WHY A QUERY-STRING SUITE AND NOT A COMPONENT ONE. `mine=true` is the fix for
// "the viewer's own published generators go missing past page one" (see the
// `myPublished` state in `App.tsx`), and the route it talks to validates the
// parameter as `z.union([z.literal('true'), z.literal('false')]).optional()` —
// deliberately NOT `z.coerce.boolean()`, which maps the string "false" to TRUE.
// Two ways to get that wrong both type-check and both 400 in production:
//
//   1. sending the flag as a string the union does not name, and
//   2. sending `?mine=` for an UNSET flag — what any `?? ''` or
//      `{ mine: opts.mine }` fallback produces. The route answers 400, not "the
//      whole board", so the Discover read would break too.
//
// Neither is observable from a component test: those drive the app through a fake
// whose list route answers from its own state, so a board that renders correctly
// says nothing about the string that asked for it. This reads the recorded
// `URLSearchParams` instead.
//
// 🔴 ABSENCE IS ASSERTED AS ABSENCE. `toEqual` semantics make
// `{ limit: 51, mine: undefined }` EQUAL to `{ limit: 51 }`, so an expectation
// written as `mine: undefined` passes against an adapter that never forwards
// `mine` at all — it proves nothing. Every claim here is `searchParams.has()` or
// the raw URL, which cannot be satisfied that way.
//
// 🔴 WHAT THIS IS NOT. The server is `src/platform/testing.tsx`'s fake, so these
// are claims about the string this app SENDS and about that fake's reading of the
// route's schema. Nothing here has run against civitai.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __configurePlatform } from './client.js';
import { createSharedStorage } from './sharedStorage.js';
import { createFakeCivitai, SITE_URL, type FakeCivitai } from './testing.js';
import type { GeneratorData } from '../types.js';

const ME = 99;
const SOMEONE_ELSE = 7;

function gen(title: string) {
  return { title, body: 'a desc', data: { v: 1, buttons: [] } as unknown as GeneratorData };
}

let fake: FakeCivitai;

/** Three of the viewer's rows interleaved with four of someone else's. */
function install(viewer: { id: number } | null) {
  fake = createFakeCivitai({
    viewer: viewer ? { id: viewer.id, username: 'me' } : null,
    shared: {
      seed: [
        { key: 'k1', authorUserId: SOMEONE_ELSE, value: gen('Theirs 1') },
        { key: 'k2', authorUserId: ME, value: gen('Mine 1') },
        { key: 'k3', authorUserId: SOMEONE_ELSE, value: gen('Theirs 2') },
        { key: 'k4', authorUserId: ME, value: gen('Mine 2') },
        { key: 'k5', authorUserId: SOMEONE_ELSE, value: gen('Theirs 3') },
        { key: 'k6', authorUserId: ME, value: gen('Mine 3') },
        { key: 'k7', authorUserId: SOMEONE_ELSE, value: gen('Theirs 4') },
      ],
    },
  });
  __configurePlatform({ transport: fake.transport, fetch: fake.fetch, siteUrl: SITE_URL });
}

beforeEach(() => install({ id: ME }));

afterEach(() => {
  __configurePlatform({});
});

/** The one `list` call's recorded query. Fails loudly if a different count ran. */
function listQuery(index = 0): URLSearchParams {
  const listCalls = fake.calls.filter((c) => c.path === 'blocks/shared-storage/list');
  expect(listCalls.length).toBeGreaterThan(index);
  return listCalls[index].query;
}

describe('the `mine` parameter on the wire', () => {
  it('renders a boolean TRUE as the literal string the route accepts', async () => {
    await createSharedStorage().list({ mine: true, limit: 51 });
    const q = listQuery();
    expect(q.get('mine')).toBe('true');
    // Not `?mine=1`, `?mine=True` or `?mine`: the union names two strings and
    // nothing else, and an unrecognised value 400s rather than defaulting.
    expect(q.getAll('mine')).toEqual(['true']);
    expect(q.get('limit')).toBe('51');
  });

  /**
   * `mine: false` is not a shape this app sends today, and it is pinned anyway:
   * it is the other half of the literal union, and it is the value that would
   * break first under `z.coerce.boolean()` — which reads the STRING "false" as
   * true. Pinning it makes the serialisation claim symmetric rather than a
   * statement about the one value we happen to use.
   */
  it('renders a boolean FALSE as "false", never as an empty or dropped key', async () => {
    await createSharedStorage().list({ mine: false, limit: 51 });
    const q = listQuery();
    expect(q.get('mine')).toBe('false');
    expect(q.has('mine')).toBe(true);
  });

  it('🔴 OMITS THE KEY ENTIRELY when `mine` is not passed', async () => {
    await createSharedStorage().list({ limit: 51 });
    const q = listQuery();
    // 🔴 KEY PRESENCE, not value equality. `?mine=` would satisfy any assertion
    // written as `mine: undefined` and is a 400 at the route.
    expect(q.has('mine')).toBe(false);
    expect(q.toString()).toBe('limit=51');
    expect(q.toString()).not.toContain('mine');
  });

  it('🔴 OMITS THE KEY on a bare `list()` with no options at all', async () => {
    await createSharedStorage().list();
    const q = listQuery();
    expect(q.has('mine')).toBe(false);
    // Every other optional is conditionally spread the same way, so a no-arg read
    // sends an EMPTY query. That is the state the route's `.default()` values
    // exist for, and it is the Discover read's shape minus its limit.
    expect(q.toString()).toBe('');
  });

  /**
   * POSITIVE CONTROL FOR THE INSTRUMENT. Every `has('mine') === false` above is
   * indistinguishable from a recorder wired to nothing, so this shows the same
   * recorder DOES report a `mine` key when one is sent — and the first case shows
   * the value it reports. Without this pair a zero is a claim about the harness.
   */
  it('the recorder observes the key when it is sent, and not when it is not', async () => {
    const shared = createSharedStorage();
    await shared.list({ limit: 51 });
    await shared.list({ mine: true, limit: 51 });
    expect(listQuery(0).has('mine')).toBe(false);
    expect(listQuery(1).has('mine')).toBe(true);
  });

  /**
   * NEGATIVE CONTROL FOR THE FAKE'S ROUTE. `?mine=` is the production hazard, and
   * every case above would read identically if the fake simply tolerated it. Fed
   * directly — the adapter cannot construct this string, which is the point — the
   * fake answers 400, as the route's literal union does. So an adapter that ever
   * started sending `?mine=` would FAIL the suite rather than pass it.
   */
  it('the fake route 400s on `?mine=`, exactly as the literal union does', async () => {
    const res = await fake.fetch(`${SITE_URL}/blocks/shared-storage/list?mine=`);
    expect(res.status).toBe(400);
    // ...and on a plausible-looking wrong spelling.
    expect((await fake.fetch(`${SITE_URL}/blocks/shared-storage/list?mine=1`)).status).toBe(400);
    // CONTROL: the two accepted values are accepted, so the 400s above are
    // attributable to the VALUE and not to the route being broken.
    expect((await fake.fetch(`${SITE_URL}/blocks/shared-storage/list?mine=true`)).status).toBe(200);
    expect((await fake.fetch(`${SITE_URL}/blocks/shared-storage/list?mine=false`)).status).toBe(200);
  });
});

describe('what `mine=true` comes back with', () => {
  it('narrows the page to the viewer’s own rows, out of the whole store', async () => {
    const res = await createSharedStorage().list({ mine: true, limit: 51 });
    expect(res.items.map((i) => i.key)).toEqual(['k6', 'k4', 'k2']);
    expect(res.items.every((i) => i.authorUserId === ME)).toBe(true);
  });

  it('a read WITHOUT it still returns the whole board — the two differ', async () => {
    const res = await createSharedStorage().list({ limit: 51 });
    expect(res.items).toHaveLength(7);
    expect(res.items.some((i) => i.authorUserId === SOMEONE_ELSE)).toBe(true);
  });

  /**
   * 🔴 THE ANON ANSWER IS AN EMPTY PAGE, NOT AN ERROR AND NOT THE WHOLE BOARD —
   * and it is that third possibility that makes this worth a test. Server-side it
   * falls out of three-valued logic rather than a guard: `s.author_user_id =
   * $4::int` is UNKNOWN for a NULL subject. A refactor to
   * `COALESCE($4, s.author_user_id)` would hand an anonymous caller the ENTIRE
   * board under a "my rows" flag.
   *
   * This pins the row count the app would see. It is NOT evidence about the SQL —
   * civitai's own `apps-shared.router.test.ts` pins that shape, because against an
   * empty fixture the two implementations are indistinguishable. `App` never makes
   * this request for an anonymous viewer anyway (an empty page cannot be told apart
   * from an empty store), which is asserted in `Browse.ranking.test.tsx`.
   */
  it('an ANONYMOUS viewer asking for `mine` gets an empty page, not the board', async () => {
    install(null);
    const res = await createSharedStorage().list({ mine: true, limit: 51 });
    expect(res.items).toEqual([]);
    // CONTROL: the same anonymous token reads the full board without the flag, so
    // the emptiness above is the FILTER and not a refused read.
    const board = await createSharedStorage().list({ limit: 51 });
    expect(board.items).toHaveLength(7);
  });
});
