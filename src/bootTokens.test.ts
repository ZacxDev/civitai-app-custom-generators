// The inline boot styles in index.html hardcode colour literals. Everything else in
// this app is `var(--civitai-*)` with zero hardcoded colour (src/theme.ts), and that
// is deliberate — but the boot window is the one place a var is unusable, because
// `@civitai/theme/styles.css` is a render-blocking <link> that has not loaded yet.
// These tests keep that necessary duplication honest: every literal is asserted
// against the @civitai/theme copy this app RESOLVES, per region, so a theme bump
// that moves a value fails here instead of shipping a colour jump at handoff.
//
// 🔴 THAT SENTENCE WAS WORTHLESS UNTIL THE SINGLE-COPY GUARD BELOW EXISTED, AND THIS
// FILE IS WHY IT IS WRITTEN DOWN. An assertion against "the resolved copy" only means
// anything while the resolved copy is the copy that PAINTS, and it was not. The exact
// chain, traced through the installed packages:
//
//   main.tsx, module scope:
//     import '@civitai/theme/styles.css'  → THE APP'S copy, bundled into the CSS <link>
//     injectBlocksStyles()                → src/ui/styles.ts
//       → injectStyles()                    @civitai/components-react → @civitai/components
//         → injectTokens()                  @civitai/theme — THE COPY *COMPONENTS* RESOLVES
//           → head.appendChild(<style> tokensCss)
//
// The `<link>` is in <head> from the initial HTML; the `<style>` is appended at startup,
// so it is LAST in document order at equal specificity — the injected copy wins. While
// this app pinned `@civitai/theme@^0.3.1` and `@civitai/components@0.5.0` pinned 0.4.0,
// both installed: `createRequire` below resolved the app's 0.3.1 while `injectTokens`
// painted 0.4.0's, and dark `--civitai-color-surface` had moved #1A1B1E → #25262B
// between them. So this file compared #1a1b1e against #1a1b1e, passed, and a real token
// change shipped underneath it. The version SPLIT, not the resolution logic, was the
// whole defect — which is why the fix is a single-copy guard and not a re-pointed path.
//
// 🔴 SO THE SINGLE-COPY TEST IS THE LOAD-BEARING ONE HERE. It pins a RELATIONSHIP, not
// a colour: it fails when the set of resolved `@civitai/theme` versions GROWS, which is
// the only way the copy asserted below can stop being the copy that paints. The
// colour-by-colour assertions are downstream of it — green ones mean nothing if it is
// red.
//
// 🔴 WHAT NO TEST IN THIS FILE DOES: render anything, or read a computed style. It
// compares TEXT in index.html against TEXT in the theme package. It cannot see a token
// the app overrides in its own stylesheet, nor a cascade or specificity mistake between
// two stylesheets that both load. The boot window itself — whether the placeholder
// actually paints these colours before the bundle lands — has never been observed in a
// browser.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const INDEX_HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const THEME_CSS_PATH = createRequire(import.meta.url).resolve('@civitai/theme/styles.css');

const THEME_CSS = readFileSync(THEME_CSS_PATH, 'utf8');

/**
 * The version of the copy the assertions below actually read.
 *
 * Walked UP from the resolved stylesheet to the owning `package.json` rather than
 * `require.resolve`d directly: `@civitai/theme` does not export `./package.json`, and
 * its `./styles.css` subpath maps to `dist/tokens.css`, so neither the filename nor the
 * depth is something this test should hardcode.
 */
const RESOLVED_THEME_VERSION = (() => {
  let dir = dirname(THEME_CSS_PATH);
  for (let i = 0; i < 10; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === '@civitai/theme' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      /* keep walking — not every ancestor has a package.json */
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`could not find the @civitai/theme package.json above ${THEME_CSS_PATH}`);
})();

/**
 * The inline `<style>` body ONLY.
 *
 * 🔴 EVERY CSS LOOKUP GOES THROUGH THIS, not the raw file. Searching the whole
 * document for `@media (prefers-color-scheme: light)` can match a PROSE mention of
 * it in a comment rather than the rule — which is exactly how the first version of
 * the canvas-background test in the pilot app failed at baseline while appearing to
 * kill every mutant. A comment is not a rule.
 */
