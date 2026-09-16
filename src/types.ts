// The app-side "generator" data model.
//
// 🔴 The PLATFORM has no concept of a "generator" — it is entirely app-owned.
// A published generator lives in App Blocks SHARED storage as a
// `{ title, body, data }` record: the moderated user-visible TEXT in
// `title`/`body`, and this structured config in the opaque `data` blob
// (see lib/generator.ts `buildPublishPayload` / `parsePublishedGenerator`).

/** Which image workflow a button runs. img2img is signalled by a source image. */
export type WorkflowType = 'txt2img' | 'img2img';

/** A checkpoint pinned to a button (from useResourcePicker, Checkpoint). */
export interface CheckpointRef {
  versionId: number;
  modelId: number;
  /** Display name — from the picker or rehydrated via useGenerationResources. */
  modelName?: string;
  versionName?: string;
  baseModel?: string;
}

/** One weighted LoRA in a button's stack (from useResourcePicker, LORA). */
export interface LoraRef {
  versionId: number;
  /** Applied weight/strength (clamped to [min,max]). */
  weight: number;
  // Display + clamp metadata seeded from the picker / rehydrate:
  modelName?: string;
  versionName?: string;
  minStrength?: number;
  maxStrength?: number;
  trainedWords?: string[];
}

/** Per-button generation parameters (subset of BlockTextToImageParams). */
export interface GenButtonParams {
  negativePrompt?: string;
  cfgScale?: number;
  steps?: number;
  sampler?: string;
  width?: number;
  height?: number;
  seed?: number | null;
  quantity?: number;
}

/** A named button carrying a full image-generation payload. */
export interface GenButton {
  /** Stable local id (not persisted meaningfully — regenerated on load is fine). */
  id: string;
  label: string;
  workflowType: WorkflowType;
  checkpoint?: CheckpointRef;
  loras: LoraRef[];
  /**
   * Prompt template; a `{prompt}` token is where the runner's input is spliced.
   * The runtime prompt box is INFERRED from this: it shows iff the template
   * contains `{prompt}` (see `exposesPrompt`). The runtime image box is inferred
   * from `workflowType === 'img2img'` (see `exposesImage`). There is no longer a
   * persisted `exposedInputs` flag — it's derived from these two fields.
   */
  promptTemplate: string;
  params: GenButtonParams;
}

/** A cosmetic (never a generation input) moderated header/cover image. */
export interface HeaderImageRef {
  imageId: number;
  url: string;
}

/**
 * The moderation SCAN outcome for a just-uploaded DISPLAY header image,
 * observed AFTER the host upload modal has accepted + auto-closed. Drives the
 * inline scan-status UI on the builder (see `Builder` `BgScanState`) and gates
 * persistence — only a `'scanned'` (clean) image is ever attached as the
 * generator's `headerImageRef` (fail-closed).
 *
 * The SDK/host gap is now CLOSED: `useImageUpload({ asyncScan: true })`
 * early-resolves `open()` with a `BlockPendingImageInfo` (image persisted, scan
 * still in flight) and streams the verdict via `scanStatus(handle)`. The App's
 * `scanBackground` default subscribes to that verdict and maps it onto this
 * result: a host `'scanned'` → `{ status:'scanned' }`, `'blocked'` →
 * `{ status:'blocked', reason }`, and a transient `'error'`/timeout throws → the
 * builder's inline `error` phase + Retry. The seam stays injectable so tests can
 * drive the pending→scanned / pending→blocked / error paths deterministically.
 */
export type BackgroundScanResult =
  | { status: 'scanned' }
  | { status: 'blocked'; reason?: string };

/** The full app-side generator definition (a draft or a published body). */
export interface GeneratorConfig {
  name: string;
  description: string;
  buttons: GenButton[];
  headerImageRef?: HeaderImageRef;
  /**
   * Placeholder text for the Runner's shared prompt box (a gentle nudge to the
   * runner about what to type). Cosmetic + user-authored, so it's moderated
   * alongside the rest of the visible text. Falls back to a sensible default
   * when unset.
   */
  promptPlaceholder?: string;
}

/** The opaque structured payload we stash in shared-storage `data`. */
export interface GeneratorData {
  /** Schema version so a future shape change can migrate old rows. */
  v: 1;
  workflowVersion?: string;
  buttons: GenButton[];
  headerImageRef?: HeaderImageRef;
  /**
   * @deprecated Legacy field — generators published before the "header image"
   * rename stored the cover under `backgroundImageRef`. The READ path
   * (`parsePublishedGenerator`) still accepts it so those rows keep their image;
   * the WRITE path only ever emits `headerImageRef`.
   */
  backgroundImageRef?: HeaderImageRef;
  promptPlaceholder?: string;
}

/** One entry in the runner's output queue. */
export type QueueStatus =
  | 'estimating'
  | 'confirming'
  | 'submitting'
  | 'processing'
  /**
   * The poll window elapsed while the workflow was still generating (slow edit /
   * queued gens). App-internal only (never a host status): the generation is
   * almost certainly still running server-side, so we keep the `workflowId` and
   * offer a "check again" re-poll rather than dropping to a blank/failed state.
   */
  | 'stalled'
  | 'succeeded'
  | 'failed'
  | 'canceled';

/**
 * Where a succeeded run is in the KEEP flow — the app's terminal (see
 * `lib/runs.ts`). Independent of {@link QueueStatus}: a run is `succeeded` the
 * moment its images exist, and only then can it be kept.
 *
 * 🔴 `failed` here covers a DECLINED consent as well as a real error, and that
 * conflation is the platform's, not this app's. The `PUBLISH_GENERATION_OUTPUTS`
 * request is answered by exactly one reply type, `PUBLISH_RESULT`, whose payload
 * is `{ requestId, result?: { imageIds }, error?: string }` — an id list or a
 * free-text string, with no third discriminator (`@civitai/app-sdk@0.35.0`,
 * `dist/blocks/messages.d.ts`). So a viewer who simply dismissed the host's
 * consent confirm is indistinguishable, at this seam, from one who hit a rate
 * limit. That is why the failed-keep copy is neutral and offers a retry rather
 * than announcing an error: telling someone their deliberate "no" was a failure
 * is the one reading that is certainly wrong.
 */
export type KeepStatus = 'idle' | 'keeping' | 'kept' | 'failed';

export interface QueueItem {
  id: string;
  buttonLabel: string;
  status: QueueStatus;
  /** Estimated cost (Buzz) once the estimate lands. */
  estimatedCost?: number;
  workflowId?: string;
  imageUrls?: string[];
  error?: string;
  /** Keep-flow state for a succeeded run. Absent ⇒ never attempted (`idle`). */
  keepStatus?: KeepStatus;
  /** Durable civitai `Image` ids, once kept. */
  keptImageIds?: number[];
  /**
   * Ids a SUCCESSFUL publish returned, held from the moment the bridge resolves —
   * before, and independently of, the app-side record being written.
   *
   * 🔴 THIS FIELD IS AN IDEMPOTENCY KEY, NOT A DUPLICATE OF {@link
   * QueueItem.keptImageIds}. `blocks.publishGenerationOutputs` mints a FRESH
   * `Image` row per selected output on every call (civitai `blocks.router`, the
   * per-output `persistBlockWorkflowOutputImage` loop) — there is no dedupe — so
   * a retry that re-publishes duplicates durable rows and re-spends the
   * image-weighted publish rate budget. Present ⇒ the publish already happened
   * and a retry must only re-attempt the storage write.
   */
  publishedImageIds?: number[];
}
