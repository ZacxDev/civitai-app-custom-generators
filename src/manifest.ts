// Manifest loading + validation.
//
// The committed `block.manifest.json` is a PAGE-APP SOURCE manifest: it declares
// `page`, `scopes` etc. and OMITS `appId`, `targets` and `iframe.src`, which the
// platform injects. Since `@civitai/app-sdk` 0.48, `defineBlock` (now on the
// Node-only `@civitai/app-sdk/manifest` subpath, with `ajv` as its peer) validates
// exactly that source shape against the canonical schema — and REJECTS a
// manifest carrying `iframe.src`, which is server-owned — so the source is
// validated as committed.
//
// All six scopes are members of the SDK's `BLOCK_SCOPES` (`apps:storage` and
// `apps:storage:publish` included), and the schema knows the `storage` block, so
// no scope needs filtering before the gate runs.

import { defineBlock } from '@civitai/app-sdk/manifest';
import type { BlockManifest } from '@civitai/app-sdk/blocks';

import rawManifest from '../block.manifest.json';

/** The raw committed manifest (page-app source shape). */
export const manifest = rawManifest as unknown as Record<string, unknown>;

export class ManifestValidationError extends Error {
  override readonly name = 'ManifestValidationError';
}

/**
 * Run the SDK's `defineBlock` over a source manifest (default: as committed).
 * Returns it typed; throws `BlockManifestError` (with a `.field` dot-path) on any
 * violation.
 */
export function validateManifest(source: Record<string, unknown> = manifest): BlockManifest {
  return defineBlock({ manifest: source as unknown as BlockManifest });
}

/**
 * The manifest without its per-collection `schema`s.
 *
 * It no longer feeds the `defineBlock` gate: since `@civitai/app-sdk` 0.81 the gate
 * reads collection schemas, and the manifest is validated as committed. Two tests
 * still use it: `src/manifest.test.ts` pins the collections' key-space shape apart
 * from their schemas (which `src/platform/storageSchemas.test.ts` pins), and
 * `src/platform/appStorage.test.ts` builds a schemaless store fake from it.
 */
export function withoutCollectionSchemas(source: Record<string, unknown> = manifest): Record<string, unknown> {
  const storage = source.storage as { collections?: Record<string, Record<string, unknown>> } | undefined;
  if (!storage?.collections) return source;
  const collections = Object.fromEntries(
    Object.entries(storage.collections).map(([name, decl]) => {
      const rest = { ...decl };
      delete rest.schema;
      return [name, rest];
    }),
  );
  return { ...source, storage: { ...storage, collections } };
}

/** The `page.buzzBudgetPerGen` declared in the source manifest. */
export function manifestBuzzBudgetPerGen(source: Record<string, unknown> = manifest): number | undefined {
  const page = source.page as Record<string, unknown> | undefined;
  const v = page?.buzzBudgetPerGen;
  return typeof v === 'number' ? v : undefined;
}
