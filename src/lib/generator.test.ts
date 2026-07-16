import { describe, expect, it } from 'vitest';
import type { BlockResourceInfo } from '@civitai/app-sdk/blocks';

import {
  buildPublishPayload,
  buildSubmitBody,
  canRunButton,
  checkpointFromPick,
  clampWeight,
  collectVersionIds,
  collectVisibleText,
  composePrompt,
  exposesImage,
  exposesPrompt,
  loraFromPick,
  missingRequiredInputs,
  mergeParams,
  moveButton,
  newButton,
  newGenerator,
  parsePublishedGenerator,
  rehydrateConfig,
  updateButton,
  validateGenerator,
} from './generator.js';
import type { GenButton, GeneratorConfig } from '../types.js';

const CKPT_PICK: BlockResourceInfo = {
  versionId: 1001,
  modelId: 500,
  modelName: 'DreamShaper',
  versionName: '8',
  baseModel: 'SD 1.5',
  modelType: 'Checkpoint',
};

const LORA_PICK: BlockResourceInfo = {
  versionId: 2002,
  modelId: 900,
  modelName: 'Neon Glow',
  versionName: 'v2',
  baseModel: 'SD 1.5',
  modelType: 'LORA',
  strength: 0.8,
  minStrength: 0,
  maxStrength: 1.5,
  trainedWords: ['neon'],
  clipSkip: 2,
};

function buttonWith(overrides: Partial<GenButton>): GenButton {
  return newButton({
    label: 'Go',
    checkpoint: { versionId: 1001, modelId: 500, modelName: 'DreamShaper', baseModel: 'SD 1.5' },
    promptTemplate: 'a portrait of {prompt}',
    ...overrides,
  });
}

describe('composePrompt', () => {
  it('splices runner input into the {prompt} token', () => {
    expect(composePrompt('a portrait of {prompt}, neon', 'a cat')).toBe('a portrait of a cat, neon');
  });
  it('appends input when the template has no token', () => {
    expect(composePrompt('neon portrait', 'a cat')).toBe('neon portrait a cat');
  });
  it('strips the token cleanly when there is no input', () => {
    expect(composePrompt('a portrait of {prompt}, neon')).toBe('a portrait of , neon');
  });
  it('trims whitespace from the input', () => {
    expect(composePrompt('{prompt}', '  hello  ')).toBe('hello');
  });
});

describe('clampWeight', () => {
  it('clamps above max and below min', () => {
    expect(clampWeight(3, 0, 1.5)).toBe(1.5);
    expect(clampWeight(-2, 0, 1.5)).toBe(0);
  });
  it('passes values inside the range', () => {
    expect(clampWeight(0.8, 0, 1.5)).toBe(0.8);
  });
  it('falls back to default weight on a non-finite value', () => {
    expect(clampWeight(Number.NaN, -1, 2)).toBe(1);
  });
});

describe('resource picks', () => {
  it('maps a checkpoint pick to a checkpoint ref', () => {
    expect(checkpointFromPick(CKPT_PICK)).toEqual({
      versionId: 1001,
      modelId: 500,
      modelName: 'DreamShaper',
      versionName: '8',
      baseModel: 'SD 1.5',
    });
  });

  it('seeds LoRA weight from the picker strength and keeps the clamp range', () => {
    const lora = loraFromPick(LORA_PICK);
    expect(lora.versionId).toBe(2002);
    expect(lora.weight).toBe(0.8); // seeded from strength
    expect(lora.minStrength).toBe(0);
    expect(lora.maxStrength).toBe(1.5);
    expect(lora.trainedWords).toEqual(['neon']);
  });

  it('clamps a seeded weight that exceeds the recommended range', () => {
    const lora = loraFromPick({ ...LORA_PICK, strength: 5, maxStrength: 1.5 });
    expect(lora.weight).toBe(1.5);
  });

  it('defaults weight/clamp when the pick omits recommended settings', () => {
    const lora = loraFromPick({ versionId: 3, modelId: 3, modelName: 'x', versionName: 'y', baseModel: 'SDXL', modelType: 'LORA' });
    expect(lora.weight).toBe(1);
    expect(lora.minStrength).toBe(-1);
    expect(lora.maxStrength).toBe(2);
  });
});

