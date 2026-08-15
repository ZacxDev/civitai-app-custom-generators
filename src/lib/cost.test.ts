import { describe, expect, it } from 'vitest';

import { estimateRunCostBuzz, generatorCostRange, formatCostRange, BUZZ_BASE } from './cost.js';
import { buildPublishPayload, newButton } from './generator.js';
import type { GeneratorConfig, GenButtonParams } from '../types.js';

describe('estimateRunCostBuzz', () => {
  it('falls back to the app defaults (25 steps, 1024², qty 1) for empty params', () => {
    // BUZZ_BASE + 0.5 * 25 * 1 = 16.5 → round 17
    expect(estimateRunCostBuzz(undefined)).toBe(17);
    expect(estimateRunCostBuzz({})).toBe(17);
  });

  it('scales with steps, megapixels and quantity', () => {
    const cheap = estimateRunCostBuzz({ steps: 10, width: 512, height: 512, quantity: 1 });
    const dear = estimateRunCostBuzz({ steps: 40, width: 1024, height: 1024, quantity: 1 });
    expect(dear).toBeGreaterThan(cheap);

    const one = estimateRunCostBuzz({ steps: 20, width: 1024, height: 1024, quantity: 1 });
    const four = estimateRunCostBuzz({ steps: 20, width: 1024, height: 1024, quantity: 4 });
    expect(four).toBe(one * 4);
  });

  it('never returns below 1 and always a finite integer', () => {
    const c = estimateRunCostBuzz({ steps: 1, width: 64, height: 64, quantity: 1 });
    expect(Number.isInteger(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(1);
  });

  it('clamps a forged over-limit blob to the canonical bounds (no runaway figure)', () => {
    const forged = { steps: 9999, width: 99999, height: 99999, quantity: 999 } as unknown as GenButtonParams;
    const capped = estimateRunCostBuzz(forged);
    // clamps to steps 50, 2048², qty 4 → BUZZ_BASE + 0.5*50*4 * 4 = (4+400)*4
    const mp = (2048 * 2048) / (1024 * 1024);
    const expected = Math.round(BUZZ_BASE + 0.5 * 50 * mp) * 4;
    expect(capped).toBe(expected);
  });
});

describe('generatorCostRange', () => {
  it('returns the min/max across a generator\'s buttons', () => {
    const config: GeneratorConfig = {
      name: 'G',
      description: '',
      buttons: [
        newButton({ params: { steps: 10, width: 512, height: 512, quantity: 1 } }),
        newButton({ params: { steps: 40, width: 1024, height: 1024, quantity: 1 } }),
      ],
    };
    const range = generatorCostRange(buildPublishPayload(config));
    expect(range).not.toBeNull();
    expect(range!.min).toBeLessThan(range!.max);
  });

  it('returns null for a row with no buttons', () => {
    expect(generatorCostRange({ title: 'x', body: '', data: { v: 1, buttons: [] } })).toBeNull();
    expect(generatorCostRange({ title: 'x', body: '' })).toBeNull();
  });
});

describe('formatCostRange', () => {
  it('renders a single approximate figure when min === max', () => {
    expect(formatCostRange({ min: 17, max: 17 })).toBe('≈ 17 ⚡ per run');
  });
  it('renders a range when the buttons differ', () => {
    expect(formatCostRange({ min: 12, max: 34 })).toBe('≈ 12–34 ⚡ per run');
  });
  it('passes null through', () => {
    expect(formatCostRange(null)).toBeNull();
  });
});
