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
} from './post.js';

// 🔴 THERE IS NO `expect(POST_MAX_IMAGES).toBe(20)` HERE, AND ITS ABSENCE IS
// DELIBERATE. That assertion compares two spellings of one value inside one
// repo, edited in one commit, so it cannot detect the server drift its own
// comment claimed to catch — and a test that reads as coverage while providing
// none is worse than no test, because it stops anyone looking. The cap is
// covered where it is observable instead: `KeptGallery` stops selection at it
// and says so, which is behaviour a mutation to the constant would break.

describe('parsePostTags', () => {
  it('trims, drops empties, and keeps the order typed', () => {
    expect(parsePostTags(' portrait ,neon,, cyberpunk ')).toEqual(['portrait', 'neon', 'cyberpunk']);
  });

  it('de-duplicates case-insensitively, keeping the FIRST spelling', () => {
    expect(parsePostTags('Portrait, portrait, PORTRAIT, neon')).toEqual(['Portrait', 'neon']);
  });

  /**
   * 🔴 NO CLIENT CAP, AND THAT IS THE ASSERTION. civitai TRUNCATES an over-long
   * tag list rather than refusing the post, so a cap here could only duplicate a
   * silent truncation — there is no refusal to get in front of, and the host's
   * consent screen shows the viewer the list it actually resolved.
   */
  it('does not truncate the list — the server does that, silently', () => {
    expect(parsePostTags('a,b,c,d,e,f,g')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
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

  /**
   * 🔴 THE PATH THE VIEWER ACTUALLY HAS. Nothing inside a sandboxed block iframe
   * hands a viewer a raw `modelVersionId`; the only place the number is visible
   * is the query parameter on a civitai model page, i.e. their address bar. So a
   * paste of that URL is the primary input, and each of these is a real address
   * bar shape — the bare version link, one carrying more parameters after it,
   * and one with a fragment.
   */
  it('reads the id out of a pasted model URL', () => {
    expect(parseModelVersionId('https://civitai.com/models/133005?modelVersionId=782002')).toBe(782002);
    expect(parseModelVersionId('  https://civitai.com/models/133005?modelVersionId=782002  ')).toBe(782002);
    expect(parseModelVersionId('https://civitai.com/models/133005?modelVersionId=782002&dialog=x')).toBe(
      782002,
    );
    expect(parseModelVersionId('https://civitai.com/models/133005?dialog=x&modelVersionId=782002')).toBe(
      782002,
    );
    expect(parseModelVersionId('https://civitai.com/models/133005?modelVersionId=782002#gallery')).toBe(
      782002,
    );
  });

  /**
   * 🔴 IT PARSES OR IT REFUSES — IT NEVER GUESSES. A model URL carries a modelId
   * in its PATH as well, and `133005` is not a version id: attaching to the
   * wrong id is a server refusal the viewer has no way to diagnose, so a link
   * with no `modelVersionId` parameter is malformed input rather than a hint.
   */
  it('refuses a model link that names no version, rather than guessing the path id', () => {
    expect(parseModelVersionId('https://civitai.com/models/133005')).toBeUndefined();
    expect(parseModelVersionId('https://civitai.com/models/133005/neon-portrait')).toBeUndefined();
    // Not anchored to a `?`/`&`, so a word in prose cannot be mined for an id.
    expect(parseModelVersionId('the modelVersionId=782002 one')).toBeUndefined();
  });

  it('omits the key rather than sending something the host must reject', () => {
    // Each of these would otherwise travel as `modelVersionId` and be refused
    // server-side, costing the viewer the whole post for a typo in an OPTIONAL
    // field.
    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      '0',
      0,
      -3,
      1.5,
      '1.5',
      'abc',
      '12a',
      NaN,
      Infinity,
      'https://civitai.com/models/1?modelVersionId=0',
      'https://civitai.com/models/1?modelVersionId=abc',
      'https://civitai.com/models/1?modelVersionId=',
      // Past `Number.MAX_SAFE_INTEGER`, so `Number()` would round it to a
      // different id than the one pasted.
      '90071992547409910',
    ]) {
      expect(parseModelVersionId(bad as number | string | null | undefined)).toBeUndefined();
    }
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
   * A `visible` image the host returned WITHOUT the flag and without a rating.
   *
   * 🔴 POSTABLE, AND THAT IS THE ASSERTION. The gate states the biconditional —
   * *"Absent ⇔ `ratingPending`"* — so this shape is not the pending one, and
   * reading it as pending would put the cell behind copy promising a wait that
   * never ends ("you can post this once that finishes"), permanently, with no
   * escape hatch. The flag is the spelling; an absent rating is not a second
   * one.
   */
  const unflaggedNoRating: BlockGatedImage = {
    imageId: 3,
    status: 'visible',
    url: 'https://img.example/3.jpg',
    width: 512,
    height: 512,
  };
  const hidden: BlockGatedImage = { imageId: 4, status: 'hidden' };

  it('reads an unrated own-image as pending, by the flag the host sets', () => {
    expect(isRatingPending(pending)).toBe(true);
    expect(isRatingPending(rated)).toBe(false);
    expect(isRatingPending(hidden)).toBe(false);
  });

  it('does NOT strand an image whose rating is merely absent', () => {
    expect(isRatingPending(unflaggedNoRating)).toBe(false);
    expect(isPostableGatedState(unflaggedNoRating)).toBe(true);
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

  /**
   * 🔴 AND IT DOES NOT CLAIM AN OUTCOME IT CANNOT KNOW. The sentence used to end
   * *"Nothing was posted."* — the exact claim `POST_TIMEOUT_NOTICE` is written
   * NOT to make, on a branch that knows even less than the timeout does: all the
   * app has here is that a refusal came back carrying no words, which says
   * nothing about what the server did before sending it. It may describe the
   * refusal; it may not describe the post.
   */
  it('never renders an empty banner, and never asserts nothing was posted', () => {
    const outcome = describeCreatePostError('   ', { timedOut: false });
    expect(outcome).toEqual({
      kind: 'notice',
      source: 'server',
      message:
        'Civitai turned the post down and didn’t say why. Check your Civitai profile before posting these again.',
    });
    expect(outcome).not.toMatchObject({ message: expect.stringContaining('Nothing was posted') });
  });
});
