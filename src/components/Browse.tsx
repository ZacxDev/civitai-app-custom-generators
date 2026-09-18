// The BROWSE screen: discover published generators (shared storage, with vote
// counts, search, sort-by-popularity, and pagination) and manage "My generators"
// (the viewer's own drafts + published rows). Presentation only — data + actions
// (vote/fork/share/delete) come from the App.
//
// Chrome is the `@civitai/theme` design system: EmptyState panels, SafeImage
// covers, and `--civitai-*` tokens (via ../theme) so it flips with `[data-theme]`.
//
// a11y: the Discover/Mine switcher is an ARIA tablist with roving tabindex +
// arrow-key navigation; each panel is a labelled `role="tabpanel"`.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';

import { Alert, Badge, Button, Card, Group, Loader, Modal, Stack, TextInput } from '@civitai/blocks-react/ui';
// Design-system primitives (`@civitai/components-react` 0.3.1): the accessible
// SegmentedControl, hover/focus Tooltip, and the Toast notification system. These
// render the same `data-civitai-ui` + `--civitai-*` token contract as the
// blocks-react/ui pack, so they sit alongside it as one visual system.
import { SegmentedControl, Tooltip, ToastProvider, useToast } from '@civitai/components-react';

import type { BlockGatedImage } from '@civitai/app-sdk/blocks';
import type { SharedListItem } from '@civitai/blocks-react';
import type { StoredDraft } from '../lib/drafts.js';
import { keptImageCount, type KeptImageCell, type KeptRun } from '../lib/runs.js';
import { KeptGallery } from './KeptGallery.js';
import { ResultLightbox } from './ResultLightbox.js';
import { token, radius, metaText, type Palette } from '../theme.js';
// Motion is opt-in per element and gated on `prefers-reduced-motion` by
// `useMotion()` — see ../motion.ts for the single-guard rationale.
import { CLASS_LIFT, CLASS_RISE, CLASS_TICK, motionClass, staggerDelayMs, useChangeTick, useMotion } from '../motion.js';
import { formatCostRange, generatorCostRange } from '../lib/cost.js';
import { EXAMPLE_SHARED_ITEMS } from '../lib/examples.js';
import { EmptyState } from './EmptyState.js';
import { IntroPanel } from './IntroPanel.js';
import { SafeImage } from './SafeImage.js';
import { ReportButton } from '@civitai/blocks-react/ui';

type Tab = 'discover' | 'mine' | 'kept';
type SortMode = 'new' | 'top';

/** Rows revealed per "Show more" click.
 *  🔴 EXPORTED so tests can land exactly ON the boundary rather than duplicating
 *  the number. A test that hardcodes 12 stops testing the boundary the moment
 *  this changes, silently — measured: with the literal drifted, a `<=` -> `<`
 *  mutant survives a fully green file. */
export const PAGE_SIZE = 12;

/**
 * 🔴 `kept` is appended, not inserted. The roving-tabindex arrow navigation and
 * every `Home`/`End` case index into THIS array, so its order is the keyboard
 * order; putting the new tab in the middle would silently move where `End` lands
 * for people who navigate that way.
 *
 * 🔴 And it is only ever RENDERED for a signed-in viewer (see `visibleTabs`) —
 * kept runs live in per-user storage, so for an anonymous viewer the tab is not
 * an empty gallery, it is a gallery that cannot exist.
 */
const TABS: Tab[] = ['discover', 'mine', 'kept'];

const TAB_LABELS: Record<Tab, string> = {
  discover: 'Discover',
  mine: 'My generators',
  kept: 'My gallery',
};

