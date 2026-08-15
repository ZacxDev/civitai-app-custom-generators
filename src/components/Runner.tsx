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

import { useEffect, useMemo, useState } from 'react';
import type {
  BlockGenerationSourceImageInfo,
  BlockSourceImage,
  BlockWorkflowSnapshot,
  WorkflowBody,
} from '@civitai/app-sdk/blocks';

import { Alert, Badge, Button, Card, Collapse, Group, Loader, Modal, NumberInput, Stack, TextInput } from '@civitai/blocks-react/ui';

import type { GenButton, GeneratorConfig, GenButtonParams, QueueItem, QueueStatus } from '../types.js';
import { DEFAULT_PROMPT_PLACEHOLDER, buildSubmitBody, canRunButton, exposesImage, exposesPrompt, missingRequiredInputs, type RequiredInput } from '../lib/generator.js';
import { isTerminalSnapshot, mapSnapshotStatus, pollToTerminal, queueStatusLabel } from '../lib/workflow.js';
import { isInsufficientBuzzError } from '../lib/buzz.js';
import type { Analytics } from '../lib/analytics.js';
import { ANALYTICS_EVENTS, noopAnalytics } from '../lib/analytics.js';
import { Image } from '@civitai/components-react';

import { token, radius, metaText, type Palette } from '../theme.js';
import { EmptyState } from './EmptyState.js';
import { SafeImage } from './SafeImage.js';

interface RunnerItem extends QueueItem {
  body: WorkflowBody;
  /** How many images this gen requested (for partial-failure "N of M" messaging). */
  requested: number;
  /** Set when a terminal failure is classified as insufficient Buzz (top-up path). */
  insufficientBuzz?: boolean;
}

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
  /** Test seams. */
  pollIntervalMs?: number;
  /** Total poll-window before a still-processing gen is marked `stalled` (ms). */
  pollMaxDurationMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function Runner(props: RunnerProps) {
  const { config, sharedContentKey, headerUrl, c, canGenerate, buzzBalance, onRequestConsent, uploadSourceImage, estimate, submit, poll, onBack, onTopUp, onBalanceRefresh, onOpenInGenerator, onCopyImageLink, rehydrateNotice, preview = false } = props;
  const analytics = props.analytics ?? noopAnalytics;

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

  // Keep the local balance in sync when the parent pushes a fresh value.
  useEffect(() => {
    setLocalBalance(buzzBalance);
  }, [buzzBalance]);

  // Runtime inputs are INFERRED: the prompt box shows iff some button's template
  // carries a `{prompt}` token; the img2img source box shows iff some button is
  // img2img.
  const showPromptInput = useMemo(() => config.buttons.some(exposesPrompt), [config.buttons]);
  const showImageInput = useMemo(() => config.buttons.some(exposesImage), [config.buttons]);
  const promptPlaceholder = config.promptPlaceholder?.trim() || DEFAULT_PROMPT_PLACEHOLDER;

  // Union of the required inputs still unmet across the buttons — drives the
  // inline "what's needed to run" hint. Empty (or in preview) ⇒ no hint.
  const requiredHint = useMemo(() => {
    if (preview) return null;
    const missing = new Set<RequiredInput>();
    for (const b of config.buttons) {
      for (const m of missingRequiredInputs(b, { promptInput, sourceImage })) missing.add(m);
    }
    return missing.size > 0 ? missingInputsMessage([...missing]) : null;
  }, [preview, config.buttons, promptInput, sourceImage]);

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
      setRunnerError(missingInputsMessage(missing));
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
    const item: RunnerItem = { id, buttonLabel: button.label, status: 'estimating', body, requested };
    setItems((list) => [item, ...list]);

    try {
      const snap = await estimate(body);
      patchItem(id, { status: 'confirming', estimatedCost: snap.cost?.total });
    } catch (e) {
      patchItem(id, { status: 'failed', error: errMsg(e) });
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
    const clone: RunnerItem = { id, buttonLabel: item.buttonLabel, status: 'estimating', body: item.body, requested: item.requested };
    setItems((list) => [clone, ...list]);
    void (async () => {
      try {
        const snap = await estimate(item.body);
        patchItem(id, { status: 'confirming', estimatedCost: snap.cost?.total });
      } catch (e) {
        patchItem(id, { status: 'failed', error: errMsg(e) });
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

            {/* buttons — disabled until every runtime input the button EXPOSES is
                satisfied (prompt non-blank / img2img source uploaded). Preview is
                non-runnable, so it isn't input-gated: pressing surfaces a note. */}
            <Group gap={8}>
              {config.buttons.map((b) => (
                <Button
                  key={b.id}
                  data-testid="gen-button"
                  data-button-id={b.id}
                  disabled={!preview && !canRunButton(b, { promptInput, sourceImage })}
                  onClick={() => pressButton(b)}
                >
                  {b.label || 'Button'}
                </Button>
              ))}
            </Group>

            {!preview && requiredHint && (
              <span data-testid="runner-required-hint" style={{ fontSize: 12, color: c.muted }}>
                {requiredHint}
              </span>
            )}

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
              Generations are saved to your Civitai feed.
            </span>
          )}
          {items.length === 0 && (
            <EmptyState
              data-testid="queue-empty"
              title="No generations yet"
              body="Press a generator button above to queue your first image."
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
                    <div data-testid="queue-results" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 8 }}>
                      {it.imageUrls.map((u, i) => (
                        <Image
                          key={`${u}-${i}`}
                          src={u}
                          alt={`Result ${i + 1}`}
                          data-testid="result-image"
                          loading="lazy"
                          fallback="Image unavailable"
                          wrapperStyle={{ width: '100%', aspectRatio: '1 / 1', borderRadius: radius.md }}
                        />
                      ))}
                    </div>
                    {/* Result actions: download each image, re-run the same inputs,
                        or continue in the on-site Civitai generator. */}
                    <Group gap={6} data-testid="result-actions">
                      {onCopyImageLink && it.imageUrls.map((u, i) => (
                        // Copy the image url (sandbox-legal): a file download needs
                        // allow-downloads and opening a tab needs allow-popups —
                        // neither is granted to an unverified block. Paste the url
                        // into a top-level tab to open/save the image.
                        <Button
                          key={`cp-${u}-${i}`}
                          size="sm"
                          variant="subtle"
                          data-testid="result-copy-link"
                          onClick={() => copyImageLink(u)}
                        >
                          {copiedUrl === u ? '✓ Link copied' : `⧉ Copy link ${i + 1}`}
                        </Button>
                      ))}
                      <Button size="sm" variant="light" data-testid="result-rerun" onClick={() => rerun(it)}>
                        Re-run
                      </Button>
                      {onOpenInGenerator && (
                        <Button size="sm" variant="subtle" data-testid="result-open-generator" onClick={onOpenInGenerator}>
                          Open in Civitai generator
                        </Button>
                      )}
                    </Group>
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
      </Stack>

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

/** Human-readable "what's still needed to run" from a button's missing inputs. */
function missingInputsMessage(missing: RequiredInput[]): string {
  const needsPrompt = missing.includes('prompt');
  const needsImage = missing.includes('image');
  if (needsPrompt && needsImage) return 'Enter a prompt and add a source image to run.';
  if (needsImage) return 'Add a source image to run.';
  return 'Enter a prompt to run.';
}
