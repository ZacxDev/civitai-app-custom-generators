// What a generator BUTTON actually is, described for the person about to press it.
//
// 🔴 THE DEFECT THIS EXISTS TO FIX. A published generator's buttons rendered as
// bare labelled pills — "Cyberpunk", "Remix a photo" — so a runner could not tell
// what any of them would do, roughly what it would cost, or what it needed from
// them. They pressed a stranger's button and found out by spending Buzz. This
// app's whole proposition is "someone built you a button"; an anonymous button is
// that proposition with the useful half removed.
//
// 🔴 AND ITS SHARPER HALF, which is a correctness bug rather than a presentation
// one. The Runner's "what's still needed" hint was a UNION over every button
// (`config.buttons.some(exposesImage)` / a `Set` merged across the loop), so a
// generator carrying one txt2img button and one img2img button told a viewer
// pressing the TXT2IMG one to "Enter a prompt and add a source image to run" —
// demanding an upload that button never uses and cannot use. A requirement is a
// property OF A BUTTON. It is derived per-button here; the union survives only
// where it is genuinely correct, i.e. deciding whether a SHARED input field is
// rendered on the form at all.
//
// Everything here is PURE and lives in the `node` vitest project: no DOM, no
// hooks, literal expectations.

import type { GenButton } from '../types.js';
import { clampParams, exposesImage, exposesPrompt, type RequiredInput } from './generator.js';
import { estimateRunCostBuzz } from './cost.js';

/**
 * A button, described in the terms the person pressing it cares about.
 *
 * 🔴 Every numeric field is read through `clampParams`, the SAME bounds the money
 * path applies — so a forged or over-limit published `data` blob cannot make a
 * button advertise a size or a cost the run would not actually honour. This
 * mirrors `generatorCostRange`'s reasoning in `lib/cost.ts`; the display path and
 * the spend path must not disagree about what a button is.
 */
export interface ButtonPreset {
  label: string;
  /**
   * What the RUNNER must supply for THIS button — never a union across the
   * generator's other buttons. Order is stable (`prompt` before `image`) so the
   * rendered sentence is deterministic.
   */
  needs: RequiredInput[];
  /** Pinned checkpoint, as "<model> <version>", or null when the button has none. */
  checkpointName: string | null;
  loraCount: number;
  /** Clamped output size as "768×1024", or null when neither dimension is set. */
  sizeLabel: string | null;
  /** Clamped image count for one press (always ≥ 1). */
  quantity: number;
  /** Approximate Buzz for one press — the same heuristic Discover shows. */
  approxCostBuzz: number;
}

/** Fallback when a button carries no label at all (matches the Runner's own). */
export const UNNAMED_BUTTON_LABEL = 'Button';

/**
 * Describe one button. Pure; safe on a hostile `data` blob (every numeric goes
 * through `clampParams`, and a missing checkpoint yields `null` rather than a
 * fabricated name).
 */
export function describeButton(button: GenButton): ButtonPreset {
  const params = clampParams(button.params);
  const needs: RequiredInput[] = [];
  if (exposesPrompt(button)) needs.push('prompt');
  if (exposesImage(button)) needs.push('image');

  const ckpt = button.checkpoint;
  const checkpointName = ckpt?.modelName
    ? [ckpt.modelName, ckpt.versionName].filter(Boolean).join(' ')
    : null;

  const width = params.width;
  const height = params.height;
  const sizeLabel = width != null && height != null ? `${width}×${height}` : null;

  return {
    label: button.label?.trim() || UNNAMED_BUTTON_LABEL,
    needs,
    checkpointName,
    loraCount: Array.isArray(button.loras) ? button.loras.length : 0,
    sizeLabel,
    quantity: params.quantity ?? 1,
    approxCostBuzz: estimateRunCostBuzz(button.params),
  };
}

/**
 * "What this button needs from you", as a sentence — or `null` when it needs
 * nothing (a fully self-contained one-tap preset, which is the app's best case
 * and should read as such rather than as an empty string).
 *
 * 🔴 Phrased as a STATEMENT ABOUT THE BUTTON ("Needs a prompt"), not as an
 * instruction to the viewer ("Enter a prompt"). The card is describing a preset
 * that may not be the one they press; an imperative there reads as a demand the
 * whole screen is making, which is exactly the union-hint bug in words.
 */
export function presetNeedsLabel(needs: readonly RequiredInput[]): string | null {
  const prompt = needs.includes('prompt');
  const image = needs.includes('image');
  if (prompt && image) return 'Needs a prompt and your image';
  if (image) return 'Needs your image';
  if (prompt) return 'Needs a prompt';
  return null;
}

/**
 * "What this button is made of", as a compact recipe line — checkpoint, LoRA
 * count, output size. `null` when nothing is known, so the card renders no line
 * at all rather than a lonely separator.
 */
export function presetRecipeLabel(preset: ButtonPreset): string | null {
  const parts: string[] = [];
  if (preset.checkpointName) parts.push(preset.checkpointName);
  if (preset.loraCount > 0) parts.push(`${preset.loraCount} LoRA${preset.loraCount === 1 ? '' : 's'}`);
  if (preset.sizeLabel) parts.push(preset.sizeLabel);
  if (preset.quantity > 1) parts.push(`×${preset.quantity}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The imperative form, for the ONE button the viewer actually tried to press and
 * could not. This is the only place an instruction is correct, because by now a
 * specific button is in hand.
 *
 * 🔴 Names the button. The old message did not, so on a multi-button generator it
 * was ambiguous which press it was answering.
 */
export function missingForButtonMessage(label: string, missing: readonly RequiredInput[]): string {
  const prompt = missing.includes('prompt');
  const image = missing.includes('image');
  const what = prompt && image ? 'a prompt and a source image' : image ? 'a source image' : 'a prompt';
  return `“${label}” needs ${what}.`;
}
