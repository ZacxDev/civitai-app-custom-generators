// Which sampler control a button's editor shows, from the platform's catalog and
// the button's CHECKPOINT (feedback #179).
//
// Pure, so every branch is tested without rendering. The lookup is
// `@civitai/app-sdk`'s `resolveGenerationSampler`, keyed on the checkpoint's
// `baseModel` and `versionId` — never a LoRA, which can belong to another family.
//
// 🔴 FOUR ANSWERS, AND ONLY ONE OF THEM HIDES THE FIELD. `none` means the
// platform said this family has no sampler control (Flux.1, for one), so the
// field hides and no sampler is sent. Anything the platform could NOT answer —
// no catalog, no checkpoint yet, a base model it does not map — is `free`: the
// old free-text field with a note, never a hidden field and never an empty list.

import { resolveGenerationSampler } from '@civitai/app-sdk/blocks';
import type { GenerationSamplerOption } from '@civitai/app-sdk/blocks';

import type { GenerationSamplersState } from '../platform/index.js';
import type { CheckpointRef, GenButtonParams } from '../types.js';

export type SamplerControl =
  /** The catalog has not answered yet. */
  | { kind: 'loading' }
  /** A drop-down of exactly these options; `defaultValue` is the family default. */
  | { kind: 'select'; options: GenerationSamplerOption[]; defaultValue: string }
  /** The family has no sampler control: hide the field, send no sampler. */
  | { kind: 'none' }
  /** Unknown: the free-text field, with `note` saying why. */
  | { kind: 'free'; note: string };

export const SAMPLER_NOTES = {
  unavailable: "Couldn't load the sampler list, so type a sampler name.",
  noCheckpoint: 'Pick a checkpoint to choose from its samplers.',
  unknownFamily: "This checkpoint's sampler list isn't known, so type a sampler name.",
} as const;

export function samplerControlFor(
  state: GenerationSamplersState | null,
  checkpoint: CheckpointRef | undefined,
): SamplerControl {
  if (state == null) return { kind: 'loading' };
  if (state.status !== 'ready') return { kind: 'free', note: SAMPLER_NOTES.unavailable };
  if (!checkpoint) return { kind: 'free', note: SAMPLER_NOTES.noCheckpoint };
  const lookup = resolveGenerationSampler(state.catalog, {
    baseModel: checkpoint.baseModel,
    modelVersionId: checkpoint.versionId,
  });
  if (!lookup.known) return { kind: 'free', note: SAMPLER_NOTES.unknownFamily };
  if (lookup.sampler === null) return { kind: 'none' };
  // Never an empty drop-down: a control with no options is not something to pick from.
  if (lookup.sampler.options.length === 0) return { kind: 'free', note: SAMPLER_NOTES.unknownFamily };
  return { kind: 'select', options: lookup.sampler.options, defaultValue: lookup.sampler.default };
}

/**
 * The params change the control requires, or `null` when the stored value is
 * already valid for it.
 *
 *  - `select`: a value the family does not offer becomes the family default
 *    (the host would otherwise swap it silently). `reset` carries the old value
 *    when there was one, so the editor can say what it replaced.
 *  - `none`: a stored sampler is removed, so none is sent.
 *  - `loading` / `free`: nothing to correct.
 */
export function samplerCorrection(
  control: SamplerControl,
  params: GenButtonParams,
): { params: GenButtonParams; reset: string | null } | null {
  const current = params.sampler;
  if (control.kind === 'select') {
    if (current !== undefined && control.options.some((o) => o.value === current)) return null;
    // A default the list does not contain would be an invalid value of our own making.
    const next = control.options.some((o) => o.value === control.defaultValue)
      ? control.defaultValue
      : control.options[0]!.value;
    return { params: { ...params, sampler: next }, reset: current ? current : null };
  }
  if (control.kind === 'none' && current !== undefined) {
    const { sampler: _dropped, ...rest } = params;
    return { params: rest, reset: null };
  }
  return null;
}
