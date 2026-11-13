// `loadGenerationSamplers` against the fake server — FEATURE tests (feedback #179).
//
// What they pin: the request goes to `blocks/generation-samplers`, a failure is
// classified (and never becomes an empty catalog), and the catalog is fetched once
// per session, except that a network failure is retried.

import { beforeEach, describe, expect, it } from 'vitest';

import { __configurePlatform } from './client.js';
import { loadGenerationSamplers } from './samplers.js';
import { createFakeCivitai, SITE_URL, type FakeCivitai, type FakeCivitaiOptions } from './testing.js';
import { SAMPLER_CATALOG } from '../test-helpers.js';

let fake: FakeCivitai;
function configure(generationSamplers: FakeCivitaiOptions['generationSamplers']) {
  fake = createFakeCivitai({ generationSamplers });
  __configurePlatform({ transport: fake.transport, fetch: fake.fetch, siteUrl: SITE_URL });
}
const requests = () => fake.calls.filter((c) => c.path === 'blocks/generation-samplers').length;

describe('loadGenerationSamplers', () => {
  beforeEach(() => configure(SAMPLER_CATALOG));

  it('resolves the parsed catalog from the route', async () => {
    const s = await loadGenerationSamplers();
    expect(s.status).toBe('ready');
    if (s.status !== 'ready') return;
    expect(s.catalog.baseModels['SDXL 1.0']).toBe('SDXL');
    expect(s.catalog.ecosystems.Flux1!.sampler).toBeNull();
    expect(s.catalog.ecosystems.SDXL!.sampler!.default).toBe('Euler a');
    expect(fake.calls.find((c) => c.path === 'blocks/generation-samplers')?.method).toBe('GET');
  });

  it('fetches once per session', async () => {
    await loadGenerationSamplers();
    await loadGenerationSamplers();
    await Promise.all([loadGenerationSamplers(), loadGenerationSamplers()]);
    expect(requests()).toBe(1);
  });

  it('a reconfigured platform (a new session) fetches again', async () => {
    await loadGenerationSamplers();
    configure(SAMPLER_CATALOG);
    await loadGenerationSamplers();
    expect(requests()).toBe(1); // the NEW fake's own count
  });

  it.each([
    ['an HTML 404 (a platform without the route)', undefined, 'unsupported-platform'],
    ['a 401', 401, 'unauthorized'],
    ['a 500', 500, 'http-error'],
    ['a body that is not the catalog shape', { nope: true }, 'invalid-response'],
    ['a failed fetch', 'network-error', 'network-error'],
  ] as const)('%s is unavailable (%s), never an empty catalog', async (_l, answer, code) => {
    configure(answer);
    await expect(loadGenerationSamplers()).resolves.toEqual({ status: 'unavailable', code });
  });

  it('keeps an old-platform answer for the session, but retries after a network failure', async () => {
    configure(undefined);
    await loadGenerationSamplers();
    await loadGenerationSamplers();
    expect(requests()).toBe(1);

    configure('network-error');
    await loadGenerationSamplers();
    await Promise.resolve();
    await loadGenerationSamplers();
    expect(requests()).toBe(2);
  });
});
