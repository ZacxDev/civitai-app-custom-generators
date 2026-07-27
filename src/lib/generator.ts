// PURE, node-testable core of Custom Generators. No React, no SDK hooks, no
// network — every function here is a deterministic transform over the app's own
// data model. This is where the money-shaped logic lives (submit-body
// construction, the publish text/data split, weight clamping), so it is the
// primary unit-test surface.

import type {
  BlockResourceInfo,
  BlockSourceImage,
  BlockTextToImageParams,
  SharedStorageValue,
  WorkflowBodyTextToImage,
} from '@civitai/app-sdk/blocks';

import type {
  CheckpointRef,
  GenButton,
  GenButtonParams,
  GeneratorConfig,
  GeneratorData,
  LoraRef,
  WorkflowType,
} from '../types.js';

/** Placeholder in a promptTemplate where the runner's typed prompt is spliced. */
export const PROMPT_TOKEN = '{prompt}';

/** Fallback placeholder for the Runner's prompt box when the author sets none. */
export const DEFAULT_PROMPT_PLACEHOLDER = 'Describe what you want…';

/** Max LoRAs the server accepts in `additionalResources` (mirrors the Zod gate). */
export const MAX_LORAS = 5;

/** Default weight clamp when a picked LoRA carries no recommended range. */
export const DEFAULT_MIN_WEIGHT = -1;
export const DEFAULT_MAX_WEIGHT = 2;
export const DEFAULT_WEIGHT = 1;

