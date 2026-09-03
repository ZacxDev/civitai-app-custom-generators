// 🔴 "Top" is a ranking over ONE PAGE, and the app must say so when there is
// more board than page.
//
// `App` reads `shared.list({ limit: 50 })` — a single page, no cursor loop —
// and Browse then sorts that page by vote count for the "Top" tab and filters
// it for search. There is no server-side sort (`list` is newest-first and takes
// no rank parameter), so both operations are honest only to the depth read:
//
//   - "Top" over the 50 NEWEST is not the top of the board. A generator with
//     more votes than anything on screen sits at row 51 and can never appear,
//     and nothing about the UI suggests the order is partial.
//   - Search is worse in kind: a query that misses row 51 renders as "no such
//     generator exists", which is a wrong answer rather than a short one.
//
// "Newest" is deliberately NOT covered. Showing the 50 newest under a control
// labelled "Newest" is exactly what it claims, so a notice there would be noise.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import type { SharedListItem } from '@civitai/blocks-react';

import { App, type AppDeps } from '../App.js';
import { fakeShared, memoryDraftStore, mockWorkflow } from '../test-helpers.js';
import type { GeneratorData } from '../types.js';

const VIEWER_ID = 99;

function item(key: string, title: string, count: number): SharedListItem {
  return {
    key,
    authorUserId: 7,
    value: { title, body: 'a desc', data: { v: 1, buttons: [] } as GeneratorData },
    count,
    viewerVoted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function setup(hasMore: boolean) {
  const shared = fakeShared([item('a', 'Alpha gen', 5), item('b', 'Beta gen', 2)], { hasMore });
  const wf = mockWorkflow();
  const deps: Partial<AppDeps> = {
    resolveResources: async () => [],
    shared: shared.shared,
    updateSharedGenerator: shared.update,
    drafts: memoryDraftStore(),
    estimate: wf.estimate,
    submit: wf.submit,
    poll: wf.poll,
  };
  render(
    <Harness viewer={{ id: VIEWER_ID, username: 'me' }} theme="dark" consentGranted showLog={false}>
      <App deps={deps} />
    </Harness>,
  );
  return shared;
}

/** The sort renders as a radiogroup (measured on the live app), and its options
 *  carry no testid of their own — SegmentedControl gives an author no attribute
 *  hook on the option button. Select by accessible name. */
const popular = () => screen.getByRole('radio', { name: 'Popular' });

const NOTICE = 'discover-partial-notice';

/** 🔴 Pinned WHOLE, per branch. The first version of this file asserted only
 *  /loaded so far/i — a fragment EVERY branch contains — so an audit showed both
 *  messages could be replaced with arbitrary text, and could be SWAPPED with each
 *  other, while the suite stayed green. That is exactly why the wrong-priority
 *  bug below was invisible to it. */
const COPY = {
  searchAndTop: 'Searching and ranking only the generators loaded so far, not the whole catalog.',
  search: 'Searching the generators loaded so far, not the whole catalog.',
  top: 'Ordered by votes across the generators loaded so far, not the whole catalog.',
  endOfList: 'Showing the generators loaded so far — the catalog has more.',
} as const;

const notice = () => screen.getByTestId(NOTICE).textContent;

describe('partial-ranking disclosure', () => {
  it('🔴 says so when TOP ranks over a page that is not the whole board', async () => {
    setup(true);
    await screen.findByTestId('discover-list');

    await userEvent.click(popular());
    await waitFor(() => expect(notice()).toBe(COPY.top));
  });

  it('🔴 says so when a SEARCH filters a page that is not the whole board', async () => {
    setup(true);
    await screen.findByTestId('discover-list');

    await userEvent.type(screen.getByTestId('discover-search'), 'Alpha');
    await waitFor(() => expect(notice()).toBe(COPY.search));
  });

  it('🔴 SEARCH wording wins when both apply — it is the worse failure', async () => {
    // The audited bug: with Popular active AND a query, the app disclosed only
    // the ORDERING caveat while the search was returning "No matches" for a
    // catalog it had not read. The app's own reasoning ranks the search failure
    // worse, so the copy must cover it.
    setup(true);
    await screen.findByTestId('discover-list');

    await userEvent.click(popular());
    await userEvent.type(screen.getByTestId('discover-search'), 'Alpha');
    await waitFor(() => expect(notice()).toBe(COPY.searchAndTop));
  });

  it('🔴 renders ALONGSIDE the "No matches" empty state, not instead of it', async () => {
    // The state a user actually hits: a query that matches nothing on a
    // truncated page. Without the notice, "No matches" is an authoritative
    // wrong answer.
    setup(true);
    await screen.findByTestId('discover-list');

    await userEvent.type(screen.getByTestId('discover-search'), 'zzzznomatch');
    expect(await screen.findByTestId('discover-empty')).toBeTruthy();
    expect(notice()).toBe(COPY.search);
  });

  it('🔴 says so on NEWEST once every loaded row is shown — the end-of-list lie', async () => {
    // Reaching the end of the loaded rows with no "Show more" reads as the end
    // of the catalog. That is the one way the Newest tab, which is otherwise
    // truthful as labelled, still asserts something false.
    setup(true);
    await screen.findByTestId('discover-list');

    await waitFor(() => expect(notice()).toBe(COPY.endOfList));
  });

  it('stays silent when the page IS the whole board (negative control)', async () => {
    setup(false);
    await screen.findByTestId('discover-list');
    expect(screen.queryByTestId(NOTICE)).toBeNull();

    await userEvent.click(popular());
    await waitFor(() => expect(popular()).toBeChecked());
    expect(screen.queryByTestId(NOTICE)).toBeNull();

    await userEvent.type(screen.getByTestId('discover-search'), 'Alpha');
    await waitFor(() => expect(screen.getByTestId('discover-search')).toHaveValue('Alpha'));
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('🔴 the four messages are DISTINCT — a swap must not pass', () => {
    // Pinning each branch is only worth anything if the branches differ; two
    // identical strings would make a swap invisible again.
    const all = Object.values(COPY);
    expect(new Set(all).size).toBe(all.length);
  });
});
