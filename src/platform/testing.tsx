// The local stand-in for `@civitai/blocks-react/testing`.
//
// 🔴 WHY THIS REPLACED THE SDK MOCK HOST, AND WHY IT SITS SOMEWHERE ELSE. The old
// harness played a mock HOST and answered the app's `SHARED_*`, `GET_IMAGES_BY_IDS`
// and `*_WORKFLOW` postMessage ops. After the port the app does not SEND those
// messages — it makes REST calls — so a mock host would be answering a
// conversation nobody is having any more, and every suite would pass while
// exercising nothing. So the fake sits where the real boundary now is: **`fetch`
// for data, and a scripted transport for host UI only.**
//
// What stays REAL under test: the whole app, every hook in `./hooks`, and the
// whole of `./sharedStorage`, `./workflows`, `./images`, `./resources`, `./buzz`
// and `./appStorage` — including their URL construction, query parameters, date
// revival, batching and error classification. Only the server is fake.
//
// 🔴 THE DOCUMENT STORE (`blocks/storage/*`) IS ANSWERED BY THE SDK'S OWN CONTRACT
// FAKE, `createFakeStorage`, over this repo's `block.manifest.json` — not
// re-implemented here. It enforces the declarations, scopes and consent, `own`
// (`not_author`), marks and `viewer.marks`, the trust gate, key rules, the list
// `limit` ceiling and exact cursors, depth/size/quota limits, moderation and (opt
// in) rate limits; the SDK runs the platform's storage contract against it. This
// file only converts `fetch` to its `Http` seam, maps numeric test viewer ids onto
// its viewers, and sends each request with the scopes on the CURRENT token — so a
// token without `apps:storage:publish` is refused `consent_required` exactly as
// the real store refuses it, and a consent grant (`grantConsent`) that refreshes
// the token is what lets the next write through.
//
// 🔴 A FAKE PASSING IS EVIDENCE ABOUT THE FAKE. These suites prove the app is
// internally consistent with this file's reading of the REST contract. They are
// NOT evidence that civitai's routes behave as their docblocks say. Nothing here
// has been run against a live server.
//
// `@civitai/sdk/testing` supplies `createFakeTransport` and `__resetTransport` —
// and nothing else. There is no `Harness`, no `createMockHost`, no
// `MockSharedSeed`; those three are built here.

import { useRef } from 'react';
import type { ReactNode } from 'react';

import { createFakeStorage, createFakeTransport, __resetTransport } from '@civitai/sdk/testing';
import type { FakeStorage, FakeStorageOptions, FakeStorageViewer, FakeTransport } from '@civitai/sdk/testing';
import { ApiError, getTransport } from '@civitai/sdk';
import type { BlockTransport } from '@civitai/sdk';
import type {
  BlockCreatePostResult,
  BlockGatedImage,
  BlockPickedImageInfo,
  BlockResourceInfo,
  BlockResourcePickerType,
  BlockGenerationSourceImageInfo,
  BlockWorkflowSnapshot,
  SharedStorageValue,
} from '@civitai/app-sdk/blocks';

import blockManifest from '../../block.manifest.json';
import { __configurePlatform } from './client.js';
import { KV_COLLECTION, RECORDS_COLLECTION } from './docStore.js';
import { toSharedListItem, VOTE_MARK, type RecordDocument } from './sharedStorage.js';
import type { SharedListItem } from './types.js';

export { __resetTransport };

/** The site base the fake serves. Any other host is a miss, loudly. */
export const SITE_URL = 'https://civitai.test/api/v1';

/**
 * One seeded shared row.
 *
 * 🔴 `key` IS NEW RELATIVE TO THE BRIDGE'S VERSION, AND IT MATTERS. Use it
 * whenever a test refers to a row by key. The old suite hardcoded keys like
 * `shared_2`, which was the mock host's minting convention and nothing the real
 * server ever produces — it would have gone on passing while describing something
 * untrue. Real keys are server-minted ULIDs.
 */
export interface MockSharedSeed {
  value: SharedStorageValue;
  authorUserId?: number;
  /** User ids that have up-voted this row. Drives `count` and `viewerVoted`. */
  voters?: number[];
  /** Pin the row's key so a test can name it. */
  key?: string;
}

export interface MockGenerationScenario {
  costPerGen?: number;
  latencyMs?: number;
  images?: string[];
  /** Fail the estimate: a non-2xx (`'failed'`) or a priceless 200 (`'no-cost'`). */
  failEstimate?: 'failed' | 'no-cost';
  /** Resolve submit with a priced refusal snapshot — the recoverable top-up path. */
  insufficient?: boolean;
  /** Polls returning non-terminal before the workflow completes. */
  pollsUntilDone?: number;
}

