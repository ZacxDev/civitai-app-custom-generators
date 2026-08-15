import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import { Runner } from './Runner.js';
import { palette } from '../theme.js';
import { newButton, newGenerator } from '../lib/generator.js';
import { GENERATION_SOURCE_IMAGE, immediateSleep, mockWorkflow } from '../test-helpers.js';
import type { GeneratorConfig } from '../types.js';

const c = palette();

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
        loras: [{ versionId: 2002, weight: 0.8, minStrength: 0, maxStrength: 1.5 }],
        promptTemplate: 'cyberpunk {prompt}',
        params: { ...newButton().params, steps: 28, quantity: 1 },
      }),
    ],
  });
}

function imgConfig(): GeneratorConfig {
  return newGenerator({
    name: 'Remix',
    buttons: [
      newButton({
        id: 'i1',
        label: 'Remix',
        workflowType: 'img2img',
        checkpoint: { versionId: 1001, modelId: 500, modelName: 'DreamShaper', baseModel: 'SD 1.5' },
        promptTemplate: 'restyle {prompt}',
      }),
    ],
  });
}

function renderRunner(config: GeneratorConfig, over: Partial<Parameters<typeof Runner>[0]> = {}) {
  const wf = mockWorkflow({ cost: 42, images: ['res.jpg'], polls: 2 });
  const props = {
    config,
    sharedContentKey: 'shared:99',
    c,
    canGenerate: true,
    buzzBalance: 5000,
    onRequestConsent: vi.fn(),
    uploadSourceImage: vi.fn(async () => GENERATION_SOURCE_IMAGE),
    estimate: wf.estimate,
    submit: wf.submit,
    poll: wf.poll,
    onBack: vi.fn(),
    pollIntervalMs: 0,
    sleep: immediateSleep,
    ...over,
  };
  render(<Runner {...props} />);
  return { props, wf };
}

describe('Runner — submit body construction', () => {
  it('builds a txt2img estimate body: checkpoint + weighted LoRAs + params + sharedContentKey, NO sourceImage', async () => {
    const { wf } = renderRunner(txtConfig());
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));

    await waitFor(() => expect(wf.calls.estimate).toHaveLength(1));
    const body = wf.calls.estimate[0];
    expect(body).toMatchObject({ kind: 'textToImage', modelId: 500, modelVersionId: 1001 });
    expect(body.params.prompt).toBe('cyberpunk a fox');
    expect(body.params.steps).toBe(28);
    expect(body.additionalResources).toEqual([{ modelVersionId: 2002, strength: 0.8 }]);
    expect(body.sharedContentKey).toBe('shared:99');
    expect(body.sourceImage).toBeUndefined();
  });

  it('applies advanced param overrides (quantity) — via the pack Collapse + NumberInput', async () => {
    const { wf } = renderRunner(txtConfig());
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByRole('button', { name: /advanced/i }));
    await userEvent.type(screen.getByTestId('ov-quantity'), '4');
    await userEvent.click(screen.getByTestId('gen-button'));
    await waitFor(() => expect(wf.calls.estimate).toHaveLength(1));
    expect(wf.calls.estimate[0].params.quantity).toBe(4);
  });

  it('blocks an img2img run until a generationSource image is uploaded, then includes the REAL-dim sourceImage', async () => {
    const { wf, props } = renderRunner(imgConfig());
    // imgConfig exposes BOTH prompt + image — satisfy the prompt first to isolate
    // the image requirement.
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    // still no image → the gen button is DISABLED (not submittable), no estimate
    expect(screen.getByTestId('gen-button')).toBeDisabled();
    await userEvent.click(screen.getByTestId('gen-button'));
    expect(wf.calls.estimate).toHaveLength(0);

    // upload via the UNSCANNED generationSource dep → the button enables
    await userEvent.click(screen.getByTestId('upload-source'));
    // a preview THUMBNAIL now stands in for the old "Image ready" text
    const thumb = await screen.findByTestId('source-thumb');
    expect(thumb).toHaveAttribute('src', GENERATION_SOURCE_IMAGE.url);
    expect(props.uploadSourceImage).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('gen-button')).toBeEnabled());
    await userEvent.click(screen.getByTestId('gen-button'));
    await waitFor(() => expect(wf.calls.estimate).toHaveLength(1));
    // dims come from the mock RESULT (832×1216), NOT a hardcoded 1024×1024.
    expect(wf.calls.estimate[0].sourceImage).toEqual({
      url: GENERATION_SOURCE_IMAGE.url,
      width: GENERATION_SOURCE_IMAGE.width,
      height: GENERATION_SOURCE_IMAGE.height,
    });
    expect(wf.calls.estimate[0].sourceImage).not.toMatchObject({ width: 1024, height: 1024 });
  });
});

