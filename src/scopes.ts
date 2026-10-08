// Block-scope constants used by the app. All eight are declared in the manifest.
//
// `ai:write:budgeted` is CONSENT-GATED: the host mints the first token WITHOUT
// it and only adds it after the viewer grants consent (REQUEST_CONSENT →
// TOKEN_REFRESH). So the runner must check the live token scopes before
// generating and, if absent, request consent first.

import { BLOCK_SCOPES } from '@civitai/app-sdk/blocks';

export const AI_WRITE_BUDGETED = 'ai:write:budgeted';
export const BUZZ_READ_SELF = 'buzz:read:self';
export const APPS_STORAGE_READ = 'apps:storage:read';
export const APPS_STORAGE_WRITE = 'apps:storage:write';
export const APPS_STORAGE_SHARED_READ = 'apps:storage:shared:read';
export const APPS_STORAGE_SHARED_WRITE = 'apps:storage:shared:write';
/**
 * Publish a REAL, feed-visible Post on the VIEWER'S profile from images this app
 * already published for them (`useCreatePostFromApp()`).
 *
 * SENSITIVE and CONSENT-GATED, like `ai:write:budgeted` — and consent is taken
 * TWICE over: the scope grant once, then a host-chrome confirm on EVERY call,
 * rendering the SERVER'S resolution of the request (the tags it actually
 * matched, real thumbnails) rather than this app's strings. A block cannot show
 * one post and publish another.
 */
export const POSTS_WRITE_SELF = 'posts:write:self';
/**
 * List the viewer's OWN published generators in the civitai App Store as
 * sub-listing cards under this app (`/api/v1/blocks/sub-listings/*`).
 *
 * SENSITIVE (the manifest must justify it) but CONSENT-EXEMPT: the host mints it
 * on an approved app's token without asking, because the real gates are
 * server-side and per call (item authorship, text safety, moderator review,
 * rate limits). It is minted by NO dev, tunnel or review token, so its absence
 * from the token is the normal state outside an approved production build — the
 * app checks for it and makes no store call without it ({@link hasStoreScope}).
 *
 * The SDK's own constant (`BLOCK_SCOPES.APPS_STORE_ITEMS_WRITE`, since
 * `@civitai/app-sdk` 0.59.0).
 */
export const APPS_STORE_ITEMS_WRITE = BLOCK_SCOPES.APPS_STORE_ITEMS_WRITE;

/** Does the current token carry the generation scope (consent-gated)? */
export function hasGenerateScope(tokenScopes: readonly string[] | undefined): boolean {
  return (tokenScopes ?? []).includes(AI_WRITE_BUDGETED);
}

/** Does the current token carry the App Store sub-listing scope? */
export function hasStoreScope(tokenScopes: readonly string[] | undefined): boolean {
  return (tokenScopes ?? []).includes(APPS_STORE_ITEMS_WRITE);
}
