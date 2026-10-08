// Image — the `@civitai/components` markup contract, rendered in React.
//
// The 0.9 line retired the React `Image` this app used to import from
// `@civitai/components-react`; the replacement binding is the shadow-DOM
// `<civitai-image>` element. This app renders the documented light-DOM
// contract instead (as `primitives.tsx` does for the controls): a
// `data-civitai-ui="image"` wrapper carrying `data-status`, the `<img>`
// itself, and the fallback overlay the stylesheet shows on `error`.
//
// The prop vocabulary is the one the call sites already use: `src`, `alt`,
// `loading`, `fallback` (text shown when the file fails), `wrapperStyle`
// (sizing for the wrapper) and `style` (applied to the `<img>`; an
// `objectFit` there becomes the contract's `data-fit`).

import { useState } from 'react';
import type { CSSProperties, ImgHTMLAttributes } from 'react';

export interface ImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'style'> {
  /** Text shown in the fallback overlay when the image fails to load. */
  fallback?: string;
  /** Sizing/style for the `data-civitai-ui="image"` wrapper. */
  wrapperStyle?: CSSProperties;
  style?: CSSProperties;
}

export function Image({ fallback, wrapperStyle, style, onLoad, onError, ...rest }: ImageProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const fit = style?.objectFit === 'contain' ? 'contain' : style?.objectFit === 'cover' ? 'cover' : undefined;
  const imgStyle: CSSProperties | undefined = style
    ? { ...style, objectFit: undefined, width: style.width ?? '100%', height: style.height ?? '100%' }
    : { width: '100%', height: '100%' };
  return (
    <div data-civitai-ui="image" data-status={status} style={wrapperStyle}>
      <img
        data-civitai-ui-image-img
        {...(fit ? { 'data-fit': fit } : {})}
        {...rest}
        style={imgStyle}
        onLoad={(e) => {
          setStatus('loaded');
          onLoad?.(e);
        }}
        onError={(e) => {
          setStatus('error');
          onError?.(e);
        }}
      />
      {fallback ? (
        <div data-civitai-ui-image-fallback aria-hidden="true">
          {fallback}
        </div>
      ) : null}
    </div>
  );
}
