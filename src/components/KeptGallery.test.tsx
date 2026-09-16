// THE GALLERY'S OWN SEAMS — the gated read, what a withheld cell SAYS, and the
// two ways a cell used to get stuck forever.
//
// 🔴 EVERY EXPECTATION HERE IS A LITERAL, NEVER AN IMPORTED CONSTANT. The defect
// this file was written for was a sentence: a cell that said "Not shown at your
// browsing level" over the viewer's own just-published images. A test asserting
// `toHaveTextContent(HIDDEN_CELL_NOTICE)` would have passed against that sentence
// and against any replacement for it, which is exactly how the old
// `/browsing level/i` assertion came to entrench the wrong copy. Pinning the
// whole string means a reword fails this suite — that is the price of a
// machine-readable claim, and it is worth paying.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BlockGatedImage } from '@civitai/app-sdk/blocks';

import { KeptGallery } from './KeptGallery.js';
import { palette } from '../theme.js';
import type { KeptRun } from '../lib/runs.js';

const c = palette();

function run(over: Partial<KeptRun> = {}): KeptRun {
  return {
    id: 'k1',
    keptAt: 1_000,
    imageIds: [501],
    generatorName: 'Neon Portrait Studio',
    generatorKey: 'shared:99',
    buttonLabel: 'Cyberpunk',
    ...over,
  };
}

function visible(imageId: number): BlockGatedImage {
  return {
    imageId,
    status: 'visible',
    url: `https://img.example/${imageId}.jpg`,
    nsfwLevel: 1,
    contentRating: 'pg',
    width: 512,
    height: 512,
  };
}

function hidden(imageId: number): BlockGatedImage {
  return { imageId, status: 'hidden' };
}

type Props = Parameters<typeof KeptGallery>[0];

function props(over: Partial<Props> = {}): Props {
  return {
    runs: [run()],
    c,
    getImages: async (ids) => ids.map(visible),
    emptyTitle: 'Nothing kept yet',
    emptyBody: 'Keep a generation and it will be here next time.',
    onOpenCell: vi.fn(),
    ...over,
  };
}

/** One macrotask, so a `setTimeout(…, 0)` that WOULD have fired already has. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * 🔴 THE FLAGSHIP SURFACE MISLABELLED THE VIEWER'S OWN IMAGES, ON THE DOMINANT
 * PATH. Re-derived from civitai at 3bac90199d: `publishGenerationOutputs` persists
 * each output through `createImage` with no `skipIngestion`, and `Image.ingestion`
 * is `@default(Pending)` in `prisma/schema.prisma`; the gate
 * (`block-gated-images.logic.ts`) returns `hidden` for `ingestion !== Scanned`
 * with no owner bypass — *"an unscanned/flagged image is `hidden` for EVERYONE
 * (including its author)"*. Press Keep, and the gallery that mounts underneath
 * reads those ids within the same second: every cell comes back `hidden`, and the
 * app told the viewer Civitai was withholding their own work at their own
 * browsing level.
 */
describe('a withheld cell says why it MIGHT be withheld, and does not pick one', () => {
  it('names the scan as well as the browsing level', async () => {
    render(<KeptGallery {...props({ getImages: async (ids) => ids.map(hidden) })} />);

    const cell = await screen.findByTestId('kept-cell');
    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'hidden'));
    expect(within(cell).getByTestId('kept-cell-placeholder')).toHaveTextContent(
      'Still being checked, or above your browsing level',
    );
  });

  /**
   * The negative half, and the one that would have caught the original defect:
   * the old sentence asserted a cause the gate never supplied.
   */
  it('never blames the browsing level alone', async () => {
    render(<KeptGallery {...props({ getImages: async (ids) => ids.map(hidden) })} />);
    const cell = await screen.findByTestId('kept-cell');
    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'hidden'));
    expect(document.body.textContent).not.toContain('Not shown at your browsing level');
  });
});

