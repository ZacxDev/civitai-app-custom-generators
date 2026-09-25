// The design-system stylesheet, plus the CSS for the two components this app
// re-implements locally.
//
// 🔴 WHY THERE IS LOCAL CSS AT ALL. `@civitai/components` styles the components
// it ships. `Modal` and `Collapse` are NOT among them — measured on 0.5.0:
// `grep -o` over `dist/*.css` returns 0 occurrences of `modal` and 0 of
// `collapse`, against 89 occurrences of `data-civitai-ui` as the positive
// control. The React bindings package does not export them either. So the
// markup contract those two components render has no stylesheet behind it and
// this file supplies one.
//
// The rules below are carried verbatim from `@civitai/blocks-react`'s `/ui`
// pack (its `ui/styles.js`), so the two components look exactly as they did
// before the port. They reference only `--civitai-*` tokens, which
// `@civitai/components` defines — nothing here hardcodes a colour.

import { injectStyles } from '@civitai/components-react';

const STYLE_ID = 'civitai-custom-generators-ui';

/**
 * Modal + Collapse rules, lifted unchanged from the `/ui` pack.
 *
 * Kept as one string with one `<style>` element so injection is a single
 * idempotent DOM write, matching how the design-system package injects its own.
 */
const LOCAL_UI_CSS = `
/* ----- Modal ----- */
[data-civitai-ui='modal-overlay'] {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 32px 16px;
  overflow-y: auto;
  z-index: 1000;
}
[data-civitai-ui='modal'] {
  background: var(--civitai-color-surface);
  color: var(--civitai-color-text);
  border: 1px solid var(--civitai-color-border);
  border-radius: var(--civitai-radius);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  width: 100%;
  max-width: 440px;
  outline: none;
}
[data-civitai-ui='modal'][data-size='sm'] { max-width: 340px; }
[data-civitai-ui='modal'][data-size='md'] { max-width: 440px; }
[data-civitai-ui='modal'][data-size='lg'] { max-width: 620px; }
[data-civitai-ui='modal'] [data-civitai-ui-modal-header] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--civitai-color-border);
}
[data-civitai-ui='modal'] [data-civitai-ui-modal-title] {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
}
[data-civitai-ui='modal'] [data-civitai-ui-modal-close] {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--civitai-color-text-dimmed);
  font-size: 20px;
  line-height: 1;
  padding: 0;
}
[data-civitai-ui='modal'] [data-civitai-ui-modal-close]:hover {
  color: var(--civitai-color-text);
}
[data-civitai-ui='modal'] [data-civitai-ui-modal-body] {
  padding: 18px;
}

/* ----- Collapse ----- */
[data-civitai-ui='collapse'] [data-civitai-ui-collapse-trigger] {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 0;
  background: transparent;
  border: none;
  font-family: var(--civitai-font);
  font-size: 14px;
  font-weight: 600;
  color: var(--civitai-color-text);
  text-align: left;
  cursor: pointer;
}
[data-civitai-ui='collapse'] [data-civitai-ui-collapse-trigger]:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
[data-civitai-ui='collapse'] [data-civitai-ui-collapse-chevron] {
  display: inline-block;
  width: 1em;
  color: var(--civitai-color-text-dimmed);
}
[data-civitai-ui='collapse'] [data-civitai-ui-collapse-region] {
  padding-top: 4px;
}
`;

/** Inject the local Modal/Collapse rules once. Idempotent. */
function injectLocalUiStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = LOCAL_UI_CSS;
  document.head.appendChild(el);
}

/**
 * Inject the whole design system: the `@civitai/components` stylesheet and
 * `--civitai-*` tokens, plus this app's local Modal/Collapse rules.
 *
 * Named to match the `injectBlocksStyles()` this app called before the port —
 * it is the same contract (idempotent, safe to call at module scope and again
 * from a component) over a different pair of stylesheets, so the call sites
 * needed no change.
 */
export function injectBlocksStyles(): void {
  injectStyles();
  injectLocalUiStyles();
}

/**
 * Hook form, for a component that wants to guarantee tokens exist before it
 * paints. Deliberately not a `useEffect`: an effect can run after the first
 * paint, and a component whose stylesheet lands one frame late renders unstyled
 * and then snaps. Injection is an idempotent DOM write, so doing it during
 * render is safe here.
 */
export function useBlocksStyles(): void {
  injectBlocksStyles();
}
