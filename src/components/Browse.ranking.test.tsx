// 🔴 "Top" is a ranking over ONE PAGE, and the app must say so when there is
// more board than page.
//
// `App` reads ONE page of the BOARD — `shared.list({ limit: DISCOVER_LIST_LIMIT
// + 1 })`, the extra row being how it learns whether a row exists past the
// horizon — and Browse then sorts the rendered 50 by vote count for the "Top" tab
// and filters them for search. There is no server-side sort (`list` is
// newest-first and takes no rank parameter), so both operations are honest only
// to the depth read:
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
//
// 🔴 "PUBLISHED BY ME" IS NO LONGER ONE OF THESE CASES, AND THE CHANGE RUNS THE
// OTHER WAY FROM EVERY PARAGRAPH ABOVE. It used to be the fourth victim of the
// single-page read: `myPublished` was `shared.filter((s) => s.authorUserId ===
// viewer.id)` over that same page, so a viewer's own generators sitting past the
// horizon of the WHOLE BOARD were missing from their own list — and when all of
// them were, the panel said they had published nothing. That was not a ranking
// being honest to its depth; it was a wrong answer about the viewer's own data,
// and the app hedged about it ("Nothing published in the loaded page") because a
// client filter over one page cannot do better.
//
// It now has its OWN read: `shared.list({ mine: true, limit:
// MY_PUBLISHED_LIST_LIMIT + 1 })`, which the server answers over the whole board
// (civitai/civitai#5361). Two consequences this file pins:
//
//   - the rows are THERE however deep they sit, which is the regression case —
//     built so the old client filter demonstrably cannot produce it;
//   - the hedge is GONE, because it would now be false. `discoverTruncated` is a
//     fact about the board and says nothing about the viewer's own rows, so
//     re-reading it in that panel is the defect rather than the disclosure. The
//     four-cell `viewerId x discoverTruncated` enumeration that used to live in
//     the caveat describe below is retired with it, and replaced by an assertion
//     that the panel is SILENT in all four.
//
// The one caveat that can still apply there is `myPublishedTruncated`, which has
// its own two cases at the end of that describe.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Harness } from '../platform/testing.js';
import type { SharedListItem } from '../platform/index.js';

import { App, DISCOVER_LIST_LIMIT, type AppDeps } from '../App.js';
// 🔴 The REAL constant, not a copy. Duplicating it let the boundary case drift
// off the boundary and keep passing — measured, a `<=` -> `<` mutant then
// survived a green file.
import { PAGE_SIZE } from './Browse.js';
import { fakeShared, memoryDraftStore, mockWorkflow } from '../test-helpers.js';
import type { GeneratorData } from '../types.js';

const VIEWER_ID = 99;

