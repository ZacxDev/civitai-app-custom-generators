// Builder validation-error list: duplicate error strings must all render.
// A `key={e}` (the error string) silently collapses identical errors into one
// list item; the fix keys by index so every error is shown.

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Builder } from './Builder.js';
import { palette } from '../theme.js';
import { newButton } from '../lib/generator.js';
import type { GeneratorConfig } from '../types.js';

const c = palette();

function renderBuilder(initial: GeneratorConfig) {
  render(
    <Builder
      initial={initial}
      c={c}
      pickResource={vi.fn(async () => null)}
      uploadImage={vi.fn(async () => null)}
      scanBackground={vi.fn(async () => ({ status: 'scanned' as const }))}
      onSaveDraft={vi.fn(async () => {})}
      onPublish={vi.fn(async () => {})}
      onBack={vi.fn()}
    />,
  );
}

describe('Builder — duplicate validation errors all render (no key collision)', () => {
  it('renders one <li> per error even when two are identical', () => {
    // Two buttons share a label and both lack a checkpoint → two IDENTICAL
    // "Button Go needs a checkpoint." errors.
    const initial: GeneratorConfig = {
      name: 'Named',
      description: '',
      buttons: [
        newButton({ id: 'a', label: 'Go', checkpoint: undefined }),
        newButton({ id: 'b', label: 'Go', checkpoint: undefined }),
      ],
    };
    renderBuilder(initial);

    const list = screen.getByTestId('validation-errors');
    const dupes = within(list)
      .getAllByRole('listitem')
      .filter((li) => li.textContent === 'Button Go needs a checkpoint.');
    // With a duplicate `key={e}` React would drop the second — assert BOTH render.
    expect(dupes).toHaveLength(2);
  });
});
