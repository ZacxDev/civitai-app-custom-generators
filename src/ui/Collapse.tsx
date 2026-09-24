// Collapse — carried from `@civitai/blocks-react/ui`. The design system ships
// one only as a Lit custom element (`CivitaiCollapse`), which jsdom never
// upgrades, so the collapsed content would stay in the a11y tree and the tab
// order under test. This app uses it for the "Advanced" params reveal in both
// ButtonEditor and Runner, and both suites assert the collapsed content is
// absent, so the React version is the faithful one.
//
// Unchanged from the pack: the `<button>` trigger (ref-forwarded) carries
// `aria-expanded` + `aria-controls` pointing at the content region
// (`role="region"` + `aria-labelledby` back to the trigger). Collapsed content
// is `hidden`, so it leaves both the a11y tree and the tab order. Controlled
// (`open` + `onOpenChange`).

import { forwardRef, useId } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

import { useBlocksStyles } from './styles.js';

export interface CollapseProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'title'> {
  /** Whether the content is expanded (controlled). */
  open: boolean;
  /** Fires with the requested next open state when the trigger is activated. */
  onOpenChange: (open: boolean) => void;
  /** Trigger label (the "Advanced" toggle text). */
  title: ReactNode;
  /** Disable the trigger. */
  disabled?: boolean;
  /** Class on the wrapping element. */
  className?: string;
  /** Content revealed when `open`. */
  children?: ReactNode;
}

export const Collapse = forwardRef<HTMLButtonElement, CollapseProps>(function Collapse(
  { open, onOpenChange, title, disabled = false, className, children, id, ...rest },
  ref,
) {
  useBlocksStyles();
  const reactId = useId();
  const rootId = id ?? `ci-collapse-${reactId}`;
  const triggerId = `${rootId}-trigger`;
  const regionId = `${rootId}-region`;

  return (
    <div
      {...rest}
      className={className}
      data-civitai-ui="collapse"
      data-open={open ? 'true' : undefined}
    >
      <button
        ref={ref}
        id={triggerId}
        type="button"
        data-civitai-ui-collapse-trigger
        aria-expanded={open}
        aria-controls={regionId}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <span data-civitai-ui-collapse-chevron aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span>{title}</span>
      </button>
      <div
        id={regionId}
        role="region"
        aria-labelledby={triggerId}
        data-civitai-ui-collapse-region
        hidden={!open}
      >
        {children}
      </div>
    </div>
  );
});