describe('Runner — estimate → confirm → submit → poll queue', () => {
  it('shows the estimated cost, then submits + polls to a rendered result', async () => {
    const { wf } = renderRunner(txtConfig());
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));

    // confirming state shows the estimated cost
    const cost = await screen.findByTestId('queue-cost');
    expect(cost).toHaveTextContent('42');
    expect(wf.calls.submit).toHaveLength(0);

    await userEvent.click(screen.getByTestId('queue-confirm'));

    // submit fires with the SAME body, then polls to succeeded + renders results
    await waitFor(() => expect(wf.calls.submit).toHaveLength(1));
    expect(wf.calls.submit[0].sharedContentKey).toBe('shared:99');
    const results = await screen.findByTestId('queue-results');
    const resultImg = within(results).getAllByTestId('result-image')[0];
    expect(resultImg).toHaveAttribute('src', 'res.jpg');
    // Adopted via the design-system Image primitive: native lazy-loading + the
    // pack's `data-civitai-ui="image"` container (placeholder/error handling).
    expect(resultImg).toHaveAttribute('loading', 'lazy');
    expect(resultImg.closest('[data-civitai-ui="image"]')).not.toBeNull();
  });

  it('classifies a failed submit that reads as insufficient Buzz into the top-up path', async () => {
    // 'Not enough Buzz.' matches the insufficient classifier → the typed
    // insufficient card (with an Add Buzz affordance), NOT the generic failure.
    const wf = mockWorkflow({ failSubmit: 'Not enough Buzz.' });
    renderRunner(txtConfig(), { estimate: wf.estimate, submit: wf.submit, poll: wf.poll });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    expect(await screen.findByTestId('queue-failed-insufficient')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-failed')).not.toBeInTheDocument();
  });

  it('surfaces a GENERIC failed submit (non-Buzz) in the queue with its raw error', async () => {
    const wf = mockWorkflow({ failSubmit: 'Orchestrator unavailable.' });
    renderRunner(txtConfig(), { estimate: wf.estimate, submit: wf.submit, poll: wf.poll });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    expect(await screen.findByTestId('queue-failed')).toHaveTextContent(/orchestrator unavailable/i);
    expect(screen.queryByTestId('queue-failed-insufficient')).not.toBeInTheDocument();
  });

  it('resolves a slow gen that terminates well past the old ~48s window (does not lose the result)', async () => {
    // 90 polls > the retired 60-poll cap; with an instant clock the duration
    // budget is never consumed, so the runner keeps polling and renders results.
    const wf = mockWorkflow({ cost: 42, images: ['slow.jpg'], polls: 90 });
    renderRunner(txtConfig(), { estimate: wf.estimate, submit: wf.submit, poll: wf.poll });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    const results = await screen.findByTestId('queue-results');
    expect(within(results).getAllByTestId('result-image')[0]).toHaveAttribute('src', 'slow.jpg');
  });

  it('marks a still-generating gen as `stalled` when the poll window trips — keeps the workflowId, no blank/failed card', async () => {
    // Never-terminal poll (always processing). A short bounded window forces a
    // cap-trip while still processing.
    const wf = mockWorkflow({ cost: 42, polls: Number.POSITIVE_INFINITY });
    renderRunner(txtConfig(), {
      estimate: wf.estimate,
      submit: wf.submit,
      poll: wf.poll,
      pollIntervalMs: 10,
      pollMaxDurationMs: 30, // ~3 polls then give up
    });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));

    // Graceful "still generating" state — NOT failed, NOT a blank spinner.
    expect(await screen.findByTestId('queue-stalled')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-failed')).not.toBeInTheDocument();
    const item = screen.getByTestId('queue-item');
    expect(item).toHaveAttribute('data-status', 'stalled');
    // "Check again" is offered so the retained workflowId is actionable.
    expect(screen.getByTestId('queue-check-again')).toBeInTheDocument();
  });

  it('a stalled gen recovers its result via "Check again" once the workflow finishes', async () => {
    // Stateful poll: processing until we flip it to succeeded before the retry.
    let done = false;
    const poll = vi.fn(async () =>
      done
        ? { workflowId: 'wf', status: 'succeeded' as const, imageUrls: ['recovered.jpg'] }
        : { workflowId: 'wf', status: 'processing' as const },
    );
    const submit = vi.fn(async () => ({ workflowId: 'wf', status: 'pending' as const }));
    const estimate = vi.fn(async () => ({ workflowId: 'wf', status: 'pending' as const, cost: { total: 42 } }));
    renderRunner(txtConfig(), {
      estimate,
      submit,
      poll,
      pollIntervalMs: 10,
      pollMaxDurationMs: 30,
    });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    await screen.findByTestId('queue-stalled');

    // The gen finishes server-side; user hits "Check again".
    done = true;
    await userEvent.click(screen.getByTestId('queue-check-again'));
    const results = await screen.findByTestId('queue-results');
    expect(within(results).getAllByTestId('result-image')[0]).toHaveAttribute('src', 'recovered.jpg');
  });
});

