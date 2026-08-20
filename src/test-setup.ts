// Setup for the jsdom (component + hook + e2e) test project. Loaded via
// setupFiles in vite.config.ts's `dom` project.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { resetHarnessTransport } from './dev-transport.js';

// The SDK transport is a process-wide singleton — reset it before each test so
// each gets a fresh instance whose allowlist contains the jsdom origin, and so
// no BLOCK_INIT / token / consent state leaks between tests.
beforeEach(() => {
  resetHarnessTransport();

  // jsdom has no matchMedia; default to a MOBILE viewport (mobile-first). Tests
  // that need the desktop branch override via `setViewport('desktop')`.
  if (!window.matchMedia) {
    window.matchMedia = makeMatchMedia(true) as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Build a matchMedia stub where max-width queries report the given mobile-ness.
 *
 * 🔴 `prefers-reduced-motion` is answered EXPLICITLY (default: no preference,
 * i.e. motion plays). Without that branch it fell through to the generic
 * `!isMobile` arm, so `setViewport('desktop')` silently reported "this viewer
 * wants reduced motion" and every desktop test would have measured a
 * motion-DISABLED app while looking like it measured the real one.
 */
export function makeMatchMedia(isMobile: boolean, reducedMotion = false) {
  return (query: string) => {
    const isMaxWidth = /max-width/.test(query);
    const isReducedMotion = /prefers-reduced-motion/.test(query);
    const matches = isReducedMotion ? reducedMotion : isMaxWidth ? isMobile : !isMobile;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  };
}

/** Switch the jsdom viewport between mobile and desktop for the responsive branch. */
export function setViewport(kind: 'mobile' | 'desktop') {
  window.matchMedia = makeMatchMedia(kind === 'mobile') as typeof window.matchMedia;
}

/**
 * Answer `(prefers-reduced-motion: reduce)` for the next render. `true` is the
 * accessibility branch — every motion class must be withheld (see ../motion.ts).
 * Viewport defaults to mobile, matching the suite's default.
 */
export function setReducedMotion(reduce: boolean, kind: 'mobile' | 'desktop' = 'mobile') {
  window.matchMedia = makeMatchMedia(kind === 'mobile', reduce) as typeof window.matchMedia;
}
