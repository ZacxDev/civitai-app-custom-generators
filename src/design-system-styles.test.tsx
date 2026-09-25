// Guard for civitai/civitai-app-starters#247 — the nested-`@civitai/components`
// shadowing that ships Tooltip / Toast / Image UNSTYLED.
//
// MECHANISM (why a version assertion would be the wrong guard): every injector
// writes the component CSS through the SAME `style[data-civitai-components]`
// marker and bails early when the marker is already present, so the FIRST one to
// run decides what the document gets. `src/main.tsx` calls `injectBlocksStyles()`
// at module scope — that is `src/ui/styles.ts`, which delegates to
// `@civitai/components-react`'s `injectStyles()` — so that path wins the race, and
// whichever `@civitai/components` copy it resolves is the stylesheet that lands. A
// second, different resolution of `@civitai/components` reachable from another
// injector never gets injected. Nothing errors; a Tooltip simply renders as
// visible layout text.
//
// 🔴 THE ORIGINAL SHAPE OF #247 IS GONE AND THE GUARD IS KEPT ANYWAY. It was a
// `@civitai/blocks-react` nesting its own older `@civitai/components`; that package
// is not a dependency of this app any more, so that exact nesting cannot recur.
// What CAN recur is the general case above — two resolutions, one marker, first
// writer wins — and that is what the assertions below pin. The sibling claim about
// the TOKEN copy is `bootTokens.test.ts`'s realpath test.
//
// So this pins the OBSERVABLE — what is in the injected stylesheet after the
// production injection order — rather than a version number or a tree shape.

import { beforeEach, describe, expect, it } from 'vitest';
import { injectBlocksStyles } from './ui/index.js';
import { injectStyles as injectComponentStyles } from '@civitai/components-react';

/**
 * The `data-civitai-ui` primitives this app renders that live in
 * `@civitai/components`. These are exactly the ones the shadowed 0.2.1 stylesheet
 * had no rules for, which is why they are the ones worth pinning.
 */
const APP_COMPONENT_PRIMITIVES = ['tooltip', 'toast', 'toast-region', 'image'] as const;

/** Present in BOTH the old and new stylesheets — the positive control. */
const ALWAYS_PRESENT = ['button', 'card'] as const;

function injectedComponentCss(): string {
  // Production order: main.tsx injects the pack up-front, then components-react
  // components inject on mount. The second call must not be able to lose data.
  injectBlocksStyles();
  injectComponentStyles();
  const el = document.head.querySelector('style[data-civitai-components]');
  return el?.textContent ?? '';
}

describe('design-system CSS actually reaches the document (starters#247)', () => {
  beforeEach(() => {
    document.head.querySelectorAll('style').forEach((s) => s.remove());
  });

  it('injects a component stylesheet at all', () => {
    const css = injectedComponentCss();
    // Positive control: if this is empty the assertions below pass vacuously.
    expect(css.length).toBeGreaterThan(1000);
    for (const name of ALWAYS_PRESENT) {
      expect(css).toContain(`[data-civitai-ui='${name}']`);
    }
  });

  it.each(APP_COMPONENT_PRIMITIVES)(
    'the injected stylesheet carries rules for "%s"',
    (name) => {
      expect(injectedComponentCss()).toContain(`[data-civitai-ui='${name}']`);
    },
  );

  it('a SECOND injection pass cannot replace the first (the shadowing mechanism)', () => {
    injectBlocksStyles();
    const first = document.head.querySelector('style[data-civitai-components]')?.textContent ?? '';
    injectComponentStyles();
    const marked = document.head.querySelectorAll('style[data-civitai-components]');
    // Exactly one marked element, and its content is whatever won the race — which
    // is why every reachable resolution of `@civitai/components` has to be the SAME
    // one the app depends on.
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toBe(first);
  });
});
