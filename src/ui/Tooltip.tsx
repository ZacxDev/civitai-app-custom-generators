// Tooltip — the `@civitai/components` markup contract, rendered in React.
//
// A `data-civitai-ui="tooltip"` wrapper whose bubble is revealed on hover /
// focus-within by the contract's stylesheet; the trigger is wired to the
// bubble with `aria-describedby`.

import { cloneElement, useId } from 'react';
import type { ReactElement, ReactNode } from 'react';

export interface TooltipProps {
  label: ReactNode;
  children: ReactElement<{ 'aria-describedby'?: string }>;
}

export function Tooltip({ label, children }: TooltipProps) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const bubbleId = `tip-${id}`;
  return (
    <span data-civitai-ui="tooltip">
      {cloneElement(children, { 'aria-describedby': bubbleId })}
      <span data-civitai-ui-tooltip-bubble role="tooltip" id={bubbleId}>
        {label}
      </span>
    </span>
  );
}