export interface FakeCivitaiOptions {
  /** `null` is an anonymous viewer: reads work, writes are refused. */
  viewer?: { id: number; username?: string | null } | null;
  theme?: 'light' | 'dark';
  /**
   * Accepted for call-site compatibility and INERT, deliberately.
   *
   * 🔴 CONSENT IS NO LONGER A HOST HANDSHAKE FLAG. On the bridge the mock host
   * gated every workflow op behind a consent latch it held. Under `@civitai/sdk`
   * consent is `app.requestGrants`, and what the app actually gates on is the
   * SCOPES on its token — so `scopes` is the knob that means anything now. A test
   * wanting the ungranted state passes `scopes: []`, not `consentGranted: false`.
   * Kept as a prop so 11 existing call sites did not have to churn in a transport
   * diff; it is listed here rather than silently swallowed so nobody reads it as
   * load-bearing.
   */
  consentGranted?: boolean;
  /** Scopes on the block token. Defaults to this app's manifest set. */
  scopes?: string[];
  buzzBudget?: number;
  buzz?: { balance?: number };
  buzzBalance?: { blue: number; green: number; yellow: number };
  generation?: MockGenerationScenario;
  shared?: { seed?: MockSharedSeed[] };
  cannedPicks?: Partial<Record<BlockResourcePickerType, BlockResourceInfo | null>>;
  cannedImageUpload?: { imageId: number; url: string } | null;
  /**
   * The viewer's library behind `OPEN_IMAGE_PICKER`. Like the host, the fake
   * keeps only the images matching the request's `sources` and answers with the
   * first one, or with no `selected` key (`{}`, a dismissal) when none match or
   * this is unset. 🔴 It does NOT model the host's eligibility rules (published post,
   * scanned, rated) — a test that needs an ineligible image to be offered says
   * so by putting one here.
   *
   * The ONE eligibility rule it does model is civitai#6134's `publicOnly`: an
   * entry with `privatePost: true` (a posted image whose post is Private) is not
   * offered when the request carries `publicOnly: true`. The marker is fake-only
   * and never reaches the app — the host rebuilds each pick field by field
   * (`toWirePick`), so the fake strips it too.
   */
  cannedImagePicks?: (BlockPickedImageInfo & { privatePost?: boolean })[];
  /** Refuse `OPEN_IMAGE_PICKER` with this host error instead. */
  imagePickerError?: string;
  cannedGenerationSourceUpload?: BlockGenerationSourceImageInfo | null;
  /** Bare strings are the bridge's spelling; the object form carries a reason. */
  cannedImageScan?:
    | 'scanned'
    | 'error'
    | { status: 'scanned' }
    | { status: 'blocked'; reason?: string }
    | { status: 'error'; message?: string };
  gatedImages?: BlockGatedImage[];
  gatedImagesError?: boolean | string;
  /**
   * Answer `blocks/gated-images` with the Next.js HTML 404 a route miss really
   * returns — the PRODUCTION STATE of that route as of 2026-09-24, filed as
   * `civitai/civitai#5112`.
   *
   * 🔴 DISTINCT FROM {@link FakeCivitaiOptions.gatedImagesError}, WHICH IS A JSON
   * 500, AND THE DIFFERENCE IS THE POINT. A 500 carries `{ message }`, so the
   * SDK's http layer builds an `ApiError` whose `.message` is the server's own
   * sentence. A 404 HTML page is not JSON, so `messageOf()` returns undefined and
   * `.message` falls back to `statusText` while `.body` holds the raw markup — a
   * different object reaching the app's catch blocks, with untrusted HTML in it.
   * Both throw; only this one is what the app will actually meet in production
   * until #5112 is deployed.
   */
  gatedImagesNotFound?: boolean;
  publishImageIds?: number[];
  publishError?: boolean | string;
  createPostResult?: BlockCreatePostResult;
  createPostError?: string;
  /**
   * Never answer `CREATE_POST_FROM_APP`, so the request reaches its own deadline.
   *
   * 🔴 THIS REPLACED A REAL DROPPED FRAME, AND THE SUBSTITUTION IS A REDUCTION IN
   * WHAT IS PROVEN. The suites that use it previously patched
   * `window.parent.postMessage` to swallow the one outbound frame, which
   * genuinely exercised `IframeTransport`'s correlation and deadline. The fake
   * transport is an in-memory object and posts nothing, so there is no frame to
   * drop — this flag asks it to stay silent instead. What still holds: the app's
   * own timeout handling, its banner, and the guarantee that no SDK-internal
   * string reaches the viewer. What no longer holds: any claim about the real
   * transport's behaviour under a lost reply.
   */
  createPostNoReply?: boolean;
  /**
   * HOLD the `CREATE_POST_FROM_APP` reply until {@link releaseHeldCreatePost} is
   * called, so a test can assert the in-flight state and then let the host answer
   * late. Same substitution — and same reduction in what is proven — as
   * {@link FakeCivitaiOptions.createPostNoReply}.
   */
  createPostHold?: boolean;
  /**
   * Seeded per-viewer app storage: legacy-shaped `key → value`, written into the
   * private `kv` collection as `{ value }` — exactly what the go-live copy writes.
   */
  storage?: { seed?: Record<string, unknown> };
  /** Passed to `createFakeStorage`: rate limits, clock, moderation, consent state. */
  docStore?: Pick<FakeStorageOptions, 'enforceRateLimits' | 'now' | 'moderate' | 'consent' | 'disabled'> & {
    /** The viewer fails the store's minimum-trust gate on shared writes and marks. */
    untrustedReason?: string;
  };
  /**
   * How the fake host answers `REQUEST_CONSENT`: `'grant'` refreshes the token
   * with the requested scopes added (the real host's re-mint), `'unavailable'`
   * pushes `CONSENT_UNAVAILABLE` (so `requestGrants` resolves `false` at once),
   * and `'ignore'` (the default) answers nothing — a dismissed dialog, which only
   * the caller's own timeout ends.
   */
  grantConsent?: 'grant' | 'unavailable' | 'ignore';
  /**
   * The host route the block is opened at: `PageSlotContext.subPath` in the init
   * context. Defaults to `''` (the app root). A LATER route change is a
   * `ROUTE_CHANGED` push; deliver it with {@link pushFromHost}.
   */
  subPath?: string;
  /** Observe every outbound bridge message (requests AND notifications). */
  onOutbound?: (message: { type: string; payload: unknown }) => void;
  /**
   * The App Store sub-listing routes this app calls (`blocks/sub-listings/{upsert,mine}`).
   *
   * `seed` rows belong to the viewer unless `authorUserId` says otherwise. `fail`
   * answers one route with a fixed status instead: a JSON `{ error, code }` body
   * (the server's `subListingErrorResponse` shape), or with `html: true` the
   * Next.js HTML 404 a route miss returns.
   *
   * 🔴 The fake enforces the parts of the contract this app can get WRONG — the
   * `.strict()` body (an unknown key is a 400), the title/tagline/subPath bounds,
   * the item existing and being the viewer's — and none of the parts it cannot
   * observe (text safety, rate limits, moderation). A test that needs one of those
   * scripts it with `fail`.
   *
   * 🔴 "THE ITEM EXISTING" MEANS IN THE DOCUMENT STORE, as the server resolves it
   * for an app whose manifest declares a shared collection (civitai/civitai#6120): the
   * legacy store is never read. Likewise, an author's delete of a `records`
   * document withdraws that author's card here, as that server change does.
   */
  subListings?: {
    seed?: { itemKey: string; status: 'pending' | 'approved' | 'hidden' | 'withdrawn'; authorUserId?: number }[];
    /**
     * The images an anonymous viewer may see, with their uploader. An upsert's
     * `imageId` outside this list is the server's 400 `image_not_public`; one
     * uploaded by someone else is 403 `image_not_yours` (the server checks in
     * that order).
     */
    publicImages?: { imageId: number; userId: number }[];
    fail?: Partial<
      Record<'upsert' | 'mine', { status: number; code?: string; html?: boolean }>
    >;
  };
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  query: URLSearchParams;
}

