// JSX typings for the @civitai/components custom elements this app renders
// DIRECTLY (the upstream web components): the slide-out sidebar's nav
// list/item and the Discover sort menu. Registered by
// src/define-upstream.ts. React 19 sets matching element properties for
// props that exist on the element class (label / href / current / value).
import type React from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'civitai-nav-list': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        label?: string;
        current?: string;
      };
      'civitai-nav-item': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        label?: string;
        href?: string;
        current?: boolean;
        disabled?: boolean;
      };
      'civitai-menu': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        label?: string;
        open?: boolean;
        placement?: string;
      };
      'civitai-menu-item': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        value?: string;
        disabled?: boolean;
        destructive?: boolean;
      };
    }
  }
}

export {};
