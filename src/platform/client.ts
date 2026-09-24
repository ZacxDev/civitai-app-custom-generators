// The one place this app talks to `@civitai/sdk`.
//
// 🔴 THE SEAM IS THE DIRECTORY, AND IT IS ENFORCED. Only files under
// `src/platform/` may import `@civitai/sdk`; everything above imports
// `./platform/index.js` instead. `src/platform-seam.test.ts` asserts both halves
// of that, with a positive control, so the rule cannot rot into a comment.
//
// Why the client is a module-level promise singleton rather than React context:
// `initialize()` is a HANDSHAKE, not a query. Running it per component would
// open a second conversation with the host and race the first. Every caller
// below awaits the SAME promise, so a data call issued during boot queues behind
// the handshake instead of failing.

import { getTransport, initialize } from '@civitai/sdk';
import type { BlockAppClient, BlockSnapshot, BlockTransport } from '@civitai/sdk';

/**
 * Swapped in by tests (and the dev harness) so the app talks to a scripted host
 * and a fake `fetch` instead of the real bridge and real civitai.com.
 */
export interface PlatformOverrides {
  transport?: BlockTransport;
  fetch?: typeof fetch;
  siteUrl?: string;
  orchestrationUrl?: string;
}

let overrides: PlatformOverrides = {};
let clientPromise: Promise<BlockAppClient> | null = null;
let transportRef: BlockTransport | null = null;

/**
 * The transport, held separately from the client.
 *
 * 🔴 HELD SEPARATELY BECAUSE `BlockAppClient` DOES NOT EXPOSE THE TOKEN. This
 * app gates its whole generate path on `hasGenerateScope(token.scopes)`, and
 * scopes live only on the transport's synchronous snapshot — `BlockAppClient`
 * offers `getToken()` (the raw string) and nothing else. `useBlockToken` read the
 * snapshot, so this is where that reading comes from now.
 *
 * 🔴 And it is CACHED here rather than re-calling `getTransport()`. The SDK
 * caches its real transport on `globalThis`, but an OVERRIDDEN one (every test,
 * and the dev harness) is not cached anywhere — so re-calling `getTransport()`
 * would silently hand back the real, never-initialised singleton and the test
 * would drive a transport nobody scripted.
 */
export function getPlatformTransport(): BlockTransport {
  const existing = transportRef;
  if (existing) return existing;
  const created = overrides.transport ?? getTransport();
  transportRef = created;
  return created;
}

/** Synchronous snapshot — `ready`, `viewer`, `theme`, `token`, `context`. */
export function getSnapshot(): BlockSnapshot {
  return getPlatformTransport().snapshot.get();
}

/**
 * The initialised client. Safe to call from anywhere, any number of times.
 *
 * Rejects when no host ever answers (a direct load, or a 10s timeout). Callers
 * that render UI must handle that rather than hanging — see `BlockGate` and
 * `useBlockContext`.
 */
export function getClient(): Promise<BlockAppClient> {
  const existing = clientPromise;
  if (existing) return existing;
  const started = initialize({
    // Always explicit, so an overridden transport is the one that gets
    // initialised rather than the global.
    transport: getPlatformTransport(),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.siteUrl ? { siteUrl: overrides.siteUrl } : {}),
    ...(overrides.orchestrationUrl ? { orchestrationUrl: overrides.orchestrationUrl } : {}),
  });
  clientPromise = started;
  return started;
}

/**
 * Point the platform at a scripted host and fake server. Tests call this in
 * `beforeEach`; the dev harness calls it at module scope. Nothing in production
 * calls it.
 *
 * 🔴 DROPPING THE CACHED CLIENT AND TRANSPORT IS THE LOAD-BEARING HALF. Without
 * it the singletons above would leak the FIRST test's host and store into every
 * later test, which reads as a passing suite that never exercised its own
 * fixtures.
 */
export function __configurePlatform(next: PlatformOverrides): void {
  overrides = next;
  clientPromise = null;
  transportRef = null;
}
