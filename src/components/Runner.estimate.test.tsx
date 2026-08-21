// The ESTIMATE-REJECTION path (@civitai/blocks-react >= 0.43.0, civitai/civitai#4159).
//
// `useBuzzWorkflow().estimate()` used to RESOLVE a host failure-snapshot that
// carried no `cost`. The Runner then moved the queue item to `confirming` and
// rendered "≈ — ⚡" with Confirm ENABLED — a dialog offering to spend an unknown
// amount of Buzz — while the server's own explanation was dropped on the floor.
//
// 0.43.0 makes that reply REJECT with `WorkflowEstimateError`. These tests pin
// what the Runner does with it:
//   1. the queue item fails with VIEWER-SAFE copy (not the SDK's developer
//      string, and never the unsanitised server text);
//   2. both producers (`failed` / `no-cost`) are distinguishable to the viewer;
//   3. the re-run path behaves identically;
//   4. an UNPRICED resolve is still treated as a failure — `estimate` is an
//      injected prop, so the hook's own guard is not the only thing on this path.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowEstimateError } from '@civitai/blocks-react';
import type { BlockWorkflowSnapshot, WorkflowBody } from '@civitai/app-sdk/blocks';

import { Runner } from './Runner.js';
import { palette } from '../theme.js';
import { newButton, newGenerator } from '../lib/generator.js';
import { immediateSleep, mockWorkflow } from '../test-helpers.js';
import { ESTIMATE_FAILED_MESSAGE, ESTIMATE_NO_COST_MESSAGE } from '../lib/estimate.js';
import type { GeneratorConfig } from '../types.js';

const c = palette();

const RAW_SERVER_ERROR =
  'Invalid `prisma.workflow.create()` invocation: Unique constraint failed on the fields: (`user_email`)';

function txtConfig(): GeneratorConfig {
  return newGenerator({
    name: 'Neon',
    description: 'desc',
    buttons: [
      newButton({
        id: 'b1',
        label: 'Cyberpunk',
        workflowType: 'txt2img',
        checkpoint: { versionId: 1001, modelId: 500, modelName: 'DreamShaper', baseModel: 'SD 1.5' },
        promptTemplate: 'cyberpunk {prompt}',
        params: { ...newButton().params, steps: 28, quantity: 1 },
      }),
    ],
  });
}

function renderRunner(estimate: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>) {
  const wf = mockWorkflow({ cost: 42, images: ['res.jpg'], polls: 1 });
  render(
    <Runner
      config={txtConfig()}
      sharedContentKey="shared:99"
      c={c}
      canGenerate
      buzzBalance={5000}
      onRequestConsent={vi.fn()}
      uploadSourceImage={vi.fn()}
      estimate={estimate}
      submit={wf.submit}
      poll={wf.poll}
      onBack={vi.fn()}
      pollIntervalMs={0}
      sleep={immediateSleep}
    />,
  );
  return wf;
}

async function press() {
  await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
  await userEvent.click(screen.getByTestId('gen-button'));
}

describe('Runner — estimate() REJECTS (blocks-react >= 0.43)', () => {
  it('a code "failed" rejection fails the queue item with viewer-safe copy', async () => {
    const snap: BlockWorkflowSnapshot = { workflowId: 'failed', status: 'failed', error: RAW_SERVER_ERROR };
    renderRunner(async () => {
      throw new WorkflowEstimateError(snap, 'failed');
    });
    await press();

    const alert = await screen.findByTestId('queue-failed');
    expect(alert).toHaveTextContent(ESTIMATE_FAILED_MESSAGE);
    // Never the unsanitised server string...
    expect(alert.textContent ?? '').not.toContain('Unique constraint');
    expect(alert.textContent ?? '').not.toContain('prisma');
    // ...and never the SDK's developer-facing message.
    expect(alert.textContent ?? '').not.toContain('.snapshot.error');
    // The dead confirm dialog #4159 produced must be gone.
    expect(screen.queryByTestId('queue-confirm')).toBeNull();
    expect(screen.queryByTestId('queue-cost')).toBeNull();
  });

  it('a code "no-cost" rejection gets its OWN copy', async () => {
    const snap: BlockWorkflowSnapshot = { workflowId: 'wf', status: 'pending' };
    renderRunner(async () => {
      throw new WorkflowEstimateError(snap, 'no-cost');
    });
    await press();

    expect(await screen.findByTestId('queue-failed')).toHaveTextContent(ESTIMATE_NO_COST_MESSAGE);
  });

  it('the MODERATOR REVIEW PREVIEW refusal renders as a normal failed card, not a crash', async () => {
    // While an app is under review the host short-circuits every workflow
    // request with this snapshot — a reviewer's FIRST click hits this path.
    const snap: BlockWorkflowSnapshot = {
      workflowId: 'failed',
      status: 'failed',
      error: 'not available in review preview',
    };
    renderRunner(async () => {
      throw new WorkflowEstimateError(snap, 'failed');
    });
    await press();

    expect(await screen.findByTestId('queue-failed')).toHaveTextContent(ESTIMATE_FAILED_MESSAGE);
    expect(screen.getByTestId('runner')).toBeInTheDocument(); // still mounted, not error-boundaried
  });

  it('the RE-RUN path handles a rejection the same way', async () => {
    let calls = 0;
    const snap: BlockWorkflowSnapshot = { workflowId: 'failed', status: 'failed', error: RAW_SERVER_ERROR };
    renderRunner(async () => {
      calls += 1;
      if (calls === 1) return { workflowId: 'wf', status: 'pending', cost: { total: 42 } };
      throw new WorkflowEstimateError(snap, 'failed');
    });
    await press();

    // First estimate priced fine → confirm → succeed, so a Re-run control exists.
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    await userEvent.click(await screen.findByTestId('result-rerun'));

    await waitFor(() => expect(calls).toBe(2));
    const alert = await screen.findByTestId('queue-failed');
    expect(alert).toHaveTextContent(ESTIMATE_FAILED_MESSAGE);
    expect(alert.textContent ?? '').not.toContain('Unique constraint');
  });
});

describe('Runner — an UNPRICED resolve is not a quote you may spend against', () => {
  it('a resolved snapshot with no numeric cost fails instead of offering Confirm', async () => {
    // blocks-react >= 0.43 rejects this shape, but `estimate` is an injected
    // prop — this is the block-side half of the #4159 gate.
    renderRunner(async () => ({ workflowId: 'wf', status: 'pending' }));
    await press();

    expect(await screen.findByTestId('queue-failed')).toHaveTextContent(ESTIMATE_NO_COST_MESSAGE);
    expect(screen.queryByTestId('queue-confirm')).toBeNull();
  });

  it('a cost of ZERO is a REAL price and still confirms (whatIf cache hit)', async () => {
    renderRunner(async () => ({ workflowId: 'wf', status: 'pending', cost: { total: 0 } }));
    await press();

    expect(await screen.findByTestId('queue-confirm')).toBeEnabled();
    expect(screen.getByTestId('queue-cost')).toHaveTextContent('0');
    expect(screen.queryByTestId('queue-failed')).toBeNull();
  });
});
