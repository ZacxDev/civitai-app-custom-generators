// Viewer copy for a refusal from the App Blocks DOCUMENT STORE.
//
// The store refuses in one envelope — `{ code, message, details }` — and the SDK
// raises it as a `StorageError`. 🔴 `message` IS SERVER PROSE AND IS NEVER RENDERED:
// it is written for developers, says nothing about what the viewer can do, and can
// change without a release of this app. Everything a viewer reads about a refusal
// comes from this file, keyed on `code` and, where the code alone is ambiguous, on
// `details.reason` / `details.ceiling` (the store's own discriminators).
//
// Pure, and reads the error by SHAPE (`code` / `details` / `status` fields) rather
// than by `instanceof`, so it sits in the `node` vitest project with literal
// expectations and does not import `@civitai/sdk` (only `src/platform/` may).

/** The fields of a `StorageError` this file reads. Anything else is not a store refusal. */
export interface StorageRefusalLike {
  code: string;
  status?: number;
  details?: Record<string, unknown>;
}

/** Is `err` a document-store refusal (a `StorageError`, or something shaped like one)? */
export function isStorageRefusal(err: unknown): err is StorageRefusalLike {
  return (
    !!err &&
    typeof err === 'object' &&
    typeof (err as { code?: unknown }).code === 'string' &&
    (err as { name?: unknown }).name !== 'SharedWriteRefusal'
  );
}

function detail(err: StorageRefusalLike, name: string): string | undefined {
  const v = err.details?.[name];
  return typeof v === 'string' ? v : undefined;
}

/**
 * The publish scope is missing. Asked for when the viewer first publishes (see
 * `App.tsx` → `ensurePublishGrant`). Says "try again" because nothing retries for
 * them: a dismissed or declined dialog leaves the press failed.
 */
export const PUBLISH_CONSENT_MESSAGE =
  'Publishing needs your permission first. Approve it in the dialog, then try again.';

export const PUBLISH_SIGN_IN_MESSAGE = 'Sign in to publish.';

/**
 * 🔴 NAMES EVERY PLACE THE TEXT CAN BE. The store scans EVERY string in the
 * document — `title`, `body` and every string leaf of `data` — and its refusal
 * carries only a coarse `details.category`, never the field. So the copy cannot
 * point at one field, and narrowing it to "the name or description" would send the
 * author to the wrong place when a button's prompt template is what tripped it.
 */
export const PUBLISH_CONTENT_REJECTED_MESSAGE =
  "This couldn't be published: Civitai's content check rejected some of its text — the name, the description, a button label or a prompt template. Edit the text and try again.";

/**
 * Viewer copy for a refused SHARED write (publish a new generator, or edit a
 * published one). Every code the store documents maps to a fixed sentence; an
 * unrecognised one gets the generic retry line, never the server's message.
 */
export function publishRefusalMessage(err: StorageRefusalLike): string {
  switch (err.code) {
    case 'consent_required':
      return PUBLISH_CONSENT_MESSAGE;
    case 'sign_in_required':
    case 'unauthenticated':
      return PUBLISH_SIGN_IN_MESSAGE;
    case 'content_rejected':
      return PUBLISH_CONTENT_REJECTED_MESSAGE;
    case 'not_eligible':
      return notEligibleMessage(detail(err, 'reason'));
    case 'quota_exceeded':
      // 🔴 THE CEILING DECIDES WHO CAN FIX IT. `author`/`viewer` is the viewer's
      // own per-app allowance, which removing their own drafts or published
      // generators frees; `app` is the whole app's, which nothing the viewer does
      // changes. An unnamed ceiling is treated as the app's — the copy that
      // promises nothing.
      return detail(err, 'ceiling') === 'author' || detail(err, 'ceiling') === 'viewer'
        ? "You've used all of your storage in this app. Remove some of your drafts or published generators, then try again."
        : "This app's storage is full right now, so this couldn't be published.";
    case 'too_large':
      return 'This generator is too large to publish. Remove some buttons or shorten its text, then try again.';
    case 'rate_limited':
      return "You've published or edited a lot just now. Wait a few minutes, then try again.";
    case 'not_author':
      return 'Only the person who published this generator can change it.';
    case 'not_found':
      return "This generator isn't published any more, so it couldn't be updated.";
    case 'version_conflict':
      return 'This generator was changed somewhere else (another tab?). Go back, reopen it and try again.';
    default:
      return "This couldn't be published just now. Try again in a moment.";
  }
}

/**
 * `not_eligible`, by `details.reason` — the store's minimum-trust gate (about the
 * viewer's ACCOUNT) and the app-level gate (about this app). Each reason that the
 * viewer can clear names what clears it; the ones they cannot say so plainly.
 */
export function notEligibleMessage(reason: string | undefined): string {
  switch (reason) {
    case 'onboarding_incomplete':
      return "Finish setting up your Civitai account first, then try again — publishing isn't available until onboarding is complete.";
    case 'email_unverified':
      return 'Verify your email address on Civitai first, then try again.';
    case 'account_too_new':
      return 'Your Civitai account is too new to publish yet. Try again in a few days.';
    case 'membership_required':
      return 'Publishing here needs a Civitai membership.';
    case 'app_not_approved':
    case 'apps_disabled':
      return "Publishing isn't available for this app right now.";
    case 'restricted':
    case 'ineligible':
    default:
      return "Your account can't publish here.";
  }
}

/**
 * Viewer copy for any OTHER store refusal — a read, a private write, a withdraw,
 * a vote. Coarser than {@link publishRefusalMessage} on purpose: these are not
 * authoring actions, so "edit the text" advice would be wrong.
 */
export function storageFailureMessage(err: StorageRefusalLike): string {
  switch (err.code) {
    case 'sign_in_required':
    case 'unauthenticated':
      return 'Sign in first.';
    case 'not_eligible':
      return notEligibleMessage(detail(err, 'reason'));
    case 'rate_limited':
      return 'Too many requests just now. Wait a minute, then try again.';
    case 'quota_exceeded':
      return detail(err, 'ceiling') === 'author' || detail(err, 'ceiling') === 'viewer'
        ? "You've used all of your storage in this app. Remove some drafts or kept images, then try again."
        : "This app's storage is full right now.";
    case 'not_author':
      return 'Only the person who published this generator can change it.';
    default:
      return "Couldn't reach Civitai just now. Try again in a moment.";
  }
}

/**
 * A shared write the app refused to send, or the store refused, for a reason the
 * VIEWER can read: `message` is fixed copy from this file. Thrown so the Builder's
 * existing `catch → setError(err.message)` renders it unchanged.
 */
export class SharedWriteRefusal extends Error {
  override readonly name = 'SharedWriteRefusal';
  constructor(
    message: string,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
