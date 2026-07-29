// Best-effort client-side OG/meta for a deep-opened generator's public page.
// (jsdom project — needs a real `document`; the `.tsx` suffix routes it there.)

import { describe, expect, it, beforeEach } from 'vitest';

import { setGeneratorMeta } from './meta.js';
import { newButton, newGenerator } from './generator.js';

function metaContent(property: string): string | null {
  return document.head.querySelector(`meta[property="${property}"]`)?.getAttribute('content') ?? null;
}

describe('setGeneratorMeta', () => {
  beforeEach(() => {
    document.title = '';
    document.head.querySelectorAll('meta[property^="og:"]').forEach((m) => m.remove());
  });

  it('sets the document title + og:title/description from the generator', () => {
    setGeneratorMeta(newGenerator({ name: 'Neon Dreams', description: 'cyberpunk vibes', buttons: [newButton()] }));
    expect(document.title).toBe('Neon Dreams — Custom Generators');
    expect(metaContent('og:title')).toBe('Neon Dreams');
    expect(metaContent('og:description')).toBe('cyberpunk vibes');
  });

  it('adds og:image only when the generator has a header image', () => {
    setGeneratorMeta(newGenerator({ name: 'Plain', buttons: [newButton()] }));
    expect(metaContent('og:image')).toBeNull();

    setGeneratorMeta(
      newGenerator({ name: 'Covered', buttons: [newButton()], headerImageRef: { imageId: 1, url: 'https://img.example/cover.jpg' } }),
    );
    expect(metaContent('og:image')).toBe('https://img.example/cover.jpg');
  });

  it('upserts (does not duplicate) og tags on repeated calls', () => {
    setGeneratorMeta(newGenerator({ name: 'One', buttons: [newButton()] }));
    setGeneratorMeta(newGenerator({ name: 'Two', buttons: [newButton()] }));
    expect(document.head.querySelectorAll('meta[property="og:title"]').length).toBe(1);
    expect(metaContent('og:title')).toBe('Two');
  });

  it('falls back to sensible defaults for an unnamed generator', () => {
    setGeneratorMeta(newGenerator({ name: '', description: '', buttons: [newButton()] }));
    expect(document.title).toBe('Custom Generator — Custom Generators');
    expect(metaContent('og:description')).toBe('Run this custom generator on Civitai.');
  });
});
