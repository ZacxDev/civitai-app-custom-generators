// Minimal palette. The `@civitai/blocks-react/ui` component pack is self-themed
// off the block root's `data-theme`; this palette only styles the app chrome
// the pack doesn't cover (page background, muted text, the runner backdrop
// scrim).

import type { CSSProperties } from 'react';

export interface Palette {
  bg: string;
  fg: string;
  muted: string;
  border: string;
  card: string;
  chipBg: string;
  scrim: string;
}

export function palette(dark: boolean): Palette {
  return dark
    ? {
        bg: '#0b0c0f',
        fg: '#e8eaed',
        muted: '#9aa0a6',
        border: '#2a2d33',
        card: '#15171c',
        chipBg: '#22252c',
        scrim: 'rgba(8,9,12,0.72)',
      }
    : {
        bg: '#f6f7f9',
        fg: '#1a1c20',
        muted: '#5f6368',
        border: '#d9dce1',
        card: '#ffffff',
        chipBg: '#eceef1',
        scrim: 'rgba(255,255,255,0.72)',
      };
}

export function pageStyle(c: Palette): CSSProperties {
  return {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
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
  padding: 18,
  display: 'grid',
  gap: 16,
  alignContent: 'start',
  boxSizing: 'border-box',
};
