// `useGatedImages` — the per-viewer moderated image read, as a hook.

import { useCallback, useMemo } from 'react';

import type { BlockGatedImage } from '@civitai/app-sdk/blocks';

import { fetchGatedImages } from './images.js';

export interface UseGatedImages {
  getImages: (imageIds: number[]) => Promise<BlockGatedImage[]>;
}

export function useGatedImages(): UseGatedImages {
  const getImages = useCallback((imageIds: number[]) => fetchGatedImages(imageIds), []);
  return useMemo(() => ({ getImages }), [getImages]);
}
