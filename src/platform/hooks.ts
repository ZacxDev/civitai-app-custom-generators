// The React bindings the bridge package used to ship.
//
// `@civitai/sdk` ships no React hooks at all — it is plain functions, and binding
// them to a framework is the app's job. (How many hooks the bridge package shipped
// is not stated here: it is not installed, so nothing in this tree can check it.)
// This file is that binding, and it keeps the OLD hook names and the
// OLD signatures on purpose — which is why `App.tsx`, a large file and by far the
// heaviest consumer of these hooks, changed at its import block and nowhere else.
//
// 🔴 NO COUNTS IN THIS COMMENT, DELIBERATELY. It used to quote a hook delta, a
// line count for `App.tsx` and a number of call sites; all three rotted, and two
// of them were corrected in one file and left stale in another across three
// rounds. Nothing asserts on any of them — `git grep` the names instead.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type {
  BlockGenerationSourceImageInfo,
  BlockPendingImageInfo,
  BlockResourceInfo,
  BlockResourcePickerType,
} from '@civitai/app-sdk/blocks';
import type { ImageScanResult, PendingImage } from '@civitai/sdk';

import { getClient, getPlatformTransport, getSnapshot } from './client.js';
import { fetchBuzzBalance, type BuzzBalance } from './buzz.js';

// ---------------------------------------------------------------- context

export interface BlockContextValue {
  /** `false` until the handshake lands. Nothing may paint real data before it. */
  ready: boolean;
  /** `null` for an anonymous viewer. */
  viewer: { id: number; username: string | null } | null;
  theme: 'light' | 'dark';
}

function readContext(): BlockContextValue {
  const s = getSnapshot();
  return { ready: s.ready, viewer: s.viewer, theme: s.theme };
}

/**
 * The host handshake, as React state.
 *
 * 🔴 `theme` BEFORE `ready` IS A SENTINEL, NOT A READING. The snapshot carries
 * `'light'` before `BLOCK_INIT`, for every viewer, indistinguishable from a host
 * that really is light. Nothing may paint from it while `ready` is false.
 */
