// The builder's sampler field (feedback #179): a drop-down of the checkpoint
// family's samplers, from the platform's catalog.
//
// FEATURE TESTS, not regression tests: the drop-down is new, so each case is red
// on the base only because the behaviour did not exist there.
//
// Driven through the WHOLE app against the fake server in `platform/testing.tsx`,
// so the catalog travels the real path: `platform/samplers.ts` → `app.site.get`
// → the SDK's http client → the fake `blocks/generation-samplers` route →
// `parseGenerationSamplers` → `resolveGenerationSampler`. Only the server is fake.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BlockResourceInfo } from '@civitai/app-sdk/blocks';

import { App, type AppDeps } from '../App.js';
import { Builder } from './Builder.js';
import { checkpointFromPick, newButton, newGenerator } from '../lib/generator.js';
import { parseGenerationSamplers } from '@civitai/app-sdk/blocks';
import type { GeneratorConfig } from '../types.js';
import { palette } from '../theme.js';
import { createFakeCivitai, Harness, type FakeCivitaiOptions } from '../platform/testing.js';
import { listDrafts } from '../lib/drafts.js';
import { SAMPLER_NOTES } from '../lib/sampler.js';
import {
  CHROMA_CKPT,
  EMPTY_CKPT,
  FLUX_CKPT,
  PENDING_IMAGE,
  SAMPLER_CATALOG,
  SDXL_CKPT,
  UNMAPPED_CKPT,
  fakeShared,
  memoryDraftStore,
  mockWorkflow,
  queuedCheckpointPicker,
} from '../test-helpers.js';

/** `'no-route'` = the fake's default for the route: the HTML 404 of a platform without it. */
function setup(picks: BlockResourceInfo[], samplers: FakeCivitaiOptions['generationSamplers'] | 'no-route' = SAMPLER_CATALOG) {
  const generationSamplers = samplers === 'no-route' ? undefined : samplers;
  const shared = fakeShared();
  const drafts = memoryDraftStore();
  const wf = mockWorkflow();
  const fake = createFakeCivitai({ viewer: { id: 99, username: 'me' }, generationSamplers });
  const deps: Partial<AppDeps> = {
    pickResource: queuedCheckpointPicker(picks),
    uploadImage: async () => PENDING_IMAGE,
    resolveResources: async () => [],
    shared: shared.shared,
    updateSharedGenerator: shared.update,
    drafts,
    estimate: wf.estimate,
    submit: wf.submit,
    poll: wf.poll,
  };
  render(
    <Harness fake={fake}>
      <App deps={deps} />
    </Harness>,
  );
  return { drafts, fake };
}

async function openBuilder() {
  await userEvent.click(await screen.findByTestId('create-generator'));
  await screen.findByTestId('builder');
}

/** Pick the next queued checkpoint into the first button, and open its advanced params. */
async function pickCheckpoint(name: string) {
  const editor = screen.getAllByTestId('button-editor')[0]!;
  await userEvent.click(within(editor).getByTestId('pick-checkpoint'));
  await waitFor(() => expect(within(editor).getByTestId('checkpoint-name')).toHaveTextContent(name));
  return editor;
}

async function openAdvanced(editor: HTMLElement) {
  const toggle = within(editor).getByRole('button', { name: /advanced params/i });
  if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
  expect(within(editor).getByTestId('advanced-params')).toBeVisible();
}

const optionsOf = (el: HTMLElement) =>
  [...(el as HTMLSelectElement).options].map((o) => ({ value: o.value, label: o.textContent }));

const samplerCalls = (fake: { calls: { path: string }[] }) =>
  fake.calls.filter((c) => c.path === 'blocks/generation-samplers').length;

