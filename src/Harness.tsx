import type { ReactNode } from 'react';

import { Harness as SdkHarness } from './platform/testing.js';
import { DEMO_SHARED_SEED } from './demo-data.js';

/**
 * Local dev wiring for the Custom Generators PAGE app.
 *
 * The real full-page surface mounts the block in an iframe at
 * /apps/run/custom-generators, brokers the host-UI messages (BLOCK_INIT, token,
 * resource picker, image upload, publish) and serves the data surface over
 * `/api/v1/blocks/*`. Locally there is neither, so this mounts the app's OWN fake
 * platform — `./platform/testing.tsx`'s `<Harness>`, a fake `fetch` for the REST
 * surface plus a scripted transport for the host-UI ops. No published mock host
 * is involved: `@civitai/sdk/testing` ships `createFakeTransport` and
 * `__resetTransport` and nothing else. (It is imported below as `SdkHarness`,
 * which is a historical alias — the component is this app's, not the SDK's.)
 *
 * We seed it with a demo published generator + a plausible Buzz wallet so the
 * full build → publish → run loop is exercisable offline. `consentGranted` is
 * passed for call-site compatibility and is INERT — see
 * `FakeCivitaiOptions.consentGranted`; what the app gates on now is `scopes`.
 */
export function Harness({ children }: { children: ReactNode }) {
  return (
    <SdkHarness
      viewer={{ id: 99, username: 'me' }}
      theme="dark"
      consentGranted
      buzzBudget={1000}
      buzz={{ balance: 5000 }}
      buzzBalance={{ blue: 1200, green: 0, yellow: 5000 }}
      generation={{ costPerGen: 12, latencyMs: 400, images: ['https://image.civitai.com/demo/out.jpeg'] }}
      shared={{ seed: DEMO_SHARED_SEED }}
    >
      {children}
    </SdkHarness>
  );
}