let idCounter = 0;
/** A process-local stable id for a button (persistence-irrelevant). */
export function newId(prefix = 'btn'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export function defaultParams(): GenButtonParams {
  return {
    negativePrompt: '',
    cfgScale: 4,
    steps: 25,
    sampler: 'Euler',
    width: 1024,
    height: 1024,
    seed: null,
    quantity: 1,
  };
}

export function newButton(overrides: Partial<GenButton> = {}): GenButton {
  return {
    id: newId(),
    label: 'New button',
    workflowType: 'txt2img',
    checkpoint: undefined,
    loras: [],
    // Seed the token so a fresh button shows a runtime prompt box by default
    // (the prompt box is now INFERRED from the presence of `{prompt}`).
    promptTemplate: PROMPT_TOKEN,
    params: defaultParams(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Inferred runtime inputs (replaces the old persisted `exposedInputs` flags)
// ---------------------------------------------------------------------------

/**
 * Does a button surface a runtime PROMPT box? Inferred purely from the template:
 * the box shows iff the template contains the `{prompt}` token (i.e. the author
 * left a slot for the runner's typed prompt). A template with no token is a
 * fully-fixed prompt — valid, but no box.
 */
export function exposesPrompt(button: GenButton): boolean {
  return button.promptTemplate.includes(PROMPT_TOKEN);
}

/**
 * Does a button surface a runtime IMAGE (img2img source) box? Inferred purely
 * from the workflow type — an img2img button always needs a source image.
 */
export function exposesImage(button: GenButton): boolean {
  return button.workflowType === 'img2img';
}

/** A runtime input a button can REQUIRE the runner to supply before it runs. */
export type RequiredInput = 'prompt' | 'image';

/**
 * Which required runtime inputs are still MISSING for a button given the
 * runner's current (shared) field values — empty ⇒ the button is runnable.
 * Enforcement mirrors exposure: a `{prompt}`-token button requires a non-blank
 * prompt (whitespace-trimmed, so all-whitespace counts as empty), an img2img
 * button requires a source image. A button that exposes an input imposes NO
 * requirement for one it doesn't (a fully-fixed txt2img button requires
 * nothing).
 */
export function missingRequiredInputs(
  button: GenButton,
  inputs: { promptInput?: string; sourceImage?: BlockSourceImage | null },
): RequiredInput[] {
  const missing: RequiredInput[] = [];
  if (exposesPrompt(button) && !(inputs.promptInput ?? '').trim()) missing.push('prompt');
  if (exposesImage(button) && !inputs.sourceImage) missing.push('image');
  return missing;
}

/** A button is runnable iff every runtime input it exposes is satisfied. */
export function canRunButton(
  button: GenButton,
  inputs: { promptInput?: string; sourceImage?: BlockSourceImage | null },
): boolean {
  return missingRequiredInputs(button, inputs).length === 0;
}

export function newGenerator(overrides: Partial<GeneratorConfig> = {}): GeneratorConfig {
  return {
    name: '',
    description: '',
    buttons: [newButton()],
    headerImageRef: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Prompt composition + weight clamping (pure)
// ---------------------------------------------------------------------------

/**
 * Compose the effective prompt for a generation.
 * - When the button exposes a prompt input AND the runner typed something, the
 *   input is spliced into `{prompt}` (or appended if the template has no token).
 * - When no input is exposed/typed, the raw template is used (the `{prompt}`
 *   token, if any, is stripped so it never leaks into the generation).
 */
export function composePrompt(template: string, userInput?: string): string {
  const input = (userInput ?? '').trim();
  const hasToken = template.includes(PROMPT_TOKEN);
  if (input) {
    if (hasToken) return template.split(PROMPT_TOKEN).join(input).trim();
    return `${template} ${input}`.trim();
  }
  // No input: drop the token cleanly.
  return template.split(PROMPT_TOKEN).join('').replace(/\s+/g, ' ').trim();
}

/** Clamp a weight into [min,max]; non-finite falls back to the default weight. */
export function clampWeight(value: number, min: number, max: number): number {
  const lo = Number.isFinite(min) ? min : DEFAULT_MIN_WEIGHT;
  const hi = Number.isFinite(max) ? max : DEFAULT_MAX_WEIGHT;
  const v = Number.isFinite(value) ? value : DEFAULT_WEIGHT;
  if (lo > hi) return v; // degenerate range — leave as-is
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// Resource picker / rehydrate mapping (pure)
// ---------------------------------------------------------------------------

/** Map a Checkpoint pick to the stored checkpoint ref. */
export function checkpointFromPick(pick: BlockResourceInfo): CheckpointRef {
  return {
    versionId: pick.versionId,
    modelId: pick.modelId,
    modelName: pick.modelName,
    versionName: pick.versionName,
    baseModel: pick.baseModel,
  };
}

/**
 * Seed a LoRA ref from a picker/rehydrate result: the weight is seeded from the
 * recommended `strength` and clamped into the recommended [min,max] range.
 */
export function loraFromPick(pick: BlockResourceInfo): LoraRef {
  const min = pick.minStrength ?? DEFAULT_MIN_WEIGHT;
  const max = pick.maxStrength ?? DEFAULT_MAX_WEIGHT;
  const seed = pick.strength ?? DEFAULT_WEIGHT;
  return {
    versionId: pick.versionId,
    weight: clampWeight(seed, min, max),
    modelName: pick.modelName,
    versionName: pick.versionName,
    minStrength: min,
    maxStrength: max,
    trainedWords: pick.trainedWords,
  };
}

/** All modelVersion ids referenced by a config (checkpoints + LoRAs), deduped. */
export function collectVersionIds(config: GeneratorConfig): number[] {
  const ids = new Set<number>();
  for (const b of config.buttons) {
    if (b.checkpoint) ids.add(b.checkpoint.versionId);
    for (const l of b.loras) ids.add(l.versionId);
  }
  return [...ids];
}

/**
 * Enrich a config's resources with freshly-fetched public info (names + weight
 * clamps), WITHOUT changing which resources are pinned or the author's chosen
 * weights beyond re-clamping into the (possibly new) recommended range. Used on
 * load to rehydrate a saved/published generator whose `data` held only ids.
 */
export function rehydrateConfig(
  config: GeneratorConfig,
  infos: BlockResourceInfo[],
): GeneratorConfig {
  const byId = new Map<number, BlockResourceInfo>();
  for (const i of infos) byId.set(i.versionId, i);

  return {
    ...config,
    buttons: config.buttons.map((b) => {
      const checkpoint = b.checkpoint
        ? mergeCheckpoint(b.checkpoint, byId.get(b.checkpoint.versionId))
        : b.checkpoint;
      const loras = b.loras.map((l) => mergeLora(l, byId.get(l.versionId)));
      return { ...b, checkpoint, loras };
    }),
  };
}

function mergeCheckpoint(ref: CheckpointRef, info: BlockResourceInfo | undefined): CheckpointRef {
  if (!info) return ref;
  return {
    ...ref,
    modelName: info.modelName ?? ref.modelName,
    versionName: info.versionName ?? ref.versionName,
    baseModel: info.baseModel ?? ref.baseModel,
  };
}

function mergeLora(ref: LoraRef, info: BlockResourceInfo | undefined): LoraRef {
  if (!info) return ref;
  const min = info.minStrength ?? ref.minStrength ?? DEFAULT_MIN_WEIGHT;
  const max = info.maxStrength ?? ref.maxStrength ?? DEFAULT_MAX_WEIGHT;
  return {
    ...ref,
    modelName: info.modelName ?? ref.modelName,
    versionName: info.versionName ?? ref.versionName,
    trainedWords: info.trainedWords ?? ref.trainedWords,
    minStrength: min,
    maxStrength: max,
    weight: clampWeight(ref.weight, min, max),
  };
}

// ---------------------------------------------------------------------------
// Runner: submit-body construction (pure, money-shaped)
// ---------------------------------------------------------------------------

export interface BuildBodyOptions {
  /** Runner-typed prompt (used only when the button exposes a prompt input). */
  promptInput?: string;
  /**
   * UNSCANNED img2img source image (used only for an img2img button). This is a
   * generation INPUT uploaded via the `generationSource` purpose — the
   * orchestrator scans the OUTPUT at gen time, so the source itself carries no
   * moderation verdict. (Distinct from the cosmetic background, which IS the
   * moderated `display` upload because it's public content shown to others.)
   */
  sourceImage?: BlockSourceImage;
  /** The published generator's shared_kv key → creator attribution (G5). */
  sharedContentKey?: string;
  /** Runner "advanced" overrides merged over the author's params (e.g. quantity/seed/steps). */
  paramOverrides?: Partial<GenButtonParams>;
}

/** Merge runner overrides over a button's authored params (only defined keys win). */
export function mergeParams(
  base: GenButtonParams,
  overrides: Partial<GenButtonParams> | undefined,
): GenButtonParams {
  if (!overrides) return base;
  const out: GenButtonParams = { ...base };
  (Object.keys(overrides) as Array<keyof GenButtonParams>).forEach((k) => {
    const v = overrides[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  });
  return out;
}

/**
 * Build the `WorkflowBody` for one button press. Deterministic: given a button +
 * runtime inputs, produces exactly the body the host/orchestrator will price and
 * run. `kind` is always `'textToImage'`; img2img is signalled purely by the
 * presence of `sourceImage` (per the SDK WorkflowBody contract).
 *
 * DISCOVERY-ONLY ids: `modelVersionId` / `additionalResources[].modelVersionId`
 * are hints; the server re-validates + re-prices every id at estimate/submit.
 *
 * Typed to the `textToImage` MEMBER of the `WorkflowBody` discriminated union
 * (app-sdk 0.26+). `WorkflowBodyTextToImage` is assignable to `WorkflowBody`, so
 * `estimate()`/`submit()` call-sites are unchanged — this only narrows the
 * builder so it can read/write the member-only fields (`params`,
 * `modelVersionId`, `additionalResources`, …) that no longer live on the union.
 */
export function buildSubmitBody(button: GenButton, opts: BuildBodyOptions = {}): WorkflowBodyTextToImage {
  if (!button.checkpoint) {
    throw new Error('Button has no checkpoint pinned — cannot build a generation body.');
  }

  const prompt = composePrompt(
    button.promptTemplate,
    exposesPrompt(button) ? opts.promptInput : undefined,
  );

  const p = mergeParams(button.params, opts.paramOverrides);
  const params: BlockTextToImageParams = { prompt };
  if (p.negativePrompt) params.negativePrompt = p.negativePrompt;
  if (isNum(p.cfgScale)) params.cfgScale = p.cfgScale;
  if (p.sampler) params.sampler = p.sampler;
  if (isNum(p.steps)) params.steps = p.steps;
  if (p.seed === null || isNum(p.seed)) params.seed = p.seed;
  if (isNum(p.width)) params.width = p.width;
  if (isNum(p.height)) params.height = p.height;
  if (isNum(p.quantity)) params.quantity = p.quantity;

  const body: WorkflowBodyTextToImage = {
    kind: 'textToImage',
    modelId: button.checkpoint.modelId,
    modelVersionId: button.checkpoint.versionId,
    params,
  };

  const loras = button.loras.slice(0, MAX_LORAS);
  if (loras.length > 0) {
    body.additionalResources = loras.map((l) => ({
      modelVersionId: l.versionId,
      strength: clampWeight(
        l.weight,
        l.minStrength ?? DEFAULT_MIN_WEIGHT,
        l.maxStrength ?? DEFAULT_MAX_WEIGHT,
      ),
    }));
  }

  // img2img is expressed ONLY via sourceImage (kind stays 'textToImage').
  if (button.workflowType === 'img2img' && opts.sourceImage) {
    body.sourceImage = opts.sourceImage;
  }

  if (opts.sharedContentKey) body.sharedContentKey = opts.sharedContentKey;

  return body;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---------------------------------------------------------------------------
// Publish: text/data split (moderation boundary)
// ---------------------------------------------------------------------------

/**
 * The complete user-visible text of a generator — everything the platform must
 * moderate. Goes into the shared record's `title`/`body`; NEVER only into
 * `data` (which is opaque + unmoderated).
 */
export function collectVisibleText(config: GeneratorConfig): { title: string; body: string } {
  const lines: string[] = [];
  if (config.description.trim()) lines.push(config.description.trim());
  // The prompt-box placeholder is author-written text shown to runners — it must
  // ride the moderated title/body path, not hide in the opaque `data` blob.
  if (config.promptPlaceholder?.trim()) lines.push(`Prompt hint: ${config.promptPlaceholder.trim()}`);
  const buttonLines = config.buttons.map((b) => {
    const parts = [`• ${b.label.trim()}`];
    if (b.promptTemplate.trim()) parts.push(b.promptTemplate.trim());
    return parts.join(': ');
  });
  if (buttonLines.length) {
    lines.push('Buttons:');
    lines.push(...buttonLines);
  }
  return { title: config.name.trim(), body: lines.join('\n') };
}

/**
 * Reduce a button to the persisted GenButton shape — drops any legacy field
 * (notably the retired `exposedInputs`) so it never rides into shared `data`.
 */
function sanitizeButton(b: GenButton): GenButton {
  return {
    id: b.id,
    label: b.label,
    workflowType: b.workflowType,
    checkpoint: b.checkpoint,
    loras: b.loras,
    promptTemplate: b.promptTemplate,
    params: b.params,
  };
}

/**
 * Build the SHARED-storage `append` value for publishing a generator.
 *
 * THE SPLIT (the whole reason the platform stayed generator-agnostic):
 *  - `title` / `body`  → ALL user-visible TEXT (name, description, every button
 *    label, every promptTemplate). This is what the platform's text
 *    content-safety belt moderates.
 *  - `data`            → the opaque STRUCTURED config (buttons w/ resource
 *    ids+weights, params, exposed inputs, headerImageRef). Unmoderated,
 *    app-owned — carries no user-visible text that isn't ALSO in title/body.
 */
export function buildPublishPayload(config: GeneratorConfig): SharedStorageValue {
  const { title, body } = collectVisibleText(config);
  const data: GeneratorData = {
    v: 1,
    buttons: config.buttons.map(sanitizeButton),
    headerImageRef: config.headerImageRef,
    promptPlaceholder: config.promptPlaceholder?.trim() || undefined,
  };
  return { title, body, data };
}

/**
 * Migrate one stored button (possibly an OLD-shape row that still carries the
 * retired `exposedInputs` flag) into the current GenButton. Runtime inputs are
 * now INFERRED from `promptTemplate` (`{prompt}`) + `workflowType` — so we drop
 * the flag, but preserve author intent: a legacy button that exposed a prompt
 * input yet has no `{prompt}` token would silently lose its box, so we append
 * the token to keep the box.
 */
function migrateStoredButton(raw: unknown): GenButton | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Partial<GenButton> & {
    exposedInputs?: { prompt?: boolean; image?: boolean };
  };
  let promptTemplate = typeof b.promptTemplate === 'string' ? b.promptTemplate : '';
  if (b.exposedInputs?.prompt && !promptTemplate.includes(PROMPT_TOKEN)) {
    promptTemplate = `${promptTemplate} ${PROMPT_TOKEN}`.trim();
  }
  return {
    id: b.id || newId(),
    label: typeof b.label === 'string' ? b.label : '',
    workflowType: b.workflowType === 'img2img' ? 'img2img' : 'txt2img',
    checkpoint: b.checkpoint,
    loras: Array.isArray(b.loras) ? b.loras : [],
    promptTemplate,
    params: b.params ?? defaultParams(),
  };
}

/**
 * Reconstruct a GeneratorConfig from a published SHARED record. The structured
 * shape is read from the opaque `data` blob; `title`/`body` supply the display
 * name/description. Returns `null` when `data` isn't a recognised generator
 * payload (defensive — `data` is app-owned but a forged/legacy row is possible).
 */
export function parsePublishedGenerator(value: SharedStorageValue): GeneratorConfig | null {
  const data = value.data as GeneratorData | undefined;
  if (!data || data.v !== 1 || !Array.isArray(data.buttons)) return null;
  const buttons = data.buttons
    .map(migrateStoredButton)
    .filter((b): b is GenButton => b !== null);
  if (buttons.length === 0) return null;
  return {
    name: value.title ?? '',
    // Prefer the description embedded in data-free body's first line? Keep the
    // authored description in data-independent form: we stored it in `body`, but
    // the structured source of truth for display is the name/title; description
    // is re-derived from the first body line for a faithful round-trip.
    description: firstParagraph(value.body),
    buttons,
    // BACK-COMPAT: accept the new `headerImageRef` AND the legacy
    // `backgroundImageRef` (rows published before the header-image rename) so an
    // already-published generator never loses its cover image on load.
    headerImageRef: data.headerImageRef ?? data.backgroundImageRef,
    promptPlaceholder: typeof data.promptPlaceholder === 'string' ? data.promptPlaceholder : undefined,
  };
}

function firstParagraph(body: string | undefined): string {
  if (!body) return '';
  const line = body.split('\n')[0] ?? '';
  // The first body line is the description UNLESS the author left it blank, in
  // which case line 0 is a meta line (the prompt hint or the button list).
  if (line === 'Buttons:' || line.startsWith('Prompt hint: ')) return '';
  return line;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Human-readable validation errors that block a save/publish. Empty = valid. */
export function validateGenerator(config: GeneratorConfig): string[] {
  const errs: string[] = [];
  if (!config.name.trim()) errs.push('Give your generator a name.');
  if (config.buttons.length === 0) errs.push('Add at least one button.');
  config.buttons.forEach((b, i) => {
    const n = b.label.trim() || `#${i + 1}`;
    if (!b.label.trim()) errs.push(`Button ${n} needs a label.`);
    if (!b.checkpoint) errs.push(`Button ${n} needs a checkpoint.`);
    if (b.loras.length > MAX_LORAS) errs.push(`Button ${n} has more than ${MAX_LORAS} LoRAs.`);
    // Prompt box is inferred from the `{prompt}` token; a fully-fixed prompt is
    // valid, but an entirely EMPTY template is not (nothing to generate).
    if (!b.promptTemplate.trim()) {
      errs.push(`Button ${n} needs a prompt template (add {prompt} for a runtime prompt box).`);
    }
  });
  return errs;
}

// ---------------------------------------------------------------------------
// Button list helpers (immutable)
// ---------------------------------------------------------------------------

export function moveButton(buttons: GenButton[], from: number, to: number): GenButton[] {
  if (to < 0 || to >= buttons.length || from < 0 || from >= buttons.length) return buttons;
  const next = buttons.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function updateButton(
  buttons: GenButton[],
  id: string,
  patch: Partial<GenButton> | ((b: GenButton) => GenButton),
): GenButton[] {
  return buttons.map((b) =>
    b.id === id ? (typeof patch === 'function' ? patch(b) : { ...b, ...patch }) : b,
  );
}

export const WORKFLOW_TYPES: WorkflowType[] = ['txt2img', 'img2img'];
