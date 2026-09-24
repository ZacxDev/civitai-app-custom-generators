// Generation-resource rehydrate, over `GET /api/v1/blocks/generation-resources?ids=`.
//
// Replaces the `useGenerationResources` hook. When the app loads a saved generator
// it holds only the picked `modelVersionId`s; this returns the SAME public "safe
// subset" the resource picker's result carries, without re-opening the picker.
//
// The projection is field-for-field identical to `BlockResourceInfo` — verified
// against `projectSafeGenerationResource` on the server (`versionId`, `modelId`,
// `modelName`, `versionName`, `baseModel`, `modelType`, `strength`, `minStrength`,
// `maxStrength`, `trainedWords`, `clipSkip`) — so this needs no mapping and
// `lib/generator.ts`'s `rehydrateConfig` was untouched.
//
// ⚠️ MISSES ARE REPORTED BY OMISSION, and there are two ways to be omitted: the
// version is not published/public (`hasAccess` false), or it exceeds the token's
// clamped browsing ceiling. Both are silent. `rehydrateConfig` already treats a
// missing id as "keep the stored name, show no extra detail", which is the correct
// reading — an omitted resource is not a deleted one.

import type { BlockResourceInfo } from '@civitai/app-sdk/blocks';

import { getClient } from './client.js';

/**
 * Ids per request. The route caps `ids` at 30 and 400s a longer list.
 *
 * 🔴 NOT THE SAME CEILING AS THE IMAGE READ, which is 100. A generator with a
 * deep LoRA stack plus its checkpoint can exceed 30, and one over-long request
 * would 400 the whole rehydrate rather than a page of it, so the caller batches.
 */
export const RESOURCE_IDS_BATCH_MAX = 30;

/** Resolve public display data for a list of model-version ids. */
export async function fetchGenerationResources(ids: number[]): Promise<BlockResourceInfo[]> {
  if (ids.length === 0) return [];
  const app = await getClient();

  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += RESOURCE_IDS_BATCH_MAX) {
    batches.push(ids.slice(i, i + RESOURCE_IDS_BATCH_MAX));
  }

  const pages = await Promise.all(
    batches.map((batch) =>
      app.site.get<{ items?: BlockResourceInfo[] }>('blocks/generation-resources', {
        query: { ids: batch.join(',') },
      }),
    ),
  );

  return pages.flatMap((p) => p.items ?? []);
}