describe('ButtonEditor — sampler drop-down from the platform catalog', () => {
  it('lists the SDXL family options, in order, with the family default selected', async () => {
    const { fake } = setup([SDXL_CKPT]);
    await openBuilder();
    const editor = await pickCheckpoint('Juggernaut XL');
    await openAdvanced(editor);

    const field = await waitFor(() => {
      const f = within(editor).getByTestId('param-sampler');
      expect(f.tagName).toBe('SELECT');
      return f;
    });
    expect(optionsOf(field)).toEqual([
      { value: 'Euler a', label: 'Euler a' },
      { value: 'Euler', label: 'Euler' },
      { value: 'DPM++ 2M Karras', label: 'DPM++ 2M Karras' },
    ]);
    expect(field).toHaveValue('Euler a');
    expect(within(editor).queryByTestId('sampler-note')).toBeNull();
    // The list came over the real route, once.
    expect(samplerCalls(fake)).toBe(1);
  });

  it('hides the field for a family with no sampler control, and saves no sampler', async () => {
    const { drafts } = setup([FLUX_CKPT]);
    await openBuilder();
    const editor = await pickCheckpoint('Flux Dev');
    await openAdvanced(editor);

    // Positive control: the advanced grid is rendered (its other fields are there).
    expect(within(editor).getByTestId('param-steps')).toBeInTheDocument();
    await waitFor(() => expect(within(editor).queryByTestId('param-sampler')).toBeNull());
    expect(within(editor).queryByTestId('sampler-note')).toBeNull();

    await userEvent.type(screen.getByTestId('gen-name'), 'Flux one');
    await userEvent.click(screen.getByTestId('save-draft'));
    await screen.findByTestId('builder-notice');
    const [stored] = await listDrafts(drafts);
    expect(stored!.config.buttons[0]!.checkpoint?.versionId).toBe(FLUX_CKPT.versionId);
    expect(stored!.config.buttons[0]!.params).not.toHaveProperty('sampler');
  });

  it('switching checkpoint to a family without the current value resets it to that default, visibly', async () => {
    setup([SDXL_CKPT, CHROMA_CKPT]);
    await openBuilder();
    const editor = await pickCheckpoint('Juggernaut XL');
    await openAdvanced(editor);
    const sdxl = await waitFor(() => {
      const f = within(editor).getByTestId('param-sampler');
      expect(f.tagName).toBe('SELECT');
      return f;
    });
    await userEvent.selectOptions(sdxl, 'DPM++ 2M Karras');
    expect(sdxl).toHaveValue('DPM++ 2M Karras');
    // Choosing from the list is not a reset: no notice.
    expect(within(editor).queryByTestId('sampler-reset-notice')).toBeNull();

    await pickCheckpoint('Chroma HD');
    const chroma = await waitFor(() => {
      const f = within(editor).getByTestId('param-sampler');
      expect(optionsOf(f).map((o) => o.value)).toEqual(['heun', 'euler']);
      return f;
    });
    expect(chroma).toHaveValue('euler');
    expect(within(editor).getByTestId('sampler-reset-notice')).toHaveTextContent(
      "Sampler reset to euler: DPM++ 2M Karras isn't offered for this checkpoint.",
    );

    // The author picking again clears the notice.
    await userEvent.selectOptions(chroma, 'heun');
    expect(within(editor).queryByTestId('sampler-reset-notice')).toBeNull();
  });

  it('keeps a value the new family also offers, without a notice', async () => {
    setup([SDXL_CKPT, { ...SDXL_CKPT, versionId: 3099, modelName: 'Another XL' }]);
    await openBuilder();
    const editor = await pickCheckpoint('Juggernaut XL');
    await openAdvanced(editor);
    const field = await waitFor(() => {
      const f = within(editor).getByTestId('param-sampler');
      expect(f.tagName).toBe('SELECT');
      return f;
    });
    await userEvent.selectOptions(field, 'Euler');
    await pickCheckpoint('Another XL');
    expect(within(editor).getByTestId('param-sampler')).toHaveValue('Euler');
    expect(within(editor).queryByTestId('sampler-reset-notice')).toBeNull();
  });

  it('one catalog request serves every button editor', async () => {
    const { fake } = setup([SDXL_CKPT, CHROMA_CKPT]);
    await openBuilder();
    await userEvent.click(screen.getByTestId('add-button'));
    expect(screen.getAllByTestId('button-editor')).toHaveLength(2);
    await pickCheckpoint('Juggernaut XL');
    await waitFor(() => expect(samplerCalls(fake)).toBe(1));
    // Give a second request every chance to be sent before counting.
    await new Promise((r) => setTimeout(r, 20));
    expect(samplerCalls(fake)).toBe(1);
  });
});