describe('Runner — img2img source thumbnail', () => {
  it('renders a preview thumbnail after upload and a Remove control that clears it', async () => {
    renderRunner(imgConfig());
    // no image yet → the empty-state affordance
    expect(screen.getByTestId('source-image-state')).toBeInTheDocument();
    expect(screen.queryByTestId('source-thumb')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('upload-source'));
    const thumb = await screen.findByTestId('source-thumb');
    expect(thumb).toHaveAttribute('src', GENERATION_SOURCE_IMAGE.url);
    // Replace control is offered alongside the thumbnail
    expect(screen.getByTestId('replace-source')).toBeInTheDocument();

    // Remove clears it → back to the empty state
    await userEvent.click(screen.getByTestId('remove-source'));
    await waitFor(() => expect(screen.queryByTestId('source-thumb')).not.toBeInTheDocument());
    expect(screen.getByTestId('source-image-state')).toBeInTheDocument();
  });
});

describe('Runner — prompt placeholder propagation', () => {
  it('uses the generator-authored promptPlaceholder on the prompt box', () => {
    const cfg = txtConfig();
    cfg.promptPlaceholder = 'a fox in the snow';
    renderRunner(cfg);
    expect(screen.getByTestId('runner-prompt')).toHaveAttribute('placeholder', 'a fox in the snow');
  });

  it('falls back to a sensible default when unset', () => {
    renderRunner(txtConfig());
    expect(screen.getByTestId('runner-prompt')).toHaveAttribute('placeholder', 'Describe what you want…');
  });
});

