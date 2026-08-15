// Cheap, PURE Buzz-cost heuristic for the Discover "≈ N ⚡ per run" signal.
//
// This is NOT the authoritative price — the real cost is the host `estimate()`
// on the run path (see Runner), which is what Confirm is gated on. This is only
// a rough at-a-glance figure so a browser can gauge cost BEFORE opening a
// generator, derived solely from a button's own params (steps × megapixels ×
// quantity). It is always shown prefixed with "≈" so it never reads as exact.
//
// The heuristic runs the params through the SAME `clampParams` bounds the money
// path uses, so a forged/over-limit shared `data` blob can't inflate the shown
// figure past the real caps either.

import type { SharedStorageValue } from '@civitai/app-sdk/blocks';

import type { GenButtonParams, GeneratorData } from '../types.js';
import { clampParams } from './generator.js';

/** Flat base per generation (fixed orchestrator overhead). */
export const BUZZ_BASE = 4;
/** Marginal Buzz per (step · megapixel). Tuned to a believable range, not exact. */
export const BUZZ_PER_STEP_MP = 0.5;

const DEFAULT_STEPS = 25;
const DEFAULT_DIM = 1024;
const DEFAULT_QTY = 1;
const MEGAPIXEL = 1024 * 1024;

/**
 * Approximate Buzz for ONE press of a button with these params. Deterministic
 * and always ≥ 1. Missing params fall back to the app's own defaults (25 steps,
 * 1024², quantity 1) — the same defaults the Builder seeds.
 */
export function estimateRunCostBuzz(params: GenButtonParams | undefined): number {
  const p = clampParams(params);
  const steps = p.steps ?? DEFAULT_STEPS;
  const width = p.width ?? DEFAULT_DIM;
  const height = p.height ?? DEFAULT_DIM;
  const quantity = p.quantity ?? DEFAULT_QTY;
  const megapixels = (width * height) / MEGAPIXEL;
  const perImage = BUZZ_BASE + BUZZ_PER_STEP_MP * steps * megapixels;
  return Math.max(1, Math.round(perImage) * quantity);
}

export interface CostRange {
  min: number;
  max: number;
}

/**
 * The min/max approximate per-run Buzz across a published generator's buttons,
 * read straight from the opaque `data` blob (defense-in-depth clamping applies
 * per button). Returns `null` when the row carries no usable button params — the
 * caller then shows no cost signal rather than a misleading "0".
 */
export function generatorCostRange(value: SharedStorageValue): CostRange | null {
  const data = value.data as GeneratorData | undefined;
  const buttons = Array.isArray(data?.buttons) ? data!.buttons : [];
  const costs = buttons
    .map((b) => estimateRunCostBuzz(b?.params))
    .filter((n) => Number.isFinite(n));
  if (costs.length === 0) return null;
  return { min: Math.min(...costs), max: Math.max(...costs) };
}

/**
 * Render a cost range as an approximate, clearly-non-exact label:
 * `"≈ 17 ⚡ per run"`, or `"≈ 12–34 ⚡ per run"` when the buttons differ. `null`
 * in ⇒ `null` out (no signal).
 */
export function formatCostRange(range: CostRange | null): string | null {
  if (!range) return null;
  const amount = range.min === range.max ? `${range.min}` : `${range.min}–${range.max}`;
  return `≈ ${amount} ⚡ per run`;
}
