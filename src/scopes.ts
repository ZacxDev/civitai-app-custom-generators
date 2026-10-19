// Block-scope constants used by the app. All six are declared in the manifest.
//
// `ai:write:budgeted` is CONSENT-GATED: the host mints the first token WITHOUT
// it and only adds it after the viewer grants consent (REQUEST_CONSENT →
// TOKEN_REFRESH). So the runner must check the live token scopes before
// generating and, if absent, request consent first.

import { BLOCK_SCOPES } from '@civitai/app-sdk/blocks';

export const AI_WRITE_BUDGETED = 'ai:write:budgeted';
export const BUZZ_READ_SELF = 'buzz:read:self';
/**
 * The App Blocks document store: every read, the viewer's private `kv`
 * collection, deleting their own documents, votes, downvote marks and counters
 * (`generator_marks`) and reports. CONSENT-EXEMPT — the host mints it on the
 * first token.
 */
export const APPS_STORAGE = BLOCK_SCOPES.APPS_STORAGE;
/**
 * Creating and editing documents in the shared `"own"` collections — `records`
 * (publishing a generator, or editing a published one) and `generator_media`
 * (a kept run's published-output record). 🔴 CONSENT-GATED like
 * `ai:write:budgeted`: the first token does NOT carry it, so every path that
 * publishes checks {@link hasPublishScope} and asks for it first. The
 * `generator_media` write is best-effort: attempted only when the token already
 * carries the scope, never prompted for mid-keep.
 */
export const APPS_STORAGE_PUBLISH = BLOCK_SCOPES.APPS_STORAGE_PUBLISH;
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

/** Does the current token carry the shared-publish scope (consent-gated)? */
export function hasPublishScope(tokenScopes: readonly string[] | undefined): boolean {
  return (tokenScopes ?? []).includes(APPS_STORAGE_PUBLISH);
}