describe('Runner — inferred inputs (no exposedInputs flag)', () => {
  it('shows a prompt box because the template carries {prompt}', () => {
    renderRunner(txtConfig());
    expect(screen.getByTestId('runner-prompt')).toBeInTheDocument();
  });

  it('hides the prompt box for a fully-fixed prompt (no token)', () => {
    const cfg = newGenerator({
      name: 'Fixed',
      buttons: [newButton({ id: 'f1', label: 'Go', checkpoint: { versionId: 1, modelId: 1 }, promptTemplate: 'a fixed portrait' })],
    });
    renderRunner(cfg);
    expect(screen.queryByTestId('runner-prompt')).not.toBeInTheDocument();
  });

  it('shows the img2img source affordance for an img2img button', () => {
    renderRunner(imgConfig());
    expect(screen.getByTestId('source-image-state')).toBeInTheDocument();
  });

  it('does not show the img2img source affordance for a txt2img-only generator', () => {
    renderRunner(txtConfig());
    expect(screen.queryByTestId('source-image-state')).not.toBeInTheDocument();
    expect(screen.queryByTestId('upload-source')).not.toBeInTheDocument();
  });
});

describe('Runner — live preview mode (non-runnable)', () => {
  it('shows a Preview badge, no Back, and pressing a button does NOT estimate', async () => {
    const { wf } = renderRunner(txtConfig(), { preview: true, buzzBalance: null });
    expect(screen.getByTestId('runner-preview-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('runner-back')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('gen-button'));
    // a note is surfaced instead of an estimate/spend
    expect(await screen.findByTestId('runner-error')).toHaveTextContent(/preview/i);
    expect(wf.calls.estimate).toHaveLength(0);
    expect(screen.queryByTestId('queue-item')).not.toBeInTheDocument();
  });
});

describe('Runner — header cover banner (moderated headerUrl only)', () => {
  it('renders the banner from the resolved moderated headerUrl prop', () => {
    const cfg = txtConfig();
    // The stored (unmoderated) url is a forged tracker — it must never be used.
    cfg.headerImageRef = { imageId: 424242, url: 'https://evil.tracker/beacon.gif' };
    renderRunner(cfg, { headerUrl: 'https://image.civitai.com/moderated-header.jpeg' });
    const banner = screen.getByTestId('runner-header-banner');
    expect(banner.tagName).toBe('IMG');
    expect(banner).toHaveAttribute('src', 'https://image.civitai.com/moderated-header.jpeg');
    // it's the new top cover banner, NOT the retired CSS backdrop element
    expect(screen.queryByTestId('runner-background')).not.toBeInTheDocument();
  });

  it('renders no banner when no headerUrl is resolved', () => {
    renderRunner(txtConfig());
    expect(screen.queryByTestId('runner-header-banner')).not.toBeInTheDocument();
  });

  it('🔴 NEVER renders the banner from the stored headerImageRef.url (no resolved headerUrl)', () => {
    // A forged/unmoderated stored url present in config but NO headerUrl resolved
    // (hidden / withheld from this viewer) → the Runner shows nothing.
    const cfg = txtConfig();
    cfg.headerImageRef = { imageId: 7, url: 'https://evil.tracker/beacon.gif' };
    renderRunner(cfg, { headerUrl: null });
    expect(screen.queryByTestId('runner-header-banner')).not.toBeInTheDocument();
  });
});

describe('Runner — consent gate', () => {
  it('requests consent instead of generating when the budget scope is not granted', async () => {
    const onRequestConsent = vi.fn();
    const { wf } = renderRunner(txtConfig(), { canGenerate: false, onRequestConsent });
    expect(screen.getByTestId('consent-needed')).toBeInTheDocument();
    // fill the required prompt so the button is enabled — the consent gate is a
    // separate concern from input-completeness.
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    expect(onRequestConsent).toHaveBeenCalled();
    expect(wf.calls.estimate).toHaveLength(0);
  });
});

describe('Runner — required exposed inputs gate the run control', () => {
  // A txt2img button with a FIXED prompt template (no {prompt}) — exposes neither
  // a prompt nor an image input.
  function fixedConfig(): GeneratorConfig {
    return newGenerator({
      name: 'Fixed',
      buttons: [
        newButton({
          id: 'x1',
          label: 'Go',
          workflowType: 'txt2img',
          checkpoint: { versionId: 1001, modelId: 500, modelName: 'DreamShaper', baseModel: 'SD 1.5' },
          promptTemplate: 'a fixed portrait',
        }),
      ],
    });
  }

  // An img2img button whose template is fixed — exposes ONLY the image input.
  function imgOnlyConfig(): GeneratorConfig {
    return newGenerator({
      name: 'ImgOnly',
      buttons: [
        newButton({
          id: 'o1',
          label: 'Remix',
          workflowType: 'img2img',
          checkpoint: { versionId: 1001, modelId: 500, modelName: 'DreamShaper', baseModel: 'SD 1.5' },
          promptTemplate: 'restyle',
        }),
      ],
    });
  }

  it('(a) prompt-required button: run disabled while prompt empty/whitespace, enabled once filled', async () => {
    const { wf } = renderRunner(txtConfig());
    const btn = screen.getByTestId('gen-button');
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('runner-required-hint')).toHaveTextContent(/enter a prompt/i);

    // whitespace-only is still empty
    await userEvent.type(screen.getByTestId('runner-prompt'), '   ');
    expect(btn).toBeDisabled();

    await userEvent.clear(screen.getByTestId('runner-prompt'));
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    expect(btn).toBeEnabled();
    expect(screen.queryByTestId('runner-required-hint')).not.toBeInTheDocument();

    await userEvent.click(btn);
    await waitFor(() => expect(wf.calls.estimate).toHaveLength(1));
  });

  it('(b) image-required button: run disabled with no image, enabled once uploaded', async () => {
    const { wf } = renderRunner(imgOnlyConfig());
    // no prompt box for a fixed-template img2img button
    expect(screen.queryByTestId('runner-prompt')).not.toBeInTheDocument();
    const btn = screen.getByTestId('gen-button');
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('runner-required-hint')).toHaveTextContent(/source image/i);

    await userEvent.click(screen.getByTestId('upload-source'));
    await screen.findByTestId('source-thumb');
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    await waitFor(() => expect(wf.calls.estimate).toHaveLength(1));
  });

  it('(c) button exposing BOTH: run disabled until prompt AND image are both provided', async () => {
    renderRunner(imgConfig());
    const btn = screen.getByTestId('gen-button');
    expect(btn).toBeDisabled();

    // prompt only → still blocked on the image
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('runner-required-hint')).toHaveTextContent(/source image/i);

    // add the image → now runnable
    await userEvent.click(screen.getByTestId('upload-source'));
    await screen.findByTestId('source-thumb');
    await waitFor(() => expect(btn).toBeEnabled());
  });

  it('(d) button exposing NEITHER is unaffected: runnable immediately, no hint', async () => {
    const { wf } = renderRunner(fixedConfig());
    const btn = screen.getByTestId('gen-button');
    expect(btn).toBeEnabled();
    expect(screen.queryByTestId('runner-required-hint')).not.toBeInTheDocument();
    await userEvent.click(btn);
    await waitFor(() => expect(wf.calls.estimate).toHaveLength(1));
  });
});

