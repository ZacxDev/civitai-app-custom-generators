// Presentational Browse features (rendered directly against props): voting
// (optimistic + rollback), sort-by-popularity, search, pagination, and the
// tablist a11y (roving tabindex + arrow-key navigation).

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Browse, type BrowseProps } from './Browse.js';
import { palette } from '../theme.js';
import type { SharedListItem } from '@civitai/blocks-react';

const c = palette();

function item(key: string, title: string, count = 0, authorUserId = 7, viewerVoted = false): SharedListItem {
  return {
    key,
    authorUserId,
    value: { title, body: `${title} description`, data: { v: 1, buttons: [] } },
    count,
    viewerVoted,
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
    discoverTruncated: false,
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

describe('Browse — vote state hydrates from the host (`viewerVoted`)', () => {
  it('a row the viewer ALREADY up-voted renders pressed, and one click UNVOTES it', async () => {
    // `viewerVoted` is required on `SharedListItem` since @civitai/blocks-react
    // 0.29. Before it was read, an already-voted row rendered un-voted, so the
    // first click sent a duplicate VOTE and unvoting took two clicks.
    const onVote = vi.fn(async () => 6);
    renderBrowse({ discover: [item('k1', 'Alpha', 7, 7, true)], onVote });

    const card = screen.getByTestId('published-card');
    expect(within(card).getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(within(card).getByTestId('vote-button'));
    // ONE click, and it is an UNVOTE (`false`), not a duplicate vote.
    expect(onVote).toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }), false);
    await waitFor(() => expect(within(card).getByTestId('published-votes')).toHaveTextContent('6'));
    expect(within(card).getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'false');
  });

  it('a row the viewer has NOT voted on still renders un-pressed', () => {
    renderBrowse({ discover: [item('k1', 'Alpha', 7, 7, false)] });
    const card = screen.getByTestId('published-card');
    expect(within(card).getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('Browse — voting (optimistic + rollback)', () => {
  it('optimistically increments the count and calls onVote(item, true)', async () => {
    let resolve!: (n: number) => void;
    const onVote = vi.fn(() => new Promise<number>((r) => { resolve = r; }));
    renderBrowse({ discover: [item('k1', 'Alpha', 3)], onVote });

    const card = screen.getByTestId('published-card');
    expect(within(card).getByTestId('published-votes')).toHaveTextContent('3');
    await userEvent.click(within(card).getByTestId('vote-button'));

    // optimistic: 3 → 4 immediately, before the host resolves
    expect(within(card).getByTestId('published-votes')).toHaveTextContent('4');
    expect(onVote).toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }), true);
    expect(within(card).getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'true');

    // authoritative count from the host wins
    resolve(9);
    await waitFor(() => expect(within(card).getByTestId('published-votes')).toHaveTextContent('9'));
  });

  it('rolls back the optimistic increment when onVote rejects', async () => {
    const onVote = vi.fn(async () => { throw new Error('host down'); });
    renderBrowse({ discover: [item('k1', 'Alpha', 3)], onVote });
    const card = screen.getByTestId('published-card');
    await userEvent.click(within(card).getByTestId('vote-button'));
    await waitFor(() => expect(within(card).getByTestId('published-votes')).toHaveTextContent('3'));
    expect(within(card).getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'false');
  });

  it('a second click unvotes (decrements + calls onVote(item, false))', async () => {
    const onVote = vi.fn(async (_i, voted: boolean) => (voted ? 4 : 3));
    renderBrowse({ discover: [item('k1', 'Alpha', 3)], onVote });
    const card = screen.getByTestId('published-card');
    await userEvent.click(within(card).getByTestId('vote-button')); // vote
    await waitFor(() => expect(within(card).getByTestId('published-votes')).toHaveTextContent('4'));
    await userEvent.click(within(card).getByTestId('vote-button')); // unvote
    expect(onVote).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'k1' }), false);
    await waitFor(() => expect(within(card).getByTestId('published-votes')).toHaveTextContent('3'));
  });

  it('rapid vote→unvote stays server-authoritative even when the votes resolve OUT OF ORDER', async () => {
    // Capture each call's resolver so the test can settle them in reverse order.
    const settlers: Array<{ voted: boolean; resolve: (n: number) => void }> = [];
    const onVote = vi.fn(
      (_i: unknown, voted: boolean) => new Promise<number>((resolve) => settlers.push({ voted, resolve })),
    );
    renderBrowse({ discover: [item('k1', 'Alpha', 3)], onVote });
    const card = screen.getByTestId('published-card');
    const btn = within(card).getByTestId('vote-button');

    await userEvent.click(btn); // click 1: vote   → optimistic 4, seq 1
    await userEvent.click(btn); // click 2: unvote → optimistic 3, seq 2
    expect(settlers).toHaveLength(2);
    expect(settlers[0].voted).toBe(true);
    expect(settlers[1].voted).toBe(false);

    // Resolve OUT OF ORDER: the newest (unvote) first with authoritative 3, then
    // the stale vote with 4 — which must be IGNORED (no double-count / no revert).
    settlers[1].resolve(3);
    settlers[0].resolve(4);

    await waitFor(() => expect(within(card).getByTestId('published-votes')).toHaveTextContent('3'));
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('anonymous viewer: a vote click does NOT optimistically flash — it defers to onVote (sign-in)', async () => {
    const onVote = vi.fn(async () => 0);
    renderBrowse({ viewerId: null, discover: [item('k1', 'Alpha', 3)], onVote });
    const card = screen.getByTestId('published-card');
    await userEvent.click(within(card).getByTestId('vote-button'));
    // no optimistic increment — count stays 3, aria-pressed stays false
    expect(within(card).getByTestId('published-votes')).toHaveTextContent('3');
    expect(within(card).getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'false');
    expect(onVote).toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }), true);
  });
});

