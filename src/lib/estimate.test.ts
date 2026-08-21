import { describe, expect, it, vi } from 'vitest';
import { WorkflowEstimateError } from '@civitai/blocks-react';
import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import {
  ESTIMATE_FAILED_MESSAGE,
  ESTIMATE_NO_COST_MESSAGE,
  estimateFailureMessage,
} from './estimate.js';

/**
 * A REALISTIC unsanitised server string. `@civitai/blocks-react` documents
 * `snapshot.error` as server-authored and unsanitised — raw upstream text,
 * Prisma/`pg` column and constraint names among it — so the fixture is shaped
 * like the thing we must not render, not like a tidy placeholder.
 */
const RAW_SERVER_ERROR =
  'Invalid `prisma.workflow.create()` invocation: Unique constraint failed on the fields: (`user_email`)';

function failedSnapshot(error = RAW_SERVER_ERROR): BlockWorkflowSnapshot {
  return { workflowId: 'failed', status: 'failed', error };
}

describe('estimateFailureMessage — viewer-safe copy for an estimate rejection', () => {
  it('maps code "failed" to the failed copy', () => {
    const msg = estimateFailureMessage(new WorkflowEstimateError(failedSnapshot(), 'failed'), () => {});
    expect(msg).toBe(ESTIMATE_FAILED_MESSAGE);
  });

  it('maps code "no-cost" to its OWN copy — the two producers are distinguishable', () => {
    const snap: BlockWorkflowSnapshot = { workflowId: 'wf', status: 'pending' };
    const msg = estimateFailureMessage(new WorkflowEstimateError(snap, 'no-cost'), () => {});
    expect(msg).toBe(ESTIMATE_NO_COST_MESSAGE);
    // The two arms must not collapse into one string, or `code` buys nothing.
    expect(ESTIMATE_NO_COST_MESSAGE).not.toBe(ESTIMATE_FAILED_MESSAGE);
  });

  it('never leaks the raw server string, and never prints the SDK developer message', () => {
    const err = new WorkflowEstimateError(failedSnapshot(), 'failed');
    const msg = estimateFailureMessage(err, () => {});
    // Positive control on the fixture: the raw text really IS reachable on the
    // error, so "the message does not contain it" is a claim about our mapping
    // and not about an empty fixture.
    expect(err.snapshot.error).toContain('Unique constraint failed');
    expect(msg).not.toContain('Unique constraint');
    expect(msg).not.toContain('prisma');
    expect(msg).not.toContain('user_email');
    // `err.message` is the SDK's developer-facing constant; it names the code and
    // points at `.snapshot.error`. It is safe to print but is not viewer copy.
    expect(err.message).toContain('.snapshot.error');
    expect(msg).not.toContain('.snapshot.error');
  });

  it('routes the server reason to the log so a failed estimate stays diagnosable', () => {
    const log = vi.fn();
    estimateFailureMessage(new WorkflowEstimateError(failedSnapshot(), 'failed'), log);
    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][1] as { code: string; serverError?: string };
    expect(payload.code).toBe('failed');
    expect(payload.serverError).toBe(RAW_SERVER_ERROR);
  });

  it('logs the review-preview refusal verbatim (the reviewer-facing diagnosis)', () => {
    const log = vi.fn();
    const err = new WorkflowEstimateError(failedSnapshot('not available in review preview'), 'failed');
    expect(estimateFailureMessage(err, log)).toBe(ESTIMATE_FAILED_MESSAGE);
    expect((log.mock.calls[0][1] as { serverError?: string }).serverError).toBe(
      'not available in review preview',
    );
  });

  it('passes a NON-estimate error through unchanged (transport timeouts etc.)', () => {
    const log = vi.fn();
    expect(estimateFailureMessage(new Error('request timed out after 30000ms'), log)).toBe(
      'request timed out after 30000ms',
    );
    // Nothing to diagnose from the SDK error class here — do not log a phantom.
    expect(log).not.toHaveBeenCalled();
  });

  it('falls back to generic copy for a non-Error throw', () => {
    expect(estimateFailureMessage('boom', () => {})).toBe('Something went wrong.');
  });
});