describe('Runner — money-path balance guard (ship-blocker #2)', () => {
  it('blocks Confirm and warns when the estimate exceeds the balance', async () => {
    // cost 42 > balance 10 → Confirm is replaced by an Add-Buzz affordance + warning.
    const { wf } = renderRunner(txtConfig(), {
      buzzBalance: 10,
      onTopUp: vi.fn(async () => ({ purchased: false })),
    });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));

    await screen.findByTestId('queue-cost');
    expect(screen.getByTestId('queue-insufficient')).toHaveTextContent(/add buzz/i);
    // no Confirm control (can't afford) → the submit never fires
    expect(screen.queryByTestId('queue-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('queue-topup')).toBeInTheDocument();
    expect(wf.calls.submit).toHaveLength(0);
  });

  it('enables Confirm normally when the balance covers the estimate', async () => {
    renderRunner(txtConfig(), { buzzBalance: 5000 });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    expect(await screen.findByTestId('queue-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-insufficient')).not.toBeInTheDocument();
  });

  it('concurrent double-confirm: the 2nd gen lands in the top-up path once the 1st reserves the balance', async () => {
    // Each gen costs 30 and is individually affordable (30 <= 50), but running
    // both would exceed the wallet. The first, once in-flight, RESERVES its 30 so
    // the second sees only 20 available → insufficient (no server round-trip).
    const wf = mockWorkflow({ cost: 30 });
    const hangingPoll = (): Promise<BlockWorkflowSnapshot> => new Promise<BlockWorkflowSnapshot>(() => {});
    renderRunner(txtConfig(), {
      buzzBalance: 50,
      estimate: wf.estimate,
      submit: wf.submit,
      poll: hangingPoll,
      onTopUp: vi.fn(async () => ({ purchased: false })),
    });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');

    // gen A → confirm (affordable) → A goes in-flight (submitting) and hangs there
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    await waitFor(() => expect(screen.getByTestId('queue-item')).toHaveAttribute('data-status', 'submitting'));

    // gen B → individually affordable, but 30 > (50 − 30 reserved) → insufficient
    await userEvent.click(screen.getByTestId('gen-button'));
    expect(await screen.findByTestId('queue-insufficient')).toHaveTextContent(/still running/i);
    expect(screen.getByTestId('queue-topup')).toBeInTheDocument();
    // no Confirm anywhere: A is submitting, B is gated on the top-up path
    expect(screen.queryByTestId('queue-confirm')).not.toBeInTheDocument();
  });
});

