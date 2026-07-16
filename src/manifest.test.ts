import { describe, expect, it } from 'vitest';

import { manifest, manifestBuzzBudgetPerGen, validateManifest } from './manifest.js';

describe('block.manifest.json', () => {
  it('validates against the SDK defineBlock gate (augmented to runtime shape)', () => {
    expect(() => validateManifest()).not.toThrow();
  });

  it('declares exactly the six scopes the app uses', () => {
    expect(manifest.scopes).toEqual([
      'ai:write:budgeted',
      'buzz:read:self',
      'apps:storage:read',
      'apps:storage:write',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
    ]);
  });

  it('is a generation-category page app', () => {
    expect(manifest.category).toBe('generation');
    expect((manifest.page as { path: string }).path).toBe('/');
  });

  it('caps buzzBudgetPerGen at the 1000 platform ceiling', () => {
    const budget = manifestBuzzBudgetPerGen();
    expect(budget).toBeDefined();
    expect(budget!).toBeLessThanOrEqual(1000);
  });
});
