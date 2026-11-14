// The Runner sends a saved sampler RESOLVED against its checkpoint's family
// (0.18.1). `runSampler.test.ts` pins the resolution on `buildSubmitBody`; this
// file pins the WIRING: that the Runner loads the catalog and hands it to the
// body builder, which a resolver nobody calls would pass the unit tests without.
//
// REGRESSION: the first case is RED on 0.18.0, which ignored the catalog at run
// time and estimated the stored value. The rest are INVARIANT guards on what the
// wiring must not change.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { parseGenerationSamplers } from '@civitai/app-sdk/blocks';

import { Runner } from './Runner.js';
import { palette } from '../theme.js';
import { checkpointFromPick, newButton, newGenerator } from '../lib/generator.js';
import { CHROMA_CKPT, SAMPLER_CATALOG, immediateSleep, mockWorkflow } from '../test-helpers.js';
import type { GenerationSamplersState } from '../platform/index.js';

const ready: GenerationSamplersState = { status: 'ready', catalog: parseGenerationSamplers(SAMPLER_CATALOG) };

/** A generator saved before the drop-down: Chroma, with a sampler Chroma does not offer. */
function staleConfig() {
  return newGenerator({
    name: 'Old',
    buttons: [
      newButton({
        id: 'b1',
        label: 'Go',
        checkpoint: checkpointFromPick(CHROMA_CKPT),
        promptTemplate: 'a fox',
        params: { steps: 20, quantity: 1, sampler: 'DPM++ 2M Karras' },
      }),
    ],
  });
}

function renderRunner(loadSamplers: (() => Promise<GenerationSamplersState>) | undefined, samplerWaitMs?: number) {
  const wf = mockWorkflow({ cost: 5, polls: 1 });
  render(
    <Runner
      config={staleConfig()}
      sharedContentKey="shared:1"
      c={palette()}
      canGenerate
      buzzBalance={5000}
      onRequestConsent={vi.fn()}
      uploadSourceImage={vi.fn()}
      estimate={wf.estimate}
      submit={wf.submit}
      poll={wf.poll}
      onBack={vi.fn()}
      loadSamplers={loadSamplers}
      samplerWaitMs={samplerWaitMs}
      pollIntervalMs={0}
      sleep={immediateSleep}
    />,
  );
  return wf;
}

async function pressAndReadSampler(wf: ReturnType<typeof mockWorkflow>) {
  await userEvent.click(screen.getByTestId('gen-button'));
  await waitFor(() => expect(wf.calls.estimate).toHaveLength(1));
  return wf.calls.estimate[0]!.params;
}

describe('Runner — a saved sampler is resolved against the catalog at run time', () => {
  it('REGRESSION: a sampler the family does not offer is estimated as the family default', async () => {
    const load = vi.fn(async () => ready);
    const wf = renderRunner(load);
    const params = await pressAndReadSampler(wf);
    expect(params.sampler).toBe('euler');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('INVARIANT: the catalog unavailable: the stored value is sent unchanged', async () => {
    const wf = renderRunner(async () => ({ status: 'unavailable', code: 'http-error' }));
    expect((await pressAndReadSampler(wf)).sampler).toBe('DPM++ 2M Karras');
  });

  it('INVARIANT: no catalog loader: the stored value is sent unchanged', async () => {
    const wf = renderRunner(undefined);
    expect((await pressAndReadSampler(wf)).sampler).toBe('DPM++ 2M Karras');
  });

  it('a catalog that never answers holds a press only for the bound, then sends the stored value', async () => {
    const wf = renderRunner(() => new Promise<GenerationSamplersState>(() => {}), 20);
    expect((await pressAndReadSampler(wf)).sampler).toBe('DPM++ 2M Karras');
  });

  it('INVARIANT: the runner is never shown the author note', async () => {
    renderRunner(async () => ready);
    await screen.findByTestId('gen-button');
    expect(screen.queryByTestId('sampler-saved-invalid')).toBeNull();
  });
});
