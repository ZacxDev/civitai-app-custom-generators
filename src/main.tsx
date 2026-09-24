import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { injectBlocksStyles } from './ui/index.js';
import { BlockGate } from './platform/index.js';

// Design-system tokens (`--civitai-*` custom properties, light/dark via
// `[data-theme]`). The pack's injectBlocksStyles() also injects these at
// runtime, but importing the stylesheet makes @civitai/theme an explicit,
// first-paint token source rather than a transitive side-effect of the pack.
import '@civitai/theme/styles.css';

import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Harness } from './Harness.js';
import { injectMotionStyles } from './motion.js';

import './index.css';

// `<ErrorBoundary>` is mounted bare, with NO `onError`. It used to carry one that
// fed an `APP_CRASHED` event into `useBlockAnalytics()` — a no-op shim nothing
// consumed — so the wrapper component that existed only to call that hook is gone
// with it. A caught render crash is now recovered on screen and reported NOWHERE:
// the boundary's fallback is the only signal, plus whatever React logs itself.
// `ErrorBoundary`'s `onError` prop stays (it has its own coverage in
// `ErrorBoundary.test.tsx`); it simply has no caller in production.
// Inject the /ui pack's themed stylesheet once up-front (idempotent; the pack
// components also self-inject on first render — this just guarantees tokens
// exist before the first paint).
injectBlocksStyles();

// Same reason, for the app's own motion layer (./motion.ts). `useMotion()` also
// self-injects, but from a `useEffect` — which React may run AFTER the first
// paint, and an entrance animation whose stylesheet lands one frame late shows
// the card at full opacity and THEN fades it in from 0. Injecting up-front makes
// that impossible. Idempotent, so the hook's call is a no-op.
injectMotionStyles();

// `pnpm run dev:harness` sets VITE_DEV_HARNESS=true to mount the local mock host
// (the published `@civitai/blocks-react/testing` Harness / createMockHost) that
// answers the FULL block protocol — BLOCK_INIT, viewer/consent, resource
// picker, image upload, workflow money path, and shared/KV storage. So unlike
// simpler apps this app needs NO injected HTTP fakes in dev; the mock host
// serves everything. Never set VITE_DEV_HARNESS in prod.
const useHarness = import.meta.env.VITE_DEV_HARNESS === 'true';

// 🔴 NOTHING TO INSTALL HERE ANY MORE, AND THE REASON IS THE WHOLE PORT. This
// used to pre-initialise the transport with `window.location.origin` allowlisted,
// because the mock host posted messages from this origin and the bridge SDK's
// transport dropped mismatched ones. The dev harness now INJECTS a transport
// object directly (`<Harness>` → `__configurePlatform`), so no message is ever
// origin-matched and there is no initialisation order to get right. `<Harness>`
// configures the platform during its own render, before <App/> below issues a
// call — see its docblock for why an effect would be too late.

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

// `<BlockGate>` shows an "Open on Civitai" landing when the block is loaded
// DIRECTLY (top-level at its bare `<slug>.civit.ai` origin, no BLOCK_INIT)
// instead of hanging on the app's loading state. It's inert on the embedded
// happy path and the dev harness (both post BLOCK_INIT), so it renders the app
// unchanged there. The run slug is derived from `location.hostname`. The
// ErrorBoundary wraps the actual app inside the gate.
createRoot(container).render(
  <StrictMode>
    <BlockGate>
      <ErrorBoundary>{useHarness ? <Harness><App /></Harness> : <App />}</ErrorBoundary>
    </BlockGate>
  </StrictMode>,
);
