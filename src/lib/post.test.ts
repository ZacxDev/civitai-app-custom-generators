// THE POST PATH'S PURE DECISIONS — the bounds, the postability predicate, and
// the branch that decides what a viewer is told when the host refuses.
//
// 🔴 EVERY COPY EXPECTATION IS A WHOLE LITERAL STRING, never an imported
// constant compared against itself. The failures this file exists to catch are
// SENTENCES — an SDK-internal string reaching a viewer, a timeout described as
// "nothing happened", a raw host token rendered as if it were English — and a
// test that asserts `toBe(POST_TIMEOUT_NOTICE)` passes against any replacement
// for it, including a wrong one. Pinning the whole string means a reword has to
// come back through this suite. That is the price of a machine-readable claim.

import { describe, expect, it } from 'vitest';
import { CREATE_POST_ERROR_CODES } from '@civitai/blocks-react';
import type { BlockGatedImage } from '@civitai/app-sdk/blocks';

import {
  describeCreatePostError,
  isPostableGatedState,
  isRatingPending,
  parseModelVersionId,
  parsePostTags,
  postTextLooksLinky,
  POST_DETAIL_MAX,
  POST_MAX_IMAGES,
  POST_MAX_TAGS,
  POST_TITLE_MAX,
} from './post.js';

describe('the bounds this app mirrors from the server', () => {
  /**
   * 🔴 LITERALS, READ OFF civitai's `block-post.logic.ts`. A client-side bound is
   * only worth having if it is the SAME bound — its entire job is to stop the
   * viewer BEFORE the host's consent dialog rather than after they have agreed
   * to something the server then refuses. A drifted copy is worse than none: it
   * either refuses posts civitai would accept, or lets through the refusal it
   * was added to prevent.
   */
  it('matches the server ceilings exactly', () => {
    expect(POST_MAX_IMAGES).toBe(20);
    expect(POST_MAX_TAGS).toBe(5);
    expect(POST_TITLE_MAX).toBe(255);
    expect(POST_DETAIL_MAX).toBe(2000);
  });
});

