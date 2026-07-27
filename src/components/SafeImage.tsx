// An <img> that removes itself if the source fails to load, instead of leaving a
// broken-image glyph (a withdrawn cover, a dead/offline host). Used for the
// cosmetic cover/header images, which are decorative — a missing one should
// simply collapse, never dominate the card with a broken placeholder.

import { useState } from 'react';
import type { ImgHTMLAttributes } from 'react';

export function SafeImage(props: ImgHTMLAttributes<HTMLImageElement>) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    <img
      {...props}
      onError={(e) => {
        setBroken(true);
        props.onError?.(e);
      }}
    />
  );
}
