// Browse — dogfood UX fixes: the persistent anon sign-in header, the per-card
// Discover cost signal, and the one-time onboarding IntroPanel.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Browse, type BrowseProps } from './Browse.js';
import { palette } from '../theme.js';
import { buildPublishPayload, newButton } from '../lib/generator.js';
import type { GeneratorConfig } from '../types.js';
import type { SharedListItem } from '@civitai/blocks-react';

const c = palette();

function itemWithButtons(key: string, title: string): SharedListItem {
  const config: GeneratorConfig = {
    name: title,
    description: `${title} description`,
    buttons: [newButton({ params: { steps: 25, width: 1024, height: 1024, quantity: 1 } })],
  };
  return {
    key,
    authorUserId: 7,
    value: buildPublishPayload(config),
    count: 0,
    viewerVoted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function renderBrowse(over: Partial<BrowseProps> = {}) {
  const props: BrowseProps = {
    c,
    loading: false,
    error: null,
    discover: [],
    myDrafts: [],
    myPublished: [],
    viewerId: 99,
    onSignIn: vi.fn(),
    onCreate: vi.fn(),
    onOpenPublished: vi.fn(),
    onOpenDraft: vi.fn(),
    onEditDraft: vi.fn(),
    onDeleteDraft: vi.fn(),
    onDeletePublished: vi.fn(),
    onVote: vi.fn(async () => 1),
    onFork: vi.fn(),
    onShare: vi.fn(async () => true),
    coverUrlFor: () => null,
    onRetry: vi.fn(),
    ...over,
  };
  render(<Browse {...props} />);
  return props;
}

/** Like renderBrowse but returns the RenderResult (for container text assertions). */
function renderBrowseRaw(over: Partial<BrowseProps> = {}) {
  const props: BrowseProps = {
    c,
    loading: false,
    error: null,
    discover: [],
    myDrafts: [],
    myPublished: [],
    viewerId: 99,
    onSignIn: vi.fn(),
    onCreate: vi.fn(),
    onOpenPublished: vi.fn(),
    onOpenDraft: vi.fn(),
    onEditDraft: vi.fn(),
    onDeleteDraft: vi.fn(),
    onDeletePublished: vi.fn(),
    onVote: vi.fn(async () => 1),
    onFork: vi.fn(),
    onShare: vi.fn(async () => true),
    coverUrlFor: () => null,
    onRetry: vi.fn(),
    ...over,
  };
  return render(<Browse {...props} />);
}

describe('Browse — persistent anon sign-in (fix #2)', () => {
  it('shows a persistent "Sign in to build & run" header prompt for logged-out viewers', async () => {
    const onSignIn = vi.fn();
    renderBrowse({ viewerId: null, onSignIn });
    const signin = screen.getByTestId('header-signin');
    expect(signin).toHaveTextContent(/sign in to build/i);
    // It is NOT the reactive create button.
    expect(screen.queryByTestId('create-generator')).not.toBeInTheDocument();
    await userEvent.click(signin);
    expect(onSignIn).toHaveBeenCalled();
  });

  it('shows the Create button (not the sign-in prompt) for logged-in viewers', () => {
    renderBrowse({ viewerId: 99 });
    expect(screen.getByTestId('create-generator')).toBeInTheDocument();
    expect(screen.queryByTestId('header-signin')).not.toBeInTheDocument();
  });
});

describe('Browse — softened "one-tap" copy (fix #5)', () => {
  it('the header subtitle no longer overpromises "one-tap"', () => {
    const { container } = renderBrowseRaw();
    expect(container.textContent).not.toMatch(/one-tap/i);
    expect(screen.getByText(/one-click image generators/i)).toBeInTheDocument();
  });
});

describe('Browse — Discover cost signal (fix #3)', () => {
  it('surfaces an approximate "≈ N ⚡ per run" on each Discover card', () => {
    renderBrowse({ discover: [itemWithButtons('k1', 'Alpha')] });
    const card = screen.getByTestId('published-card');
    expect(within(card).getByTestId('published-cost')).toHaveTextContent(/≈ \d+ ⚡ per run/);
  });
});

describe('Browse — onboarding IntroPanel (fix #1)', () => {
  it('shows the concept panel on Discover and hides it after dismiss', async () => {
    renderBrowse();
    expect(screen.getByTestId('intro-panel')).toBeInTheDocument();
    // seeded examples are copy-able
    expect(screen.getAllByTestId('intro-example').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByTestId('intro-dismiss'));
    expect(screen.queryByTestId('intro-panel')).not.toBeInTheDocument();
  });

  it('"Make a copy" of a seeded example routes through onFork', async () => {
    const onFork = vi.fn();
    renderBrowse({ onFork });
    const first = screen.getAllByTestId('intro-example')[0];
    await userEvent.click(within(first).getByTestId('intro-example-copy'));
    expect(onFork).toHaveBeenCalledTimes(1);
  });

  it('suppresses the redundant plain empty-state while the intro is showing (no query)', () => {
    renderBrowse({ discover: [] });
    expect(screen.getByTestId('intro-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('discover-empty')).not.toBeInTheDocument();
  });

  it('shows the plain empty-state once the intro is dismissed', async () => {
    renderBrowse({ discover: [] });
    await userEvent.click(screen.getByTestId('intro-dismiss'));
    expect(screen.getByTestId('discover-empty')).toBeInTheDocument();
  });
});
