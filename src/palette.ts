// Review palette selection for Custom Generators' custom theme.
//
// Three candidate palettes ("Forge", "Signal Violet", "Slate Workshop") are
// defined as `--civitai-*` token redefinitions in `src/palette.css`, scoped to
// the app root's `data-palette` attribute. This module owns the CHOICE only:
// which palette is active, how it is picked up (a `?palette=` deep link wins
// over the stored choice, which wins over the default), and how it is
// remembered between reloads.
//
// The default is the FIRST candidate, Forge — the palette the boot skeleton
// in `index.html` is pinned to, so boot and first paint agree before the app
// hydrates. Picking another palette via the switcher keeps that choice in
// `localStorage`; the boot skeleton cannot know it, so a reload with a
// non-default stored palette may briefly paint the Forge skeleton first —
// accepted for a review build, and the reason the switcher is a review tool
// rather than a shipped viewer preference.

export type PaletteId = 'forge' | 'violet' | 'slate';

export interface PaletteOption {
  id: PaletteId;
  /** Short name shown in the switcher. */
  name: string;
  /** The palette's defining pair, for the switcher chip. */
  swatch: [string, string];
}

export const PALETTES: readonly PaletteOption[] = [
  { id: 'forge', name: 'Forge', swatch: ['#171310', '#f59e0b'] },
  { id: 'violet', name: 'Signal Violet', swatch: ['#14101f', '#8b5cf6'] },
  { id: 'slate', name: 'Slate Workshop', swatch: ['#10151a', '#38bdf8'] },
];

export const DEFAULT_PALETTE: PaletteId = 'forge';

const STORAGE_KEY = 'cg-palette';

function asPalette(value: string | null | undefined): PaletteId | null {
  return value === 'forge' || value === 'violet' || value === 'slate' ? value : null;
}

/** The palette to paint first: `?palette=` › stored choice › default. */
export function initialPalette(): PaletteId {
  try {
    const fromQuery = asPalette(new URLSearchParams(window.location.search).get('palette'));
    if (fromQuery) return fromQuery;
  } catch {
    /* no location (tests) — fall through */
  }
  try {
    const stored = asPalette(window.localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;
  } catch {
    /* storage unavailable (private mode, sandboxed frame) — default */
  }
  return DEFAULT_PALETTE;
}

/** Remember the reviewer's pick; a failure to store is not an error. */
export function storePalette(id: PaletteId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* see above */
  }
}
