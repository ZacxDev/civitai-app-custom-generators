// A React error boundary around the whole app. Without it, a thrown render
// error (e.g. a malformed shared row that slips past parsing and crashes a
// child) unmounts everything and leaves a BLANK iframe with no way to recover.
// This catches the throw, shows a recoverable fallback, and a Retry re-mounts
// the subtree (resetting the boundary so the app tries again).

import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional analytics/logging sink for the caught error (fire-and-forget). */
  onError?: (error: Error, info: ErrorInfo) => void;
  /**
   * Render prop for a custom fallback. Receives the error + a `reset` that
   * clears the boundary and re-mounts children. Defaults to the built-in card.
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return <DefaultFallback error={error} reset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultFallback({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div
      role="alert"
      data-testid="app-error-boundary"
      style={{
        margin: 'auto',
        maxWidth: 420,
        padding: 24,
        textAlign: 'center',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        color: 'var(--civitai-color-text, #e8eaed)',
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 8 }} aria-hidden>
        ⚠️
      </div>
      <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Something went wrong</h2>
      <p style={{ margin: '0 0 16px', fontSize: 14, opacity: 0.75 }} data-testid="app-error-message">
        {error.message || 'The app hit an unexpected error.'}
      </p>
      <button
        type="button"
        data-testid="app-error-retry"
        onClick={reset}
        style={{
          padding: '8px 18px',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          borderRadius: 8,
          border: '1px solid var(--civitai-color-border, #2a2d33)',
          background: 'var(--civitai-color-primary, #4263eb)',
          color: 'var(--civitai-color-primary-fg, #fff)',
        }}
      >
        Try again
      </button>
    </div>
  );
}
