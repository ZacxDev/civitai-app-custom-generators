// Prop adapters over `@civitai/components-react`.
//
// 🔴 THESE WRAPPERS EXIST SO THE VOCABULARY DIFFERENCE LIVES IN ONE PLACE. The
// components the app used from `@civitai/blocks-react/ui` and the ones
// `@civitai/components-react` ships are the same components, but they do not
// take the same props. The alternative to this file was editing ~200 JSX sites
// across nine files, which would have made the port a visual redesign as well as
// a transport change — two risks in one diff, with no way to tell which one broke
// a rendering assertion.
//
// The measured deltas this file absorbs:
//   Stack   gap: string|number    → gap: 'sm'|'md'|'lg';  align/justify dropped
//   Group   gap: string|number    → gap: 'sm'|'md'|'lg';  align/justify/wrap dropped
//   Card    radius dropped
//   Alert   withCloseButton dropped; closeButtonLabel → closeLabel; role dropped
//   Badge   color widened → BadgeColor
//   Button  color dropped
//   Loader  color dropped
//   NumberInput  value:number|null + onChange(number|null) → native input events
//
// 🔴 NUMERIC GAPS ARE PASSED THROUGH AS EXACT PIXELS rather than bucketed into
// the pack's three presets. This app uses eight distinct spacings (4, 6, 8, 10,
// 12, 14, 16, 18); collapsing those into 'sm'|'md'|'lg' would silently redesign
// every screen while the diff claimed to be a transport change. Presets remain
// the right choice for NEW code — this is a compatibility layer, not a
// recommendation.

import { forwardRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import {
  Alert as PackAlert,
  Badge as PackBadge,
  Button as PackButton,
  Card as PackCard,
  Group as PackGroup,
  Loader as PackLoader,
  NumberInput as PackNumberInput,
  Select as PackSelect,
  Slider as PackSlider,
  Stack as PackStack,
  TextInput as PackTextInput,
  Textarea as PackTextarea,
} from '@civitai/components-react';
import type {
  AlertColor,
  BadgeSize,
  BadgeVariant,
  ButtonSize,
  ButtonVariant,
  CardPadding,
  LoaderSize,
  TextInputProps,
} from '@civitai/components-react';

import { useBlocksStyles } from './styles.js';

/** The colour vocabulary the app passes; wider than the pack's `BadgeColor`. */
type AppColor = 'primary' | 'error' | 'success' | 'warning' | 'info' | (string & {});

/**
 * A numeric gap becomes an inline `gap`; a preset is forwarded to the pack so its
 * own CSS applies. `undefined` leaves the pack's default alone.
 */
function gapStyle(gap: string | number | undefined): CSSProperties | undefined {
  if (gap === undefined) return undefined;
  return { gap: typeof gap === 'number' ? `${gap}px` : gap };
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
  return (
    <PackStack
      ref={ref}
      {...rest}
      style={{ ...gapStyle(gap), ...(align ? { alignItems: align } : {}), ...(justify ? { justifyContent: justify } : {}), ...style }}
    />
  );
});

export interface GroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style'> {
  gap?: string | number;
  align?: CSSProperties['alignItems'];
  justify?: CSSProperties['justifyContent'];
  /** `false` pins the row to one line. The pack's CSS wraps by default. */
  wrap?: boolean;
  style?: CSSProperties;
}

