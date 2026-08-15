// Shared demo fixtures: a couple of published generators used to seed the SDK
// mock host (dev harness + tests) so the browse/run loop has content offline.

import type { MockSharedSeed } from '@civitai/blocks-react/testing';

import { buildPublishPayload, newButton } from './lib/generator.js';
import type { GeneratorConfig } from './types.js';

export const DEMO_GENERATOR: GeneratorConfig = {
  name: 'Neon Portrait Studio',
  description: 'One-click neon-lit portraits. Type a subject and pick a vibe.',
  buttons: [
    newButton({
      id: 'demo-btn-1',
      label: 'Cyberpunk',
      workflowType: 'txt2img',
      checkpoint: { versionId: 128713, modelId: 4384, modelName: 'DreamShaper', versionName: '8', baseModel: 'SD 1.5' },
      loras: [
        { versionId: 82098, weight: 0.8, modelName: 'Neon Glow', minStrength: 0, maxStrength: 1.5, trainedWords: ['neon'] },
      ],
      promptTemplate: 'cyberpunk neon portrait of {prompt}, rain, bokeh, cinematic',
      params: { negativePrompt: 'blurry, lowres', cfgScale: 5, steps: 28, sampler: 'DPM++ 2M Karras', width: 768, height: 1024, seed: null, quantity: 1 },
    }),
    newButton({
      id: 'demo-btn-2',
      label: 'Remix a photo',
      workflowType: 'img2img',
      checkpoint: { versionId: 128713, modelId: 4384, modelName: 'DreamShaper', versionName: '8', baseModel: 'SD 1.5' },
      loras: [],
      promptTemplate: 'neon restyle, glowing rim light, {prompt}',
      params: { negativePrompt: '', cfgScale: 4, steps: 22, sampler: 'Euler', width: 768, height: 768, seed: null, quantity: 1 },
    }),
  ],
  headerImageRef: { imageId: 555001, url: 'https://image.civitai.com/demo/header.jpeg' },
};

export const DEMO_SHARED_SEED: MockSharedSeed[] = [
  {
    value: buildPublishPayload(DEMO_GENERATOR),
    authorUserId: 7, // authored by someone else → shows in "Discover"
    voters: [1, 2, 3],
  },
];
