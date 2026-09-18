// Block-scope constants used by the app. All seven are declared in the manifest.
//
// `ai:write:budgeted` is CONSENT-GATED: the host mints the first token WITHOUT
// it and only adds it after the viewer grants consent (REQUEST_CONSENT →
// TOKEN_REFRESH). So the runner must check the live token scopes before
// generating and, if absent, request consent first.

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

/** Does the current token carry the (consent-gated) generation scope? */
export function hasGenerateScope(tokenScopes: readonly string[] | undefined): boolean {
  return (tokenScopes ?? []).includes(AI_WRITE_BUDGETED);
}
