// The money path, over `POST /api/v1/blocks/workflows/{estimate,submit,poll,cancel}`.
//
// Replaces `useBuzzWorkflow`. Each route is a thin adapter over the SAME tRPC
// procedure the page host called for the bridge message, so spend caps, the
// maturity clamp and app attribution all still apply.
//
// 🔴 DO NOT SUBSTITUTE `app.orchestration` FOR THESE ROUTES. It is the sharpest
// trap in the whole migration, because the wrong version COMPILES AND PASSES
// TESTS. Submitting through the host went through civitai's own
// `blocks.submitWorkflow`, which adds controls a direct orchestrator call does not
// get: the per-call `buzzBudget`, the per-viewer daily cap and the per-app daily
// cap; the viewer's browsing-level ceiling; and the app/block attribution tags. A
// direct call has only the orchestrator's per-token budget. `app.orchestration` is
// the raw escape hatch for an app that is genuinely its own principal — this app
// is not.
//
// The request body is UNCHANGED from the bridge: `WorkflowBody` in
// `@civitai/app-sdk/blocks` already mirrors the server's own
// `blockWorkflowBodySchema` (a discriminated union on `kind`; this app only ever
// sends `kind: 'textToImage'`), so `lib/generator.ts`'s body builder was not
// touched.

import type { BlockWorkflowSnapshot, WorkflowBody } from '@civitai/app-sdk/blocks';
import { ApiError } from '@civitai/sdk';

import { getClient } from './client.js';

/**
 * The `workflowId` the server puts on a snapshot it synthesised rather than
 * observed — every refusal, and every `failureSnapshot`.
 *
 * 🔴 ON THE BRIDGE THIS WAS A WIRE INVARIANT; HERE IT IS OURS. Compare with
 * `===` only, and never poll on it.
 */
export const HOST_SYNTHESISED_WORKFLOW_ID = 'failed';

export type WorkflowEstimateErrorCode = 'failed' | 'no-cost';

/**
 * An estimate that produced no usable price.
 *
 * Carried over from `@civitai/blocks-react` unchanged in shape and meaning,
 * because `lib/estimate.ts` branches on `instanceof` and on `.code`, and
 * `Runner` renders viewer-safe copy chosen by that code. Two producers:
 *   - `'failed'`  — the estimate did not succeed (a server-side refusal, or a
 *                   whatIf the orchestrator itself reports failed). The moderator
 *                   review preview lands here too.
 *   - `'no-cost'` — an otherwise-successful reply with no numeric `cost.total`.
 *
 * 🔴 `.snapshot.error` IS SERVER-AUTHORED AND UNSANITISED — raw upstream text
 * (Prisma/`pg` column and constraint names among it) can reach it. Log it; never
 * render it. `.code` is the only stable branch target. `lib/estimate.ts` already
 * enforces that split and needed no change.
 */
export class WorkflowEstimateError extends Error {
  readonly code: WorkflowEstimateErrorCode;
  readonly snapshot: BlockWorkflowSnapshot;

  constructor(snapshot: BlockWorkflowSnapshot, code: WorkflowEstimateErrorCode) {
    super(
      code === 'no-cost'
        ? 'Workflow estimate returned no cost; reason on .snapshot.error'
        : 'Workflow estimate failed; reason on .snapshot.error',
    );
    this.name = 'WorkflowEstimateError';
    this.code = code;
    this.snapshot = snapshot;
  }
}

/**
 * Turn a thrown REST failure into the failure-shaped snapshot the app expects.
 *
 * 🔴 THIS IS THE ONE PLACE THE TWO TRANSPORTS GENUINELY DIFFER, AND THE WHOLE
 * ERROR PATH HANGS ON IT. On the bridge a server-side throw could not reject
 * across `postMessage`, so the host posted a well-formed reply carrying a
 * failure snapshot. Over REST the same throw is a NON-2xx and the SDK's http
 * client raises `ApiError`. Left alone, that would reach `Runner` as a plain
 * `Error`, `instanceof WorkflowEstimateError` would be false, and every estimate
 * failure would fall out of the classified handling into the generic catch —
 * losing the top-up CTA and the retry copy.
 *
 * ⚠️ The message is taken from the server's own body. `@civitai/sdk`'s `ApiError`
 * already extracts it from both the `{ error }` and `{ message }` envelopes this
 * surface mixes, so `lib/buzz.ts`'s `isInsufficientBuzzError` needed no change.
 */
function snapshotFromError(err: unknown): BlockWorkflowSnapshot {
  const message =
    err instanceof ApiError || err instanceof Error ? err.message : String(err);
  return {
    workflowId: HOST_SYNTHESISED_WORKFLOW_ID,
    status: 'failed',
    error: message,
  };
}

/**
 * A 2xx that carried no snapshot is malformed, not a workflow.
 *
 * Returning it would make a caller's terminal test read `undefined` and the poll
 * loop spin until its own duration cap.
 */
function requireSnapshot(res: { snapshot?: BlockWorkflowSnapshot }): BlockWorkflowSnapshot {
  if (!res?.snapshot || typeof res.snapshot.status !== 'string') {
    throw new Error('Workflow reply carried no snapshot');
  }
  return res.snapshot;
}

