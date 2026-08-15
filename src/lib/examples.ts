// Onboarding EXAMPLE generators, surfaced in the IntroPanel so a first-time
// viewer can "Make a copy" and immediately see how a generator is built. These
// are NOT real shared-storage rows — they are synthesized `SharedListItem`s
// whose `value` is a normal publish payload, so the existing fork path
// (`parsePublishedGenerator(item.value)` → new draft) forks them with zero
// special-casing. They never appear in the real Discover list; they only live
// inside the intro panel.

import type { SharedListItem } from '@civitai/blocks-react';

import type { GeneratorConfig } from '../types.js';
import { buildPublishPayload, newButton } from './generator.js';

// A real public SD 1.5 checkpoint (DreamShaper) so a forked copy is immediately
// valid + runnable (the runner rehydrates the resource by id on open).
const DREAMSHAPER = {
  versionId: 128713,
  modelId: 4384,
  modelName: 'DreamShaper',
  versionName: '8',
  baseModel: 'SD 1.5',
} as const;

export const EXAMPLE_GENERATORS: GeneratorConfig[] = [
  {
    name: 'Sticker Maker',
    description: 'Turn any idea into a die-cut sticker — type a subject and pick a style.',
    promptPlaceholder: 'a happy corgi',
    buttons: [
      newButton({
        label: 'Kawaii sticker',
        workflowType: 'txt2img',
        checkpoint: { ...DREAMSHAPER },
        loras: [],
        promptTemplate: 'die-cut sticker of {prompt}, kawaii, thick white border, flat vector art, vibrant',
        params: { negativePrompt: '', cfgScale: 5, steps: 22, sampler: 'Euler', width: 1024, height: 1024, seed: null, quantity: 1 },
      }),
      newButton({
        label: 'Holographic',
        workflowType: 'txt2img',
        checkpoint: { ...DREAMSHAPER },
        loras: [],
        promptTemplate: 'holographic die-cut sticker of {prompt}, iridescent, glossy, white border',
        params: { negativePrompt: '', cfgScale: 5, steps: 26, sampler: 'Euler', width: 1024, height: 1024, seed: null, quantity: 1 },
      }),
    ],
  },
  {
    name: 'Fantasy Portrait',
    description: 'One-click fantasy character portraits — describe your hero and pick a class.',
    promptPlaceholder: 'an elf ranger with silver hair',
    buttons: [
      newButton({
        label: 'Arcane mage',
        workflowType: 'txt2img',
        checkpoint: { ...DREAMSHAPER },
        loras: [],
        promptTemplate: 'fantasy portrait of {prompt}, arcane mage, glowing runes, dramatic light, highly detailed',
        params: { negativePrompt: 'blurry, lowres', cfgScale: 6, steps: 30, sampler: 'DPM++ 2M Karras', width: 768, height: 1024, seed: null, quantity: 1 },
      }),
    ],
  },
];

/** Build the synthetic `SharedListItem`s the intro panel forks from. */
export function exampleSharedItems(): SharedListItem[] {
  const epoch = new Date(0);
  return EXAMPLE_GENERATORS.map((config, i) => ({
    key: `example:${i}`,
    authorUserId: 0, // sentinel — not a real author
    value: buildPublishPayload(config),
    count: 0,
    createdAt: epoch,
    updatedAt: epoch,
  }));
}

/** Built once at module load (ids are minted inside `newButton`). */
export const EXAMPLE_SHARED_ITEMS: SharedListItem[] = exampleSharedItems();