describe('buildSubmitBody', () => {
  it('builds a txt2img body with checkpoint + weighted LoRA stack + params, no sourceImage', () => {
    const button = buttonWith({
      workflowType: 'txt2img',
      loras: [
        { versionId: 2002, weight: 0.8, minStrength: 0, maxStrength: 1.5 },
        { versionId: 3003, weight: 1.2, minStrength: -1, maxStrength: 2 },
      ],
      params: { negativePrompt: 'blurry', cfgScale: 5, steps: 28, sampler: 'Euler', width: 768, height: 1024, seed: 42, quantity: 2 },
    });
    const body = buildSubmitBody(button, {
      promptInput: 'a fox',
      sharedContentKey: 'shared:abc',
      sourceImage: { url: 'https://image.civitai.com/x.jpg', width: 512, height: 512 },
    });

    expect(body.kind).toBe('textToImage');
    expect(body.modelId).toBe(500);
    expect(body.modelVersionId).toBe(1001);
    expect(body.params.prompt).toBe('a portrait of a fox');
    expect(body.params).toMatchObject({ negativePrompt: 'blurry', cfgScale: 5, steps: 28, sampler: 'Euler', width: 768, height: 1024, seed: 42, quantity: 2 });
    expect(body.additionalResources).toEqual([
      { modelVersionId: 2002, strength: 0.8 },
      { modelVersionId: 3003, strength: 1.2 },
    ]);
    expect(body.sharedContentKey).toBe('shared:abc');
    // txt2img must NOT carry a source image even when one is provided.
    expect(body.sourceImage).toBeUndefined();
  });

  it('includes sourceImage for an img2img button and re-clamps LoRA strength', () => {
    const button = buttonWith({
      workflowType: 'img2img',
      loras: [{ versionId: 2002, weight: 9, minStrength: 0, maxStrength: 1.5 }],
    });
    const src = { url: 'https://image.civitai.com/x.jpg', width: 640, height: 640 };
    const body = buildSubmitBody(button, { promptInput: 'a fox', sourceImage: src });

    expect(body.sourceImage).toEqual(src);
    // out-of-range author weight is clamped at build time
    expect(body.additionalResources).toEqual([{ modelVersionId: 2002, strength: 1.5 }]);
  });

  it('ignores a runner prompt when the template has no {prompt} token (fixed prompt)', () => {
    const button = buttonWith({ promptTemplate: 'fixed prompt' });
    const body = buildSubmitBody(button, { promptInput: 'should be ignored' });
    expect(body.params.prompt).toBe('fixed prompt');
  });

  it('applies runner param overrides over the authored params', () => {
    const button = buttonWith({ params: { ...newButton().params, quantity: 1, steps: 25 } });
    const body = buildSubmitBody(button, { paramOverrides: { quantity: 4, steps: 40 } });
    expect(body.params.quantity).toBe(4);
    expect(body.params.steps).toBe(40);
  });

  it('caps the LoRA stack at 5', () => {
    const loras = Array.from({ length: 7 }, (_, i) => ({ versionId: 10 + i, weight: 1 }));
    const body = buildSubmitBody(buttonWith({ loras }), {});
    expect(body.additionalResources).toHaveLength(5);
  });

  it('throws when the button has no checkpoint', () => {
    expect(() => buildSubmitBody(newButton({ checkpoint: undefined }), {})).toThrow(/checkpoint/i);
  });
});

describe('mergeParams', () => {
  it('only defined override keys win', () => {
    const base = { cfgScale: 4, steps: 25, quantity: 1 };
    expect(mergeParams(base, { steps: 30, quantity: undefined })).toEqual({ cfgScale: 4, steps: 30, quantity: 1 });
  });
  it('returns base when overrides are undefined', () => {
    const base = { steps: 25 };
    expect(mergeParams(base, undefined)).toBe(base);
  });
});