export interface BrowseProps {
  c: Palette;
  loading: boolean;
  error: string | null;
  discover: SharedListItem[];
  /**
   * The `discover` rows are ONE PAGE of a longer board. When true, "Popular" is
   * a ranking over that page and search is a filter over it — both honest only
   * to the depth read, so the UI says so. See the notice in the Discover panel.
   */
  discoverTruncated: boolean;
  myDrafts: StoredDraft[];
  myPublished: SharedListItem[];
  viewerId: number | null;
  /** Prompt the logged-out viewer to sign in (persistent header affordance). */
  onSignIn: () => void;
  onCreate: () => void;
  onOpenPublished: (item: SharedListItem) => void;
  onOpenDraft: (draft: StoredDraft) => void;
  onEditDraft: (draft: StoredDraft) => void;
  onDeleteDraft: (draft: StoredDraft) => void;
  /** Withdraw one of the viewer's OWN published generators (shared_kv row). */
  onDeletePublished: (item: SharedListItem) => void | Promise<void>;
  /** Toggle this viewer's up-vote; resolves with the authoritative post-vote count. */
  onVote: (item: SharedListItem, nextVoted: boolean) => Promise<number>;
  /**
   * File a published generator for PLATFORM moderator review.
   *
   * 🔴 ESCALATION, NOT REMOVAL — `report` files the row and does not hide
   * it; a moderator decides. Offered only on a row the SIGNED-IN viewer does
   * not own: `report` rejects for an anonymous viewer, and an author already
   * has a real Remove, so offering it in either case is offering an error.
   */
  onReport: (item: SharedListItem) => Promise<void>;
  /** Fork a published generator into the viewer's own draft. */
  onFork: (item: SharedListItem) => void;
  /** Copy a shareable deeplink; resolves `true` on a successful copy. */
  onShare: (item: SharedListItem) => Promise<boolean>;
  /**
   * The per-viewer MODERATED cover url for a card, resolved by the host from the
   * stored `headerImageRef.imageId` (via `useGatedImages`). 🔴 Covers render from
   * THIS only — never from the unmoderated stored `url`. `null` (hidden / above
   * the viewer's ceiling / unresolved / no cover) ⇒ no cover image.
   */
  coverUrlFor: (item: SharedListItem) => string | null;
  /**
   * The viewer's KEPT runs — durable civitai image ids they chose to keep, across
   * every generator. Drives the "My gallery" tab, which is the app's answer to
   * "why would I come back?". Not because the images would otherwise be lost —
   * they go to the viewer's Civitai feed either way — but because the feed is an
   * undifferentiated stream that knows nothing about this app: which generator
   * made an image, which button, what was typed. This tab is the only place that
   * link exists, and the only one inside the block.
   */
  keptRuns?: KeptRun[];
  /**
   * Kept runs exist outside `keptRuns`. A read whose key walk reached the end of
   * the store hydrates the viewer's newest `KEPT_LIST_LIMIT`, so what is outside
   * is their oldest — and where it did not, `keptIncomplete` below says so,
   * because that is the state in which this sentence inverts. Threaded to the
   * gallery so it discloses either instead of presenting the set as complete.
   *
   * 🔴 Only legal because `keptRuns` here IS the loaded set. The Runner filters
   * to one generator and therefore deliberately does not take this prop.
   */
  keptTruncated?: boolean;
  /**
   * The kept-runs key walk was cut short, so what the gallery is missing is the
   * viewer's NEWEST keeps rather than their oldest (`KeptRunPage.incomplete` in
   * `lib/runs.ts`). Picks the gallery notice that is true in that state.
   *
   * 🔴 Same scoping rule as `keptTruncated` — a fact about the store, so only a
   * caller passing the UNFILTERED set may pass it.
   */
  keptIncomplete?: boolean;
  /**
   * The kept-runs read FAILED. 🔴 Not the same fact as "no kept runs", and the
   * difference is the whole reason this prop exists: rendering the gallery's
   * empty state over a failed read tells a viewer who has kept things that they
   * have not, which reads as data loss caused by this app. Set ⇒ the panel says
   * the load failed and offers `onRetry`, and the empty state is NOT shown.
   */
  keptError?: string | null;
  /** Per-viewer gated image read for the gallery. Required alongside `keptRuns`. */
  getImages?: (imageIds: number[]) => Promise<BlockGatedImage[]>;
  /**
   * Open the generator a kept image came from. Returns `false` when the key is
   * not on the loaded page (or was withdrawn), so the gallery can say so instead
   * of presenting a control that does nothing.
   */
  onOpenGeneratorKey?: (key: string) => boolean;
  /**
   * Offer the My-gallery post composer (`posts:write:self`), WITH somewhere for
   * the durable removal to land. Absent ⇒ no post surface at all.
   *
   * 🔴 THIS TAB AND NOWHERE ELSE. My gallery is the viewer's WHOLE kept set and
   * the surface they come to to look at what they made, so it is the one place
   * where "post these" is the obvious next thing and where the grid emptying out
   * afterwards is comprehensible. The Runner's kept strip is one generator's
   * slice under a heading about that generator, so it deliberately does not get
   * this — see `KeptGalleryProps.posting`.
   */
  posting?: {
    /**
     * The ids that joined a post, as the SERVER echoed them — the cue to delete
     * them from the durable kept-run store.
     *
     * 🔴 CARRIED ON THE OPT-IN ITSELF, SO THE PAIR IS UNREPRESENTABLE. A posted
     * image stops resolving for this app forever (the app-scoped read is
     * conjoined with `postId IS NULL`), so a post that is not followed by a
     * prune leaves a permanent *"No longer available"* tile and a run count that
     * keeps counting it. See `removeKeptImages` in `lib/runs.ts`.
     *
     * ⚠️ THIS PROP USED TO BE TWO INDEPENDENT OPTIONALS — `canPost?: boolean`
     * plus `onPosted?` — under a docblock asserting *"REQUIRED ALONGSIDE
     * `canPost`, AND THE GALLERY'S OWN PROP SHAPE ENFORCES IT"*. It did not:
     * `KeptGalleryProps` is a DIFFERENT type, and this component collapsed the
     * pair itself (`canPost && onPosted ? { onPosted } : undefined`) before that
     * shape was ever consulted, so the enforcement was asserted in prose and
     * absent from the types. A round-2 audit mutated that line to the fail-open
     * form `onPosted ?? (() => {})` — the round-0 defect restored — and the whole
     * `dom` project stayed green. The pair is now ONE object, which the
     * typechecker enforces at every call site and CI runs (`pnpm typecheck`).
     */
    onPosted: (imageIds: number[]) => void;
  };
  /** Route an anonymous viewer into the host sign-in flow (post refusal path). */
  onRequestSignIn?: () => void;
  /** Copy text to the clipboard; resolves `true` on success. Hands over a post url. */
  copyToClipboard?: (text: string) => Promise<boolean>;
  onRetry: () => void;
}

