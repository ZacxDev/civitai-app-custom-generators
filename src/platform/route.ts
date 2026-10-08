// The host route: where on civitai.com's `/apps/run/<slug>/<...path>` the viewer
// is, as the host tells the block.
//
// The host forwards `<...path>` (no leading slash) as `subPath` in two places:
//   - the `BLOCK_INIT` context (`PageSlotContext.subPath`), for the route the
//     page was opened at;
//   - a `ROUTE_CHANGED { subPath }` push, every time it changes after init
//     (back/forward, or the host's own shallow push after a block `NAVIGATE`).
//
// `@civitai/sdk@0.3.0` types the first and not the second, but its transport
// hands any push it does not consume to `on(type)` listeners, so subscribing by
// name is the supported path (the same one `IMAGE_SCAN_RESOLVED` uses).
//
// 🔴 THE PUSH IS HELD SEPARATELY FROM THE SNAPSHOT, AND THAT IS LOAD-BEARING.
// The snapshot emits on every token refresh and theme change, and its `context`
// still carries the INIT `subPath`. Re-reading it on each emit would put the
// stale init route back over a newer `ROUTE_CHANGED`, so the value returned is
// "latest push, else init context", never "latest snapshot".

import { useEffect, useState } from 'react';

import { getPlatformTransport, getSnapshot } from './client.js';

export const ROUTE_CHANGED = 'ROUTE_CHANGED';

export interface HostRoute {
  /**
   * The current sub-path under the app's run route, `''` at the app root.
   * `null` when there is no page host to ask: before the handshake, or in a
   * slot that has no route.
   */
  subPath: string | null;
  /** The app's slug on the host, `null` when the host did not send one. */
  slug: string | null;
}

interface InitRoute {
  subPath: string | null;
  slug: string | null;
}

function readInitRoute(): InitRoute {
  const s = getSnapshot();
  if (!s.ready) return { subPath: null, slug: null };
  const ctx = s.context as { subPath?: unknown; slug?: unknown };
  return {
    subPath: typeof ctx.subPath === 'string' ? ctx.subPath : null,
    slug: typeof ctx.slug === 'string' && ctx.slug !== '' ? ctx.slug : null,
  };
}

/** The `subPath` out of a `ROUTE_CHANGED` payload, or `null` for a malformed one. */
export function subPathOfRouteChanged(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const sub = (payload as { subPath?: unknown }).subPath;
  return typeof sub === 'string' ? sub : null;
}

/** The host route as React state: init context, then every `ROUTE_CHANGED`. */
export function useHostRoute(): HostRoute {
  const [init, setInit] = useState<InitRoute>(readInitRoute);
  const [pushed, setPushed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const transport = getPlatformTransport();
    // Subscribe first, then re-read, so a handshake landing between the
    // `useState` read and this effect is not missed (same as `useBlockContext`).
    const offSnapshot = transport.snapshot.subscribe(() => {
      if (!cancelled) setInit(readInitRoute());
    });
    const offRoute = transport.on(ROUTE_CHANGED, (payload) => {
      const sub = subPathOfRouteChanged(payload);
      if (!cancelled && sub !== null) setPushed(sub);
    });
    setInit(readInitRoute());
    return () => {
      cancelled = true;
      offSnapshot();
      offRoute();
    };
  }, []);

  return { subPath: pushed ?? init.subPath, slug: init.slug };
}
