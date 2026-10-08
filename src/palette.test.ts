import { describe, expect, it, vi } from 'vitest';

// The palette layer's contract, pinned at the seams that matter:
//  • the default is Forge — it is what the boot skeleton paints (bootTokens
//    keeps those literals in step with palette.css's Forge block);
//  • a `?palette=` deep link wins over the stored choice (that is how a
//    reviewer compares palettes across screenshots);
//  • an unknown id never reaches the attribute (it would silently fall back
//    to stock tokens and look like a fourth palette).

describe('palette selection', () => {
  it('offers exactly the three candidate palettes', async () => {
    const { PALETTES } = await import('./palette.js');
    expect(PALETTES.map((p) => p.id)).toEqual(['forge', 'violet', 'slate']);
  });

  it('the query param wins, garbage is ignored, and the default is Forge', async () => {
    vi.stubGlobal('window', {
      location: { search: '?palette=violet' },
      localStorage: { getItem: () => 'slate', setItem: () => {} },
    });
    const { initialPalette } = await import('./palette.js');
    expect(initialPalette()).toBe('violet');

    vi.stubGlobal('window', {
      location: { search: '?palette=chartreuse' },
      localStorage: { getItem: () => null, setItem: () => {} },
    });
    vi.resetModules();
    const again = await import('./palette.js');
    expect(again.initialPalette()).toBe('forge');
  });
});
