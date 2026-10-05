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
//     "no drafts" over a failed read, trading a visible error for a false claim;
//   - and the confined failure stays ATTRIBUTABLE: it warns with its reason, and
//     a SUCCESSFUL read does not warn. Both directions, because confining a
//     failure is exactly what removes it from the screen — so the console line is
//     the only remaining signal, and a warn that fired on success would be a false
//     one.
//
// ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT ASSERT. Confining the `mine` failure
// means the "Published by me" panel renders its empty state over a failed read,
// and that empty state says *"Nothing published yet"* — a positive claim about
// the viewer's data, made where the app does not know it. That is an OPEN defect
// and it was deliberately left open here, which is why no case below asserts
// anything about that panel's copy: a test pinning the current wording would make
// the falsehood harder to fix, not easier. It is named at THREE sites, so the next
// reader finds it from the code rather than from a tracker: in
// `components/Browse.tsx` beside the empty state, in that file's `myPublished`
// PROP docblock (which is where a `publishedError` prop would be added), and in
// the `myPublished` state docblock in `App.tsx`.
// ⚠️ Note what IS asserted, so this paragraph is not read too widely: the two
// cases below pin the console warn on a failed read and its absence on a
// successful one. That is the DEVELOPER surface, not the panel's copy — asserting
// it does not pin the wording this paragraph is about.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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

  // Confining the rejection is what makes it invisible: the panel says "Nothing
  // published yet" and, without this warn, nothing anywhere records that a read
  // failed. This pins the ONE remaining signal. It asserts the REASON is passed
  // through, not just that something was logged — a warn that drops the reason
  // names no cause and is the same dead end as no warn at all.
  it('a REJECTED my-published read is still attributable — it warns with the reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const shared = setup({ failShared: 'mine' });
      await screen.findByTestId('discover-list');
      await waitFor(() => expect(shared.listCalls.length).toBe(2));

      // The fake throws `new Error(LIST_FAILURE)`, so the reason is an Error —
      // asserting against the bare string would compare an Error to a string and
      // be false for the right code. Read `.message`.
      await waitFor(() =>
        expect(
          warn.mock.calls.some(
            (args: unknown[]) =>
              typeof args[0] === 'string' &&
              args[0].includes('my-published read failed') &&
              args[1] instanceof Error &&
              args[1].message === LIST_FAILURE,
          ),
        ).toBe(true),
      );
    } finally {
      warn.mockRestore();
    }
  });

  // 🔴 THE OTHER HALF, AND WITHOUT IT THE GUARD ABOVE IS ONE-SIDED. A mutant that
  // drops the `if (… === 'rejected')` branch and warns UNCONDITIONALLY satisfies
  // the case above and SURVIVES the whole suite — it would log
  // "my-published read failed undefined" into every viewer's console on every
  // successful Browse load. Measured: that mutant passed 509/509 before this case
  // existed. A warn is a developer surface, so a false one costs the next person
  // debugging this panel their starting assumption.
  it('a SUCCESSFUL my-published read does not warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const shared = setup();
      await screen.findByTestId('discover-list');
      // Precondition: the `mine` read really was issued and really did resolve —
      // otherwise this passes against an app that never asked, which is the
      // vacuous way to be silent.
      await waitFor(() => expect(shared.listCalls.length).toBe(2));
      expect(shared.listCalls.some((c) => c.mine === true)).toBe(true);
      // ...and it RESOLVED: a rejection would surface no view-level error (that is
      // the whole point of confining it), so the discriminator is that the load
      // completed without one while both reads were issued.
      // 🔴 NOT `published-empty` — that node lives in the Mine panel and the
      // default tab is Discover, so asserting it here fails for a reason that has
      // nothing to do with warning. Cost me one red run.
      expect(screen.queryByTestId('browse-error')).toBeNull();

      expect(
        warn.mock.calls.filter(
          (args: unknown[]) =>
            typeof args[0] === 'string' && args[0].includes('my-published read failed'),
        ),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
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
