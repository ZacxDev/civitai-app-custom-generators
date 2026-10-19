// Card-level social + media behaviour (rendered directly against props):
// the downvote control (optimistic, mutually exclusive with the upvote,
// rollback on failure), the published-media strip, and the decluttered card
// actions (icon Share / Make a copy, "Generate" instead of "Open").

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Browse, type BrowseProps } from './Browse.js';
import { palette } from '../theme.js';
import type { SharedListItem } from '../platform/index.js';

const c = palette();

function item(key: string, title: string, count = 0, viewerVoted = false): SharedListItem {
  return {
    key,
    authorUserId: 7,
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
    onReport: vi.fn(async () => {}),
    coverUrlFor: () => null,
    onRetry: vi.fn(),
    ...over,
  };
  render(<Browse {...props} />);
  return props;
}

describe('Browse — downvote', () => {
  it('renders the seeded tally + pressed state, and toggling calls onDownvote(item, false)', async () => {
    const onDownvote = vi.fn(async () => 1);
    renderBrowse({
      discover: [item('k1', 'Alpha')],
      downvotes: { k1: { count: 2, downvoted: true } },
      onDownvote,
    });
    const card = screen.getByTestId('published-card');
    const btn = within(card).getByTestId('downvote-button');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(within(card).getByTestId('published-downvotes')).toHaveTextContent('2');

    await userEvent.click(btn);
    expect(onDownvote).toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }), false);
    await waitFor(() => expect(within(card).getByTestId('published-downvotes')).toHaveTextContent('1'));
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('rolls the optimistic downvote back when onDownvote rejects', async () => {
    const onDownvote = vi.fn(async () => {
      throw new Error('store unavailable');
    });
    renderBrowse({ discover: [item('k1', 'Alpha')], downvotes: {}, onDownvote });
    const card = screen.getByTestId('published-card');
    await userEvent.click(within(card).getByTestId('downvote-button'));
    await waitFor(() => expect(within(card).getByTestId('published-downvotes')).toHaveTextContent('0'));
    expect(within(card).getByTestId('downvote-button')).toHaveAttribute('aria-pressed', 'false');
  });

  it('🔴 one vote per direction: downvoting a generator the viewer upvoted clears the upvote first', async () => {
    const onVote = vi.fn(async () => 4);
    const onDownvote = vi.fn(async () => 1);
    renderBrowse({ discover: [item('k1', 'Alpha', 5, true)], onVote, onDownvote, downvotes: {} });
    const card = screen.getByTestId('published-card');
    await userEvent.click(within(card).getByTestId('downvote-button'));
    expect(onVote).toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }), false);
    expect(onDownvote).toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }), true);
    await waitFor(() => expect(within(card).getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'false'));
  });

  it('🔴 and upvoting a downvoted generator clears the downvote first', async () => {
    const onVote = vi.fn(async () => 1);
    const onDownvote = vi.fn(async () => 0);
    renderBrowse({
      discover: [item('k1', 'Alpha')],
      onVote,
      onDownvote,
      downvotes: { k1: { count: 1, downvoted: true } },
    });
    const card = screen.getByTestId('published-card');
    await userEvent.click(within(card).getByTestId('vote-button'));
    expect(onDownvote).toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }), false);
    expect(onVote).toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }), true);
  });

  it('renders no downvote control when no handler is wired', () => {
    renderBrowse({ discover: [item('k1', 'Alpha')] });
    expect(within(screen.getByTestId('published-card')).queryByTestId('downvote-button')).not.toBeInTheDocument();
  });
});

describe('Browse — published media on cards', () => {
  it('shows the published-output strip when the generator has media and no cover', () => {
    renderBrowse({
      discover: [item('k1', 'Alpha')],
      mediaUrlsFor: () => ['https://img.example/a.png', 'https://img.example/b.png'],
    });
    const card = screen.getByTestId('published-card');
    const strip = within(card).getByTestId('published-media');
    expect(strip.querySelectorAll('img')).toHaveLength(2);
  });

  it('a cover wins over the strip — never both', () => {
    renderBrowse({
      discover: [item('k1', 'Alpha')],
      coverUrlFor: () => 'https://img.example/cover.png',
      mediaUrlsFor: () => ['https://img.example/a.png'],
    });
    const card = screen.getByTestId('published-card');
    expect(within(card).getByTestId('published-cover')).toBeInTheDocument();
    expect(within(card).queryByTestId('published-media')).not.toBeInTheDocument();
  });

  it('no media and no cover renders neither', () => {
    renderBrowse({ discover: [item('k1', 'Alpha')], mediaUrlsFor: () => [] });
    const card = screen.getByTestId('published-card');
    expect(within(card).queryByTestId('published-media')).not.toBeInTheDocument();
    expect(within(card).queryByTestId('published-cover')).not.toBeInTheDocument();
  });
});

describe('Browse — card actions', () => {
  it('the run action reads "Generate"', () => {
    renderBrowse({ discover: [item('k1', 'Alpha')] });
    expect(within(screen.getByTestId('published-card')).getByTestId('published-open')).toHaveTextContent('Generate');
  });

  it('Share and Make a copy are icon buttons with accessible names, not text buttons', () => {
    renderBrowse({ discover: [item('k1', 'Alpha')] });
    const card = screen.getByTestId('published-card');
    const share = within(card).getByTestId('published-share');
    const fork = within(card).getByTestId('published-fork');
    expect(share).toHaveAttribute('aria-label', 'Share');
    expect(fork).toHaveAttribute('aria-label', 'Make a copy');
    expect(share.textContent?.trim()).toBe('');
    expect(fork.textContent?.trim()).toBe('');
    expect(share.querySelector('svg')).not.toBeNull();
    expect(fork.querySelector('svg')).not.toBeNull();
  });
});
