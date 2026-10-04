// 🔴 ONE FAILING READ MUST NOT BLANK THE WHOLE BOARD.
//
// `App`'s Browse load effect issues three reads at once — the board page, the
// viewer's own `mine: true` page, and the viewer's drafts. They were awaited with
// `Promise.all`, so the setters after the await ran only if ALL THREE resolved: a
// rejection of any one of them left `shared` at its `[]` initial value and emptied
// every panel in the view at once. Measured by replacing the `mine` read with a
// rejection on `5c566a9`: 48 tests across 8 files went red — Discover list, cover
// grid, deeplink open, share, fork, report, gallery, and both e2e loops.
//
// The two panels answer SEPARATE QUESTIONS out of SEPARATE REQUESTS ("a page of
// the board" versus "everything you published"), so one failing is not evidence
// about the other, and rendering neither is a wrong answer about both. This file
// pins the split:
//
//   - a rejected `mine` read is CONFINED: Discover and Drafts still render their
//     data, and no view-level error appears;
//   - a rejected BOARD read is still FATAL: the board is the view, so `error` +
//     Retry is the honest answer rather than a blank page. Same for the drafts
//     read, which has no failure state of its own either — confining it would put
//     "no drafts" over a failed read, trading a visible error for a false claim.
//
// ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT ASSERT. Confining the `mine` failure
// means the "Published by me" panel renders its empty state over a failed read,
// and that empty state says *"Nothing published yet"* — a positive claim about
// the viewer's data, made where the app does not know it. That is an OPEN defect
// and it was deliberately left open here, which is why no case below asserts
// anything about that panel's copy: a test pinning the current wording would make
// the falsehood harder to fix, not easier. It is named in `components/Browse.tsx`
// beside the empty state, and in the `myPublished` docblock in `App.tsx`, so the
// next reader finds it from the code rather than from a tracker.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Harness } from './platform/testing.js';

import { App, type AppDeps } from './App.js';
import { fakeShared, memoryDraftStore, mockWorkflow } from './test-helpers.js';
import { draftKey } from './lib/drafts.js';
import type { DraftStore, StoredDraft } from './lib/drafts.js';
import type { SharedListItem } from './platform/index.js';
import type { GeneratorData } from './types.js';

const VIEWER_ID = 99;

/** A board row by SOMEONE ELSE, so it can only reach the screen via the board read. */
const BOARD_TITLE = 'A board row from the server';
/** A row the VIEWER authored, reachable only via the `mine: true` read. */
const MINE_TITLE = 'A row I published myself';
const DRAFT_TITLE = 'An unpublished draft of mine';
/** The rejection message the fake throws — distinctive, so a matching alert is attributable. */
const LIST_FAILURE = 'shared list unavailable (test)';

