// THE TERMINAL — keeping a run, and the payoff view.
//
// Covers the whole arm against injected seams: the happy path, a rejected keep
// (which must NOT lose the run), a host that consents but resolves nothing, the
// double-press guard, and the full-size view with its attribution and paging.
//
// 🔴 A HAPPY-PATH-ONLY SUITE HAS NOT TESTED A BRIDGE. Every failure arm below was
// watched red before it was watched green (see the PR description's matrix).

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockGatedImage } from '@civitai/app-sdk/blocks';

import { Runner } from './Runner.js';
import { palette } from '../theme.js';
import { newButton, newGenerator } from '../lib/generator.js';
import type { KeptRun } from '../lib/runs.js';
import { GENERATION_SOURCE_IMAGE, immediateSleep, mockWorkflow } from '../test-helpers.js';
import type { GeneratorConfig } from '../types.js';

const c = palette();

function txtConfig(): GeneratorConfig {
  return newGenerator({
    name: 'Neon Portrait Studio',
    buttons: [
      newButton({
        id: 'b1',
        label: 'Cyberpunk',
        workflowType: 'txt2img',
        checkpoint: { versionId: 1001, modelId: 500, modelName: 'DreamShaper', versionName: '8' },
        loras: [{ versionId: 2002, weight: 0.8 }],
        promptTemplate: 'cyberpunk {prompt}',
        params: { ...newButton().params, width: 768, height: 1024, quantity: 1 },
      }),
    ],
  });
}

function renderRunner(over: Partial<Parameters<typeof Runner>[0]> = {}, images = ['res-a.jpg']) {
  const wf = mockWorkflow({ cost: 12, images, polls: 1 });
  const props = {
    config: txtConfig(),
    sharedContentKey: 'shared:99',
    c,
    canGenerate: true,
    buzzBalance: 5000,
    onRequestConsent: vi.fn(),
    uploadSourceImage: vi.fn(async () => GENERATION_SOURCE_IMAGE),
    estimate: wf.estimate,
    submit: wf.submit,
    poll: wf.poll,
    onBack: vi.fn(),
    pollIntervalMs: 0,
    sleep: immediateSleep,
    ...over,
  };
  render(<Runner {...props} />);
  return { props, wf };
}

type KeepArgs = { workflowId: string; imageIndexes?: number[]; title?: string };
type GetImages = (imageIds: number[]) => Promise<BlockGatedImage[]>;

/** A `keepOutputs` double that keeps its argument type, so calls can be asserted. */
function keepFn(impl: (args: KeepArgs) => Promise<number[]>) {
  return vi.fn(impl);
}

/** An `onKeepRun` double that keeps its argument type, so the record can be asserted. */
function keepRunFn() {
  return vi.fn(async (_run: KeptRun) => {});
}

/** Drive a generation through to a succeeded result grid. */
async function generate(prompt = 'a fox') {
  await userEvent.type(screen.getByTestId('runner-prompt'), prompt);
  await userEvent.click(screen.getByTestId('gen-button'));
  await userEvent.click(await screen.findByTestId('queue-confirm'));
  await screen.findByTestId('queue-results');
}

describe('Runner — the preset card tells you what the button is', () => {
  it('shows the recipe, the approximate cost and the requirement BEFORE the press', async () => {
    renderRunner();
    const card = screen.getByTestId('gen-button');
    // The three things a runner could not previously know about a stranger's button.
    expect(within(card).getByTestId('preset-recipe')).toHaveTextContent('DreamShaper 8 · 1 LoRA · 768×1024');
    expect(within(card).getByTestId('preset-cost')).toHaveTextContent(/≈ \d+ ⚡/);
    expect(within(card).getByTestId('preset-needs')).toHaveTextContent(/needs a prompt/i);
    expect(within(card).getByTestId('preset-label')).toHaveTextContent('Cyberpunk');
  });
});

