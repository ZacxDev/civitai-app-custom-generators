// Estimate-rejection handling for the money path (@civitai/blocks-react >= 0.43.0).
//
// `useBuzzWorkflow().estimate()` REJECTS with `WorkflowEstimateError` when the
// host's reply carries no usable price (civitai/civitai#4159). Two producers,
// discriminated by `.code`:
//   - 'failed'  — the estimate did not succeed (a server-side error, or a whatIf
//                 the orchestrator itself reports as failed). Moderator REVIEW
//                 PREVIEW lands here too: the host short-circuits every workflow
//                 request with `'not available in review preview'`.
//   - 'no-cost' — an otherwise-successful reply with no numeric `cost.total`.
//
// 🔴 THREE SURFACES, THREE DIFFERENT STRINGS — do not collapse them:
//   - `err.snapshot.error` is SERVER-AUTHORED AND UNSANITISED. It is where the
//     reason lives, and raw upstream text (Prisma/`pg` column and constraint
//     names among it) can reach it. LOG it; never render it as copy.
//   - `err.message` is the SDK's generic developer constant ("… reason on
//     .snapshot.error"). Safe to print, but it is not viewer copy and its exact
//     wording is explicitly not a contract.
//   - `.code` is the only stable branch target.

import { WorkflowEstimateError } from '@civitai/blocks-react';

/**
 * Shown when the estimate did not succeed. Says the two things a viewer needs:
 * nothing was submitted, and no Buzz was spent (an estimate is a price check —
 * it never charges).
 */
export const ESTIMATE_FAILED_MESSAGE =
  'We couldn’t price this generation, so nothing was submitted and no Buzz was spent. Please try again in a moment.';

/** Shown when the reply came back with no price at all. */
export const ESTIMATE_NO_COST_MESSAGE =
  'This generation came back without a price, so nothing was submitted and no Buzz was spent. Please try again in a moment.';

/** Where the server's own words go: a developer surface, never the UI. */
type EstimateLogger = (message: string, detail: { code: string; serverError?: string }) => void;

const defaultLogger: EstimateLogger = (message, detail) => {
  // eslint-disable-next-line no-console
  console.warn(message, detail);
};

/**
 * Map an `estimate()` rejection to VIEWER-SAFE copy, routing the server's own
 * explanation to `log` so a failed estimate stays diagnosable instead of being
 * discarded (which is exactly what civitai/civitai#4159 was about).
 *
 * A rejection that is NOT a `WorkflowEstimateError` (a transport timeout, an
 * aborted request) passes through with its own message — those are already
 * block-authored or protocol-level strings, not server prose.
 */
export function estimateFailureMessage(e: unknown, log: EstimateLogger = defaultLogger): string {
  if (e instanceof WorkflowEstimateError) {
    log('[custom-generators] estimate rejected', { code: e.code, serverError: e.snapshot.error });
    return e.code === 'no-cost' ? ESTIMATE_NO_COST_MESSAGE : ESTIMATE_FAILED_MESSAGE;
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/**
 * A snapshot is a QUOTE only when it carries a numeric total. `0` is a real
 * price (a whatIf cache hit prices at 0) and must stay confirmable; `undefined`
 * must not.
 *
 * blocks-react >= 0.43 rejects an unpriced reply inside the hook, so this is
 * defense in depth for the seam the Runner actually consumes: `estimate` is an
 * injected prop, and an unpriced resolve reaching Confirm is a dialog that
 * spends an unknown amount of Buzz.
 */
export function isPricedSnapshot(snapshot: { cost?: { total?: number } }): boolean {
  return typeof snapshot.cost?.total === 'number';
}
