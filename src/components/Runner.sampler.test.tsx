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

import { App, type AppDeps } from '../App.js';
import { saveDraft } from '../lib/drafts.js';
import { createFakeCivitai, Harness } from '../platform/testing.js';
import { Runner } from './Runner.js';
import { palette } from '../theme.js';
import { checkpointFromPick, newButton, newGenerator } from '../lib/generator.js';
import { CHROMA_CKPT, SAMPLER_CATALOG, fakeShared, immediateSleep, memoryDraftStore, mockWorkflow } from '../test-helpers.js';
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

  it('a hung catalog delays only the FIRST press: later presses do not wait again', async () => {
    // A bound longer than `waitFor`'s 1000 ms default, so a second wait cannot pass.
    const wf = renderRunner(() => new Promise<GenerationSamplersState>(() => {}), 1500);
    await userEvent.click(screen.getByTestId('gen-button'));
    await waitFor(() => expect(wf.calls.estimate).toHaveLength(1), { timeout: 4000 });
    await userEvent.click(screen.getByTestId('gen-button'));
    await waitFor(() => expect(wf.calls.estimate).toHaveLength(2));
    expect(wf.calls.estimate[1]!.params.sampler).toBe('DPM++ 2M Karras');
  });

  it('a catalog that arrives after a timed-out press still corrects the next press', async () => {
    let answer!: (s: GenerationSamplersState) => void;
    const late = new Promise<GenerationSamplersState>((r) => {
      answer = r;
    });
    const wf = renderRunner(() => late, 20);
    expect((await pressAndReadSampler(wf)).sampler).toBe('DPM++ 2M Karras');
    answer(ready);
    await userEvent.click(screen.getByTestId('gen-button'));
    await waitFor(() => expect(wf.calls.estimate).toHaveLength(2));
    expect(wf.calls.estimate[1]!.params.sampler).toBe('euler');
  });

  it('INVARIANT: the runner is never shown the author note', async () => {
    renderRunner(async () => ready);
    await screen.findByTestId('gen-button');
    expect(screen.queryByTestId('sampler-saved-invalid')).toBeNull();
  });
});

/**
 * The SEAM: the App hands its catalog loader to the Runner. Every case above
 * renders `Runner` directly, and `loadSamplers` is optional, so deleting the
 * App's prop would pass typecheck and all of them. This drives a saved stale
 * draft through the whole App, with the catalog served by the fake platform's
 * `blocks/generation-samplers` route.
 */
describe('App → Runner — the run path gets the catalog', () => {
  it('REGRESSION: running a saved draft with an out-of-family sampler estimates the family default', async () => {
    const drafts = memoryDraftStore();
    await saveDraft(drafts, { id: 'gen_old', config: staleConfig(), updatedAt: 1 });
    const shared = fakeShared();
    const wf = mockWorkflow({ cost: 5, polls: 1 });
    const fake = createFakeCivitai({
      viewer: { id: 99, username: 'me' },
      consentGranted: true,
      buzz: { balance: 5000 },
      generationSamplers: SAMPLER_CATALOG,
    });
    const deps: Partial<AppDeps> = {
      resolveResources: async () => [],
      shared: shared.shared,
      updateSharedGenerator: shared.update,
      drafts,
      estimate: wf.estimate,
      submit: wf.submit,
      poll: wf.poll,
      pollIntervalMs: 0,
      sleep: immediateSleep,
    };
    render(
      <Harness fake={fake}>
        <App deps={deps} />
      </Harness>,
    );
    await userEvent.click(await screen.findByTestId('tab-mine'));
    await userEvent.click(await screen.findByTestId('draft-open'));
    await screen.findByTestId('runner');
    await userEvent.click(screen.getByTestId('gen-button'));
    await waitFor(() => expect(wf.calls.estimate).toHaveLength(1));
    expect(wf.calls.estimate[0]!.params.sampler).toBe('euler');
    // Positive control on the instrument: the catalog came over the fake route.
    expect(fake.calls.filter((c) => c.path === 'blocks/generation-samplers').length).toBeGreaterThan(0);
  });
});
