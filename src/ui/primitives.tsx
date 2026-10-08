// Prop adapters rendering the `@civitai/components` MARKUP contract.
//
// 🔴 THE 0.9 LINE RETIRED THE REACT LAYER THESE WRAPPERS USED TO FORWARD TO.
// `@civitai/components-react@0.9` binds the `<civitai-*>` custom elements
// (shadow DOM), and `@civitai/components` documents the markup contract —
// `data-civitai-ui` attributes styled by its `components.css`, injected via
// `injectStyles()` — as the framework-agnostic consumption path: "Consuming
// this document means writing the markup yourself, in whatever framework."
// That is what this file does now. The exported prop vocabulary is UNCHANGED
// from the old adapters, so the ~200 JSX call sites did not move; only the
// rendering underneath them did.
//
// The measured deltas this file absorbs:
//   Stack/Group  numeric gap → inline `gap` (presets remain `data-gap`)
//   Card    radius dropped by the contract; re-applied inline
//   Alert   `title` → the alert-title row; close affordance rendered here
//   Button  `color` (non-primary) → inline token tint (the contract colours
//           Badge/Alert via `data-color`; Button reads variant/size only)
//   NumberInput  value:number|null + onChange(number|null) → native input
//           events, with "" / non-numeric reported as `null`, never NaN
//   Select  declarative `options` → native `<option>` children
//   Slider  `showValue` → the value read-out `<output>` + `aria-valuetext`
//
// Field chrome follows MARKUP.md: a wrapper carrying `data-civitai-ui`, an
// optional `<label data-civitai-ui-label for>`, description/error spans the
// control is `aria-describedby`-wired to, and the control itself carrying
// `data-civitai-ui-control` (except the slider's native range input).

import { forwardRef, useId } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { useBlocksStyles } from './styles.js';

export type ButtonVariant = 'filled' | 'light' | 'outline' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type BadgeVariant = 'filled' | 'light' | 'outline';
export type BadgeSize = 'sm' | 'md' | 'lg';
export type CardPadding = 'sm' | 'md' | 'lg';
export type LoaderSize = 'sm' | 'md' | 'lg';
export type AlertColor = 'info' | 'success' | 'warning' | 'error';

/** The colour vocabulary the app passes; wider than the contract's intent set. */
type AppColor = 'primary' | 'error' | 'success' | 'warning' | 'info' | (string & {});

const INTENTS: ReadonlySet<string> = new Set(['info', 'success', 'warning', 'error']);

/**
 * A numeric gap becomes an inline `gap`; a preset is forwarded as `data-gap`
 * so the contract's own CSS applies. `undefined` leaves the default alone.
 */
function gapAttrs(gap: string | number | undefined): { dataGap?: string; styleGap?: string } {
  if (gap === undefined) return {};
  if (typeof gap === 'number') return { styleGap: `${gap}px` };
  if (gap === 'sm' || gap === 'md' || gap === 'lg') return { dataGap: gap };
  return { styleGap: gap };
}

// ---------------------------------------------------------------- layout

export interface StackProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style'> {
  gap?: string | number;
  align?: CSSProperties['alignItems'];
  justify?: CSSProperties['justifyContent'];
  style?: CSSProperties;
}

export const Stack = forwardRef<HTMLDivElement, StackProps>(function Stack(
  { gap, align, justify, style, ...rest },
  ref,
) {
  const g = gapAttrs(gap);
  return (
    <div
      ref={ref}
      data-civitai-ui="stack"
      {...(g.dataGap ? { 'data-gap': g.dataGap } : {})}
      {...rest}
      style={{
        ...(g.styleGap ? { gap: g.styleGap } : {}),
        ...(align ? { alignItems: align } : {}),
        ...(justify ? { justifyContent: justify } : {}),
        ...style,
      }}
    />
  );
});

export interface GroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style'> {
  gap?: string | number;
  align?: CSSProperties['alignItems'];
  justify?: CSSProperties['justifyContent'];
  /** `false` pins the row to one line. The contract wraps by default. */
  wrap?: boolean;
  style?: CSSProperties;
}

