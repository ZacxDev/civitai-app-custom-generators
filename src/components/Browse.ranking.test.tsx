// 🔴 "Top" is a ranking over ONE PAGE, and the app must say so when there is
// more board than page.
//
// `App` reads ONE page — `shared.list({ limit: DISCOVER_LIST_LIMIT + 1 })`, the
// extra row being how it learns whether a row exists past the horizon — and
// Browse then sorts the rendered 50 by vote count for the "Top" tab and filters
// them for search. There is no server-side sort (`list` is newest-first and
// takes no rank parameter), so both operations are honest only to the depth
// read:
//
//   - "Top" over the 50 NEWEST is not the top of the board. A generator with
//     more votes than anything on screen sits at row 51 and can never appear,
//     and nothing about the UI suggests the order is partial.
//   - Search is worse in kind: a query that misses row 51 renders as "no such
//     generator exists", which is a wrong answer rather than a short one.
//
// 🔴 "Newest" IS covered, and an earlier version of this header said the
// opposite. Its ORDERING is truthful as labelled — the 50 newest under a control
// called "Newest" is exactly what it claims — but its END OF LIST is not: with
// every loaded row on screen and no "Show more", the absent button reads as the
// end of the catalog. That is the one false claim the tab still makes, so the
// notice covers it there too.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import type { SharedListItem } from '@civitai/blocks-react';

import { App, DISCOVER_LIST_LIMIT, type AppDeps } from '../App.js';
// 🔴 The REAL constant, not a copy. Duplicating it let the boundary case drift
// off the boundary and keep passing — measured, a `<=` -> `<` mutant then
// survived a green file.
import { PAGE_SIZE } from './Browse.js';
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

/** 🔴 PAGE_SIZE is 12 (Browse.tsx). A fixture with fewer rows than that makes
 *  `allLoadedShown` a CONSTANT TRUE, which collapses the render guard to
 *  `discoverTruncated && true` — and an audit measured exactly that: deleting
 *  either arm of the disjunction, or the whole disjunction, SURVIVED a green
 *  suite. `rows` exists so the not-yet-paged-to-the-end state is constructible. */
function manyItems(n: number) {
  // Descending vote counts so "Popular" order is deterministic and distinct
  // from insertion order.
  return Array.from({ length: n }, (_, i) => item(`k${i}`, `Gen ${i}`, n - i));
}

/**
 * 🔴 A TRUNCATED BOARD IS NOW A PROPERTY OF THE STORE, NOT A FLAG. `App` reads
 * `DISCOVER_LIST_LIMIT + 1` rows and sets `discoverTruncated` from the ROW COUNT
 * it got back, because a cursor is emitted iff the page filled and therefore
 * cannot tell "exactly 50 rows" from "more than 50" (see `App.tsx`). So
 * `fakeShared` no longer takes a `hasMore` boolean and none can be
 * reintroduced: to make the board truncated, the store has to actually hold a
 * row past the horizon.
 *
 * `discoverPageLimit` shrinks that horizon to the fixture's own size so every
 * `it()` below still renders exactly the rows it was written for. Without it a
 * truncated board always loads exactly 50 rows, and `PAGE_SIZE` (12) does not
 * divide 50 — which would put `allLoadedShown` permanently off its `<=`
 * boundary and silently retire the mutant the last case in this file exists to
 * kill.
 */
function withHorizon(base: SharedListItem[], hasMore: boolean) {
  const pageLimit = Math.max(1, base.length);
  if (!hasMore) return { rows: base, pageLimit };
  // Exactly enough rows past the horizon for the over-fetch to see one. They sit
  // at the END of the store, so `slice(0, pageLimit)` renders `base` verbatim.
  const extra = pageLimit + 1 - base.length;
  return {
    rows: [...base, ...Array.from({ length: extra }, (_, i) => item(`overflow-${i}`, `Past the horizon ${i}`, 0))],
    pageLimit,
  };
}

function setup(hasMore: boolean, rows?: SharedListItem[]) {
  const { rows: seed, pageLimit } = withHorizon(
    rows ?? [item('a', 'Alpha gen', 5), item('b', 'Beta gen', 2)],
    hasMore,
  );
  const shared = fakeShared(seed);
  const wf = mockWorkflow();
  const deps: Partial<AppDeps> = {
    resolveResources: async () => [],
    shared: shared.shared,
    updateSharedGenerator: shared.update,
    drafts: memoryDraftStore(),
    estimate: wf.estimate,
    submit: wf.submit,
    poll: wf.poll,
    discoverPageLimit: pageLimit,
  };
  render(
    <Harness viewer={{ id: VIEWER_ID, username: 'me' }} theme="dark" consentGranted showLog={false}>
      <App deps={deps} />
    </Harness>,
  );
  return shared;
}

