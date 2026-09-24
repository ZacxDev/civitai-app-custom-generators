// Test/dev-only transport wiring.
//
// 🔴 THIS FILE IS NOW ALMOST EMPTY, AND THAT IS THE POINT. Before the port it
// existed to solve one problem: the bridge SDK's transport was a process-wide
// singleton whose FIRST `getTransport()` call fixed its origin allowlist, so the
// harness had to initialise it with `window.location.origin` allowed BEFORE any
// hook ran, or every inbound mock-host message was dropped on an origin mismatch.
//
// After the port there is no mock host posting messages from this origin. The
// dev harness and the tests INJECT a transport object directly
// (`__configurePlatform`), so nothing is ever matched against an origin
// allowlist and there is no initialisation order to get right. The reset below is
// kept because `test-setup.ts` calls it between tests.

import { __configurePlatform } from './platform/index.js';
import { __resetTransport } from './platform/testing.js';

/**
 * Return the platform to its unconfigured state.
 *
 * Both halves are needed: `__configurePlatform({})` drops this app's cached
 * client and transport, and `__resetTransport()` clears the SDK's own
 * `globalThis` cache so a later real `getTransport()` re-detects rather than
 * handing back a transport built for a previous test's window.
 */
export function resetHarnessTransport(): void {
  __configurePlatform({});
  __resetTransport();
}