export interface FakeCivitai {
  transport: BlockTransport;
  fetch: typeof fetch;
  /** The fake server's shared rows (newest key first), as the default viewer reads them. */
  rows: () => Promise<SharedListItem[]>;
  /** The SDK contract fake behind `blocks/storage/*`, for asserting stored documents. */
  docStore: FakeStorage;
  /** Every REST call the app made, in order. */
  calls: RecordedCall[];
  /** The fake server's App Store sub-listing rows, keyed by item key. */
  subListings: () => Map<
    string,
    { status: string; title: string; subPath: string; tagline: string | null; imageId: number | null }
  >;
}

/**
 * The token's scopes by default: everything the manifest declares except the App
 * Store scope (minted by no dev, tunnel or review token), with BOTH consent-gated
 * scopes already granted — the state of a returning viewer. A test about the
 * consent flow passes its own `scopes` without `apps:storage:publish`.
 */
export const DEFAULT_SCOPES = [
  'ai:write:budgeted',
  'buzz:read:self',
  'apps:storage',
  'apps:storage:publish',
  'posts:write:self',
];

/** A numeric test viewer id → the SDK fake's viewer. */
function docViewer(id: number, untrustedReason?: string): FakeStorageViewer {
  return {
    username: `user${id}`,
    id,
    ...(untrustedReason !== undefined ? { trusted: false, untrustedReason } : {}),
  };
}

/**
 * The reply a `createPostHold` fake is sitting on.
 *
 * Module-scoped because the tests that use it hold the frame from OUTSIDE the
 * render tree and release it from a later `act()`. One at a time is sufficient:
 * no suite holds two posts at once, and `__configurePlatform` in `beforeEach`
 * clears it.
 */
let heldCreatePost: (() => void) | null = null;

/** Deliver a reply held by `createPostHold`. Returns `false` if nothing was held. */
export function releaseHeldCreatePost(): boolean {
  const held = heldCreatePost;
  if (!held) return false;
  heldCreatePost = null;
  held();
  return true;
}

