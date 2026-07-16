// Block-scope constants used by the app. All six are declared in the manifest.
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

/** Does the current token carry the (consent-gated) generation scope? */
export function hasGenerateScope(tokenScopes: readonly string[] | undefined): boolean {
  return (tokenScopes ?? []).includes(AI_WRITE_BUDGETED);
}
