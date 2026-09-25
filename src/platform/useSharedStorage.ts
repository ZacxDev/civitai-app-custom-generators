// `useSharedStorage` — the hook shape `App.tsx` passes straight into
// `deps.shared`.

import { useMemo } from 'react';

import { createSharedStorage } from './sharedStorage.js';
import type { SharedStorage } from './types.js';

/**
 * The shared store, memoised so the object identity is stable across renders.
 *
 * Identity matters here: `App.tsx` puts this object into a `useMemo`'d `deps` bag
 * whose dependency array deliberately does NOT list it, on the documented
 * assumption that the hook results are stable. A fresh object each render would
 * not break that memo (it is not in the array) but it would make the assumption
 * false, which is the kind of quiet divergence that bites the next change.
 */
export function useSharedStorage(): SharedStorage {
  return useMemo(() => createSharedStorage(), []);
}
