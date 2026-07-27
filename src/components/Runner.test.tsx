import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Runner } from './Runner.js';
import { palette } from '../theme.js';
import { newButton, newGenerator, parsePublishedGenerator } from '../lib/generator.js';
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
    expect(within(results).getAllByTestId('result-image')[0]).toHaveAttribute('src', 'res.jpg');
  });

  it('surfaces a failed submit (e.g. insufficient Buzz) in the queue', async () => {
    const wf = mockWorkflow({ failSubmit: 'Not enough Buzz.' });
    renderRunner(txtConfig(), { estimate: wf.estimate, submit: wf.submit, poll: wf.poll });
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    expect(await screen.findByTestId('queue-failed')).toHaveTextContent(/enough Buzz/i);
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

describe('Runner — header cover banner', () => {
  const HEADER = { imageId: 424242, url: 'https://image.civitai.com/header.jpeg' };

  it('renders the header image as a top cover banner when set', () => {
    const cfg = txtConfig();
    cfg.headerImageRef = HEADER;
    renderRunner(cfg);
    const banner = screen.getByTestId('runner-header-banner');
    expect(banner.tagName).toBe('IMG');
    expect(banner).toHaveAttribute('src', HEADER.url);
    // it's the new top cover banner, NOT the retired CSS backdrop element
    expect(screen.queryByTestId('runner-background')).not.toBeInTheDocument();
  });

  it('renders no banner when the generator has no header image', () => {
    renderRunner(txtConfig());
    expect(screen.queryByTestId('runner-header-banner')).not.toBeInTheDocument();
  });

  it('BACK-COMPAT: a stored value with the OLD backgroundImageRef still renders the header banner', () => {
    // Simulate an already-published row from before the rename: its cover lives
    // under the legacy `backgroundImageRef`. parsePublishedGenerator must surface
    // it as headerImageRef so the runner still shows the banner.
    const legacyValue = {
      title: 'Legacy Gen',
      body: 'desc',
      data: {
        v: 1 as const,
        buttons: [
          {
            id: 'l1',
            label: 'Go',
            workflowType: 'txt2img' as const,
            checkpoint: { versionId: 1001, modelId: 500 },
            loras: [],
            promptTemplate: 'neon {prompt}',
            params: newButton().params,
          },
        ],
        backgroundImageRef: { imageId: 9, url: 'https://image.civitai.com/legacy.jpeg' },
      },
    };
    const cfg = parsePublishedGenerator(legacyValue);
    expect(cfg).not.toBeNull();
    renderRunner(cfg!);
    expect(screen.getByTestId('runner-header-banner')).toHaveAttribute('src', 'https://image.civitai.com/legacy.jpeg');
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
