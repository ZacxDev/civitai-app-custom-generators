// Modal — carried from `@civitai/blocks-react/ui` when this app moved to
// `@civitai/sdk`, which ships no UI at all.
//
// 🔴 WRITTEN OUT IN REACT RATHER THAN BOUND TO THE LIT ELEMENT. The design
// system does ship a modal, but only as a custom element
// (`@civitai/components-react/elements` → `CivitaiModal`). Under jsdom a custom
// element is never upgraded, so a Lit-backed modal does two things this app's
// suites assert against: it leaves its children in the document WHILE CLOSED,
// and it exposes no `role="dialog"`. Neither is a test artefact — "content is
// present while closed" is a real defect for a modal holding a composer, and
// this app has three (Browse's confirm, KeptGallery's post composer, the result
// lightbox). The React version below returns `null` when closed, so the DOM is
// genuinely empty.
//
// Behaviour is unchanged from the pack: `role="dialog"` + `aria-modal`,
// `aria-labelledby` when titled, focus moved to the panel on open and restored
// on close, Escape and overlay-click both close, a click inside does not.
//
// v0 limitation, carried over deliberately: this does NOT trap focus inside the
// panel — Tab can still reach content behind the overlay. Unchanged from the
// pack so the port is not also a behaviour change; a real focus trap is a
// follow-up, not part of a transport migration.

import { useEffect, useId, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { useBlocksStyles } from './styles.js';

export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalProps {
  /** Whether the modal is shown. When `false`, nothing is rendered. */
  opened: boolean;
  /**
   * Called when the user requests close — Escape, overlay click, or the header
   * close button. The parent owns `opened`, so it must flip it.
   */
  onClose: () => void;
  /** Optional header title (also wires `aria-labelledby`). */
  title?: ReactNode;
  /** Panel width preset. Defaults to `'md'`. */
  size?: ModalSize;
  /** Show the header close (×) button. Defaults to `true`. */
  withCloseButton?: boolean;
  /** Close when the dimmed overlay (outside the panel) is clicked. Default `true`. */
  closeOnOverlayClick?: boolean;
  /** Close when Escape is pressed. Default `true`. */
  closeOnEscape?: boolean;
  /** Accessible label for the close button. Defaults to "Close". */
  closeButtonLabel?: string;
  /** Class applied to the panel element. */
  className?: string;
  /** Style applied to the panel element. */
  style?: CSSProperties;
  /** Modal body content. */
  children?: ReactNode;
}

export function Modal(props: ModalProps): React.JSX.Element | null {
  const {
    opened,
    onClose,
    title,
    size = 'md',
    withCloseButton = true,
    closeOnOverlayClick = true,
    closeOnEscape = true,
    closeButtonLabel = 'Close',
    className,
    style,
    children,
  } = props;

  useBlocksStyles();

  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const reactId = useId();
  const titleId = `ci-modal-title-${reactId}`;

  // Focus the panel on open; restore focus to the prior element on close.
  useEffect(() => {
    if (!opened) return;
    previouslyFocused.current = typeof document !== 'undefined' ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      const prev = previouslyFocused.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [opened]);

  // Escape-to-close. Listener only attached while open.
  useEffect(() => {
    if (!opened || !closeOnEscape) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't stopPropagation — that swallows Escape unpredictably when two
      // modals (or the app's own document Escape handler) are present.
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [opened, closeOnEscape, onClose]);

  if (!opened) return null;

  return (
    <div
      data-civitai-ui="modal-overlay"
      onMouseDown={(e) => {
        // Only close on a press that starts AND lands on the overlay itself — a
        // drag that began inside the panel and released on the overlay must not
        // close it.
        if (closeOnOverlayClick && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={className}
        data-civitai-ui="modal"
        data-size={size}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        tabIndex={-1}
        style={style}
      >
        {title != null || withCloseButton ? (
          <div data-civitai-ui-modal-header>
            {title != null ? (
              <h2 id={titleId} data-civitai-ui-modal-title>
                {title}
              </h2>
            ) : (
              <span />
            )}
            {withCloseButton ? (
              <button
                type="button"
                data-civitai-ui-modal-close
                aria-label={closeButtonLabel}
                onClick={() => onClose()}
              >
                ×
              </button>
            ) : null}
          </div>
        ) : null}
        <div data-civitai-ui-modal-body>{children}</div>
      </div>
    </div>
  );
}
