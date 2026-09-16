// The RUNNER screen: open a generator and run its buttons. Renders the cosmetic
// background, a shared prompt input, an optional img2img source-image picker, an
// "advanced" params reveal, the button row, and a persistent-in-session output
// queue that estimates → confirms → submits → polls each generation.
//
// The estimate/submit/poll callables + source-image upload are injected (the App
// wires them to useBuzzWorkflow / useImageUpload) so this component is
// deterministically testable and never touches the transport directly. The
// img2img source is uploaded via the UNSCANNED `generationSource` purpose, which
// returns the image's REAL intrinsic `{ url, width, height }` (the orchestrator
// scans it at gen time) — distinct from the moderated cosmetic background, which
// the Builder uploads via the DISPLAY purpose.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BlockGatedImage,
  BlockGenerationSourceImageInfo,
  BlockSourceImage,
  BlockWorkflowSnapshot,
  WorkflowBody,
} from '@civitai/app-sdk/blocks';

import { Alert, Badge, Button, Card, Collapse, Group, Loader, Modal, NumberInput, Stack, TextInput } from '@civitai/blocks-react/ui';

import type { GenButton, GeneratorConfig, GenButtonParams, QueueItem, QueueStatus } from '../types.js';
import { DEFAULT_PROMPT_PLACEHOLDER, buildSubmitBody, canRunButton, exposesImage, exposesPrompt, missingRequiredInputs, newId } from '../lib/generator.js';
import { describeButton, missingForButtonMessage, presetNeedsLabel, presetRecipeLabel } from '../lib/preset.js';
import type { KeptImageCell, KeptRun } from '../lib/runs.js';
import { isTerminalSnapshot, mapSnapshotStatus, pollToTerminal, queueStatusLabel } from '../lib/workflow.js';
import { isInsufficientBuzzError } from '../lib/buzz.js';
import { ESTIMATE_NO_COST_MESSAGE, estimateFailureMessage, isPricedSnapshot } from '../lib/estimate.js';
import type { Analytics } from '../lib/analytics.js';
import { ANALYTICS_EVENTS, noopAnalytics } from '../lib/analytics.js';
import { Image } from '@civitai/components-react';

import { CLASS_LIFT, motionClass, useMotion } from '../motion.js';
import { token, radius, elevate, metaText, type Palette } from '../theme.js';
import { EmptyState } from './EmptyState.js';
import { KeptGallery } from './KeptGallery.js';
import { ResultLightbox } from './ResultLightbox.js';
import { SafeImage } from './SafeImage.js';

interface RunnerItem extends QueueItem {
  body: WorkflowBody;
  /** How many images this gen requested (for partial-failure "N of M" messaging). */
  requested: number;
  /** Set when a terminal failure is classified as insufficient Buzz (top-up path). */
  insufficientBuzz?: boolean;
  /** The prompt the viewer typed for this run — carried onto the kept record. */
  promptUsed?: string;
  /** Compact recipe line for this run's button (shown in the payoff view). */
  recipe?: string | null;
}

/** Which image the lightbox is showing, and where it came from. */
type LightboxTarget =
  | { kind: 'queue'; itemId: string; index: number }
  | { kind: 'kept'; cell: KeptImageCell; url: string | null };

/** Suggested top-up amount (Buzz) when a gen can't be afforded — covers the gap + headroom. */
function topUpSuggestion(cost: number | undefined, balance: number | null | undefined): number {
  const gap = Math.max(0, (cost ?? 0) - (balance ?? 0));
  // Round the shortfall up to a friendly increment so the modal opens with a
  // sensible default the user can adjust.
  return Math.max(100, Math.ceil(gap / 100) * 100);
}

/**
 * Queue statuses that mean paid/in-flight work would be lost on leave — drives
 * both the Back/leave confirm dialog and the `beforeunload` guard. (Terminal:
 * `succeeded|failed|canceled`; `stalled` keeps its `workflowId` and is
 * re-pollable, so it is NOT treated as unsaved in-flight work here.)
 */
const IN_FLIGHT_STATUSES: ReadonlySet<QueueStatus> = new Set<QueueStatus>([
  'estimating',
  'confirming',
  'submitting',
  'processing',
]);

