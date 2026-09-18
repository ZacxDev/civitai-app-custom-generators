// POSTING KEPT IMAGES TO THE VIEWER'S PROFILE — the pure half.
//
// `useCreatePostFromApp()` asks the host to publish a REAL, feed-visible,
// reward-earning Post under the VIEWER'S byline from images this app already
// published for them. That is strictly more consequential than Keep, so the
// decisions that are cheap to get subtly wrong — what may be selected, what the
// bounds are, and what a viewer is told when the host refuses — live here as
// total functions rather than inside a component.
//
// 🔴 THE SERVER IS THE AUTHORITY AND THIS FILE IS NOT. Every bound below mirrors
// one in civitai's `block-post.logic.ts`, and mirroring it buys exactly one
// thing: the viewer is stopped BEFORE the host's consent dialog opens rather
// than after they have agreed to something the server then refuses. A copy of a
// server rule is never a proof of it, so nothing here may be relied on as a
// guarantee — the refusal path is implemented in full for the cases these
// bounds are meant to make rare.

import { isCreatePostErrorCode } from '@civitai/blocks-react';
import type { BlockCreatePostHostError, BlockGatedImage } from '@civitai/app-sdk/blocks';

/**
 * Hard ceiling on images in ONE app-created post
 * (civitai `BLOCK_POST_MAX_IMAGES`).
 *
 * 🔴 THE SERVER REFUSES AN OVER-CAP POST RATHER THAN TRUNCATING IT, and the
 * divergence from the grid publish (which silently `break`s) is deliberate on
 * their side: a confirm that can be right about the content and wrong about the
 * set is not a consent screen. So an over-cap selection costs the viewer the
 * whole post, which is why selection is bounded here instead of being sent and
 * apologised for.
 */
export const POST_MAX_IMAGES = 20;

/** Hard ceiling on applied tags (civitai `BLOCK_POST_MAX_TAGS`). */
export const POST_MAX_TAGS = 5;

/** Server-side `title` bound (civitai `BLOCK_POST_TITLE_MAX`). */
export const POST_TITLE_MAX = 255;

/** Server-side `detail` bound (civitai `BLOCK_POST_DETAIL_MAX`). */
export const POST_DETAIL_MAX = 2000;

/**
 * `true` when the gate returned an image NOTHING HAS RATED YET.
 *
 * 🔴 TWO SPELLINGS, BOTH CHECKED, AND NEITHER IS "ASSUME G". Since
 * civitai/civitai#4895 the author's own unrated image comes back `visible` with
 * `ratingPending: true` and NO `nsfwLevel` / `contentRating` — the absence IS
 * the fix, and a block that dereferenced those fields would read `undefined`.
 * `nsfwLevel === undefined` is checked alongside the flag so a host that ever
 * omits the flag while still omitting the rating is still read as pending, and a
 * default rating is never substituted for a missing one.
 */
export function isRatingPending(image: BlockGatedImage): boolean {
  return image.status === 'visible' && (image.ratingPending === true || image.nsfwLevel === undefined);
}

/**
 * May this gated-read verdict be put in a post?
 *
 * 🔴 THIS IS A REFUSAL THE APP MUST PREVENT, NOT ONE IT MAY SURFACE. civitai's
 * `resolveAppPublishedImages` requires `classifyGatedImageForViewer(...).status
 * === 'visible'` for EVERY named id and REFUSES unresolvable ids rather than
 * skipping them — its own comment: *"silently posting fewer images than were
 * confirmed would make the confirm inaccurate."* An unrated image classifies as
 * `pending` there, so ONE freshly-kept image in a selection of twenty fails the
 * ENTIRE post with `an image is not available to post`. The client can see that
 * coming (a pending image is exactly the `ratingPending` shape above), so it
 * stops the selection instead of letting the viewer discover it at the confirm.
 */
export function isPostableGatedState(
  state: BlockGatedImage | { imageId: number; status: 'missing' } | undefined,
): boolean {
  if (state == null || state.status !== 'visible') return false;
  if (typeof state.url !== 'string' || state.url.length === 0) return false;
  return !isRatingPending(state);
}

/**
 * Split the composer's comma-separated tag field into the names that will be
 * SENT — trimmed, de-duplicated case-insensitively (first spelling wins), and
 * capped at {@link POST_MAX_TAGS}.
 *
 * ⚠️ WHAT COMES BACK IS NOT WHAT IS APPLIED. The server resolves these against
 * EXISTING tags only: a name matching no tag is DROPPED, never minted. So this
 * is the request, and the host's consent screen — which renders the server's
 * resolution, not these strings — is the answer. The UI must not promise the
 * viewer their tags will be applied.
 */
export function parsePostTags(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(',')) {
    const name = piece.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length === POST_MAX_TAGS) break;
  }
  return out;
}

/**
 * Normalise the optional model-version gallery attach into the value that will
 * be SENT, or `undefined` to omit the key entirely.
 *
 * Returns `undefined` for anything that is not a positive safe integer — an
 * empty field, a cleared control, a half-typed or pasted string — so the request
 * omits `modelVersionId` rather than carrying a `NaN`, a `0` or a float the host
 * would have to reject. Takes `number | string | null` because the composer's
 * control is numeric while a paste is not.
 */
