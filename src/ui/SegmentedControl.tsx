// SegmentedControl — the `@civitai/components` markup contract, toggle mode.
//
// The 0.9 line retired the React binding and points hand-written markup at
// this contract, with the keyboard behaviour explicitly the author's job:
// a `radiogroup` of `radio` segment buttons, roving tabindex, arrow/Home/End
// navigation with selection following focus.

import { useRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

export interface SegmentedControlOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  value: string;
  onChange: (value: string) => void;
  data: SegmentedControlOption[];
  size?: 'sm' | 'md' | 'lg';
}

export function SegmentedControl({ value, onChange, data, size, ...rest }: SegmentedControlProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function moveFocus(nextIndex: number) {
    const buttons = data
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => !o.disabled);
    if (buttons.length === 0) return;
    const wrapped = ((nextIndex % buttons.length) + buttons.length) % buttons.length;
    const target = buttons[wrapped];
    onChange(target.o.value);
    refs.current[target.i]?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const enabled = data.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled);
    const pos = enabled.findIndex(({ i }) => i === index);
    if (pos === -1) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(pos + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(pos - 1);
        break;
      case 'Home':
        e.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        e.preventDefault();
        moveFocus(enabled.length - 1);
        break;
    }
  }

  return (
    <div
      data-civitai-ui="segmented-control"
      role="radiogroup"
      {...(size ? { 'data-size': size } : {})}
      {...rest}
    >
      {data.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            data-civitai-ui-segment
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
