// THE APP'S OWN GALLERY — the kept images a viewer has made here, resolved back
// through the host's per-viewer moderation gate.
//
// 🔴 THIS IS THE TERMINAL THE APP DID NOT HAVE. Precisely: a run used to end at a
// thumbnail in a queue documented as in-session, and while the images did reach
// the viewer's Civitai feed, the APP retained nothing — no record that the run
// happened, no link from an image to the generator that made it, no way back to
// it from inside the block. A kept run stores durable civitai `Image` ids (see
// lib/runs.ts); this component is where they come back, attributed.
//
// 🔴 IDS IN, URLS RESOLVED PER RENDER — never the other way round. `getImages`
// applies THIS viewer's browsing-level clamp server-side at read time, so a kept
// image whose moderation status later changes is re-evaluated on every view. A
// url cached at keep time would be a snapshot of a permission, which is exactly
// the mistake the cover-image path already refuses to make.
//
// 🔴 THREE OUTCOMES, ALL RENDERED, NONE COLLAPSED. The gate returns `visible`
// (url) or `hidden` (NO url), and OMITS ids it cannot resolve at all — so the
// returned array may be SHORTER than the request and a missing entry is not the
// same fact as a hidden one. `hidden` means "not being served to you right now"
// — which covers a still-scanning image as well as one above this viewer's
// ceiling, and the gate does not say which (see {@link HIDDEN_CELL_NOTICE});
// omitted means "this is gone". Rendering either as a broken `<img>` would be a
// moderation failure in the first case and a lie in the second.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { BlockGatedImage } from '@civitai/app-sdk/blocks';
import { Alert, Button, Group, Stack } from '@civitai/blocks-react/ui';
import { Image } from '@civitai/components-react';

import { chunkImageIds, keptImageFeed, type KeptImageCell, type KeptRun } from '../lib/runs.js';
import { CLASS_LIFT, motionClass, useMotion } from '../motion.js';
import { elevate, metaText, radius, type Palette } from '../theme.js';
import { EmptyState } from './EmptyState.js';

/** Cells revealed per "Show more" click. */
export const GALLERY_PAGE_SIZE = 12;

/**
 * 🔴 NO NUMBER, DELIBERATELY. This notice used to open *"Showing 200 kept
 * runs"* — a hardcoded constant rendered over whatever the grid actually had.
 * In the Runner, where the same component renders one generator's runs, that
 * told a viewer with two kept runs they were looking at two hundred; in Browse
 * it overstated whenever malformed rows were dropped. A count the component has
 * not derived from what it rendered is a claim it cannot keep, so there is none:
 * what remains is the one fact `truncated` actually carries.
 *
 * Bounded by what the code can see. `lib/runs.ts` walks the viewer's keys to the
 * end of the store and hydrates the TAIL, so "your most recent ones" is what the
 * grid holds, and `truncated` means kept runs exist outside it (see
 * `KeptRunPage` in `lib/runs.ts`).
 */
export const TRUNCATION_NOTICE =
  'Older keeps aren’t shown here — this app loads your most recent ones.';

/**
 * What a cell says when the gate returned `hidden`.
 *
 * 🔴 THE DOMINANT CAUSE IS THE SCAN, NOT THE BROWSING LEVEL, AND THIS LINE USED
 * TO NAME ONLY THE BROWSING LEVEL. `publishGenerationOutputs` creates each row
 * with `createImage` DEFAULT ingestion, which Prisma defaults to `Pending`, and
 * the gate (`block-gated-images.logic.ts`) returns `hidden` for anything not
 * terminally `Scanned` — with NO owner bypass, in its own words *"an
 * unscanned/flagged image is `hidden` for EVERYONE (including its author)"*. So
 * on the ordinary path — press Keep, the gallery mounts below the result and
 * reads within the same second — the viewer's own just-paid-for images come back
 * `hidden`, and *"Not shown at your browsing level"* told them Civitai had
 * withheld their own work from them.
 *
 * Both causes are named because the gate genuinely collapses them: `hidden`
 * carries no reason, so the component cannot know which one applies and must not
 * pick. The scan is named first because it is the one that resolves itself.
 */
export const HIDDEN_CELL_NOTICE = 'Still being checked, or above your browsing level';

/**
 * How long after a `hidden` verdict the gallery re-reads those ids once.
 *
 * 🔴 A HEURISTIC, NOT A MEASURED SCAN TIME. Nobody here has measured how long
 * `Pending` → `Scanned` takes, and this number is not a claim about it: it buys
 * one extra chance for a freshly-kept image to appear without the viewer having
 * to leave and come back. When the scan is slower, the cell keeps saying what it
 * says — which is true either way — and the next mount re-reads.
 *
 * Exactly ONE re-read per id, tracked in a ref, so a permanently-hidden image
 * (above the viewer's ceiling, flagged) can never become a polling loop.
 */