/** Same harness, no viewer — `null` is the anon path; `undefined` would give the
 *  mock host's default dev-viewer and silently make this a signed-IN case. */
function setupAnon(hasMore: boolean, rows?: SharedListItem[]) {
  const { rows: seed, pageLimit } = withHorizon(rows ?? [], hasMore);
  const shared = fakeShared(seed);
  const wf = mockWorkflow();
  render(
    <Harness viewer={null} theme="dark" consentGranted showLog={false}>
      <App
        deps={{
          resolveResources: async () => [],
          shared: shared.shared,
          updateSharedGenerator: shared.update,
          drafts: memoryDraftStore(),
          estimate: wf.estimate,
          submit: wf.submit,
          poll: wf.poll,
          discoverPageLimit: pageLimit,
        }}
      />
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

  describe('with MORE loaded rows than fit on screen (the guard is not constant here)', () => {
    // 15 rows against PAGE_SIZE 12 → 12 visible, `allLoadedShown` FALSE. This is
    // the state the feature exists for, and the one no earlier fixture built.
    const ROWS = 15;

    it('🔴 stays SILENT on Newest until the viewer pages to the end', async () => {
      setup(true, manyItems(ROWS));
      await screen.findByTestId('discover-list');

      // Not yet at the end: Newest makes no false end-of-list claim, so nothing
      // to disclose. This is what pins the `allLoadedShown` arm — a mutant that
      // hardcodes it true fires the notice here.
      expect(screen.queryByTestId(NOTICE)).toBeNull();
      expect(screen.getByTestId('discover-show-more')).toBeTruthy();

      await userEvent.click(screen.getByTestId('discover-show-more'));
      await waitFor(() => expect(screen.queryByTestId('discover-show-more')).toBeNull());
      expect(notice()).toBe(COPY.endOfList);
    });

    it('🔴 the POPULAR arm fires while rows are still unpaged', async () => {
      // `allLoadedShown` is false here, so only the `sort === 'top'` arm can be
      // producing this notice. Deleting that arm used to survive.
      setup(true, manyItems(ROWS));
      await screen.findByTestId('discover-list');
      expect(screen.queryByTestId(NOTICE)).toBeNull();

      await userEvent.click(popular());
      await waitFor(() => expect(notice()).toBe(COPY.top));
    });

    it('🔴 the SEARCH arm fires while rows are still unpaged', async () => {
      // Same isolation for the query arm: a filter that keeps more rows than fit,
      // so `allLoadedShown` stays false and only the query arm can fire.
      setup(true, manyItems(ROWS));
      await screen.findByTestId('discover-list');
      expect(screen.queryByTestId(NOTICE)).toBeNull();

      await userEvent.type(screen.getByTestId('discover-search'), 'Gen');
      await waitFor(() => expect(notice()).toBe(COPY.search));
    });

    it('the Show more count is SCOPED to the loaded rows, not the catalog', async () => {
      setup(true, manyItems(ROWS));
      await screen.findByTestId('discover-list');
      // Never a bare total on a truncated board — the number must say what it counts.
      expect(screen.getByTestId('discover-show-more').textContent).toBe(
        `Show more (${ROWS - PAGE_SIZE} loaded)`,
      );
    });

    it('🔴 fires at the EXACT boundary — every loaded row shown, no Show more', async () => {
      // 🔴 length === discoverVisible exactly. `allLoadedShown` uses `<=`, and a
      // fixture that never LANDS on the boundary cannot see a `<=` -> `<`
      // mutant: with 15 rows the comparison is 15<=24, true either way. At
      // exactly PAGE_SIZE the two spellings disagree, which is the only place
      // they can. Measured: this case is what kills that mutant.
      setup(true, manyItems(PAGE_SIZE));
      await screen.findByTestId('discover-list');

      expect(screen.queryByTestId('discover-show-more')).toBeNull();
      await waitFor(() => expect(notice()).toBe(COPY.endOfList));
    });

    it('NEGATIVE CONTROL: an untruncated board keeps the plain count and never discloses', async () => {
      setup(false, manyItems(ROWS));
      await screen.findByTestId('discover-list');
      expect(screen.getByTestId('discover-show-more').textContent).toBe(`Show more (${ROWS - PAGE_SIZE})`);
      await userEvent.click(screen.getByTestId('discover-show-more'));
      await waitFor(() => expect(screen.queryByTestId('discover-show-more')).toBeNull());
      expect(screen.queryByTestId(NOTICE)).toBeNull();
    });
  });

  describe('the "Published by me" caveat', () => {
    // 🔴 An earlier fix SUBSTITUTED the empty-state copy on a truncated board.
    // That told a signed-OUT visitor — whose `myPublished` is empty for reasons
    // having nothing to do with truncation — that "anything you published
    // earlier may not appear here", and it deleted the panel's only call to
    // action for everyone. The caveat is now appended and viewer-gated.
    const CTA = 'Publish a generator from the builder to share it in Discover.';

    it('moves the TITLE off "nothing published" and still keeps the CTA, for a signed-in viewer', async () => {
      setup(true, manyItems(15));
      await screen.findByTestId('discover-list');
      await userEvent.click(screen.getByTestId('tab-mine'));

      const empty = await screen.findByTestId('published-empty');
      // 🔴 REPOINTED. This asserted the headline "Nothing published yet" while
      // the body below it said their generators may simply not be listed — the
      // most prominent line on the panel telling a viewer with 30 published
      // generators that they have none, contradicted three sentences later. The
      // title has to move with the caveat.
      expect(empty.textContent).toContain('Nothing published in the loaded page');
      expect(empty.textContent).not.toContain('Nothing published yet');
      expect(empty.textContent).toContain(CTA);
      expect(empty.textContent).toContain('loads only part of the catalog');
    });

    it('🔴 an UNTRUNCATED board says "nothing published yet" with NO caveat', async () => {
      // 🔴 The state nothing in the repo constructed. This round added a second
      // `viewerId && discoverTruncated` predicate (on the title) and no state to
      // exercise it, so BOTH predicates could be simplified to `viewerId != null`
      // and the suite stayed green — measured, two surviving mutants.
      //
      // What that ships: a signed-in viewer on a board with no cursor (whole
      // catalog loaded, under 50 rows) who has published nothing is told
      // "Nothing published in the loaded page" — a hedge pointing at pages that
      // do not exist. The mirror image of the contradiction the previous round
      // fixed, and green all the way.
      setup(false, manyItems(15));
      await screen.findByTestId('discover-list');
      await userEvent.click(screen.getByTestId('tab-mine'));

      const empty = await screen.findByTestId('published-empty');
      expect(empty.textContent).toContain('Nothing published yet');
      expect(empty.textContent).not.toContain('Nothing published in the loaded page');
      expect(empty.textContent).toContain(CTA);
      expect(empty.textContent).not.toContain('loads only part of the catalog');
    });

    it('🔴 says NOTHING about a publishing history to a signed-out visitor', async () => {
      setupAnon(true, manyItems(15));
      await screen.findByTestId('discover-list');
      await userEvent.click(screen.getByTestId('tab-mine'));

      const empty = await screen.findByTestId('published-empty');
      expect(empty.textContent).toContain('Nothing published yet');
      expect(empty.textContent).toContain(CTA);
      expect(empty.textContent).not.toContain('loads only part of the catalog');
      expect(empty.textContent).not.toMatch(/you published/i);
    });

    it('a signed-out visitor on an UNTRUNCATED board — the fourth cell', async () => {
      // 🔴 Completes the viewerId x discoverTruncated enumeration. With only the
      // other three cells built, the surviving mutation class is exactly XNOR —
      // the one two-variable function that agrees with AND everywhere the suite
      // looks and differs here — and rewriting either predicate that way left
      // 274/274 green. No plausible simplification produces XNOR, so this closes
      // a completeness gap rather than a live exposure; it is cheap, and the
      // enumeration is worth being able to state as complete.
      setupAnon(false, manyItems(15));
      await screen.findByTestId('discover-list');
      await userEvent.click(screen.getByTestId('tab-mine'));

      const empty = await screen.findByTestId('published-empty');
      expect(empty.textContent).toContain('Nothing published yet');
      expect(empty.textContent).toContain(CTA);
      expect(empty.textContent).not.toContain('loads only part of the catalog');
    });
  });

  /**
   * 🔴 THE HORIZON ITSELF, AT THE PRODUCTION LIMIT AND ON ITS OWN BOUNDARY.
   * Every case above shrinks the horizon with `discoverPageLimit` so its fixture
   * keeps its shape; these three do NOT — they seed real rows against the real
   * {@link DISCOVER_LIST_LIMIT}, because the defect being pinned lives exactly
   * at that constant and nowhere else.
   *
   * The defect: `setDiscoverTruncated(Boolean(sharedRes.nextCursor))`. civitai's
   * `apps.shared.router` `list` emits `nextCursor` **iff the page filled**
   * (`rows.length === input.limit`, re-derived at `5549de73`), so a board
   * holding exactly 50 non-hidden rows filled the page, handed back a cursor for
   * a board with nothing behind it, and the app told the viewer *"this app loads
   * only part of the catalog at once, so anything you published earlier may not
   * be listed here"* over a catalog it had loaded whole. Verbatim the class
   * `lib/runs.ts` declares a rule against — A CURSOR IS NOT EVIDENCE OF A NEXT
   * ROW — shipped alongside that rule.
   *
   * 🔴 ONE ASSERTION PINS BOTH FACTS, WHICH IS WHY IT IS A WHOLE STRING. "Show
   * more (N)" carries the LOADED row count, and the `loaded` suffix is rendered
   * only when `discoverTruncated` — so `(37)` / `(38)` / `(38 loaded)` says both
   * how many rows came back and what the app concluded from them. A flag-only
   * assertion would pass for a read that loaded the wrong set.
   *
   * Only the middle case is regression coverage. 49 and 51 pass at `aba7765`
   * too and are labelled controls: they are what makes the middle case a
   * boundary rather than a constant.
   */
  describe('the Discover horizon, at the real DISCOVER_LIST_LIMIT', () => {
    /** No `discoverPageLimit` — the production constant is the thing under test. */
    function setupAtLimit(rowCount: number) {
      const shared = fakeShared(manyItems(rowCount));
      const wf = mockWorkflow();
      render(
        <Harness viewer={{ id: VIEWER_ID, username: 'me' }} theme="dark" consentGranted showLog={false}>
          <App
            deps={{
              resolveResources: async () => [],
              shared: shared.shared,
              updateSharedGenerator: shared.update,
              drafts: memoryDraftStore(),
              estimate: wf.estimate,
              submit: wf.submit,
              poll: wf.poll,
            }}
          />
        </Harness>,
      );
    }

    const showMore = () => screen.getByTestId('discover-show-more').textContent;

    it('CONTROL: one row UNDER the horizon — whole board, and it says nothing', async () => {
      setupAtLimit(DISCOVER_LIST_LIMIT - 1);
      await screen.findByTestId('discover-list');

      await userEvent.click(popular());
      await waitFor(() => expect(popular()).toBeChecked());
      expect(screen.queryByTestId(NOTICE)).toBeNull();
      expect(showMore()).toBe(`Show more (${DISCOVER_LIST_LIMIT - 1 - PAGE_SIZE})`);
    });

    it('🔴 EXACTLY at the horizon the board is WHOLE, and the app must not say otherwise', async () => {
      setupAtLimit(DISCOVER_LIST_LIMIT);
      await screen.findByTestId('discover-list');

      // Popular is the arm that fires regardless of how far the viewer has
      // paged, so this isolates the flag from `allLoadedShown`.
      await userEvent.click(popular());
      await waitFor(() => expect(popular()).toBeChecked());
      expect(screen.queryByTestId(NOTICE)).toBeNull();
      // …and the whole board really did load: every row is here, unscoped.
      expect(showMore()).toBe(`Show more (${DISCOVER_LIST_LIMIT - PAGE_SIZE})`);
    });

    it('CONTROL: one row OVER the horizon — a row was left behind, and it says so', async () => {
      setupAtLimit(DISCOVER_LIST_LIMIT + 1);
      await screen.findByTestId('discover-list');

      await userEvent.click(popular());
      await waitFor(() => expect(notice()).toBe(COPY.top));
      // The over-fetched row is NOT rendered — the count is the horizon, scoped.
      expect(showMore()).toBe(`Show more (${DISCOVER_LIST_LIMIT - PAGE_SIZE} loaded)`);
    });
  });

  it('🔴 the four messages are DISTINCT — a swap must not pass', () => {
    // Pinning each branch is only worth anything if the branches differ; two
    // identical strings would make a swap invisible again.
    const all = Object.values(COPY);
    expect(new Set(all).size).toBe(all.length);
  });
});
