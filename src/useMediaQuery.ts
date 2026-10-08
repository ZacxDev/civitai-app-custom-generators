import { useEffect, useState } from 'react';

// The Civitai breakpoint scale is 0 / 480 (xs) / 768 (sm) / 1024 (md) /
// 1184 (lg) / 1440 (xl), published as the `--civitai-bp-*` tokens. A page app
// measures its own frame, so CSS tokens are not needed here — the layout
// switch is written as the literal pixel boundary the scale defines: the
// compact layout holds below the `sm` tier (768px).
const MOBILE_QUERY = '(max-width: 767px)';

/** True in the compact (below-`sm`) layout. Mobile-first: defaults to true when
 * matchMedia is unavailable (SSR/older jsdom) so the compact layout wins. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return window.matchMedia(MOBILE_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);

  return isMobile;
}
