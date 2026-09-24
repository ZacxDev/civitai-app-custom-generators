// THE PAYOFF VIEW — one generated image, big, with the recipe that made it.
//
// 🔴 WHY THIS EXISTS. A run's outputs rendered as 120px cells in an
// `auto-fill,minmax(120px,1fr)` grid with no way to enlarge one. The viewer had
// just spent real Buzz, and the artifact they bought was a thumbnail they could
// not look at: an unverified block's iframe is `allow-scripts allow-forms` only,
// so there is NO `allow-downloads` (a file save is blocked) and NO `allow-popups`
// (`window.open` / `target="_blank"` silently fail) — the image could not be
// opened in a tab either. "Copy the url and paste it somewhere else" was the
// entire viewing story for the thing the app exists to produce.
//
// So the app has to be the viewer. This is that: full-width image, the generator
// and button that produced it, the recipe, the prompt the viewer typed, and the
// copy-link escape hatch relocated here from the result grid (where it rendered
// one button PER IMAGE — "⧉ Copy link 1  ⧉ Copy link 2  ⧉ Copy link 3" — a row
// that grew with quantity and buried Re-run).
//
// 🔴 HIDDEN IS A FIRST-CLASS STATE, NOT AN ERROR. A gated read can return
// `status:'hidden'` with NO url (above the viewer's browsing ceiling, unscanned,
// or flagged). `src === null` renders a placeholder and the actions that need a
// url are withheld — never a broken `<img>`, and never a control that would
// operate on a url this component does not have.
//
// a11y: `Modal` owns Escape, the overlay click, focus trapping and returning
// focus to the trigger, so none of that is re-implemented here. What IS added is
// arrow-key paging across a multi-image run, because a lightbox that can only be
// paged with the mouse is a lightbox half the audience cannot page — but ONLY for
// a caller that supplies paging handlers. The kept-image caller cannot: it holds
// one cell and one url, and the sibling images' urls live in the gallery's gated
// state. So that view states its position and renders no controls, rather than
// two dead buttons (see `pageable`).

import { useCallback, useEffect } from 'react';

import { Badge, Button, Group, Modal, Stack } from '../ui/index.js';
import { Image } from '@civitai/components-react';

import { radius, metaText, token, elevate, type Palette } from '../theme.js';

export interface ResultLightboxProps {
  opened: boolean;
  onClose: () => void;
  c: Palette;
  /**
   * Host-served image url, or `null` when the image is withheld from this viewer
   * (gated `hidden`) or could not be resolved. 🔴 `null` is a render state, not a
   * failure to handle upstream.
   */
  src: string | null;
  /** Attribution — the generator's name. App-owned text, never a person's handle. */
  generatorName: string;
  buttonLabel: string;
  /** Compact "checkpoint · N LoRAs · 768×1024" line, when known. */
  recipe?: string | null;
  /** What the viewer typed for this run, when the button exposed a prompt box. */
  prompt?: string;
  /** Position within the run's images, 1-based, for the "2 of 4" affordance. */
  index: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
  /** Copy this image's url. Omitted (or `src === null`) ⇒ the control hides. */
  onCopyLink?: () => void;
  /** Render the copy control in its transient confirmed state. */
  copied?: boolean;
  /** Shown when this image is already kept, so the view states its own durability. */
  kept?: boolean;
  /**
   * Re-open the generator that made this image — the one control that turns
   * "look what I made" into "make another one like it", and the only place the
   * gallery feeds back into the board. Omitted when the image's generator cannot
   * be resolved (an unpublished draft, or a row past the loaded page).
   */
  onOpenGenerator?: () => void;
}

