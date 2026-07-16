// Dev-server embeddability for `civitai app dev-tunnel`.
//
// `dev:tunnel` serves THIS local dev server, through an ephemeral reverse tunnel,
// as a `dev-<hex>.civit.ai` host that the REAL production parent
// (https://civitai.com/apps/dev/<blockId>) iframes inside its `PageBlockHost`.
// For that prod-fidelity embed to work the dev server must (a) be framable BY
// civitai.com, and (b) serve its ES modules with CORS open — the host sandboxes
// the child iframe at a NULL origin, so its module scripts are CORS-fetched.
//
// This is the single source of truth for both, imported by vite.config.ts. It is
// DEV-ONLY: vite `server.*` options apply only to `vite dev`, never to
// `vite build`, so the PRODUCTION bundle's framing/CORS is untouched (its
// parent-origin allowlist still comes from VITE_BLOCK_ALLOWED_PARENT_ORIGINS).
// Keep this in sync with the host CSP.

/**
 * The production parent origins allowed to EMBED the dev tunnel. `/apps/dev`
 * iframes the tunneled child from civitai.com; the `*.civitai.com` wildcard
 * covers the sibling subdomains the platform may frame it from.
 */
export const PROD_FRAME_ANCESTORS: string[] = [
  'https://civitai.com',
  'https://*.civitai.com',
];

/**
 * The dev host suffix the tunnel serves the child on (`dev-<hex>.civit.ai`).
 * Vite's DNS-rebinding host check must allow it, or the tunneled request is 403'd
 * before it reaches the app. A leading-dot entry matches any subdomain.
 */
export const DEV_TUNNEL_HOST_SUFFIX = '.civit.ai';

/**
 * Hosts the dev server accepts (Vite `server.allowedHosts`). `localhost` covers
 * the normal harness; the `.civit.ai` suffix admits the tunneled host.
 */
export const DEV_ALLOWED_HOSTS: string[] = ['localhost', DEV_TUNNEL_HOST_SUFFIX];

/**
 * Response headers that make the dev server iframe-embeddable from the prod
 * parent. Two headers, both DEV-ONLY:
 *
 * 1. `frame-ancestors` CSP scoped to civitai.com (+ `'self'` for the plain local
 *    harness) so civitai.com may EMBED the dev server. Critically we DO NOT set
 *    `X-Frame-Options` — an `X-Frame-Options: DENY/SAMEORIGIN` would block the
 *    cross-origin embed regardless of the CSP. (Vite sets no XFO by default;
 *    this documents + asserts that invariant.)
 *
 * 2. `Access-Control-Allow-Origin: *` so the ES modules load. The dev-tunnel
 *    embeds this server inside App Blocks' `PageBlockHost` iframe, which is
 *    sandboxed with a NULL origin. When that null-origin document fetches the
 *    dev server's ES modules (`/src/main.tsx`, `/@vite/client`, …) the browser
 *    applies CORS; without an `Access-Control-Allow-Origin` header it blocks
 *    every module script ("from origin 'null' has been blocked by CORS policy").
 *    `*` matches how PRODUCTION app-blocks are served (their module scripts
 *    carry `access-control-allow-origin: *`), so the tunneled dev build behaves
 *    like prod. This is safe: the dev server is reachable only through the
 *    authenticated dev-tunnel gate, and module-script fetches are
 *    non-credentialed so `*` (not a specific origin) is correct. Like all
 *    `server.*` options it applies only to `vite dev`, never to a `vite build`.
 */
export function devServerSecurityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': `frame-ancestors 'self' ${PROD_FRAME_ANCESTORS.join(' ')}`,
    'Access-Control-Allow-Origin': '*',
  };
}
