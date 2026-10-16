// Refusal-code → viewer copy. Pure; literal expectations.
//
// 🔴 The sentences are pinned WHOLE: a guard on a word is walkable by rewording,
// and these are the only words a viewer reads about why a publish failed.

import { describe, expect, it } from 'vitest';

import {
  isStorageRefusal,
  notEligibleMessage,
  PUBLISH_CONSENT_MESSAGE,
  PUBLISH_CONTENT_REJECTED_MESSAGE,
  PUBLISH_SIGN_IN_MESSAGE,
  publishRefusalMessage,
  SharedWriteRefusal,
  storageFailureMessage,
} from './storageErrors.js';

const SERVER_PROSE = 'SERVER-PROSE-MUST-NOT-RENDER';
const refusal = (code: string, details?: Record<string, unknown>) => ({ code, message: SERVER_PROSE, details });

describe('publishRefusalMessage', () => {
  it.each([
    ['consent_required', undefined, PUBLISH_CONSENT_MESSAGE],
    ['sign_in_required', undefined, PUBLISH_SIGN_IN_MESSAGE],
    ['content_rejected', { category: 'blocked' }, PUBLISH_CONTENT_REJECTED_MESSAGE],
    ['too_large', undefined, 'This generator is too large to publish. Remove some buttons or shorten its text, then try again.'],
    ['rate_limited', { retryAfter: 360 }, "You've published or edited a lot just now. Wait a few minutes, then try again."],
    ['not_author', undefined, 'Only the person who published this generator can change it.'],
    ['not_found', undefined, "This generator isn't published any more, so it couldn't be updated. Publish it again to share it."],
    ['version_conflict', { currentVersion: 3 }, 'This generator was changed somewhere else (another tab?). Go back, reopen it and try again.'],
    ['moderation_unavailable', { retryAfter: 5 }, "This couldn't be published just now. Try again in a moment."],
    ['a_code_from_a_later_server', undefined, "This couldn't be published just now. Try again in a moment."],
  ])('%s → fixed copy', (code, details, expected) => {
    const msg = publishRefusalMessage(refusal(code, details));
    expect(msg).toBe(expected);
    expect(msg).not.toContain(SERVER_PROSE);
  });

  /**
   * 🔴 THE CEILING DECIDES WHO CAN FIX IT: the author's own allowance is freed by
   * removing their own items; the app's is not theirs to free.
   */
  it.each([
    ['author', "You've used all of your storage in this app. Remove some of your drafts or published generators, then try again."],
    ['viewer', "You've used all of your storage in this app. Remove some of your drafts or published generators, then try again."],
    ['app', "This app's storage is full right now, so this couldn't be published."],
    [undefined, "This app's storage is full right now, so this couldn't be published."],
  ])('quota_exceeded at the %s ceiling', (ceiling, expected) => {
    expect(publishRefusalMessage(refusal('quota_exceeded', ceiling ? { ceiling } : undefined))).toBe(expected);
  });

  it('not_eligible is keyed on details.reason', () => {
    expect(publishRefusalMessage(refusal('not_eligible', { reason: 'account_too_new' }))).toBe(
      'Your Civitai account is too new to publish yet. Try again in a few days.',
    );
  });
});

describe('notEligibleMessage', () => {
  it.each([
    ['onboarding_incomplete', "Finish setting up your Civitai account first, then try again — publishing isn't available until onboarding is complete."],
    ['email_unverified', 'Verify your email address on Civitai first, then try again.'],
    ['account_too_new', 'Your Civitai account is too new to publish yet. Try again in a few days.'],
    ['membership_required', 'Publishing here needs a Civitai membership.'],
    ['app_not_approved', "Publishing isn't available for this app right now."],
    ['apps_disabled', "Publishing isn't available for this app right now."],
    ['restricted', "Your account can't publish here."],
    ['ineligible', "Your account can't publish here."],
    [undefined, "Your account can't publish here."],
  ])('%s', (reason, expected) => {
    expect(notEligibleMessage(reason)).toBe(expected);
  });
});

describe('storageFailureMessage', () => {
  it.each([
    ['sign_in_required', undefined, 'Sign in first.'],
    ['rate_limited', { retryAfter: 60 }, 'Too many requests just now. Wait a minute, then try again.'],
    ['quota_exceeded', { ceiling: 'viewer' }, "You've used all of your storage in this app. Remove some drafts or kept images, then try again."],
    ['quota_exceeded', { ceiling: 'app' }, "This app's storage is full right now."],
    ['not_author', undefined, 'Only the person who published this generator can change it.'],
    ['internal_error', undefined, "Couldn't reach Civitai just now. Try again in a moment."],
  ])('%s → fixed copy', (code, details, expected) => {
    expect(storageFailureMessage(refusal(code, details))).toBe(expected);
  });
});

describe('isStorageRefusal', () => {
  it('recognises the store envelope by shape, and not a refusal already turned into copy', () => {
    expect(isStorageRefusal(refusal('rate_limited'))).toBe(true);
    expect(isStorageRefusal(new SharedWriteRefusal(PUBLISH_CONSENT_MESSAGE, 'consent_required'))).toBe(false);
    expect(isStorageRefusal(new Error('plain'))).toBe(false);
    expect(isStorageRefusal(null)).toBe(false);
  });
});