describe('Runner — KEEP: the app terminal', () => {
  it('publishes the run, records durable IDS, and settles the card to Kept', async () => {
    const keepOutputs = keepFn(async () => [4242]);
    const onKeepRun = keepRunFn();
    renderRunner({ keepOutputs, onKeepRun });
    await generate();

    await userEvent.click(screen.getByTestId('result-keep'));

    // The bridge is called with the workflow id — never with urls, which the
    // block is not trusted to supply.
    await waitFor(() => expect(keepOutputs).toHaveBeenCalledTimes(1));
    expect(keepOutputs.mock.calls[0][0]).toMatchObject({ workflowId: 'wf', title: 'Neon Portrait Studio' });
    expect(keepOutputs.mock.calls[0][0]).not.toHaveProperty('imageUrls');

    // The persisted record carries the IDS the host returned, plus attribution.
    await waitFor(() => expect(onKeepRun).toHaveBeenCalledTimes(1));
    const saved = onKeepRun.mock.calls[0][0];
    expect(saved.imageIds).toEqual([4242]);
    expect(saved.generatorName).toBe('Neon Portrait Studio');
    expect(saved.generatorKey).toBe('shared:99');
    expect(saved.buttonLabel).toBe('Cyberpunk');
    expect(saved.prompt).toBe('a fox');

    // 🔴 Not a url in sight — the whole point of storing ids.
    expect(JSON.stringify(saved)).not.toContain('res-a.jpg');

    expect(await screen.findByTestId('result-kept')).toHaveTextContent(/kept/i);
    expect(screen.queryByTestId('result-keep')).not.toBeInTheDocument();
  });

  it('shows what it is waiting for while the host consent dialog is open', async () => {
    let release!: (ids: number[]) => void;
    const keepOutputs = vi.fn(() => new Promise<number[]>((res) => { release = res; }));
    renderRunner({ keepOutputs, onKeepRun: vi.fn(async () => {}) });
    await generate();

    await userEvent.click(screen.getByTestId('result-keep'));
    // The call waits on a PERSON (a 10-minute ceiling), so an anonymous spinner
    // is not enough — say what is being waited on.
    expect(await screen.findByTestId('result-keep-pending')).toHaveTextContent(/confirm in the civitai dialog/i);

    release([1]);
    await screen.findByTestId('result-kept');
  });

  /**
   * 🔴 THE RUN IS NEVER LOST TO A FAILED KEEP. The images are still there, the
   * Buzz is still spent, and the card returns to an offerable state. Losing the
   * whole result to a failed optional extra is what teaches people not to press
   * the button.
   */
  it('a rejected keep leaves the run intact, offers a retry, and never renders the host text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Free, server-authored, UNSANITISED text — the same class the estimate path
    // already refuses to render.
    const hostText = 'RAW SERVER DETAIL <script>alert(1)</script> rate limit 42';
    const keepOutputs = keepFn(async () => {
      throw new Error(hostText);
    });
    const onKeepRun = keepRunFn();
    renderRunner({ keepOutputs, onKeepRun });
    await generate();

    await userEvent.click(screen.getByTestId('result-keep'));

    const notice = await screen.findByTestId('result-keep-failed');
    expect(notice).toHaveTextContent(/weren’t kept/i);
    // The host's own words never reach the screen…
    expect(document.body.textContent).not.toContain('RAW SERVER DETAIL');
    expect(document.body.textContent).not.toContain('rate limit 42');
    // …but they are not thrown away either.
    expect(warn).toHaveBeenCalled();

    // The result grid survives, nothing was recorded, and a retry is offered.
    expect(screen.getByTestId('queue-results')).toBeInTheDocument();
    expect(onKeepRun).not.toHaveBeenCalled();
    expect(screen.getByTestId('result-keep')).toHaveTextContent(/try keeping again/i);
    warn.mockRestore();
  });

  /**
   * 🔴 A host that consents but resolves NOTHING is not a success. Writing a kept
   * run with an empty id list would produce a record `isKeptRun` rejects on read —
   * so the gallery the viewer was just told they had added to would silently not
   * contain it.
   */
  it('treats an empty id list as a failure rather than recording an imageless run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const keepOutputs = keepFn(async () => [] as number[]);
    const onKeepRun = keepRunFn();
    renderRunner({ keepOutputs, onKeepRun });
    await generate();

    await userEvent.click(screen.getByTestId('result-keep'));

    expect(await screen.findByTestId('result-keep-failed')).toBeInTheDocument();
    expect(onKeepRun).not.toHaveBeenCalled();
    expect(screen.queryByTestId('result-kept')).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it('a second press while one is in flight does not raise a second consent dialog', async () => {
    let release!: (ids: number[]) => void;
    const keepOutputs = vi.fn(() => new Promise<number[]>((res) => { release = res; }));
    renderRunner({ keepOutputs, onKeepRun: vi.fn(async () => {}) });
    await generate();

    const keep = screen.getByTestId('result-keep');
    await userEvent.click(keep);
    await screen.findByTestId('result-keep-pending');
    // The control is disabled while in flight; force the handler anyway to prove
    // the guard is in the handler and not merely in the disabled attribute.
    await userEvent.click(keep);
    expect(keepOutputs).toHaveBeenCalledTimes(1);

    release([7]);
    await screen.findByTestId('result-kept');
    expect(keepOutputs).toHaveBeenCalledTimes(1);
  });

  it('hides the Keep affordance entirely when the app is not wired for it (no dead button)', async () => {
    renderRunner(); // no keepOutputs
    await generate();
    expect(screen.queryByTestId('result-keep')).not.toBeInTheDocument();
    // …and the rest of the rail is unaffected.
    expect(screen.getByTestId('result-rerun')).toBeInTheDocument();
  });

  /**
   * 🔴 A FAILED RECORD IS NOT A FAILED PUBLISH, AND THE RETRY MUST NOT REPUBLISH.
   * `keepOutputs` is a real publish — the host fetches each output server-side,
   * re-uploads it to the image store and creates a durable `Image` row (civitai
   * `blocks.router` → `persistBlockWorkflowOutputImage`, once per selected
   * output, with no dedupe) — while `onKeepRun` is a KV write that can fail on
   * its own, and does so PERMANENTLY once the viewer is at the per-user row or
   * byte ceiling (`USER_ROW_LIMIT` 1,000 / `USER_QUOTA_BYTES` 2 MiB, shared with
   * this app's drafts) because the gallery is add-only. Both under one `try` made
   * "Try keeping again" an unbounded duplicate-publish loop.
   */
  it('does NOT re-publish when only the app-side record failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const keepOutputs = keepFn(async () => [4242]);
    const onKeepRun = vi.fn(async (_run: KeptRun) => {
      throw new Error('quota exceeded');
    });
    renderRunner({ keepOutputs, onKeepRun });
    await generate();

    await userEvent.click(screen.getByTestId('result-keep'));
    await screen.findByTestId('result-keep-failed');
    expect(keepOutputs).toHaveBeenCalledTimes(1);
    expect(onKeepRun).toHaveBeenCalledTimes(1);

    // The retry re-attempts the WRITE and nothing else — the rows already exist.
    await userEvent.click(screen.getByTestId('result-keep'));
    await waitFor(() => expect(onKeepRun).toHaveBeenCalledTimes(2));
    expect(keepOutputs).toHaveBeenCalledTimes(1);
    // …and the ids it records are the ones the first publish returned.
    expect(onKeepRun.mock.calls[1][0].imageIds).toEqual([4242]);
    warn.mockRestore();
  });

  it('says what actually happened when the record failed over a real publish', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const keepOutputs = keepFn(async () => [4242]);
    const onKeepRun = vi.fn(async (_run: KeptRun) => {
      throw new Error('quota exceeded');
    });
    renderRunner({ keepOutputs, onKeepRun });
    await generate();
    await userEvent.click(screen.getByTestId('result-keep'));

    const notice = await screen.findByTestId('result-keep-failed');
    // 🔴 The rows exist. "These images weren't kept" was false in this branch,
    // and it is the sentence that sent people back through a paid publish.
    expect(notice).toHaveTextContent(
      'Civitai saved these images, but this app couldn’t add them to your gallery. Trying again won’t create duplicates.',
    );
    expect(notice.textContent).not.toContain('weren’t kept');
    warn.mockRestore();
  });

  /**
   * NEGATIVE CONTROL for the pair above: when the PUBLISH is what failed, nothing
   * durable was created, so the retry must go all the way through it again and
   * the original copy is the correct one.
   */
  it('NEGATIVE CONTROL: a failed publish IS retried in full', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const keepOutputs = keepFn(async () => {
      throw new Error('rate limited');
    });
    const onKeepRun = keepRunFn();
    renderRunner({ keepOutputs, onKeepRun });
    await generate();

    await userEvent.click(screen.getByTestId('result-keep'));
    expect(await screen.findByTestId('result-keep-failed')).toHaveTextContent(
      'These images weren’t kept. Nothing was charged — you can try again.',
    );

    await userEvent.click(screen.getByTestId('result-keep'));
    await waitFor(() => expect(keepOutputs).toHaveBeenCalledTimes(2));
    expect(onKeepRun).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a re-run does not inherit the original run KEPT state', async () => {
    const keepOutputs = keepFn(async () => [1]);
    renderRunner({ keepOutputs, onKeepRun: vi.fn(async () => {}) });
    await generate();
    await userEvent.click(screen.getByTestId('result-keep'));
    await screen.findByTestId('result-kept');

    await userEvent.click(screen.getByTestId('result-rerun'));
    // The fresh item is a NEW generation; nothing about it has been kept.
    await waitFor(() => expect(screen.getAllByTestId('queue-item').length).toBe(2));
    await userEvent.click((await screen.findAllByTestId('queue-confirm'))[0]);
    await waitFor(() => expect(screen.getAllByTestId('result-keep').length).toBe(1));
  });
});