let ulidCounter = 0;
/** Monotonic, lexicographically increasing — the property `list`'s sort relies on. */
function mintKey(): string {
  ulidCounter += 1;
  return `01J${String(ulidCounter).padStart(23, '0')}`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * An unknown route answers an HTML 404, not a JSON one.
 *
 * Spelled as HTML on purpose — it is what a Next.js route miss actually returns in
 * production, and a JSON 404 here would make the fake kinder than the thing it
 * stands in for.
 *
 * 🔴 `statusText` IS SET DELIBERATELY, AND OMITTING IT MADE A TEST UNKILLABLE. Per
 * Fetch, `new Response(body, { status: 404 })` defaults `statusText` to the EMPTY
 * string — it is not derived from the status code. `@civitai/sdk` throws
 * `ApiError(status, response.statusText, body)`, so without this line every 404 the
 * fake produced carried `.message === ''`, and
 * `gatedImages.notFound.test.tsx`'s `expect(text).not.toContain('Not Found')` could
 * never fail however carelessly the app rendered `.message`. A real Next.js 404 does
 * send `Not Found`, so this makes the fake match it AND gives that assertion a truthy
 * string to actually be tested against.
 */
function notFound(path: string): Response {
  return new Response(`<!DOCTYPE html><h1>404</h1><p>${path}</p>`, {
    status: 404,
    statusText: 'Not Found',
    headers: { 'content-type': 'text/html' },
  });
}

export function createFakeCivitai(options: FakeCivitaiOptions = {}): FakeCivitai {
  const viewer = options.viewer === undefined ? { id: 99, username: 'me' } : options.viewer;
  const viewerId = viewer?.id ?? null;
  const gen = options.generation ?? {};
  const calls: RecordedCall[] = [];

  // ---- server state -------------------------------------------------------
  // The document store: the SDK's contract fake over this repo's manifest.
  //
  // 🔴 SEEDS ARE FIXTURE, NOT TRAFFIC. Written as each seed's own author with a
  // full, consented token before the first request is answered, and — with rate
  // limits on — on a clock that jumps a full window per reading, so seeding never
  // spends the windows the app's requests are measured against.
  let seeding = true;
  let seedClock = 0;
  const callerNow = options.docStore?.now;
  const realNow = callerNow ?? Date.now;
  const docStore: FakeStorage = createFakeStorage({
    manifest: blockManifest as FakeStorageOptions['manifest'],
    viewer: viewerId == null ? null : docViewer(viewerId, options.docStore?.untrustedReason),
    ...(options.docStore?.enforceRateLimits !== undefined ? { enforceRateLimits: options.docStore.enforceRateLimits } : {}),
    ...(options.docStore?.moderate ? { moderate: options.docStore.moderate } : {}),
    ...(options.docStore?.consent ? { consent: options.docStore.consent } : {}),
    ...(options.docStore?.disabled ? { disabled: options.docStore.disabled } : {}),
    ...(options.docStore?.enforceRateLimits || callerNow
      ? { now: () => (seeding ? (seedClock += 61_000) : realNow()) }
      : {}),
  });
  const seedAuthor = viewerId ?? 1;
  const seeded = (async () => {
    const asSeed = docStore.as({ viewer: docViewer(seedAuthor), scopes: blockManifest.scopes });
    for (const [k, v] of Object.entries(options.storage?.seed ?? {})) {
      await asSeed.storage.collection(KV_COLLECTION).put(k, { value: v });
    }
    for (const seed of options.shared?.seed ?? []) {
      const key = seed.key ?? mintKey();
      const author = seed.authorUserId ?? seedAuthor;
      await docStore
        .as({ viewer: docViewer(author), scopes: blockManifest.scopes })
        .storage.collection<RecordDocument>(RECORDS_COLLECTION)
        .put(key, seed.value as RecordDocument);
      for (const voter of seed.voters ?? []) {
        await docStore
          .as({ viewer: docViewer(voter), scopes: blockManifest.scopes })
          .storage.collection(RECORDS_COLLECTION)
          .mark(key, VOTE_MARK);
      }
    }
  })().finally(() => {
    seeding = false;
  });

  const subListings = new Map<
    string,
    {
      status: string;
      title: string;
      subPath: string;
      tagline: string | null;
      imageId: number | null;
      authorUserId: number;
      /** The server's `pendingSubmittedAt != null`: an edit to an approved item awaits review. */
      pendingEdit: boolean;
    }
  >();
  for (const s of options.subListings?.seed ?? []) {
    subListings.set(s.itemKey, {
      status: s.status,
      title: s.itemKey,
      subPath: `g/${s.itemKey}`,
      tagline: null,
      imageId: null,
      authorUserId: s.authorUserId ?? viewerId ?? 1,
      pendingEdit: false,
    });
  }
  const workflows = new Map<string, { snapshot: BlockWorkflowSnapshot; pollsLeft: number }>();
  let workflowCounter = 0;

  /** The current token's scopes — what every store request is made with. */
  const tokenScopes = (): readonly string[] => fake.snapshot.get().token?.scopes ?? [];

  /** Every shared row, newest key first, as the default viewer reads them. */
  const rows = async (): Promise<SharedListItem[]> => {
    await seeded;
    const reader = docStore.as({ viewer: viewerId == null ? null : docViewer(viewerId), scopes: blockManifest.scopes });
    const out: SharedListItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await reader.storage
        .collection<RecordDocument>(RECORDS_COLLECTION)
        .list({ sort: '-key', limit: 100, ...(cursor ? { cursor } : {}) });
      for (const d of page.items) out.push(toSharedListItem(d, viewerId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return out;
  };

  /**
   * Who wrote a shared item, for the sub-listing author check: the viewer, someone
   * else (-1), or nobody (`null`) — from the DOCUMENT STORE only, as civitai
   * resolves it (civitai/civitai#6120 and #6296): every ITEM collection the
   * manifest declares (shared, viewer-authored: `own`/`anyone`) is probed, a
   * `write: "none"` one (`generator_marks`) never is, and a key found in two item
   * collections names no item.
   */
  const declared: Record<string, { visibility: string; write?: string }> =
    blockManifest.storage?.collections ?? {};
  const itemCollections = Object.entries(declared)
    .filter(([, c]) => c.visibility === 'shared' && (c.write === 'own' || c.write === 'anyone'))
    .map(([name]) => name);
  const itemAuthor = async (key: string): Promise<number | null> => {
    if (viewerId == null) return null;
    const reader = docStore.as({ viewer: docViewer(viewerId), scopes: blockManifest.scopes });
    const found = [];
    for (const name of itemCollections) {
      const doc = await reader.storage.collection(name).get(key);
      if (doc) found.push(doc);
    }
    if (found.length !== 1) return null;
    const doc = found[0]!;
    return doc.author.kind === 'user' && doc.author.isViewer ? viewerId : -1;
  };

  const cost = gen.costPerGen ?? 12;

  // ---- the fake fetch -----------------------------------------------------
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^.*\/api\/v1\//, '');
    const q = url.searchParams;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body, query: q });

    // ---- the document store: blocks/storage/*
    if (path === 'blocks/storage' || path.startsWith('blocks/storage/')) {
      await seeded;
      const query: Record<string, string | string[]> = {};
      for (const name of new Set(q.keys())) {
        const all = q.getAll(name);
        query[name] = all.length === 1 ? (all[0] as string) : all;
      }
      try {
        const reply = await docStore
          .as({ viewer: viewerId == null ? null : docViewer(viewerId, options.docStore?.untrustedReason), scopes: tokenScopes() })
          .http<unknown>(method, path, { query, ...(body !== undefined ? { body } : {}) });
        // The author's delete of a shared document withdraws THEIR store card,
        // server-side (civitai/civitai#6120).
        const recordKey = /^blocks\/storage\/records\/([^/]+)$/.exec(path)?.[1];
        if (method === 'DELETE' && recordKey && (reply as { deleted?: boolean } | null)?.deleted) {
          const card = subListings.get(decodeURIComponent(recordKey));
          if (card && card.authorUserId === viewerId && (card.status === 'pending' || card.status === 'approved')) {
            card.status = 'withdrawn';
          }
        }
        return json(200, reply ?? {});
      } catch (err) {
        if (err instanceof ApiError) {
          const res = json(err.status, err.body);
          const retryAfter = (err.body as { details?: { retryAfter?: unknown } } | null)?.details?.retryAfter;
          if (typeof retryAfter === 'number') res.headers.set('Retry-After', String(retryAfter));
          return res;
        }
        throw err;
      }
    }

    // ---- images / resources / buzz
    if (path === 'blocks/gated-images') {
      // The route is UNDEPLOYED in production (#5112) — a miss, before any
      // auth/scope/param handling, exactly as Next.js orders it.
      if (options.gatedImagesNotFound) return notFound(path);
      if (options.gatedImagesError) {
        return json(500, {
          message: typeof options.gatedImagesError === 'string' ? options.gatedImagesError : 'gated image read failed',
        });
      }
      if (viewerId == null) return json(401, { message: 'anonymous viewers may not read gated images' });
      const ids = (q.get('ids') ?? '').split(',').map(Number).filter(Number.isFinite);
      if (ids.length > 100) return json(400, { error: 'Invalid query parameters' });
      const supplied = options.gatedImages ?? [];
      // Request order, misses omitted — the route's documented contract.
      const out = ids
        .map((id) => supplied.find((i) => i.imageId === id))
        .filter((i): i is BlockGatedImage => !!i);
      return json(200, { images: out });
    }
    if (path === 'blocks/generation-resources') {
      const ids = (q.get('ids') ?? '').split(',').map(Number).filter(Number.isFinite);
      if (ids.length > 30) return json(400, { error: 'at most 30 ids' });
      const picks = Object.values(options.cannedPicks ?? {}).filter(
        (p): p is BlockResourceInfo => !!p,
      );
      return json(200, {
        items: ids
          .map((id) => picks.find((p) => p.versionId === id))
          .filter((p): p is BlockResourceInfo => !!p),
        maturity: { browsingLevel: 1, sfwOnly: true },
      });
    }
    if (path === 'blocks/buzz') {
      if (viewerId == null) return json(403, { error: 'Anonymous block tokens may not read a balance' });
      const b = options.buzzBalance ?? {
        blue: options.buzz?.balance ?? 5000,
        green: 0,
        yellow: 0,
      };
      return json(200, { blue: b.blue, green: b.green, yellow: b.yellow });
    }

    // ---- workflows
    if (path === 'blocks/workflows/estimate') {
      if (gen.failEstimate === 'failed')
        return json(403, { message: 'not available in review preview' });
      if (gen.failEstimate === 'no-cost')
        return json(200, { snapshot: { workflowId: 'wf_estimate', status: 'pending' } });
      return json(200, {
        snapshot: { workflowId: 'wf_estimate', status: 'pending', cost: { total: cost } },
      });
    }
    if (path === 'blocks/workflows/submit') {
      // The route requires it; a fake that tolerated its absence would let a
      // submit missing the key pass here and 400 in production.
      if (typeof body?.idempotencyKey !== 'string' || body.idempotencyKey === '')
        return json(400, { error: 'Invalid request body' });
      if (gen.insufficient) {
        // 🔴 A 200 CARRYING A PRICED FAILURE — the recoverable top-up path, and the
        // one outcome a 4xx here would destroy.
        return json(200, {
          snapshot: {
            workflowId: 'failed',
            status: 'failed',
            cost: { total: cost },
            error: `insufficient buzz budget: estimate ${cost} exceeds budget 1`,
          },
        });
      }
      workflowCounter += 1;
      const id = `${viewerId ?? 0}-${workflowCounter}`;
      const pollsLeft = gen.pollsUntilDone ?? 0;
      workflows.set(id, {
        pollsLeft,
        snapshot: {
          workflowId: id,
          status: 'succeeded',
          cost: { total: cost },
          imageUrls: gen.images ?? ['https://image.civitai.com/demo/out.jpeg'],
        },
      });
      return json(200, {
        snapshot:
          pollsLeft > 0
            ? { workflowId: id, status: 'processing', cost: { total: cost } }
            : workflows.get(id)!.snapshot,
      });
    }
    if (path === 'blocks/workflows/poll') {
      const id = String(body?.workflowId);
      const entry = workflows.get(id);
      if (!entry) return json(403, { message: 'workflow not minted for this viewer' });
      if (entry.pollsLeft > 0) {
        entry.pollsLeft -= 1;
        return json(200, {
          snapshot: { workflowId: id, status: 'processing', cost: { total: cost } },
        });
      }
      return json(200, { snapshot: entry.snapshot });
    }
    if (path === 'blocks/workflows/cancel') {
      const id = String(body?.workflowId);
      return json(200, { snapshot: { workflowId: id, status: 'canceled' } });
    }

    // ---- App Store sub-listings (civitai `src/pages/api/v1/blocks/sub-listings/*`)
    if (path.startsWith('blocks/sub-listings/')) {
      const op = path.slice('blocks/sub-listings/'.length) as 'upsert' | 'mine';
      const fail = options.subListings?.fail?.[op];
      if (fail) {
        if (fail.html) return notFound(path);
        return json(fail.status, { error: `scripted ${fail.status}`, code: fail.code ?? 'scripted' });
      }
      // Every :self-style store scope needs a signed-in subject (block-scope middleware).
      if (viewerId == null) return json(403, { error: 'apps:store:items:write requires authenticated subject' });
      if (op === 'mine' && method === 'GET') {
        const items = [...subListings.entries()]
          .filter(([, r]) => r.authorUserId === viewerId)
          .map(([itemKey, r]) => ({
            id: `asl_${itemKey}`,
            itemKey,
            status: r.status,
            title: r.title,
            pendingEdit: r.pendingEdit,
            statusReason: null,
            editRejectionReason: null,
            updatedAt: '2026-01-02T00:00:00.000Z',
          }));
        return json(200, { items });
      }
      if (op === 'upsert' && method === 'POST') {
        const allowed = new Set(['itemKey', 'title', 'tagline', 'imageId', 'subPath', 'contentRating']);
        const b = (body ?? {}) as Record<string, unknown>;
        const bad =
          Object.keys(b).some((k) => !allowed.has(k)) ||
          typeof b.itemKey !== 'string' ||
          typeof b.title !== 'string' ||
          b.title.length < 1 ||
          b.title.length > 80 ||
          (b.tagline != null && (typeof b.tagline !== 'string' || b.tagline.length > 140)) ||
          (b.imageId != null &&
            (typeof b.imageId !== 'number' || !Number.isInteger(b.imageId) || b.imageId <= 0)) ||
          typeof b.subPath !== 'string' ||
          !/^[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_-]{1,64}){0,3}$/.test(b.subPath);
        if (bad) return json(400, { error: 'Invalid request body', code: 'invalid_body' });
        await seeded;
        const author = await itemAuthor(b.itemKey as string);
        if (author === null) return json(404, { error: 'Item not found', code: 'item_not_found' });
        if (author !== viewerId) {
          return json(403, { error: 'Only the item author can publish it', code: 'not_your_item' });
        }
        if (b.imageId != null) {
          const img = (options.subListings?.publicImages ?? []).find((i) => i.imageId === b.imageId);
          if (!img) {
            return json(400, {
              error: 'The image must be public: in a published post and reviewed',
              code: 'image_not_public',
            });
          }
          if (img.userId !== viewerId) {
            return json(403, { error: 'The image must be one you uploaded', code: 'image_not_yours' });
          }
        }
        const existing = subListings.get(b.itemKey as string);
        if (existing?.status === 'hidden') {
          return json(200, { id: `asl_${b.itemKey}`, status: 'hidden', pendingEdit: false });
        }
        // The server stores `body.imageId ?? null` (and the same for tagline): an absent key
        // clears it. Upsert REPLACES the item.
        const content = {
          title: b.title as string,
          subPath: b.subPath as string,
          tagline: (b.tagline as string | undefined) ?? null,
          imageId: (b.imageId as number | undefined) ?? null,
        };
        if (existing?.status === 'approved') {
          // As civitai's `writeSubListing`: an approved item keeps serving its live version. An
          // edit identical to it clears any staged edit (`pendingEdit: false`); anything else is
          // staged for a moderator (`pendingEdit: true`) and the live columns are NOT touched.
          const same =
            existing.title === content.title &&
            existing.subPath === content.subPath &&
            existing.tagline === content.tagline &&
            existing.imageId === content.imageId;
          existing.pendingEdit = !same;
          return json(200, { id: `asl_${b.itemKey}`, status: 'approved', pendingEdit: !same });
        }
        // New, pending or withdrawn: the live columns are the draft, and it waits for review.
        subListings.set(b.itemKey as string, {
          status: 'pending',
          ...content,
          authorUserId: viewerId,
          pendingEdit: false,
        });
        return json(200, { id: `asl_${b.itemKey}`, status: 'pending', pendingEdit: false });
      }
      return json(405, { error: 'Method not allowed' });
    }

    return notFound(path);
  };

  // ---- the scripted transport (host UI only) ------------------------------
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  const fake: FakeTransport = createFakeTransport({
    ready: true,
    hostOrigin: 'https://civitai.com',
    renderMode: 'iframe',
    viewer: viewer ? { id: viewer.id, username: viewer.username ?? null } : null,
    theme: options.theme ?? 'dark',
    token: {
      raw: 'fake-block-token',
      scopes: options.scopes ?? DEFAULT_SCOPES,
      expiresAt,
      buzzBudget: options.buzzBudget ?? 1000,
    },
    context: {
      slotId: 'app.page',
      slug: 'custom-generators',
      subPath: options.subPath ?? '',
      viewerUserId: viewerId,
      theme: options.theme ?? 'dark',
    },
  });

  // 🔴 A STANDING `REQUEST_TOKEN` ANSWER, OR THE SUITE HANGS. The SDK's http
  // client retries a 401 once with `getToken({ fresh: true })`, which sends
  // `REQUEST_TOKEN` over the bridge — and `createFakeTransport` leaves an
  // unanswered request pending FOREVER (it has no timeout). A test exercising an
  // auth failure would time out rather than fail.
  fake.handle('REQUEST_TOKEN', () => ({
    token: { token: 'fake-block-token-refreshed', expiresAt: expiresAt.toISOString() },
  }));

  fake.handle('OPEN_RESOURCE_PICKER', (params) => {
    const type = (params as { resourceType?: BlockResourcePickerType })?.resourceType;
    const pick = type ? options.cannedPicks?.[type] : null;
    return { selected: pick ?? null };
  });

  fake.handle('OPEN_IMAGE_UPLOAD', (params) => {
    const purpose = (params as { purpose?: string })?.purpose;
    if (purpose === 'generationSource') {
      return { selected: options.cannedGenerationSourceUpload ?? null };
    }
    const up = options.cannedImageUpload;
    if (!up) return { selected: null };
    // The display upload EARLY-RESOLVES with a pending handle; the verdict
    // arrives as a separate push, correlated by `imageId`.
    queueMicrotask(() => {
      const raw = options.cannedImageScan ?? 'scanned';
      const scan = typeof raw === 'string' ? { status: raw } : raw;
      fake.push('IMAGE_SCAN_RESOLVED', {
        imageId: up.imageId,
        result:
          scan.status === 'scanned'
            ? {
                status: 'scanned',
                image: { imageId: up.imageId, url: up.url, nsfwLevel: 1, contentRating: 'pg' },
              }
            : scan,
      });
    });
    return { selected: { status: 'pending', imageId: up.imageId, url: up.url } };
  });

  fake.handle('OPEN_IMAGE_PICKER', (params) => {
    if (options.imagePickerError !== undefined) throw new Error(options.imagePickerError);
    const req = (params ?? {}) as { sources?: string[]; publicOnly?: unknown };
    // civitai `resolveImagePickerRequest` (#6134): an absent `publicOnly` is
    // `false`, and anything present that is not a boolean is REFUSED with an
    // `error` — never coerced, never ignored.
    if (req.publicOnly !== undefined && typeof req.publicOnly !== 'boolean') {
      throw new Error('OPEN_IMAGE_PICKER: publicOnly must be a boolean.');
    }
    const publicOnly = req.publicOnly === true;
    const sources = req.sources ?? ['posted', 'generated'];
    // `publicOnly` narrows the POSTED source only (`postedPickableWhere`);
    // generated images are listed as before either way.
    const found = (options.cannedImagePicks ?? []).find(
      (p) => sources.includes(p.source) && !(publicOnly && p.source === 'posted' && p.privatePost),
    );
    // The real host answers a dismissal with no `selected` key at all
    // (civitai `buildImagePickerReply`), never `selected: null`.
    if (!found) return {};
    const { privatePost: _privatePost, ...selected } = found;
    return { selected };
  });

  fake.handle('PUBLISH_GENERATION_OUTPUTS', (params) => {
    if (options.publishError) {
      throw new Error(typeof options.publishError === 'string' ? options.publishError : 'publish failed');
    }
    const indexes = (params as { imageIndexes?: number[] })?.imageIndexes;
    const ids = options.publishImageIds ?? (indexes ?? [0]).map((i) => 900_000 + i);
    return { imageIds: ids };
  });

  fake.handle('OPEN_BUZZ_PURCHASE', () => ({ purchased: true }));

  /**
   * A thin decorator over the fake transport.
   *
   * 🔴 `CREATE_POST_FROM_APP` GOES OUT AS A NOTIFICATION, NOT A REQUEST, because
   * the SDK's reply-type derivation cannot name `CREATE_POST_RESULT` — see
   * `createPost.ts`. `createFakeTransport` records a notification but offers no
   * way to react to one, so the reply is pushed from here. `onOutbound` also
   * hangs off this, which is what lets a test observe BOTH requests and
   * notifications with one hook.
   */
  const transport: BlockTransport = {
    snapshot: fake.snapshot,
    on: (type, handler) => fake.on(type, handler),
    request: (type, params, opts) => {
      options.onOutbound?.({ type, payload: params });
      return fake.request(type, params, opts);
    },
    notify: (message) => {
      options.onOutbound?.({ type: message.type, payload: message.payload });
      fake.notify(message);
      if (message.type === 'REQUEST_CONSENT') {
        // The real host shows its dialog and, on approval, RE-MINTS the token with
        // the scopes added — which is the snapshot change `requestGrants` waits for.
        const asked = ((message.payload as { scopes?: string[] })?.scopes ?? []).filter(
          (x): x is string => typeof x === 'string',
        );
        if (options.grantConsent === 'grant') {
          queueMicrotask(() => {
            const current = fake.snapshot.get().token;
            fake.setSnapshot({
              token: { ...current, scopes: [...new Set([...(current?.scopes ?? []), ...asked])] },
            } as Parameters<FakeTransport['setSnapshot']>[0]);
          });
        } else if (options.grantConsent === 'unavailable') {
          queueMicrotask(() => fake.push('CONSENT_UNAVAILABLE', {}));
        }
        return;
      }
      if (message.type === 'CREATE_POST_FROM_APP') {
        const requestId = (message.payload as { requestId?: string })?.requestId;
        if (options.createPostNoReply) return;
        const deliver = () => {
          if (options.createPostError !== undefined) {
            fake.push('CREATE_POST_RESULT', { requestId, error: options.createPostError });
            return;
          }
          fake.push('CREATE_POST_RESULT', {
            requestId,
            result:
              options.createPostResult ??
              ({ postId: 4242, url: 'https://civitai.com/posts/4242', imageIds: [900_000] } as BlockCreatePostResult),
          });
        };
        if (options.createPostHold) {
          heldCreatePost = deliver;
          return;
        }
        queueMicrotask(deliver);
      }
    },
  };

  activeFake = fake;
  return {
    transport,
    fetch: fakeFetch,
    rows,
    docStore,
    calls,
    subListings: () =>
      new Map(
        [...subListings.entries()].map(([k, { status, title, subPath, tagline, imageId }]) => [
          k,
          { status, title, subPath, tagline, imageId },
        ]),
      ),
  };
}

