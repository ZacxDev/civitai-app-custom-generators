import { describe, expect, it } from 'vitest';

import { newButton } from './generator.js';
import {
  UNNAMED_BUTTON_LABEL,
  describeButton,
  missingForButtonMessage,
  presetNeedsLabel,
  presetRecipeLabel,
} from './preset.js';

describe('describeButton — a button describes itself', () => {
  it('reads the requirement from the button ALONE, in a stable order', () => {
    const both = newButton({
      workflowType: 'img2img',
      promptTemplate: 'restyle {prompt}',
    });
    expect(describeButton(both).needs).toEqual(['prompt', 'image']);

    const promptOnly = newButton({ workflowType: 'txt2img', promptTemplate: 'a {prompt}' });
    expect(describeButton(promptOnly).needs).toEqual(['prompt']);

    const imageOnly = newButton({ workflowType: 'img2img', promptTemplate: 'restyle' });
    expect(describeButton(imageOnly).needs).toEqual(['image']);

    const neither = newButton({ workflowType: 'txt2img', promptTemplate: 'a fixed portrait' });
    expect(describeButton(neither).needs).toEqual([]);
  });

  it('names the pinned checkpoint as "<model> <version>", and null when unpinned', () => {
    const pinned = newButton({
      checkpoint: { versionId: 7, modelId: 3, modelName: 'DreamShaper', versionName: '8' },
    });
    expect(describeButton(pinned).checkpointName).toBe('DreamShaper 8');

    // A checkpoint with no version name must not render a trailing space.
    const noVersion = newButton({ checkpoint: { versionId: 7, modelId: 3, modelName: 'DreamShaper' } });
    expect(describeButton(noVersion).checkpointName).toBe('DreamShaper');

    expect(describeButton(newButton({ checkpoint: undefined })).checkpointName).toBeNull();
  });

  it('falls back to a placeholder label rather than rendering an empty control', () => {
    expect(describeButton(newButton({ label: '   ' })).label).toBe(UNNAMED_BUTTON_LABEL);
    expect(describeButton(newButton({ label: 'Cyberpunk' })).label).toBe('Cyberpunk');
  });

  /**
   * 🔴 The display path and the SPEND path must not disagree about what a button
   * is. A published generator's `data` is opaque and unmoderated, so a forged row
   * can carry `quantity: 999` / `width: 99999` — `clampParams` pulls those to
   * PARAM_BOUNDS on the run path, and a card that advertised the raw values would
   * be describing a generation that cannot happen.
   *
   * Fixture values are chosen to overshoot the bounds, not to sit on them, so a
   * mutant that drops the clamp changes the output rather than landing on the
   * same number by luck.
   */
  it('clamps advertised size and quantity to the same bounds the run path applies', () => {
    const forged = newButton({
      params: { ...newButton().params, width: 99999, height: 99999, quantity: 999, steps: 999 },
    });
    const p = describeButton(forged);
    expect(p.sizeLabel).toBe('2048×2048');
    expect(p.quantity).toBe(4);
    // And the advertised price is the clamped one, not the forged one.
    expect(p.approxCostBuzz).toBeLessThan(1_000);
  });

  it('reports the LoRA count, and survives a row whose loras are not an array', () => {
    const two = newButton({
      loras: [
        { versionId: 1, weight: 1 },
        { versionId: 2, weight: 1 },
      ],
    });
    expect(describeButton(two).loraCount).toBe(2);
    // A hostile/legacy blob can carry anything here.
    const hostile = { ...newButton(), loras: undefined as never };
    expect(describeButton(hostile).loraCount).toBe(0);
  });
});

describe('presetNeedsLabel — a statement about the button, not an instruction', () => {
  it('renders each combination literally', () => {
    expect(presetNeedsLabel(['prompt'])).toBe('Needs a prompt');
    expect(presetNeedsLabel(['image'])).toBe('Needs your image');
    expect(presetNeedsLabel(['prompt', 'image'])).toBe('Needs a prompt and your image');
  });

  it('returns null (not an empty string) when the button needs nothing', () => {
    expect(presetNeedsLabel([])).toBeNull();
  });

  /**
   * 🔴 THE SHAPE OF THE OLD BUG, pinned as a property.
   *
   * The Runner used to merge every button's missing inputs into ONE sentence, so
   * a generator with a txt2img button and an img2img button told the txt2img one
   * it needed an image. This asserts the replacement is a pure function OF ITS
   * ARGUMENT: the label for `['prompt']` is identical whether or not some other
   * button in the generator wants an image — because no other button is reachable
   * from here at all.
   */
  it('cannot be influenced by any other button', () => {
    const promptOnly = describeButton(newButton({ workflowType: 'txt2img', promptTemplate: 'a {prompt}' }));
    const imageHungry = describeButton(newButton({ workflowType: 'img2img', promptTemplate: 'restyle' }));
    expect(presetNeedsLabel(promptOnly.needs)).toBe('Needs a prompt');
    expect(presetNeedsLabel(imageHungry.needs)).toBe('Needs your image');
    // The union of the two is what the old code rendered for BOTH.
    expect(presetNeedsLabel([...promptOnly.needs, ...imageHungry.needs])).toBe(
      'Needs a prompt and your image',
    );
    // …and it is NOT what either button reports.
    expect(presetNeedsLabel(promptOnly.needs)).not.toBe('Needs a prompt and your image');
  });
});

describe('presetRecipeLabel', () => {
  it('joins only the parts it actually knows', () => {
    const full = describeButton(
      newButton({
        checkpoint: { versionId: 7, modelId: 3, modelName: 'DreamShaper', versionName: '8' },
        loras: [{ versionId: 1, weight: 1 }],
        params: { ...newButton().params, width: 768, height: 1024, quantity: 2 },
      }),
    );
    expect(presetRecipeLabel(full)).toBe('DreamShaper 8 · 1 LoRA · 768×1024 · ×2');
  });

  it('singularises one LoRA and omits a quantity of one', () => {
    const one = describeButton(
      newButton({
        checkpoint: { versionId: 7, modelId: 3, modelName: 'X' },
        loras: [{ versionId: 1, weight: 1 }],
        params: { ...newButton().params, width: 512, height: 512, quantity: 1 },
      }),
    );
    expect(presetRecipeLabel(one)).toBe('X · 1 LoRA · 512×512');

    const many = describeButton(
      newButton({
        checkpoint: { versionId: 7, modelId: 3, modelName: 'X' },
        loras: [
          { versionId: 1, weight: 1 },
          { versionId: 2, weight: 1 },
        ],
        params: { ...newButton().params, width: 512, height: 512, quantity: 1 },
      }),
    );
    expect(presetRecipeLabel(many)).toBe('X · 2 LoRAs · 512×512');
  });

  it('returns null when nothing is known, so no lonely separator renders', () => {
    const bare = describeButton(
      newButton({ checkpoint: undefined, loras: [], params: { quantity: 1 } }),
    );
    expect(presetRecipeLabel(bare)).toBeNull();
  });
});

describe('missingForButtonMessage — the imperative form, and it names the button', () => {
  it('names the button and only what that button is missing', () => {
    expect(missingForButtonMessage('Cyberpunk', ['prompt'])).toBe('“Cyberpunk” needs a prompt.');
    expect(missingForButtonMessage('Remix', ['image'])).toBe('“Remix” needs a source image.');
    expect(missingForButtonMessage('Both', ['prompt', 'image'])).toBe(
      '“Both” needs a prompt and a source image.',
    );
  });
});
