// Manifest loading + validation.
//
// The committed `block.manifest.json` is a PAGE-APP SOURCE manifest: it declares
// `page`, `scopes` etc. and OMITS `appId`, `targets` and `iframe.src`, which the
// platform injects. Since `@civitai/app-sdk` 0.48, `defineBlock` (now on the
// Node-only `@civitai/app-sdk/manifest` subpath, with `ajv` as its peer) validates
// exactly that source shape against the canonical schema — and REJECTS a
// manifest carrying `iframe.src`, which is server-owned — so the source is
// validated as committed, with ONE thing removed: the collection `schema`s (below).
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
 * Run the SDK's `defineBlock` over a source manifest (default: as committed, which
 * the installed gate refuses until it knows collection schemas — see
 * {@link withoutCollectionSchemas}). Returns it typed; throws `BlockManifestError`
 * (with a `.field` dot-path) on any violation.
 */
export function validateManifest(source: Record<string, unknown> = manifest): BlockManifest {
  return defineBlock({ manifest: source as unknown as BlockManifest });
}

/**
 * The manifest without its per-collection `schema`s — the one thing the installed
 * SDK gate cannot read yet.
 *
 * 🔴 A STOPGAP WITH A TRIPWIRE. civitai/civitai#7491 added
 * `storage.collections.<name>.schema` to the canonical manifest schema, but the
 * `@civitai/app-sdk` this repo builds against vendors the schema from before it,
 * so `defineBlock` refuses the committed manifest at `storage.collections.kv.schema`
 * ("not a known property here"). Every other key still goes through the gate.
 * The schemas themselves are checked by `src/platform/storageSchemas.test.ts`, and at submit
 * by civitai. `src/manifest.test.ts` asserts the installed gate STILL refuses them:
 * when an SDK bump makes that case fail, delete this function and validate the
 * manifest as committed again.
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
