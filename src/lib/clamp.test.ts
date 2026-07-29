// Ship-blocker #1: range-clamp untrusted published `params` on the run path.
// A published generator's params come from the opaque, unmoderated shared `data`
// blob, so a forged row could carry `quantity:999` (a real spend-abuse vector).
// These prove the clamp pulls every over-limit value to the Builder/server range
// AND that the reconstructed submit body inherits the clamped values.

import { describe, expect, it } from 'vitest';

import {
  MAX_LORAS,
  PARAM_BOUNDS,
  buildSubmitBody,
  clampParams,
  parsePublishedGenerator,
} from './generator.js';
import type { SharedStorageValue } from '@civitai/app-sdk/blocks';

describe('clampParams — untrusted param range clamping', () => {
  it('clamps every over-limit numeric down to its PARAM_BOUNDS max', () => {
    const out = clampParams({ quantity: 999, steps: 500, width: 9999, height: 8888, cfgScale: 100, seed: 123 });
    expect(out.quantity).toBe(PARAM_BOUNDS.quantity.max); // 4
    expect(out.steps).toBe(PARAM_BOUNDS.steps.max); // 50
    expect(out.width).toBe(PARAM_BOUNDS.width.max); // 2048
    expect(out.height).toBe(PARAM_BOUNDS.height.max); // 2048
    expect(out.cfgScale).toBe(PARAM_BOUNDS.cfgScale.max); // 30
    expect(out.seed).toBe(123); // in-range seed preserved
  });

  it('clamps under-limit numerics up to the min and leaves in-range values alone', () => {
    const out = clampParams({ quantity: 0, steps: 0, width: 1, cfgScale: -5, height: 1024 });
    expect(out.quantity).toBe(PARAM_BOUNDS.quantity.min); // 1
    expect(out.steps).toBe(PARAM_BOUNDS.steps.min); // 1
    expect(out.width).toBe(PARAM_BOUNDS.width.min); // 64
    expect(out.cfgScale).toBe(PARAM_BOUNDS.cfgScale.min); // 1
    expect(out.height).toBe(1024);
  });

  it('keeps a null seed (orchestrator-random) but clamps a negative seed to 0', () => {
    expect(clampParams({ seed: null }).seed).toBeNull();
    expect(clampParams({ seed: -42 }).seed).toBe(0);
  });

  it('drops non-numeric / NaN params (orchestrator defaults apply) and passes free-text through', () => {
    const out = clampParams({
      quantity: Number.NaN,
      steps: 'lots' as unknown as number,
      negativePrompt: 'blurry',
      sampler: 'Euler',
    });
    expect('quantity' in out).toBe(false);
    expect('steps' in out).toBe(false);
    expect(out.negativePrompt).toBe('blurry');
    expect(out.sampler).toBe('Euler');
  });
});

describe('parsePublishedGenerator — forged over-limit blob is clamped on the run path', () => {
  it('clamps a forged quantity:999 row to the max, caps the LoRA stack, and the submit body inherits it', () => {
    const forged: SharedStorageValue = {
      title: 'Forged',
      body: 'evil',
      data: {
        v: 1,
        buttons: [
          {
            id: 'x',
            label: 'Spend it all',
            workflowType: 'txt2img',
            checkpoint: { versionId: 1001, modelId: 500 },
            // 7 LoRAs (> MAX_LORAS) — must be capped.
            loras: Array.from({ length: 7 }, (_, i) => ({ versionId: 3000 + i, weight: 1 })),
            promptTemplate: 'neon {prompt}',
            params: { quantity: 999, steps: 9999, width: 99999, height: 99999, cfgScale: 999 },
          },
        ],
      },
    } as unknown as SharedStorageValue;

    const cfg = parsePublishedGenerator(forged);
    expect(cfg).not.toBeNull();
    const btn = cfg!.buttons[0];
    expect(btn.params.quantity).toBe(4);
    expect(btn.params.steps).toBe(50);
    expect(btn.params.width).toBe(2048);
    expect(btn.params.height).toBe(2048);
    expect(btn.params.cfgScale).toBe(30);
    expect(btn.loras).toHaveLength(MAX_LORAS);

    const body = buildSubmitBody(btn, { promptInput: 'a fox' });
    expect(body.params.quantity).toBe(4);
    expect(body.additionalResources).toHaveLength(MAX_LORAS);
  });
});
