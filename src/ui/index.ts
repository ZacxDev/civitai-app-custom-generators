// The app's design-system seam.
//
// Everything this app used to import from `@civitai/blocks-react/ui` comes from
// here now, under the same names and the same prop vocabulary, so the nine
// component files changed their import specifier and nothing else.
//
// What is behind each name:
//   - Alert, Badge, Button, Card, Group, Loader, NumberInput, Select, Slider,
//     Stack, TextInput, Textarea → `@civitai/components-react`, through the
//     prop adapters in `./primitives.tsx` (the packs do not agree on props).
//   - Modal, Collapse, ReportButton → re-implemented locally. Measured: the
//     React bindings package exports none of the three, and its custom-element
//     subpath offers only Lit versions of the first two, which jsdom never
//     upgrades. See each file's header.
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

export { injectBlocksStyles } from './styles.js';
