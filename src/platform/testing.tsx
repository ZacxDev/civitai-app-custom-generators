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

import { createFakeTransport, __resetTransport } from '@civitai/sdk/testing';
import type { FakeTransport } from '@civitai/sdk/testing';
import type { BlockTransport } from '@civitai/sdk';
import type {
  BlockCreatePostResult,
  BlockGatedImage,
  BlockResourceInfo,
  BlockResourcePickerType,
  BlockGenerationSourceImageInfo,
  BlockWorkflowSnapshot,
  SharedStorageValue,
} from '@civitai/app-sdk/blocks';

import { __configurePlatform } from './client.js';
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
  /** Seeded per-viewer app storage. */
  storage?: { seed?: Record<string, unknown> };
  /** Observe every outbound bridge message (requests AND notifications). */
  onOutbound?: (message: { type: string; payload: unknown }) => void;
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
  /** The fake server's shared rows, for asserting server state. */
  rows: () => SharedListItem[];
  /** Every REST call the app made, in order. */
  calls: RecordedCall[];
}

const DEFAULT_SCOPES = [
  'ai:write:budgeted',
  'buzz:read:self',
  'apps:storage:read',
  'apps:storage:write',
  'apps:storage:shared:read',
  'apps:storage:shared:write',
  'posts:write:self',
];

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
 */
function notFound(path: string): Response {
  return new Response(`<!DOCTYPE html><h1>404</h1><p>${path}</p>`, {
    status: 404,
    headers: { 'content-type': 'text/html' },
  });
}