describe('ButtonEditor — sampler falls back to free text when the answer is unknown', () => {
  it.each([
    ['an old platform without the route (HTML 404)', 'no-route'],
    ['a server error', 500],
    ['a network failure', 'network-error'],
  ])('%s: free-text field with a note, never an empty drop-down', async (_label, failure) => {
    setup([SDXL_CKPT], failure);
    await openBuilder();
    const editor = await pickCheckpoint('Juggernaut XL');
    await openAdvanced(editor);
    await waitFor(() =>
      expect(within(editor).getByTestId('sampler-note')).toHaveTextContent(SAMPLER_NOTES.unavailable),
    );
    const field = within(editor).getByTestId('param-sampler');
    expect(field.tagName).toBe('INPUT');
    await userEvent.type(field, 'DPM++ SDE');
    expect(field).toHaveValue('DPM++ SDE');
  });

  it('a base model the catalog does not map: free text with the unknown-family note', async () => {
    setup([UNMAPPED_CKPT]);
    await openBuilder();
    const editor = await pickCheckpoint('Mystery');
    await openAdvanced(editor);
    await waitFor(() =>
      expect(within(editor).getByTestId('sampler-note')).toHaveTextContent(SAMPLER_NOTES.unknownFamily),
    );
    expect(within(editor).getByTestId('param-sampler').tagName).toBe('INPUT');
  });

  it('a family whose list is empty renders free text, not an empty drop-down', async () => {
    setup([EMPTY_CKPT]);
    await openBuilder();
    const editor = await pickCheckpoint('Empty Family');
    await openAdvanced(editor);
    await waitFor(() => expect(within(editor).getByTestId('sampler-note')).toBeInTheDocument());
    expect(within(editor).getByTestId('param-sampler').tagName).toBe('INPUT');
  });

  it('before a checkpoint is picked: free text with the pick-a-checkpoint note', async () => {
    setup([]);
    await openBuilder();
    const editor = screen.getAllByTestId('button-editor')[0]!;
    await openAdvanced(editor);
    await waitFor(() =>
      expect(within(editor).getByTestId('sampler-note')).toHaveTextContent(SAMPLER_NOTES.noCheckpoint),
    );
    expect(within(editor).getByTestId('param-sampler').tagName).toBe('INPUT');
  });
});

/**
 * REGRESSION (audit round 1 on #45): every editor corrects its sampler in the SAME
 * commit when the catalog arrives. Patches built from one render's `config.buttons`
 * let the last editor's write drop the others', so only the last button was saved
 * corrected while every button showed the reset notice.
 *
 * Opens an EXISTING generator (the shape the new-generator tests above never build)
 * with three buttons whose stored samplers their families do not offer.
 */
describe('Builder — every button keeps its sampler correction', () => {
  it('corrects all buttons of an existing generator, not only the last', async () => {
    const ready = { status: 'ready' as const, catalog: parseGenerationSamplers(SAMPLER_CATALOG) };
    const initial = newGenerator({
      name: 'Existing',
      buttons: [
        newButton({ label: 'A', checkpoint: checkpointFromPick(CHROMA_CKPT), params: { steps: 20, sampler: 'DPM++ 2M Karras' } }),
        newButton({ label: 'B', checkpoint: checkpointFromPick(CHROMA_CKPT), params: { steps: 21, sampler: 'Euler a' } }),
        newButton({ label: 'C', checkpoint: checkpointFromPick(FLUX_CKPT), params: { steps: 22, sampler: 'Euler' } }),
      ],
    });
    let saved: GeneratorConfig | null = null;
    render(
      <Harness>
        <Builder
          initial={initial}
          c={palette()}
          pickResource={async () => null}
          loadSamplers={async () => ready}
          uploadImage={async () => null}
          scanBackground={async () => ({ status: 'scanned' })}
          onSaveDraft={async (cfg) => {
            saved = cfg;
          }}
          onPublish={async () => {}}
          onBack={() => {}}
        />
      </Harness>,
    );
    await waitFor(() => expect(screen.getAllByTestId('sampler-reset-notice')).toHaveLength(2));
    await userEvent.click(screen.getByTestId('save-draft'));
    await waitFor(() => expect(saved).not.toBeNull());
    const params = saved!.buttons.map((b) => b.params);
    expect(params.map((p) => p.sampler)).toEqual(['euler', 'euler', undefined]);
    expect(params[2]).not.toHaveProperty('sampler');
    // The other params of each button survive the correction.
    expect(params.map((p) => p.steps)).toEqual([20, 21, 22]);
  });
});

/**
 * The AUTHOR's note for a generator saved before the drop-down (0.18.1). Runs
 * correct such a sampler to the family default at run time; the author sees why,
 * on the button's card itself rather than inside the collapsed advanced params
 * (where the reset notice above is `hidden` until expanded).
 */