function item(key: string, title: string, authorUserId: number): SharedListItem {
  return {
    key,
    authorUserId,
    value: { title, body: 'a desc', data: { v: 1, buttons: [] } as GeneratorData },
    count: 0,
    viewerVoted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const SEED: SharedListItem[] = [
  item('board-1', BOARD_TITLE, 7),
  item('mine-1', MINE_TITLE, VIEWER_ID),
];

function draft(): StoredDraft {
  return {
    id: 'd1',
    config: { name: DRAFT_TITLE, description: '', buttons: [] },
    updatedAt: 1,
  };
}

/**
 * A draft store seeded with one draft, with an optional rejecting `list`.
 *
 * 🔴 SEEDED THROUGH `set` AND READ BACK THROUGH THE REAL `listDrafts`, so the
 * "drafts still render" case below is a claim about the load path rather than
 * about a hand-built prop. `failList` wraps the SAME store so the failing and
 * succeeding arms differ in exactly one behaviour.
 */
function draftStore(failList = false): DraftStore {
  const store = memoryDraftStore();
  void store.set(draftKey(draft().id), draft());
  if (!failList) return store;
  return {
    ...store,
    async list() {
      throw new Error(LIST_FAILURE);
    },
  };
}

interface SetupOpts {
  /** Which `shared.list` reads reject (none, by default). */
  failShared?: 'all' | 'mine';
  /** Make the DRAFTS read reject. */
  failDrafts?: boolean;
}

function setup({ failShared, failDrafts = false }: SetupOpts = {}) {
  const shared = fakeShared(SEED, {
    viewerId: VIEWER_ID,
    ...(failShared ? { failList: LIST_FAILURE, failListScope: failShared } : {}),
  });
  const wf = mockWorkflow();
  const deps: Partial<AppDeps> = {
    resolveResources: async () => [],
    shared: shared.shared,
    updateSharedGenerator: shared.update,
    drafts: draftStore(failDrafts),
    estimate: wf.estimate,
    submit: wf.submit,
    poll: wf.poll,
    // The seed is two rows; keep the horizon above it so no case below is
    // accidentally also exercising the truncation disclosure.
    discoverPageLimit: 10,
  };
  render(
    <Harness viewer={{ id: VIEWER_ID, username: 'me' }} theme="dark" consentGranted showLog={false}>
      <App deps={deps} />
    </Harness>,
  );
  return shared;
}

describe('App — Browse load, a failing read is confined to the panel that failed', () => {
  it('🔴 a REJECTED my-published read still leaves Discover rendering the board', async () => {
    const shared = setup({ failShared: 'mine' });

    const discover = await screen.findByTestId('discover-list');
    await waitFor(() => expect(discover.textContent).toContain(BOARD_TITLE));

    // Precondition, asserted rather than assumed: the `mine` read really was
    // issued and really did reject. Without this the case could pass against an
    // app that stopped asking for the viewer's rows at all.
    await waitFor(() => expect(shared.listCalls.length).toBe(2));
    expect(shared.listCalls.some((c) => c.mine === true)).toBe(true);

    // 🔴 AND NO VIEW-LEVEL ERROR. The failure belongs to one panel; surfacing it
    // across the whole view is the behaviour this fix removes.
    expect(screen.queryByTestId('browse-error')).toBeNull();
  });

  it('🔴 ...and still leaves the viewer’s DRAFTS rendering, out of the same effect', async () => {
    setup({ failShared: 'mine' });
    await screen.findByTestId('discover-list');

    await userEvent.click(screen.getByTestId('tab-mine'));
    const mine = await screen.findByTestId('mine-list');
    await waitFor(() => expect(mine.textContent).toContain(DRAFT_TITLE));
    expect(screen.getAllByTestId('draft-card').length).toBe(1);
  });

  /**
   * INVARIANT GUARD, not regression coverage: this passes on `5c566a9` too, where
   * `Promise.all` propagated the rejection by construction. It is here because the
   * fix replaced that propagation with an explicit re-throw per read, and an
   * explicit branch can be deleted — which `Promise.all` could not be.
   */
  it('a rejected BOARD read is still FATAL — the view says so and offers Retry', async () => {
    setup({ failShared: 'all' });

    const alert = await screen.findByTestId('browse-error');
    expect(alert.textContent).toContain(LIST_FAILURE);
    expect(screen.getByTestId('browse-retry')).toBeTruthy();
    // The board did not render behind the error.
    expect(screen.getByTestId('discover-list').textContent).not.toContain(BOARD_TITLE);
  });

  /** INVARIANT GUARD, same reasoning as the case above — the drafts arm of it. */
  it('a rejected DRAFTS read is still FATAL — the view says so and offers Retry', async () => {
    setup({ failDrafts: true });

    const alert = await screen.findByTestId('browse-error');
    expect(alert.textContent).toContain(LIST_FAILURE);
    expect(screen.getByTestId('browse-retry')).toBeTruthy();
    expect(screen.getByTestId('discover-list').textContent).not.toContain(BOARD_TITLE);
  });
});
