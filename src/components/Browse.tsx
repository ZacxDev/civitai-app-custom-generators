// The BROWSE screen: discover published generators (shared storage, with vote
// counts, search, sort-by-popularity, and pagination) and manage "My generators"
// (the viewer's own drafts + published rows). Presentation only — data + actions
// (vote/fork/share/delete) come from the App.
//
// Chrome is the `@civitai/theme` design system: EmptyState panels, SafeImage
// covers, and `--civitai-*` tokens (via ../theme) so it flips with `[data-theme]`.
//
// Navigation: a slide-out sidebar (hamburger in the header) carrying the
// upstream `civitai-nav-list` / `civitai-nav-item` web components; each panel
// stays a labelled `role="tabpanel"` named by its nav item.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Alert, Badge, Button, Card, Group, Loader, Modal, Stack, TextInput, Tooltip, ToastProvider, useToast } from '../ui/index.js';
// The hover/focus Tooltip and Toast system render the `@civitai/components`
// markup contract (`data-civitai-ui` + `--civitai-*` tokens), same as the
// control adapters in ui/primitives — one visual system. The sidebar nav and
// the sort menu below are the upstream WEB COMPONENTS themselves
// (`civitai-nav-list` / `civitai-menu`), registered by define-upstream.

import type { BlockGatedImage } from '@civitai/app-sdk/blocks';
import type { DownvoteState, SharedListItem } from '../platform/index.js';
import '../define-upstream.js';
import type { StoredDraft } from '../lib/drafts.js';
import { keptImageCount, type KeptImageCell, type KeptRun } from '../lib/runs.js';
import { KeptGallery } from './KeptGallery.js';
import { ResultLightbox } from './ResultLightbox.js';
import { token, radius, metaText, type Palette } from '../theme.js';
// Motion is opt-in per element and gated on `prefers-reduced-motion` by
// `useMotion()` — see ../motion.ts for the single-guard rationale.
import { CLASS_LIFT, CLASS_RISE, CLASS_TICK, motionClass, staggerDelayMs, useChangeTick, useMotion } from '../motion.js';
import { EmptyState } from './EmptyState.js';
import { SafeImage } from './SafeImage.js';
import { ReportButton } from '../ui/index.js';

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

/** Each section's host-page route — the nav item `href` the upstream list
 *  matches `current` against. Mirrors `routeForPage` in lib/routes.ts.
 *  Discover is `/`, never ``: an EMPTY href makes civitai-nav-item render as
 *  a collapsible GROUP header (chevron, aria-expanded) instead of a link. */
const SECTION_ROUTE: Record<Tab, string> = {
  discover: '/',
  mine: 'mine',
  kept: 'gallery',
};