/**
 * The fake transport the most recent {@link createFakeCivitai} built, so a test
 * can deliver a host push from OUTSIDE the render tree (wrap the call in `act`).
 */
let activeFake: FakeTransport | null = null;

/**
 * Deliver an unsolicited host push (e.g. `ROUTE_CHANGED`) to the app's `on()`
 * subscribers, through the same fake transport the app is reading. Throws when
 * no fake has been built, rather than silently delivering to nobody.
 */
export function pushFromHost(type: string, payload: unknown): void {
  if (!activeFake) throw new Error('pushFromHost: no fake platform has been configured');
  activeFake.push(type, payload);
}

/**
 * Patch the fake host's snapshot (a token refresh, a theme change), which emits
 * to snapshot subscribers exactly as the real transport does on those pushes.
 */
export function setHostSnapshot(next: Parameters<FakeTransport['setSnapshot']>[0]): void {
  if (!activeFake) throw new Error('setHostSnapshot: no fake platform has been configured');
  activeFake.setSnapshot(next);
}

export interface HarnessProps extends FakeCivitaiOptions {
  children: ReactNode;
  /**
   * Use this `fetch` instead of the fake server.
   *
   * For a suite that wants to assert the exact request a platform module builds,
   * or to script one specific response body — the fake server answers from its own
   * state, which is the wrong instrument for "what URL did the hook construct".
   */
  fetch?: typeof fetch;
  /** Accepted for call-site compatibility with the old harness; inert here. */
  showLog?: boolean;
  applyUrlToggles?: boolean;
  /** Bump to rebuild the fake (a test that wants a fresh server mid-file). */
  resetKey?: number;
  /**
   * Use THIS fake (its transport, and its fetch unless `fetch` is given) instead of
   * building a second one from the options.
   *
   * 🔴 A TEST THAT HOLDS A `createFakeCivitai()` HANDLE MUST PASS IT HERE. Without
   * it the Harness builds its own fake, and the app then reads its token from THAT
   * one's transport while its requests reach the handle's server — so a consent
   * grant re-mints one token and the store checks the other.
   */
  fake?: FakeCivitai;
}

