// Manifest loading + validation.
//
// The committed `block.manifest.json` is a PAGE-APP SOURCE manifest: it declares
// `page`, `scopes` etc. and OMITS `appId`, `targets` and `iframe.src`, which the
// platform injects. Since `@civitai/app-sdk` 0.48, `defineBlock` (now on the
// Node-only `@civitai/app-sdk/manifest` subpath, with `ajv` as its peer) validates
// exactly that source shape against the canonical schema — and REJECTS a
// manifest carrying `iframe.src`, which is server-owned — so the source is
// validated as committed, with nothing added or removed.
//
// All eight scopes are members of the SDK's `BLOCK_SCOPES` as of 0.59.0
// (`apps:store:items:write` arrived there), so no scope needs filtering.

import { defineBlock } from '@civitai/app-sdk/manifest';
import type { BlockManifest } from '@civitai/app-sdk/blocks';

import rawManifest from '../block.manifest.json';

/** The raw committed manifest (page-app source shape). */
export const manifest = rawManifest as unknown as Record<string, unknown>;

export class ManifestValidationError extends Error {
  override readonly name = 'ManifestValidationError';
}

/**
 * Run the SDK's `defineBlock` over the source manifest as committed. Returns it
 * typed; throws `BlockManifestError` (with a `.field` dot-path) on any violation.
 */
export function validateManifest(source: Record<string, unknown> = manifest): BlockManifest {
  return defineBlock({ manifest: source as unknown as BlockManifest });
}

/** The `page.buzzBudgetPerGen` declared in the source manifest. */
export function manifestBuzzBudgetPerGen(source: Record<string, unknown> = manifest): number | undefined {
  const page = source.page as Record<string, unknown> | undefined;
  const v = page?.buzzBudgetPerGen;
  return typeof v === 'number' ? v : undefined;
}
