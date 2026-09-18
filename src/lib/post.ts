// POSTING KEPT IMAGES TO THE VIEWER'S PROFILE — the pure half.
//
// `useCreatePostFromApp()` asks the host to publish a REAL, feed-visible,
// reward-earning Post under the VIEWER'S byline from images this app already
// published for them. That is strictly more consequential than Keep, so the
// decisions that are cheap to get subtly wrong — what may be selected, what the
// bounds are, and what a viewer is told when the host refuses — live here as
// total functions rather than inside a component.
//
// 🔴 THE SERVER IS THE AUTHORITY AND THIS FILE DELIBERATELY COPIES ALMOST NONE
// OF IT. The SDK's `BlockCreatePostRequest` calls every text field ADVISORY and
// publishes no numeric bound for any of them — it publishes bounds precisely
// where it wants a block to enforce one — so a mirrored `title`/`detail`/tag
// ceiling here would be a second authority that can only drift, and it would
// drift in the UNRECOVERABLE direction: a hard keyboard stop with no sentence
// attached. The server names each of those refusals in plain English
// (`title exceeds 255 characters`, `detail may not contain links`, …) and this
// app renders a free-text refusal verbatim, so the server's own words are the
// mechanism. The one bound that survives is {@link POST_MAX_IMAGES}, which is a
// live selection affordance rather than a copied validation.

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

/**
 * `true` when the gate returned an image NOTHING HAS RATED YET.
 *
 * 🔴 THE FLAG ONLY, BECAUSE THE HOST STATES THE BICONDITIONAL. Since
 * civitai/civitai#4895 the author's own unrated image comes back `visible` with
 * `ratingPending: true` and NO `nsfwLevel` / `contentRating`, and
 * `block-gated-images.service.ts` says so in as many words — *"Absent ⇔
 * `ratingPending`"* — setting the two mutually exclusively.
 *
 * 🔴 AND AN ABSENT-RATING DISJUNCT WOULD FAIL THE UNRECOVERABLE WAY. This
 * predicate makes a cell PERMANENTLY unselectable behind copy that promises the
 * wait ends ("Still being rated — you can post this once that finishes"), with
 * no escape hatch. Reading a missing `nsfwLevel` as pending would apply that
 * dead end to any image whose rating the host ever omits for some other reason —
 * and it would buy nothing, because this app reads `nsfwLevel` nowhere, so
 * there is no default rating anywhere for it to be substituted into.
 */
export function isRatingPending(image: BlockGatedImage): boolean {
  return image.status === 'visible' && image.ratingPending === true;
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
 * SENT — trimmed, de-duplicated case-insensitively (first spelling wins).
 *
 * ⚠️ WHAT COMES BACK IS NOT WHAT IS APPLIED. The server resolves these against
 * EXISTING tags only: a name matching no tag is DROPPED, never minted. So this
 * is the request, and the host's consent screen — which renders the server's
 * resolution, not these strings — is the answer. The UI must not promise the
 * viewer their tags will be applied.
 *
 * 🔴 NO COUNT CEILING HERE, AND THE REASON IS NARROWER THAN THIS BLOCK USED TO
 * CLAIM. civitai's `normalizeBlockPostTagNames` applies `BLOCK_POST_MAX_TAGS`
 * with a `break` **before** the tag lookup, so names past the cap appear in
 * NEITHER the resolved `tags` nor the `droppedTags` the consent screen renders:
 * they are not "shown as dropped", they are absent. So the old reasoning — the
 * consent screen shows what was resolved, therefore nothing is hidden — was
 * false for exactly the names the cap eats.
 *
 * A mirrored cap here is still the wrong fix, for the reason at the top of this
 * file: it would be a copied server constant whose drift is SILENT and points
 * the unrecoverable way (raise the server's cap and this app would keep dropping
 * names the server would have taken, with no sentence attached and nothing on
 * the confirm to reveal it). What the cap actually costs is a PROMISE the
 * composer was making, so the composer stops making it — the tag field's own
 * copy names the ceiling without naming a number, and the preview is labelled as
 * what this app SENDS rather than what will apply. See `POST_TAGS_NOTICE` and
 * `POST_TAGS_PREVIEW_LABEL` in `components/KeptGallery.tsx`.
 *
 * ⚠️ What makes that adequate here and NOT adequate for the model-version attach
 * (which DOES block submit) is reversibility: the consent screen renders the
 * server's resolution — the tags that will actually land — and the viewer can
 * still decline, so the post can still be stopped after seeing it.
 *
 * ⚠️ VISIBLE IS NOT ANNOUNCED, AND THE CUT IS POSITIONAL — THIS PARAGRAPH USED TO
 * SAY THE WALK STOPS "once `BLOCK_POST_MAX_TAGS` KNOWN names have been taken",
 * which is a different and milder mechanism, and which contradicted the paragraph
 * fifty lines above it. Nothing on that screen SAYS a name was omitted, and what
 * gets omitted is decided before any tag is looked up. Read off civitai:
 * `normalizeBlockPostTagNames` (`block-post.logic.ts`) trims, lowercases,
 * de-duplicates and `break`s at `BLOCK_POST_MAX_TAGS` **with no `Tag` lookup in
 * it at all**, and `resolveExistingPostTags` (`block-post.service.ts`) is only
 * ever called with the RAW request — so by the time a row is fetched the list is
 * already at most `BLOCK_POST_MAX_TAGS` names, which makes that function's own
 * `if (tagIds.length >= BLOCK_POST_MAX_TAGS) break` unreachable. The cap
 * therefore falls on the viewer's first N DISTINCT names, known or not.
 *
 * 🔴 THE WORST CASE IS WORSE THAN "A SHORTER ROW THAN THEY TYPED" — IT IS AN
 * EMPTY ONE. Type eight tags whose first five match no `Tag` row and whose last
 * three are real: normalisation keeps the five unknown names and drops the three
 * real ones on POSITION, the lookup resolves none of what survives, and `tagIds`
 * comes back empty. The three tags that would have applied were never sent, never
 * resolved, and appear in neither the resolved badges nor `droppedTags` — so
 * `droppedTagsLine` (the one sentence about tags that did not make it, built from
 * `droppedTags` alone) names the five that failed and says nothing about the
 * three that would have worked, over a consent body rendering ZERO tag badges.
 * What the viewer gets is an ABSENCE TO NOTICE, before publishing, not a
 * disclosure.
 *
 * That is still the reversible side of the line — the screen is shown and the
 * decline is available while nothing has been published — and it is what keeps
 * (b) the right call. The attach is the other side: it is omitted with no screen
 * of its own at all, and is discovered after the images have left this app's
 * grid for good, which is why that one blocks submit.
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
  }
  return out;
}