/**
 * 🔴 A JUST-KEPT IMAGE IS `Pending`, SO IT IS `hidden` — AND NOTHING RE-ASKED.
 * The component pinned every id in a `requested` ref and never read it again, so
 * the image the viewer had just paid for stayed a placeholder until they left the
 * app and came back. One re-read is not a scan-time claim (nobody here has
 * measured that); it is one more chance, taken once.
 */
describe('one delayed re-read of a withheld cell', () => {
  it('shows the image when the second read resolves it', async () => {
    const getImages = vi
      .fn<(ids: number[]) => Promise<BlockGatedImage[]>>()
      .mockResolvedValueOnce([hidden(501)])
      .mockResolvedValue([visible(501)]);

    render(<KeptGallery {...props({ getImages, recheckDelayMs: 0 })} />);

    const cell = await screen.findByTestId('kept-cell');
    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'hidden'));
    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'visible'));
    expect(getImages).toHaveBeenCalledTimes(2);
  });

  /**
   * 🔴 ONCE, NOT A POLL. An image above the viewer's ceiling, or flagged, is
   * hidden permanently — re-asking forever would be a request loop per cell, on
   * a surface that renders up to `GALLERY_PAGE_SIZE` of them.
   */
  it('does not re-ask a second time when the image is still withheld', async () => {
    const getImages = vi.fn(async (ids: number[]) => ids.map(hidden));
    render(<KeptGallery {...props({ getImages, recheckDelayMs: 0 })} />);

    await waitFor(() => expect(getImages).toHaveBeenCalledTimes(2));
    await tick();
    await tick();
    expect(getImages).toHaveBeenCalledTimes(2);
  });

  it('NEGATIVE CONTROL: a cell the gate resolves is never re-read', async () => {
    const getImages = vi.fn(async (ids: number[]) => ids.map(visible));
    render(<KeptGallery {...props({ getImages, recheckDelayMs: 0 })} />);

    const cell = await screen.findByTestId('kept-cell');
    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'visible'));
    await tick();
    await tick();
    expect(getImages).toHaveBeenCalledTimes(1);
  });
});

/**
 * 🔴 REPRODUCED, NOT HYPOTHESISED. Ids were added to `requested` BEFORE the await
 * and the resolved batch was dropped whenever the effect had been torn down — so
 * a read cancelled mid-flight lost its result AND left its ids looking fetched.
 * Nothing could ever ask for them again: the cells sat at "Loading…" for the life
 * of the mount. The trigger was ordinary — `App` called `runsForGenerator(...)`
 * inline in the Runner's JSX, minting a fresh array identity on every App render,
 * which re-ran this effect and cancelled whatever was in flight.
 */
describe('a read cancelled in flight does not strand its cells', () => {
  it('still resolves after the runs prop changes identity mid-read', async () => {
    let release!: (images: BlockGatedImage[]) => void;
    const getImages = vi.fn(
      () =>
        new Promise<BlockGatedImage[]>((resolve) => {
          release = resolve;
        }),
    );
    const base = props({ getImages });
    const { rerender } = render(<KeptGallery {...base} runs={[run()]} />);
    await waitFor(() => expect(getImages).toHaveBeenCalledTimes(1));

    // A NEW ARRAY, SAME CONTENT — exactly what the inline call minted per render.
    rerender(<KeptGallery {...base} runs={[run()]} />);
    release([visible(501)]);

    const cell = await screen.findByTestId('kept-cell');
    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'visible'));
  });

  /**
   * 🔴 THE OTHER HALF OF THAT CLEANUP LINE, WHICH NOTHING OBSERVED. The release
   * is guarded by `!settled`: it exists to un-strand a read torn down IN FLIGHT,
   * and must not re-open ids whose read already completed. Removing the guard —
   * releasing unconditionally — left the whole suite green, so the narrowing
   * clause read as coverage while having none, and the next person to "simplify"
   * it would have had a green run agreeing with them.
   *
   * The identity churn here is the same one the test above reproduces; the only
   * difference is that the read has SETTLED first, which is precisely the arm the
   * guard selects. An unguarded release re-requests id 501 on the rerender, so
   * the mutant differs from HEAD by exactly this call count.
   */
  it('does NOT re-ask for ids whose read already settled', async () => {
    const getImages = vi.fn(async (ids: number[]) => ids.map(visible));
    const base = props({ getImages });
    const { rerender } = render(<KeptGallery {...base} runs={[run()]} />);

    const cell = await screen.findByTestId('kept-cell');
    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'visible'));
    expect(getImages).toHaveBeenCalledTimes(1);

    // A NEW ARRAY, SAME CONTENT — the effect re-runs and its cleanup fires, but
    // this read is done, so there is nothing to un-strand.
    rerender(<KeptGallery {...base} runs={[run()]} />);
    expect(getImages).toHaveBeenCalledTimes(1);
  });
});

