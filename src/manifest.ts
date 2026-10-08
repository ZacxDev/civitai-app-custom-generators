// Manifest loading + validation.
//
// The committed `block.manifest.json` is a PAGE-APP SOURCE manifest: it declares
// `page`, `scopes` etc. but OMITS `appId`, `targets`, and `iframe.src` — the
// platform injects those at deploy/serve time. The SDK's `defineBlock`
// validates the FULL runtime shape, so to get a real `defineBlock` gate we
// augment the source manifest to the full shape before validating.
//
// Seven of the eight scopes (`ai:write:budgeted`, `buzz:read:self`,
// `apps:storage:read`, `apps:storage:write`, `apps:storage:shared:read`,
// `apps:storage:shared:write`, `posts:write:self`) are members of BLOCK_SCOPES in
// @civitai/app-sdk (the first six verified against 0.27, `posts:write:self`
// against 0.42), so they validate directly. The eighth, `apps:store:items:write`,
// is not in any published SDK yet — see `SCOPES_AHEAD_OF_SDK`.

import { defineBlock } from '@civitai/app-sdk/blocks';
import type { BlockManifest } from '@civitai/app-sdk/blocks';

import rawManifest from '../block.manifest.json';

/** The raw committed manifest (page-app source shape). */
export const manifest = rawManifest as unknown as Record<string, unknown>;

/**
 * Scopes civitai accepts that the pinned `@civitai/app-sdk` does not list yet.
 *
 * `defineBlock` gates on membership in the SDK's `BLOCK_SCOPES`, so a scope the
 * platform added after the installed SDK was cut would fail this LOCAL gate while
 * being valid where it matters. Those names are filtered out before
 * `defineBlock` runs, and nothing else is.
 *
 * - `apps:store:items:write` — live in civitai#5511; mirrored into the SDK by
 *   civitai/civitai-app-starters#569 (unreleased at 0.10.0).
 *
 * `src/manifest.test.ts` goes red once the installed SDK knows a listed scope, so
 * this list cannot outlive its reason.
 */
export const SCOPES_AHEAD_OF_SDK: readonly string[] = ['apps:store:items:write'];

export class ManifestValidationError extends Error {
  override readonly name = 'ManifestValidationError';
}

/**
 * Augment the page-app source manifest to the full `BlockManifest` runtime shape
 * (adding the platform-injected `appId`, `targets`, `iframe.src`) and run the
 * SDK's `defineBlock`. Returns the validated (augmented) manifest; throws on any
 * violation.
 */
export function validateManifest(source: Record<string, unknown> = manifest): BlockManifest {
  const iframeSource = (source.iframe ?? {}) as Record<string, unknown>;

  const scopes = Array.isArray(source.scopes)
    ? (source.scopes as unknown[]).filter((s) => !(typeof s === 'string' && SCOPES_AHEAD_OF_SDK.includes(s)))
    : source.scopes;

  const augmented = {
    ...(source as object),
    scopes,
    // Platform-injected at deploy time; placeholders for local validation.
    appId: (source.appId as string) ?? 'app_local_custom_generators',
    // Page apps have no manifest `targets`; the platform derives an `app.page`
    // target from `page`. Synthesize one so defineBlock's required-field check
    // passes.
    targets: (source.targets as unknown[]) ?? [{ slotId: 'app.page', priority: 100 }],
    iframe: {
      ...iframeSource,
      src: (iframeSource.src as string) ?? 'https://custom-generators.civit.ai/',
    },
  } as BlockManifest;

  return defineBlock({ manifest: augmented });
}

/** The `page.buzzBudgetPerGen` declared in the source manifest. */
export function manifestBuzzBudgetPerGen(source: Record<string, unknown> = manifest): number | undefined {
  const page = source.page as Record<string, unknown> | undefined;
  const v = page?.buzzBudgetPerGen;
  return typeof v === 'number' ? v : undefined;
}