/**
 * The ONE spelling of a version id that a viewer can actually obtain: the
 * `modelVersionId` query parameter civitai puts on a model page's URL.
 *
 * Anchored to a `?`/`&` so it cannot match a word inside prose, and terminated
 * so a longer parameter value is read whole rather than truncated to its prefix.
 */
const MODEL_VERSION_QUERY_RE = /[?&]modelVersionId=(\d+)(?:[&#]|$)/;

/** A version id is a positive safe integer or it is not a version id. */
function asVersionId(n: number): number | undefined {
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Normalise the optional model-version gallery attach into the value that will
 * be SENT, or `undefined` to omit the key entirely.
 *
 * 🔴 A PASTED URL IS THE PRIMARY INPUT, NOT A FALLBACK. There is nowhere inside
 * a sandboxed block iframe to obtain a raw `modelVersionId`: the only place a
 * viewer ever sees one is the `?modelVersionId=` parameter on a civitai model
 * page, i.e. in their address bar. A control that accepts only a bare number is
 * therefore a control asking for a value nobody has, which is why the composer's
 * field is a text field and this takes a string.
 *
 * 🔴 CONSERVATIVE BY CONSTRUCTION — IT PARSES OR IT REFUSES, IT NEVER GUESSES.
 * A model URL carries a modelId in its path as well, and attaching to the wrong
 * id is a refusal the viewer cannot diagnose, so only the explicitly-named
 * `modelVersionId` parameter is read. Everything else — an empty field, a
 * half-typed paste, a model link with no version parameter, a float, a zero —
 * returns `undefined`, so the request omits the key rather than carrying
 * something the host has to reject.
 */
export function parseModelVersionId(raw: string | number | null | undefined): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'number') return asVersionId(raw);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return asVersionId(Number(trimmed));
  const match = MODEL_VERSION_QUERY_RE.exec(trimmed);
  if (match == null) return undefined;
  return asVersionId(Number(match[1]));
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

/**
 * Shown when the failure carries no message at all.
 *
 * 🔴 IT USED TO END *"Nothing was posted."* — the exact claim
 * {@link POST_TIMEOUT_NOTICE} is written NOT to make, in a branch that knows
 * even less. This arm is reached when the host replied with an `error` that is
 * an empty string: the app knows a refusal came back and knows nothing about
 * what the server did before sending it, so it may describe the refusal and must
 * not describe the outcome. Practically unreachable — the SDK substitutes
 * `no images to post` for an empty `error` — which is precisely why the sentence
 * had to be read rather than trusted.
 */
export const POST_UNKNOWN_NOTICE =
  'Civitai turned the post down and didn’t say why. Check your Civitai profile before posting these again.';

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
