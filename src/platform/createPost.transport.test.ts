// `CREATE_POST_FROM_APP` OVER THE REAL `IframeTransport` — the one suite in this
// repo that does not inject a fake transport.
//
// 🔴 WHY IT EXISTS: THE PORT LOST THIS COVERAGE AND SAID SO. Before the move to
// `@civitai/sdk`, three cases in `KeptGallery.post.transport.test.tsx` patched
// `window.parent.postMessage` to swallow or hold the one outbound frame, which
// genuinely drove the real transport's correlation and deadline. After the port
// every suite supplies a `createFakeTransport()` override through
// `__configurePlatform`, so the real transport's code ran in NO test — while
// `CREATE_POST_FROM_APP` remained the one surface still on the bridge in
// production. This file restores that, at the layer where it is actually
// checkable.
//
// 🔴 WHAT THIS CATCHES THAT NO FAKE-DRIVEN SUITE CAN — MEASURED, NOT ASSUMED.
// `platform/createPost.ts` is hand-rolled on `notify()` + `on()` instead of
// `transport.request()`, and its whole justification is a claim about the SDK's
// internals:
//
//   "the transport routes any inbound message with no matching pending request to
//    its push listeners — which is exactly what `CREATE_POST_RESULT` is, from its
//    point of view"
//
// `CREATE_POST_RESULT` is NOT in the SDK's `LEGACY_REPLIES` ledger, so
// `request('CREATE_POST_FROM_APP')` would wait for `CREATE_POST_FROM_APP_RESULT`
// forever. The fake transport's answer to that message is hardcoded in
// `platform/testing.tsx` — OUR file — so it keeps answering however the SDK
// behaves. Control run: deleting the push-listener dispatch from the INSTALLED
// SDK (`dist/core/transports/iframe-transport.js`) failed 5 cases in this file
// and left all 43 other test files GREEN, the fake-driven
// `KeptGallery.post.transport.test.tsx` included. So an SDK-side change to that
// routing — the shape a version bump would bring — is visible here and nowhere
// else.
//
// 🔴 WHAT IS *NOT* UNIQUE TO THIS FILE, stated so nobody over-reads the above:
// an APP-side mistake in the listener type is caught by the fake-driven suite too
// (control run: pointing `on()` at `CREATE_POST_FROM_APP_RESULT` reddened both).
// The two properties genuinely beyond a fake's reach are the ORIGIN check and the
// pre-`BLOCK_INIT` outbound QUEUE, because `createFakeTransport()` has no concept
// of either.
//
// 🔴 WHAT IT IS STILL NOT. There is no real parent frame and no real host: the
// parent is a recorder, and every inbound frame is one this file wrote. These are
// claims about the SDK transport shipped in `node_modules`, not about civitai's
// host. NOTHING HERE HAS RUN AGAINST A LIVE SERVER, and the host's confirm dialog
// — what it shows, and that it waits on a human — has no analogue here at all.
//
// 🔴 EVERY EXPECTATION IS A LITERAL, never an imported constant, so a test cannot
// agree with a changed implementation by construction.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __configurePlatform } from './client.js';
import { createPost, CreatePostError } from './createPost.js';
import { createRealTransport, REAL_HOST_ORIGIN, type RealTransportHarness } from './testing.js';

let harness: RealTransportHarness;

beforeEach(() => {
  harness = createRealTransport();
  // The REAL transport is what the platform hands to `createPost()`. No `fetch`
  // is configured because this path makes no REST call at all.
  __configurePlatform({ transport: harness.transport });
});

afterEach(() => {
  harness.dispose();
  __configurePlatform({});
  vi.useRealTimers();
});

/** Frames the block sent, minus the transport's own handshake chatter. */
function appFrames() {
  return harness.sent.filter((m) => m.type !== 'BLOCK_HELLO' && m.type !== 'BLOCK_READY');
}

function payloadOf(frame: { payload?: unknown }) {
  return (frame.payload ?? {}) as Record<string, unknown>;
}

// The shape this app really sends — `KeptGallery.tsx:690` builds exactly this.
// `BlockPostSource` is a discriminated union on `kind`; the other arm is
// `{ kind: 'workflow', workflowId }`, which this app never produces.
const SOURCES = [{ kind: 'published' as const, imageIds: [90_210] }];

