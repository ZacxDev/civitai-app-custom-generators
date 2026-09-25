// Setup for the jsdom (component + hook + e2e) test project. Loaded via
// setupFiles in vite.config.ts's `dom` project.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { resetHarnessTransport } from './dev-transport.js';

// The platform caches a client and a transport — reset both before each test so
// no handshake, token or store state leaks between tests.
beforeEach(() => {
  resetHarnessTransport();

  // 🔴 THE APP NOW DRIVES ITS DATA OVER HTTP, NOT postMessage — so global `fetch`
  // is stubbed to REJECT LOUDLY. A test that reaches the network has forgotten to
  // install the fake (`<Harness>`, or `__configurePlatform({ fetch })`), and the
  // rejection says so immediately instead of hanging until a timeout or — far
  // worse — reaching real civitai.com with a real-looking request. Suites that
  // need data install the fake, which the platform client uses in preference to
  // this global.
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.reject(
        new Error(
          'No network in tests. This call escaped the fake platform — wrap the ' +
            'render in <Harness>, or call __configurePlatform({ fetch }).',
        ),
      ),
    ),
  );

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
