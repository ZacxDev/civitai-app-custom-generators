// The insufficient-Buzz error classifier (fallback for a server-side spend
// rejection). Deterministic string heuristic — see lib/buzz.ts for why.

import { describe, expect, it } from 'vitest';

import { isInsufficientBuzzError } from './buzz.js';

describe('isInsufficientBuzzError', () => {
  it('matches insufficient-Buzz copy shapes (case-insensitive, substring)', () => {
    // 🔴 THIS STRING NO LONGER HAS A SOURCE IN THIS TREE, AND THAT IS STATED
    // RATHER THAN PAPERED OVER. It was copied byte-for-byte from the bridge-era
    // `@civitai/blocks-react` mock host, which is not installed any more; the
    // app's own fake refuses with `insufficient buzz budget: …` (covered by the
    // next line's substring). So this is a realistic fixture whose shape nothing
    // here reproduces — keep it as a realistic input to the classifier, not as
    // evidence about what any host actually sends.
    expect(isInsufficientBuzzError('Insufficient Buzz to run this generation.')).toBe(true);
    expect(isInsufficientBuzzError('insufficient buzz')).toBe(true);
    expect(isInsufficientBuzzError('Not enough Buzz.')).toBe(true);
    expect(isInsufficientBuzzError('You have NOT ENOUGH BUZZ for this')).toBe(true);
  });

  it('does not misclassify unrelated failures', () => {
    expect(isInsufficientBuzzError('Orchestrator unavailable.')).toBe(false);
    expect(isInsufficientBuzzError('Model version not found')).toBe(false);
    expect(isInsufficientBuzzError('')).toBe(false);
    expect(isInsufficientBuzzError(undefined)).toBe(false);
    expect(isInsufficientBuzzError(null)).toBe(false);
  });
});