export const Group = forwardRef<HTMLDivElement, GroupProps>(function Group(
  { gap, align, justify, wrap, style, ...rest },
  ref,
) {
  const g = gapAttrs(gap);
  return (
    <div
      ref={ref}
      data-civitai-ui="group"
      {...(g.dataGap ? { 'data-gap': g.dataGap } : {})}
      {...(wrap === false ? { 'data-nowrap': 'true' } : {})}
      {...rest}
      style={{
        ...(g.styleGap ? { gap: g.styleGap } : {}),
        ...(align ? { alignItems: align } : {}),
        ...(justify ? { justifyContent: justify } : {}),
        ...(wrap === false ? { flexWrap: 'nowrap' } : wrap === true ? { flexWrap: 'wrap' } : {}),
        ...style,
      }}
    />
  );
});

export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style'> {
  withBorder?: boolean;
  padding?: CardPadding;
  /** Not in the contract; re-applied inline so rounded cards stay rounded. */
  radius?: string | number;
  style?: CSSProperties;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { withBorder, padding, radius, style, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      data-civitai-ui="card"
      {...(withBorder ? { 'data-with-border': 'true' } : {})}
      {...(padding ? { 'data-padding': padding } : {})}
      {...rest}
      style={{
        ...(radius !== undefined
          ? { borderRadius: typeof radius === 'number' ? `${radius}px` : radius }
          : {}),
        ...style,
      }}
    />
  );
});

// ---------------------------------------------------------------- controls

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color' | 'style'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Not a contract colour for Button — applied as inline tokens.
   *
   * 🔴 THE THEME DEFINES EXACTLY ONE ERROR TOKEN, `--civitai-color-error`. There
   * is no paired foreground token, so a destructive button is rendered as an
   * outline rather than a filled one — a filled variant would need a contrasting
   * text colour the theme does not define, and hardcoding `#fff` is what this
   * app's own `theme.test.tsx` "no hex in inline styles" guard exists to catch.
   */
  color?: AppColor;
  loading?: boolean;
  fullWidth?: boolean;
  leftSection?: ReactNode;
  rightSection?: ReactNode;
  style?: CSSProperties;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { color, loading, fullWidth, variant, size, leftSection, rightSection, disabled, style, children, ...rest },
  ref,
) {
  const tinted: CSSProperties | undefined =
    color && color !== 'primary'
      ? {
          background: 'transparent',
          color: `var(--civitai-color-${color})`,
          borderColor: `var(--civitai-color-${color})`,
        }
      : undefined;
  return (
    <button
      ref={ref}
      type="button"
      data-civitai-ui="button"
      {...(variant ? { 'data-variant': variant } : {})}
      {...(size ? { 'data-size': size } : {})}
      {...(fullWidth ? { 'data-full-width': 'true' } : {})}
      {...(loading ? { 'aria-busy': true } : {})}
      disabled={disabled || loading}
      {...rest}
      style={{ ...tinted, ...style }}
    >
      {loading ? <span data-civitai-ui="loader" data-size="sm" aria-hidden="true" /> : null}
      {leftSection ? <span data-civitai-ui-section="left">{leftSection}</span> : null}
      {children}
      {rightSection ? <span data-civitai-ui-section="right">{rightSection}</span> : null}
    </button>
  );
});

export interface BadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'color'> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  color?: AppColor;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { color, variant, size, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      data-civitai-ui="badge"
      {...(variant ? { 'data-variant': variant } : {})}
      {...(size ? { 'data-size': size } : {})}
      {...(color && INTENTS.has(color) ? { 'data-color': color } : {})}
      {...rest}
    />
  );
});

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'role'> {
  color?: AlertColor;
  title?: ReactNode;
  /** The close affordance renders when this and `onClose` are both given. */
  withCloseButton?: boolean;
  onClose?: () => void;
  closeButtonLabel?: string;
  role?: React.AriaRole;
}

export function Alert({
  color,
  title,
  withCloseButton,
  onClose,
  closeButtonLabel,
  role,
  children,
  ...rest
}: AlertProps): React.JSX.Element {
  const closable = withCloseButton !== false && onClose !== undefined;
  return (
    <div data-civitai-ui="alert" data-color={color ?? 'info'} role={role ?? 'alert'} {...rest}>
      <div data-civitai-ui-alert-body>
        {title ? <div data-civitai-ui-alert-title>{title}</div> : null}
        {children}
      </div>
      {closable ? (
        <button type="button" data-civitai-ui-alert-close aria-label={closeButtonLabel ?? 'Dismiss'} onClick={onClose}>
          ×
        </button>
      ) : null}
    </div>
  );
}

