// `OPEN_IMAGE_PICKER` — the host's picker over the viewer's OWN Civitai images,
// used here to choose a generator's App Store card image.
//
// 🔴 THE APP NEVER LISTS THE LIBRARY. The host opens its own modal over the
// viewer's images and hands back only the one they picked, so this needs no
// scope, no REST read of anyone's images, and nothing a moderator must approve.
// `sources: ['posted']` restricts the modal to the host's "posted pickable" set
// — the viewer's own images in a published post, scan complete, unflagged and
// rated (civitai `postedPickableWhere`). Those are the only ones that carry an
// `imageId`, and an `imageId` is what the store's `upsert` takes.
//
// `publicOnly: true` (civitai/civitai#6134) narrows that set further to images in
// a post that is not Private — the store shows a card to everyone, so a pick
// from a Private post is one the store would refuse. 🔴 It must be the literal
// boolean: the host REFUSES a non-boolean `publicOnly` (`resolveImagePickerRequest`)
// rather than ignoring it. A host older than #6134 ignores the key and offers the
// whole posted set, as before.
//
// ⚠️ THE PICKER'S SET IS STILL NOT PROVABLY THE STORE'S. The store checks the
// image with a separate anonymous-visibility read (`publicImageOwner` →
// `getImage({ isModerator: false })`), so a pick can still be refused with
// `image_not_public` — by an older host that ignored `publicOnly`, or because a
// pick that was public stopped being so later (the post made Private, the image
// re-rated). The caller surfaces that refusal; it does not assume eligibility.
//
// `@civitai/sdk` 0.15 has no wrapper for this message, but its transport ledger
// does (`OPEN_IMAGE_PICKER` → `IMAGE_PICKER_RESULT`, legacy framing), so a plain
// `transport.request()` correlates the reply. The transport imposes no timeout,
// so one is applied here: the reply waits on a person, and a host that predates
// the picker never answers at all.

import type { BlockPickedImageInfo } from '@civitai/app-sdk/blocks';

import { getPlatformTransport } from './client.js';

/** Ten minutes: the reply waits on the viewer choosing. Same ceiling as the post confirm. */
export const IMAGE_PICKER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Open the host picker over the viewer's own POSTED images, from public posts
 * only (on a host that supports `publicOnly`). Resolves with the
 * picked image, or `null` when nothing was picked (dismissed, signed out, review
 * mode). Rejects on a host refusal or a timeout.
 */
export async function pickPostedImage(): Promise<BlockPickedImageInfo | null> {
  const transport = getPlatformTransport();
  const reply = (await transport.request(
    'OPEN_IMAGE_PICKER',
    { sources: ['posted'], publicOnly: true },
    { signal: AbortSignal.timeout(IMAGE_PICKER_TIMEOUT_MS) },
  )) as { selected?: BlockPickedImageInfo | null } | null | undefined;
  return reply?.selected ?? null;
}