/**
 * Installs the fake platform and renders the app against it.
 *
 * 🔴 CONFIGURED DURING RENDER, NOT IN AN EFFECT, AND THE ORDERING IS THE WHOLE
 * POINT. `__configurePlatform` drops any client already built, and React runs a
 * CHILD's effects before its parent's — so an effect here would land AFTER the app
 * below had already started the handshake and issued its first REST call against
 * the real (unconfigured) platform.
 */
export function Harness({
  children,
  resetKey = 0,
  fetch: fetchOverride,
  fake: given,
  ...options
}: HarnessProps): React.JSX.Element {
  const configuredFor = useRef<number | null>(null);
  if (configuredFor.current !== resetKey) {
    heldCreatePost = null;
    const fake = given ?? createFakeCivitai(options);
    __configurePlatform({
      transport: fake.transport,
      fetch: fetchOverride ?? fake.fetch,
      siteUrl: SITE_URL,
    });
    configuredFor.current = resetKey;
  }
  return <>{children}</>;
}


// ---------------------------------------------------------------------------
// THE REAL TRANSPORT
// ---------------------------------------------------------------------------

/**
 * The parent origin the real transport is configured to trust below. A concrete
 * origin, not a wildcard, because `IframeTransport` can only use an EXACT entry
 * as a `postMessage` targetOrigin.
 */