describe('Builder — the author is told a saved sampler is not valid for its checkpoint', () => {
  function openSaved(
    buttons: Parameters<typeof newButton>[0][],
    samplers: Awaited<ReturnType<NonNullable<Parameters<typeof Builder>[0]['loadSamplers']>>> = {
      status: 'ready',
      catalog: parseGenerationSamplers(SAMPLER_CATALOG),
    },
    picks: BlockResourceInfo[] = [],
  ) {
    render(
      <Harness>
        <Builder
          initial={newGenerator({ name: 'Saved', buttons: buttons.map((b) => newButton(b)) })}
          c={palette()}
          pickResource={queuedCheckpointPicker(picks)}
          loadSamplers={async () => samplers}
          uploadImage={async () => null}
          scanBackground={async () => ({ status: 'scanned' })}
          onSaveDraft={async () => {}}
          onPublish={async () => {}}
          onBack={() => {}}
        />
      </Harness>,
    );
  }

  const STALE = { label: 'Old', checkpoint: checkpointFromPick(CHROMA_CKPT), params: { sampler: 'DPM++ 2M Karras' } };
  const NOTE = "Saved sampler DPM++ 2M Karras isn't valid for this checkpoint, so the family default, euler, is used.";

  it('shown: visible on the card without opening the advanced params, naming both values', async () => {
    openSaved([STALE, { label: 'Fine', checkpoint: checkpointFromPick(CHROMA_CKPT), params: { sampler: 'heun' } }]);
    const [stale, fine] = screen.getAllByTestId('button-editor');
    const note = await within(stale!).findByTestId('sampler-saved-invalid');
    expect(note).toHaveTextContent(NOTE);
    expect(note).toBeVisible();
    // The advanced params are still collapsed: the note does not depend on them.
    expect(within(stale!).getByTestId('advanced-params')).not.toBeVisible();
    // Only the button whose saved value is invalid carries it.
    expect(within(fine!).queryByTestId('sampler-saved-invalid')).toBeNull();
  });

  it('hidden: a saved sampler the family offers', async () => {
    openSaved([{ label: 'Fine', checkpoint: checkpointFromPick(CHROMA_CKPT), params: { sampler: 'heun' } }]);
    // Positive control: the catalog arrived (the drop-down is rendered).
    await waitFor(() => expect(screen.getByTestId('param-sampler').tagName).toBe('SELECT'));
    expect(screen.queryByTestId('sampler-saved-invalid')).toBeNull();
  });

  it('hidden: the catalog is unavailable, so nothing is known to be invalid', async () => {
    openSaved([STALE], { status: 'unavailable', code: 'http-error' });
    await waitFor(() => expect(screen.getByTestId('sampler-note')).toHaveTextContent(SAMPLER_NOTES.unavailable));
    expect(screen.queryByTestId('sampler-saved-invalid')).toBeNull();
  });

  it('hidden: a reset the AUTHOR caused by switching checkpoint is not a saved-value note', async () => {
    openSaved([{ label: 'Fine', checkpoint: checkpointFromPick(SDXL_CKPT), params: { sampler: 'DPM++ 2M Karras' } }], undefined, [CHROMA_CKPT]);
    const editor = screen.getAllByTestId('button-editor')[0]!;
    await waitFor(() => expect(within(editor).getByTestId('param-sampler').tagName).toBe('SELECT'));
    await pickCheckpoint('Chroma HD');
    // Positive control: the switch DID reset the value (the in-advanced notice says so).
    await waitFor(() => expect(within(editor).getByTestId('sampler-reset-notice')).toBeInTheDocument());
    expect(within(editor).queryByTestId('sampler-saved-invalid')).toBeNull();
  });

  it('hidden: back on the saved checkpoint, a value the AUTHOR\'s switch produced is not the saved one', async () => {
    // Saved valid (SDXL `Euler`). Switching to Chroma resets it to `euler`; switching
    // back to the SAME SDXL version resets `euler` again. That value was never saved.
    openSaved([{ label: 'Fine', checkpoint: checkpointFromPick(SDXL_CKPT), params: { sampler: 'Euler' } }], undefined, [CHROMA_CKPT, SDXL_CKPT]);
    const editor = screen.getAllByTestId('button-editor')[0]!;
    await waitFor(() => expect(within(editor).getByTestId('param-sampler').tagName).toBe('SELECT'));
    await pickCheckpoint('Chroma HD');
    await pickCheckpoint('Juggernaut XL');
    // Positive control: the second switch reset `euler` to SDXL's default.
    await waitFor(() =>
      expect(within(editor).getByTestId('sampler-reset-notice')).toHaveTextContent(
        "Sampler reset to Euler a: euler isn't offered for this checkpoint.",
      ),
    );
    expect(within(editor).queryByTestId('sampler-saved-invalid')).toBeNull();
  });

  it('cleared once the author picks a sampler', async () => {
    openSaved([STALE]);
    const editor = screen.getAllByTestId('button-editor')[0]!;
    await within(editor).findByTestId('sampler-saved-invalid');
    await openAdvanced(editor);
    await userEvent.selectOptions(within(editor).getByTestId('param-sampler'), 'heun');
    expect(within(editor).queryByTestId('sampler-saved-invalid')).toBeNull();
  });
});