/** Case-insensitive match against a published generator's title + description. */
function matchesQuery(item: SharedListItem, q: string): boolean {
  const title = (item.value.title ?? '').toLowerCase();
  const desc = (item.value.body ?? '').toLowerCase();
  return title.includes(q) || desc.includes(q);
}

interface VoteState {
  count: number;
  voted: boolean;
}

export function Browse(props: BrowseProps) {
  const { c, loading, error, discover, discoverTruncated, myDrafts, myPublished, viewerId, onSignIn, onCreate, onOpenPublished, onOpenDraft, onEditDraft, onDeleteDraft, onDeletePublished, onVote, onFork, onShare, onReport, coverUrlFor, keptRuns, keptTruncated = false, keptIncomplete = false, keptError = null, getImages, onOpenGeneratorKey, posting, onRequestSignIn, copyToClipboard, onRetry } = props;
  const [tab, setTab] = useState<Tab>('discover');
  // Motion gate for the chrome Browse owns directly (draft cards). Cards rendered
  // by PublishedCard/IntroPanel read it themselves.
  const motion = useMotion();
  // One-time onboarding intro on Discover; dismissed for the session.
  const [introDismissed, setIntroDismissed] = useState(false);
  // Confirm-gated withdraw of an own published generator.
  const [pendingDelete, setPendingDelete] = useState<SharedListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Discover controls: search, sort, incremental pagination.
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('new');
  const [discoverVisible, setDiscoverVisible] = useState(PAGE_SIZE);
  const [draftsVisible, setDraftsVisible] = useState(PAGE_SIZE);

  // Optimistic vote overlay: key → { count, voted }. Seeds lazily from the item's
  // OWN row on first vote; sort/render prefer the overlay when present.
  //
  // `viewerVoted` is the host's authoritative per-viewer answer (required on
  // `SharedListItem` since @civitai/blocks-react 0.29). Seeding `voted: false`
  // regardless — which is what this did before — meant an already-upvoted row
  // rendered as un-voted, so the first click sent a *vote* the host rejected as
  // a duplicate and the viewer had to click TWICE to unvote.
  const [voteOverlay, setVoteOverlay] = useState<Record<string, VoteState>>({});
  const voteState = (item: SharedListItem): VoteState =>
    voteOverlay[item.key] ?? { count: item.count, voted: item.viewerVoted };
  // Per-key click sequence so an OUT-OF-ORDER resolution (rapid vote/unvote) can't
  // clobber a newer click's result — only the latest click applies its outcome.
  const voteSeq = useRef<Record<string, number>>({});

  const tablistRef = useRef<HTMLDivElement>(null);

  // The gallery tab exists only when there is a viewer to own it AND the app is
  // wired for the gated read. `visibleTabs` — not `TABS` — is what the keyboard
  // navigation walks, so arrow keys can never land on a tab that is not rendered.
  const galleryAvailable = viewerId != null && !!getImages && !!keptRuns;
  const visibleTabs = useMemo(
    () => (galleryAvailable ? TABS : TABS.filter((t) => t !== 'kept')),
    [galleryAvailable],
  );
  // A viewer who signs out while on the gallery must not be left on a panel that
  // no longer renders — that would show the tablist with nothing under it.
  useEffect(() => {
    if (!visibleTabs.includes(tab)) setTab('discover');
  }, [visibleTabs, tab]);

  const keptCells = keptRuns ?? [];
  const keptTotal = keptImageCount(keptCells);
  // The payoff view, shared with the Runner so the app has ONE way of showing a
  // result full size.
  const [keptLightbox, setKeptLightbox] = useState<{ cell: KeptImageCell; url: string } | null>(null);
  // Set when a kept image's generator is not on the loaded page — see
  // `onOpenGeneratorKey`'s contract.
  const [openGeneratorError, setOpenGeneratorError] = useState<string | null>(null);

  // Reset the discover page window when the query/sort changes so the first
  // page of the new result set is shown.
  useEffect(() => setDiscoverVisible(PAGE_SIZE), [query, sort]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await onDeletePublished(pendingDelete);
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  async function toggleVote(item: SharedListItem) {
    // Anonymous viewers can't vote — hand off to the App (which prompts sign-in)
    // WITHOUT an optimistic flash that would only revert.
    if (viewerId == null) {
      try {
        await onVote(item, true);
      } catch {
        /* App requested sign-in — nothing to roll back. */
      }
      return;
    }
    const cur = voteState(item);
    const nextVoted = !cur.voted;
    const seq = (voteSeq.current[item.key] ?? 0) + 1;
    voteSeq.current[item.key] = seq;
    const optimistic: VoteState = { voted: nextVoted, count: Math.max(0, cur.count + (nextVoted ? 1 : -1)) };
    setVoteOverlay((o) => ({ ...o, [item.key]: optimistic }));
    try {
      const count = await onVote(item, nextVoted);
      // Only the latest click applies its authoritative count (guards against a
      // slow earlier vote resolving AFTER a newer unvote, which would double-count).
      if (voteSeq.current[item.key] === seq) {
        setVoteOverlay((o) => ({ ...o, [item.key]: { voted: nextVoted, count } }));
      }
    } catch {
      // Roll back the optimistic change on host failure — but only if this is
      // still the latest click (a newer click already owns the state).
      if (voteSeq.current[item.key] === seq) {
        setVoteOverlay((o) => ({ ...o, [item.key]: cur }));
      }
    }
  }

  // Roving-tabindex + arrow-key navigation for the tablist (ARIA pattern).
  function onTabKeyDown(e: ReactKeyboardEvent) {
    // 🔴 Walks `visibleTabs`, NOT `TABS`. With the gallery hidden (anonymous
    // viewer, or an app not wired for the gated read) a `TABS`-based wrap would
    // move focus onto a tab that is not in the DOM: `End` would select 'kept',
    // the panel would render nothing, and the subsequent `.focus()` would find no
    // element — a dead tablist with no error.
    const tabs = visibleTabs;
    const idx = tabs.indexOf(tab);
    let next: Tab | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(idx + 1) % tabs.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabs[(idx - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (next) {
      e.preventDefault();
      setTab(next);
      const target = next;
      requestAnimationFrame(() => tablistRef.current?.querySelector<HTMLButtonElement>(`#tab-${target}`)?.focus());
    }
  }

  // Derived Discover list: filter by query, sort (newest = as-given, popular =
  // by effective vote count desc), then page.
  const filteredDiscover = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? discover.filter((it) => matchesQuery(it, q)) : discover.slice();
    if (sort === 'top') {
      base.sort((a, b) => (voteOverlay[b.key]?.count ?? b.count) - (voteOverlay[a.key]?.count ?? a.count));
    }
    return base;
  }, [discover, query, sort, voteOverlay]);
  const visibleDiscover = filteredDiscover.slice(0, discoverVisible);
  /** Every loaded row is on screen, so the absence of a "Show more" reads as
   *  "that is the whole catalog" — which is false on a truncated board, and is
   *  the one way the Newest tab lies. */
  const allLoadedShown = filteredDiscover.length <= discoverVisible;
  const visibleDrafts = myDrafts.slice(0, draftsVisible);

  return (
    // ToastProvider owns the share-confirmation toast (see PublishedCard). Scoped
    // to Browse (the only surface that raises a toast) so it needs no app-root
    // wiring and each Browse render — including tests — is self-contained.
    <ToastProvider>
    <Stack gap={16} data-testid="browse">
      <Group
        justify="space-between"
        align="center"
        gap={12}
        style={{ paddingBottom: 14, borderBottom: `1px solid ${token.border}` }}
      >
        <Group gap={12} align="center" wrap={false} style={{ minWidth: 0 }}>
          <span aria-hidden="true" style={brandMarkStyle}>
            <WandIcon />
          </span>
          <Stack gap={2} style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 19, letterSpacing: '-0.01em', lineHeight: 1.2 }}>
              Custom Generators
            </h1>
            <span style={metaText}>Build and run one-click image generators</span>
          </Stack>
        </Group>
        {viewerId == null ? (
          // Persistent top-level sign-in for anonymous viewers — building, running,
          // voting and forking all need an account, so surface it up front instead
          // of only reacting when they try one of those actions.
          <Button data-testid="header-signin" onClick={onSignIn}>
            Sign in to build &amp; run
          </Button>
        ) : (
          <Button data-testid="create-generator" leftSection="+" onClick={onCreate}>
            Create
          </Button>
        )}
      </Group>

      <div ref={tablistRef}>
        <Group gap={8} role="tablist" aria-label="Generator source" onKeyDown={onTabKeyDown}>
          {visibleTabs.map((t) => (
            <Button
              key={t}
              id={`tab-${t}`}
              size="sm"
              variant={tab === t ? 'filled' : 'subtle'}
              role="tab"
              aria-selected={tab === t}
              aria-controls={`panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              data-testid={`tab-${t}`}
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]}
              {t === 'kept' && keptTotal > 0 && (
                <>
                  {' '}
                  <Badge variant="light" data-testid="tab-kept-count">
                    {keptTotal}
                  </Badge>
                </>
              )}
            </Button>
          ))}
        </Group>
      </div>

      {error && (
        <Alert color="error" data-testid="browse-error">
          {error}{' '}
          <Button size="sm" variant="light" data-testid="browse-retry" onClick={onRetry}>
            Retry
          </Button>
        </Alert>
      )}

      {tab === 'discover' && (
        <div role="tabpanel" id="panel-discover" aria-labelledby="tab-discover" tabIndex={0}>
          <Stack gap={10} data-testid="discover-list">
            {!introDismissed && (
              <IntroPanel
                c={c}
                examples={EXAMPLE_SHARED_ITEMS}
                onTryExample={onFork}
                onCreate={onCreate}
                onDismiss={() => setIntroDismissed(true)}
              />
            )}
            <Group justify="space-between" gap={8} style={{ flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 200px', minWidth: 160 }}>
                <TextInput
                  aria-label="Search generators"
                  placeholder="Search generators…"
                  value={query}
                  data-testid="discover-search"
                  onChange={(e) => setQuery(e.currentTarget.value)}
                />
              </div>
              <SegmentedControl
                aria-label="Sort generators"
                data-testid="discover-sort"
                value={sort}
                onChange={(v) => setSort(v as SortMode)}
                data={[
                  { value: 'new', label: 'Newest' },
                  { value: 'top', label: 'Popular' },
                ]}
              />
            </Group>

            {/* 🔴 EVERY claim this panel makes about the catalog is really a
                claim about ONE PAGE of it. `list` is newest-first with no rank
                parameter, so:
                  - "Popular" ranks only what was loaded — a generator with more
                    votes can sit past the page and never appear;
                  - a search that misses such a row renders "No matches", i.e.
                    "no such generator exists" — a WRONG answer, not a short one;
                  - reaching the end of the loaded rows looks like the end of the
                    catalog, on every tab including Newest.
                🔴 The search case is the worst of the three, so when a search is
                active its wording WINS — an earlier version let the "Popular"
                wording win whenever both applied, which disclosed the lesser
                problem in exactly the state the worse one was live. */}
            {discoverTruncated && (sort === 'top' || query.trim().length > 0 || allLoadedShown) && (
              <span
                data-testid="discover-partial-notice"
                role="status"
                style={{ ...metaText }}
              >
                {query.trim().length > 0
                  ? sort === 'top'
                    ? 'Searching and ranking only the generators loaded so far, not the whole catalog.'
                    : 'Searching the generators loaded so far, not the whole catalog.'
                  : sort === 'top'
                    ? 'Ordered by votes across the generators loaded so far, not the whole catalog.'
                    : 'Showing the generators loaded so far — the catalog has more.'}
              </span>
            )}
            {loading && (
              <Group gap={8} data-testid="discover-loading" role="status" aria-live="polite">
                <Loader size="sm" />
                <span style={metaText}>Loading generators…</span>
              </Group>
            )}
            {/* When the intro panel is showing and there's no query, it already
                carries the concept + a "Build your own" CTA, so the plain empty
                panel would be redundant — suppress it in that case. */}
            {!loading && filteredDiscover.length === 0 && (query.trim() || introDismissed) && (
              <EmptyState
                data-testid="discover-empty"
                title={query.trim() ? 'No matches' : 'No published generators yet'}
                body={
                  query.trim()
                    ? `No generators match “${query.trim()}”.`
                    : 'Build a set of one-click generation buttons and publish it for everyone to run.'
                }
                action={
                  query.trim() ? undefined : (
                    <Button size="sm" data-testid="discover-empty-create" onClick={onCreate}>
                      Create the first one
                    </Button>
                  )
                }
              />
            )}
            {visibleDiscover.map((item, i) => {
              const vs = voteState(item);
              return (
                <PublishedCard
                  key={item.key}
                  item={item}
                  c={c}
                  enterIndex={i}
                  coverUrl={coverUrlFor(item)}
                  voteCount={vs.count}
                  voted={vs.voted}
                  onVote={() => toggleVote(item)}
                  onFork={() => onFork(item)}
                  onShare={() => onShare(item)}
                  onOpen={() => onOpenPublished(item)}
                  onReport={
                    // Signed-in AND not the author. Both halves are load-bearing:
                    // the host rejects `report` for an anonymous viewer, and the
                    // author's own row already offers Remove under the Mine tab.
                    viewerId != null && item.authorUserId !== viewerId
                      ? () => onReport(item)
                      : undefined
                  }
                />
              );
            })}
            {filteredDiscover.length > discoverVisible && (
              <Group justify="center">
                <Button variant="light" size="sm" data-testid="discover-show-more" onClick={() => setDiscoverVisible((n) => n + PAGE_SIZE)}>
                  {/* 🔴 The number is how many LOADED rows remain unshown — not
                      how many this click reveals (a click reveals at most
                      PAGE_SIZE), and never a claim about the catalog. Dropping
                      it entirely (an earlier fix) removed a real progress signal
                      and left the viewer paging blind; SCOPING it keeps the
                      information without the implicature. */}
                  Show more{discoverTruncated
                    ? ` (${filteredDiscover.length - discoverVisible} loaded)`
                    : ` (${filteredDiscover.length - discoverVisible})`}
                </Button>
              </Group>
            )}
          </Stack>
        </div>
      )}

      {tab === 'mine' && (
        <div role="tabpanel" id="panel-mine" aria-labelledby="tab-mine" tabIndex={0}>
          <Stack gap={16} data-testid="mine-list">
            <Stack gap={10}>
              <div style={{ fontSize: 13, color: c.muted, fontWeight: 600 }}>Drafts</div>
              {myDrafts.length === 0 && (
                <EmptyState
                  data-testid="drafts-empty"
                  title="No drafts yet"
                  body="Start a generator and save it as a draft to pick up later."
                  action={
                    <Button size="sm" variant="light" data-testid="drafts-empty-create" onClick={onCreate}>
                      New generator
                    </Button>
                  }
                />
              )}
              {visibleDrafts.map((d, i) => (
                <Card
                  key={d.id}
                  withBorder
                  padding="md"
                  data-testid="draft-card"
                  data-draft-id={d.id}
                  className={motionClass(motion, CLASS_LIFT, CLASS_RISE)}
                  style={motion ? { animationDelay: `${staggerDelayMs(i)}ms` } : undefined}
                >
                  <Group justify="space-between">
                    <div>
                      <div style={{ fontWeight: 600 }}>{d.config.name || 'Untitled generator'}</div>
                      <div style={{ fontSize: 12, color: c.muted }}>
                        {d.config.buttons.length} button{d.config.buttons.length === 1 ? '' : 's'}
                        {d.publishedKey ? ' · published' : ' · draft'}
                      </div>
                    </div>
                    <Group gap={6}>
                      <Button size="sm" variant="subtle" data-testid="draft-delete" color="error" onClick={() => onDeleteDraft(d)}>
                        Delete
                      </Button>
                      <Button size="sm" variant="light" data-testid="draft-edit" onClick={() => onEditDraft(d)}>
                        Edit
                      </Button>
                      <Button size="sm" data-testid="draft-open" onClick={() => onOpenDraft(d)}>
                        Run
                      </Button>
                    </Group>
                  </Group>
                </Card>
              ))}
              {myDrafts.length > draftsVisible && (
                <Group justify="center">
                  <Button variant="light" size="sm" data-testid="drafts-show-more" onClick={() => setDraftsVisible((n) => n + PAGE_SIZE)}>
                    Show more ({myDrafts.length - draftsVisible})
                  </Button>
                </Group>
              )}
            </Stack>

            <Stack gap={10}>
              <div style={{ fontSize: 13, color: c.muted, fontWeight: 600 }}>Published by me</div>
              {/* 🔴 `myPublished` is filtered out of the SAME single page, so on a
                  truncated board the viewer's own generators past that page are
                  missing here — and if all of them are, this panel would claim
                  they published nothing.
                  🔴 BOTH halves move together, and both are gated on the SAME
                  pair. The title stops asserting "nothing" (it would be false
                  for someone with 30 published generators) and the body KEEPS
                  its call to action, appending the caveat rather than replacing
                  it. Earlier rounds traded one for the other in each direction;
                  neither trade was necessary.
                  🔴 The `viewerId` half is not decoration: `myPublished` is empty
                  for a signed-out viewer for a reason that has nothing to do
                  with truncation, and telling someone with no account that
                  "anything you published earlier may not appear" addresses a
                  history they do not have. Dropping EITHER condition from EITHER
                  branch is a live defect — the untruncated case would hedge at a
                  page that does not exist — so both are pinned. */}
              {myPublished.length === 0 && (
                <EmptyState
                  data-testid="published-empty"
                  title={
                    viewerId != null && discoverTruncated
                      ? 'Nothing published in the loaded page'
                      : 'Nothing published yet'
                  }
                  body={
                    viewerId != null && discoverTruncated
                      ? 'Publish a generator from the builder to share it in Discover. Note this app loads only part of the catalog at once, so anything you published earlier may not be listed here.'
                      : 'Publish a generator from the builder to share it in Discover.'
                  }
                />
              )}
              {myPublished.map((item, i) => {
                const vs = voteState(item);
                return (
                  <PublishedCard
                    key={item.key}
                    item={item}
                    c={c}
                    enterIndex={i}
                    coverUrl={coverUrlFor(item)}
                    voteCount={vs.count}
                    voted={vs.voted}
                    onVote={() => toggleVote(item)}
                    onShare={() => onShare(item)}
                    onOpen={() => onOpenPublished(item)}
                    onDelete={() => setPendingDelete(item)}
                  />
                );
              })}
            </Stack>
          </Stack>
        </div>
      )}

      {/* 🔴 MY GALLERY — what the app gives you back. Discover is other people's
          generators and "My generators" is the things you built; neither is the
          thing you MADE. The images themselves do reach the viewer's Civitai
          feed (every submit is tagged `'civitai'`), so this is not a rescue from
          data loss — it is the only surface that keeps an image ATTACHED to the
          generator that produced it, and the only end-state that lives where the
          run happened. Before it there was no answer to "why open this app
          again?"; the feed cannot be one, because it cannot tell you the app
          was ever involved. */}
      {tab === 'kept' && galleryAvailable && (
        <div role="tabpanel" id="panel-kept" aria-labelledby="tab-kept" tabIndex={0}>
          <Stack gap={10} data-testid="kept-list">
            {keptCells.length > 0 && (
              <span style={metaText} data-testid="kept-summary">
                {keptTotal} image{keptTotal === 1 ? '' : 's'} kept from {keptCells.length} run
                {keptCells.length === 1 ? '' : 's'}.
              </span>
            )}
            {openGeneratorError && (
              <Alert
                color="info"
                data-testid="kept-open-error"
                withCloseButton
                onClose={() => setOpenGeneratorError(null)}
              >
                {openGeneratorError}
              </Alert>
            )}
            {/* 🔴 A FAILED READ IS NOT AN EMPTY GALLERY. With no runs to show
                the gallery would render "Nothing kept yet" — a confident claim
                about the viewer's history built on a read that never returned —
                so the failure REPLACES it rather than sitting above it. With
                runs already in hand (a keep made this session) the list is real
                but possibly short, so the alert rides above it instead. */}
            {keptError && (
              <Alert color="warning" data-testid="kept-load-error">
                <Stack gap={8}>
                  <span>{keptError}</span>
                  <Group>
                    <Button size="sm" variant="light" data-testid="kept-load-retry" onClick={onRetry}>
                      Try again
                    </Button>
                  </Group>
                </Stack>
              </Alert>
            )}
            {!(keptError && keptCells.length === 0) && (
            <KeptGallery
              data-testid="browse-kept-gallery"
              runs={keptCells}
              c={c}
              getImages={getImages!}
              withAttribution
              truncated={keptTruncated}
              incomplete={keptIncomplete}
              // 🔴 THE OPT-IN CARRIES THE DURABLE REMOVAL, AND IT IS PASSED
              // THROUGH RATHER THAN ASSEMBLED HERE. `KeptGallery` does not own
              // the kept-run store, so posting without a prune path is a
              // permanent "No longer available" tile. This line used to build
              // the pair out of two independent optionals and silently DEGRADE
              // when only one arrived — `canPost && onPosted ? … : undefined` —
              // which meant the gallery's prop shape was consulted after the
              // decision had already been made, and a fail-open mutation of it
              // was invisible to the whole suite. Both props are one object now,
              // so there is nothing left here to get wrong.
              posting={posting}
              onRequestSignIn={onRequestSignIn}
              copyToClipboard={copyToClipboard}
              emptyTitle="Nothing kept yet"
              emptyBody="Run a generator and press Keep on a result — the images you keep stay here."
              emptyAction={
                <Button size="sm" variant="light" data-testid="kept-empty-discover" onClick={() => setTab('discover')}>
                  Find a generator
                </Button>
              }
              onOpenCell={(cell, url) => {
                if (url) setKeptLightbox({ cell, url });
              }}
            />
            )}
          </Stack>
        </div>
      )}

      {/* The payoff view for a kept image, with the way back to the generator
          that made it — the one place the app turns "look what I made" into
          "make another one like it". */}
      <ResultLightbox
        opened={keptLightbox != null}
        onClose={() => setKeptLightbox(null)}
        c={c}
        src={keptLightbox?.url ?? null}
        generatorName={keptLightbox?.cell.run.generatorName ?? ''}
        buttonLabel={keptLightbox?.cell.run.buttonLabel ?? ''}
        prompt={keptLightbox?.cell.run.prompt}
        kept
        index={
          keptLightbox ? keptLightbox.cell.run.imageIds.indexOf(keptLightbox.cell.imageId) + 1 || 1 : 1
        }
        total={keptLightbox?.cell.run.imageIds.length ?? 1}
        onOpenGenerator={
          keptLightbox?.cell.run.generatorKey && onOpenGeneratorKey
            ? () => {
                const key = keptLightbox.cell.run.generatorKey!;
                setKeptLightbox(null);
                // 🔴 The board read is ONE page and there is no get-a-generator-
                // by-key seam, so this legitimately fails for a generator past
                // that page or withdrawn since. Say which, rather than closing
                // the view and appearing to do nothing.
                if (!onOpenGeneratorKey(key)) {
                  setOpenGeneratorError(
                    'That generator isn’t in the list right now — it may have been withdrawn, or be further down the catalog than this app has loaded.',
                  );
                }
              }
            : undefined
        }
      />

      {/* Confirm-gated withdraw. `withdraw` permanently removes the shared_kv row
          (and its votes) — so gate it behind an explicit confirmation. */}
      <Modal
        opened={!!pendingDelete}
        onClose={() => (deleting ? undefined : setPendingDelete(null))}
        title="Delete published generator?"
        size="sm"
      >
        <Stack gap={14} data-testid="delete-published-modal">
          <p style={{ margin: 0, fontSize: 14 }}>
            This removes <strong>{pendingDelete?.value.title || 'this generator'}</strong> from Discover for
            everyone, along with its votes. This can't be undone.
          </p>
          <Group justify="flex-end" gap={8}>
            <Button
              variant="subtle"
              size="sm"
              data-testid="cancel-delete-published"
              disabled={deleting}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
            <Button
              color="error"
              size="sm"
              data-testid="confirm-delete-published"
              loading={deleting}
              onClick={confirmDelete}
            >
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
    </ToastProvider>
  );
}

/** A tinted rounded tile that holds the brand mark (matches the manifest's
 * `wand` page icon), styled entirely off `--civitai-*` tokens. */
const brandMarkStyle: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 38,
  height: 38,
  flexShrink: 0,
  borderRadius: radius.md,
  color: token.primary,
  background: token.primaryLight,
  border: `1px solid ${token.border}`,
};

/** Inline `wand` glyph (currentColor), no external icon dependency. */
function WandIcon(): React.JSX.Element {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 6l3 3M5 19L16.5 7.5a1.8 1.8 0 0 0 0-2.5l-.5-.5a1.8 1.8 0 0 0-2.5 0L2 16l3 3z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M18 3l.6 1.4L20 5l-1.4.6L18 7l-.6-1.4L16 5l1.4-.6zM6 3l.4 1L7.5 4.5 6.5 5 6 6l-.5-1L4.5 4.5 5.5 4z" fill="currentColor" />
    </svg>
  );
}

function PublishedCard({
  item,
  c,
  coverUrl,
  enterIndex,
  voteCount,
  voted,
  onVote,
  onFork,
  onShare,
  onOpen,
  onDelete,
  onReport,
}: {
  item: SharedListItem;
  c: Palette;
  /** Host-resolved MODERATED cover url (from the stored `imageId`), or null. */
  coverUrl: string | null;
  /** Position in its list — drives the capped entrance stagger. Omit for no entrance. */
  enterIndex?: number;
  voteCount: number;
  voted: boolean;
  onVote: () => void;
  /**
   * When present, renders the Report control. Presence IS the gate: Browse
   * passes it only for a signed-in non-author, so this component never has to
   * re-derive who may report.
   */
  onReport?: () => Promise<void>;
  /** When present, renders a "Make a copy" (fork) affordance (discover cards). */
  onFork?: () => void;
  /** Copy a shareable deeplink; resolves `true` on a successful copy. */
  onShare?: () => Promise<boolean>;
  onOpen: () => void;
  /** When present, renders a confirm-gated Delete affordance (own published only). */
  onDelete?: () => void;
}) {
  const desc = (item.value.body ?? '').split('\n')[0];
  // Approximate at-a-glance run cost (heuristic; the real price is the host
  // estimate on the run path). Shown prefixed with "≈" so it never reads as exact.
  const costLabel = formatCostRange(generatorCostRange(item.value));
  const toast = useToast();
  const motion = useMotion();
  // 0 until the count actually moves, so a freshly-painted list does not tick.
  // Doubles as the tick element's `key` so a SECOND vote replays the animation.
  const voteTick = useChangeTick(voteCount);

  async function share() {
    if (!onShare) return;
    const ok = await onShare();
    if (ok) {
      // Confirm the copy via the design-system Toast (auto-dismisses) instead of
      // the former inline "Copied!" button-label swap.
      toast.show({ message: 'Link copied to clipboard', color: 'success' });
    }
  }

  return (
    <Card
      withBorder
      padding="md"
      data-testid="published-card"
      data-key={item.key}
      className={motionClass(motion, CLASS_LIFT, enterIndex != null && CLASS_RISE)}
      style={motion && enterIndex != null ? { animationDelay: `${staggerDelayMs(enterIndex)}ms` } : undefined}
    >
      <Stack gap={10}>
        {coverUrl && (
          // A broken/dead cover URL (withdrawn image, offline host) collapses
          // gracefully rather than leaving a broken glyph dominating the card.
          <SafeImage
            data-testid="published-cover"
            src={coverUrl}
            alt=""
            style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: radius.md, border: `1px solid ${c.border}`, display: 'block' }}
          />
        )}
        <Group justify="space-between" align="flex-start" gap={12}>
          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{item.value.title || 'Untitled generator'}</div>
            {desc && (
              <div style={{ ...metaText, marginTop: 2 }} data-testid="published-desc">
                {desc}
              </div>
            )}
            {costLabel && (
              <div
                style={{ ...metaText, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}
                data-testid="published-cost"
              >
                {costLabel}
              </div>
            )}
          </div>
          <Group gap={8} wrap={false}>
            <Tooltip label={voted ? 'Remove your upvote' : 'Upvote this generator'}>
              <Button
                size="sm"
                variant={voted ? 'light' : 'subtle'}
                data-testid="vote-button"
                aria-pressed={voted}
                aria-label={voted ? 'Remove upvote' : 'Upvote'}
                onClick={onVote}
              >
                ▲{' '}
                <Badge variant="light" data-testid="published-votes">
                  {/* `key` remounts the span so the tick REPLAYS on every vote —
                      re-applying the same class to a reused node would not. */}
                  <span
                    key={voteTick}
                    className={motionClass(motion, voteTick > 0 && CLASS_TICK)}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {voteCount}
                  </span>
                </Badge>
              </Button>
            </Tooltip>
            {onShare && (
              <Button size="sm" variant="subtle" data-testid="published-share" onClick={share}>
                Share
              </Button>
            )}
            {onFork && (
              <Tooltip label="Fork into your own editable draft">
                <Button size="sm" variant="subtle" data-testid="published-fork" onClick={onFork}>
                  Make a copy
                </Button>
              </Tooltip>
            )}
            {onReport && (
              // Last in the group on purpose: escalation is not a primary
              // action. The control owns its own two-step confirm and its own
              // copy — which is the point of sharing it, so do not restate
              // the wording here.
              <ReportButton noun="generator" onReport={onReport} data-testid="published-report" />
            )}
            {onDelete && (
              <Button size="sm" variant="subtle" color="error" data-testid="published-delete" onClick={onDelete}>
                Delete
              </Button>
            )}
            <Button size="sm" data-testid="published-open" onClick={onOpen}>
              Open
            </Button>
          </Group>
        </Group>
      </Stack>
    </Card>
  );
}