describe('Browse — sort by popularity', () => {
  it('reorders Discover by vote count when Popular is selected', async () => {
    renderBrowse({ discover: [item('low', 'Low', 1), item('high', 'High', 50)] });
    // default (Newest) preserves the given order
    let cards = screen.getAllByTestId('published-card');
    expect(cards[0]).toHaveAttribute('data-key', 'low');

    await userEvent.click(within(screen.getByTestId('discover-sort')).getByText('Popular'));
    cards = screen.getAllByTestId('published-card');
    expect(cards[0]).toHaveAttribute('data-key', 'high'); // 50 first
    expect(cards[1]).toHaveAttribute('data-key', 'low');
  });
});

describe('Browse — search', () => {
  it('filters Discover by title/description (case-insensitive)', async () => {
    renderBrowse({ discover: [item('a', 'Neon City'), item('b', 'Forest Path')] });
    await userEvent.type(screen.getByTestId('discover-search'), 'neon');
    const cards = screen.getAllByTestId('published-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('Neon City');
  });

  it('shows a "no match" empty state for a non-matching query', async () => {
    renderBrowse({ discover: [item('a', 'Neon City')] });
    await userEvent.type(screen.getByTestId('discover-search'), 'zzz');
    expect(screen.getByTestId('discover-empty')).toHaveTextContent(/no generators match/i);
  });
});

describe('Browse — pagination', () => {
  it('pages Discover with Show more (12 per page)', async () => {
    const many = Array.from({ length: 15 }, (_, i) => item(`k${i}`, `Gen ${i}`));
    renderBrowse({ discover: many });
    expect(screen.getAllByTestId('published-card')).toHaveLength(12);
    await userEvent.click(screen.getByTestId('discover-show-more'));
    expect(screen.getAllByTestId('published-card')).toHaveLength(15);
    expect(screen.queryByTestId('discover-show-more')).not.toBeInTheDocument();
  });

  it('pages Drafts with Show more', async () => {
    const drafts = Array.from({ length: 14 }, (_, i) => ({
      id: `d${i}`,
      config: { name: `Draft ${i}`, description: '', buttons: [] },
      updatedAt: i,
    }));
    renderBrowse({ myDrafts: drafts });
    await userEvent.click(screen.getByTestId('tab-mine'));
    expect(screen.getAllByTestId('draft-card')).toHaveLength(12);
    await userEvent.click(screen.getByTestId('drafts-show-more'));
    expect(screen.getAllByTestId('draft-card')).toHaveLength(14);
  });
});

describe('Browse — tablist a11y (roving tabindex + arrow keys)', () => {
  it('uses roving tabindex and moves selection with ArrowRight/ArrowLeft', async () => {
    renderBrowse({ discover: [item('a', 'Alpha')] });
    const discoverTab = screen.getByTestId('tab-discover');
    const mineTab = screen.getByTestId('tab-mine');

    // roving tabindex: selected=0, other=-1; panels are labelled by their tab
    expect(discoverTab).toHaveAttribute('aria-selected', 'true');
    expect(discoverTab).toHaveAttribute('tabindex', '0');
    expect(mineTab).toHaveAttribute('tabindex', '-1');
    expect(discoverTab).toHaveAttribute('aria-controls', 'panel-discover');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-discover');

    discoverTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(mineTab).toHaveAttribute('aria-selected', 'true');
    expect(mineTab).toHaveAttribute('tabindex', '0');
    expect(discoverTab).toHaveAttribute('tabindex', '-1');

    await userEvent.keyboard('{ArrowLeft}');
    expect(discoverTab).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Browse — fork + share affordances', () => {
  it('offers Make a copy on discover cards and calls onFork', async () => {
    const onFork = vi.fn();
    renderBrowse({ discover: [item('k1', 'Alpha')], onFork });
    await userEvent.click(within(screen.getByTestId('published-card')).getByTestId('published-fork'));
    expect(onFork).toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }));
  });

  it('copies a share link and raises a toast confirmation', async () => {
    const onShare = vi.fn(async () => true);
    renderBrowse({ discover: [item('k1', 'Alpha')], onShare });
    await userEvent.click(within(screen.getByTestId('published-card')).getByTestId('published-share'));
    expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }));
    // The design-system Toast (portaled to document.body) confirms the copy.
    expect(await screen.findByText('Link copied to clipboard')).toBeInTheDocument();
  });

  it('describes the vote and fork controls with design-system Tooltips (aria-describedby)', () => {
    renderBrowse({ discover: [item('k1', 'Alpha')], onFork: vi.fn() });
    const card = screen.getByTestId('published-card');

    // The Tooltip wires each trigger's aria-describedby to a role="tooltip" bubble
    // carrying the supplementary label — proving the pack primitive is adopted.
    const vote = within(card).getByTestId('vote-button');
    const voteTipId = vote.getAttribute('aria-describedby');
    expect(voteTipId).toBeTruthy();
    expect(document.getElementById(voteTipId!)).toHaveAttribute('role', 'tooltip');
    expect(document.getElementById(voteTipId!)).toHaveTextContent('Upvote this generator');

    const fork = within(card).getByTestId('published-fork');
    const forkTipId = fork.getAttribute('aria-describedby');
    expect(forkTipId).toBeTruthy();
    expect(document.getElementById(forkTipId!)).toHaveTextContent('Fork into your own editable draft');
  });
});