describe('the transport under test is the real one', () => {
  /**
   * POSITIVE CONTROL FOR THE WHOLE FILE, and it is not decorative: if
   * `createRealTransport()` silently handed back a fake, every assertion below
   * would still pass for the wrong reason. Only the real `IframeTransport`
   * announces itself to its parent on construction and answers `BLOCK_INIT` with
   * `BLOCK_READY`; a `createFakeTransport()` posts nothing anywhere.
   */
  it('announces BLOCK_HELLO on construction and BLOCK_READY after BLOCK_INIT', () => {
    expect(harness.sent.map((m) => m.type)).toEqual(['BLOCK_HELLO']);
    harness.handshake();
    expect(harness.sent.map((m) => m.type)).toEqual(['BLOCK_HELLO', 'BLOCK_READY']);
  });

  /**
   * NEGATIVE CONTROL for `deliver()`. Every assertion about a reply being ignored
   * below would read identically if `deliver()` were wired to nothing, so this
   * pins that a delivered frame IS observed: the same mechanism that carries a
   * reply carries the handshake, and the handshake visibly lands.
   */
  it('a frame from a DISALLOWED origin is dropped by the real origin check', () => {
    harness.deliver(
      {
        type: 'BLOCK_INIT',
        payload: {
          renderMode: 'iframe',
          context: { slotId: 'app.page' },
          token: { raw: 'x', scopes: [], expiresAt: new Date().toISOString() },
          settings: { publisherSettings: {}, userSettings: {} },
          viewer: null,
          theme: 'dark',
          blockInstanceId: 'evil',
        },
      },
      'https://evil.example',
    );
    // No BLOCK_READY: the handshake was refused, so the transport never latched.
    expect(harness.sent.map((m) => m.type)).toEqual(['BLOCK_HELLO']);

    // ...and the same frame from the trusted origin DOES latch it.
    harness.handshake();
    expect(harness.sent.map((m) => m.type)).toEqual(['BLOCK_HELLO', 'BLOCK_READY']);
  });
});

describe('the outbound CREATE_POST_FROM_APP frame', () => {
  it('is QUEUED before BLOCK_INIT and flushed to the parent after it', async () => {
    // Deliberately no handshake yet — this is the pre-handshake path the app hits
    // when a viewer is fast, and `createPost.ts` claims the queue makes it safe.
    void createPost({ sources: SOURCES, title: 'Neon run' });
    expect(appFrames()).toEqual([]);

    harness.handshake();

    const frames = appFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('CREATE_POST_FROM_APP');
    const payload = payloadOf(frames[0]);
    expect(payload.title).toBe('Neon run');
    expect(payload.sources).toEqual([{ kind: 'published', imageIds: [90_210] }]);
    // The app mints its own correlation id — the transport does not add one for
    // `notify()`, which is exactly why `createPost.ts` carries its own.
    expect(typeof payload.requestId).toBe('string');
    expect(payload.requestId as string).not.toBe('');
  });

  it('omits every optional field the caller left alone', async () => {
    harness.handshake();
    void createPost({ sources: SOURCES });
    const payload = payloadOf(appFrames()[0]);
    expect(Object.keys(payload).sort()).toEqual(['requestId', 'sources']);
  });
});

