// Guard for civitai/civitai-app-starters#247 — the nested-`@civitai/components`
// shadowing that ships Tooltip / Toast / Image UNSTYLED.
//
// MECHANISM (why a version assertion would be the wrong guard): both
// `@civitai/blocks-react`'s `injectBlocksStyles()` and
// `@civitai/components-react`'s `useComponentStyles()` inject the component CSS
// through the SAME `style[data-civitai-components]` marker, and both bail early
// when the marker is already present. `src/main.tsx` calls `injectBlocksStyles()`
// at module scope, so blocks-react's OWN resolution of `@civitai/components`
// wins the race. When npm nests an older copy under `blocks-react/node_modules`
// (the state of this repo's lockfile before @civitai/blocks-react@0.43.0), that
// older, smaller stylesheet is what lands — and the hoisted copy the app itself
// depends on never gets injected. Nothing errors; a Tooltip simply renders as
// visible layout text.
//
// So this pins the OBSERVABLE — what is in the injected stylesheet after the
// production injection order — rather than a version number or a tree shape.

import { beforeEach, describe, expect, it } from 'vitest';
import { injectBlocksStyles } from '@civitai/blocks-react/ui';
import { injectStyles as injectComponentStyles } from '@civitai/components-react';

/**
 * The `data-civitai-ui` primitives this app renders that live in
 * `@civitai/components` (NOT in blocks-react's own interactive layer). These are
 * exactly the ones the shadowed 0.2.1 stylesheet had no rules for.
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
    // is why the resolved version of `@civitai/components` under blocks-react has
    // to be the SAME one the app depends on.
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toBe(first);
  });
});