export function ResultLightbox({
  opened,
  onClose,
  c,
  src,
  generatorName,
  buttonLabel,
  recipe,
  prompt,
  index,
  total,
  onPrev,
  onNext,
  onCopyLink,
  copied = false,
  kept = false,
  onOpenGenerator,
}: ResultLightboxProps) {
  /** This image is one of several — worth SAYING, whether or not it can be paged. */
  const multi = total > 1;
  /**
   * 🔴 PAGING IS A CAPABILITY OF THE CALLER, NOT A PROPERTY OF THE RUN. `total > 1`
   * alone rendered a Prev/Next row for the KEPT lightbox, whose caller supplies
   * neither handler — two permanently-disabled buttons and a keydown listener
   * that could never fire, under a position line promising four images. A caller
   * that CAN page always supplies at least one handler (the other is absent only
   * at an end of the run, where a disabled control is the correct answer), so the
   * presence of either is the honest test.
   */
  const pageable = multi && (onPrev != null || onNext != null);

  // Arrow-key paging. Registered on the document because `Modal` owns the focus
  // trap and the focused element inside it is whatever the user last touched —
  // binding to a panel ref would miss keys pressed while a Button holds focus.
  // Only while `opened` AND pageable, so neither a closed nor an unpageable
  // lightbox listens for keys it cannot act on.
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!pageable) return;
      if (e.key === 'ArrowLeft' && onPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === 'ArrowRight' && onNext) {
        e.preventDefault();
        onNext();
      }
    },
    [pageable, onPrev, onNext],
  );

  useEffect(() => {
    if (!opened || !pageable) return;
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [opened, pageable, onKeyDown]);

  return (
    <Modal opened={opened} onClose={onClose} title={buttonLabel} size="lg">
      <Stack gap={12} data-testid="result-lightbox">
        {src ? (
          <Image
            src={src}
            alt={`${buttonLabel} — result ${index} of ${total}`}
            data-testid="lightbox-image"
            fallback="Image unavailable"
            wrapperStyle={{
              width: '100%',
              maxHeight: '60dvh',
              borderRadius: radius.md,
              background: elevate(3),
            }}
            style={{ objectFit: 'contain' }}
          />
        ) : (
          // Gated `hidden`, or an id the host would not resolve. Say which kind of
          // absence this is — "unavailable" alone reads as a bug in the app.
          <div
            data-testid="lightbox-hidden"
            style={{
              width: '100%',
              minHeight: 220,
              display: 'grid',
              placeItems: 'center',
              padding: 20,
              textAlign: 'center',
              borderRadius: radius.md,
              border: `1px dashed ${c.border}`,
              background: elevate(2),
            }}
          >
            <span style={{ ...metaText, maxWidth: 380 }}>
              This image isn’t shown here — it may be above your browsing level, or still being
              checked by Civitai.
            </span>
          </div>
        )}

        {/* Position is a fact about the run and is stated whenever there is more
            than one image; the CONTROLS appear only where they can do something.
            An `<span/>` holds the slot so the position line stays centred. */}
        {multi && (
          <Group justify="space-between" align="center">
            {pageable ? (
              <Button
                size="sm"
                variant="subtle"
                data-testid="lightbox-prev"
                disabled={!onPrev}
                onClick={onPrev}
              >
                ← Previous
              </Button>
            ) : (
              <span />
            )}
            <span style={metaText} data-testid="lightbox-position">
              {index} of {total}
            </span>
            {pageable ? (
              <Button
                size="sm"
                variant="subtle"
                data-testid="lightbox-next"
                disabled={!onNext}
                onClick={onNext}
              >
                Next →
              </Button>
            ) : (
              <span />
            )}
          </Group>
        )}

        <Stack gap={6}>
          <Group gap={8} align="center">
            {/* 🔴 Identity, phase 4. The generator gets the credit line, because
                the generator is what the app can name truthfully: `SharedListItem`
                carries `authorUserId` as a bare number and the platform exposes no
                user lookup, so a person's handle is not derivable here (see
                taste.json decision "identity"). */}
            <span style={{ fontSize: 14 }} data-testid="lightbox-attribution">
              Made with <strong>{generatorName}</strong>
            </span>
            {kept && (
              <Badge color="success" variant="light" data-testid="lightbox-kept-badge">
                Kept
              </Badge>
            )}
          </Group>
          {recipe && (
            <span style={{ ...metaText }} data-testid="lightbox-recipe">
              {recipe}
            </span>
          )}
          {prompt && (
            <div
              data-testid="lightbox-prompt"
              style={{
                fontSize: 13,
                lineHeight: 1.5,
                color: token.text,
                background: elevate(2),
                border: `1px solid ${c.border}`,
                borderRadius: radius.md,
                padding: '8px 10px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {prompt}
            </div>
          )}
        </Stack>

        {/* Actions. The copy-link escape hatch is relocated here from the result
            grid; it is withheld when there is no url to copy, because a control
            that cannot work is worse than an absent one. */}
        {(onOpenGenerator || (onCopyLink && src)) && (
          <Group justify="space-between" gap={8}>
            {onOpenGenerator ? (
              <Button
                size="sm"
                variant="light"
                data-testid="lightbox-open-generator"
                onClick={onOpenGenerator}
              >
                Make another with {generatorName}
              </Button>
            ) : (
              <span />
            )}
            {onCopyLink && src && (
              <Button size="sm" variant="subtle" data-testid="lightbox-copy-link" onClick={onCopyLink}>
                {copied ? '✓ Link copied' : '⧉ Copy image link'}
              </Button>
            )}
          </Group>
        )}
      </Stack>
    </Modal>
  );
}
