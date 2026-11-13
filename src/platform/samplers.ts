// The generator's sampler options per model family, over
// `GET /api/v1/blocks/generation-samplers` (feedback #179).
//
// The on-site generator offers a different sampler list per model family, and a
// name the family does not offer is not refused: the host swaps in the family
// default. So the builder's sampler field is a drop-down fed from the SAME list
// the generator renders, served by the platform, never a copy kept here.
//
// Fetched through `app.site` like every other block REST read in this app, and
// parsed with `@civitai/app-sdk`'s `parseGenerationSamplers` (the parser
// `fetchGenerationSamplers` uses), so the shape is validated by the package that
// owns it.
//
// 🔴 A FAILURE IS NEVER AN EMPTY CATALOG. A platform that predates the route
// answers 404, and an empty catalog would read as "no family has a sampler" and
// hide the field everywhere. Every failure resolves to `{ status: 'unavailable' }`
// instead, and the builder falls back to the free-text field.

import {
  GenerationSamplersError,
  parseGenerationSamplers,
} from '@civitai/app-sdk/blocks';
import type {
  GenerationSamplerCatalog,
  GenerationSamplersErrorCode,
} from '@civitai/app-sdk/blocks';
import { ApiError } from '@civitai/sdk';
import type { BlockAppClient } from '@civitai/sdk';

import { getClient } from './client.js';

/** What the builder renders from. Never rejects: a failure is `unavailable`. */
export type GenerationSamplersState =
  | { status: 'ready'; catalog: GenerationSamplerCatalog }
  | { status: 'unavailable'; code: GenerationSamplersErrorCode };

/** Map a thrown value onto the SDK's error vocabulary. */
function classify(err: unknown): GenerationSamplersErrorCode {
  if (err instanceof GenerationSamplersError) return err.code;
  if (err instanceof ApiError) {
    if (err.status === 404) return 'unsupported-platform';
    if (err.status === 401 || err.status === 403) return 'unauthorized';
    return 'http-error';
  }
  return 'network-error';
}

/**
 * The cached answer, tied to the client it was fetched with.
 *
 * Keyed on the `getClient()` promise rather than held bare: `__configurePlatform`
 * (every test, and the dev harness) drops the client, and a bare cache would
 * then leak the first test's catalog into every later one.
 */
let cache: { client: Promise<BlockAppClient>; result: Promise<GenerationSamplersState> } | null = null;

/**
 * The sampler catalog, fetched once per session and held in memory.
 *
 * A `network-error` is not kept, so a later builder retries; every other answer
 * (including `unsupported-platform`) is kept for the session.
 */
export function loadGenerationSamplers(): Promise<GenerationSamplersState> {
  const client = getClient();
  if (cache && cache.client === client) return cache.result;
  const result = (async (): Promise<GenerationSamplersState> => {
    try {
      const app = await client;
      const body = await app.site.get<unknown>('blocks/generation-samplers');
      return { status: 'ready', catalog: parseGenerationSamplers(body) };
    } catch (err) {
      return { status: 'unavailable', code: classify(err) };
    }
  })();
  const entry = { client, result };
  cache = entry;
  void result.then((r) => {
    if (r.status === 'unavailable' && r.code === 'network-error' && cache === entry) cache = null;
  });
  return result;
}
