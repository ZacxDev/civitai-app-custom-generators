// BlockGate — carried from `@civitai/blocks-react/ui` when this app moved to
// `@civitai/sdk`, which ships no UI.
//
// Without it, this app opened at its own bare `custom-generators.civit.ai`
// origin — a shared link, a social unfurl, a crawler — hangs forever on its
// loading state, because nobody is ever going to send `BLOCK_INIT`. The gate
// turns that into a branded "Open on Civitai" landing.
//
// It lives in `platform/` rather than `ui/` because deciding "is anyone out
// there?" means asking whether the handshake completed, which is a transport
// question.

import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { Card, Stack, useBlocksStyles } from '../ui/index.js';
import { getClient } from './client.js';

/**
 * Milliseconds to wait for the handshake before concluding a TOP-LEVEL load is a
 * direct one. Well above the dev harness's init latency (its transport is
 * injected with a snapshot already in hand, so `getClient()` settles on a
 * microtask without exchanging a message) and below anything a human tolerates
 * staring at a spinner.
 */
export const DIRECT_LOAD_TIMEOUT_MS = 2000;

/** The Civitai host that serves the embedded run route. */
const CIVITAI_HOST = 'civitai.com';
/** The deployed-block origin suffix (`<slug>.civit.ai`). */
const CIVIT_AI_SUFFIX = '.civit.ai';
/** A single DNS label (the slug), lowercased. */
const DNS_LABEL = /^[a-z0-9-]+$/;

/**
 * Derive the canonical Civitai route for a block served from `<slug>.civit.ai`.
 *
 * Anything else — `localhost`, an IP, a bare `civit.ai`, a non-civit.ai host —
 * returns `null`, and the caller MUST NOT render a `civitai.com/apps/run/…` link
 * in that case: there is no meaningful target, and a broken `apps/run/localhost`
 * is worse than a neutral message.
 */
export function hostToRunUrl(hostname: string | null | undefined): string | null {
  if (!hostname) return null;
  // Normalise, then strip trailing FQDN dots with a linear trim rather than a
  // `/\.+$/` regex, which backtracks O(n²) on a string of many dots (ReDoS).
  const normalized = hostname.trim().toLowerCase();
  let end = normalized.length;
  while (end > 0 && normalized.charCodeAt(end - 1) === 46 /* '.' */) end -= 1;
  const host = normalized.slice(0, end);
  if (!host.endsWith(CIVIT_AI_SUFFIX)) return null;
  const slug = host.slice(0, host.length - CIVIT_AI_SUFFIX.length).split('.')[0] ?? '';
  if (!slug || !DNS_LABEL.test(slug)) return null;
  return `https://${CIVITAI_HOST}/apps/run/${slug}`;
}

/**
 * True iff this window is the TOP-LEVEL browsing context.
 *
 * Uses the `window.self === window.top` IDENTITY comparison, which is always
 * safe: it never reads a property off a (potentially cross-origin) parent, so it
 * cannot throw the SecurityError that `window.top.location` would.
 */
function isTopLevel(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self === window.top;
  } catch {
    // Defensive: treat an exotic engine's throw as embedded — never show the
    // fallback to a genuinely-framed block.
    return false;
  }
}

/**
 * Detect a DIRECT (unembedded) load.
 *
 * Returns `true` ONLY when the block is top-level AND the handshake has not
 * completed within `timeoutMs`. Precise by construction: an embedded block is
 * never top-level, and under the dev harness `getClient()` resolves off the
 * injected snapshot, so the timer is cleared long before it fires.
 */
export function useDirectLoad(timeoutMs: number = DIRECT_LOAD_TIMEOUT_MS): boolean {
  const [direct, setDirect] = useState(false);

  useEffect(() => {
    if (!isTopLevel()) return;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) setDirect(true);
    }, timeoutMs);

    void getClient()
      // A host answered — this is embedded after all, so never show the landing.
      .then(() => {
        settled = true;
        clearTimeout(timer);
      })
      // A rejection IS the direct-load case; leave the timer to decide, so the
      // landing appears at the same moment either way.
      .catch(() => {});

    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, [timeoutMs]);

  return direct;
}

/**
 * Read the OS/browser colour-scheme preference, live.
 *
 * A directly-loaded block has no `BLOCK_INIT`, so there is no host `theme` to
 * paint from. `prefers-color-scheme` is the only signal available.
 */
function usePrefersColorScheme(): 'light' | 'dark' {
  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return dark ? 'dark' : 'light';
}

const wrapperStyle: CSSProperties = {
  minHeight: '100%',
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  boxSizing: 'border-box',
  background: 'var(--civitai-color-surface-2)',
  color: 'var(--civitai-color-text)',
};
const brandStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--civitai-color-primary)',
};
const titleStyle: CSSProperties = { fontSize: 18, fontWeight: 700 };
const bodyStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.5,
  color: 'var(--civitai-color-text-dimmed)',
};

export interface DirectLoadFallbackProps {
  /** Override the hostname used to derive the run URL. Primarily a testing seam. */
  hostname?: string;
}

/** The branded "Open on Civitai" landing. */
export function DirectLoadFallback({ hostname }: DirectLoadFallbackProps): React.JSX.Element {
  useBlocksStyles();
  const theme = usePrefersColorScheme();
  const resolvedHost =
    hostname ?? (typeof window !== 'undefined' ? window.location?.hostname : undefined);
  const runUrl = hostToRunUrl(resolvedHost);

  return (
    <div data-theme={theme} data-civitai-block-direct-load="true" style={wrapperStyle}>
      <Card withBorder padding="lg" style={{ maxWidth: 420, width: '100%', textAlign: 'center' }}>
        <Stack gap={12} align="center">
          <span style={brandStyle}>Civitai App</span>
          {runUrl ? (
            <>
              <strong style={titleStyle}>Open this app on Civitai</strong>
              <span style={bodyStyle}>
                This is a Civitai App. It runs inside Civitai, where you can sign in and use it.
              </span>
              <a
                data-civitai-ui="button"
                data-variant="filled"
                data-size="lg"
                data-full-width="true"
                data-testid="direct-load-open-on-civitai"
                href={runUrl}
                target="_top"
                rel="noopener"
              >
                Open on Civitai
              </a>
            </>
          ) : (
            <>
              <strong style={titleStyle}>Waiting for the Civitai host…</strong>
              <span style={bodyStyle} role="status">
                This is a Civitai App. It’s meant to run inside the Civitai host. In local
                development, load it through the block dev harness.
              </span>
            </>
          )}
        </Stack>
      </Card>
    </div>
  );
}

export interface BlockGateProps {
  /** The app. Rendered whenever the block is NOT a direct (unembedded) load. */
  children: ReactNode;
  timeoutMs?: number;
  /** Override the fallback rendered on a direct load. */
  fallback?: ReactNode;
  /** Forwarded to the default fallback (testing seam). */
  hostname?: string;
}

/**
 * Renders `children` unchanged unless the block was loaded directly, in which
 * case it shows the landing instead.
 *
 * It also injects the design-system stylesheet on BOTH branches. Every component
 * injects it itself, so styling used to arrive as a side effect of rendering one
 * — which meant a branch rendering none got no tokens at all.
 */
export function BlockGate({
  children,
  timeoutMs,
  fallback,
  hostname,
}: BlockGateProps): React.JSX.Element {
  // Before the branch, and unconditional: hook order must not depend on
  // `directLoad`.
  useBlocksStyles();
  const directLoad = useDirectLoad(timeoutMs);

  if (directLoad) return <>{fallback ?? <DirectLoadFallback hostname={hostname} />}</>;
  return <>{children}</>;
}
