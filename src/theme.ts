// Design tokens for the app chrome the `@civitai/blocks-react/ui` pack doesn't
// cover (page background, muted text, card scaffolding, the prompt-template
// editor, inline states). Every value resolves to a `@civitai/theme` CSS custom
// property (`--civitai-*`) so there are ZERO hardcoded colors and light/dark is
// driven entirely by the `[data-theme]` attribute the host sets on the block
// root (see App.tsx). The pack (Button/Card/Badge/…) is self-themed off the same
// tokens, so the hand-rolled chrome reads as one system with it.
//
// Token source: `@civitai/theme@0.2.0` — imported once in main.tsx via
// `@civitai/theme/styles.css` (and also injected at runtime by the pack's
// injectBlocksStyles()). Two traps this module deliberately avoids:
//   • the `--civitai-color-gray-*` ramp is theme-INVARIANT (not redefined under
//     [data-theme='dark']) — never used here for a theme-responsive surface.
//   • in LIGHT theme `body == surface == surface-2` (identical near-white), so a
//     card never gets FILL contrast in light — panels are separated by a `border`,
//     and any recess uses `elevate()` (a text-into-surface mix that reads in
//     BOTH themes), never `surface-2` as a background.

import type { CSSProperties } from 'react';

/** The theme-aware `--civitai-*` tokens this app consumes (all flip with `[data-theme]`). */
export const token = {
  text: 'var(--civitai-color-text)',
  dimmed: 'var(--civitai-color-text-dimmed)',
  body: 'var(--civitai-color-body)',
  surface: 'var(--civitai-color-surface)',
  surface2: 'var(--civitai-color-surface-2)',
  border: 'var(--civitai-color-border)',
  primary: 'var(--civitai-color-primary)',
  primaryLight: 'var(--civitai-color-primary-light)',
  error: 'var(--civitai-color-error)',
  success: 'var(--civitai-color-success)',
  radius: 'var(--civitai-radius)',
  font: 'var(--civitai-font)',
} as const;

/** `--civitai-radius` (0.25rem) and its common multiples, as strings. */
export const radius = {
  sm: token.radius,
  md: `calc(${token.radius} * 2)`,
  lg: `calc(${token.radius} * 3)`,
} as const;

/**
 * A subtle, theme-agnostic elevation tint derived from the tokens: mix a little
 * `text` into `surface`. Works in BOTH themes (in light it darkens white; in
 * dark it lightens the panel) WITHOUT touching the invariant gray ramp — which
 * is why we don't just use `surface-2` (identical to `body`/`surface` in light).
 * `color-mix` is broadly supported and used by the pack's own components.
 */
export function elevate(pct: number): string {
  return `color-mix(in srgb, var(--civitai-color-text) ${pct}%, var(--civitai-color-surface))`;
}

/**
 * A translucent accent wash — a little `primary` over transparent — for a
 * non-solid highlight (e.g. the `{prompt}` token mark) that reads in both
 * themes without a hardcoded rgba.
 */
export function accentWash(pct: number): string {
  return `color-mix(in srgb, var(--civitai-color-primary) ${pct}%, transparent)`;
}

// The app-chrome palette, entirely as `--civitai-*` var references. Kept as an
// object threaded through the components (`c`) so the existing component API is
// unchanged — only the values moved from hardcoded hex to tokens. Because CSS
// custom properties INHERIT and flip on `[data-theme]`, this needs no `dark`
// argument: the same var() reference resolves to the right value per theme.
export interface Palette {
  bg: string;
  fg: string;
  muted: string;
  border: string;
  card: string;
  /** A faint token-derived recess that reads in BOTH themes (never surface-2). */
  recess: string;
}

export function palette(): Palette {
  return {
    bg: token.body,
    fg: token.text,
    muted: token.dimmed,
    border: token.border,
    card: token.surface,
    recess: elevate(2),
  };
}

export function pageStyle(c: Palette): CSSProperties {
  return {
    fontFamily: token.font,
    background: c.bg,
    color: c.fg,
    width: '100%',
    minHeight: '100dvh',
    display: 'flex',
    boxSizing: 'border-box',
  };
}

export const contentStyle: CSSProperties = {
  margin: '0 auto',
  width: '100%',
  maxWidth: 900,
  padding: 'clamp(14px, 3vw, 24px)',
  display: 'grid',
  gap: 18,
  alignContent: 'start',
  boxSizing: 'border-box',
};

/** Muted secondary text — the dimmed token at full opacity (crisper than opacity-stacking). */
export const mutedText: CSSProperties = { color: token.dimmed, fontSize: 13, lineHeight: 1.5 };

/** Smaller meta/caption text. */
export const metaText: CSSProperties = { color: token.dimmed, fontSize: 12, lineHeight: 1.45 };