describe('Runner — the payoff view', () => {
  it('opens a result full size with the generator, recipe and prompt that made it', async () => {
    renderRunner();
    await generate('a neon fox');

    await userEvent.click(screen.getAllByTestId('result-image-open')[0]);
    const box = await screen.findByTestId('result-lightbox');

    expect(within(box).getByTestId('lightbox-attribution')).toHaveTextContent('Made with Neon Portrait Studio');
    expect(within(box).getByTestId('lightbox-recipe')).toHaveTextContent('DreamShaper 8 · 1 LoRA · 768×1024');
    expect(within(box).getByTestId('lightbox-prompt')).toHaveTextContent('a neon fox');
    expect(within(box).getByTestId('lightbox-image')).toBeInTheDocument();
  });

  it('pages a multi-image run with the arrow keys and bounds the ends', async () => {
    renderRunner({}, ['one.jpg', 'two.jpg', 'three.jpg']);
    await generate();

    await userEvent.click(screen.getAllByTestId('result-image-open')[0]);
    expect(await screen.findByTestId('lightbox-position')).toHaveTextContent('1 of 3');
    // At the first image there is nowhere back to go.
    expect(screen.getByTestId('lightbox-prev')).toBeDisabled();

    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(screen.getByTestId('lightbox-position')).toHaveTextContent('2 of 3'));
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(screen.getByTestId('lightbox-position')).toHaveTextContent('3 of 3'));
    // …and nowhere forward at the last.
    expect(screen.getByTestId('lightbox-next')).toBeDisabled();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('lightbox-position')).toHaveTextContent('3 of 3');

    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(screen.getByTestId('lightbox-position')).toHaveTextContent('2 of 3'));
  });

  it('does not offer paging controls for a single-image run', async () => {
    renderRunner();
    await generate();
    await userEvent.click(screen.getAllByTestId('result-image-open')[0]);
    await screen.findByTestId('result-lightbox');
    expect(screen.queryByTestId('lightbox-position')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lightbox-next')).not.toBeInTheDocument();
  });

  it('reflects a keep that happens while the view is open (derived, not snapshotted)', async () => {
    const keepOutputs = keepFn(async () => [11]);
    renderRunner({ keepOutputs, onKeepRun: vi.fn(async () => {}) });
    await generate();

    await userEvent.click(screen.getAllByTestId('result-image-open')[0]);
    await screen.findByTestId('result-lightbox');
    expect(screen.queryByTestId('lightbox-kept-badge')).not.toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('result-keep'));
    await screen.findByTestId('result-kept');

    await userEvent.click(screen.getAllByTestId('result-image-open')[0]);
    expect(await screen.findByTestId('lightbox-kept-badge')).toBeInTheDocument();
  });

  it('closes rather than stranding itself when the item underneath is dismissed', async () => {
    renderRunner();
    await generate();
    await userEvent.click(screen.getAllByTestId('result-image-open')[0]);
    await screen.findByTestId('result-lightbox');

    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('queue-remove'));
    expect(screen.queryByTestId('result-lightbox')).not.toBeInTheDocument();
  });
});

