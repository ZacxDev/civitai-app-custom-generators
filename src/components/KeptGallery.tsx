// THE APP'S OWN GALLERY — the kept images a viewer has made here, resolved back
// through the host's per-viewer moderation gate.
//
// 🔴 THIS IS THE TERMINAL THE APP DID NOT HAVE. A run used to end at a thumbnail
// in a queue documented as in-session, so "press a stranger's button and spend
// Buzz" produced nothing that outlived the tab. A kept run stores durable civitai
// `Image` ids (see lib/runs.ts); this component is where they come back.
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
// same fact as a hidden one. `hidden` means "you may not see this"; omitted means
// "this is gone". Rendering either as a broken `<img>` would be a moderation
// failure in the first case and a lie in the second.

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
  'data-testid': testId = 'kept-gallery',
}: KeptGalleryProps) {
  const motion = useMotion();
  const feed = useMemo(() => keptImageFeed(runs), [runs]);
  const [visibleCount, setVisibleCount] = useState(GALLERY_PAGE_SIZE);
  const [gated, setGated] = useState<Record<number, GatedState>>({});
  const [readError, setReadError] = useState<string | null>(null);

  // Ids already requested, so a re-render (or a newly-kept run appended to the
  // list) re-reads only what is genuinely new. A ref rather than state: it must
  // not itself re-trigger the effect it guards.
  const requested = useRef<Set<number>>(new Set());

  const wantedIds = useMemo(
    () => feed.slice(0, visibleCount).map((cell) => cell.imageId),
    [feed, visibleCount],
  );

  useEffect(() => {
    const missing = wantedIds.filter((id) => !requested.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requested.current.add(id);
    let cancelled = false;
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
      } catch (e) {
        // 🔴 Surfaced, not swallowed. A failed gated read leaves the seeded
        // `missing` states, which render as placeholders — indistinguishable
        // from "these images are gone" unless the failure is stated.
        if (!cancelled) {
          setReadError('Couldn’t load your kept images just now.');
          // Allow a retry to re-request these ids.
          for (const id of missing) requested.current.delete(id);
        }
      }
      if (!cancelled) setGated((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [wantedIds, getImages]);

  if (feed.length === 0) {
    return (
      <EmptyState data-testid={`${testId}-empty`} title={emptyTitle} body={emptyBody} action={emptyAction} />
    );
  }

  const visible = feed.slice(0, visibleCount);

  return (
    <Stack gap={10} data-testid={testId}>
      {readError && (
        <Alert color="warning" data-testid={`${testId}-error`}>
          {readError}
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
                        ? 'Not shown at your browsing level'
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
