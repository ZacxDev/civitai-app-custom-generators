// `useCreatePostFromApp` — the host-mediated post write, as a hook.
//
// Keeps the bridge hook's exact surface (`createPost` / `pending` / `error`),
// including the unmount guard, because `KeptGallery` reads all three and the
// request can outlive the component by up to ten minutes while the viewer decides.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { BlockCreatePostRequest, BlockCreatePostResult } from '@civitai/app-sdk/blocks';

import { createPost as sendCreatePost, CreatePostError } from './createPost.js';

export interface UseCreatePostFromApp {
  createPost: (args: BlockCreatePostRequest) => Promise<BlockCreatePostResult>;
  /** `true` while a request is in flight, including the viewer's confirm. */
  pending: boolean;
  /** The last request's failure, or `null`. A dismissal lands here too — read `.declined`. */
  error: CreatePostError | null;
}

export function useCreatePostFromApp(): UseCreatePostFromApp {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<CreatePostError | null>(null);

  // This request can outlive the component by up to ten minutes (the viewer may
  // leave the confirm open), so `pending` toggled on an unmounted control is
  // state nobody can clear.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const createPost = useCallback(async (args: BlockCreatePostRequest) => {
    if (mountedRef.current) {
      setPending(true);
      setError(null);
    }
    try {
      return await sendCreatePost(args);
    } catch (err) {
      const wrapped =
        err instanceof CreatePostError
          ? err
          : new CreatePostError(err instanceof Error ? err.message : String(err));
      if (mountedRef.current) setError(wrapped);
      // 🔴 THROWN UNCONDITIONALLY, even when unmounted. The caller's `await` is
      // what decides whether to revert optimistic state, and swallowing the
      // rejection because a component went away would resolve it as success.
      throw wrapped;
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }, []);

  return { createPost, pending, error };
}
