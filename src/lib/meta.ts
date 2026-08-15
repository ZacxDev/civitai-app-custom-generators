// Best-effort client-side OG / social meta for a deep-opened generator's public
// page. NOTE: real crawler-facing Open Graph must be emitted by the host's SSR
// (a crawler never runs the iframe's JS) — this only updates the live document
// so an in-app share / same-tab navigation reflects the opened generator. Kept
// pure-ish (takes the target `Document`) so it's testable in jsdom.

import type { GeneratorConfig } from '../types.js';

const OG_TITLE = 'og:title';
const OG_DESC = 'og:description';
const OG_IMAGE = 'og:image';

function upsertMeta(doc: Document, property: string, content: string): void {
  let el = doc.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!el) {
    el = doc.createElement('meta');
    el.setAttribute('property', property);
    doc.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

/**
 * Reflect a generator into the document title + OG meta tags (best-effort,
 * client-side). Safe to call repeatedly; a no-op when there's no document.
 *
 * 🔴 SECURITY: `og:image` is set ONLY from `coverUrl` — the per-viewer MODERATED
 * url the host resolves from `headerImageRef.imageId` (via `useGatedImages`).
 * It is NEVER set from the stored free-text `headerImageRef.url`, which rides in
 * the UNMODERATED shared `data` blob and could be a forged tracker/beacon or a
 * content-moderation bypass. A caller with no resolved (visible) cover passes
 * `undefined`/`null` and no `og:image` is emitted.
 */
export function setGeneratorMeta(
  config: GeneratorConfig,
  coverUrl?: string | null,
  doc: Document = document,
): void {
  if (!doc?.head) return;
  const title = config.name?.trim() || 'Custom Generator';
  const desc = config.description?.trim() || 'Run this custom generator on Civitai.';
  doc.title = `${title} — Custom Generators`;
  upsertMeta(doc, OG_TITLE, title);
  upsertMeta(doc, OG_DESC, desc);
  if (coverUrl) upsertMeta(doc, OG_IMAGE, coverUrl);
}
