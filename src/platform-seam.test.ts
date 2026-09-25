// The guard that makes `src/platform/` a SEAM rather than just a folder.
//
// THREE assertions. There used to be a fourth — "no file imports
// `@civitai/blocks-react`" — and it was DELETED because it could not fail
// independently of the `package.json` assertion below: with the package absent
// from `package.json` at all, an import of it cannot resolve, so the suite would
// already be red at module load. It read as a second, stronger guard and was
// really the same one spelled twice.
//
// What the three do:
//   1. POSITIVE CONTROL for the file scan. A scan that silently matched nothing
//      would satisfy assertion 3 vacuously and go on doing so forever.
//   2. `package.json` declares `@civitai/sdk` and NOT `@civitai/blocks-react`.
//      This is the one that actually keeps the bridge package out of the tree,
//      and it reads the manifest rather than the sources — so assertion 1 is not
//      its control, and it needs none.
//   3. The SDK is reachable from `src/platform/` only, as an exact ledger.
//
// 🔴 MATCHES MODULE SPECIFIERS, NOT SUBSTRINGS. This port's own comments name
// `@civitai/blocks-react` and `@civitai/sdk` constantly — deliberately, because
// explaining what moved and why is most of the value of the diff. A substring
// scan for `@civitai/blocks-react` therefore reports files that only mention it
// in prose (the count is quoted in the PR body, and it is not zero). What is
// asserted here is what the module GRAPH does, so the pattern is anchored to
// `from`/`import`/`require`/`vi.mock` followed by a quoted specifier.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 🔴 `dirname(fileURLToPath(import.meta.url))`, NOT `new URL('.', import.meta.url)`.
// Under this repo's jsdom test environment the global `URL` resolves a bare `'.'`
// against the DOCUMENT base, so `new URL('.', import.meta.url)` returns
// `http://localhost:3000/src` and every read below fails on a path that looks
// almost right.
const SRC = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(SRC);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Does `source` import `pkg` (or any subpath of it) as a module? */
function importsPackage(source: string, pkg: string): boolean {
  const quoted = `['"]${pkg.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(?:/[^'"]*)?['"]`;
  return new RegExp(`(?:from|import|require|vi\\.mock)\\s*\\(?\\s*${quoted}`).test(source);
}

const FILES = sourceFiles(SRC);

function importersOf(pkg: string): string[] {
  return FILES.filter((f) => importsPackage(readFileSync(f, 'utf8'), pkg)).map((f) =>
    relative(SRC, f).split('\\').join('/'),
  );
}

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('the platform seam', () => {
  /**
   * POSITIVE CONTROL for the file-scanning assertion below (`confines
   * @civitai/sdk to src/platform/`).
   *
   * That assertion is satisfied by a scan that found nothing, so it would pass
   * against an empty file list — and `readdirSync` on a mistyped path, or a regex
   * that never matches, produces exactly that. This pins the scan's own reach: a
   * real number of files, and two specific ones that MUST be in it.
   *
   * It is NOT a control for the `package.json` assertion, which reads the
   * manifest and never touches `FILES`.
   */
  it('scans the real source tree', () => {
    expect(FILES.length).toBeGreaterThan(20);
    const names = FILES.map((f) => relative(SRC, f).split('\\').join('/'));
    expect(names).toContain('App.tsx');
    expect(names).toContain('platform/workflows.ts');
    // And the matcher itself can match: `App.tsx` really does import the platform
    // barrel, so a regex that never fired would fail here rather than downstream.
    expect(importersOf('./platform/index.js').length).toBeGreaterThan(0);
  });

  /**
   * The guard that keeps the bridge package out. An import of it cannot resolve
   * while it is absent here, so this subsumes the source-scan version of the same
   * claim that used to sit above it.
   */
  it('declares @civitai/sdk and not @civitai/blocks-react', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all)).not.toContain('@civitai/blocks-react');
    expect(Object.keys(all)).toContain('@civitai/sdk');
  });

  /**
   * The seam's actual content: the SDK is reachable from one directory only.
   *
   * Asserted as a ledger rather than a count, so it fails when the set GROWS *or*
   * SHRINKS — a new SDK caller outside `platform/` is the regression this exists
   * for, and a shrink means a surface quietly stopped being wired.
   */
  it('confines @civitai/sdk to src/platform/', () => {
    const importers = importersOf('@civitai/sdk').sort();
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((f) => !f.startsWith('platform/'))).toEqual([]);
    expect(importers).toEqual([
      'platform/client.ts',
      'platform/hooks.ts',
      'platform/testing.tsx',
      'platform/workflows.ts',
    ]);
  });
});