export const REAL_HOST_ORIGIN = 'https://civitai.com';

export interface RealTransportHarness {
  /** A REAL `IframeTransport` from `@civitai/sdk` — not `createFakeTransport`. */
  transport: BlockTransport;
  /**
   * Every frame the block posted to its parent, in order, as the real transport
   * posted it. `BLOCK_HELLO` and `BLOCK_READY` appear here too — they are the
   * transport's own traffic, and their presence is the cheapest proof that the
   * thing under test is the real one.
   */
  sent: { type: string; payload?: unknown }[];
  /**
   * Deliver a host→block frame as a genuine `message` event at
   * {@link REAL_HOST_ORIGIN}, so the transport's origin check, framing check and
   * requestId correlation all run for real.
   */
  deliver(data: unknown, origin?: string): void;
  /** Deliver a minimal valid `BLOCK_INIT`, which is what flushes the outbound queue. */
  handshake(opts?: { scopes?: string[] }): void;
  dispose(): void;
}

/**
 * Build a REAL `IframeTransport` and the two controls needed to drive it.
 *
 * 🔴 WHY THIS EXISTS. Every other suite in this repo injects a
 * `createFakeTransport()` through `__configurePlatform`, so the real transport's
 * code runs in NO test — and `CREATE_POST_FROM_APP` is the one surface still on
 * the bridge in production. Three properties matter there and are structurally
 * invisible to an in-memory fake, because the fake has no origins, no frames and
 * no queue:
 *
 *   1. A reply type that is NOT in the SDK's `LEGACY_REPLIES` ledger
 *      (`CREATE_POST_RESULT` answering `CREATE_POST_FROM_APP`) reaches `on()`
 *      push listeners rather than a pending request. `platform/createPost.ts` is
 *      built entirely on that behaviour; if the SDK ever routed it elsewhere,
 *      every fake-transport test would stay green and the app would hang.
 *   2. A frame from a DISALLOWED origin is dropped.
 *   3. `notify()` before `BLOCK_INIT` is QUEUED and flushed after it, not lost.
 *
 * 🔴 WHY IT LIVES IN THIS FILE. `src/platform-seam.test.ts` asserts that only
 * files under `src/platform/` import `@civitai/sdk`, as an exact ledger. A test
 * under `src/components/` reaching for `getTransport` itself would break that
 * guard, so the SDK access stays behind this seam and the test imports the
 * harness.
 *
 * 🔴 WHAT IT STILL IS NOT. There is no real parent frame and no real host: the
 * parent is a recorder and every inbound frame is one a test wrote. It proves the
 * transport's framing, origin check, queue and correlation behave as
 * `createPost.ts` assumes — NOT that civitai's host sends these shapes. Nothing
 * here has run against a live server.
 */