const BOOT_CSS = (() => {
  const m = /<style>([\s\S]*?)<\/style>/.exec(INDEX_HTML);
  if (!m) throw new Error('no inline <style> found in index.html');
  return m[1];
})();

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const end = css.indexOf('}', start);
  if (end === -1) throw new Error(`unterminated block: ${selector}`);
  return css.slice(start, end);
}

function tokenValue(css: string, selector: string, prop: string): string {
  const m = new RegExp(`${prop}:\\s*([^;]+);`).exec(block(css, selector));
  if (!m) throw new Error(`${prop} not found in ${selector}`);
  return m[1].trim().toLowerCase();
}

function bootValue(selector: string, prop: string): string {
  return tokenValue(BOOT_CSS, selector, prop);
}

describe('boot token parity with @civitai/theme', () => {
  /**
   * 🔴 THE GUARD THAT MAKES EVERY OTHER ASSERTION IN THIS FILE MEAN ANYTHING. See the
   * file header: while two `@civitai/theme` copies were installed, this suite asserted
   * the app's copy against itself and stayed green through a real dark-surface change
   * that the OTHER copy was painting.
   *
   * Read from `pnpm-lock.yaml` rather than by walking `node_modules`, for two reasons:
   * the lockfile is what `pnpm install --frozen-lockfile` makes CI install, so it is the
   * resolution authority; and an in-place `pnpm install` does NOT prune `node_modules/.pnpm/`,
   * so directories from earlier installs linger there reachable from nothing. Bumping this
   * app's pin left exactly such a `@civitai+theme@0.3.1` tree behind, and a filesystem walk
   * would have reported a split that no longer existed. (A clean install does not create it —
   * which is the point: the residue is a property of HOW you installed, so it must not be
   * what this guard reads.)
   *
   * It fails if the set GROWS — a transitive dependency pinning a different theme minor
   * re-opens exactly the hole described in the header — and it also fails if the copy
   * this file reads is not the one the lockfile names.
   */
  it('resolves exactly ONE @civitai/theme, so the copy asserted here is the copy that paints', () => {
    const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
    const versions = [...lock.matchAll(/'@civitai\/theme@([^']+)':/g)].map((m) => m[1]);

    // DIAGNOSTIC ONLY, and deliberately not claimed as a control: the `toEqual` below
    // already fails on an empty match set (`[]` is not `['<version>']`), so this cannot
    // catch anything that one misses. What it buys is a readable cause — `expected 0 to
    // be greater than 0` means the regex stopped matching the lockfile's format, versus
    // a version list that means the copies genuinely split. Measured both ways.
    expect(versions.length).toBeGreaterThan(0);

    expect([...new Set(versions)]).toEqual([RESOLVED_THEME_VERSION]);
  });

  it('the DARK literals match the package [data-theme=dark] block', () => {
    const body = tokenValue(THEME_CSS, "[data-theme='dark']", '--civitai-color-body');
    const text = tokenValue(THEME_CSS, "[data-theme='dark']", '--civitai-color-text');
    const surface = tokenValue(THEME_CSS, "[data-theme='dark']", '--civitai-color-surface');

    expect(bootValue(':root', '--cg-boot-body')).toBe(body);
    expect(bootValue(':root', '--cg-boot-text')).toBe(text);
    expect(bootValue(':root', '--cg-boot-surface')).toBe(surface);

    // …and the host-answered dark override, which must be the SAME literals.
    expect(bootValue(":root[data-civitai-boot-theme='dark']", '--cg-boot-body')).toBe(body);
    expect(bootValue(":root[data-civitai-boot-theme='dark']", '--cg-boot-text')).toBe(text);
    expect(bootValue(":root[data-civitai-boot-theme='dark']", '--cg-boot-surface')).toBe(
      surface,
    );
  });

  it('the LIGHT literals match the package :root block', () => {
    const body = tokenValue(THEME_CSS, ':root', '--civitai-color-body');
    const text = tokenValue(THEME_CSS, ':root', '--civitai-color-text');
    const surface = tokenValue(THEME_CSS, ':root', '--civitai-color-surface');

    const media = BOOT_CSS.slice(BOOT_CSS.indexOf('@media (prefers-color-scheme: light)'));
    expect(tokenValue(media, ':root', '--cg-boot-body')).toBe(body);
    expect(tokenValue(media, ':root', '--cg-boot-text')).toBe(text);
    expect(tokenValue(media, ':root', '--cg-boot-surface')).toBe(surface);

    expect(bootValue(":root[data-civitai-boot-theme='light']", '--cg-boot-body')).toBe(body);
    expect(bootValue(":root[data-civitai-boot-theme='light']", '--cg-boot-text')).toBe(text);
    expect(bootValue(":root[data-civitai-boot-theme='light']", '--cg-boot-surface')).toBe(
      surface,
    );
  });

  // 🔴 The load-bearing structural claim a colour-by-colour check cannot make: dark
  // must be what "no information" MEANS. A light value reachable without either the
  // media query or an explicit light signal would make a no-preference viewer boot
  // light while every other layer of this app resolves unknown to dark.
  it('no light value is reachable without an explicit light signal', () => {
    const lightBody = tokenValue(THEME_CSS, ':root', '--civitai-color-body');
    const darkBody = tokenValue(THEME_CSS, "[data-theme='dark']", '--civitai-color-body');
    expect(lightBody).not.toBe(darkBody); // sanity: or this test proves nothing

    expect(bootValue(':root', '--cg-boot-body')).toBe(darkBody);
    expect(bootValue(':root', '--cg-boot-body')).not.toBe(lightBody);

    expect(BOOT_CSS.indexOf('@media (prefers-color-scheme: light)')).toBeGreaterThan(-1);
    // No `@media (prefers-color-scheme: dark)` block: one would invert the default
    // for `no-preference` and for any UA without the query. Scoped to the
    // STYLESHEET — the claim is about rules, not a word in a comment.
    expect(BOOT_CSS).not.toContain('prefers-color-scheme: dark');
  });

  // 🔴 THIS EXISTS BECAUSE A MUTANT SURVIVED WITHOUT IT IN THE PILOT APP. The
  // `background` DECLARATION is not decoration: it paints the html canvas, the layer
  // beneath the skeleton. Flipping it to white changed nothing and no test failed.
  it('every html-canvas background matches its region', () => {
    const lightBody = tokenValue(THEME_CSS, ':root', '--civitai-color-body');
    const darkBody = tokenValue(THEME_CSS, "[data-theme='dark']", '--civitai-color-body');

    const baseHtml = BOOT_CSS.indexOf('html {');
    expect(baseHtml).toBeGreaterThan(-1);
    expect(/background:\s*([^;]+);/.exec(BOOT_CSS.slice(baseHtml))?.[1].trim().toLowerCase()).toBe(
      darkBody,
    );

    const mediaAt = BOOT_CSS.indexOf('@media (prefers-color-scheme: light)');
    expect(mediaAt).toBeGreaterThan(-1);
    expect(/background:\s*([^;]+);/.exec(BOOT_CSS.slice(mediaAt))?.[1].trim().toLowerCase()).toBe(
      lightBody,
    );

    // Both host-answer overrides — the ONLY thing standing between a
    // dark-host/light-OS viewer and a white flash.
    expect(bootValue(":root[data-civitai-boot-theme='dark']", 'background')).toBe(darkBody);
    expect(bootValue(":root[data-civitai-boot-theme='light']", 'background')).toBe(lightBody);
    expect(bootValue(":root[data-civitai-boot-theme='dark']", 'color-scheme')).toBe('dark');
    expect(bootValue(":root[data-civitai-boot-theme='light']", 'color-scheme')).toBe('light');
  });

  // `color-scheme` drives the UA canvas, which paints before ANY of the CSS above.
  // `light dark` would paint a no-preference viewer's canvas white under a dark
  // skeleton.
  it('the color-scheme meta lists dark first', () => {
    expect(INDEX_HTML).toContain('content="dark light"');
    expect(INDEX_HTML).not.toContain('content="light dark"');
  });
});
