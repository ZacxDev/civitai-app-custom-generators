// `useGenerationResources` — resource rehydrate by version id, as a hook.

import { useCallback, useMemo } from 'react';

import type { BlockResourceInfo } from '@civitai/app-sdk/blocks';

import { fetchGenerationResources } from './resources.js';

export interface UseGenerationResources {
  fetch: (ids: number[]) => Promise<BlockResourceInfo[]>;
}

export function useGenerationResources(): UseGenerationResources {
  const fetchFn = useCallback((ids: number[]) => fetchGenerationResources(ids), []);
  return useMemo(() => ({ fetch: fetchFn }), [fetchFn]);
}