export function createRealTransport(): RealTransportHarness {
  // The SDK caches its transport on `globalThis`, so a previous test's instance
  // would otherwise be handed back with its listeners still attached.
  __resetTransport();

  const sent: { type: string; payload?: unknown }[] = [];
  const parent = {
    postMessage: (msg: unknown) => {
      sent.push(msg as { type: string; payload?: unknown });
    },
  };

  // 🔴 A PLAIN `EventTarget`, NOT THE AMBIENT `window` — so this works in BOTH
  // vitest tiers. `vite.config.ts` runs `*.test.ts` under `environment: 'node'`,
  // where there is no `window` at all; binding to `globalThis.window` made every
  // case here die at setup with `Cannot read properties of undefined`. Nothing is
  // lost by not using jsdom: the transport's real behaviour under test is its
  // origin matching, framing, outbound queue and requestId correlation, none of
  // which touch the DOM. A stubbed `parent` was always going to be a stand-in.
  const bus = new EventTarget();

  const win = {
    parent,
    // An empty hash: `#seedFromFragment` parses it, finds no host fragment and
    // returns without touching `history`.
    location: { hash: '' },
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      bus.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      bus.removeEventListener(type, listener),
  };

  const transport = getTransport({
    allowedParentOrigins: [REAL_HOST_ORIGIN],
    window: win as unknown as Window,
  });

  const deliver = (data: unknown, origin: string = REAL_HOST_ORIGIN) => {
    bus.dispatchEvent(new MessageEvent('message', { data, origin }));
  };

  const handshake = (opts: { scopes?: string[] } = {}) => {
    deliver({
      type: 'BLOCK_INIT',
      payload: {
        renderMode: 'iframe',
        context: { slotId: 'app.page' },
        token: {
          raw: 'real-transport-test-token',
          scopes: opts.scopes ?? DEFAULT_SCOPES,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        },
        settings: { publisherSettings: {}, userSettings: {} },
        viewer: { id: 99, username: 'me' },
        theme: 'dark',
        blockInstanceId: 'real-transport-test',
      },
    });
  };

  return {
    transport,
    sent,
    deliver,
    handshake,
    dispose: () => {
      __resetTransport();
    },
  };
}
