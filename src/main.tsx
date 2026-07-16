import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { Harness } from './Harness.js';
import { installHarnessTransport } from './dev-transport.js';
import './index.css';

// `npm run dev:harness` sets VITE_DEV_HARNESS=true to mount the local mock host
// (the published `@civitai/blocks-react/testing` Harness / createMockHost) that
// answers the FULL block protocol — BLOCK_INIT, viewer/consent, resource
// picker, image upload, workflow money path, and shared/KV storage. So unlike
// simpler apps this app needs NO injected HTTP fakes in dev; the mock host
// serves everything. Never set VITE_DEV_HARNESS in prod.
const useHarness = import.meta.env.VITE_DEV_HARNESS === 'true';

// The mock host replies from window.location.origin; the SDK transport drops
// mismatched-origin messages. Allowlist this origin BEFORE any hook runs.
if (useHarness) installHarnessTransport();

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

createRoot(container).render(
  <StrictMode>{useHarness ? <Harness><App /></Harness> : <App />}</StrictMode>,
);
