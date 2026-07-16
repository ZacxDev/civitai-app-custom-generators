import type { ReactNode } from 'react';

import { Harness as SdkHarness } from '@civitai/blocks-react/testing';
import { DEMO_SHARED_SEED } from './demo-data.js';

/**
 * Local dev mock host for the Custom Generators PAGE app.
 *
 * The real full-page surface mounts the block in an iframe at
 * /apps/run/custom-generators and brokers the protocol (BLOCK_INIT, viewer,
 * consent, resource picker, image upload, workflow, shared storage). Locally
 * there's no host, so the published SDK mock host (`createMockHost`) plays one —
 * it answers ALL of those (unlike the KV-only harness of simpler apps), so the
 * dev harness needs no injected fakes.
 *
 * We seed it consent-granted with a demo published generator + a plausible Buzz
 * wallet so the full build → publish → run loop is exercisable offline.
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