export function createFakeCivitai(options: FakeCivitaiOptions = {}): FakeCivitai {
  const viewer = options.viewer === undefined ? { id: 99, username: 'me' } : options.viewer;
  const viewerId = viewer?.id ?? null;
  const gen = options.generation ?? {};
  const calls: RecordedCall[] = [];

  // ---- server state -------------------------------------------------------
  const shared = new Map<string, { value: SharedStorageValue; authorUserId: number; voters: Set<number> }>();
  for (const seed of options.shared?.seed ?? []) {
    shared.set(seed.key ?? mintKey(), {
      value: seed.value,
      authorUserId: seed.authorUserId ?? viewerId ?? 1,
      voters: new Set(seed.voters ?? []),
    });
  }
  const storage = new Map<string, unknown>(Object.entries(options.storage?.seed ?? {}));
  const workflows = new Map<string, { snapshot: BlockWorkflowSnapshot; pollsLeft: number }>();
  let workflowCounter = 0;

  const rowOf = (key: string): SharedListItem => {
    const r = shared.get(key)!;
    return {
      key,
      authorUserId: r.authorUserId,
      value: r.value,
      count: r.voters.size,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      viewerVoted: viewerId != null && r.voters.has(viewerId),
    };
  };

  /** Wire form: the dates are ISO strings, as JSON makes them. */
  const wireRow = (key: string) => {
    const row = rowOf(key);
    return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  };

  const rows = () =>
    [...shared.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).map(rowOf);

  /** Anonymous writes are refused before anything else, as the server does. */
  const requireViewer = (): Response | null =>
    viewerId == null ? json(403, { error: 'apps:storage:shared:write requires authenticated subject' }) : null;

  const cost = gen.costPerGen ?? 12;

  // ---- the fake fetch -----------------------------------------------------
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^.*\/api\/v1\//, '');
    const q = url.searchParams;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body, query: q });

    // ---- shared storage
    if (path === 'blocks/shared-storage/list') {
      const prefix = q.get('prefix') ?? '';
      const limit = Number(q.get('limit') ?? 50);
      const cursor = q.get('cursor');
      const after = cursor ? atob(cursor) : null;
      const all = [...shared.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
        .filter((k) => (after ? k < after : true));
      const page = all.slice(0, limit);
      // `nextCursor` iff the page FILLED — the server's own rule, and the reason
      // `App.tsx` over-fetches by one rather than trusting this.
      const nextCursor = page.length === limit ? btoa(page[page.length - 1]!) : undefined;
      return json(200, { items: page.map(wireRow), metadata: { nextCursor } });
    }
    if (path === 'blocks/shared-storage/item') {
      const key = q.get('key') ?? '';
      return json(200, { item: shared.has(key) ? wireRow(key) : null });
    }
    if (path === 'blocks/shared-storage/counts') {
      // Repeated `keys` params — never comma-split.
      const keys = q.getAll('keys');
      const counts: Record<string, number> = {};
      for (const k of keys) counts[k] = shared.get(k)?.voters.size ?? 0;
      return json(200, { counts });
    }
    if (path === 'blocks/shared-storage/append') {
      const refused = requireViewer();
      if (refused) return refused;
      const key = mintKey();
      shared.set(key, {
        value: (body as { value: SharedStorageValue }).value,
        authorUserId: viewerId!,
        voters: new Set(),
      });
      return json(200, { key });
    }
    if (path === 'blocks/shared-storage/update') {
      const refused = requireViewer();
      if (refused) return refused;
      const key = String(body?.key);
      const row = shared.get(key);
      if (!row) return json(404, { message: 'request not found' });
      if (row.authorUserId !== viewerId)
        return json(403, { message: 'you can only edit your own submissions' });
      row.value = (body as { value: SharedStorageValue }).value;
      return json(200, { ok: true });
    }
    if (path === 'blocks/shared-storage/vote' || path === 'blocks/shared-storage/unvote') {
      const refused = requireViewer();
      if (refused) return refused;
      const key = String(body?.key);
      const row = shared.get(key);
      if (!row) {
        // `vote` pre-checks existence; `unvote` does not and answers 0.
        if (path.endsWith('vote') && !path.endsWith('unvote'))
          return json(404, { message: 'request not found' });
        return json(200, { count: 0 });
      }
      if (path.endsWith('unvote')) row.voters.delete(viewerId!);
      else row.voters.add(viewerId!);
      return json(200, { count: row.voters.size });
    }
    if (path === 'blocks/shared-storage/withdraw') {
      const refused = requireViewer();
      if (refused) return refused;
      const key = String(body?.key);
      const row = shared.get(key);
      // Never 403/404 — so this route is not an existence oracle for other
      // viewers' rows.
      const deleted = !!row && row.authorUserId === viewerId;
      if (deleted) shared.delete(key);
      return json(200, { ok: true, deleted });
    }
    if (path === 'blocks/shared-storage/report') {
      const refused = requireViewer();
      if (refused) return refused;
      return json(200, { ok: true });
    }

    // ---- app storage (all POST)
    if (path === 'blocks/app-storage/get') {
      if (viewerId == null) return json(403, { message: 'apps:storage:read requires authenticated subject' });
      return json(200, { value: storage.has(String(body?.key)) ? storage.get(String(body?.key)) : null });
    }
    if (path === 'blocks/app-storage/set') {
      if (viewerId == null) return json(403, { message: 'apps:storage:write requires authenticated subject' });
      storage.set(String(body?.key), body?.value);
      return json(200, { ok: true, sizeBytes: JSON.stringify(body?.value ?? null).length });
    }
    if (path === 'blocks/app-storage/delete') {
      if (viewerId == null) return json(403, { message: 'apps:storage:write requires authenticated subject' });
      return json(200, { ok: true, deleted: storage.delete(String(body?.key)) });
    }
    if (path === 'blocks/app-storage/list') {
      if (viewerId == null) return json(403, { message: 'apps:storage:read requires authenticated subject' });
      const prefix = String(body?.prefix ?? '');
      const keys = [...storage.keys()].filter((k) => k.startsWith(prefix)).sort();
      return json(200, {
        keys: keys.map((k) => ({ key: k, updatedAt: '2026-01-02T00:00:00.000Z' })),
      });
    }
    if (path === 'blocks/app-storage/quota') {
      return json(200, { usedBytes: 1024, rowCount: storage.size, limitBytes: 1_000_000, limitRows: 50 });
    }

    // ---- images / resources / buzz
    if (path === 'blocks/gated-images') {
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
      subPath: '',
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

  return { transport, fetch: fakeFetch, rows, calls };
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
  ...options
}: HarnessProps): React.JSX.Element {
  const configuredFor = useRef<number | null>(null);
  if (configuredFor.current !== resetKey) {
    heldCreatePost = null;
    const fake = createFakeCivitai(options);
    __configurePlatform({
      transport: fake.transport,
      fetch: fetchOverride ?? fake.fetch,
      siteUrl: SITE_URL,
    });
    configuredFor.current = resetKey;
  }
  return <>{children}</>;
}