function item(key: string, title: string, count: number, authorUserId = 7): SharedListItem {
  return {
    key,
    authorUserId,
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

/**
 * `horizons` overrides what `withHorizon` derives.
 *
 * 🔴 `discoverPageLimit` IS NEEDED BECAUSE `withHorizon` DERIVES IT FROM THE
 * FIXTURE'S SIZE — it returns `base.length`, so an untruncated board renders
 * every seeded row by construction. Every case above wants exactly that. The
 * "my rows sit past the discover page" case wants the opposite: a board whose
 * read genuinely leaves rows behind while the fixture stays small enough to read,
 * which needs the two decoupled.
 */
function setup(
  hasMore: boolean,
  rows?: SharedListItem[],
  horizons: { myPublishedPageLimit?: number; discoverPageLimit?: number } = {},
) {
  const { rows: seed, pageLimit: derivedPageLimit } = withHorizon(
    rows ?? [item('a', 'Alpha gen', 5), item('b', 'Beta gen', 2)],
    hasMore,
  );
  const pageLimit = horizons.discoverPageLimit ?? derivedPageLimit;
  const { myPublishedPageLimit } = horizons;
  const shared = fakeShared(seed, { viewerId: VIEWER_ID });
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
    ...(myPublishedPageLimit !== undefined ? { myPublishedPageLimit } : {}),
  };
  render(
    <Harness viewer={{ id: VIEWER_ID, username: 'me' }} theme="dark" consentGranted showLog={false}>
      <App deps={deps} />
    </Harness>,
  );
  return shared;
}

/** Same harness, no viewer — `null` is the anon path; `undefined` would give the
 *  fake platform's default dev-viewer (`{ id: 99 }`) and silently make this a
 *  signed-IN case. */
function setupAnon(hasMore: boolean, rows?: SharedListItem[]) {
  const { rows: seed, pageLimit } = withHorizon(rows ?? [], hasMore);
  const shared = fakeShared(seed, { viewerId: VIEWER_ID });
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

  describe('the "Published by me" panel', () => {
    const CTA = 'Publish a generator from the builder to share it in Discover.';
    /**
     * 🔴 THE RETIRED HEDGE, PINNED AS A STRING SO ITS RETURN IS LOUD. While
     * `myPublished` was a client filter over the discover page, this panel said
     * *"Nothing published in the loaded page"* / *"anything you published earlier
     * may not be listed here"* whenever `viewerId != null && discoverTruncated` —
     * honest at the time, because the filter genuinely could not tell "published
     * nothing" from "your rows are past the page".
     *
     * The rows now come from their own `mine=true` read over the whole board, so
     * an empty list means the SERVER found none, and that sentence would be a
     * false claim about a page this list does not have. Pinned by its own words
     * rather than by a flag, because the flag it used to read (`discoverTruncated`)
     * is still live and still correct for Discover — a regression here looks like
     * someone re-wiring a real flag into the wrong panel.
     */
    const RETIRED_HEDGE = [
      'Nothing published in the loaded page',
      'loads only part of the catalog',
      'anything you published earlier',
    ] as const;

    function expectNoHedge(el: HTMLElement) {
      for (const phrase of RETIRED_HEDGE) expect(el.textContent).not.toContain(phrase);
    }

    /**
     * 🔴 THE FOUR CELLS OF `viewerId x discoverTruncated`, NOW ALL SILENT. The
     * previous round built this enumeration to pin a two-variable predicate that
     * had two surviving mutants (both predicates simplifying to `viewerId !=
     * null`) and one unreachable-by-simplification one (XNOR). The predicate is
     * gone, so the enumeration survives inverted: no cell may hedge, and every
     * cell keeps the call to action.
     *
     * It is NOT redundant with a single case. `discoverTruncated` and `viewerId`
     * are both still computed and still passed to this component, so a mutant
     * that reads either of them in this panel is a live possibility — and only a
     * fixture where they DIFFER can see it.
     */
    const CELLS = [
      ['signed-in', 'truncated', true, true],
      ['signed-in', 'whole', true, false],
      ['signed-out', 'truncated', false, true],
      ['signed-out', 'whole', false, false],
    ] as const;

    for (const [who, board, signedIn, hasMore] of CELLS) {
      it(`🔴 a ${who} viewer on a ${board} board: "nothing published yet", no hedge`, async () => {
        // Every seeded row is authored by someone else (the `item` default), so
        // the viewer's own list is legitimately empty in all four cells.
        if (signedIn) setup(hasMore, manyItems(15));
        else setupAnon(hasMore, manyItems(15));
        await screen.findByTestId('discover-list');
        await userEvent.click(screen.getByTestId('tab-mine'));

        const empty = await screen.findByTestId('published-empty');
        expect(empty.textContent).toContain('Nothing published yet');
        expect(empty.textContent).toContain(CTA);
        expectNoHedge(empty);
        // Nothing about a history a signed-out visitor does not have.
        expect(empty.textContent).not.toMatch(/you published/i);
      });
    }

    /**
     * 🔴 THE REGRESSION CASE. THE FIXTURE IS BUILT SO THE OLD IMPLEMENTATION
     * CANNOT PASS IT, which is the only thing that makes it regression coverage
     * rather than a restatement of the new code.
     *
     * The store is ordered newest-first and holds four rows: two by someone else,
     * then two by the viewer. `discoverPageLimit` is 2, so the Discover read asks
     * for 3 and RENDERS 2 — both of them someone else's. `shared` (the array the
     * old `myPublished = shared.filter(authorUserId === viewer.id)` ran over)
     * therefore contains ZERO of the viewer's rows:
     *
     *   - `mine-a` is inside the 3-row fetch but outside the rendered slice;
     *   - `mine-b` is outside the fetch entirely.
     *
     * Two different ways to be invisible to a client filter, so the case does not
     * rest on the slice boundary alone. Both must appear, out of the viewer's own
     * read.
     */
    const PAST_THE_PAGE = [
      item('z-theirs-1', 'Someone elses newest', 1),
      item('y-theirs-2', 'Someone elses second', 1),
      item('x-mine-a', 'My older generator', 3, VIEWER_ID),
      item('w-mine-b', 'My oldest generator', 2, VIEWER_ID),
    ];

    it('🔴 shows the viewer’s OWN rows that sit PAST the discover page', async () => {
      setup(false, PAST_THE_PAGE, { discoverPageLimit: 2 });
      await screen.findByTestId('discover-list');

      // Precondition, asserted rather than assumed: neither of the viewer's rows
      // is on the Discover board, so a filter over what Discover loaded is empty.
      // If this ever stops holding, the case below is passing for a fixture that
      // no longer constructs the defect.
      const discover = screen.getByTestId('discover-list');
      expect(discover.textContent).toContain('Someone elses newest');
      expect(discover.textContent).not.toContain('My older generator');
      expect(discover.textContent).not.toContain('My oldest generator');

      await userEvent.click(screen.getByTestId('tab-mine'));
      const mine = await screen.findByTestId('mine-list');
      await waitFor(() => expect(mine.textContent).toContain('My older generator'));
      expect(mine.textContent).toContain('My oldest generator');
      // ...and the panel does not simultaneously claim they have published nothing.
      expect(screen.queryByTestId('published-empty')).toBeNull();
    });

    it('asks the SERVER for them: one `mine: true` read, over its own horizon', async () => {
      const shared = setup(false, PAST_THE_PAGE, { discoverPageLimit: 2, myPublishedPageLimit: 7 });
      await screen.findByTestId('discover-list');
      await waitFor(() => expect(shared.listCalls.length).toBe(2));

      const [discoverCall, mineCall] = shared.listCalls;
      // 🔴 KEY PRESENCE, not value equality. `toEqual` treats
      // `{ mine: undefined }` as equal to `{}`, so an assertion written as
      // `mine: undefined` would pass against code that never sends `mine`.
      expect('mine' in discoverCall).toBe(false);
      expect(discoverCall.limit).toBe(3); // discoverPageLimit (2) + 1
      expect('mine' in mineCall).toBe(true);
      // A real boolean — the route's schema is a `'true' | 'false'` literal union
      // and `?mine=` is a 400. The serialisation itself is pinned in
      // `platform/sharedStorage.list.test.ts`.
      expect(mineCall.mine).toBe(true);
      expect(mineCall.limit).toBe(8); // myPublishedPageLimit (7) + 1
    });

    /**
     * 🔴 AN ANONYMOUS VIEWER: THE REQUEST IS NOT MADE AT ALL. The server answers
     * an anonymous `mine=true` with an EMPTY PAGE — not an error, and not the
     * whole board — because the author predicate is UNKNOWN for a NULL subject.
     * That is the right answer, but it is indistinguishable from "the store is
     * empty", so the app does not ask: it has nothing to learn from a reply it
     * could not interpret. Pinned as a CALL COUNT plus key absence, because an
     * empty mine panel looks identical either way.
     */
    it('🔴 fires NO `mine` request for a signed-out visitor', async () => {
      const shared = setupAnon(false, PAST_THE_PAGE);
      await screen.findByTestId('discover-list');
      await userEvent.click(screen.getByTestId('tab-mine'));
      await screen.findByTestId('published-empty');

      expect(shared.listCalls).toHaveLength(1);
      expect('mine' in shared.listCalls[0]).toBe(false);
      // CONTROL: the same fixture DOES produce a second, `mine`-carrying call for
      // a signed-in viewer (the case above), so the 1 here is attributable to the
      // viewer and not to a recorder that never sees anything.
    });

    /**
     * 🔴 THE ONE CAVEAT THAT CAN STILL APPLY, and the tripwire behind it.
     * `MY_PUBLISHED_LIST_LIMIT` is the server's per-author row cap, so a row past
     * it is impossible today — the read over-fetches by one anyway, so that
     * assumption is falsifiable at runtime instead of being a comment. If the cap
     * is raised server-side the viewer is TOLD, rather than quietly losing rows
     * the way the client filter did.
     *
     * `myPublishedPageLimit` is what makes the state constructible at all: at the
     * production value it needs 51 rows from ONE author, which the cap forbids.
     */
    const FOUR_OF_MINE = [
      item('z-mine-1', 'Mine one', 1, VIEWER_ID),
      item('y-mine-2', 'Mine two', 1, VIEWER_ID),
      item('x-mine-3', 'Mine three', 1, VIEWER_ID),
      item('w-mine-4', 'Mine four', 1, VIEWER_ID),
    ];

    const MINE_NOTICE = 'published-partial-notice';

    it('🔴 discloses when the viewer has MORE rows than this app loads at once', async () => {
      setup(false, FOUR_OF_MINE, { myPublishedPageLimit: 3 });
      await screen.findByTestId('discover-list');
      await userEvent.click(screen.getByTestId('tab-mine'));

      const mine = await screen.findByTestId('mine-list');
      await waitFor(() => expect(mine.textContent).toContain('Mine one'));
      // Pinned WHOLE. A fragment every branch shares would let the sentence be
      // replaced with arbitrary text while this stayed green.
      expect(screen.getByTestId(MINE_NOTICE).textContent).toBe(
        'Showing your most recent generators — you have more than this app loads at once.',
      );
      // The horizon is respected: 3 rendered, the 4th withheld.
      expect(mine.textContent).toContain('Mine three');
      expect(mine.textContent).not.toContain('Mine four');
    });

    it('CONTROL: EXACTLY at the horizon the list is WHOLE, and says nothing', async () => {
      // The boundary, on the other side. The read asks for 5 and gets 4, so the
      // over-fetch row is absent and the claim is a fact rather than a hedge —
      // the same `+1` reasoning `DISCOVER_LIST_LIMIT` rests on, and the case that
      // dies if someone re-derives truncation from `nextCursor` (emitted iff the
      // page filled, which it would here).
      setup(false, FOUR_OF_MINE, { myPublishedPageLimit: 4 });
      await screen.findByTestId('discover-list');
      await userEvent.click(screen.getByTestId('tab-mine'));

      const mine = await screen.findByTestId('mine-list');
      await waitFor(() => expect(mine.textContent).toContain('Mine four'));
      expect(screen.queryByTestId(MINE_NOTICE)).toBeNull();
    });

    it('CONTROL: an EMPTY own-list is never truncated — no notice beside the empty state', async () => {
      // `myPublishedTruncated` can only be true when rows came back, which is why
      // the notice lives beside the rows and not inside the empty state. A hedge
      // appearing here would be the retired defect in a new spelling.
      setup(true, manyItems(15), { myPublishedPageLimit: 3 });
      await screen.findByTestId('discover-list');
      await userEvent.click(screen.getByTestId('tab-mine'));

      await screen.findByTestId('published-empty');
      expect(screen.queryByTestId(MINE_NOTICE)).toBeNull();
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