/**
 * 🔴 THE ALERT PROMISED A RETRY IT DID NOT HAVE. The catch arm released the ids
 * "to allow a retry" and rendered a notice with no control on it; the only thing
 * that ever re-fired the read was the identity bug above.
 */
describe('a failed gated read can actually be retried', () => {
  it('offers a control that re-asks the gate and clears the notice', async () => {
    const getImages = vi
      .fn<(ids: number[]) => Promise<BlockGatedImage[]>>()
      .mockRejectedValueOnce(new Error('host exploded'))
      .mockResolvedValue([visible(501)]);

    render(<KeptGallery {...props({ getImages })} />);

    await screen.findByTestId('kept-gallery-error');
    await userEvent.click(screen.getByTestId('kept-gallery-retry'));

    const cell = await screen.findByTestId('kept-cell');
    await waitFor(() => expect(cell).toHaveAttribute('data-state', 'visible'));
    expect(screen.queryByTestId('kept-gallery-error')).not.toBeInTheDocument();
    expect(getImages).toHaveBeenCalledTimes(2);
  });
});

/**
 * 🔴 THE NOTICE STATED A COUNT IT HAD NOT COUNTED. It opened *"Showing 200 kept
 * runs"* — a hardcoded constant — while the same component renders one
 * generator's runs in the Runner and a malformed-row-filtered set in Browse. A
 * number the component did not derive is a number it cannot keep, so there is
 * none.
 */
describe('the truncation notice', () => {
  it('claims no count', async () => {
    render(<KeptGallery {...props({ truncated: true })} />);
    const notice = await screen.findByTestId('kept-gallery-truncated');
    expect(notice).toHaveTextContent(
      'Older keeps aren’t shown here — this app loads your most recent ones.',
    );
    expect(notice.textContent).not.toMatch(/\d/);
  });

  it('NEGATIVE CONTROL: an untruncated gallery renders no notice', async () => {
    render(<KeptGallery {...props()} />);
    await screen.findByTestId('kept-cell');
    expect(screen.queryByTestId('kept-gallery-truncated')).not.toBeInTheDocument();
  });

  /**
   * 🔴 THE SENTENCE INVERTED IN THE STATE THAT RENDERED IT. "this app loads your
   * most recent ones" is true of a key walk that reached the end of the store.
   * When the walk stops at `KEPT_LIST_MAX_PAGES` the app holds the tail of a
   * PREFIX, so the keeps it is missing are the viewer's newest — and the notice
   * above was being rendered over exactly that, telling them the opposite.
   *
   * Both flags are set here because both are true of that state (a cut-short
   * walk is always also truncated), which is the case the component has to
   * disambiguate. Whole strings, per this file's header rule.
   */
  it('says the opposite thing when the key walk was cut short', async () => {
    render(<KeptGallery {...props({ truncated: true, incomplete: true })} />);
    const notice = await screen.findByTestId('kept-gallery-truncated');
    expect(notice).toHaveTextContent(
      'You’ve kept more than this app can list — your newest keeps may not be shown here.',
    );
    expect(notice).not.toHaveTextContent(
      'Older keeps aren’t shown here — this app loads your most recent ones.',
    );
  });
});