export interface LoaderProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: LoaderSize;
  /** Not a contract colour; applied as `currentColor` so the spinner inherits it. */
  color?: string;
}

export function Loader({ color, size, style, ...rest }: LoaderProps): React.JSX.Element {
  return (
    <span
      data-civitai-ui="loader"
      {...(size ? { 'data-size': size } : {})}
      aria-hidden="true"
      {...rest}
      style={{ ...(color ? { color } : {}), ...style }}
    />
  );
}

// ---------------------------------------------------------------- fields

interface FieldChromeProps {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
}

function useFieldIds(idProp: string | undefined, hasDesc: boolean, hasErr: boolean) {
  const auto = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const id = idProp ?? `f-${auto}`;
  return {
    id,
    descId: hasDesc ? `${id}-desc` : undefined,
    errId: hasErr ? `${id}-err` : undefined,
  };
}

function fieldChrome(
  ui: string,
  chrome: FieldChromeProps,
  ids: ReturnType<typeof useFieldIds>,
  control: ReactNode,
): React.JSX.Element {
  const { label, description, error, required, className } = chrome;
  return (
    <div
      data-civitai-ui={ui}
      className={className}
      {...(error ? { 'data-invalid': 'true' } : {})}
    >
      {label ? (
        <label data-civitai-ui-label htmlFor={ids.id}>
          {label}
          {required ? (
            <span data-civitai-ui-required aria-hidden="true">
              {' *'}
            </span>
          ) : null}
        </label>
      ) : null}
      {description ? (
        <span id={ids.descId} data-civitai-ui-description>
          {description}
        </span>
      ) : null}
      {control}
      {error ? (
        <span id={ids.errId} data-civitai-ui-error role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function describedBy(ids: ReturnType<typeof useFieldIds>): string | undefined {
  const parts = [ids.descId, ids.errId].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * NumberInput — the one adapter with real behaviour, not just prop renaming.
 *
 * 🔴 THE SIGNATURES ARE INCOMPATIBLE WITH THE NATIVE CONTROL. The contract's
 * NumberInput is a native `<input type="number">`: its value is a string and
 * changes arrive as DOM events. The app's call sites pass
 * `value={number | null}` and `onChange={(n: number | null) => …}` — a cleared
 * field must arrive as `null`, not as `NaN` and not as `0`, because both Runner
 * and ButtonEditor treat `null` as "use the server default" and `0` is a
 * meaningful seed.
 */
export interface NumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'type' | 'value' | 'onChange'> {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  inputClassName?: string;
  value: number | null;
  onChange: (value: number | null) => void;
}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onChange, label, description, error, required, className, inputClassName, id, ...rest },
  ref,
) {
  const ids = useFieldIds(id, description !== undefined, error !== undefined);
  return fieldChrome(
    'number-input',
    { label, description, error, required, className },
    ids,
    <input
      ref={ref}
      data-civitai-ui-control
      className={inputClassName}
      id={ids.id}
      type="number"
      aria-describedby={describedBy(ids)}
      {...(error ? { 'aria-invalid': true } : {})}
      {...rest}
      // An empty string, not `undefined`: `undefined` would make this an
      // uncontrolled input and React would keep the last typed text on screen
      // after the app cleared the value.
      value={value === null ? '' : String(value)}
      onChange={(e) => {
        const raw = e.currentTarget.value;
        if (raw === '') {
          onChange(null);
          return;
        }
        const n = Number(raw);
        // A partially-typed value ("-", "1e") parses to NaN. Report it as "no
        // value" rather than forwarding NaN into a workflow parameter.
        onChange(Number.isNaN(n) ? null : n);
      }}
    />,
  );
});

/**
 * Select — another real adapter, for the same reason as NumberInput.
 *
 * The contract ships the framework-agnostic NATIVE select: `<option>` children
 * and a DOM `onChange`. The app's call site passes a declarative `options`
 * array and expects `onChange` to receive the selected VALUE. Both are
 * converted here.
 */
export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface AppSelectProps
  extends Omit<
    React.SelectHTMLAttributes<HTMLSelectElement>,
    'onChange' | 'value' | 'defaultValue' | 'size'
  > {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  inputClassName?: string;
  value: string;
  onChange: (value: string) => void;
  /** Declarative options, rendered as `<option>` children. */
  options?: SelectOption[];
  /** A disabled, empty-valued leading option. Rendered only alongside `options`. */
  placeholder?: string;
  children?: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, AppSelectProps>(function Select(
  { value, onChange, options, placeholder, children, label, description, error, required, className, inputClassName, id, ...rest },
  ref,
) {
  const ids = useFieldIds(id, description !== undefined, error !== undefined);
  return fieldChrome(
    'select',
    { label, description, error, required, className },
    ids,
    <select
      ref={ref}
      data-civitai-ui-control
      className={inputClassName}
      id={ids.id}
      aria-describedby={describedBy(ids)}
      {...(error ? { 'aria-invalid': true } : {})}
      {...rest}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
    >
      {options ? (
        <>
          {placeholder !== undefined ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </>
      ) : (
        children
      )}
    </select>,
  );
});

/**
 * Slider — converts the native range event to the numeric `onChange` the app's
 * LoRA-weight control expects, and renders the `showValue` read-out (plus the
 * `aria-valuetext` the contract explicitly leaves to the author).
 */
export interface AppSliderProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'onChange' | 'value' | 'defaultValue' | 'type' | 'size'
  > {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  inputClassName?: string;
  value: number;
  onChange: (value: number) => void;
  /** Show the current value at the end of the label row. Default `false`. */
  showValue?: boolean;
}

export const Slider = forwardRef<HTMLInputElement, AppSliderProps>(function Slider(
  { value, onChange, showValue, label, description, error, required, className, inputClassName, id, ...rest },
  ref,
) {
  const ids = useFieldIds(id, description !== undefined, error !== undefined);
  const control = (
    <input
      ref={ref}
      className={inputClassName}
      id={ids.id}
      type="range"
      aria-describedby={describedBy(ids)}
      {...(error ? { 'aria-invalid': true } : {})}
      {...(showValue ? { 'aria-valuetext': String(value) } : {})}
      {...rest}
      value={value}
      onChange={(e) => onChange(e.currentTarget.valueAsNumber)}
    />
  );
  return (
    <div data-civitai-ui="slider" className={className} {...(error ? { 'data-invalid': 'true' } : {})}>
      {label ? (
        showValue ? (
          <div data-civitai-ui-slider-header>
            <label data-civitai-ui-label htmlFor={ids.id}>
              {label}
            </label>
            <output data-civitai-ui-slider-value htmlFor={ids.id}>
              {value}
            </output>
          </div>
        ) : (
          <label data-civitai-ui-label htmlFor={ids.id}>
            {label}
            {required ? (
              <span data-civitai-ui-required aria-hidden="true">
                {' *'}
              </span>
            ) : null}
          </label>
        )
      ) : null}
      {description ? (
        <span id={ids.descId} data-civitai-ui-description>
          {description}
        </span>
      ) : null}
      {control}
      {error ? (
        <span id={ids.errId} data-civitai-ui-error role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
});

/**
 * Textarea — prop-compatible except for `minRows`, which the contract spells
 * as the native `rows`, and `textareaClassName`, spelled `inputClassName`.
 */
export interface AppTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'> {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  minRows?: number;
  textareaClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, AppTextareaProps>(function Textarea(
  { minRows, textareaClassName, label, description, error, required, className, id, ...rest },
  ref,
) {
  const ids = useFieldIds(id, description !== undefined, error !== undefined);
  return fieldChrome(
    'textarea',
    { label, description, error, required, className },
    ids,
    <textarea
      ref={ref}
      data-civitai-ui-control
      className={textareaClassName}
      id={ids.id}
      rows={minRows}
      aria-describedby={describedBy(ids)}
      {...(error ? { 'aria-invalid': true } : {})}
      {...rest}
    />,
  );
});

// ---------------------------------------------------------------- pass-through

export interface TextInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  inputClassName?: string;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { label, description, error, required, className, inputClassName, id, ...rest },
  ref,
) {
  const ids = useFieldIds(id, description !== undefined, error !== undefined);
  return fieldChrome(
    'text-input',
    { label, description, error, required, className },
    ids,
    <input
      ref={ref}
      data-civitai-ui-control
      className={inputClassName}
      id={ids.id}
      aria-describedby={describedBy(ids)}
      {...(error ? { 'aria-invalid': true } : {})}
      {...rest}
    />,
  );
});

export { useBlocksStyles };
