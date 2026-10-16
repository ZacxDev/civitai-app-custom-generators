// The app's page map: every screen is a host subPath ("page"), so the
// viewer's native back/forward walks the app like the rest of civitai.com.
//
//   ''              Browse · Discover
//   'mine'          Browse · My generators
//   'gallery'       Browse · My gallery
//   'g/<key>'       Runner for a published generator (deeplink.ts owns the key)
//   'd/<draftId>'   Runner for one of the viewer's own drafts
//   'build'         Builder, new generator
//   'build/<id>'    Builder, editing that draft
//
// Before this map existed only `g/<key>` was a page: everything else was
// in-app state, so opening the Builder or switching sections pushed no
// history and the native back button left the app entirely instead of
// returning to Browse. Every navigation the app makes now goes through
// `navigate()` (a shallow host push) and every host route change —
// including the back button — is interpreted back into state by ONE
// follower in App.tsx, so state and the address bar cannot drift apart.
//
// Shapes are anchored and segment-strict, mirroring deeplink.ts: anything
// unrecognised parses to `null` and the app leaves it alone (a route this
// app does not own is not its business — the host may grow routes of its
// own, e.g. the `generate` path the sub-listing cards point at).

import { parseRouteKey, routeForKey } from './deeplink.js';

export type BrowseSection = 'discover' | 'mine' | 'kept';

export type AppRoute =
  | { kind: 'browse'; section: BrowseSection }
  | { kind: 'runner'; key: string }
  | { kind: 'draft-runner'; draftId: string }
  | { kind: 'builder'; draftId: string | null };

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** Parse a host `subPath` into a page, or `null` for a foreign/malformed one. */
export function parseAppRoute(subPath: string | null | undefined): AppRoute | null {
  if (typeof subPath !== 'string') return null;
  if (subPath === '') return { kind: 'browse', section: 'discover' };
  if (subPath === 'mine') return { kind: 'browse', section: 'mine' };
  if (subPath === 'gallery') return { kind: 'browse', section: 'kept' };
  if (subPath === 'build') return { kind: 'builder', draftId: null };
  const key = parseRouteKey(subPath);
  if (key) return { kind: 'runner', key };
  const seg = subPath.split('/');
  if (seg.length === 2 && seg[0] === 'd' && SEGMENT.test(seg[1] ?? '')) {
    return { kind: 'draft-runner', draftId: seg[1] as string };
  }
  if (seg.length === 2 && seg[0] === 'build' && SEGMENT.test(seg[1] ?? '')) {
    return { kind: 'builder', draftId: seg[1] as string };
  }
  return null;
}

/** The `subPath` for a page — the inverse of {@link parseAppRoute}. */
export function routeForPage(route: AppRoute): string {
  switch (route.kind) {
    case 'browse':
      return route.section === 'discover' ? '' : route.section === 'mine' ? 'mine' : 'gallery';
    case 'runner':
      return routeForKey(route.key);
    case 'draft-runner':
      return `d/${route.draftId}`;
    case 'builder':
      return route.draftId ? `build/${route.draftId}` : 'build';
  }
}