export const GALLERY_RECHECK_MS = 20_000;

/** What the gate said about one id, or `'missing'` when it said nothing at all. */
export type GatedState = BlockGatedImage | { imageId: number; status: 'missing' };

export interface KeptGalleryProps {
  runs: KeptRun[];
  c: Palette;
  /** Host gated read. Rejections are surfaced, never swallowed into an empty grid. */
  getImages: (imageIds: number[]) => Promise<BlockGatedImage[]>;
  emptyTitle: string;
  emptyBody: string;
  /** Rendered inside the empty panel (e.g. a "run something" CTA). */
  emptyAction?: React.ReactNode;
  /** Open the lightbox on a cell. */
  onOpenCell: (cell: KeptImageCell, url: string | null) => void;
  /** Show each cell's "Made with <generator>" caption (off inside one generator). */
  withAttribution?: boolean;
  /**
   * Kept runs exist that are not in `runs`. Renders {@link TRUNCATION_NOTICE}.
   *
   * 🔴 ONLY MEANINGFUL WHEN `runs` IS THE WHOLE LOADED SET. The flag is global
   * (it describes the viewer's store), so a caller that has FILTERED `runs` —
   * the Runner, which scopes to one generator — must not pass it: the notice
   * would be a global fact rendered as if it described the grid beneath it.
   */
  truncated?: boolean;
  /**
   * Delay before the single re-read of `hidden` ids. See
   * {@link GALLERY_RECHECK_MS} — it is a heuristic, and tests set it to 0.
   */
  recheckDelayMs?: number;
  'data-testid'?: string;
}

