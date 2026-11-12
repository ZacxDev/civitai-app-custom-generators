// `useCivitaiNavigate` read off the wire (a jsdom suite, for `renderHook`): the
// exact `NAVIGATE` payload this app SENDS, against `src/platform/testing.tsx`'s fake host.
//
// 🔴 WHY THE WIRE AND NOT A SPY: feedback #181 ("Open in Civitai generator does nothing")
// lived in the gap between the App and the host. The civitai host resolves a
// NAVIGATE path inside the app's OWN route unless the payload carries the
// literal `scope: 'site'` (civitai `resolveNavigateRequest`, civitai/civitai#5209). This hook's
// old signature had no way to send `scope` at all — its second argument was the
// tab target — so no caller could reach the site generator, and every spy-level
// test above the hook stayed green. Nothing here has run against a real host;
// what it pins is the payload.

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __configurePlatform } from './client.js';
import { useCivitaiNavigate } from './hooks.js';
import { createFakeCivitai, SITE_URL } from './testing.js';

let outbound: { type: string; payload: unknown }[] = [];

beforeEach(() => {
  outbound = [];
  const fake = createFakeCivitai({
    viewer: { id: 99, username: 'me' },
    onOutbound: (m) => outbound.push(m),
  });
  __configurePlatform({ transport: fake.transport, fetch: fake.fetch, siteUrl: SITE_URL });
});
afterEach(() => __configurePlatform({}));

/**
 * The hook's `navigate`, called through the SHAPE the host contract needs rather
 * than through its declared type — so this file compiles, and reports a real
 * assertion failure, against a hook whose signature cannot express `scope` (the
 * pre-fix one took the tab target as its second argument).
 */
type Navigate = (path: string, opts?: { scope?: 'app' | 'site'; target?: 'current' | 'new_tab' }) => void;
function navigateHook(): Navigate {
  const { result } = renderHook(() => useCivitaiNavigate());
  return (path, opts) => (result.current.navigate as unknown as Navigate)(path, opts);
}

async function sent(): Promise<unknown[]> {
  // `navigate` is fire-and-forget behind the client's init promise.
  for (let i = 0; i < 50 && !outbound.some((m) => m.type === 'NAVIGATE'); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  return outbound.filter((m) => m.type === 'NAVIGATE').map((m) => m.payload);
}

describe('useCivitaiNavigate', () => {
  it("passes `scope: 'site'` through, so a site page is reachable at all (feedback #181)", async () => {
    navigateHook()('generate', { scope: 'site' });
    expect(await sent()).toStrictEqual([{ path: 'generate', scope: 'site', target: 'current' }]);
  });

  it('passes a new-tab target through alongside the scope', async () => {
    navigateHook()('models/500', { scope: 'site', target: 'new_tab' });
    expect(await sent()).toStrictEqual([{ path: 'models/500', scope: 'site', target: 'new_tab' }]);
  });

  // INVARIANT GUARD, not regression coverage: the App's own route sync
  // (`g/<key>`, `build/<id>`, '') never named a scope and must keep sending
  // none, which the host reads as app scope.
  it('an in-app route sends no scope (the host default, app scope)', async () => {
    navigateHook()('g/abc');
    expect(await sent()).toStrictEqual([{ path: 'g/abc', target: 'current' }]);
  });
});
