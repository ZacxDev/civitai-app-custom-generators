import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { manifest, manifestBuzzBudgetPerGen, validateManifest } from './manifest.js';

describe('block.manifest.json', () => {
  it('validates against the SDK defineBlock gate (augmented to runtime shape)', () => {
    expect(() => validateManifest()).not.toThrow();
  });

  it('declares exactly the seven scopes the app uses', () => {
    expect(manifest.scopes).toEqual([
      'ai:write:budgeted',
      'buzz:read:self',
      'apps:storage:read',
      'apps:storage:write',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
      'posts:write:self',
    ]);
  });

  /**
   * 🔴 A SENSITIVE SCOPE WITHOUT A JUSTIFICATION IS REJECTED AT SUBMIT, NOT AT
   * BUILD. `defineBlock` above is a SHAPE gate — it does not enforce the
   * justification requirement (the schema says so in as many words: *"enforced
   * imperatively by the manifest validator"*), so a manifest that declares
   * `posts:write:self` and forgets the rationale typechecks, builds, tests green
   * and is then turned down by the platform at the one point where the feedback
   * loop is a human review round. That is exactly the shape of defect worth
   * pinning locally.
   *
   * Asserted as a RELATIONSHIP over every declared scope rather than a list of
   * the sensitive ones: this repo cannot see civitai's sensitivity table, and a
   * copy of it here would rot silently the next time a scope is reclassified.
   * Justifying all seven is cheap and cannot be wrong.
   */
  it('justifies every declared scope, with a justification for nothing else', () => {
    const scopes = manifest.scopes as string[];
    const justifications = manifest.scopeJustifications as Record<string, string>;
    expect(Object.keys(justifications).sort()).toEqual([...scopes].sort());
    for (const scope of scopes) {
      // Non-empty and ≤500 chars — the schema's own bounds on each value.
      expect(justifications[scope]!.trim().length).toBeGreaterThan(0);
      expect(justifications[scope]!.length).toBeLessThanOrEqual(500);
    }
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

/**
 * 🔴 THE STORE READS ONE VERSION AND THE BUILD READS THE OTHER.
 *
 * `block.manifest.json` is what the platform reads: it decides the submitted
 * version, and `civitai app submit` refuses anything not above the highest
 * approved one. `package.json` is what the build and the toolchain read. A
 * release that bumps only one of them is a real, shippable defect, and until
 * now nothing in this repo noticed it.
 *
 * That is not hypothetical. On 2026-08-27 a batch that added the manifest's
 * `repository` key bumped the manifest and left `package.json` behind in SEVEN
 * apps at once. Two of them — civitai-app-model-benchmarking and
 * civitai-app-playable-collections — already had this assertion and went red
 * immediately (`expected '0.3.2' to be '0.3.1'`). The other five, this repo
 * among them, took the same bad change silently. This is the port of the guard
 * that worked.
 *
 * Deliberately NOT a literal (`toBe('0.6.2')`). A literal pins nothing worth
 * knowing and rots on every bump, turning the default branch red on a release
 * that broke nothing — and a permanently-red gate is worse than no gate,
 * because it trains everyone to merge through it. The relationship between the
 * two files cannot rot on a bump, and it still fires when someone bumps only
 * one.
 *
 * Read off disk rather than imported so it asserts against the bytes that
 * actually ship; `import.meta.url` keeps the paths independent of the working
 * directory the runner happens to use.
 */
function versionOf(relativePath: string): string {
  const raw = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    // Not a soft pass: a missing `version` is exactly the state this guard
    // exists to notice, so it must fail loudly rather than compare undefined
    // against undefined and go green.
    throw new Error(`${relativePath} has no string "version" field`);
  }
  return parsed.version;
}

describe('release versions', () => {
  it('keeps block.manifest.json and package.json versions in lockstep', () => {
    const manifestVersion = versionOf('../block.manifest.json');
    expect(manifestVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versionOf('../package.json')).toBe(manifestVersion);
  });
});
