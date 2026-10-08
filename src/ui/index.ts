// The app's design-system seam.
//
// Everything this app used to import from `@civitai/blocks-react/ui` comes from
// here now, under the same names and the same prop vocabulary, so the nine
// component files changed their import specifier and nothing else.
//
// What is behind each name:
//   - Alert, Badge, Button, Card, Group, Loader, NumberInput, Select, Slider,
//     Stack, TextInput, Textarea → the `@civitai/components` MARKUP contract
//     (`data-civitai-ui` attributes + its injected stylesheet), through the
//     prop adapters in `./primitives.tsx`. The 0.9 line retired the React
//     bindings layer this used to forward to; writing the documented markup
//     is the package's framework-agnostic consumption path.
//   - Image → the same contract's image markup, in `./Image.tsx`.
//   - Modal, Collapse, ReportButton → re-implemented locally (the contract
//     carries no modal/collapse styling). See each file's header.
//   - injectBlocksStyles → `injectStyles()` plus the local Modal/Collapse CSS.
//
// `BlockGate` is deliberately NOT here: it has to know whether the host ever
// answered, which makes it a platform concern rather than a presentational one.
// It lives in `../platform/BlockGate.tsx`.

export {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  Select,
  Slider,
  Stack,
  TextInput,
  Textarea,
  useBlocksStyles,
} from './primitives.js';

export type {
  AlertProps,
  AppSelectProps,
  AppSliderProps,
  AppTextareaProps,
  BadgeProps,
  ButtonProps,
  CardProps,
  GroupProps,
  LoaderProps,
  NumberInputProps,
  SelectOption,
  StackProps,
  TextInputProps,
} from './primitives.js';

export { Modal } from './Modal.js';
export type { ModalProps, ModalSize } from './Modal.js';

export { Collapse } from './Collapse.js';
export type { CollapseProps } from './Collapse.js';

export { ReportButton } from './ReportButton.js';
export type { ReportButtonProps } from './ReportButton.js';

export { Image } from './Image.js';
export type { ImageProps } from './Image.js';

export { SegmentedControl } from './SegmentedControl.js';
export type { SegmentedControlOption, SegmentedControlProps } from './SegmentedControl.js';

export { Tooltip } from './Tooltip.js';
export type { TooltipProps } from './Tooltip.js';

export { ToastProvider, useToast } from './Toast.js';
export type { ToastApi, ToastShowOptions } from './Toast.js';

export { injectBlocksStyles } from './styles.js';