export function useBlockContext(): BlockContextValue {
  const [value, setValue] = useState<BlockContextValue>(readContext);

  useEffect(() => {
    let cancelled = false;
    // 🔴 SUBSCRIBE FIRST, THEN RE-READ. A handshake landing between the initial
    // `useState` read and this effect would otherwise be missed entirely, and the
    // app would sit on `ready: false` forever with a host on the line.
    const off = getPlatformTransport().snapshot.subscribe(() => {
      if (!cancelled) setValue(readContext());
    });
    setValue(readContext());
    // `initialize()` is what sends BLOCK_READY, so nothing arrives until some
    // caller starts the handshake. Starting it here makes this hook sufficient on
    // its own rather than dependent on a data call happening to run first.
    //
    // A rejection is the no-host case; `BlockGate` renders the landing for it, so
    // there is nothing to do here but not crash.
    void getClient().catch(() => {});
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return value;
}

export interface BlockTokenValue {
  raw: string;
  scopes: string[];
  expiresAt: Date;
  buzzBudget?: number;
}

/**
 * The block token, as React state.
 *
 * Read from the transport snapshot rather than `client.getToken()`: this app
 * gates its generate path on `scopes`, and `getToken()` resolves the raw string
 * only. Both halves come from the SAME snapshot read — mixing sources would let a
 * mid-flight `TOKEN_REFRESH` produce a pair that never existed together.
 */
export function useBlockToken(): BlockTokenValue {
  const [token, setToken] = useState<BlockTokenValue>(() => getSnapshot().token);

  useEffect(() => {
    let cancelled = false;
    const off = getPlatformTransport().snapshot.subscribe(() => {
      if (!cancelled) setToken(getSnapshot().token);
    });
    setToken(getSnapshot().token);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return token;
}

/** Keep the iframe as tall as `ref`'s element. The SDK owns the ResizeObserver. */
export function useBlockResize(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;

    void getClient()
      .then((app) => {
        if (cancelled) return;
        stop = app.host.autoResize(ref.current ?? undefined);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [ref]);
}

// ---------------------------------------------------------------- host UI

export interface UseResourcePicker {
  open: (opts: {
    resourceType: BlockResourcePickerType;
    baseModelGroup?: string;
  }) => Promise<BlockResourceInfo | null>;
}

/**
 * civitai's own resource picker.
 *
 * The SDK's `PickedResource` and the app's `BlockResourceInfo` are the same
 * projection of the same host reply — same field names, same optionality — so
 * this is a pass-through rather than a mapping.
 */
export function useResourcePicker(): UseResourcePicker {
  const open = useCallback(
    async (opts: { resourceType: BlockResourcePickerType; baseModelGroup?: string }) => {
      const app = await getClient();
      const picked = await app.host.openResourcePicker({
        resourceType: opts.resourceType,
        ...(opts.baseModelGroup !== undefined ? { baseModelGroup: opts.baseModelGroup } : {}),
      });
      return picked as BlockResourceInfo | null;
    },
    [],
  );
  return useMemo(() => ({ open }), [open]);
}

export interface UseImageUpload {
  /** Opens the host upload modal. `null` means the viewer closed it. */
  open: () => Promise<BlockPendingImageInfo | null>;
  /** Resolve the moderation verdict for a handle `open()` returned. */
  scanStatus: (image: BlockPendingImageInfo) => Promise<ImageScanResult>;
}

export interface UseSourceImageUpload {
  open: () => Promise<BlockGenerationSourceImageInfo | null>;
}

/**
 * The host's upload modal, in its two purposes.
 *
 * 🔴 THE HANDLE AND ITS VERDICT ARE SEPARATED BY A SIDE TABLE, AND THEY HAVE TO
 * BE. The SDK resolves a `PendingImage` carrying a `scan()` METHOD; this app's
 * `AppDeps.uploadImage` is typed to return the plain `BlockPendingImageInfo`
 * wire shape, and it stores that handle in React state, passes it between
 * components and re-reads it after a retry. A method does not survive that, so
 * the live object is kept here, keyed by `imageId`, and `scanStatus()` looks it
 * up. Keeping the app's shape is what let the Builder's scan UI stay untouched.
 *
 * ⚠️ `scan()` HAS NO DEADLINE OF ITS OWN. The old hook gave up after ten minutes
 * and called it a retryable error; the SDK deliberately sets no bound, because
 * the host is what bounds the scan. The app's own `bgScanTimeoutMs` seam is what
 * supplies one now — see `App.tsx`.
 */
export function useImageUpload(opts?: {
  asyncScan?: boolean;
  purpose?: 'display' | 'generationSource';
}): UseImageUpload & UseSourceImageUpload {
  // Not state: re-rendering on an upload would be wrong, and the map has to
  // survive the re-render the upload itself causes.
  const pendingRef = useRef(new Map<number, PendingImage>());
  const purpose = opts?.purpose ?? 'display';

  const open = useCallback(async () => {
    const app = await getClient();
    if (purpose === 'generationSource') {
      const source = await app.host.openImageUpload({ purpose: 'generationSource' });
      return source as never;
    }
    const pending = await app.host.openImageUpload({ purpose: 'display' });
    if (!pending) return null as never;
    pendingRef.current.set(pending.imageId, pending);
    return {
      status: 'pending',
      imageId: pending.imageId,
      url: pending.url,
    } as never;
  }, [purpose]);

  const scanStatus = useCallback(async (image: BlockPendingImageInfo) => {
    const live = pendingRef.current.get(image.imageId);
    if (!live) {
      // The handle did not come from this hook instance — a remount, or a handle
      // rehydrated from storage. There is no `scan()` to await, and reporting
      // "scanned" would clear an image nobody checked, so this fails closed.
      return {
        status: 'error',
        message: 'Lost track of this upload. Re-upload the image to scan it again.',
      } satisfies ImageScanResult;
    }
    // Re-readable by contract: the SDK returns the same answer to every later
    // call, which is what makes the app's Retry button work.
    return live.scan();
  }, []);

  return useMemo(
    () => ({ open, scanStatus }) as UseImageUpload & UseSourceImageUpload,
    [open, scanStatus],
  );
}

export interface UsePublishGenerationOutputs {
  publish: (args: {
    workflowId: string;
    imageIndexes?: number[];
    /** Accepted and DROPPED — see below. */
    title?: string;
  }) => Promise<number[]>;
}

/**
 * Turn this app's own workflow outputs into durable civitai `Image` rows.
 *
 * ⚠️ `title` IS ACCEPTED AND DISCARDED, and that is not new behaviour. It
 * reached the host's validator and was then dropped before the mutation, so
 * sending it was a no-op end to end; the SDK simply stopped carrying a field
 * that did nothing. The parameter is kept in this signature so the call site in
 * `App.tsx` did not have to change.
 *
 * ⚠️ Publishing is best-effort per image: an output that fails is SKIPPED rather
 * than failing the call, so the returned array can be SHORTER than the selection
 * and nothing says which index dropped. Compare lengths; never pair ids to
 * indexes.
 */
export function usePublishGenerationOutputs(): UsePublishGenerationOutputs {
  const publish = useCallback(
    async (args: { workflowId: string; imageIndexes?: number[]; title?: string }) => {
      const app = await getClient();
      return app.host.publishGenerationOutputs({
        workflowId: args.workflowId,
        ...(args.imageIndexes !== undefined ? { imageIndexes: args.imageIndexes } : {}),
      });
    },
    [],
  );
  return useMemo(() => ({ publish }), [publish]);
}

export interface UseRequestConsent {
  requestConsent: (opts: { scopes: string[] }) => void;
}

/**
 * Ask for more scopes.
 *
 * 🔴 A REFUSAL NOW RESOLVES `false` RATHER THAN REJECTING. The old hook's
 * `requestConsent` was fire-and-forget and the app re-read its scopes afterwards;
 * `requestGrants` answers. The signature here stays `void`-returning so the call
 * site is unchanged, and `App.tsx` uses the awaited form directly where it
 * retries a budgeted generation — see `requestGrants` below.
 */
export function useRequestConsent(): UseRequestConsent {
  const requestConsent = useCallback((opts: { scopes: string[] }) => {
    void getClient()
      .then((app) => app.requestGrants(opts.scopes as never))
      .catch(() => {});
  }, []);
  return useMemo(() => ({ requestConsent }), [requestConsent]);
}

/** The awaited form: `true` when every scope is now held. */
export async function requestGrants(scopes: string[]): Promise<boolean> {
  const app = await getClient();
  return app.requestGrants(scopes as never);
}

export interface UseRequestSignIn {
  requestSignIn: () => void;
}

/**
 * Start sign-in.
 *
 * 🔴 SENT OVER THE RAW TRANSPORT, NOT `app.host.requestSignIn()`, and
 * deliberately. Both emit the identical wire message, but this one is
 * SYNCHRONOUS and needs no initialised client — so the signed-out CTA still
 * works in the window before the handshake completes, which is exactly the state
 * an anonymous viewer is in when they press it.
 */
export function useRequestSignIn(): UseRequestSignIn {
  const requestSignIn = useCallback(() => {
    getPlatformTransport().notify({ type: 'REQUEST_SIGN_IN', payload: {} });
  }, []);
  return useMemo(() => ({ requestSignIn }), [requestSignIn]);
}

export interface UseCivitaiNavigate {
  navigate: (path: string, target?: 'current' | 'new_tab') => void;
}

/** Host-mediated navigation. The host refuses anything outside this app's paths. */
export function useCivitaiNavigate(): UseCivitaiNavigate {
  const navigate = useCallback((path: string, target?: 'current' | 'new_tab') => {
    void getClient()
      .then((app) => app.host.navigate(path, target ? { target } : undefined))
      .catch(() => {});
  }, []);
  return useMemo(() => ({ navigate }), [navigate]);
}

export interface PurchaseResult {
  purchased: boolean;
  newBalance?: number;
}

export interface UseBuzzPurchase {
  openPurchaseModal: (suggestedAmount?: number) => Promise<PurchaseResult>;
}

/**
 * The host's Buzz-purchase modal.
 *
 * ⚠️ SHIPPED DEGRADED: `newBalance` IS ALWAYS `undefined` NOW. The host's reply
 * still carries it, but the SDK's `openBuzzPurchase` projects the reply down to
 * `{ purchased }` and drops it. Nothing reads a WRONG number — the field is
 * simply absent — and `App.tsx` already follows a purchase with
 * `refreshBalance()`, so the balance on screen is correct one round trip later.
 * Filed against the SDK; when it carries the field again this returns it.
 */
export function useBuzzPurchase(): UseBuzzPurchase {
  const openPurchaseModal = useCallback(async (suggestedAmount?: number) => {
    const app = await getClient();
    const res = await app.host.openBuzzPurchase(
      suggestedAmount !== undefined ? { suggestedAmount } : undefined,
    );
    return { purchased: res.purchased };
  }, []);
  return useMemo(() => ({ openPurchaseModal }), [openPurchaseModal]);
}

// ---------------------------------------------------------------- analytics
//
// THERE IS NO ANALYTICS SURFACE HERE ANY MORE, AND NOTHING REPLACED IT.
//
// `useBlockAnalytics()` was a no-op shim (`if (import.meta.env.DEV)
// console.debug(...)`) behind eleven `track()` call sites and an eleven-name event
// vocabulary in `src/lib/analytics.ts`. It recorded nothing in production by
// construction, nothing consumed the events, and the requirement for them was
// unattributed — so the shim, the vocabulary and the call sites were deleted
// rather than kept against a sink that might arrive.
//
// The consequence, stated rather than softened: this app now emits NO funnel
// telemetry at all, and a render error caught by the top-level `ErrorBoundary` is
// reported nowhere (React's own console output is what remains). Wiring a real
// sink means re-adding the emit sites, not filling in a hook body.

// ---------------------------------------------------------------- buzz

export interface UseBuzzBalance {
  /**
   * The three pools, or `null` until the first read resolves.
   *
   * 🔴 NULL IS NOT ZERO, and `App.tsx` depends on the difference: it renders the
   * Buzz total as "—" while `balance` is null and as a number once it is set. A
   * zeroed default would tell a viewer with Buzz that they have none, and the
   * insufficient-funds guard would refuse a generation they could afford.
   */
  balance: BuzzBalance | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * The viewer's Buzz balance.
 *
 * The read is latest-wins: a slow first request must not overwrite a fast second
 * one, which is the ordinary shape after a purchase (refetch fires while the
 * pre-purchase read is still in flight).
 */
export function useBuzzBalance(): UseBuzzBalance {
  const [state, setState] = useState<{
    balance: BuzzBalance | null;
    loading: boolean;
    error: Error | null;
  }>({ balance: null, loading: true, error: null });
  const seq = useRef(0);

  const refetch = useCallback(() => {
    const mine = (seq.current += 1);
    setState((s) => ({ ...s, loading: true }));
    void fetchBuzzBalance()
      .then((balance) => {
        if (seq.current !== mine) return;
        setState({ balance, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (seq.current !== mine) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        }));
      });
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return useMemo(() => ({ ...state, refetch }), [state, refetch]);
}
