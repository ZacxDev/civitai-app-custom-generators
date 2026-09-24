// The per-viewer GATED image read, over `GET /api/v1/blocks/gated-images?ids=`.
//
// Replaces the `GET_IMAGES_BY_IDS` → `IMAGES_RESULT` bridge message. The route is
// the REST twin of exactly that message, written for apps porting onto
// `@civitai/sdk`, and its response is documented as *"byte-identical to the
// `IMAGES_RESULT` bridge payload, in REQUEST order, with unresolvable ids
// omitted"* — which is why `BlockGatedImage` is still the type and why nothing
// downstream of `deps.getImages` changed.
//
// 🔴 DO NOT SUBSTITUTE `blocks/images?ids=`, WHICH LOOKS LIKE THE SAME READ AND IS
// NOT. The two corpora are DISJOINT, not merely differently disclosed:
// `blocks/images` searches the Meilisearch index, whose source query hard-filters
// `postId IS NOT NULL`; this route's corpus is exactly the complement, `postId IS
// NULL` scoped to the calling app's own `blockPublishedAppId`. Complementary
// predicates — an image cannot satisfy both — so `blocks/images?ids=` returns an
// EMPTY ARRAY for every id in this route's corpus, at any ceiling, for any viewer,
// forever. The substitution does not lose a tile; it loses all of them.
//
// 🔴 AND THE `hidden` DISCRIMINATOR IS LOAD-BEARING FOR THIS APP SPECIFICALLY.
// The route's own docblock names us: *"`civitai-app-custom-generators` treats this
// read as the ONLY sanctioned source of a cover url, mapping anything not
// `visible` to `null` so a card can never fall back to the unmoderated stored
// url."* `blocks/images` reports a withheld id by OMISSION, which would make
// "hidden from you" and "deleted" the same observation.
//
// ⚠️ AN ANONYMOUS VIEWER GETS 401, NOT AN EMPTY LIST — and this is PARITY with the
// bridge, which always refused the anon subject here, so it is not a migration
// regression. A signed-out viewer browsing the public board resolves no cover
// images on either transport. `Browse` already renders a placeholder for that.

import type { BlockGatedImage } from '@civitai/app-sdk/blocks';

import { getClient } from './client.js';

/**
 * Ids per request, matching the route's `IMAGE_IDS_BATCH_MAX`.
 *
 * Held equal to the bridge procedure's own inline `.max(100)` by a parity test on
 * the server, so this cannot drift into sending a batch the route refuses.
 */
export const IMAGE_IDS_BATCH_MAX = 100;

/**
 * Resolve per-viewer moderated display data for a list of image ids.
 *
 * Each result is `visible` (with a host-served `url`) or `hidden` (NO url). Ids
 * the viewer may not see, or that do not exist, are OMITTED — so the result can be
 * shorter than the request. Never infer deletion from absence.
 *
 * Batched at {@link IMAGE_IDS_BATCH_MAX} because the route refuses a larger `ids`
 * list outright, and this app's gallery legitimately holds more than that: a
 * viewer's kept-runs grid grows without bound, and one over-long request would
 * fail the whole grid rather than a page of it.
 */
export async function fetchGatedImages(imageIds: number[]): Promise<BlockGatedImage[]> {
  if (imageIds.length === 0) return [];
  const app = await getClient();

  const batches: number[][] = [];
  for (let i = 0; i < imageIds.length; i += IMAGE_IDS_BATCH_MAX) {
    batches.push(imageIds.slice(i, i + IMAGE_IDS_BATCH_MAX));
  }

  const pages = await Promise.all(
    batches.map((batch) =>
      app.site.get<{ images?: BlockGatedImage[] }>('blocks/gated-images', {
        // The route parses `?ids=1,2,3` (a comma-delimited number array), so the
        // list is joined rather than repeated.
        query: { ids: batch.join(',') },
      }),
    ),
  );

  return pages.flatMap((p) => p.images ?? []);
}
