import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';

import { App, type AppDeps } from '../App.js';
import {
  CKPT_INFO,
  LORA_INFO,
  PENDING_IMAGE,
  UPLOADED_IMAGE,
  cannedPicker,
  fakeShared,
  memoryDraftStore,
  mockWorkflow,
} from '../test-helpers.js';
import { listDrafts } from '../lib/drafts.js';
import type { BackgroundScanResult, GeneratorData } from '../types.js';

/** A promise whose resolve/reject the test drives — for scan-status transitions. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(over: Partial<AppDeps> = {}) {
  const shared = fakeShared();
  const drafts = memoryDraftStore();
  const wf = mockWorkflow();
  const deps: Partial<AppDeps> = {
    pickResource: cannedPicker({ Checkpoint: CKPT_INFO, LORA: LORA_INFO }),
    uploadImage: async () => PENDING_IMAGE,
    resolveResources: async () => [],
    shared: shared.shared,
    updateSharedGenerator: shared.update,
    drafts,
    estimate: wf.estimate,
    submit: wf.submit,
    poll: wf.poll,
    ...over,
  };
  render(
    <Harness viewer={{ id: 99, username: 'me' }} theme="dark" consentGranted showLog={false}>
      <App deps={deps} />
    </Harness>,
  );
  return { shared, drafts };
}

async function openBuilder() {
  await userEvent.click(await screen.findByTestId('create-generator'));
  await screen.findByTestId('builder');
}

async function configureFirstButton() {
  const editor = screen.getByTestId('button-editor');
  // fireEvent.change (not userEvent.type): the label has a default value and the
  // template contains `{prompt}` which userEvent parses as a special-key sequence.
  fireEvent.change(within(editor).getByTestId('btn-label-input'), { target: { value: 'Cyberpunk' } });
  await userEvent.click(within(editor).getByTestId('pick-checkpoint'));
  await waitFor(() => expect(within(editor).getByTestId('checkpoint-name')).toHaveTextContent('DreamShaper'));
  await userEvent.click(within(editor).getByTestId('add-lora'));
  await screen.findByTestId('lora-row');
  fireEvent.change(within(editor).getByTestId('btn-prompt-template'), { target: { value: 'neon {prompt}' } });
}

describe('Builder — button config round-trip', () => {
  it('pins a checkpoint and adds a LoRA whose weight is seeded from the picker', async () => {
    setup();
    await openBuilder();
    await configureFirstButton();
    // LoRA weight seeded from the picker's strength (0.8)
    expect(screen.getByTestId('lora-weight-value')).toHaveTextContent('0.80');
  });

  it('clamps the LoRA weight to the picker-recommended max', async () => {
    setup();
    await openBuilder();
    await configureFirstButton();
    const slider = screen.getByTestId('lora-weight');
    // drive it past the recommended max (1.5) → clamps
    fireEvent.change(slider, { target: { value: '5' } });
    await waitFor(() => expect(screen.getByTestId('lora-weight-value')).toHaveTextContent('1.50'));
  });
});

describe('Builder — publish payload split (moderation boundary)', () => {
  it('puts visible text in title/body and the structured config in opaque data', async () => {
    const { shared } = setup();
    await openBuilder();
    await userEvent.type(screen.getByTestId('gen-name'), 'My Gen');
    await userEvent.type(screen.getByTestId('gen-description'), 'a neon studio');
    await configureFirstButton();

    await userEvent.click(screen.getByTestId('publish'));
    await screen.findByTestId('builder-notice');

    expect(shared.appended).toHaveLength(1);
    const payload = shared.appended[0];
    // moderated text
    expect(payload.title).toBe('My Gen');
    expect(payload.body).toContain('a neon studio');
    expect(payload.body).toContain('Cyberpunk');
    expect(payload.body).toContain('neon {prompt}');
    // opaque structured config
    const data = payload.data as GeneratorData;
    expect(data.v).toBe(1);
    expect(data.buttons[0].checkpoint?.versionId).toBe(CKPT_INFO.versionId);
    expect(data.buttons[0].loras[0]).toMatchObject({ versionId: LORA_INFO.versionId });
    expect(data.buttons[0].label).toBe('Cyberpunk');
  });

  it('blocks publish while validation errors exist (no name)', async () => {
    const { shared } = setup();
    await openBuilder();
    // don't set a name → invalid
    await configureFirstButton();
    expect(screen.getByTestId('publish')).toBeDisabled();
    expect(screen.getByTestId('validation-errors')).toBeInTheDocument();
    expect(shared.appended).toHaveLength(0);
  });
});

describe('Builder — cosmetic header image', () => {
  it('stores the moderated image id + url on upload and publishes it in data', async () => {
    // Deterministic seam: the pending upload scans clean immediately.
    const { shared } = setup({ scanBackground: async () => ({ status: 'scanned' }) });
    await openBuilder();
    await userEvent.type(screen.getByTestId('gen-name'), 'BG Gen');
    await configureFirstButton();

    await userEvent.click(screen.getByTestId('upload-header-image'));
    const preview = await screen.findByTestId('header-preview');
    expect(preview).toHaveAttribute('src', PENDING_IMAGE.url);

    await userEvent.click(screen.getByTestId('publish'));
    await screen.findByTestId('builder-notice');
    const data = shared.appended[0].data as GeneratorData;
    expect(data.headerImageRef).toEqual({ imageId: PENDING_IMAGE.imageId, url: PENDING_IMAGE.url });
  });

  it('handles a cancelled upload (resolves null) without error or a preview', async () => {
    setup({ uploadImage: async () => null });
    await openBuilder();
    await userEvent.click(screen.getByTestId('upload-header-image'));
    // no preview, no error surfaced
    await waitFor(() => expect(screen.queryByTestId('header-preview')).not.toBeInTheDocument());
    expect(screen.queryByTestId('builder-error')).not.toBeInTheDocument();
  });
});

describe('Builder — non-blocking header-image scan (auto-close + inline status)', () => {
  // (a) On accept the upload modal auto-closes and an inline "scanning" status
  // shows immediately — the image is NOT persisted while the scan is in flight.
  it('auto-closes on accept and shows an inline scanning status (not yet persisted)', async () => {
    const scan = deferred<BackgroundScanResult>();
    setup({ scanBackground: () => scan.promise });
    await openBuilder();

    await userEvent.click(screen.getByTestId('upload-header-image'));

    // inline scanning indicator shows; the upload button is no longer "busy"
    // (the modal has closed — user can keep editing)
    await screen.findByTestId('header-scanning');
    await waitFor(() => expect(screen.getByTestId('upload-header-image')).not.toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByTestId('upload-header-image')).not.toBeDisabled();
    // fail-closed: nothing persisted while pending
    expect(screen.queryByTestId('header-preview')).not.toBeInTheDocument();
  });

  // (b) pending → scanned: the image appears and persists as headerImageRef.
  it('pending → scanned shows the image and persists headerImageRef', async () => {
    const scan = deferred<BackgroundScanResult>();
    const { shared } = setup({ scanBackground: () => scan.promise });
    await openBuilder();
    await userEvent.type(screen.getByTestId('gen-name'), 'Scan Gen');
    await configureFirstButton();

    await userEvent.click(screen.getByTestId('upload-header-image'));
    await screen.findByTestId('header-scanning');

    // scan resolves clean → preview appears + scanned badge
    scan.resolve({ status: 'scanned' });
    const preview = await screen.findByTestId('header-preview');
    expect(preview).toHaveAttribute('src', PENDING_IMAGE.url);
    expect(screen.getByTestId('header-scanned')).toBeInTheDocument();
    expect(screen.queryByTestId('header-scanning')).not.toBeInTheDocument();

    // and it publishes into the opaque data blob
    await userEvent.click(screen.getByTestId('publish'));
    await screen.findByTestId('builder-notice');
    const data = shared.appended[0].data as GeneratorData;
    expect(data.headerImageRef).toEqual({ imageId: PENDING_IMAGE.imageId, url: PENDING_IMAGE.url });
  });

  // (c) pending → blocked: rejection is shown inline and the image is NOT saved
  // (fail-closed).
  it('pending → blocked shows the rejection and does NOT persist the header image', async () => {
    const scan = deferred<BackgroundScanResult>();
    const { shared } = setup({ scanBackground: () => scan.promise });
    await openBuilder();
    await userEvent.type(screen.getByTestId('gen-name'), 'Blocked Gen');
    await configureFirstButton();

    await userEvent.click(screen.getByTestId('upload-header-image'));
    await screen.findByTestId('header-scanning');

    scan.resolve({ status: 'blocked', reason: 'Failed moderation.' });
    const blocked = await screen.findByTestId('header-blocked');
    expect(blocked).toHaveTextContent('Failed moderation.');
    // fail-closed: no preview, and publish carries NO header
    expect(screen.queryByTestId('header-preview')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('publish'));
    await screen.findByTestId('builder-notice');
    const data = shared.appended[0].data as GeneratorData;
    expect(data.headerImageRef).toBeUndefined();
  });

  // (d) a scan error is surfaced inline (not stuck on "scanning") and is retryable.
  it('surfaces a scan error inline (not stuck) and does not persist', async () => {
    const scan = deferred<BackgroundScanResult>();
    const { shared } = setup({ scanBackground: () => scan.promise });
    await openBuilder();
    await userEvent.type(screen.getByTestId('gen-name'), 'Err Gen');
    await configureFirstButton();

    await userEvent.click(screen.getByTestId('upload-header-image'));
    await screen.findByTestId('header-scanning');

    scan.reject(new Error('scan service unavailable'));
    const err = await screen.findByTestId('header-scan-error');
    expect(err).toHaveTextContent('scan service unavailable');
    expect(screen.queryByTestId('header-scanning')).not.toBeInTheDocument();
    expect(screen.getByTestId('retry-header-scan')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('publish'));
    await screen.findByTestId('builder-notice');
    const data = shared.appended[0].data as GeneratorData;
    expect(data.headerImageRef).toBeUndefined();
  });

  // (d, timeout variant) a hung scan surfaces the inline error via the timeout.
  it('times out a hung scan into the inline error state', async () => {
    const scan = deferred<BackgroundScanResult>(); // never resolves
    setup({ scanBackground: () => scan.promise, bgScanTimeoutMs: 20 });
    await openBuilder();

    await userEvent.click(screen.getByTestId('upload-header-image'));
    await screen.findByTestId('header-scanning');

    const err = await screen.findByTestId('header-scan-error');
    expect(err).toHaveTextContent(/timed out/i);
    expect(screen.queryByTestId('header-preview')).not.toBeInTheDocument();
  });
});

describe('Builder — edit-in-place (the "editing creates a new one" bug fix)', () => {
  it('editing a PUBLISHED generator updates the SAME shared row — never appends a duplicate', async () => {
    const { shared, drafts } = setup();
    await openBuilder();
    await userEvent.type(screen.getByTestId('gen-name'), 'Edit Me');
    await configureFirstButton();

    // first publish → append once; the draft remembers the minted key
    await userEvent.click(screen.getByTestId('publish'));
    await screen.findByTestId('builder-notice');
    expect(shared.appended).toHaveLength(1);
    expect(shared.updated).toHaveLength(0);
    const publishedKey = shared.items[0].key;

    let stored = await listDrafts(drafts);
    expect(stored).toHaveLength(1);
    expect(stored[0].publishedKey).toBe(publishedKey);

    // back → My generators → Edit the SAME generator
    await userEvent.click(screen.getByTestId('builder-back'));
    await userEvent.click(await screen.findByTestId('tab-mine'));
    const card = await screen.findByTestId('draft-card');
    await userEvent.click(within(card).getByTestId('draft-edit'));
    await waitFor(() => expect(screen.getByTestId('gen-name')).toHaveValue('Edit Me'));

    // change + re-publish
    await userEvent.type(screen.getByTestId('gen-name'), ' v2');
    await userEvent.click(screen.getByTestId('publish'));
    await screen.findByTestId('builder-notice');

    // in-place UPDATE with the SAME key; NO second append; NO duplicate row/draft
    expect(shared.appended).toHaveLength(1);
    expect(shared.updated).toHaveLength(1);
    expect(shared.updated[0].key).toBe(publishedKey);
    expect(shared.updated[0].value.title).toBe('Edit Me v2');
    expect(shared.items).toHaveLength(1);

    stored = await listDrafts(drafts);
    expect(stored).toHaveLength(1);
  });

  it('Save draft upserts the SAME draft id — re-saving does not create a duplicate', async () => {
    const { drafts } = setup();
    await openBuilder();
    await userEvent.type(screen.getByTestId('gen-name'), 'Dup?');
    await configureFirstButton();

    await userEvent.click(screen.getByTestId('save-draft'));
    await screen.findByTestId('builder-notice');
    // re-save the same builder session
    await userEvent.click(screen.getByTestId('save-draft'));

    const stored = await listDrafts(drafts);
    expect(stored).toHaveLength(1);
  });
});

describe('Builder — inferred inputs + {prompt} editor (no expose checkboxes)', () => {
  it('has no expose-input checkboxes and shows inferred hints instead', async () => {
    setup();
    await openBuilder();
    const editor = screen.getByTestId('button-editor');
    expect(within(editor).queryByTestId('expose-prompt')).not.toBeInTheDocument();
    expect(within(editor).queryByTestId('expose-image')).not.toBeInTheDocument();

    // default button seeds {prompt} → a prompt hint
    expect(within(editor).getByTestId('hint-prompt')).toBeInTheDocument();

    // img2img → an image hint appears
    await userEvent.selectOptions(within(editor).getByTestId('btn-workflow-select'), 'img2img');
    expect(within(editor).getByTestId('hint-image')).toBeInTheDocument();

    // back to txt2img with a token-free template → the "fully fixed" hint
    await userEvent.selectOptions(within(editor).getByTestId('btn-workflow-select'), 'txt2img');
    fireEvent.change(within(editor).getByTestId('btn-prompt-template'), { target: { value: 'a fixed portrait' } });
    expect(within(editor).getByTestId('hint-fixed')).toBeInTheDocument();
    expect(within(editor).queryByTestId('hint-prompt')).not.toBeInTheDocument();
  });

  it('Insert {prompt} splices the token at the caret and the overlay highlights it', async () => {
    setup();
    await openBuilder();
    const editor = screen.getByTestId('button-editor');
    const ta = within(editor).getByTestId('btn-prompt-template') as HTMLTextAreaElement;

    fireEvent.change(ta, { target: { value: 'neon portrait' } });
    // no token → no highlight yet
    expect(within(editor).queryByTestId('prompt-token-mark')).not.toBeInTheDocument();

    ta.setSelectionRange(4, 4); // caret right after "neon"
    await userEvent.click(within(editor).getByTestId('insert-prompt-token'));
    expect(ta.value).toBe('neon{prompt} portrait');

    // the overlay now marks the token
    const mark = within(editor).getByTestId('prompt-token-mark');
    expect(mark).toHaveTextContent('{prompt}');
  });
});

describe('Builder — pack primitives (blocks-react 0.23 UI)', () => {
  it('uses Select (workflow), Collapse (advanced), and NumberInput (params)', async () => {
    setup();
    await openBuilder();
    const editor = screen.getByTestId('button-editor');

    // Select controls the workflow type
    const sel = within(editor).getByTestId('btn-workflow-select') as HTMLSelectElement;
    await userEvent.selectOptions(sel, 'img2img');
    expect(sel.value).toBe('img2img');

    // Collapse hides advanced params until opened
    expect(within(editor).getByTestId('advanced-params')).not.toBeVisible();
    await userEvent.click(within(editor).getByRole('button', { name: /advanced params/i }));
    expect(within(editor).getByTestId('advanced-params')).toBeVisible();

    // NumberInput holds a numeric value
    const steps = within(editor).getByTestId('param-steps') as HTMLInputElement;
    fireEvent.change(steps, { target: { value: '30' } });
    expect(steps.value).toBe('30');
  });
});

describe('Builder — live preview pane (non-runnable)', () => {
  it('reflects config changes live and does not generate', async () => {
    setup();
    await openBuilder();
    await userEvent.type(screen.getByTestId('gen-name'), 'Preview Me');

    // author a prompt-box placeholder → it must reach the runtime prompt box
    await userEvent.type(screen.getByTestId('gen-prompt-placeholder'), 'a fox in the snow');

    // jsdom has no matchMedia → mobile layout → reveal the preview via the toggle
    await userEvent.click(screen.getByTestId('toggle-preview'));
    const preview = await screen.findByTestId('builder-preview');
    expect(within(preview).getByTestId('runner-title')).toHaveTextContent('Preview Me');
    expect(within(preview).getByTestId('runner-preview-badge')).toBeInTheDocument();
    // placeholder propagated Builder → Runner
    expect(within(preview).getByTestId('runner-prompt')).toHaveAttribute('placeholder', 'a fox in the snow');

    // pressing a preview button surfaces a note, never a queue item
    await userEvent.click(within(preview).getByTestId('gen-button'));
    expect(within(preview).getByTestId('runner-error')).toHaveTextContent(/preview/i);
    expect(within(preview).queryByTestId('queue-item')).not.toBeInTheDocument();
  });
});

describe('Builder — draft save + load', () => {
  it('saves a draft to per-user storage and reopens it with its values', async () => {
    const { drafts } = setup();
    await openBuilder();
    await userEvent.type(screen.getByTestId('gen-name'), 'Draft One');
    await configureFirstButton();

    await userEvent.click(screen.getByTestId('save-draft'));
    await screen.findByTestId('builder-notice');

    // persisted
    const stored = await listDrafts(drafts);
    expect(stored).toHaveLength(1);
    expect(stored[0].config.name).toBe('Draft One');

    // back → My generators → draft appears → edit reopens with the name
    await userEvent.click(screen.getByTestId('builder-back'));
    await userEvent.click(await screen.findByTestId('tab-mine'));
    const card = await screen.findByTestId('draft-card');
    expect(card).toHaveTextContent('Draft One');
    await userEvent.click(within(card).getByTestId('draft-edit'));
    await waitFor(() => expect(screen.getByTestId('gen-name')).toHaveValue('Draft One'));
  });
});

// The tests above drive the injectable seam directly. These exercise the REAL
// App.tsx wiring end-to-end: `uploadImage: imageUpload.open` (early-resolve
// pending handle) + the default `scanBackground` mapping `imageUpload.scanStatus`
// verdicts, both served by the SDK mock host — NO uploadImage/scanBackground
// overrides. The verdict is chosen via the Harness `cannedImageScan` prop.
describe('Builder — real SDK scanStatus wiring (mock host)', () => {
  function renderReal(cannedImageScan?: 'scanned' | { status: 'blocked'; reason?: string } | 'error') {
    render(
      <Harness
        viewer={{ id: 99, username: 'me' }}
        theme="dark"
        consentGranted
        cannedPicks={{ Checkpoint: CKPT_INFO, LORA: LORA_INFO }}
        cannedImageUpload={UPLOADED_IMAGE}
        cannedImageScan={cannedImageScan}
        showLog={false}
      >
        <App deps={{ resolveResources: async () => [] }} />
      </Harness>,
    );
  }

  // pending → scanned: the real open() early-resolves a pending handle, scanStatus
  // streams 'scanned', and the fail-closed persist attaches headerImageRef.
  it('pending → scanned persists the header image via imageUpload.scanStatus', async () => {
    renderReal('scanned'); // default, but explicit for intent
    await openBuilder();

    await userEvent.click(screen.getByTestId('upload-header-image'));
    // scan resolves clean → preview + scanned badge (headerImageRef persisted)
    const preview = await screen.findByTestId('header-preview');
    expect(preview).toHaveAttribute('src', UPLOADED_IMAGE.url);
    expect(await screen.findByTestId('header-scanned')).toBeInTheDocument();
  });

  // pending → blocked: scanStatus streams a terminal 'blocked' → inline rejection,
  // NOT persisted (fail-closed).
  it('pending → blocked shows the rejection and does NOT persist', async () => {
    renderReal({ status: 'blocked', reason: 'Failed moderation (mock host).' });
    await openBuilder();

    await userEvent.click(screen.getByTestId('upload-header-image'));
    const blocked = await screen.findByTestId('header-blocked');
    expect(blocked).toHaveTextContent('Failed moderation (mock host).');
    expect(screen.queryByTestId('header-preview')).not.toBeInTheDocument();
  });

  // transient 'error': the default scanBackground THROWS on a host 'error' verdict
  // → inline error phase + Retry, nothing persisted.
  it('transient scan error surfaces the inline error + Retry and does NOT persist', async () => {
    renderReal('error');
    await openBuilder();

    await userEvent.click(screen.getByTestId('upload-header-image'));
    const err = await screen.findByTestId('header-scan-error');
    expect(within(err).getByTestId('retry-header-scan')).toBeInTheDocument();
    expect(screen.queryByTestId('header-preview')).not.toBeInTheDocument();
  });
});

describe('Builder — a11y: focus retained after a button reorder (feature #12)', () => {
  it('moves keyboard focus to the moved button’s enabled move control', async () => {
    setup();
    await openBuilder();
    // add a 2nd button so the first can move down
    await userEvent.click(screen.getByTestId('add-button'));
    const editors = screen.getAllByTestId('button-editor');
    expect(editors).toHaveLength(2);
    const firstId = editors[0].getAttribute('data-button-id');

    await userEvent.click(within(editors[0]).getByTestId('move-down'));

    await waitFor(() => {
      const all = screen.getAllByTestId('button-editor');
      // the first button is now the SECOND card (moved down)…
      expect(all[1].getAttribute('data-button-id')).toBe(firstId);
      // …and focus followed it onto its now-enabled move-up control (move-down
      // is disabled at the bottom), rather than being dumped to the page top.
      const moved = document.querySelector(`[data-button-id="${firstId}"]`)!;
      expect(moved.querySelector('[data-testid="move-up"]')).toHaveFocus();
    });
  });
});

describe('Builder — concept hint (dogfood UX #1)', () => {
  it('explains that each button is a saved preset (checkpoint + LoRAs + prompt template)', async () => {
    setup();
    await openBuilder();
    const hint = screen.getByTestId('builder-concept-hint');
    expect(hint).toHaveTextContent(/saved generation preset/i);
    expect(hint).toHaveTextContent(/checkpoint/i);
    expect(hint).toHaveTextContent(/prompt/i);
  });
});
