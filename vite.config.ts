/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { DEV_ALLOWED_HOSTS, devServerSecurityHeaders } from './src/dev-embed.js';

// base MUST be '/' — the platform serves the build output at the root of the
// app's own subdomain and server-owns the manifest iframe.src (the full-page
// surface iframes the bundle at /apps/run/custom-generators). No path prefix.
export default defineConfig(() => {
  // `civitai app dev-tunnel` runs `npm run dev:tunnel`, which sets
  // CIVITAI_DEV_TUNNEL_HMR=1 (see package.json). When tunneling, Vite's injected
  // `@vite/client` must open its HMR socket over the PUBLIC tunnel host
  // (`wss://dev-<hex>.civit.ai:443`), NOT the dev server's own
  // `ws://localhost:5188` — which the browser INSIDE the `dev-<hex>.civit.ai`
  // iframe cannot reach (that's why HMR silently fails on the tunnel while a
  // manual hard-reload still works). The websocket knobs live on `server.ws`
  // (Vite 8.1 renamed the old `server.hmr` websocket options to `server.ws`).
  // Setting `clientPort: 443` + `protocol: 'wss'` while LEAVING `ws.host` UNSET
  // makes the client derive the host from `location.hostname` — which, inside
  // the tunneled iframe, IS the `dev-<hex>.civit.ai` host (minted at runtime
  // after Vite starts, so it can't be hardcoded here). For plain
  // `dev` / `dev:harness` (flag unset) HMR stays at its DEFAULT local ws —
  // forcing wss:443 there would BREAK local live-reload. Deterministic env
  // gate, not a host heuristic.
  const tunnelHmr =
    process.env.CIVITAI_DEV_TUNNEL_HMR === '1' ||
    process.env.CIVITAI_DEV_TUNNEL_HMR === 'true';

  return {
  base: '/',
  plugins: [react()],
  server: {
    // The dev harness fires a fake BLOCK_INIT from window.location.origin and
    // the SDK IframeTransport drops any postMessage whose origin isn't its
    // allowed parent origin. Pin host+port so that origin is stable.
    host: 'localhost',
    port: 5188,
    strictPort: true,
    // `civitai app dev-tunnel` serves THIS dev server, through a reverse tunnel,
    // as a dev-*.civit.ai host that the real https://civitai.com/apps/dev/<id>
    // parent iframes. Two things make that embed work (both DEV-ONLY — `server.*`
    // never applies to `vite build`, so the production framing/CORS is untouched):
    //   1. allowedHosts admits the tunneled `.civit.ai` host (Vite's DNS-rebinding
    //      check would otherwise 403 it), and
    //   2. a `frame-ancestors` CSP (+ `Access-Control-Allow-Origin: *` for the
    //      null-origin module fetches) + NO X-Frame-Options lets civitai.com
    //      frame it. (The block's parent-origin ALLOWLIST also needs civitai.com —
    //      see .env.example's VITE_BLOCK_ALLOWED_PARENT_ORIGINS.)
    // See src/dev-embed.ts (single source of truth + tests).
    allowedHosts: DEV_ALLOWED_HOSTS,
    headers: devServerSecurityHeaders(),
    // Route HMR over the tunnel ONLY when `dev:tunnel` set the gate flag (see
    // `tunnelHmr` above). Spread-in so plain dev leaves `server.ws` at default.
    ...(tunnelHmr ? { ws: { clientPort: 443, protocol: 'wss' as const } } : {}),
  },
  build: {
    target: 'es2022',
    rollupOptions: { output: { manualChunks: undefined } },
  },
  test: {
    // Two suites in one `vitest run`:
    //  - `node`: pure-logic unit tests (*.test.ts) — no DOM, fast (the generator
    //            payload builders, prompt composition, weight clamping).
    //  - `dom` : component + hook + e2e tests (*.test.tsx) — jsdom +
    //            testing-library, driving the Builder/Runner against the SDK's
    //            mock host.
    projects: [
      {
        extends: true as const,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        extends: true as const,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./src/test-setup.ts'],
        },
      },
    ],
  },
  };
});
