// Asserts the dev server is embeddable from the real Civitai host (for
// `civitai app dev-tunnel`) WITHOUT loosening the production build.
import { describe, it, expect } from 'vitest';

import {
  PROD_FRAME_ANCESTORS,
  DEV_ALLOWED_HOSTS,
  DEV_TUNNEL_HOST_SUFFIX,
  devServerSecurityHeaders,
} from './dev-embed.js';

describe('dev-tunnel embeddability', () => {
  it('emits a frame-ancestors CSP that admits civitai.com (+ wildcard)', () => {
    const csp = devServerSecurityHeaders()['Content-Security-Policy'];
    expect(csp).toContain('frame-ancestors');
    expect(csp).toContain('https://civitai.com');
    expect(csp).toContain('https://*.civitai.com');
    expect(csp).toContain("'self'"); // keeps the plain local harness working
    for (const origin of PROD_FRAME_ANCESTORS) expect(csp).toContain(origin);
  });

  it('sets Access-Control-Allow-Origin: * so null-origin module fetches load', () => {
    expect(devServerSecurityHeaders()['Access-Control-Allow-Origin']).toBe('*');
  });

  it('does NOT set X-Frame-Options (would block the cross-origin embed)', () => {
    const keys = Object.keys(devServerSecurityHeaders()).map((k) => k.toLowerCase());
    expect(keys).not.toContain('x-frame-options');
  });

  it('allows the tunnel host suffix in the dev server host check', () => {
    expect(DEV_ALLOWED_HOSTS).toContain(DEV_TUNNEL_HOST_SUFFIX); // .civit.ai
    expect(DEV_TUNNEL_HOST_SUFFIX).toBe('.civit.ai');
    expect(DEV_ALLOWED_HOSTS).toContain('localhost'); // plain harness still works
  });
});
