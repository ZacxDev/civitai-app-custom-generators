// The insufficient-Buzz error classifier (fallback for a server-side spend
// rejection). Deterministic string heuristic — see lib/buzz.ts for why.

import { describe, expect, it } from 'vitest';

import { isInsufficientBuzzError } from './buzz.js';

describe('isInsufficientBuzzError', () => {
  it('matches the host insufficient-Buzz copy (case-insensitive, substring)', () => {
    // Byte-for-byte the mock host's message.
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
