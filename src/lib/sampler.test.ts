// `samplerControlFor` / `samplerCorrection` — FEATURE tests (feedback #179), not
// regression tests: nothing chose a sampler control before this change.

import { describe, expect, it } from 'vitest';
import { parseGenerationSamplers } from '@civitai/app-sdk/blocks';

import { CHROMA_CKPT, EMPTY_CKPT, FLUX_CKPT, SAMPLER_CATALOG, SDXL_CKPT, UNMAPPED_CKPT } from '../test-helpers.js';
import { checkpointFromPick, defaultParams } from './generator.js';
import { SAMPLER_NOTES, samplerControlFor, samplerCorrection, type SamplerControl } from './sampler.js';

const ready = { status: 'ready' as const, catalog: parseGenerationSamplers(SAMPLER_CATALOG) };
const ck = checkpointFromPick;

describe('samplerControlFor', () => {
  it('is loading until the catalog answers', () => {
    expect(samplerControlFor(null, ck(SDXL_CKPT))).toEqual({ kind: 'loading' });
  });

  it('a family with options is a drop-down of exactly those, with its default', () => {
    expect(samplerControlFor(ready, ck(SDXL_CKPT))).toEqual({
      kind: 'select',
      options: SAMPLER_CATALOG.ecosystems.SDXL.sampler.options,
      defaultValue: 'Euler a',
    });
    // A second family, so a control that ignored the checkpoint would fail one of them.
    expect(samplerControlFor(ready, ck(CHROMA_CKPT))).toMatchObject({ kind: 'select', defaultValue: 'euler' });
  });

  it('a family with no sampler control hides the field', () => {
    expect(samplerControlFor(ready, ck(FLUX_CKPT))).toEqual({ kind: 'none' });
  });

  it.each([
    ['unsupported-platform'],
    ['network-error'],
    ['http-error'],
  ] as const)('an unavailable catalog (%s) is free text, never "none"', (code) => {
    expect(samplerControlFor({ status: 'unavailable', code }, ck(FLUX_CKPT))).toEqual({
      kind: 'free',
      note: SAMPLER_NOTES.unavailable,
    });
  });

  it('no checkpoint, an unmapped base model, and an empty list are all free text', () => {
    expect(samplerControlFor(ready, undefined)).toEqual({ kind: 'free', note: SAMPLER_NOTES.noCheckpoint });
    expect(samplerControlFor(ready, ck(UNMAPPED_CKPT))).toEqual({ kind: 'free', note: SAMPLER_NOTES.unknownFamily });
    expect(samplerControlFor(ready, ck(EMPTY_CKPT))).toEqual({ kind: 'free', note: SAMPLER_NOTES.unknownFamily });
  });

  it('keys on the checkpoint version: a per-version override wins over the family', () => {
    const catalog = parseGenerationSamplers({
      ...SAMPLER_CATALOG,
      ecosystems: {
        ...SAMPLER_CATALOG.ecosystems,
        SDXL: {
          ...SAMPLER_CATALOG.ecosystems.SDXL,
          byModelVersion: { [String(SDXL_CKPT.versionId)]: null },
        },
      },
    });
    expect(samplerControlFor({ status: 'ready', catalog }, ck(SDXL_CKPT))).toEqual({ kind: 'none' });
  });
});

describe('samplerCorrection', () => {
  const sdxl = samplerControlFor(ready, ck(SDXL_CKPT));
  const base = { ...defaultParams(), steps: 31 };

  it('a fresh button carries no hardcoded sampler, so the family default applies', () => {
    expect(defaultParams()).not.toHaveProperty('sampler');
    expect(samplerCorrection(sdxl, base)).toEqual({ params: { ...base, sampler: 'Euler a' }, reset: null });
  });

  it('a value the family offers is left alone', () => {
    expect(samplerCorrection(sdxl, { ...base, sampler: 'DPM++ 2M Karras' })).toBeNull();
  });

  it('a value the family does not offer is reset to the default, naming what it replaced', () => {
    expect(samplerCorrection(sdxl, { ...base, sampler: 'heun' })).toEqual({
      params: { ...base, sampler: 'Euler a' },
      reset: 'heun',
    });
  });

  it('a default missing from its own list falls back to the first option, never an invalid value', () => {
    const odd: SamplerControl = {
      kind: 'select',
      options: [{ value: 'b', label: 'B' }],
      defaultValue: 'zzz',
    };
    expect(samplerCorrection(odd, { ...base, sampler: 'q' })).toEqual({ params: { ...base, sampler: 'b' }, reset: 'q' });
  });

  it('"none" drops a stored sampler and leaves the other params', () => {
    const out = samplerCorrection({ kind: 'none' }, { ...base, sampler: 'Euler' });
    expect(out).toEqual({ params: base, reset: null });
    expect(out!.params).not.toHaveProperty('sampler');
    expect(samplerCorrection({ kind: 'none' }, base)).toBeNull();
  });

  it('free text and loading never rewrite what the author typed', () => {
    expect(samplerCorrection({ kind: 'free', note: 'x' }, { ...base, sampler: 'anything' })).toBeNull();
    expect(samplerCorrection({ kind: 'loading' }, { ...base, sampler: 'anything' })).toBeNull();
  });
});