describe('Runner — insufficient-Buzz top-up (ship-blocker #3)', () => {
  it('invokes the purchase modal from the pre-submit guard and re-enables Confirm after a top-up', async () => {
    const onTopUp = vi.fn(async () => ({ purchased: true, newBalance: 100 }));
    const onBalanceRefresh = vi.fn();
    // cost 42, balance 10 → insufficient; a purchase lifts the local balance to 100.
    renderRunner(txtConfig(), { buzzBalance: 10, onTopUp, onBalanceRefresh });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));

    await userEvent.click(await screen.findByTestId('queue-topup'));
    expect(onTopUp).toHaveBeenCalled();
    expect(onBalanceRefresh).toHaveBeenCalled();
    // balance badge reflects the new balance and Confirm is now available
    await waitFor(() => expect(screen.getByTestId('runner-balance')).toHaveTextContent('100'));
    expect(await screen.findByTestId('queue-confirm')).toBeInTheDocument();
  });

  it('a failed submit classified as insufficient offers a top-up (typed, not a generic error)', async () => {
    const onTopUp = vi.fn(async () => ({ purchased: true, newBalance: 9000 }));
    const wf = mockWorkflow({ failSubmit: 'Insufficient Buzz to run this generation.' });
    renderRunner(txtConfig(), { estimate: wf.estimate, submit: wf.submit, poll: wf.poll, onTopUp });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));

    const card = await screen.findByTestId('queue-failed-insufficient');
    expect(card).toBeInTheDocument();
    await userEvent.click(within(card).getByTestId('queue-failed-topup'));
    expect(onTopUp).toHaveBeenCalled();
  });
});

describe('Runner — partial-failure clarity (ship-blocker #6)', () => {
  it('messages "N of M" when fewer images return than the requested quantity', async () => {
    // request 4 (via advanced override), only 2 come back → partial notice.
    const wf = mockWorkflow({ cost: 12, images: ['a.jpg', 'b.jpg'], polls: 1 });
    renderRunner(txtConfig(), { estimate: wf.estimate, submit: wf.submit, poll: wf.poll });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByRole('button', { name: /advanced/i }));
    await userEvent.type(screen.getByTestId('ov-quantity'), '4');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));

    const partial = await screen.findByTestId('queue-partial');
    expect(partial).toHaveTextContent('2 of 4');
    expect(within(await screen.findByTestId('queue-results')).getAllByTestId('result-image')).toHaveLength(2);
  });

  it('shows NO partial notice when every requested image returns', async () => {
    const wf = mockWorkflow({ cost: 12, images: ['only.jpg'], polls: 1 });
    renderRunner(txtConfig(), { estimate: wf.estimate, submit: wf.submit, poll: wf.poll });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    await screen.findByTestId('queue-results');
    expect(screen.queryByTestId('queue-partial')).not.toBeInTheDocument();
  });
});

