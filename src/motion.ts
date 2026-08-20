// The app's ONLY motion layer.
//
// Why a stylesheet at all, in a codebase that otherwise styles with inline
// `style={{…}}` off ../theme? Because `@keyframes` and `:hover` cannot be
// expressed as inline styles, and the brief forbids adding an animation or
// CSS-in-JS dependency. So this mirrors the design system's OWN idiom
// (`@civitai/components`' `injectStyles()`): ship the CSS as a string constant
// and inject it into `<head>` exactly once behind a marker attribute. Rendering
// any motion-aware component is enough — no CSS import, no setup step, and it
// works identically in jsdom (which is what makes the motion measurable in a
// test rather than only in a browser).
//
// 🔴 REDUCED MOTION — ONE GUARD, ONE PLACE. `usePrefersReducedMotion()` is the
// single gate: when the viewer asks for reduced motion the components simply do
// not apply the motion classes, so there is nothing to animate. A parallel
// `@media (prefers-reduced-motion: reduce)` block inside the CSS was
// deliberately NOT added — a second, redundant guard would mean a broken gate
// still "passes" because the other one caught it, and jsdom does not evaluate
// that media query anyway, so it could never be tested here. The hook
// subscribes to `change`, so flipping the OS setting mid-session takes effect
// without a reload.
//
// 🔴 EVERY declaration below animates `opacity`/`transform` (compositor-only)
// and box-shadow. Nothing animates width/height/top/left — no layout thrash.
//
// 🔴 LONGHAND ONLY (`animation-name`, `animation-duration`, …), never the
// `animation:`/`transition:` shorthand. jsdom's CSSOM does not expand those
// shorthands, so a shorthand rule is invisible to `getComputedStyle()` in the
// tests that assert this motion exists (measured: a `.cg-x { animation: a 200ms }`
// rule reads back `animationName: ""`).

import { useEffect, useRef, useState } from 'react';

/** The media query that means "this viewer does not want animation". */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Idempotency marker on the injected `<style>` element. */
export const MOTION_STYLE_MARKER = 'data-custom-generators-motion';

/** Entrance: a card/panel fades and rises into place. */
export const CLASS_RISE = 'cg-rise';
/** Hover: a card lifts a couple of pixels and casts a soft shadow. */
export const CLASS_LIFT = 'cg-lift';
/** A number that just changed gives one quick tick. */
export const CLASS_TICK = 'cg-tick';

/** Per-item entrance stagger (ms) and the index at which it stops growing. */
export const STAGGER_STEP_MS = 40;
export const STAGGER_MAX_STEPS = 6;

/**
 * Entrance delay for the nth item in a freshly-populated list. Capped so a long
 * list never turns into a slow cascade — item 6 and item 60 both start at 240ms.
 */
export function staggerDelayMs(index: number): number {
  return Math.min(Math.max(index, 0), STAGGER_MAX_STEPS) * STAGGER_STEP_MS;
}

// `animation-fill-mode: backwards` (NOT `both`) is load-bearing: `both` keeps
// the animation's final `transform: none` applied FOREVER, and an animation's
// filled value beats a normal declaration in the cascade — which would silently
// kill `.cg-lift:hover`'s translate for the rest of the session. `backwards`
// applies only the `from` state during the stagger delay and hands the element
// back to its normal styles the moment it finishes.
export const MOTION_CSS = `
@keyframes cg-rise {
  from { opacity: 0; transform: translate3d(0, 8px, 0); }
  to   { opacity: 1; transform: translate3d(0, 0, 0); }
}
@keyframes cg-tick {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.18); }
  100% { transform: scale(1); }
}
.${CLASS_RISE} {
  animation-name: cg-rise;
  animation-duration: 280ms;
  animation-timing-function: cubic-bezier(0.22, 0.72, 0.3, 1);
  animation-fill-mode: backwards;
}
.${CLASS_LIFT} {
  transition-property: transform, box-shadow;
  transition-duration: 160ms;
  transition-timing-function: cubic-bezier(0.22, 0.72, 0.3, 1);
}
.${CLASS_LIFT}:hover {
  transform: translate3d(0, -2px, 0);
  box-shadow: 0 6px 18px -8px color-mix(in srgb, var(--civitai-color-text) 40%, transparent);
}
.${CLASS_LIFT}:active {
  transform: translate3d(0, -1px, 0);
  transition-duration: 80ms;
}
.${CLASS_TICK} {
  display: inline-block;
  animation-name: cg-tick;
  animation-duration: 320ms;
  animation-timing-function: cubic-bezier(0.3, 1.35, 0.5, 1);
}
`;

/**
 * Inject the motion stylesheet into a document's `<head>` exactly once.
 * Idempotent; a no-op with no document (SSR).
 */
export function injectMotionStyles(doc?: Document): void {
  const target = doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!target) return;
  if (target.querySelector(`style[${MOTION_STYLE_MARKER}]`)) return;
  const style = target.createElement('style');
  style.setAttribute(MOTION_STYLE_MARKER, 'true');
  style.textContent = MOTION_CSS;
  const head = target.head ?? target.getElementsByTagName('head')[0];
  if (head) head.appendChild(style);
  else target.documentElement.appendChild(style);
}

/**
 * True when the viewer has asked their OS/browser for reduced motion.
 *
 * Defaults to FALSE where `matchMedia` is unavailable, because the CSS default
 * for this feature is `no-preference` — treating an unknown environment as
 * "reduce" would silently disable motion for everyone on an old runtime.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(mql.matches);
    onChange();
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}

/**
 * The one hook a component needs: injects the stylesheet on mount and reports
 * whether motion may play. `false` ⇒ apply NO motion class (see the guard note
 * at the top of this file).
 */
export function useMotion(): boolean {
  useEffect(() => {
    injectMotionStyles();
  }, []);
  return !usePrefersReducedMotion();
}

/**
 * A counter that increments every time `value` changes AFTER the first render.
 * `0` therefore means "never changed since mount", which is what keeps the vote
 * tick from firing on every card the moment the list paints.
 *
 * Used as a React `key` so the tick animation genuinely REPLAYS: a CSS animation
 * only restarts when the element is created or its `animation-name` changes, and
 * React reuses the same DOM node across re-renders, so re-applying the same class
 * would do nothing on the second vote.
 */
export function useChangeTick(value: number): number {
  const [tick, setTick] = useState(0);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setTick((n) => n + 1);
    }
  }, [value]);
  return tick;
}

/**
 * Join a motion class onto an optional existing className, gated on `enabled`.
 * Returns `undefined` (not `''`) when there is nothing to apply, so the DOM
 * carries no empty `class=""` attribute.
 */
export function motionClass(enabled: boolean, ...classes: (string | false | undefined)[]): string | undefined {
  if (!enabled) return undefined;
  const kept = classes.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return kept.length ? kept.join(' ') : undefined;
}