describe('publish payload split (moderation boundary)', () => {
  const config: GeneratorConfig = {
    name: 'Neon Studio',
    description: 'Glowing neon portraits.',
    buttons: [
      buttonWith({ label: 'Cyberpunk', promptTemplate: 'cyberpunk neon {prompt}', loras: [{ versionId: 2002, weight: 0.8 }] }),
      buttonWith({ label: 'Vaporwave', promptTemplate: 'vaporwave aesthetic {prompt}' }),
    ],
    headerImageRef: { imageId: 77, url: 'https://image.civitai.com/bg.jpg' },
  };

  it('puts ALL user-visible text in title/body (moderated)', () => {
    const { title, body } = collectVisibleText(config);
    expect(title).toBe('Neon Studio');
    expect(body).toContain('Glowing neon portraits.');
    expect(body).toContain('Cyberpunk');
    expect(body).toContain('cyberpunk neon {prompt}');
    expect(body).toContain('Vaporwave');
    expect(body).toContain('vaporwave aesthetic {prompt}');
  });

  it('puts the STRUCTURED config in the opaque data blob', () => {
    const payload = buildPublishPayload(config);
    expect(payload.title).toBe('Neon Studio');
    expect(typeof payload.body).toBe('string');
    const data = payload.data as { v: number; buttons: GenButton[]; headerImageRef?: { imageId: number } };
    expect(data.v).toBe(1);
    expect(data.buttons).toHaveLength(2);
    // resource ids + weights live in data (needed to run)
    expect(data.buttons[0].checkpoint?.versionId).toBe(1001);
    expect(data.buttons[0].loras[0]).toMatchObject({ versionId: 2002, weight: 0.8 });
    // WRITE path emits the new `headerImageRef` (never the legacy field).
    expect(data.headerImageRef).toEqual({ imageId: 77, url: 'https://image.civitai.com/bg.jpg' });
    expect((data as Record<string, unknown>).backgroundImageRef).toBeUndefined();
  });

  it('round-trips: parsePublishedGenerator reconstructs the config from data', () => {
    const payload = buildPublishPayload(config);
    const parsed = parsePublishedGenerator(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Neon Studio');
    expect(parsed!.description).toBe('Glowing neon portraits.');
    expect(parsed!.buttons).toHaveLength(2);
    expect(parsed!.buttons[0].checkpoint?.versionId).toBe(1001);
    expect(parsed!.headerImageRef?.imageId).toBe(77);
  });

  it('BACK-COMPAT: reads the legacy `backgroundImageRef` from an already-published row into headerImageRef', () => {
    // A row published BEFORE the header-image rename stored its cover under the
    // legacy `backgroundImageRef`. The read path must still surface it.
    const legacy = {
      title: 'Legacy Cover',
      body: 'desc',
      data: {
        v: 1 as const,
        buttons: [
          {
            id: 'l1',
            label: 'Go',
            workflowType: 'txt2img' as const,
            checkpoint: { versionId: 1001, modelId: 500 },
            loras: [],
            promptTemplate: 'neon {prompt}',
            params: newButton().params,
          },
        ],
        backgroundImageRef: { imageId: 77, url: 'https://image.civitai.com/legacy-bg.jpg' },
      },
    };
    const parsed = parsePublishedGenerator(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed!.headerImageRef).toEqual({ imageId: 77, url: 'https://image.civitai.com/legacy-bg.jpg' });
  });

  it('BACK-COMPAT: prefers the new `headerImageRef` when both fields are present', () => {
    const both = {
      title: 'Both',
      body: 'desc',
      data: {
        v: 1 as const,
        buttons: [
          { id: 'b1', label: 'Go', workflowType: 'txt2img' as const, checkpoint: { versionId: 1, modelId: 1 }, loras: [], promptTemplate: 'x {prompt}', params: newButton().params },
        ],
        headerImageRef: { imageId: 2, url: 'new.jpg' },
        backgroundImageRef: { imageId: 1, url: 'old.jpg' },
      },
    };
    expect(parsePublishedGenerator(both)!.headerImageRef).toEqual({ imageId: 2, url: 'new.jpg' });
  });

  it('returns null for an unrecognised data blob', () => {
    expect(parsePublishedGenerator({ title: 'x', body: 'y', data: { v: 99 } })).toBeNull();
    expect(parsePublishedGenerator({ title: 'x', body: 'y' })).toBeNull();
  });
});

describe('collectVersionIds + rehydrateConfig', () => {
  const config: GeneratorConfig = {
    name: 'G',
    description: '',
    buttons: [
      buttonWith({ checkpoint: { versionId: 1001, modelId: 500 }, loras: [{ versionId: 2002, weight: 5, minStrength: 0, maxStrength: 1.5 }] }),
    ],
  };

  it('collects deduped checkpoint + lora ids', () => {
    expect(collectVersionIds(config).sort()).toEqual([1001, 2002]);
  });

  it('enriches names + re-clamps weights from freshly fetched info', () => {
    const infos: BlockResourceInfo[] = [
      { ...CKPT_PICK, versionId: 1001 },
      { ...LORA_PICK, versionId: 2002, minStrength: 0, maxStrength: 1.0 },
    ];
    const out = rehydrateConfig(config, infos);
    expect(out.buttons[0].checkpoint?.modelName).toBe('DreamShaper');
    expect(out.buttons[0].loras[0].modelName).toBe('Neon Glow');
    // weight 5 re-clamped into the new [0,1] range
    expect(out.buttons[0].loras[0].weight).toBe(1.0);
  });

  it('leaves resources untouched when no matching info is returned', () => {
    const out = rehydrateConfig(config, []);
    expect(out.buttons[0].loras[0].weight).toBe(5); // unchanged (no info to re-clamp against)
  });
});

describe('validateGenerator', () => {
  it('accepts a well-formed generator', () => {
    expect(validateGenerator(newGenerator({ name: 'X', buttons: [buttonWith({})] }))).toEqual([]);
  });
  it('flags missing name, checkpoint, label, and an empty prompt template', () => {
    const errs = validateGenerator({
      name: '',
      description: '',
      buttons: [newButton({ label: '', checkpoint: undefined, promptTemplate: '' })],
    });
    expect(errs.some((e) => /name/i.test(e))).toBe(true);
    expect(errs.some((e) => /checkpoint/i.test(e))).toBe(true);
    expect(errs.some((e) => /label/i.test(e))).toBe(true);
    expect(errs.some((e) => /prompt/i.test(e))).toBe(true);
  });
  it('accepts an img2img button without any expose flag (inputs are inferred now)', () => {
    const errs = validateGenerator(
      newGenerator({ name: 'X', buttons: [buttonWith({ workflowType: 'img2img' })] }),
    );
    expect(errs).toEqual([]);
  });
  it('accepts a fully-fixed prompt (template text, no {prompt} token)', () => {
    const errs = validateGenerator(
      newGenerator({ name: 'X', buttons: [buttonWith({ promptTemplate: 'a fixed neon portrait' })] }),
    );
    expect(errs).toEqual([]);
  });
});

describe('inferred runtime inputs (replaces exposedInputs)', () => {
  it('exposesPrompt is driven ONLY by the {prompt} token in the template', () => {
    expect(exposesPrompt(buttonWith({ promptTemplate: 'a portrait of {prompt}' }))).toBe(true);
    expect(exposesPrompt(buttonWith({ promptTemplate: 'a fixed portrait' }))).toBe(false);
  });
  it('exposesImage is driven ONLY by the img2img workflow type', () => {
    expect(exposesImage(buttonWith({ workflowType: 'img2img' }))).toBe(true);
    expect(exposesImage(buttonWith({ workflowType: 'txt2img' }))).toBe(false);
  });
  it('a fresh button seeds the {prompt} token so its prompt box shows by default', () => {
    expect(exposesPrompt(newButton())).toBe(true);
  });
});

describe('required exposed inputs (missingRequiredInputs / canRunButton)', () => {
  const SOURCE = { url: 'src.jpg', width: 512, height: 512 };

  it('a prompt-exposing button requires a non-blank, whitespace-trimmed prompt', () => {
    const b = buttonWith({ promptTemplate: 'lego {prompt}', workflowType: 'txt2img' });
    expect(missingRequiredInputs(b, { promptInput: '' })).toEqual(['prompt']);
    expect(missingRequiredInputs(b, { promptInput: '   ' })).toEqual(['prompt']);
    expect(canRunButton(b, { promptInput: '' })).toBe(false);
    expect(canRunButton(b, { promptInput: 'a castle' })).toBe(true);
  });

  it('an img2img button requires a source image', () => {
    const b = buttonWith({ promptTemplate: 'restyle', workflowType: 'img2img' });
    expect(missingRequiredInputs(b, {})).toEqual(['image']);
    expect(canRunButton(b, { sourceImage: null })).toBe(false);
    expect(canRunButton(b, { sourceImage: SOURCE })).toBe(true);
  });

  it('a button exposing BOTH requires both a prompt and an image', () => {
    const b = buttonWith({ promptTemplate: 'restyle {prompt}', workflowType: 'img2img' });
    expect(missingRequiredInputs(b, {})).toEqual(['prompt', 'image']);
    expect(canRunButton(b, { promptInput: 'a fox' })).toBe(false);
    expect(canRunButton(b, { sourceImage: SOURCE })).toBe(false);
    expect(canRunButton(b, { promptInput: 'a fox', sourceImage: SOURCE })).toBe(true);
  });

  it('a button exposing NEITHER (fixed txt2img prompt) requires nothing', () => {
    const b = buttonWith({ promptTemplate: 'a fixed portrait', workflowType: 'txt2img' });
    expect(missingRequiredInputs(b, {})).toEqual([]);
    expect(canRunButton(b, {})).toBe(true);
  });
});

describe('migration from an old (exposedInputs) config', () => {
  // A legacy stored data blob still carrying the retired `exposedInputs` flag.
  function legacyPayload(exposedInputs: { prompt?: boolean; image?: boolean }, workflowType: 'txt2img' | 'img2img', promptTemplate: string) {
    return {
      title: 'Legacy Gen',
      body: 'legacy',
      data: {
        v: 1 as const,
        buttons: [
          {
            id: 'legacy1',
            label: 'Go',
            workflowType,
            checkpoint: { versionId: 1001, modelId: 500 },
            loras: [],
            promptTemplate,
            params: newButton().params,
            exposedInputs,
          },
        ],
      },
    };
  }

  it('drops exposedInputs entirely — the parsed button no longer carries it', () => {
    const parsed = parsePublishedGenerator(legacyPayload({ prompt: true, image: false }, 'txt2img', 'neon {prompt}'));
    expect(parsed).not.toBeNull();
    expect((parsed!.buttons[0] as unknown as Record<string, unknown>).exposedInputs).toBeUndefined();
  });

  it('exposedInputs no longer drives inputs: image box comes from workflowType, not the old flag', () => {
    // Old flag said image:true but the workflow is txt2img → NO image box now.
    const parsed = parsePublishedGenerator(legacyPayload({ prompt: false, image: true }, 'txt2img', 'fixed {prompt}'));
    expect(exposesImage(parsed!.buttons[0])).toBe(false);
    // And the prompt box is inferred from the token even though the old flag was false.
    expect(exposesPrompt(parsed!.buttons[0])).toBe(true);
  });

  it('preserves an old prompt-exposing button that lacked a token by injecting {prompt}', () => {
    const parsed = parsePublishedGenerator(legacyPayload({ prompt: true }, 'txt2img', 'a plain prompt'));
    expect(parsed!.buttons[0].promptTemplate).toContain('{prompt}');
    expect(exposesPrompt(parsed!.buttons[0])).toBe(true);
  });
});

describe('promptPlaceholder round-trip + moderation', () => {
  const config: GeneratorConfig = newGenerator({
    name: 'Placeholder Gen',
    description: 'desc',
    promptPlaceholder: 'a fox in the snow',
    buttons: [buttonWith({ label: 'Go', promptTemplate: 'neon {prompt}' })],
  });

  it('rides the moderated title/body (not just opaque data)', () => {
    const { body } = collectVisibleText(config);
    expect(body).toContain('a fox in the snow');
  });

  it('persists in data and round-trips through parse', () => {
    const payload = buildPublishPayload(config);
    expect((payload.data as { promptPlaceholder?: string }).promptPlaceholder).toBe('a fox in the snow');
    const parsed = parsePublishedGenerator(payload);
    expect(parsed!.promptPlaceholder).toBe('a fox in the snow');
    // description still round-trips even with the placeholder present
    expect(parsed!.description).toBe('desc');
  });
});

describe('button list helpers', () => {
  it('moveButton reorders immutably', () => {
    const b = [newButton({ id: 'a' }), newButton({ id: 'b' }), newButton({ id: 'c' })];
    const out = moveButton(b, 0, 2);
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a']);
    expect(b.map((x) => x.id)).toEqual(['a', 'b', 'c']); // original untouched
  });
  it('moveButton is a no-op out of range', () => {
    const b = [newButton({ id: 'a' })];
    expect(moveButton(b, 0, 5)).toBe(b);
  });
  it('updateButton patches only the matching id', () => {
    const b = [newButton({ id: 'a', label: 'A' }), newButton({ id: 'b', label: 'B' })];
    const out = updateButton(b, 'b', { label: 'B2' });
    expect(out[0].label).toBe('A');
    expect(out[1].label).toBe('B2');
  });
});
