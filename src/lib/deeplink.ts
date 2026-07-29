// Shareable-generator deeplinks. A published generator can be linked directly
// with `?g=<sharedKey>` — opening the app with that query param deep-opens the
// generator in the Runner (see App). All pure + testable; the App wires
// `window.location` / `navigator.clipboard` around these.

/** The query param that carries a published generator's shared_kv key. */
export const DEEPLINK_PARAM = 'g';

/**
 * Extract the deeplink shared_kv key from a URL query string (`window.location
 * .search`). Returns the trimmed key, or `null` when absent/blank. Accepts a
 * bare `?g=...` string or a full search string.
 */
export function parseDeeplinkKey(search: string | undefined | null): string | null {
  if (!search) return null;
  const qs = search.startsWith('?') ? search.slice(1) : search;
  const key = new URLSearchParams(qs).get(DEEPLINK_PARAM);
  const trimmed = (key ?? '').trim();
  return trimmed ? trimmed : null;
}

/**
 * Build a shareable URL for a published generator from the current page href.
 * Self-referential (derived from `href`, no hardcoded domain) so it works on
 * whatever origin the block is served from. Sets `?g=<key>` (replacing any
 * existing value) and drops the hash.
 */
export function buildShareUrl(href: string, key: string): string {
  const url = new URL(href);
  url.searchParams.set(DEEPLINK_PARAM, key);
  url.hash = '';
  return url.toString();
}

/**
 * Return `href` with the `?g=` deeplink param removed — used to clean the
 * address bar after a deeplink has been consumed so a later reload / share of
 * the tab doesn't re-trigger the deep-open.
 */
export function stripDeeplinkParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(DEEPLINK_PARAM);
  return url.toString();
}
