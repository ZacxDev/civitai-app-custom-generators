// Ship-blocker #4: a thrown render error must show a recoverable fallback (not a
// blank iframe), and Retry must re-mount the subtree.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary.js';

/** A child that throws on first render, then (after a reset flips the flag) renders fine. */
function Bomb({ throwNow }: { throwNow: boolean }) {
  if (throwNow) throw new Error('boom in render');
  return <div data-testid="bomb-ok">recovered content</div>;
}

/** Wrapper whose `throwNow` can be flipped externally, then reset re-mounts children. */
function Harness() {
  const [armed, setArmed] = useState(true);
  return (
    <div>
      <button data-testid="disarm" onClick={() => setArmed(false)}>
        disarm
      </button>
      <ErrorBoundary fallback={(error, reset) => (
        <div>
          <span data-testid="fallback">{error.message}</span>
          <button data-testid="retry" onClick={reset}>retry</button>
        </div>
      )}>
        <Bomb throwNow={armed} />
      </ErrorBoundary>
    </div>
  );
}

describe('ErrorBoundary', () => {
  // React logs the caught error to console.error — silence it for a clean run.
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('renders the DEFAULT fallback with a Try again control on a child throw', () => {
    render(
      <ErrorBoundary>
        <Bomb throwNow />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('app-error-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('app-error-message')).toHaveTextContent('boom in render');
    expect(screen.getByTestId('app-error-retry')).toBeInTheDocument();
  });

  it('Retry re-mounts children — after the throw condition clears, the app comes back', async () => {
    render(<Harness />);
    // fallback is showing
    expect(screen.getByTestId('fallback')).toHaveTextContent('boom in render');

    // clear the throw condition in the (still-mounted) parent, then retry
    await userEvent.click(screen.getByTestId('disarm'));
    await userEvent.click(screen.getByTestId('retry'));

    // the boundary reset → children re-mounted and now render successfully
    expect(await screen.findByTestId('bomb-ok')).toHaveTextContent('recovered content');
    expect(screen.queryByTestId('fallback')).not.toBeInTheDocument();
  });

  it('calls onError with the caught error', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Bomb throwNow />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