export interface BrowseProps {
  c: Palette;
  loading: boolean;
  error: string | null;
  /**
   * The visible section, controlled by the caller when the section is a
   * host PAGE (App.tsx routes `''` / `mine` / `gallery`). Absent = Browse
   * owns it (tests, embeds). `onSectionChange` is how a section switch
   * asks the router to push the new page; the section itself only changes
   * when the prop does, so the address bar and the panel cannot drift.
   */
  section?: Tab;
  onSectionChange?: (section: Tab) => void;
  discover: SharedListItem[];
  /**
   * The `discover` rows are ONE PAGE of a longer board. When true, "Popular" is
   * a ranking over that page and search is a filter over it — both honest only
   * to the depth read, so the UI says so. See the notice in the Discover panel.
   */
  discoverTruncated: boolean;
  myDrafts: StoredDraft[];
  /**
   * The viewer's OWN published generators, from a SERVER-FILTERED read over the
   * whole board — not a client filter over `discover`.
   *
   * 🔴 THAT DISTINCTION IS WHY THIS PANEL CARRIES NO PAGINATION CAVEAT. While these
   * rows were filtered out of the single discover page, an empty list could mean
   * either "published nothing" or "every one of your rows sits past the page we
   * read", so the empty state had to say so. It is now the server's answer about
   * the viewer's own rows, read at the list route's own maximum
   * (`SHARED_LIST_LIMIT_MAX` in `App.tsx`), which the per-author row cap sits far
   * below — so this is ALL of them, not a page of them.
   * `discoverTruncated` is a fact about the BOARD and says nothing about this
   * list; re-reading it here is the defect, not the disclosure.
   *
   * ⚠️ **`[]` IS OVERLOADED AND "empty means empty" IS NO LONGER TRUE** — an
   * earlier version of this paragraph said it was. `App.tsx`'s load effect passes
   * `[]` both for "the server returned zero rows" and for "the read REJECTED and
   * was confined so it would not blank the rest of Browse". So emptiness here is
   * ambiguous in a way pagination no longer makes it. The panel states it as a
   * positive fact anyway ("Nothing published yet"); that is tracked as
   * `published-empty` at the empty-state site below and is OPEN, not fixed.
   * 🔴 If you are adding a `publishedError` prop, THIS is the declaration to add it
   * beside. The paragraph above is accurate **as scoped** — it is about PAGE DEPTH
   * only — so do not rewrite or delete it; what it does not cover is whether the
   * read SUCCEEDED, which is this paragraph's subject.
   */
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
   * Downvote tallies + the viewer's own downvote state per generator key,
   * from the document store (`generator_marks`). Absent key = 0 / not
   * downvoted. Optional as a whole: no `onDownvote` = no downvote control.
   */
  downvotes?: Record<string, DownvoteState>;
  /** Toggle this viewer's downvote; resolves with the authoritative post-downvote count. */
  onDownvote?: (item: SharedListItem, nextDownvoted: boolean) => Promise<number>;
  /**
   * Resolved MODERATED urls of outputs published from a generator (kept
   * runs recorded at keep time), newest first. Rendered as the card's media
   * strip when the generator has no cover of its own — a generator people
   * have actually made things with should not read as raw text.
   */
  mediaUrlsFor?: (item: SharedListItem) => string[];
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
   * A viewer-facing sentence about the kept-run STORE, rendered over the gallery
   * with `onRetry` beside it, and suppressing the empty state.
   *
   * 🔴 THE ORIGINATING FAULT IS A FAILED READ. Not the same fact as "no kept
   * runs", and the difference is the whole reason this prop exists: rendering the
   * gallery's empty state over a failed read tells a viewer who has kept things
   * that they have not, which reads as data loss caused by this app.
   *
   * ⚠️ IT IS NO LONGER ONLY A READ, AND THIS DOC SAID IT WAS. `App` also sets it
   * when a post landed but the durable PRUNE could not be written
   * (`handlePostedImages`) — a *write* failure, where the list beside it is fully
   * reliable and merely over-reports by the ids that could not be pruned. So this
   * being set does NOT license treating `keptRuns` as untrustworthy: do not
   * suppress or grey the grid on the strength of it. If a future caller needs
   * behaviour that is right for one fault and wrong for the other, SPLIT THE
   * CHANNEL rather than keying off this string — the two carry the same prop and
   * different guarantees.
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
  const { c, loading, error, discover, discoverTruncated, myDrafts, myPublished, viewerId, onSignIn, onCreate, onOpenPublished, onOpenDraft, onEditDraft, onDeleteDraft, onDeletePublished, onVote, onDownvote, downvotes, mediaUrlsFor, onFork, onShare, onReport, coverUrlFor, keptRuns, keptTruncated = false, keptIncomplete = false, keptError = null, getImages, onOpenGeneratorKey, posting, onRequestSignIn, copyToClipboard, onRetry } = props;
  const [tabState, setTabState] = useState<Tab>('discover');
  const tab = props.section ?? tabState;
  const setTab = (next: Tab) => {
    if (props.onSectionChange) props.onSectionChange(next);
    else setTabState(next);
  };
  // The section switcher is a SLIDE-OUT sidebar: closed until the header's
  // menu button opens it, at every width. The nav itself is the upstream
  // civitai-nav-list web component (see the aside below).
  const [navOpen, setNavOpen] = useState(false);
  // Escape closes the sidebar — the keyboard way out of a slide-over.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);
  // Motion gate for the chrome Browse owns directly (draft cards). Cards rendered
  // by PublishedCard read it themselves.
  const motion = useMotion();
  // Confirm-gated withdraw of an own published generator.
  const [pendingDelete, setPendingDelete] = useState<SharedListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Discover controls: search, sort, incremental pagination.
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('new');
  // The sort control is the upstream civitai-menu: its `select` event is the
  // real-browser path; the items ALSO take onClick (below) so the choice
  // registers wherever the element has not upgraded (jsdom, older hosts).
  const sortMenuRef = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    el.addEventListener('select', (e: Event) => {
      const v = (e as CustomEvent<{ value?: string }>).detail?.value;
      if (v === 'new' || v === 'top') setSort(v);
    });
  }, []);
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

  // Downvote overlay: same optimistic + latest-click-wins discipline as the
  // upvote overlay, seeded from the document-store read (App's `downvotes`).
  const [downvoteOverlay, setDownvoteOverlay] = useState<Record<string, DownvoteState>>({});
  const downvoteState = (item: SharedListItem): DownvoteState =>
    downvoteOverlay[item.key] ?? downvotes?.[item.key] ?? { count: 0, downvoted: false };
  const downvoteSeq = useRef<Record<string, number>>({});

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
      // One vote per viewer per direction: casting an upvote clears the
      // viewer's downvote on the same generator first.
      if (nextVoted && onDownvote && downvoteState(item).downvoted) {
        const dc = await onDownvote(item, false);
        setDownvoteOverlay((o) => ({ ...o, [item.key]: { downvoted: false, count: dc } }));
      }
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

  async function toggleDownvote(item: SharedListItem) {
    if (!onDownvote) return;
    // Anonymous viewers can't mark — hand off to the App (which prompts
    // sign-in) WITHOUT an optimistic flash that would only revert.
    if (viewerId == null) {
      try {
        await onDownvote(item, true);
      } catch {
        /* App requested sign-in — nothing to roll back. */
      }
      return;
    }
    const cur = downvoteState(item);
    const nextDownvoted = !cur.downvoted;
    const seq = (downvoteSeq.current[item.key] ?? 0) + 1;
    downvoteSeq.current[item.key] = seq;
    const optimistic: DownvoteState = {
      downvoted: nextDownvoted,
      count: Math.max(0, cur.count + (nextDownvoted ? 1 : -1)),
    };
    setDownvoteOverlay((o) => ({ ...o, [item.key]: optimistic }));
    try {
      // Casting a downvote clears the viewer's upvote on the same generator.
      if (nextDownvoted && voteState(item).voted) {
        const upCount = await onVote(item, false);
        setVoteOverlay((o) => ({ ...o, [item.key]: { voted: false, count: upCount } }));
      }
      const count = await onDownvote(item, nextDownvoted);
      // Only the latest click applies its authoritative count.
      if (downvoteSeq.current[item.key] === seq) {
        setDownvoteOverlay((o) => ({ ...o, [item.key]: { downvoted: nextDownvoted, count } }));
      }
    } catch {
      if (downvoteSeq.current[item.key] === seq) {
        setDownvoteOverlay((o) => ({ ...o, [item.key]: cur }));
      }
    }
  }

  // Derived Discover list: filter by query, sort (newest = as-given, popular =
  // by effective NET score — upvotes minus downvotes — desc), then page.
  const filteredDiscover = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? discover.filter((it) => matchesQuery(it, q)) : discover.slice();
    if (sort === 'top') {
      const net = (it: SharedListItem) =>
        (voteOverlay[it.key]?.count ?? it.count) -
        (downvoteOverlay[it.key]?.count ?? downvotes?.[it.key]?.count ?? 0);
      base.sort((a, b) => net(b) - net(a));
    }
    return base;
  }, [discover, query, sort, voteOverlay, downvoteOverlay, downvotes]);
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
          <Button
            size="sm"
            variant="subtle"
            data-testid="nav-toggle"
            aria-label="Open menu"
            aria-expanded={navOpen}
            aria-controls="cg-sidebar"
            onClick={() => setNavOpen(true)}
            style={{ fontSize: 17, lineHeight: 1, padding: '4px 8px' }}
          >
            ☰
          </Button>
          <span aria-hidden="true" style={brandMarkStyle}>
            <BrandMarkIcon />
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

      {error && (
        <Alert color="error" data-testid="browse-error">
          {error}{' '}
          <Button size="sm" variant="light" data-testid="browse-retry" onClick={onRetry}>
            Retry
          </Button>
        </Alert>
      )}

      {/* ── Slide-out sidebar ─────────────────────────────────────────────
          The sections ride the upstream civitai-nav-list / civitai-nav-item
          web components; the slide-over chrome (scrim, transform, close) is
          the app's — the upstream docs ship nav PRIMITIVES, not a shell.
          Item clicks land on the host element, so routing works whether or
          not the element has upgraded yet. Selecting a section routes (App
          owns the page) and closes the sidebar. */}
      {navOpen && (
        <div
          data-testid="nav-scrim"
          onClick={() => setNavOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'var(--cg-scrim, rgba(0, 0, 0, 0.55))', zIndex: 940 }}
        />
      )}
      <aside
        id="cg-sidebar"
        data-testid="sidebar"
        data-open={navOpen ? 'true' : 'false'}
        aria-hidden={!navOpen}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          height: '100dvh',
          width: 264,
          maxWidth: '85vw',
          zIndex: 950,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          padding: 16,
          background: 'var(--civitai-color-surface)',
          borderRight: `1px solid ${token.border}`,
          boxShadow: navOpen ? '0 0 44px rgba(0, 0, 0, 0.4)' : 'none',
          transform: navOpen ? 'translateX(0)' : 'translateX(-102%)',
          transition: motion ? 'transform 240ms ease' : 'none',
        }}
      >
        <Group justify="space-between" align="center" wrap={false}>
          <Group gap={10} align="center" wrap={false} style={{ minWidth: 0 }}>
            <span aria-hidden="true" style={brandMarkStyle}>
              <BrandMarkIcon />
            </span>
            <span style={{ fontWeight: 700, fontSize: 15 }}>Custom Generators</span>
          </Group>
          <Button size="sm" variant="subtle" data-testid="nav-close" aria-label="Close menu" onClick={() => setNavOpen(false)}>
            ✕
          </Button>
        </Group>
        <nav aria-label="Sections">
          <civitai-nav-list label="Sections" current={SECTION_ROUTE[tab]}>
            {visibleTabs.map((t) => (
              <civitai-nav-item
                key={t}
                id={`tab-${t}`}
                data-testid={`tab-${t}`}
                href={SECTION_ROUTE[t]}
                label={TAB_LABELS[t]}
                current={tab === t}
                onClick={(e) => {
                  e.preventDefault();
                  setTab(t);
                  setNavOpen(false);
                }}
              >
                <span slot="label">
                  {TAB_LABELS[t]}
                  {t === 'kept' && keptTotal > 0 && (
                    <>
                      {' '}
                      <Badge variant="light" data-testid="tab-kept-count">
                        {keptTotal}
                      </Badge>
                    </>
                  )}
                </span>
              </civitai-nav-item>
            ))}
          </civitai-nav-list>
        </nav>
        <Button
          data-testid="nav-create"
          variant="light"
          leftSection="+"
          onClick={() => {
            setNavOpen(false);
            onCreate();
          }}
        >
          Create generator
        </Button>
      </aside>

      <div style={{ minWidth: 0 }}>

      {tab === 'discover' && (
        <div role="tabpanel" id="panel-discover" aria-labelledby="tab-discover" tabIndex={0}>
          <Stack gap={10} data-testid="discover-list">
            <p style={{ margin: 0, fontSize: 14, color: c.muted }} data-testid="discover-intro">
              Use premade generators for various specific purposes, copy and customize them, or build
              your own from scratch!
            </p>
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
              <civitai-menu label="Sort generators" data-testid="discover-sort" ref={sortMenuRef}>
                <Button
                  slot="trigger"
                  size="sm"
                  variant="light"
                  data-testid="discover-sort-button"
                  aria-label={`Sort generators, currently ${sort === 'new' ? 'Newest' : 'Popular'}`}
                >
                  ⇅ {sort === 'new' ? 'Newest' : 'Popular'}
                </Button>
                <civitai-menu-item value="new" data-testid="sort-new" onClick={() => setSort('new')}>
                  Newest
                </civitai-menu-item>
                <civitai-menu-item value="top" data-testid="sort-top" onClick={() => setSort('top')}>
                  Popular
                </civitai-menu-item>
              </civitai-menu>
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
            {!loading && filteredDiscover.length === 0 && (
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
                  downvoteCount={downvoteState(item).count}
                  downvoted={downvoteState(item).downvoted}
                  onDownvote={onDownvote ? () => toggleDownvote(item) : undefined}
                  mediaUrls={mediaUrlsFor?.(item) ?? []}
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
              {/* 🔴 NO HEDGE, AND THE ABSENCE IS THE FIX. This panel used to carry
                  a caveat gated on `viewerId != null && discoverTruncated`
                  ("Nothing published in the loaded page" / "anything you
                  published earlier may not be listed here"), because
                  `myPublished` was a CLIENT FILTER over the one discover page —
                  so an empty list genuinely could not tell "published nothing"
                  from "all your rows are past the page we read".
                  The rows now come from their own `mine=true` read over the whole
                  board, bounded by the server's per-author row cap, so empty is
                  not a statement about PAGE DEPTH and that caveat would be a
                  false statement about a page this list does not have.
                  (It is still not a statement that the viewer published nothing —
                  see the open defect below. This sentence used to read "so empty
                  means empty" HERE, mid-sentence, which the confined-rejection
                  change falsified; its ending is unchanged.)
                  `discoverTruncated` describes the
                  BOARD; it has nothing to say about the viewer's own rows, and
                  re-reading it here is the defect, not the disclosure.
                  🔴 THERE IS NO *PAGE* CAVEAT EITHER. The read asks for the
                  list route's own maximum (`SHARED_LIST_LIMIT_MAX` in `App.tsx`),
                  which the per-author row cap sits far below and cannot pass
                  without the route being widened in the same change — so this is
                  every row the viewer can hold, not a page of them, and a hedge
                  about depth in ANY spelling would be a false statement.
                  🔴 WHAT "empty means empty" DOES NOT COVER, AND THIS IS AN OPEN
                  DEFECT RATHER THAN A RESOLVED ONE. `App` now confines a REJECTED
                  `mine` read to this panel instead of blanking the whole view, and
                  it passes `[]` for that case — so an empty `myPublished` means
                  EITHER "the viewer has published nothing" OR "the read failed",
                  and the title below states the first of those unconditionally.
                  There is no `publishedError` prop to distinguish them, and adding
                  one was deliberately left out of the change that confined the
                  failure. Do not read the paragraphs above as covering it: they are
                  about PAGE DEPTH, which is a different question from whether the
                  read succeeded. `keptError` in `App.tsx` is the shape the fix
                  would take. */}
              {myPublished.length === 0 && (
                <EmptyState
                  data-testid="published-empty"
                  title="Nothing published yet"
                  body="Publish a generator from the builder to share it in Discover."
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
                    downvoteCount={downvoteState(item).count}
                    downvoted={downvoteState(item).downvoted}
                    onDownvote={onDownvote ? () => toggleDownvote(item) : undefined}
                    mediaUrls={mediaUrlsFor?.(item) ?? []}
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
                but possibly short, so the alert rides above it instead.
                ⚠️ The suppression is keyed on there being nothing to show, NOT
                on the fault: `keptError` also carries the post-prune WRITE
                failure (see the prop's own doc), where the list is reliable —
                and that arm can never reach `keptCells.length === 0`, because a
                rejected write puts its run back into `remaining`. */}
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
              // so the pair cannot come apart HERE — which is narrower than "no
              // mistake is possible": a deliberately-written fallback (`posting
              // ?? { onPosted: () => {} }`) still type-checks and still silently
              // drops the prune. The type closes the ordinary call-site error,
              // not that one.
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
      </div>

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

/** Share glyph (nodes-and-lines), drawn inline like the brand mark. */
function ShareIcon(): React.JSX.Element {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx={18} cy={5} r={3} />
      <circle cx={6} cy={12} r={3} />
      <circle cx={18} cy={19} r={3} />
      <line x1={8.59} y1={13.51} x2={15.42} y2={17.49} />
      <line x1={15.41} y1={6.51} x2={8.59} y2={10.49} />
    </svg>
  );
}

/** Make-a-copy glyph (two overlapping sheets). */
function CopyIcon(): React.JSX.Element {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x={9} y={9} width={13} height={13} rx={2} />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** A tinted rounded tile that holds the brand mark, styled entirely off
 * `--civitai-*` tokens. (The manifest's `page.icon` stays `wand` — that
 * enum is the host's, not the brand's.) */
const brandMarkStyle: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 38,
  height: 38,
  flexShrink: 0,
  borderRadius: radius.md,
  color: 'var(--civitai-color-primary-fg)',
  background: 'var(--cg-hot, var(--civitai-color-primary))',
  border: `1px solid ${token.border}`,
};

/**
 * The brand mark — the dome-on-cylinder BUTTON from `brand/icon.svg`
 * ("Build the button. Share the button."), drawn inline in the app's own
 * tones: bezel ring, plate gap, raised cap as three concentric circles.
 * Same geometry as the store icon, so recognition carries across the
 * store → app boundary; the store plate keeps its violet, the in-app
 * mark wears Forge primary.
 */
function BrandMarkIcon(): React.JSX.Element {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx={12} cy={12} r={9.5} stroke="currentColor" strokeWidth={2} opacity={0.45} />
      <circle cx={12} cy={12} r={6.2} fill="currentColor" />
      <circle cx={12} cy={12} r={2.7} fill="var(--civitai-color-body)" opacity={0.9} />
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
  downvoteCount,
  downvoted,
  onDownvote,
  mediaUrls,
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
  /** Downvote tally (document store) + the viewer's own downvote state. */
  downvoteCount: number;
  downvoted: boolean;
  /** When present, renders the downvote control (absent = signal unavailable). */
  onDownvote?: () => void;
  /**
   * Host-resolved MODERATED urls of outputs published from this generator.
   * Shown as a media strip when there is no cover — presence evidence that
   * people have made things with it, instead of a text-only card.
   */
  mediaUrls: string[];
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
  // 🔴 NO per-run Buzz on the card, deliberately: the figure was a heuristic
  // range, and the one true price is the host estimate on the run path —
  // which the Runner shows, and gates Confirm on. A guessed price here read
  // as a quote and competed with it.
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
        {!coverUrl && mediaUrls.length > 0 && (
          // Published output made with this generator (kept runs), resolved
          // through the same moderated gated read as covers.
          <div data-testid="published-media" style={{ display: 'flex', gap: 6 }}>
            {mediaUrls.map((url) => (
              <SafeImage
                key={url}
                src={url}
                alt=""
                style={{ flex: '1 1 0', minWidth: 0, height: 118, objectFit: 'cover', borderRadius: radius.md, border: `1px solid ${c.border}`, display: 'block' }}
              />
            ))}
          </div>
        )}
        <Group justify="space-between" align="flex-start" gap={12}>
          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{item.value.title || 'Untitled generator'}</div>
            {desc && (
              <div style={{ ...metaText, marginTop: 2 }} data-testid="published-desc">
                {desc}
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
            {onDownvote && (
              <Tooltip label={downvoted ? 'Remove your downvote' : 'Downvote this generator'}>
                <Button
                  size="sm"
                  variant={downvoted ? 'light' : 'subtle'}
                  data-testid="downvote-button"
                  aria-pressed={downvoted}
                  aria-label={downvoted ? 'Remove downvote' : 'Downvote'}
                  onClick={onDownvote}
                >
                  ▼{' '}
                  <Badge variant="light" data-testid="published-downvotes">
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{downvoteCount}</span>
                  </Badge>
                </Button>
              </Tooltip>
            )}
            {onShare && (
              <Tooltip label="Copy a share link">
                <Button size="sm" variant="subtle" data-testid="published-share" aria-label="Share" onClick={share}>
                  <ShareIcon />
                </Button>
              </Tooltip>
            )}
            {onFork && (
              <Tooltip label="Make a copy — fork into your own editable draft">
                <Button size="sm" variant="subtle" data-testid="published-fork" aria-label="Make a copy" onClick={onFork}>
                  <CopyIcon />
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
              Generate
            </Button>
          </Group>
        </Group>
      </Stack>
    </Card>
  );
}