describe('parsePostTags', () => {
  it('trims, drops empties, and keeps the order typed', () => {
    expect(parsePostTags(' portrait ,neon,, cyberpunk ')).toEqual(['portrait', 'neon', 'cyberpunk']);
  });

  it('de-duplicates case-insensitively, keeping the FIRST spelling', () => {
    expect(parsePostTags('Portrait, portrait, PORTRAIT, neon')).toEqual(['Portrait', 'neon']);
  });

  it('caps at five, which is the server cap', () => {
    // Six distinct names in, five out — and the SIXTH is the one dropped, not an
    // arbitrary member, so an off-by-one that kept the tail would fail here.
    expect(parsePostTags('a,b,c,d,e,f')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('returns nothing for an empty or whitespace field', () => {
    expect(parsePostTags('')).toEqual([]);
    expect(parsePostTags('  ,  , ')).toEqual([]);
  });
});

describe('parseModelVersionId', () => {
  it('takes a positive whole number, from a number or a string', () => {
    expect(parseModelVersionId(12345)).toBe(12345);
    expect(parseModelVersionId('12345')).toBe(12345);
    expect(parseModelVersionId(' 7 ')).toBe(7);
  });

  it('omits the key rather than sending something the host must reject', () => {
    // Each of these would otherwise travel as `modelVersionId` and be refused
    // server-side, costing the viewer the whole post for a typo in an OPTIONAL
    // field.
    for (const bad of [null, undefined, '', '   ', '0', 0, -3, 1.5, '1.5', 'abc', '12a', NaN, Infinity]) {
      expect(parseModelVersionId(bad as number | string | null | undefined)).toBeUndefined();
    }
  });
});

describe('postTextLooksLinky', () => {
  it('spots the forms a block would actually reach for', () => {
    expect(postTextLooksLinky('see https://example.com/x')).toBe(true);
    expect(postTextLooksLinky('www.example.org')).toBe(true);
    expect(postTextLooksLinky('grab it at mysite.io today')).toBe(true);
  });

  it('leaves ordinary prose alone', () => {
    expect(postTextLooksLinky('A neon portrait, rendered at 1024 by 1024.')).toBe(false);
    expect(postTextLooksLinky('')).toBe(false);
  });
});

describe('what may be put in a post', () => {
  const rated: BlockGatedImage = {
    imageId: 1,
    status: 'visible',
    nsfwLevel: 1,
    contentRating: 'pg',
    url: 'https://img.example/1.jpg',
    width: 512,
    height: 512,
  };
  /** The viewer's OWN image that nothing has rated yet: url, and NO rating. */
  const pending: BlockGatedImage = {
    imageId: 2,
    status: 'visible',
    ratingPending: true,
    url: 'https://img.example/2.jpg',
    width: 512,
    height: 512,
  };
  /**
   * The same state spelled ONLY by the missing rating — no `ratingPending` flag.
   * Checked because a default rating must never be substituted for an absent
   * one, whichever way the host spells the absence.
   */
  const pendingByOmission: BlockGatedImage = {
    imageId: 3,
    status: 'visible',
    url: 'https://img.example/3.jpg',
    width: 512,
    height: 512,
  };
  const hidden: BlockGatedImage = { imageId: 4, status: 'hidden' };

  it('reads an unrated own-image as pending, by either spelling', () => {
    expect(isRatingPending(pending)).toBe(true);
    expect(isRatingPending(pendingByOmission)).toBe(true);
    expect(isRatingPending(rated)).toBe(false);
    expect(isRatingPending(hidden)).toBe(false);
  });

  /**
   * 🔴 THE REFUSAL THIS PREVENTS IS NOT PER-IMAGE. civitai's
   * `resolveAppPublishedImages` refuses unresolvable ids rather than skipping
   * them, so ONE unrated image fails the ENTIRE post — twenty images lost to a
   * keep made a minute ago.
   */
  it('refuses a `visible` image that nothing has rated yet', () => {
    expect(isPostableGatedState(rated)).toBe(true);
    expect(isPostableGatedState(pending)).toBe(false);
    expect(isPostableGatedState(pendingByOmission)).toBe(false);
  });

  it('refuses everything that is not a `visible` image with a url', () => {
    expect(isPostableGatedState(hidden)).toBe(false);
    expect(isPostableGatedState({ imageId: 5, status: 'missing' })).toBe(false);
    expect(isPostableGatedState(undefined)).toBe(false);
    expect(isPostableGatedState({ ...rated, url: '' })).toBe(false);
  });
});

describe('describeCreatePostError', () => {
  /**
   * 🔴 THE ORDERING GUARD, AND THE CONTROL THAT MAKES IT AN ATTRIBUTION.
   *
   * A transport timeout has `code === undefined` exactly like a forwarded server
   * message does, so the natural reading — "no code ⇒ render `.message`" — puts
   * an SDK-internal string in front of a viewer. The first expectation says the
   * flagged case is NOT rendered; the second says the SAME STRING, unflagged, IS
   * rendered verbatim. Without the second, this test would also pass on an
   * implementation that filtered by message content, which would be a different
   * (and wrong) mechanism.
   */
  it('checks .timedOut BEFORE treating a missing code as a renderable message', () => {
    const sdkInternal = 'IframeTransport: request "CREATE_POST_FROM_APP" timed out after 600000ms';

    expect(describeCreatePostError(sdkInternal, { timedOut: true })).toEqual({
      kind: 'notice',
      source: 'timeout',
      message:
        'Civitai didn’t answer in time. Your post may still have gone through — check your Civitai profile before posting these again.',
    });

    // CONTROL: same bytes, no flag ⇒ verbatim. The branch is chosen by the flag.
    expect(describeCreatePostError(sdkInternal, { timedOut: false })).toEqual({
      kind: 'notice',
      source: 'server',
      message: sdkInternal,
    });
  });

  /**
   * 🔴 THE TIMEOUT COPY MAY NOT CLAIM NOTHING HAPPENED, because nobody knows
   * that. The reply never arrived; the WRITE may have landed, and here the write
   * is a public post under the viewer's own name. Pinned as a whole string
   * rather than as a keyword search, which a reword walks straight past.
   */
  it('tells the viewer the post may have landed, and where to look', () => {
    const out = describeCreatePostError('anything', { timedOut: true });
    expect(out).toEqual({
      kind: 'notice',
      source: 'timeout',
      message:
        'Civitai didn’t answer in time. Your post may still have gone through — check your Civitai profile before posting these again.',
    });
  });

  it('reports a dismissal as a dismissal, not as a failure', () => {
    expect(describeCreatePostError('declined', { timedOut: false })).toEqual({ kind: 'declined' });
  });

  it('routes an anonymous viewer to sign-in rather than to an error', () => {
    expect(describeCreatePostError('sign in to post', { timedOut: false })).toEqual({ kind: 'sign-in' });
  });

  it.each([
    [
      'review-mode',
      'Posting is switched off in moderator review. Open Custom Generators normally and these images will post from there.',
    ],
    [
      'block is not ready',
      'This app hasn’t finished connecting to Civitai yet. Give it a second, then press Post again.',
    ],
    [
      'no images to post',
      'Civitai couldn’t use any of these images. They may already belong to a post, or they’re still being checked.',
    ],
    ['no block token', 'Civitai hasn’t handed this app a session yet. Reload the page, then post again.'],
  ])('turns the host code %s into its own sentence', (code, sentence) => {
    const out = describeCreatePostError(code, { timedOut: false });
    expect(out).toEqual({ kind: 'notice', source: 'code', message: sentence });
    // A host token is not English; rendering it raw is the failure mode.
    expect(out.kind === 'notice' && out.message).not.toContain(code);
  });

  /**
   * 🔴 ENUMERATED FROM THE SDK'S OWN ARRAY, so a code added upstream fails HERE
   * rather than falling silently into generic copy. Covers the two non-sentence
   * arms too — the point is that every member is HANDLED, not that every member
   * produces prose.
   */
  it('handles every member of the closed code set, distinctly', () => {
    expect(CREATE_POST_ERROR_CODES).toHaveLength(6);
    const seen = new Set<string>();
    for (const code of CREATE_POST_ERROR_CODES) {
      const out = describeCreatePostError(code, { timedOut: false });
      const key = out.kind === 'notice' ? out.message : out.kind;
      expect(key.length).toBeGreaterThan(0);
      // Distinct: generic copy shared between two codes tells the viewer nothing
      // about which of them happened.
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(6);
  });

  it('renders a free-text server message verbatim', () => {
    // Not a member of the closed set — the host forwards these untouched, and so
    // does this app. A `switch` over the union type would treat it as unmatched.
    const message = 'You can only create 5 posts per hour';
    expect(describeCreatePostError(message, { timedOut: false })).toEqual({
      kind: 'notice',
      source: 'server',
      message,
    });
  });

  it('never renders an empty banner', () => {
    expect(describeCreatePostError('   ', { timedOut: false })).toEqual({
      kind: 'notice',
      source: 'server',
      message: 'Civitai turned the post down without saying why. Nothing was posted.',
    });
  });
});
