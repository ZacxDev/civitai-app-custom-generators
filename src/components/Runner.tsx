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

import { useMemo, useState } from 'react';
import type {
  BlockGenerationSourceImageInfo,
  BlockSourceImage,
  BlockWorkflowSnapshot,
  WorkflowBody,
} from '@civitai/app-sdk/blocks';

import { Alert, Badge, Button, Card, Collapse, Group, Loader, NumberInput, Stack, TextInput } from '@civitai/blocks-react/ui';

import type { GenButton, GeneratorConfig, GenButtonParams, QueueItem } from '../types.js';
import { DEFAULT_PROMPT_PLACEHOLDER, buildSubmitBody, canRunButton, exposesImage, exposesPrompt, missingRequiredInputs, type RequiredInput } from '../lib/generator.js';
import { isTerminalSnapshot, mapSnapshotStatus, pollToTerminal } from '../lib/workflow.js';
import type { Palette } from '../theme.js';

interface RunnerItem extends QueueItem {
  body: WorkflowBody;
}

export interface RunnerProps {
  config: GeneratorConfig;
  /** shared_kv key of the published generator (creator attribution G5); omit for own draft. */
  sharedContentKey?: string;
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
   * Live-preview mode for the Builder: renders the exact runtime layout but is
   * NON-runnable — pressing a button shows a note instead of estimating/spending.
   */
  preview?: boolean;
  /** Test seams. */
  pollIntervalMs?: number;
  /** Total poll-window before a still-processing gen is marked `stalled` (ms). */
  pollMaxDurationMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function Runner(props: RunnerProps) {
  const { config, sharedContentKey, c, canGenerate, buzzBalance, onRequestConsent, uploadSourceImage, estimate, submit, poll, onBack, preview = false } = props;

  const [promptInput, setPromptInput] = useState('');
  const [sourceImage, setSourceImage] = useState<BlockSourceImage | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [overrides, setOverrides] = useState<Partial<GenButtonParams>>({});
  const [items, setItems] = useState<RunnerItem[]>([]);
  const [runnerError, setRunnerError] = useState<string | null>(null);

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

    const id = `q_${Date.now().toString(36)}_${items.length}`;
    const item: RunnerItem = { id, buttonLabel: button.label, status: 'estimating', body };
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
      patchItem(id, { status: mapSnapshotStatus(snap.status), imageUrls: snap.imageUrls, error: snap.error });
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
    patchItem(item.id, { status: 'submitting', error: undefined });
    try {
      const snap = await submit(item.body);
      patchItem(item.id, {
        workflowId: snap.workflowId,
        status: mapSnapshotStatus(snap.status),
        imageUrls: snap.imageUrls,
        error: snap.error,
      });
      const terminal = await pollToTerminal(poll, snap, pollOpts(item.id));
      applyPollResult(item.id, terminal);
    } catch (e) {
      patchItem(item.id, { status: 'failed', error: errMsg(e) });
    }
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

  return (
    <div data-testid="runner">
      <Stack gap={16}>
        <Group justify="space-between">
          {preview ? (
            <Badge data-testid="runner-preview-badge" color="info">
              Preview
            </Badge>
          ) : (
            <Button variant="subtle" size="sm" data-testid="runner-back" onClick={onBack}>
              ← Back
            </Button>
          )}
          {buzzBalance != null && (
            <Badge data-testid="runner-balance">⚡ {buzzBalance.toLocaleString()}</Badge>
          )}
        </Group>

        {/* cosmetic header/cover banner — a full-width ~16:9 image at the TOP of
            the generator, above the prompt/buttons/generate content (not a
            backdrop behind them). Decorative, so empty alt. */}
        {config.headerImageRef && (
          <img
            data-testid="runner-header-banner"
            src={config.headerImageRef.url}
            alt=""
            style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 12, border: `1px solid ${c.border}`, display: 'block' }}
          />
        )}

        <div>
          <h2 style={{ margin: 0, fontSize: 20 }} data-testid="runner-title">
            {config.name || 'Untitled generator'}
          </h2>
          {config.description && <p style={{ margin: '4px 0 0', color: c.muted, fontSize: 14 }}>{config.description}</p>}
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
                  Source image (img2img) <span style={{ color: '#e5484d' }} aria-hidden>*</span>
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
          {items.length === 0 && <p style={{ color: c.muted, fontSize: 13 }} data-testid="queue-empty">No generations yet — press a button to start.</p>}
          {items.map((it) => (
            <Card key={it.id} withBorder padding="md" data-testid="queue-item" data-status={it.status}>
              <Stack gap={8}>
                <Group justify="space-between">
                  <strong style={{ fontSize: 14 }}>{it.buttonLabel}</strong>
                  <Badge data-testid="queue-status" color={statusColor(it.status)}>
                    {it.status}
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

                {it.status === 'confirming' && (
                  <Group justify="space-between">
                    <span style={{ fontSize: 14 }} data-testid="queue-cost">
                      ≈ {it.estimatedCost ?? '—'} ⚡
                    </span>
                    <Group gap={6}>
                      <Button size="sm" variant="subtle" data-testid="queue-dismiss" onClick={() => dismissItem(it.id)}>
                        Cancel
                      </Button>
                      <Button size="sm" data-testid="queue-confirm" onClick={() => confirmItem(it)}>
                        Confirm & generate
                      </Button>
                    </Group>
                  </Group>
                )}

                {it.status === 'succeeded' && it.imageUrls && it.imageUrls.length > 0 && (
                  <div data-testid="queue-results" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 8 }}>
                    {it.imageUrls.map((u, i) => (
                      <img key={`${u}-${i}`} src={u} alt={`Result ${i + 1}`} data-testid="result-image" style={{ width: '100%', borderRadius: 8 }} />
                    ))}
                  </div>
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

                {it.status === 'failed' && (
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

/** Human-readable "what's still needed to run" from a button's missing inputs. */
function missingInputsMessage(missing: RequiredInput[]): string {
  const needsPrompt = missing.includes('prompt');
  const needsImage = missing.includes('image');
  if (needsPrompt && needsImage) return 'Enter a prompt and add a source image to run.';
  if (needsImage) return 'Add a source image to run.';
  return 'Enter a prompt to run.';
}