export const Group = forwardRef<HTMLDivElement, GroupProps>(function Group(
  { gap, align, justify, wrap, style, ...rest },
  ref,
) {
  return (
    <PackGroup
      ref={ref}
      {...rest}
      style={{
        ...gapStyle(gap),
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
  /** Dropped by the pack; re-applied inline so rounded cards stay rounded. */
  radius?: string | number;
  style?: CSSProperties;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { radius, style, ...rest },
  ref,
) {
  return (
    <PackCard
      ref={ref}
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
   * Dropped by the pack — it reads `data-color` for Alert and Badge only. Applied
   * here as inline tokens.
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
  { color, style, ...rest },
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
  return <PackButton ref={ref} {...rest} style={{ ...tinted, ...style }} />;
});

export interface BadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'color'> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  color?: AppColor;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge({ color, ...rest }, ref) {
  // The pack narrows `color` to its own union but still forwards it to
  // `data-color`, which its CSS keys on — so a wider string is passed through
  // rather than dropped.
  return <PackBadge ref={ref} {...(rest as object)} color={color as never} />;
});

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'role'> {
  color?: AlertColor;
  title?: ReactNode;
  /** The pack always shows the close affordance when `onClose` is given. */
  withCloseButton?: boolean;
  onClose?: () => void;
  closeButtonLabel?: string;
  role?: React.AriaRole;
}

export function Alert({
  withCloseButton,
  onClose,
  closeButtonLabel,
  role,
  ...rest
}: AlertProps): React.JSX.Element {
  // `withCloseButton={false}` must actually suppress the button, and the pack
  // decides that from `onClose` alone — so withholding the handler is how the
  // old prop is honoured.
  const closable = withCloseButton !== false && onClose !== undefined;
  return (
    <PackAlert
      {...rest}
      {...(role ? { role } : {})}
      {...(closable ? { onClose } : {})}
      {...(closeButtonLabel ? { closeLabel: closeButtonLabel } : {})}
    />
  );
}

export interface LoaderProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: LoaderSize;
  /** Dropped by the pack; applied as `currentColor` so the spinner inherits it. */
  color?: string;
}

export function Loader({ color, style, ...rest }: LoaderProps): React.JSX.Element {
  return <PackLoader {...rest} style={{ ...(color ? { color } : {}), ...style }} />;
}

/**
 * NumberInput — the one adapter with real behaviour, not just prop renaming.
 *
 * 🔴 THE SIGNATURES ARE INCOMPATIBLE. The pack's NumberInput is a native
 * `<input type="number">`: `value` is a string and `onChange` receives a DOM
 * event. The app's call sites pass `value={number | null}` and
 * `onChange={(n: number | null) => …}` — a cleared field must arrive as `null`,
 * not as `NaN` and not as `0`, because both Runner and ButtonEditor treat `null`
 * as "use the server default" and `0` is a meaningful seed.
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
  { value, onChange, ...rest },
  ref,
) {
  return (
    <PackNumberInput
      ref={ref}
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
    />
  );
});

/**
 * Select — another real adapter, for the same reason as NumberInput.
 *
 * The pack ships the framework-agnostic NATIVE select: `<option>` children and a
 * DOM `onChange`. The app's call site passes a declarative `options` array and
 * expects `onChange` to receive the selected VALUE. Both are converted here.
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
  { value, onChange, options, placeholder, children, ...rest },
  ref,
) {
  return (
    <PackSelect
      ref={ref}
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
    </PackSelect>
  );
});

/**
 * Slider — converts the native range event to the numeric `onChange` the app's
 * LoRA-weight control expects, and maps `showValue` onto the pack's `valueLabel`.
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
  { value, onChange, showValue, ...rest },
  ref,
) {
  return (
    <PackSlider
      ref={ref}
      {...rest}
      {...(showValue ? { valueLabel: (v: number) => String(v) } : {})}
      value={value}
      onChange={(e) => onChange(e.currentTarget.valueAsNumber)}
    />
  );
});

/**
 * Textarea — prop-compatible except for `minRows`, which the pack spells as the
 * native `rows`, and `textareaClassName`, which it spells `inputClassName`.
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
  { minRows, textareaClassName, ...rest },
  ref,
) {
  return (
    <PackTextarea
      ref={ref}
      {...rest}
      {...(minRows !== undefined ? { rows: minRows } : {})}
      {...(textareaClassName !== undefined ? { inputClassName: textareaClassName } : {})}
    />
  );
});

// ---------------------------------------------------------------- pass-through
// Prop-compatible as shipped, so this one is a plain re-export — it is here only
// so every call site has a single import to change.

export const TextInput = PackTextInput;

export type { TextInputProps };
export { useBlocksStyles };