describe('Runner — kept gallery for this generator', () => {
  const kept: KeptRun[] = [
    {
      id: 'k1',
      keptAt: 2,
      imageIds: [501, 502],
      generatorName: 'Neon Portrait Studio',
      generatorKey: 'shared:99',
      buttonLabel: 'Cyberpunk',
      prompt: 'a fox',
    },
  ];

  let getImages: GetImages;
  beforeEach(() => {
    getImages = vi.fn(async (ids: number[]): Promise<BlockGatedImage[]> =>
      ids.map((imageId) =>
        imageId === 501
          ? { imageId, status: 'visible', url: `https://img/${imageId}.jpg`, nsfwLevel: 1, contentRating: 'pg', width: 512, height: 512 }
          : { imageId, status: 'hidden' },
      ),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders kept images resolved through the gate, and survives a reload by construction', async () => {
    renderRunner({ keptRuns: kept, getImages });
    const gallery = await screen.findByTestId('runner-kept');
    expect(within(gallery).getByTestId('runner-kept-count')).toHaveTextContent('1 run');
    // 🔴 Ids went out; urls came back. Nothing url-shaped was ever stored.
    await waitFor(() => expect(getImages).toHaveBeenCalledWith([501, 502]));
  });

  /**
   * 🔴 THE MODERATION OBLIGATION. `hidden` carries NO url, and the gate is the
   * only thing standing between a viewer's browsing ceiling and an image above
   * it. A hidden cell must render a placeholder, must not be openable, and must
   * not produce an `<img>`.
   */
  it('renders a hidden image as an inert placeholder, never an image', async () => {
    renderRunner({ keptRuns: kept, getImages });
    await screen.findByTestId('runner-kept');
    const cells = await screen.findAllByTestId('kept-cell');
    const hidden = cells.find((el) => el.getAttribute('data-image-id') === '502')!;
    const visible = cells.find((el) => el.getAttribute('data-image-id') === '501')!;

    await waitFor(() => expect(hidden).toHaveAttribute('data-state', 'hidden'));
    // 🔴 The literal, not a substring. `/browsing level/i` matched the sentence
    // that named the browsing level as the ONLY cause, which is wrong on the
    // dominant path (a just-published image is `Pending`, therefore `hidden`) —
    // so the loose matcher entrenched the defect it looked like it covered. The
    // wording itself is pinned in `KeptGallery.test.tsx`; this asserts the
    // moderation BEHAVIOUR still holds around it.
    expect(within(hidden).getByTestId('kept-cell-placeholder')).toHaveTextContent(
      'Still being checked, or above your browsing level',
    );
    expect(within(hidden).queryByRole('img')).not.toBeInTheDocument();
    expect(hidden).toBeDisabled();

    await waitFor(() => expect(visible).toHaveAttribute('data-state', 'visible'));
    expect(visible).toBeEnabled();
  });

  it('renders an id the host would not resolve as "no longer available", not as loading forever', async () => {
    // The gate OMITS ids it cannot resolve, so the reply is SHORTER than the ask.
    const omitting: GetImages = vi.fn(async (): Promise<BlockGatedImage[]> => []);
    renderRunner({ keptRuns: kept, getImages: omitting });
    await screen.findByTestId('runner-kept');
    const cells = await screen.findAllByTestId('kept-cell');
    await waitFor(() => expect(cells[0]).toHaveAttribute('data-state', 'missing'));
    expect(within(cells[0]).getByTestId('kept-cell-placeholder')).toHaveTextContent(/no longer available/i);
  });

  it('surfaces a failed gated read instead of showing an empty gallery', async () => {
    const failing: GetImages = vi.fn(async () => {
      throw new Error('host exploded');
    });
    renderRunner({ keptRuns: kept, getImages: failing });
    await screen.findByTestId('runner-kept');
    expect(await screen.findByTestId('runner-kept-gallery-error')).toHaveTextContent(/couldn’t load your kept images/i);
    expect(document.body.textContent).not.toContain('host exploded');
  });

  it('is absent when the generator has no kept runs', async () => {
    renderRunner({ keptRuns: [], getImages });
    await screen.findByTestId('runner');
    expect(screen.queryByTestId('runner-kept')).not.toBeInTheDocument();
  });

  /**
   * 🔴 THE GLOBAL HORIZON IS NOT A FACT ABOUT THIS GRID, AND NO TEST COVERED IT
   * HERE AT ALL. The Runner renders `KeptGallery` over `runsForGenerator(...)` —
   * typically one or two runs — and used to pass the App's store-wide truncation
   * flag straight through, so the notice announced "Showing 200 kept runs" above
   * two images. The flag is no longer threaded; this pins that, by passing the
   * prop the old wiring would have forwarded.
   */
  it('never renders the store-wide truncation notice over one generator runs', async () => {
    // The prop the old wiring forwarded. It is no longer on `RunnerProps`, so the
    // cast is the point of the test: were it re-introduced and threaded through,
    // this fails.
    const legacyTruncated = { keptTruncated: true } as unknown as Partial<
      Parameters<typeof Runner>[0]
    >;
    renderRunner({ keptRuns: kept, getImages, ...legacyTruncated });
    await screen.findByTestId('runner-kept');
    await screen.findAllByTestId('kept-cell');
    expect(screen.queryByTestId('runner-kept-gallery-truncated')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Older keeps aren’t shown here');
    expect(document.body.textContent).not.toContain('Showing 200 kept runs');
  });

  /**
   * 🔴 A CONTROL THAT CANNOT WORK IS WORSE THAN AN ABSENT ONE. The kept lightbox
   * gets one cell and one url — its siblings' urls live in the gallery's gated
   * state — so it supplies neither `onPrev` nor `onNext`, and the old `total > 1`
   * test rendered two permanently-disabled buttons plus a keydown listener that
   * could never fire. The position line stays: it is true.
   */
  it('states position but offers no paging for a kept run it cannot page', async () => {
    renderRunner({ keptRuns: kept, getImages });
    await screen.findByTestId('runner-kept');
    const cells = await screen.findAllByTestId('kept-cell');
    const visible = cells.find((el) => el.getAttribute('data-image-id') === '501')!;
    await waitFor(() => expect(visible).toBeEnabled());
    await userEvent.click(visible);

    const box = await screen.findByTestId('result-lightbox');
    // Two images in the run, so the position is worth stating…
    expect(within(box).getByTestId('lightbox-position')).toHaveTextContent('1 of 2');
    // …and there is nothing that pretends to page between them.
    expect(within(box).queryByTestId('lightbox-prev')).not.toBeInTheDocument();
    expect(within(box).queryByTestId('lightbox-next')).not.toBeInTheDocument();
  });

  it('opens a kept image full size, attributed to the generator that made it', async () => {
    renderRunner({ keptRuns: kept, getImages });
    await screen.findByTestId('runner-kept');
    const cells = await screen.findAllByTestId('kept-cell');
    const visible = cells.find((el) => el.getAttribute('data-image-id') === '501')!;
    await waitFor(() => expect(visible).toBeEnabled());
    await userEvent.click(visible);

    const box = await screen.findByTestId('result-lightbox');
    expect(within(box).getByTestId('lightbox-attribution')).toHaveTextContent('Made with Neon Portrait Studio');
    expect(within(box).getByTestId('lightbox-kept-badge')).toBeInTheDocument();
    expect(within(box).getByTestId('lightbox-prompt')).toHaveTextContent('a fox');
  });
});