export function KeptGallery({
  runs,
  c,
  getImages,
  emptyTitle,
  emptyBody,
  emptyAction,
  onOpenCell,
  withAttribution = false,
  truncated = false,
  recheckDelayMs = GALLERY_RECHECK_MS,
  'data-testid': testId = 'kept-gallery',
}: KeptGalleryProps) {
  const motion = useMotion();
  const feed = useMemo(() => keptImageFeed(runs), [runs]);
  const [visibleCount, setVisibleCount] = useState(GALLERY_PAGE_SIZE);
  const [gated, setGated] = useState<Record<number, GatedState>>({});
  const [readError, setReadError] = useState<string | null>(null);
  /** Bumped to re-run the read effect after a recheck or a manual retry. */
  const [readTick, setReadTick] = useState(0);

  // Ids already requested, so a re-render (or a newly-kept run appended to the
  // list) re-reads only what is genuinely new. A ref rather than state: it must
  // not itself re-trigger the effect it guards.
  const requested = useRef<Set<number>>(new Set());
  /** Ids whose one automatic re-read has been spent. See GALLERY_RECHECK_MS. */
  const rechecked = useRef<Set<number>>(new Set());

  const wantedIds = useMemo(
    () => feed.slice(0, visibleCount).map((cell) => cell.imageId),
    [feed, visibleCount],
  );

  useEffect(() => {
    const missing = wantedIds.filter((id) => !requested.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requested.current.add(id);
    let cancelled = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      // 🔴 Seed EVERY requested id as `missing` first. The gate OMITS ids it
      // cannot resolve, so an id that never comes back would otherwise sit
      // undefined forever and render as a perpetual skeleton — a spinner that
      // means "this is gone" is the worst of both readings.
      const next: Record<number, GatedState> = {};
      for (const id of missing) next[id] = { imageId: id, status: 'missing' };
      try {
        // Chunked: the host rejects a request carrying more than
        // GATED_READ_MAX_IDS ids outright rather than truncating it.
        for (const batch of chunkImageIds(missing)) {
          const images = await getImages(batch);
          for (const img of images) next[img.imageId] = img;
        }
        if (!cancelled) setReadError(null);
      } catch {
        // 🔴 Surfaced, not swallowed. A failed gated read leaves the seeded
        // `missing` states, which render as placeholders — indistinguishable
        // from "these images are gone" unless the failure is stated. The ids go
        // back in the pool so the Try again control below can re-ask for them.
        if (!cancelled) setReadError('Couldn’t load your kept images just now.');
        for (const id of missing) requested.current.delete(id);
      }
      settled = true;
      if (!cancelled) setGated((prev) => ({ ...prev, ...next }));

      // ONE delayed re-read for ids the gate withheld. A just-published image is
      // `Pending` ingestion and therefore `hidden`; this is the only way it
      // becomes visible without the viewer leaving and coming back.
      const stillHidden = missing.filter(
        (id) => next[id]?.status === 'hidden' && !rechecked.current.has(id),
      );
      if (!cancelled && stillHidden.length > 0) {
        timer = setTimeout(() => {
          for (const id of stillHidden) {
            rechecked.current.add(id);
            requested.current.delete(id);
          }
          setReadTick((n) => n + 1);
        }, recheckDelayMs);
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // 🔴 THE FIX FOR A REPRODUCED STRAND. Ids enter `requested` BEFORE the
      // await and a cancelled batch's result is dropped, so without this line a
      // read torn down mid-flight left its cells at "Loading…" for the life of
      // the mount: the result was thrown away and the ids still looked fetched,
      // so nothing could ever ask again. The trigger was ordinary — `App` built
      // the Runner's `runs` array inline in JSX, minting a new identity every
      // render. Releasing them costs one repeat read of a batch already in
      // flight; stranding them costs the image.
      if (!settled) for (const id of missing) requested.current.delete(id);
    };
  }, [wantedIds, getImages, readTick, recheckDelayMs]);

  /** Re-ask the gate for everything on screen. Wired to the failed-read Alert. */
  const retryRead = () => {
    requested.current.clear();
    setReadError(null);
    setReadTick((n) => n + 1);
  };

  // 🔴 Rendered ALONGSIDE whatever the grid shows, never instead of it — and in
  // the empty branch too. `truncated` with an empty feed means every hydrated row
  // was unparseable while runs the app never loaded still exist, and "nothing
  // kept yet" is the worst available reading of that state.
  const notice = truncated ? (
    <span style={metaText} role="status" data-testid={`${testId}-truncated`}>
      {TRUNCATION_NOTICE}
    </span>
  ) : null;

  if (feed.length === 0) {
    return (
      <Stack gap={10} data-testid={testId}>
        {notice}
        <EmptyState data-testid={`${testId}-empty`} title={emptyTitle} body={emptyBody} action={emptyAction} />
      </Stack>
    );
  }

  const visible = feed.slice(0, visibleCount);

  return (
    <Stack gap={10} data-testid={testId}>
      {notice}
      {readError && (
        <Alert color="warning" data-testid={`${testId}-error`}>
          <Stack gap={8}>
            <span>{readError}</span>
            <Group>
              <Button size="sm" variant="light" data-testid={`${testId}-retry`} onClick={retryRead}>
                Try again
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))',
          gap: 10,
        }}
      >
        {visible.map((cell) => {
          const state = gated[cell.imageId];
          const url = state && state.status === 'visible' ? state.url : null;
          const resolved = state != null;
          return (
            <Stack gap={4} key={`${cell.run.id}-${cell.imageId}`}>
              <button
                type="button"
                data-testid="kept-cell"
                data-image-id={cell.imageId}
                data-state={state?.status ?? 'loading'}
                // Only a resolvable cell opens: a `hidden`/`missing` cell has
                // nothing to enlarge, so it is inert rather than a button that
                // opens an empty view.
                disabled={!url}
                aria-label={
                  url
                    ? `View result from ${cell.run.generatorName}`
                    : `Result from ${cell.run.generatorName} — not available`
                }
                className={motionClass(motion, url ? CLASS_LIFT : undefined)}
                onClick={() => onOpenCell(cell, url)}
                style={{
                  all: 'unset',
                  cursor: url ? 'pointer' : 'default',
                  display: 'block',
                  width: '100%',
                  aspectRatio: '1 / 1',
                  borderRadius: radius.md,
                  border: `1px solid ${c.border}`,
                  overflow: 'hidden',
                  background: elevate(2),
                  boxSizing: 'border-box',
                }}
              >
                {url ? (
                  <Image
                    src={url}
                    alt={`Result from ${cell.run.generatorName}`}
                    loading="lazy"
                    fallback="Image unavailable"
                    wrapperStyle={{ width: '100%', height: '100%' }}
                  />
                ) : (
                  <span
                    data-testid="kept-cell-placeholder"
                    style={{
                      ...metaText,
                      display: 'grid',
                      placeItems: 'center',
                      height: '100%',
                      padding: 8,
                      textAlign: 'center',
                    }}
                  >
                    {!resolved
                      ? 'Loading…'
                      : state.status === 'hidden'
                        ? HIDDEN_CELL_NOTICE
                        : 'No longer available'}
                  </span>
                )}
              </button>
              {withAttribution && (
                <span style={metaText} data-testid="kept-cell-attribution">
                  {cell.run.generatorName}
                </span>
              )}
            </Stack>
          );
        })}
      </div>
      {feed.length > visibleCount && (
        <Group justify="center">
          <Button
            size="sm"
            variant="light"
            data-testid={`${testId}-show-more`}
            onClick={() => setVisibleCount((n) => n + GALLERY_PAGE_SIZE)}
          >
            Show more ({feed.length - visibleCount})
          </Button>
        </Group>
      )}
    </Stack>
  );
}
