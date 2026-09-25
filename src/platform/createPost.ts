// `CREATE_POST_FROM_APP` — the one surface that stays on the bridge AND has no
// SDK wrapper.
//
// 🔴 THIS IS NOT AN OVERSIGHT TO BE FIXED BY A REST CALL. Post creation is
// deliberately staying off `/api/v1` forever: the host shows the viewer a
// confirmation built from the SERVER'S resolution of the request (real tag
// names, host-fetched model names, real thumbnails) and refuses the write on
// mismatch. A plain `POST /posts` would let a block at an opaque origin draw its
// own confirmation and publish something else. Moving it would remove a consent
// control, not relocate one. (`@civitai/sdk`'s BREAKING.md, "Post creation stays
// on the bridge".)
//
// 🔴 WHY IT IS HAND-ROLLED INSTEAD OF `transport.request()`. The SDK's transport
// derives a reply type by appending `_RESULT` unless the message is in its
// `LEGACY_REPLIES` ledger. `CREATE_POST_FROM_APP` is NOT in that ledger, so
// `request()` would wait for `CREATE_POST_FROM_APP_RESULT` while the host answers
// `CREATE_POST_RESULT` — and the SDK transport imposes NO timeout, so the promise
// would hang forever rather than fail. It would also apply envelope framing to a
// legacy-framed reply.
//
// So this correlates the reply itself, using only the transport's PUBLIC surface:
// `notify()` to send and `on()` to receive. That works because the transport
// routes any inbound message with no matching pending request to its push
// listeners — which is exactly what `CREATE_POST_RESULT` is, from its point of
// view. Filed against the SDK as a missing ledger entry; when it is added, this
// file collapses into a `request()` call.

import type {
  BlockCreatePostHostError,
  BlockCreatePostRequest,
  BlockCreatePostResult,
} from '@civitai/app-sdk/blocks';

import { getPlatformTransport } from './client.js';

/**
 * The closed set of HOST refusal codes, as a runtime array.
 *
 * 🔴 THIS EXISTS BECAUSE THE ERROR CHANNEL IS NOT AN ENUM. The host sends either
 * one of these codes or a free-text server message (a rate limit, a blocked
 * title, a refused gallery attach), so "is this a code?" is a MEMBERSHIP question
 * at runtime, not a type-level one — a `switch` over the union type would
 * silently treat `"You do not have permission…"` as unmatched prose while a
 * typo'd literal compiled fine. Mirrored from civitai's `CREATE_POST_HOST_ERRORS`.
 */
export const CREATE_POST_ERROR_CODES = [
  'review-mode',
  'block is not ready',
  'sign in to post',
  'no images to post',
  'no block token',
  'declined',
] as const satisfies readonly BlockCreatePostHostError[];

const CODE_SET: ReadonlySet<string> = new Set(CREATE_POST_ERROR_CODES);

/**
 * `true` when `error` is one of the host's CLOSED refusal codes rather than a
 * free-text server message. Use it before comparing against a code.
 */
export function isCreatePostErrorCode(error: string): error is BlockCreatePostHostError {
  return CODE_SET.has(error);
}

/**
 * The reply waits on a PERSON — the host answers only when the viewer acts on its
 * confirm — so the ceiling is ten minutes rather than a protocol default. It
 * resolves the instant the viewer acts; this only bounds an abandoned dialog.
 */
export const HUMAN_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A post-creation failure.
 *
 * `.code` is the host's refusal code when the host refused, and `undefined`
 * otherwise.
 *
 * 🔴 `.code === undefined` IS NOT BY ITSELF "A SERVER MESSAGE WORTH SHOWING".
 * Two different failures land there: a server message the host forwarded
 * verbatim, and a TRANSPORT TIMEOUT whose `.message` is internal. Check
 * `.timedOut` first; `.code === undefined && !timedOut` is the branch whose
 * `.message` is meant to be rendered.
 */
