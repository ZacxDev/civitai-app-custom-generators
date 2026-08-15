// IntroPanel — the one-time onboarding explainer + seeded examples. Rendered
// directly against props.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { IntroPanel } from './IntroPanel.js';
import { palette } from '../theme.js';
import { EXAMPLE_SHARED_ITEMS } from '../lib/examples.js';

const c = palette();

function renderIntro(over: Partial<React.ComponentProps<typeof IntroPanel>> = {}) {
  const props = {
    c,
    examples: EXAMPLE_SHARED_ITEMS,
    onTryExample: vi.fn(),
    onCreate: vi.fn(),
    onDismiss: vi.fn(),
    ...over,
  };
  render(<IntroPanel {...props} />);
  return props;
}

describe('IntroPanel', () => {
  it('explains the concept, including that a button is a saved preset', () => {
    renderIntro();
    expect(screen.getByText(/what's a custom generator/i)).toBeInTheDocument();
    // The core concept: a button = a saved generation preset (checkpoint + LoRAs + prompt).
    expect(screen.getByTestId('intro-panel')).toHaveTextContent(/saved generation preset/i);
    expect(screen.getByTestId('intro-panel')).toHaveTextContent(/checkpoint/i);
    expect(screen.getByTestId('intro-panel')).toHaveTextContent(/prompt template/i);
  });

  it('seeds copy-able examples, each with an approximate cost signal', () => {
    renderIntro();
    const examples = screen.getAllByTestId('intro-example');
    expect(examples.length).toBeGreaterThan(0);
    for (const ex of examples) {
      expect(within(ex).getByTestId('intro-example-cost')).toHaveTextContent(/≈ .* ⚡ per run/);
      expect(within(ex).getByTestId('intro-example-copy')).toBeInTheDocument();
    }
  });

  it('"Make a copy" forks the specific example via onTryExample', async () => {
    const onTryExample = vi.fn();
    renderIntro({ onTryExample });
    const first = screen.getAllByTestId('intro-example')[0];
    await userEvent.click(within(first).getByTestId('intro-example-copy'));
    expect(onTryExample).toHaveBeenCalledTimes(1);
    expect(onTryExample).toHaveBeenCalledWith(EXAMPLE_SHARED_ITEMS[0]);
  });

  it('"Build your own" and "Got it" call their handlers', async () => {
    const onCreate = vi.fn();
    const onDismiss = vi.fn();
    renderIntro({ onCreate, onDismiss });
    await userEvent.click(screen.getByTestId('intro-create'));
    expect(onCreate).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('intro-dismiss'));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('hides the examples section when none are provided', () => {
    renderIntro({ examples: [] });
    expect(screen.queryByTestId('intro-examples')).not.toBeInTheDocument();
    // concept + CTA still render
    expect(screen.getByTestId('intro-create')).toBeInTheDocument();
  });
});
