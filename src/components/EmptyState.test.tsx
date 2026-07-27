// EmptyState render + inline action. The polish pass requires an empty state to
// carry a title, a muted line, AND (where relevant) the primary action inline —
// never a lonely "nothing here" string. Assert all three render so a copy of
// this template can't silently drop the action on a later refactor.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './EmptyState.js';

describe('EmptyState', () => {
  it('renders the title, the muted body line, and the inline action together', () => {
    render(
      <EmptyState
        data-testid="empty"
        title="No published generators yet"
        body="Build a set of one-tap generation buttons and publish it for everyone to run."
        action={<button type="button">Create the first one</button>}
      />,
    );
    expect(screen.getByText('No published generators yet')).toBeInTheDocument();
    expect(
      screen.getByText('Build a set of one-tap generation buttons and publish it for everyone to run.'),
    ).toBeInTheDocument();
    // The primary action is rendered inline, not omitted.
    expect(screen.getByRole('button', { name: 'Create the first one' })).toBeInTheDocument();
  });

  it('renders without a body or action (title-only) without crashing', () => {
    render(<EmptyState data-testid="empty" title="Nothing here" />);
    expect(screen.getByTestId('empty')).toBeInTheDocument();
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