describe('Runner — result actions (feature #10)', () => {
  it('offers copy-image-link (sandbox-legal), a re-run, and open-in-generator on a succeeded gen', async () => {
    const onOpenInGenerator = vi.fn();
    // The sandbox-legal "save" affordance: copy the image url to the clipboard
    // (a file download / new tab is blocked for an unverified block).
    const onCopyImageLink = vi.fn(async () => true);
    const { wf } = renderRunner(txtConfig(), { onOpenInGenerator, onCopyImageLink });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    await screen.findByTestId('queue-results');

    const actions = screen.getByTestId('result-actions');
    const copy = within(actions).getAllByTestId('result-copy-link');
    await userEvent.click(copy[0]);
    // copied the image url via the host-clipboard seam, and confirmed inline
    await waitFor(() => expect(onCopyImageLink).toHaveBeenCalledWith('res.jpg'));
    await waitFor(() => expect(copy[0]).toHaveTextContent(/link copied/i));
    // never a silent failure, never a raw error
    expect(screen.queryByTestId('runner-error')).not.toBeInTheDocument();

    // open-in-generator delegates to the host navigation
    await userEvent.click(within(actions).getByTestId('result-open-generator'));
    expect(onOpenInGenerator).toHaveBeenCalled();

    // re-run enqueues a fresh estimate with the SAME body
    const before = wf.calls.estimate.length;
    await userEvent.click(within(actions).getByTestId('result-rerun'));
    await waitFor(() => expect(wf.calls.estimate.length).toBe(before + 1));
    expect(wf.calls.estimate.at(-1)?.params.prompt).toBe('cyberpunk a fox');
  });

  it('a failed copy surfaces a recoverable notice — never a silent failure', async () => {
    const onCopyImageLink = vi.fn(async () => false); // host clipboard unavailable
    renderRunner(txtConfig(), { onCopyImageLink });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    await screen.findByTestId('queue-results');

    await userEvent.click(within(screen.getByTestId('result-actions')).getAllByTestId('result-copy-link')[0]);
    expect(await screen.findByTestId('runner-error')).toHaveTextContent(/couldn't copy the image link/i);
  });

  it('hides the copy affordance entirely when no clipboard seam is provided (no dead button)', async () => {
    renderRunner(txtConfig()); // default renderRunner passes no onCopyImageLink
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    await screen.findByTestId('queue-results');
    expect(screen.queryByTestId('result-copy-link')).not.toBeInTheDocument();
  });
});

describe('Runner — consent revocation mid-session re-gates the run (test coverage)', () => {
  it('re-gates generation when the generate scope is revoked mid-session', async () => {
    const onRequestConsent = vi.fn();
    const wf = mockWorkflow({ cost: 42, images: ['res.jpg'], polls: 2 });
    const baseProps = {
      config: txtConfig(),
      sharedContentKey: 'shared:99',
      c,
      buzzBalance: 5000,
      onRequestConsent,
      uploadSourceImage: vi.fn(async () => GENERATION_SOURCE_IMAGE),
      estimate: wf.estimate,
      submit: wf.submit,
      poll: wf.poll,
      onBack: vi.fn(),
      pollIntervalMs: 0,
      sleep: immediateSleep,
    };
    const { rerender } = render(<Runner {...baseProps} canGenerate />);
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    expect(screen.queryByTestId('consent-needed')).not.toBeInTheDocument();

    // consent revoked upstream (token scope dropped) → canGenerate flips false.
    rerender(<Runner {...baseProps} canGenerate={false} />);
    expect(screen.getByTestId('consent-needed')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('gen-button'));
    expect(onRequestConsent).toHaveBeenCalled();
    expect(wf.calls.estimate).toHaveLength(0); // never estimated once re-gated
  });
});

describe('Runner — rehydration-failure notice (feature #12)', () => {
  it('shows a non-blocking notice when passed a rehydrateNotice', () => {
    renderRunner(txtConfig(), { rehydrateNotice: "Couldn't refresh model details." });
    expect(screen.getByTestId('runner-rehydrate-notice')).toHaveTextContent(/couldn't refresh/i);
  });
});

describe('Runner — feed reassurance + leave-guard (ephemeral-queue safety)', () => {
  it('always shows the persistent "saved to your Civitai feed" reassurance', () => {
    renderRunner(txtConfig());
    expect(screen.getByTestId('runner-feed-note')).toHaveTextContent(/saved to your civitai feed/i);
  });

  it('Back with NO in-flight work navigates immediately (no confirm)', async () => {
    const { props } = renderRunner(txtConfig());
    await userEvent.click(screen.getByTestId('runner-back'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('leave-confirm-modal')).not.toBeInTheDocument();
  });

  it('Back WHILE a gen is in flight confirms first; Stay cancels, Leave navigates', async () => {
    // A submit that never resolves keeps an item in the non-terminal 'submitting'
    // state so the leave-guard is armed.
    const estimate = async (): Promise<BlockWorkflowSnapshot> => ({ workflowId: 'wf', status: 'pending', cost: { total: 10 } });
    const submit = () => new Promise<BlockWorkflowSnapshot>(() => {}); // pending forever
    const onBack = vi.fn();
    render(
      <Runner
        config={txtConfig()}
        c={c}
        canGenerate
        buzzBalance={5000}
        onRequestConsent={vi.fn()}
        uploadSourceImage={vi.fn(async () => GENERATION_SOURCE_IMAGE)}
        estimate={estimate}
        submit={submit}
        poll={async () => ({ workflowId: 'wf', status: 'processing' })}
        onBack={onBack}
        pollIntervalMs={0}
        sleep={immediateSleep}
      />,
    );
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    // now 'submitting' (in-flight) — pill shows the human label; the raw token
    // still rides on the card's data-status.
    await waitFor(() => expect(screen.getByTestId('queue-status')).toHaveTextContent('Submitting'));
    expect(screen.getByTestId('queue-item')).toHaveAttribute('data-status', 'submitting');

    // Back → confirm modal, onBack NOT yet called
    await userEvent.click(screen.getByTestId('runner-back'));
    expect(await screen.findByTestId('leave-confirm-modal')).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();

    // Stay → modal closes, still on the runner
    await userEvent.click(screen.getByTestId('leave-cancel'));
    await waitFor(() => expect(screen.queryByTestId('leave-confirm-modal')).not.toBeInTheDocument());
    expect(onBack).not.toHaveBeenCalled();

    // Back again → Leave anyway → navigates
    await userEvent.click(screen.getByTestId('runner-back'));
    await screen.findByTestId('leave-confirm-modal');
    await userEvent.click(screen.getByTestId('leave-confirm'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('Runner — confirm double-charge guard (in-flight guard)', () => {
  it('submits exactly once and removes the Confirm affordance after confirming', async () => {
    const { wf } = renderRunner(txtConfig());
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    const confirm = await screen.findByTestId('queue-confirm');
    await userEvent.click(confirm);
    // exactly one paid submit, and the confirm button is gone (can't re-confirm)
    await waitFor(() => expect(wf.calls.submit).toHaveLength(1));
    expect(screen.queryByTestId('queue-confirm')).not.toBeInTheDocument();
  });
});
