// Shareable-generator deeplinks. All pure + testable; the App wires the host
// route, `window.location` and `navigator.clipboard` around these.
//
// Two spellings open a published generator in the Runner:
//
//   1. THE HOST ROUTE (primary, since 0.9.2). civitai.com serves this app at
//      `/apps/run/<slug>/<...path>` and forwards `<...path>` to the block as
//      `subPath`: in the init context, and as `ROUTE_CHANGED` afterwards.
//      `g/<key>` is the one shape routed here ({@link parseRouteKey}). Share
//      links point at it ({@link buildRunShareUrl}), so a link opens on
//      civitai.com with the host around it rather than on the bare block origin.
//   2. `?g=<key>` on the iframe's own URL (the pre-0.9.2 spelling), kept as the
//      fallback so links already in the wild keep working.
//
// When both are present the host route wins: it is what the viewer's address
// bar actually says.

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

/** The site that hosts this app's run route. */
export const CIVITAI_SITE_ORIGIN = 'https://civitai.com';

/**
 * The one route shape this app handles: `g/<key>`, where `<key>` is a shared_kv
 * key. Anchored at both ends with no optional parts, so `g/`, `g/a/b`, `x/<key>`,
 * a leading slash, an over-long key, and every traversal or percent-encoded
 * spelling all fail.
 */
const ROUTE_KEY = /^g\/([A-Za-z0-9_-]{1,64})$/;

/** True iff `key` can be carried in the `g/<key>` route without encoding. */
export function isRoutableKey(key: string): boolean {
  return parseRouteKey(routeForKey(key)) === key;
}

/**
 * Extract the generator key from a host `subPath` (`g/<key>`). Anything else,
 * including the app root (`''`), returns `null`: an unrecognised route opens
 * nothing.
 */
export function parseRouteKey(subPath: string | null | undefined): string | null {
  if (typeof subPath !== 'string') return null;
  const m = ROUTE_KEY.exec(subPath);
  return m ? (m[1] ?? null) : null;
}

/** The host `subPath` that shows generator `key`; inverse of {@link parseRouteKey}. */
export function routeForKey(key: string): string {
  return `g/${key}`;
}

/**
 * The share link for a published generator:
 * `https://civitai.com/apps/run/<slug>/g/<key>`.
 *
 * `slug` comes from the host context (or the manifest's `blockId` with no host)
 * rather than being hardcoded here. A key that does not fit the route shape
 * falls back to the self-referential `?g=` link built from `href`, since that is
 * the only spelling such a key could be opened by. Real keys are server-minted
 * ULIDs, so production should not reach the fallback.
 */
export function buildRunShareUrl(args: { slug: string; key: string; href: string }): string {
  if (!isRoutableKey(args.key)) return buildShareUrl(args.href, args.key);
  return `${CIVITAI_SITE_ORIGIN}/apps/run/${encodeURIComponent(args.slug)}/${routeForKey(args.key)}`;
}
