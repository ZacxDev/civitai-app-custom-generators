// The sampler a RUN sends for a generator saved before the sampler drop-down
// (0.18.0). Such a generator keeps its stored sampler, and the host silently
// swaps an out-of-family value for the family default. Since 0.18.1 the run
// resolves it against the catalog for the button's checkpoint instead.
//
// Driven through `buildSubmitBody`, the function that builds the body the Runner
// estimates and submits, so a resolver that exists but is never called fails here.
//
// REGRESSION: the "not in the list" and "no sampler control" cases are RED on
// 0.18.0 (it sends the stored value). The "in the list", "catalog unknown" and
// "no stored value" cases are INVARIANT guards: 0.18.0 already behaved this way,
// and they pin that the correction does not reach past its two cases.

import { describe, expect, it } from 'vitest';
import { parseGenerationSamplers } from '@civitai/app-sdk/blocks';

import { CHROMA_CKPT, FLUX_CKPT, SAMPLER_CATALOG, SDXL_CKPT, UNMAPPED_CKPT } from '../test-helpers.js';
import type { BlockResourceInfo } from '@civitai/app-sdk/blocks';
import { buildSubmitBody, checkpointFromPick, newButton } from './generator.js';

const ready = { status: 'ready' as const, catalog: parseGenerationSamplers(SAMPLER_CATALOG) };

/** A saved button: a checkpoint and a stored sampler, nothing else of note. */
function saved(ckpt: BlockResourceInfo, sampler: string | undefined) {
  return newButton({
    label: 'Saved',
    checkpoint: checkpointFromPick(ckpt),
    promptTemplate: 'a fox',
    params: { steps: 20, ...(sampler === undefined ? {} : { sampler }) },
  });
}

const sent = (body: ReturnType<typeof buildSubmitBody>) => body.params.sampler;

describe('run time: a saved sampler is resolved against the checkpoint family', () => {
  it('REGRESSION: a value the family does not offer sends the family default', () => {
    // Chroma's default (`euler`) is NOT its first option (`heun`), and neither is
    // the stored value, so "first option" and "unchanged" both fail here.
    const body = buildSubmitBody(saved(CHROMA_CKPT, 'DPM++ 2M Karras'), { samplers: ready });
    expect(sent(body)).toBe('euler');
  });

  it('REGRESSION: a second family resolves to ITS default, not a constant', () => {
    const body = buildSubmitBody(saved(SDXL_CKPT, 'heun'), { samplers: ready });
    expect(sent(body)).toBe('Euler a');
  });

  it('REGRESSION: a family with no sampler control sends none', () => {
    const body = buildSubmitBody(saved(FLUX_CKPT, 'Euler'), { samplers: ready });
    expect(body.params).not.toHaveProperty('sampler');
    // The rest of the params still travel.
    expect(body.params.steps).toBe(20);
  });

  it('INVARIANT: a value in the family list is sent unchanged', () => {
    // A non-default option, so a resolver that always sent the default fails.
    expect(sent(buildSubmitBody(saved(CHROMA_CKPT, 'heun'), { samplers: ready }))).toBe('heun');
    expect(sent(buildSubmitBody(saved(SDXL_CKPT, 'DPM++ 2M Karras'), { samplers: ready }))).toBe('DPM++ 2M Karras');
  });

  it.each([
    ['the catalog is unavailable', { status: 'unavailable' as const, code: 'unsupported-platform' as const }, CHROMA_CKPT],
    ['the catalog has not loaded', null, CHROMA_CKPT],
    ['no catalog was passed at all', undefined, CHROMA_CKPT],
    ['the family is not in the catalog', ready, UNMAPPED_CKPT],
  ])('INVARIANT: %s: the stored value is sent unchanged', (_label, samplers, ckpt) => {
    const body = buildSubmitBody(saved(ckpt, 'DPM++ 2M Karras'), samplers === undefined ? {} : { samplers });
    expect(sent(body)).toBe('DPM++ 2M Karras');
  });

  it('INVARIANT: no stored sampler stays none (the host applies the default itself)', () => {
    expect(buildSubmitBody(saved(CHROMA_CKPT, undefined), { samplers: ready }).params).not.toHaveProperty('sampler');
  });

  it('GUARD (no UI offers a sampler override today): a runner override is resolved too: the corrected value is what reaches the body', () => {
    const body = buildSubmitBody(saved(CHROMA_CKPT, 'heun'), {
      samplers: ready,
      paramOverrides: { sampler: 'Euler a' },
    });
    expect(sent(body)).toBe('euler');
  });
});