export class CreatePostError extends Error {
  /** The closed host refusal code, or `undefined` for a server/transport error. */
  readonly code?: BlockCreatePostHostError;
  /**
   * No reply ever arrived.
   *
   * 🔴 CHECK THIS BEFORE SHOWING `.message`, and 🔴 DO NOT PRESENT IT AS
   * "NOTHING HAPPENED". The write may have LANDED and only the reply failed to
   * arrive — and here the write is a PUBLIC POST under the viewer's name. Tell
   * the viewer to check their profile; never retry automatically, which is how a
   * duplicate post happens.
   */
  readonly timedOut: boolean;
  /**
   * The viewer DISMISSED the host's confirm, so NO POST WAS CREATED.
   *
   * 🔴 Trustworthy in the one direction that matters: the host takes its consent
   * latch SYNCHRONOUSLY before the write, so `declined` can never be reported for
   * a post that landed. Revert optimistic state and render nothing.
   */
  readonly declined: boolean;
  /**
   * There is no session. Route this into `requestSignIn()` rather than showing an
   * error — the viewer's next step is signing in, not retrying.
   */
  readonly signInRequired: boolean;

  constructor(error: string, opts?: { timedOut?: boolean }) {
    super(error);
    this.name = 'CreatePostError';
    this.timedOut = opts?.timedOut === true;
    if (isCreatePostErrorCode(error)) this.code = error;
    this.declined = error === 'declined';
    this.signInRequired = error === 'sign in to post';
  }
}

/** The host's reply, in the pre-protocol framing it still uses for this message. */
interface CreatePostReply {
  requestId?: unknown;
  error?: unknown;
  result?: unknown;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `cpfa-${Math.random().toString(36).slice(2, 8)}-${requestCounter}`;
}

/**
 * Ask the host to publish a REAL Post on the viewer's profile from this app's own
 * outputs, and resolve with the created post.
 *
 * REJECTS with a {@link CreatePostError} on every non-success — including
 * `declined`, which means the viewer dismissed the confirm and NO POST EXISTS.
 * Check `.declined` before rendering a failure.
 *
 * 🔴 Requires the `posts:write:self` scope, which is sensitive and consent-gated,
 * and the scope grant is NOT the consent: every call additionally opens the host
 * confirm.
 */
export function createPost(args: BlockCreatePostRequest): Promise<BlockCreatePostResult> {
  const transport = getPlatformTransport();
  const requestId = nextRequestId();

  return new Promise<BlockCreatePostResult>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      fn();
    };

    const off = transport.on('CREATE_POST_RESULT', (payload) => {
      const reply = (payload ?? {}) as CreatePostReply;
      // 🔴 Match on `requestId`. Two composers can be open in this app (the
      // gallery's and a retry), and without the check the first reply would
      // settle whichever promise happened to subscribe first.
      if (reply.requestId !== requestId) return;

      finish(() => {
        // 🔴 `||`, NOT `??`. An empty string is how the host spells "no failure"
        // on this reply, so `error: ''` with no result must fall through to a
        // code that names a real outcome rather than throwing with an empty
        // message — which renders as a blank failure on a public post.
        const error = typeof reply.error === 'string' ? reply.error : '';
        if (error || !reply.result) {
          reject(new CreatePostError(error || 'no images to post'));
          return;
        }
        resolve(reply.result as BlockCreatePostResult);
      });
    });

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new CreatePostError('The host did not answer the post request in time.', {
            timedOut: true,
          }),
        ),
      );
    }, HUMAN_INTERACTION_TIMEOUT_MS);

    // Sent AFTER the listener is attached: a host that answers synchronously
    // would otherwise reply into a frame with nothing subscribed. The transport
    // queues outbound messages until BLOCK_INIT, so this is safe pre-handshake.
    transport.notify({
      type: 'CREATE_POST_FROM_APP',
      payload: {
        requestId,
        sources: args.sources,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.detail !== undefined ? { detail: args.detail } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.modelVersionId !== undefined ? { modelVersionId: args.modelVersionId } : {}),
      },
    });
  });
}
