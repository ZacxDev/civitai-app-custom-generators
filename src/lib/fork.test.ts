// Fork (Make a copy) must produce a DEEP copy that shares no mutable references
// with the source generator — the parse path keeps some nested objects
// (checkpoint / individual loras) pointing at the original shared `data` blob,
// so a naive `{ ...config }` fork could let editing the copy mutate the original.

import { describe, expect, it } from 'vitest';

import { cloneConfigForFork, newButton, newGenerator } from './generator.js';

function sourceConfig() {
  return newGenerator({
    name: 'Original',
    description: 'desc',
    headerImageRef: { imageId: 1, url: 'https://img.example/cover.jpg' },
    buttons: [
      newButton({
        id: 'b1',
        label: 'Glow',
        checkpoint: { versionId: 1, modelId: 2, modelName: 'X' },
        loras: [{ versionId: 9, weight: 1, modelName: 'L', minStrength: 0, maxStrength: 2 }],
        promptTemplate: 'neon {prompt}',
        params: { ...newButton().params, steps: 22 },
      }),
    ],
  });
}

describe('cloneConfigForFork', () => {
  it('clones every nested object to a fresh identity (no shared refs)', () => {
    const src = sourceConfig();
    const fork = cloneConfigForFork(src);

    expect(fork).not.toBe(src);
    expect(fork.buttons).not.toBe(src.buttons);
    expect(fork.buttons[0]).not.toBe(src.buttons[0]);
    expect(fork.buttons[0].checkpoint).not.toBe(src.buttons[0].checkpoint);
    expect(fork.buttons[0].loras).not.toBe(src.buttons[0].loras);
    expect(fork.buttons[0].loras[0]).not.toBe(src.buttons[0].loras[0]);
    expect(fork.buttons[0].params).not.toBe(src.buttons[0].params);
    expect(fork.headerImageRef).not.toBe(src.headerImageRef);
  });

  it('assigns a fresh button id but preserves all values', () => {
    const src = sourceConfig();
    const fork = cloneConfigForFork(src);
    expect(fork.buttons[0].id).not.toBe('b1');
    expect(fork.name).toBe('Original');
    expect(fork.buttons[0].label).toBe('Glow');
    expect(fork.buttons[0].params.steps).toBe(22);
    expect(fork.buttons[0].loras[0].weight).toBe(1);
  });

  it('mutating the SOURCE after a fork does not affect the fork', () => {
    const src = sourceConfig();
    const fork = cloneConfigForFork(src);
    src.buttons[0].loras[0].weight = 99;
    src.buttons[0].checkpoint!.modelName = 'MUTATED';
    src.buttons[0].params.steps = 5;
    src.name = 'Renamed';

    expect(fork.buttons[0].loras[0].weight).toBe(1);
    expect(fork.buttons[0].checkpoint!.modelName).toBe('X');
    expect(fork.buttons[0].params.steps).toBe(22);
    expect(fork.name).toBe('Original');
  });
});