describe('the inbound CREATE_POST_RESULT reply', () => {
  /**
   * 🔴 THE LOAD-BEARING ASSERTION OF THIS FILE. `CREATE_POST_RESULT` is not in
   * the SDK's `LEGACY_REPLIES` ledger and does not match
   * `CREATE_POST_FROM_APP_RESULT`, so the real transport has no pending request to
   * settle and must route it to an `on()` push listener. That routing is the sole
   * reason `createPost.ts` works, and this is the case that dies when the SDK stops
   * doing it — see the control run in the file header. A fake-driven suite stays
   * green through that change, because the fake's answer is scripted in our own
   * `testing.tsx` rather than decided by the transport.
   */
  it('resolves the promise, because the real transport routes an unledgered reply to on()', async () => {
    harness.handshake();
    const pending = createPost({ sources: SOURCES, title: 'Neon run' });
    const requestId = payloadOf(appFrames()[0]).requestId;

    harness.deliver({
      type: 'CREATE_POST_RESULT',
      payload: {
        requestId,
        result: { postId: 4242, url: 'https://civitai.com/posts/4242', imageIds: [90_210] },
      },
    });

    await expect(pending).resolves.toEqual({
      postId: 4242,
      url: 'https://civitai.com/posts/4242',
      imageIds: [90_210],
    });
  });

  it('a reply carrying a FOREIGN requestId does not settle it', async () => {
    vi.useFakeTimers();
    harness.handshake();
    const pending = createPost({ sources: SOURCES });
    const settled = vi.fn();
    void pending.then(settled, settled);

    harness.deliver({
      type: 'CREATE_POST_RESULT',
      payload: { requestId: 'cpfa-someone-elses-99', result: { postId: 1, url: 'x', imageIds: [] } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();

    // CONTROL: the correctly-addressed reply settles the same promise, so the
    // silence above is attributable to the id and not to a dead listener.
    harness.deliver({
      type: 'CREATE_POST_RESULT',
      payload: {
        requestId: payloadOf(appFrames()[0]).requestId,
        result: { postId: 7, url: 'https://civitai.com/posts/7', imageIds: [90_210] },
      },
    });
    await expect(pending).resolves.toMatchObject({ postId: 7 });
  });

  it('rejects with the host’s refusal code when the reply carries one', async () => {
    harness.handshake();
    const pending = createPost({ sources: SOURCES });
    harness.deliver({
      type: 'CREATE_POST_RESULT',
      payload: { requestId: payloadOf(appFrames()[0]).requestId, error: 'declined' },
    });

    await expect(pending).rejects.toBeInstanceOf(CreatePostError);
    await pending.catch((err: CreatePostError) => {
      expect(err.code).toBe('declined');
      expect(err.declined).toBe(true);
      expect(err.timedOut).toBe(false);
    });
  });

  /**
   * `error: ''` is how the host spells "no failure" on this pre-protocol reply. An
   * empty string with no result must not reject with an EMPTY message — that
   * renders as a blank failure on a public post.
   */
  it('turns an empty error with no result into a named outcome, never a blank one', async () => {
    harness.handshake();
    const pending = createPost({ sources: SOURCES });
    harness.deliver({
      type: 'CREATE_POST_RESULT',
      payload: { requestId: payloadOf(appFrames()[0]).requestId, error: '' },
    });

    await pending.catch((err: CreatePostError) => {
      expect(err.message).toBe('no images to post');
      expect(err.code).toBe('no images to post');
    });
    await expect(pending).rejects.toBeInstanceOf(CreatePostError);
  });
});

describe('a reply that never arrives', () => {
  /**
   * THE RESTORED CASE. A pre-port test dropped the outbound frame at
   * `window.parent.postMessage` to produce exactly this state; the fake-transport
   * substitute asks a scripted object to stay quiet instead. Here the frame really
   * leaves and no answer is ever delivered.
   *
   * The ten-minute ceiling is `createPost.ts`'s OWN timer, not the SDK's — the SDK
   * imposes no deadline on `notify()`/`on()`, which is precisely why the app has
   * to. That is a claim about this file's subject, so it is asserted here.
   */
  it('reaches the app’s own ten-minute deadline and reports timedOut, never an SDK string', async () => {
    vi.useFakeTimers();
    harness.handshake();
    const pending = createPost({ sources: SOURCES });
    const settled = vi.fn();
    void pending.then(settled, settled);

    // The frame really went out — this is not a test of a request never made.
    expect(appFrames()[0].type).toBe('CREATE_POST_FROM_APP');

    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1_000);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);

    await pending.catch((err: CreatePostError) => {
      expect(err.timedOut).toBe(true);
      expect(err.code).toBeUndefined();
      expect(err.declined).toBe(false);
      // The message the app owns, pinned whole. `lib/post.ts` maps `timedOut`
      // FIRST precisely so no SDK-internal sentence can reach a viewer.
      expect(err.message).toBe('The host did not answer the post request in time.');
      expect(err.message).not.toContain('IframeTransport');
      expect(err.message).not.toContain('timed out after');
    });
    await expect(pending).rejects.toBeInstanceOf(CreatePostError);
  });

  it('a reply arriving AFTER the deadline cannot settle the already-rejected promise', async () => {
    vi.useFakeTimers();
    harness.handshake();
    const pending = createPost({ sources: SOURCES });
    const requestId = payloadOf(appFrames()[0]).requestId;
    const outcomes: string[] = [];
    void pending.then(
      () => outcomes.push('resolved'),
      () => outcomes.push('rejected'),
    );

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    expect(outcomes).toEqual(['rejected']);

    // The host answers late. `createPost` must have detached its listener; a
    // second settle would be a duplicate-post report on a post nobody can see.
    harness.deliver({
      type: 'CREATE_POST_RESULT',
      payload: { requestId, result: { postId: 9, url: 'https://civitai.com/posts/9', imageIds: [] } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes).toEqual(['rejected']);
  });
});

describe('the origin check protects the reply channel too', () => {
  /**
   * A `CREATE_POST_RESULT` from an untrusted origin must not settle a real post
   * request. This is the property that genuinely has no fake-transport analogue:
   * a `createFakeTransport()` has no concept of an origin, so no fake-driven suite
   * could ever have caught a regression here.
   */
  it('a CREATE_POST_RESULT from a foreign origin is ignored', async () => {
    vi.useFakeTimers();
    harness.handshake();
    const pending = createPost({ sources: SOURCES });
    const requestId = payloadOf(appFrames()[0]).requestId;
    const settled = vi.fn();
    void pending.then(settled, settled);

    harness.deliver(
      {
        type: 'CREATE_POST_RESULT',
        payload: { requestId, result: { postId: 666, url: 'https://evil.example/posts/666', imageIds: [] } },
      },
      'https://evil.example',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();

    // CONTROL: the identical frame from the trusted origin DOES settle it, so the
    // rejection above is attributable to the origin and nothing else.
    harness.deliver({
      type: 'CREATE_POST_RESULT',
      payload: { requestId, result: { postId: 4242, url: 'https://civitai.com/posts/4242', imageIds: [] } },
    });
    await expect(pending).resolves.toMatchObject({ postId: 4242 });
  });

  it('REAL_HOST_ORIGIN is the concrete origin the transport was configured with', () => {
    expect(REAL_HOST_ORIGIN).toBe('https://civitai.com');
  });
});