export interface RunnerProps {
  config: GeneratorConfig;
  /** shared_kv key of the published generator (creator attribution G5); omit for own draft. */
  sharedContentKey?: string;
  /**
   * The per-viewer MODERATED cover url, resolved by the host from
   * `config.headerImageRef.imageId` (via `useGatedImages`). 🔴 The banner renders
   * from THIS only — never from the unmoderated stored `headerImageRef.url`.
   * `null`/omitted (hidden / above the viewer's ceiling / unresolved) ⇒ no banner.
   */
  headerUrl?: string | null;
  c: Palette;
  canGenerate: boolean;
  buzzBalance?: number | null;
  onRequestConsent: () => void;
  /** UNSCANNED img2img source upload (generationSource purpose) → real `{ url, width, height }`. */
  uploadSourceImage: () => Promise<BlockGenerationSourceImageInfo | null>;
  estimate: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  submit: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  poll: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
  onBack: () => void;
  /**
   * Open the host Buzz-purchase modal (insufficient-Buzz recovery). Resolves
   * with `{ purchased, newBalance? }`. Omitted → the top-up affordance hides.
   */
  onTopUp?: (suggestedAmount?: number) => Promise<{ purchased: boolean; newBalance?: number }>;
  /** Re-request the viewer's Buzz balance (called after a spend / top-up). */
  onBalanceRefresh?: () => void;
  /** Open the on-site Civitai generator (a result action). */
  onOpenInGenerator?: () => void;
  /** Funnel analytics sink (defaults to a no-op). */
  analytics?: Analytics;
  /** Non-blocking notice (e.g. resource rehydration failed) shown above the form. */
  rehydrateNotice?: string | null;
  /**
   * Live-preview mode for the Builder: renders the exact runtime layout but is
   * NON-runnable — pressing a button shows a note instead of estimating/spending.
   */
  preview?: boolean;
  /**
   * Copy a result image's url to the clipboard (host-clipboard write, the same
   * proven path as Share). This is the sandbox-legal alternative to a file
   * download: an unverified block's iframe is `allow-scripts allow-forms` only —
   * NO `allow-downloads` (a blob/`<a download>` save is blocked) and NO
   * `allow-popups`/`allow-popups-to-escape-sandbox` (so `window.open` /
   * `target="_blank"` / host `navigate(_, 'new_tab')` all silently fail). Copying
   * the url lets the viewer paste it into a top-level tab to open/save the image.
   * Resolves `true` on success. Omitted ⇒ the copy affordance is hidden (never a
   * button that silently does nothing).
   */
  onCopyImageLink?: (url: string) => Promise<boolean>;
  /**
   * KEEP a succeeded run's outputs — the app's terminal. Asks the host to turn
   * the workflow's outputs into durable, server-scanned civitai `Image` rows and
   * resolves with their ids (`usePublishGenerationOutputs().publish`).
   *
   * 🔴 Host-chrome shows its OWN consent confirm and this call waits on a human
   * (a 10-minute ceiling, not the ~30s protocol default), so the UI must show a
   * real pending state and must not block the rest of the queue while it runs.
   *
   * Omitted ⇒ the Keep affordance hides entirely. Never a button that cannot work.
   */
  keepOutputs?: (args: { workflowId: string; imageIndexes?: number[]; title?: string }) => Promise<number[]>;
  /** Persist a kept run to the viewer's own storage (the App owns the store). */
  onKeepRun?: (run: KeptRun) => Promise<void>;
  /**
   * Kept runs already recorded FOR THIS GENERATOR, newest-kept first.
   *
   * 🔴 A FILTERED SUBSET, WHICH IS WHY THERE IS NO `keptTruncated` HERE. This
   * component used to take the App's global truncation flag and hand it to
   * `KeptGallery`, which rendered *"Showing 200 kept runs"* over a grid holding
   * one or two — a global fact presented as a statement about the images beneath
   * it. The flag describes the viewer's whole store and nothing this grid shows,
   * so it is not threaded through.
   *
   * The residual gap, named rather than implied: a viewer holding more than
   * `KEPT_LIST_LIMIT` kept runs may have runs of THIS generator outside the
   * loaded set, and this section does not say so. It closes when the Runner can
   * count this generator's runs independently of the loaded page — either a
   * per-generator key prefix or a store-side count — and the check is mechanical:
   * `runner-kept-count` is derived from something other than `keptRuns.length`,
   * or it is not.
   */
  keptRuns?: KeptRun[];
  /**
   * Per-viewer gated image read, for rendering the kept gallery. Required
   * alongside `keptRuns` — ids without a resolver render nothing.
   */
  getImages?: (imageIds: number[]) => Promise<BlockGatedImage[]>;
  /** Test seams. */
  pollIntervalMs?: number;
  /** Total poll-window before a still-processing gen is marked `stalled` (ms). */
  pollMaxDurationMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function Runner(props: RunnerProps) {
  const { config, sharedContentKey, headerUrl, c, canGenerate, buzzBalance, onRequestConsent, uploadSourceImage, estimate, submit, poll, onBack, onTopUp, onBalanceRefresh, onOpenInGenerator, onCopyImageLink, keepOutputs, onKeepRun, keptRuns, getImages, rehydrateNotice, preview = false } = props;
  const analytics = props.analytics ?? noopAnalytics;
  const motion = useMotion();

  const [promptInput, setPromptInput] = useState('');
  const [sourceImage, setSourceImage] = useState<BlockSourceImage | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [overrides, setOverrides] = useState<Partial<GenButtonParams>>({});
  const [items, setItems] = useState<RunnerItem[]>([]);
  const [runnerError, setRunnerError] = useState<string | null>(null);
  // Live balance: seeded from the prop, but updated locally after a top-up so
  // the insufficient-funds guard reflects the just-purchased Buzz immediately.
  const [localBalance, setLocalBalance] = useState<number | null | undefined>(buzzBalance);
  const [toppingUp, setToppingUp] = useState(false);
  const effectiveBalance = localBalance ?? buzzBalance;
  // Leave-guard: when set, a "you have generations in progress" confirm gates
  // the Back navigation (see IN_FLIGHT_STATUSES).
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Transient "link copied" confirmation, keyed by the copied image url.
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  // The payoff view. `null` ⇒ closed.
  const [lightbox, setLightbox] = useState<LightboxTarget | null>(null);
  // Per-item keep failure copy — app-owned text only. 🔴 The host's free-text
  // reason is server-authored and UNSANITISED (the same rule `lib/estimate.ts`
  // already applies to `.snapshot.error`), so it is logged and never rendered.
  const [keepErrors, setKeepErrors] = useState<Record<string, string>>({});

  // Keep the local balance in sync when the parent pushes a fresh value.
  useEffect(() => {
    setLocalBalance(buzzBalance);
  }, [buzzBalance]);

  // Runtime inputs are INFERRED: the prompt box shows iff some button's template
  // carries a `{prompt}` token; the img2img source box shows iff some button is
  // img2img.
  //
  // 🔴 THE UNION IS CORRECT *HERE* AND ONLY HERE. Whether to RENDER a shared
  // input field is genuinely a question about the whole generator — the prompt
  // box is one box serving every button that wants one. Whether an input is
  // REQUIRED is a question about one button, and conflating the two is the bug
  // fixed below.
  const showPromptInput = useMemo(() => config.buttons.some(exposesPrompt), [config.buttons]);
  const showImageInput = useMemo(() => config.buttons.some(exposesImage), [config.buttons]);
  const promptPlaceholder = config.promptPlaceholder?.trim() || DEFAULT_PROMPT_PLACEHOLDER;

  // 🔴 WAS: a UNION of the unmet inputs across EVERY button, rendered as one
  // instruction under the row. On a generator carrying a txt2img button and an
  // img2img button, a viewer who only wanted the txt2img one was told to "Enter a
  // prompt and add a source image to run" — an upload that button never uses and
  // that would not have unblocked it. The hint demanded strictly more than any
  // single button needed, which on the app's own demo generator is the default
  // case, not an edge one.
  //
  // NOW: each preset states its own requirement on its own card, and the imperative
  // form is reserved for the one button the viewer actually pressed and could not
  // run (see `pressButton`). There is no generator-wide instruction, because there
  // is no generator-wide requirement.
  const presets = useMemo(
    () => config.buttons.map((b) => ({ button: b, preset: describeButton(b) })),
    [config.buttons],
  );

  const patchItem = (id: string, patch: Partial<RunnerItem>) =>
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  async function pickSourceImage() {
    setUploading(true);
    setRunnerError(null);
    try {
      // generationSource upload returns the image's REAL intrinsic dims — use
      // them directly (the graph derives denoise/aspect from width/height).
      const img = await uploadSourceImage();
      if (img) setSourceImage({ url: img.url, width: img.width, height: img.height });
    } catch (e) {
      setRunnerError(errMsg(e));
    } finally {
      setUploading(false);
    }
  }

  async function pressButton(button: GenButton) {
    setRunnerError(null);
    if (preview) {
      // Non-runnable preview — surface a note instead of estimating/spending.
      setRunnerError('Preview only — buttons don’t generate here.');
      return;
    }
    if (!canGenerate) {
      onRequestConsent();
      return;
    }
    if (!button.checkpoint) {
      setRunnerError('This button has no checkpoint configured.');
      return;
    }
    // Required exposed inputs must be satisfied. The gen button is disabled when
    // they aren't (so this is normally unreachable via the UI), but keep it as a
    // guard for any non-UI press path.
    const missing = missingRequiredInputs(button, { promptInput, sourceImage });
    if (missing.length > 0) {
      // Per-button and NAMED — the old message was a union across every button and
      // did not say which press it was answering.
      setRunnerError(missingForButtonMessage(button.label?.trim() || 'This button', missing));
      return;
    }

    let body: WorkflowBody;
    try {
      body = buildSubmitBody(button, {
        promptInput,
        sourceImage: exposesImage(button) ? sourceImage ?? undefined : undefined,
        sharedContentKey,
        paramOverrides: overrides,
      });
    } catch (e) {
      setRunnerError(errMsg(e));
      return;
    }

    const requested = requestedQuantity(body);
    const id = `q_${Date.now().toString(36)}_${items.length}`;
    const item: RunnerItem = {
      id,
      buttonLabel: button.label,
      status: 'estimating',
      body,
      requested,
      // Captured AT PRESS TIME, not read back later: the shared prompt box is
      // live, so a viewer who edits it while a run is in flight would otherwise
      // have the wrong text attributed to an image they already paid for.
      promptUsed: exposesPrompt(button) ? promptInput.trim() || undefined : undefined,
      recipe: presetRecipeLabel(describeButton(button)),
    };
    setItems((list) => [item, ...list]);

    try {
      const snap = await estimate(body);
      // Only a PRICED snapshot may reach Confirm — see `isPricedSnapshot`.
      if (!isPricedSnapshot(snap)) {
        patchItem(id, { status: 'failed', error: ESTIMATE_NO_COST_MESSAGE });
        return;
      }
      patchItem(id, { status: 'confirming', estimatedCost: snap.cost?.total });
    } catch (e) {
      // blocks-react >= 0.43 REJECTS an unusable estimate (civitai/civitai#4159).
      // `estimateFailureMessage` maps it to viewer-safe copy and routes the
      // server's unsanitised reason to the console instead of the screen.
      patchItem(id, { status: 'failed', error: estimateFailureMessage(e) });
    }
  }

  /**
   * Apply a poll result to a queue item. If the poll window tripped while the
   * workflow was still pending/processing (a NON-terminal snapshot), don't drop
   * to a blank/failed card — mark it `stalled` and KEEP the `workflowId` so the
   * user can "check again". A terminal snapshot maps through as usual.
   */
  function applyPollResult(id: string, snap: BlockWorkflowSnapshot) {
    if (isTerminalSnapshot(snap.status)) {
      const status = mapSnapshotStatus(snap.status);
      patchItem(id, {
        status,
        imageUrls: snap.imageUrls,
        error: snap.error,
        insufficientBuzz: status === 'failed' && isInsufficientBuzzError(snap.error),
      });
      // A terminal result (success or spend-failure) may have moved the balance.
      if (status === 'succeeded' || status === 'failed') onBalanceRefresh?.();
    } else {
      patchItem(id, { status: 'stalled', workflowId: snap.workflowId, error: undefined });
    }
  }

  function pollOpts(id: string) {
    return {
      delayMs: props.pollIntervalMs,
      maxDurationMs: props.pollMaxDurationMs,
      sleep: props.sleep,
      onUpdate: (s: BlockWorkflowSnapshot) =>
        patchItem(id, { status: mapSnapshotStatus(s.status), imageUrls: s.imageUrls, error: s.error }),
    };
  }

  async function confirmItem(item: RunnerItem) {
    // Double-charge guard: only a still-`confirming` item may be submitted. A
    // second click (or a click on an item already moved to submitting/processing/
    // succeeded by a prior confirm) is a no-op — never a second paid submit.
    if (item.status !== 'confirming') return;
    patchItem(item.id, { status: 'submitting', error: undefined, insufficientBuzz: undefined });
    analytics.track(ANALYTICS_EVENTS.GENERATION_SUBMITTED, {
      buttonLabel: item.buttonLabel,
      quantity: item.requested,
      estimatedCost: item.estimatedCost,
      sharedContentKey,
    });
    try {
      const snap = await submit(item.body);
      // A submit that comes straight back failed (e.g. insufficient Buzz) never
      // reaches the poll loop — classify + surface it here.
      if (snap.status === 'failed') {
        patchItem(item.id, {
          status: 'failed',
          error: snap.error,
          insufficientBuzz: isInsufficientBuzzError(snap.error),
        });
        onBalanceRefresh?.();
        return;
      }
      patchItem(item.id, {
        workflowId: snap.workflowId,
        status: mapSnapshotStatus(snap.status),
        imageUrls: snap.imageUrls,
        error: snap.error,
      });
      const terminal = await pollToTerminal(poll, snap, pollOpts(item.id));
      applyPollResult(item.id, terminal);
    } catch (e) {
      const msg = errMsg(e);
      patchItem(item.id, { status: 'failed', error: msg, insufficientBuzz: isInsufficientBuzzError(msg) });
    }
  }

  /** Open the host purchase modal to cover a shortfall, then reflect the new balance. */
  async function topUp(cost: number | undefined) {
    if (!onTopUp) return;
    setToppingUp(true);
    try {
      const res = await onTopUp(topUpSuggestion(cost, effectiveBalance));
      if (res.purchased) {
        if (typeof res.newBalance === 'number') setLocalBalance(res.newBalance);
        onBalanceRefresh?.();
      }
    } catch (e) {
      setRunnerError(errMsg(e));
    } finally {
      setToppingUp(false);
    }
  }

  /** Re-run a completed/failed gen with the exact same inputs (a fresh queue item). */
  function rerun(item: RunnerItem) {
    const id = `q_${Date.now().toString(36)}_${items.length}`;
    // A re-run repeats the ORIGINAL inputs, so it inherits the original run's
    // prompt + recipe — never the live prompt box, which may have moved on.
    // Keep state is deliberately NOT inherited: this is a new generation and
    // nothing about it has been kept yet.
    const clone: RunnerItem = {
      id,
      buttonLabel: item.buttonLabel,
      status: 'estimating',
      body: item.body,
      requested: item.requested,
      promptUsed: item.promptUsed,
      recipe: item.recipe,
    };
    setItems((list) => [clone, ...list]);
    void (async () => {
      try {
        const snap = await estimate(item.body);
        if (!isPricedSnapshot(snap)) {
          patchItem(id, { status: 'failed', error: ESTIMATE_NO_COST_MESSAGE });
          return;
        }
        patchItem(id, { status: 'confirming', estimatedCost: snap.cost?.total });
      } catch (e) {
        patchItem(id, { status: 'failed', error: estimateFailureMessage(e) });
      }
    })();
  }

  /** Re-poll a stalled item (its gen is still running server-side). */
  async function checkAgain(item: RunnerItem) {
    if (!item.workflowId) return;
    patchItem(item.id, { status: 'processing', error: undefined });
    try {
      const seed: BlockWorkflowSnapshot = { workflowId: item.workflowId, status: 'processing' };
      const terminal = await pollToTerminal(poll, seed, pollOpts(item.id));
      applyPollResult(item.id, terminal);
    } catch (e) {
      patchItem(item.id, { status: 'failed', error: errMsg(e) });
    }
  }

  const dismissItem = (id: string) => setItems((list) => list.filter((it) => it.id !== id));

  /**
   * KEEP a succeeded run — the app's terminal.
   *
   * Asks the host to turn this run's outputs into durable, server-scanned civitai
   * `Image` rows, then records the returned IDS (never urls — see `lib/runs.ts`)
   * in the viewer's own storage so the images survive the tab.
   *
   * 🔴 THE RUN IS NEVER LOST TO A FAILED KEEP. On any rejection the card returns
   * to an offerable state with a neutral message and a retry; the images are
   * still in the queue and still in the viewer's Civitai feed. Losing the whole
   * result to a failed optional extra is the failure mode that teaches people not
   * to press the button.
   *
   * 🔴 The host's rejection text is server-authored and unsanitised, so it is
   * logged and never rendered — and it cannot distinguish a declined consent from
   * a real error anyway (see `KeepStatus`), which is the second reason the copy
   * stays neutral.
   *
   * 🔴 TWO STEPS, TWO OUTCOMES, AND THE RETRY MUST NOT REPEAT THE FIRST ONE.
   * `keepOutputs` is a real publish — a server-side fetch, an S3 re-upload and a
   * durable `Image` row per output — while `onKeepRun` is a KV write, and
   * `publishGenerationOutputs` has no idempotency: every call mints fresh rows
   * (see `QueueItem.publishedImageIds`). Running both under one `try` meant a
   * failed KV write showed *"These images weren't kept"* over rows that plainly
   * existed, and "Try keeping again" re-published them. It is not a rare arm: the
   * viewer's KV is capped (`USER_QUOTA_BYTES` 2 MiB / `USER_ROW_LIMIT` 1,000,
   * shared with this app's drafts) and the gallery is add-only, so a viewer at
   * the ceiling fails the write EVERY time — an unbounded duplicate-publish loop
   * driven by a button that says the opposite of what happened.
   */
  async function keepItem(item: RunnerItem) {
    if (!keepOutputs || !item.workflowId) return;
    // Only a succeeded, not-already-kept, not-in-flight run may be kept. Guards
    // the non-UI press path and makes a double click a no-op rather than a second
    // consent dialog over the same images.
    if (item.status !== 'succeeded') return;
    if (item.keepStatus === 'keeping' || item.keepStatus === 'kept') return;

    patchItem(item.id, { keepStatus: 'keeping' });
    setKeepErrors((e) => {
      const { [item.id]: _drop, ...rest } = e;
      return rest;
    });

    // ── Step 1: PUBLISH, unless a previous attempt already did. ──────────────
    let imageIds = item.publishedImageIds;
    if (!imageIds) {
      try {
        const published = await keepOutputs({
          workflowId: item.workflowId,
          title: config.name || undefined,
        });
        // A host that consents but resolves nothing is not a success. Treat an
        // empty id list as a failure rather than writing a kept run with no
        // images (which `isKeptRun` would reject on read anyway, silently
        // emptying the gallery the viewer was just told they had added to).
        if (!Array.isArray(published) || published.length === 0) {
          throw new Error('publish resolved no image ids');
        }
        imageIds = published;
        // Recorded BEFORE the write is attempted: from here on the rows exist,
        // and that fact must outlive whatever happens next.
        patchItem(item.id, { publishedImageIds: imageIds });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[custom-generators] keep failed (publish)', e);
        patchItem(item.id, { keepStatus: 'failed' });
        setKeepErrors((prev) => ({
          ...prev,
          [item.id]: 'These images weren’t kept. Nothing was charged — you can try again.',
        }));
        return;
      }
    }

    // ── Step 2: RECORD it app-side. A failure here loses no images. ──────────
    const run: KeptRun = {
      id: newId('kept'),
      keptAt: Date.now(),
      imageIds,
      generatorName: config.name || 'Untitled generator',
      generatorKey: sharedContentKey,
      buttonLabel: item.buttonLabel,
      prompt: item.promptUsed,
    };
    try {
      await onKeepRun?.(run);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[custom-generators] keep failed (record)', e);
      patchItem(item.id, { keepStatus: 'failed' });
      setKeepErrors((prev) => ({
        ...prev,
        // 🔴 A DIFFERENT SENTENCE, BECAUSE A DIFFERENT THING HAPPENED. The images
        // were published and are the viewer's; only this app's gallery entry is
        // missing. Saying "these images weren't kept" here was false, and it sent
        // people back through a publish they had already paid for.
        [item.id]:
          'Civitai saved these images, but this app couldn’t add them to your gallery. Trying again won’t create duplicates.',
      }));
      return;
    }

    patchItem(item.id, { keepStatus: 'kept', keptImageIds: imageIds });
    analytics.track(ANALYTICS_EVENTS.GENERATION_KEPT, {
      images: imageIds.length,
      buttonLabel: item.buttonLabel,
      sharedContentKey,
    });
  }

  /** Open the payoff view on one of a queue item's result images. */
  const openQueueLightbox = useCallback((itemId: string, index: number) => {
    setLightbox({ kind: 'queue', itemId, index });
  }, []);

  const openKeptLightbox = useCallback((cell: KeptImageCell, url: string | null) => {
    if (!url) return; // an unresolvable cell has nothing to enlarge
    setLightbox({ kind: 'kept', cell, url });
  }, []);

  // Any paid/in-flight generation that would be lost on a Back/reload. Drives the
  // leave-guard confirm + the native beforeunload prompt.
  const hasInFlight = useMemo(() => items.some((it) => IN_FLIGHT_STATUSES.has(it.status)), [items]);

  // Native tab-close / reload guard while work is in flight. (In the block's
  // sandboxed iframe the host frame may not surface this prompt; it's a
  // best-effort belt on top of the in-app Back confirm, and harmless if ignored.)
  useEffect(() => {
    if (preview || !hasInFlight) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [preview, hasInFlight]);

  // Back navigation: confirm first if any generation is still in flight, so a
  // just-paid gen can't be dropped by an accidental Back.
  function handleBack() {
    if (hasInFlight) {
      setConfirmLeave(true);
      return;
    }
    onBack();
  }

  // Copy a result image's url to the clipboard (sandbox-legal alternative to a
  // file download — see onCopyImageLink). Shows an inline "copied" confirmation;
  // a failure is non-fatal (the gen is already saved to the viewer's feed).
  async function copyImageLink(url: string) {
    if (!onCopyImageLink) return;
    setRunnerError(null);
    try {
      const ok = await onCopyImageLink(url);
      if (ok) {
        setCopiedUrl(url);
      } else {
        setRunnerError("Couldn't copy the image link here — you can still open this image from your Civitai feed.");
      }
    } catch {
      setRunnerError("Couldn't copy the image link here — you can still open this image from your Civitai feed.");
    }
  }

  /**
   * Resolve the open lightbox target into everything the payoff view renders.
   *
   * 🔴 DERIVED, NEVER SNAPSHOTTED INTO STATE. The target holds an item id and an
   * index, not a copy of the item — so a run that is kept while its image is open
   * flips the view's "Kept" badge, and a card dismissed underneath the modal
   * resolves to `null` and closes it instead of stranding a view over an item
   * that no longer exists.
   */
  const lightboxView = useMemo(() => {
    if (!lightbox) return null;
    if (lightbox.kind === 'queue') {
      const item = items.find((i) => i.id === lightbox.itemId);
      const urls = item?.imageUrls ?? [];
      if (!item || urls.length === 0) return null;
      const idx = Math.min(Math.max(lightbox.index, 0), urls.length - 1);
      return {
        src: urls[idx] as string | null,
        buttonLabel: item.buttonLabel,
        recipe: item.recipe ?? null,
        prompt: item.promptUsed,
        index: idx + 1,
        total: urls.length,
        kept: item.keepStatus === 'kept',
        onPrev:
          idx > 0 ? () => setLightbox({ kind: 'queue', itemId: item.id, index: idx - 1 }) : undefined,
        onNext:
          idx < urls.length - 1
            ? () => setLightbox({ kind: 'queue', itemId: item.id, index: idx + 1 })
            : undefined,
      };
    }
    const { cell, url } = lightbox;
    const pos = cell.run.imageIds.indexOf(cell.imageId);
    return {
      src: url,
      buttonLabel: cell.run.buttonLabel,
      // A kept run stores ids + attribution, not the button's param block, so the
      // recipe line is genuinely unknown here. Omitted rather than reconstructed
      // from the generator's CURRENT buttons — which may have been edited since,
      // and would then describe this image with settings that never made it.
      recipe: null,
      prompt: cell.run.prompt,
      index: pos >= 0 ? pos + 1 : 1,
      total: cell.run.imageIds.length,
      kept: true,
      onPrev: undefined,
      onNext: undefined,
    };
  }, [lightbox, items]);

  return (
    <div data-testid="runner">
      <Stack gap={16}>
        <Group justify="space-between">
          {preview ? (
            <Badge data-testid="runner-preview-badge" color="info">
              Preview
            </Badge>
          ) : (
            <Button variant="subtle" size="sm" data-testid="runner-back" onClick={handleBack}>
              ← Back
            </Button>
          )}
          {effectiveBalance != null && (
            <Badge variant="light" data-testid="runner-balance">
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>⚡ {effectiveBalance.toLocaleString()}</span>
            </Badge>
          )}
        </Group>

        {rehydrateNotice && (
          <Alert color="info" data-testid="runner-rehydrate-notice">
            {rehydrateNotice}
          </Alert>
        )}

        {/* cosmetic header/cover banner — a full-width ~16:9 image at the TOP of
            the generator, above the prompt/buttons/generate content (not a
            backdrop behind them). Decorative, so empty alt.
            🔴 Rendered from the host-resolved MODERATED `headerUrl` (from the
            image's `imageId`), NEVER the unmoderated stored `headerImageRef.url`. */}
        {headerUrl && (
          <SafeImage
            data-testid="runner-header-banner"
            src={headerUrl}
            alt=""
            style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 12, border: `1px solid ${c.border}`, display: 'block' }}
          />
        )}

        <div>
          <h2 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.01em', lineHeight: 1.2 }} data-testid="runner-title">
            {config.name || 'Untitled generator'}
          </h2>
          {config.description && <p style={{ ...metaText, margin: '5px 0 0', fontSize: 13 }}>{config.description}</p>}
        </div>

        {!preview && !canGenerate && (
          <Alert color="info" data-testid="consent-needed">
            This app needs your permission to spend Buzz on generations.{' '}
            <Button size="sm" variant="light" data-testid="grant-consent" onClick={onRequestConsent}>
              Enable generation
            </Button>
          </Alert>
        )}

        {runnerError && (
          <Alert color="warning" data-testid="runner-error" withCloseButton onClose={() => setRunnerError(null)}>
            {runnerError}
          </Alert>
        )}

        {/* the generator form: prompt + optional source + buttons + advanced */}
        <Card withBorder padding="md" data-testid="runner-form">
          <Stack gap={14}>
            {showPromptInput && (
              <TextInput
                label="Prompt"
                required
                placeholder={promptPlaceholder}
                value={promptInput}
                data-testid="runner-prompt"
                onChange={(e) => setPromptInput(e.currentTarget.value)}
              />
            )}

            {showImageInput && (
              <Stack gap={6}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  Source image (img2img) <span style={{ color: token.error }} aria-hidden>*</span>
                </div>
                {sourceImage ? (
                  <Group gap={10} align="flex-start">
                    <img
                      data-testid="source-thumb"
                      src={sourceImage.url}
                      alt="Source image preview"
                      style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: `1px solid ${c.border}` }}
                    />
                    <Group gap={6}>
                      <Button variant="light" size="sm" data-testid="replace-source" loading={uploading} onClick={pickSourceImage}>
                        Replace
                      </Button>
                      <Button variant="subtle" size="sm" color="error" data-testid="remove-source" onClick={() => setSourceImage(null)}>
                        Remove
                      </Button>
                    </Group>
                  </Group>
                ) : (
                  <Group justify="space-between">
                    <span style={{ color: c.muted, fontSize: 13 }} data-testid="source-image-state">
                      No image selected
                    </span>
                    <Button variant="light" size="sm" data-testid="upload-source" loading={uploading} onClick={pickSourceImage}>
                      Upload
                    </Button>
                  </Group>
                )}
              </Stack>
            )}

            {/* 🔴 A BUTTON IS A PRESET — SHOW IT. These were bare labelled pills
                ("Cyberpunk", "Remix a photo"), so a runner about to spend real
                Buzz on a stranger's button could not tell what it would make,
                roughly what it would cost, or what it wanted from them. Each card
                now carries the button's own recipe, its own approximate price and
                its OWN requirement — the last of which replaces the generator-wide
                union hint that used to demand a source image for txt2img buttons
                (see `lib/preset.ts`).

                Still disabled until every runtime input THIS button exposes is
                satisfied, exactly as before (`canRunButton`). Preview is
                non-runnable so it isn't input-gated: pressing surfaces a note. */}
            <div
              data-testid="runner-presets"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', gap: 10 }}
            >
              {presets.map(({ button: b, preset }) => {
                const runnable = preview || canRunButton(b, { promptInput, sourceImage });
                const needs = presetNeedsLabel(preset.needs);
                const recipe = presetRecipeLabel(preset);
                return (
                  <button
                    key={b.id}
                    type="button"
                    data-testid="gen-button"
                    data-button-id={b.id}
                    // The gate itself, exposed for assertion. Pins the run
                    // condition directly rather than via a piece of hint copy —
                    // which is what the old tests had to do, and why a reworded
                    // hint could have quietly broken them.
                    data-runnable={runnable ? 'true' : 'false'}
                    disabled={!runnable}
                    onClick={() => pressButton(b)}
                    className={motionClass(motion, runnable ? CLASS_LIFT : undefined)}
                    style={{
                      all: 'unset',
                      boxSizing: 'border-box',
                      display: 'block',
                      cursor: runnable ? 'pointer' : 'not-allowed',
                      opacity: runnable ? 1 : 0.55,
                      padding: '10px 12px',
                      borderRadius: radius.md,
                      border: `1px solid ${runnable ? token.primary : c.border}`,
                      background: runnable ? token.primaryLight : elevate(2),
                    }}
                  >
                    <Stack gap={4}>
                      <span style={{ fontWeight: 600, fontSize: 14 }} data-testid="preset-label">
                        {preset.label}
                      </span>
                      {recipe && (
                        <span style={metaText} data-testid="preset-recipe">
                          {recipe}
                        </span>
                      )}
                      <Group gap={8} align="center">
                        <span
                          style={{ ...metaText, fontVariantNumeric: 'tabular-nums' }}
                          data-testid="preset-cost"
                        >
                          ≈ {preset.approxCostBuzz} ⚡
                        </span>
                        {needs && (
                          // The button's OWN requirement, as a statement about it
                          // — never an instruction the whole screen appears to be
                          // making.
                          <span style={metaText} data-testid="preset-needs">
                            · {needs}
                          </span>
                        )}
                      </Group>
                    </Stack>
                  </button>
                );
              })}
            </div>

            {/* advanced reveal */}
            <Collapse
              open={showAdvanced}
              onOpenChange={setShowAdvanced}
              title={showAdvanced ? 'Hide advanced' : 'Advanced'}
              data-testid="runner-advanced-collapse"
            >
              <div data-testid="runner-advanced" style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(2,minmax(0,1fr))', marginTop: 8 }}>
                <OverrideNumber label="Quantity" testid="ov-quantity" value={overrides.quantity} onChange={(n) => setOverrides((o) => ({ ...o, quantity: n }))} />
                <OverrideNumber label="Steps" testid="ov-steps" value={overrides.steps} onChange={(n) => setOverrides((o) => ({ ...o, steps: n }))} />
                <OverrideNumber label="CFG" testid="ov-cfg" value={overrides.cfgScale} onChange={(n) => setOverrides((o) => ({ ...o, cfgScale: n }))} />
                <OverrideNumber label="Seed" testid="ov-seed" value={overrides.seed ?? undefined} onChange={(n) => setOverrides((o) => ({ ...o, seed: n ?? null }))} />
              </div>
            </Collapse>
          </Stack>
        </Card>

        {/* output queue */}
        <Stack gap={10} data-testid="output-queue">
          {/* Persistent reassurance: the queue is in-session (a Back/reload clears
              these cards), but every finished generation is also saved to the
              viewer's Civitai feed — so a cleared card never means lost work. */}
          {!preview && (
            <span data-testid="runner-feed-note" style={{ fontSize: 12, color: c.muted }}>
              Generations are saved to your Civitai feed. Keep the ones you like and they’ll be
              waiting here too.
            </span>
          )}
          {items.length === 0 && (
            <EmptyState
              data-testid="queue-empty"
              title="No generations yet"
              body="Pick a preset above. Each one shows what it makes, roughly what it costs, and what it needs from you."
            />
          )}
          {items.map((it) => (
            <Card key={it.id} withBorder padding="md" data-testid="queue-item" data-status={it.status}>
              <Stack gap={8}>
                <Group justify="space-between">
                  <strong style={{ fontSize: 14 }}>{it.buttonLabel}</strong>
                  <Badge data-testid="queue-status" color={statusColor(it.status)}>
                    {queueStatusLabel(it.status)}
                  </Badge>
                </Group>

                {(it.status === 'estimating' || it.status === 'submitting' || it.status === 'processing') && (
                  <Group gap={8}>
                    <Loader size="sm" />
                    <span style={{ fontSize: 13, color: c.muted }}>
                      {it.status === 'estimating' ? 'Estimating cost…' : it.status === 'submitting' ? 'Submitting…' : 'Generating…'}
                    </span>
                  </Group>
                )}

                {it.status === 'confirming' && (() => {
                  // DETERMINISTIC balance guard: block Confirm when the estimate
                  // exceeds the viewer's AVAILABLE balance, and offer a top-up
                  // instead of letting the server reject the submit generically.
                  // Available = balance minus Buzz already committed by OTHER
                  // in-flight gens (submitting/processing) whose debit hasn't been
                  // reflected in the balance yet — so two individually-affordable
                  // gens can't be double-confirmed past the wallet.
                  const reservedByInFlight = items
                    .filter((o) => o.id !== it.id && (o.status === 'submitting' || o.status === 'processing'))
                    .reduce((sum, o) => sum + (o.estimatedCost ?? 0), 0);
                  const available = effectiveBalance != null ? effectiveBalance - reservedByInFlight : null;
                  const cannotAfford =
                    it.estimatedCost != null && available != null && it.estimatedCost > available;
                  return (
                    <Stack gap={8}>
                      <Group justify="space-between">
                        <span style={{ fontSize: 14, fontVariantNumeric: 'tabular-nums' }} data-testid="queue-cost">
                          ≈ {it.estimatedCost ?? '—'} ⚡
                        </span>
                        <Group gap={6}>
                          <Button size="sm" variant="subtle" data-testid="queue-dismiss" onClick={() => dismissItem(it.id)}>
                            Cancel
                          </Button>
                          {cannotAfford && onTopUp ? (
                            <Button size="sm" data-testid="queue-topup" loading={toppingUp} onClick={() => topUp(it.estimatedCost)}>
                              Add Buzz
                            </Button>
                          ) : (
                            <Button size="sm" data-testid="queue-confirm" disabled={cannotAfford} onClick={() => confirmItem(it)}>
                              Confirm &amp; generate
                            </Button>
                          )}
                        </Group>
                      </Group>
                      {cannotAfford && (
                        <Alert color="warning" data-testid="queue-insufficient">
                          This generation costs {it.estimatedCost} ⚡ but you have{' '}
                          {(available ?? 0).toLocaleString()} ⚡ available
                          {reservedByInFlight > 0 ? ' (other generations are still running)' : ''}. Add Buzz to
                          continue.
                        </Alert>
                      )}
                    </Stack>
                  );
                })()}

                {it.status === 'succeeded' && it.imageUrls && it.imageUrls.length > 0 && (
                  <Stack gap={8}>
                    {/* Partial-failure clarity: fewer images than requested means
                        the rest failed and were refunded. Say so explicitly
                        instead of silently rendering a short grid. */}
                    {it.imageUrls.length < it.requested && (
                      <Alert color="info" data-testid="queue-partial">
                        {it.imageUrls.length} of {it.requested} images generated — you were only charged for the
                        {it.imageUrls.length === 1 ? ' one that succeeded' : ' images that succeeded'} (the rest were refunded).
                      </Alert>
                    )}
                    {/* Result images via the design-system Image primitive: a
                        token placeholder while loading, native lazy-loading, and
                        a graceful fallback overlay if a generated image URL dies
                        (vs. a broken-glyph raw <img>). */}
                    {/* 🔴 The results are now the PAYOFF, not a byproduct: each
                        cell opens the full view (`ResultLightbox`) with the recipe
                        that made it. Before, a 120px thumbnail was the largest a
                        viewer could ever see an image they had just paid for —
                        the block's sandbox grants neither `allow-downloads` nor
                        `allow-popups`, so there was no way out of the iframe to
                        look at it either. */}
                    <div data-testid="queue-results" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
                      {it.imageUrls.map((u, i) => (
                        <button
                          key={`${u}-${i}`}
                          type="button"
                          data-testid="result-image-open"
                          data-index={i}
                          aria-label={`View result ${i + 1} of ${it.imageUrls!.length} full size`}
                          className={motionClass(motion, CLASS_LIFT)}
                          onClick={() => openQueueLightbox(it.id, i)}
                          style={{
                            all: 'unset',
                            boxSizing: 'border-box',
                            display: 'block',
                            cursor: 'pointer',
                            width: '100%',
                            aspectRatio: '1 / 1',
                            borderRadius: radius.md,
                            overflow: 'hidden',
                            border: `1px solid ${c.border}`,
                          }}
                        >
                          <Image
                            src={u}
                            alt={`Result ${i + 1}`}
                            data-testid="result-image"
                            loading="lazy"
                            fallback="Image unavailable"
                            wrapperStyle={{ width: '100%', height: '100%' }}
                          />
                        </button>
                      ))}
                    </div>

                    {/* 🔴 THE OUTCOME RAIL — the app's terminal. A run used to end
                        at a thumbnail in a queue that documented itself as
                        in-session: the images still reached the viewer's Civitai
                        feed (the note below says so, and it is true), but the app
                        itself held nothing afterwards. "Keep" is what gives the
                        block its own record — durable, server-scanned civitai
                        images, attributed to this generator, in the viewer's own
                        gallery below and reopenable from here.

                        Keep is the PRIMARY action and sits first; the per-image
                        "⧉ Copy link 1 / 2 / 3" row that used to live here (one
                        button per image, growing with quantity and burying
                        Re-run) moved into the full view, where exactly one image
                        is in hand. */}
                    <Group gap={6} data-testid="result-actions" justify="space-between">
                      <Group gap={6}>
                        {keepOutputs && it.workflowId && (
                          it.keepStatus === 'kept' ? (
                            <Badge color="success" variant="light" data-testid="result-kept">
                              ✓ Kept{it.keptImageIds ? ` (${it.keptImageIds.length})` : ''}
                            </Badge>
                          ) : (
                            <Button
                              size="sm"
                              data-testid="result-keep"
                              loading={it.keepStatus === 'keeping'}
                              disabled={it.keepStatus === 'keeping'}
                              onClick={() => keepItem(it)}
                            >
                              {it.keepStatus === 'failed' ? 'Try keeping again' : '★ Keep'}
                            </Button>
                          )
                        )}
                        <Button size="sm" variant="light" data-testid="result-rerun" onClick={() => rerun(it)}>
                          Re-run
                        </Button>
                      </Group>
                      {onOpenInGenerator && (
                        <Button size="sm" variant="subtle" data-testid="result-open-generator" onClick={onOpenInGenerator}>
                          Open in Civitai generator
                        </Button>
                      )}
                    </Group>

                    {it.keepStatus === 'keeping' && (
                      // The host shows its own consent confirm and this call waits
                      // on a person (up to 10 minutes), so say what is being waited
                      // on rather than spinning anonymously.
                      <span style={metaText} data-testid="result-keep-pending" role="status">
                        Waiting for you to confirm in the Civitai dialog…
                      </span>
                    )}
                    {keepErrors[it.id] && (
                      // Neutral by construction: the bridge cannot tell a declined
                      // consent from a real failure (see `KeepStatus`), and the
                      // host's own text is unsanitised, so neither is shown.
                      <Alert color="info" data-testid="result-keep-failed">
                        {keepErrors[it.id]}
                      </Alert>
                    )}
                  </Stack>
                )}

                {it.status === 'stalled' && (
                  <Alert color="info" data-testid="queue-stalled">
                    <Stack gap={8}>
                      <span>Still generating — this one is taking longer than usual. It's not lost; check back in a moment.</span>
                      <Group justify="flex-end">
                        <Button size="sm" variant="light" data-testid="queue-check-again" onClick={() => checkAgain(it)}>
                          Check again
                        </Button>
                      </Group>
                    </Stack>
                  </Alert>
                )}

                {it.status === 'failed' && it.insufficientBuzz && (
                  <Alert color="warning" data-testid="queue-failed-insufficient">
                    <Stack gap={8}>
                      <span>Not enough Buzz to finish this generation.</span>
                      <Group justify="flex-end" gap={6}>
                        {onTopUp && (
                          <Button size="sm" data-testid="queue-failed-topup" loading={toppingUp} onClick={() => topUp(it.estimatedCost)}>
                            Add Buzz
                          </Button>
                        )}
                        <Button size="sm" variant="light" data-testid="queue-failed-rerun" onClick={() => rerun(it)}>
                          Try again
                        </Button>
                      </Group>
                    </Stack>
                  </Alert>
                )}

                {it.status === 'failed' && !it.insufficientBuzz && (
                  <Alert color="error" data-testid="queue-failed">
                    {it.error ?? 'Generation failed.'}
                  </Alert>
                )}

                {(it.status === 'succeeded' || it.status === 'failed' || it.status === 'canceled' || it.status === 'stalled') && (
                  <Group justify="flex-end">
                    <Button size="sm" variant="subtle" data-testid="queue-remove" onClick={() => dismissItem(it.id)}>
                      Dismiss
                    </Button>
                  </Group>
                )}
              </Stack>
            </Card>
          ))}
        </Stack>

        {/* 🔴 KEPT FROM THIS GENERATOR — the durable half of the terminal, and the
            reason the queue above is allowed to stay in-session. The queue is what
            you are doing now; this is what you have. It survives Back, a reload,
            and the session, because it is a list of civitai image IDS in the
            viewer's own storage rather than a list of orchestrator urls.

            Rendered only when the app is actually wired for it (both a store's
            worth of runs and a gated resolver) and never in preview, where there
            is no viewer and nothing has been run. */}
        {!preview && getImages && keptRuns && keptRuns.length > 0 && (
          <Stack gap={10} data-testid="runner-kept">
            <Group justify="space-between" align="baseline">
              <h3 style={{ margin: 0, fontSize: 15, letterSpacing: '-0.01em' }}>Kept from this generator</h3>
              <span style={metaText} data-testid="runner-kept-count">
                {keptRuns.length} run{keptRuns.length === 1 ? '' : 's'}
              </span>
            </Group>
            <KeptGallery
              data-testid="runner-kept-gallery"
              runs={keptRuns}
              c={c}
              getImages={getImages}
              emptyTitle="Nothing kept yet"
              emptyBody="Keep a generation and it will be here next time."
              onOpenCell={openKeptLightbox}
            />
          </Stack>
        )}
      </Stack>

      {/* THE PAYOFF VIEW. One modal serves both sources — a fresh result in the
          queue and a kept image in the gallery — so the app has exactly one way
          of showing you a thing you made. */}
      <ResultLightbox
        opened={lightboxView != null}
        onClose={() => setLightbox(null)}
        c={c}
        src={lightboxView?.src ?? null}
        generatorName={config.name || 'Untitled generator'}
        buttonLabel={lightboxView?.buttonLabel ?? ''}
        recipe={lightboxView?.recipe ?? null}
        prompt={lightboxView?.prompt}
        index={lightboxView?.index ?? 1}
        total={lightboxView?.total ?? 1}
        onPrev={lightboxView?.onPrev}
        onNext={lightboxView?.onNext}
        kept={lightboxView?.kept}
        onCopyLink={
          onCopyImageLink && lightboxView?.src ? () => copyImageLink(lightboxView.src!) : undefined
        }
        copied={lightboxView?.src != null && copiedUrl === lightboxView.src}
      />

      {/* Leave-guard: a Back press while a generation is estimating/confirming/
          submitting/processing confirms first, so paid/in-flight work isn't
          dropped by an accidental navigation. */}
      <Modal
        opened={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title="Leave with generations in progress?"
        size="sm"
      >
        <Stack gap={14} data-testid="leave-confirm-modal">
          <p style={{ margin: 0, fontSize: 14 }}>
            A generation is still in progress. Leaving clears this queue view — the generation keeps
            running and finished images are saved to your Civitai feed, but you'll lose the progress
            shown here.
          </p>
          <Group justify="flex-end" gap={8}>
            <Button variant="subtle" size="sm" data-testid="leave-cancel" onClick={() => setConfirmLeave(false)}>
              Stay
            </Button>
            <Button
              color="error"
              size="sm"
              data-testid="leave-confirm"
              onClick={() => {
                setConfirmLeave(false);
                onBack();
              }}
            >
              Leave anyway
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}

function OverrideNumber({
  label,
  testid,
  value,
  onChange,
}: {
  label: string;
  testid: string;
  value: number | undefined;
  onChange: (n: number | undefined) => void;
}) {
  return (
    <NumberInput
      label={label}
      placeholder="default"
      data-testid={testid}
      value={value ?? null}
      onChange={(n) => onChange(n ?? undefined)}
    />
  );
}

function statusColor(s: QueueItem['status']): 'primary' | 'success' | 'error' | 'warning' | 'info' {
  if (s === 'succeeded') return 'success';
  if (s === 'failed') return 'error';
  if (s === 'confirming' || s === 'stalled') return 'warning';
  return 'info';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/** How many images a body requested (for partial-failure "N of M" messaging). */
function requestedQuantity(body: WorkflowBody): number {
  const q = body.kind === 'textToImage' ? body.params.quantity : undefined;
  return typeof q === 'number' && q > 0 ? q : 1;
}

// `missingInputsMessage` lived here and is GONE, deliberately: it took a union of
// missing inputs across every button and phrased it as one instruction, which is
// the defect described at `lib/preset.ts`. Its per-button replacement is
// `missingForButtonMessage`, which names the button it is answering.