/** `0` is a real price (a whatIf cache hit prices at 0); `undefined` is not. */
function isPriced(snapshot: BlockWorkflowSnapshot): boolean {
  return typeof snapshot.cost?.total === 'number';
}

/**
 * A fresh idempotency key per submit attempt.
 *
 * 🔴 REQUIRED BY THE ROUTE — no `?`. The bridge input had it optional and the
 * host filled it in; on REST a submit without one is a 400. It exists because a
 * connection that drops after the orchestrator accepted and charged, followed by
 * a retry, would mint a second workflow and debit the viewer's Buzz twice.
 *
 * Charset is the server's `/^[A-Za-z0-9_-]{1,64}$/`, which `randomUUID()`'s hex
 * and hyphens satisfy. Per CALL rather than per body: two deliberate submits of
 * the same generator are two generations the viewer asked for, and must not
 * collapse into one.
 */
function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // A jsdom/older-runtime fallback. Still within the charset and still unique
  // enough for its one job, which is separating two submits seconds apart.
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface WorkflowClient {
  estimate: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  submit: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  poll: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
  cancel: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
}

export function createWorkflowClient(): WorkflowClient {
  return {
    /**
     * Price a workflow without running it.
     *
     * 🔴 ON REST A REJECTION IS A NON-2xx, NOT A PRICED FAILURE SNAPSHOT — this
     * differs from submit and the difference was measured, not assumed. None of
     * the server's four estimate resolvers can produce a `status: 'failed'`
     * snapshot; every refusal throws (403 for an unsupported img2img pairing, 401
     * for an anonymous viewer, 400 for a token without slot context). So the two
     * arms below are: a throw becomes `'failed'`, and a 2xx without a numeric
     * cost becomes `'no-cost'`.
     */
    async estimate(body) {
      let snapshot: BlockWorkflowSnapshot;
      try {
        const app = await getClient();
        snapshot = requireSnapshot(
          await app.site.post<{ snapshot?: BlockWorkflowSnapshot }>(
            'blocks/workflows/estimate',
            { body },
          ),
        );
      } catch (err) {
        throw new WorkflowEstimateError(snapshotFromError(err), 'failed');
      }
      if (!isPriced(snapshot)) throw new WorkflowEstimateError(snapshot, 'no-cost');
      return snapshot;
    },

    /**
     * Submit a workflow, spending the viewer's Buzz.
     *
     * 🔴 RESOLVES ON EVERY 2xx, INCLUDING A REFUSAL, AND THAT IS THE CONTRACT
     * RATHER THAN LENIENCY. The server answers a budget rejection by RESOLVING
     * with a failure-shaped snapshot that QUOTES THE PRICE it declined to charge
     * — which is what makes the top-up recoverable. Rejecting here would erase
     * the distinction and turn a recoverable top-up into a hard failure on a
     * spend path. `Runner` already reads `snap.status === 'failed'` plus
     * `isInsufficientBuzzError(snap.error)` and opens the purchase modal, so
     * resolving is exactly what it expects.
     *
     * A genuine transport/authorisation failure still throws, and `Runner`'s
     * catch renders it.
     */
    async submit(body) {
      const app = await getClient();
      return requireSnapshot(
        await app.site.post<{ snapshot?: BlockWorkflowSnapshot }>('blocks/workflows/submit', {
          body,
          idempotencyKey: newIdempotencyKey(),
        }),
      );
    },

    /**
     * Read a workflow's current state.
     *
     * 🔴 A `'processing'` REPLY IS NOT NECESSARILY AN OBSERVATION. When the
     * poll bucket is exhausted the server RESOLVES 200 with a PLACEHOLDER
     * `{ workflowId, status: 'processing' }` meaning "not read this time" — it
     * deliberately does not 429, because a 429 would be read as a terminal
     * failure and would strand a paid, still-running generation. `pollToTerminal`
     * treats a non-terminal snapshot as "keep waiting", which is the correct
     * response to both a real `processing` and the placeholder, so no special
     * casing is needed here — but do not add any that reads `processing` as
     * progress.
     *
     * No `waitSeconds` is sent: the app drives its own backoff in
     * `lib/workflow.ts`, and the server clamps the field to 15s anyway.
     */
    async poll(workflowId) {
      const app = await getClient();
      return requireSnapshot(
        await app.site.post<{ snapshot?: BlockWorkflowSnapshot }>('blocks/workflows/poll', {
          workflowId,
        }),
      );
    },

    /**
     * Cancel a workflow. Cancelling an already-terminal one is not an error — the
     * server re-reads and returns the real terminal state.
     *
     * Same placeholder caveat as `poll`: a shed cancel resolves `'processing'`,
     * which honestly means "the cancel was never issued" — retry rather than
     * reading it as cancelled.
     */
    async cancel(workflowId) {
      const app = await getClient();
      return requireSnapshot(
        await app.site.post<{ snapshot?: BlockWorkflowSnapshot }>('blocks/workflows/cancel', {
          workflowId,
        }),
      );
    },
  };
}

export interface UseBuzzWorkflow extends WorkflowClient {}

/** The hook shape `App.tsx` binds into its `deps` bag. */
export function useBuzzWorkflow(): UseBuzzWorkflow {
  // The client is stateless and cheap; a module-level constant would be equally
  // correct but would make the test seam harder to reason about.
  return createWorkflowClient();
}