export function parseModelVersionId(raw: string | number | null | undefined): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * A copy of civitai's `URL_LIKE_RE` — the predicate their `validateBlockPostText`
 * refuses `title` and `detail` on.
 *
 * 🔴 ADVISORY ONLY, AND DELIBERATELY NOT A BLOCK. The server owns this refusal
 * and forwards it as a free-text message, which this app renders verbatim. A
 * client-side hard block would be a second, drifting authority: this copy can be
 * narrower than theirs (a homoglyph domain, an exotic TLD) and could also become
 * WIDER than theirs on a future server relaxation, at which point it would
 * refuse text civitai would have accepted. So it warns and lets the viewer
 * proceed.
 */
const URL_LIKE_RE =
  /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|ai|xyz|app|dev|me|ru|cn|gg|link|click|top|site|online|shop)\b)/i;

/** `true` when civitai is likely to refuse this text for containing a link. */
export function postTextLooksLinky(text: string): boolean {
  return URL_LIKE_RE.test(text);
}

/**
 * What the viewer is told when a post attempt fails.
 *
 * `declined` and `sign-in` are not messages at all — one is silence and the
 * other is a route into the host sign-in flow — which is why this is a
 * discriminated union rather than a string.
 */
export type PostFailure =
  | { kind: 'declined' }
  | { kind: 'sign-in' }
  | { kind: 'notice'; message: string; source: 'timeout' | 'code' | 'server' };

/**
 * The timeout sentence.
 *
 * 🔴 IT MUST NOT SAY "NOTHING HAPPENED", BECAUSE NOBODY KNOWS THAT. A transport
 * timeout means the reply never arrived, not that the write never landed — and
 * here the write is a PUBLIC POST under the viewer's own name. Telling them to
 * check their profile is the only honest instruction, and it is also what keeps
 * a duplicate post from being the viewer's obvious next move.
 */
export const POST_TIMEOUT_NOTICE =
  'Civitai didn’t answer in time. Your post may still have gone through — check your Civitai profile before posting these again.';

/** Shown when the host refuses for sign-in and this app has no sign-in route wired. */
export const POST_SIGN_IN_NOTICE = 'Sign in to Civitai first — there’s no profile to post to yet.';

/** Shown when the failure carries no message at all. */
export const POST_UNKNOWN_NOTICE = 'Civitai turned the post down without saying why. Nothing was posted.';

/**
 * One sentence per HOST refusal code, minus the two that are not sentences.
 *
 * 🔴 A `Record` OVER AN `Exclude`, NOT A `switch`, AND NOT A DEFAULT. The type
 * makes the map exhaustive, so a code added to `BlockCreatePostHostError`
 * fails the typecheck here instead of quietly falling into generic copy — and
 * spelling it as data keeps {@link describeCreatePostError} free of a `switch`
 * over a union whose runtime values include arbitrary server prose.
 */
const CODE_NOTICE: Record<
  Exclude<BlockCreatePostHostError, 'declined' | 'sign in to post'>,
  string
> = {
  'review-mode':
    'Posting is switched off in moderator review. Open Custom Generators normally and these images will post from there.',
  'block is not ready':
    'This app hasn’t finished connecting to Civitai yet. Give it a second, then press Post again.',
  'no images to post':
    'Civitai couldn’t use any of these images. They may already belong to a post, or they’re still being checked.',
  'no block token':
    'Civitai hasn’t handed this app a session yet. Reload the page, then post again.',
};

/**
 * Turn a `CreatePostError` into what the viewer sees.
 *
 * 🔴 `timedOut` IS TESTED FIRST, AND THE ORDER IS THE WHOLE POINT. A transport
 * timeout ALSO has `code === undefined`, so the natural reading — "no code ⇒ a
 * server message worth rendering" — puts the SDK-internal string
 * `IframeTransport: request "CREATE_POST_FROM_APP" timed out after 600000ms` in
 * front of a viewer. `code === undefined && !timedOut` is the ONLY branch whose
 * `.message` is meant to be rendered, and it is the last one here.
 *
 * 🔴 MEMBERSHIP VIA `isCreatePostErrorCode()`, NEVER EQUALITY AGAINST A LITERAL
 * UNION. The error channel is not an enum: the host forwards any server message
 * verbatim (a rate limit, a blocked title, a refused gallery attach), so "is
 * this a code?" is a runtime question. The SDK derives that Set from the same
 * array it derives the type from, which is why this asks it rather than
 * re-listing the codes.
 *
 * @param raw the error's `.message` — the host's code, or the server's prose.
 * @param opts `timedOut` is the `CreatePostError` flag, which is structural
 *   (`err instanceof RequestTimeoutError`), not a message match.
 */
export function describeCreatePostError(raw: string, opts: { timedOut: boolean }): PostFailure {
  if (opts.timedOut) return { kind: 'notice', source: 'timeout', message: POST_TIMEOUT_NOTICE };
  if (isCreatePostErrorCode(raw)) {
    // The viewer dismissed the host confirm. GUARANTEED to mean no post was
    // created (the host takes its consent latch synchronously before the write),
    // so there is nothing to report and nothing to undo.
    if (raw === 'declined') return { kind: 'declined' };
    // Not an error to render: the viewer's next step is signing in, not retrying.
    if (raw === 'sign in to post') return { kind: 'sign-in' };
    return { kind: 'notice', source: 'code', message: CODE_NOTICE[raw] };
  }
  const message = raw.trim();
  return {
    kind: 'notice',
    source: 'server',
    message: message.length > 0 ? message : POST_UNKNOWN_NOTICE,
  };
}
