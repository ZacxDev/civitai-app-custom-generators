// Editor for ONE generator button. Presentation + local interaction only; all
// resource resolution comes in via the `pickResource` prop (the App wires it to
// useResourcePicker). Emits immutable patches through `onChange`.
//
// Runtime inputs are INFERRED, not toggled: the runner's prompt box shows iff
// the template carries a `{prompt}` token; the img2img source box shows iff the
// workflow is img2img. Inline hints explain what each button will surface.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { BlockResourceInfo, BlockResourcePickerType } from '@civitai/app-sdk/blocks';
import type { GenerationSamplersState } from '../platform/index.js';

import {
  Button,
  Card,
  Collapse,
  Group,
  NumberInput,
  Select,
  Slider,
  Stack,
  TextInput,
  Textarea,
  Badge,
} from '../ui/index.js';

import type { GenButton, LoraRef, WorkflowType } from '../types.js';
import {
  MAX_LORAS,
  PARAM_BOUNDS,
  PROMPT_TOKEN,
  WORKFLOW_TYPES,
  checkpointFromPick,
  clampWeight,
  exposesImage,
  exposesPrompt,
  loraFromPick,
} from '../lib/generator.js';
import { samplerControlFor, samplerCorrection } from '../lib/sampler.js';
import { accentWash, type Palette } from '../theme.js';

export interface ButtonEditorProps {
  button: GenButton;
  index: number;
  count: number;
  c: Palette;
  pickResource: (opts: {
    resourceType: BlockResourcePickerType;
    baseModelGroup?: string;
  }) => Promise<BlockResourceInfo | null>;
  /**
   * The platform's sampler catalog: `null` while it loads. Optional so a caller
   * that never loads it gets the free-text field (`loading` renders it).
   */
  samplers?: GenerationSamplersState | null;
  /**
   * This button as last SAVED (`undefined` for one added since): the baseline of
   * the saved-sampler note. The Builder moves it on every successful save, which
   * is what clears a note about a value the save has just replaced.
   */
  saved?: GenButton;
  onChange: (patch: (b: GenButton) => GenButton) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}

export function ButtonEditor({
  button,
  index,
  count,
  c,
  pickResource,
  samplers = null,
  saved,
  onChange,
  onMove,
  onRemove,
}: ButtonEditorProps) {
  const [advanced, setAdvanced] = useState(false);
  // The value a checkpoint switch replaced, shown until the author picks again.
  const [samplerReset, setSamplerReset] = useState<{ from: string; to: string } | null>(null);
  // A generator saved before the drop-down (0.18.0) can carry a sampler its
  // checkpoint's family does not offer; runs then use the family default
  // (`samplerForRun`), and the author is told so here, outside the collapsed
  // advanced params where the reset notice lives. Only the Builder renders this
  // editor, and only on the viewer's own drafts, so runners never see it.
  // Whether a note still describes the SAVED value is `savedSamplerNote`, the one
  // predicate both writers below go through.
  const [savedInvalid, setSavedInvalid] = useState<SavedSamplerNote | null>(null);
  const [picking, setPicking] = useState<null | 'ckpt' | 'lora'>(null);

  // a11y: after a reorder the moved card jumps position; keep keyboard focus on
  // its move control (or the still-enabled sibling / the card) so a keyboard user
  // isn't dumped back to the top of the page.
  const pendingFocus = useRef<null | -1 | 1>(null);
  function moveWithFocus(dir: -1 | 1) {
    pendingFocus.current = dir;
    onMove(dir);
  }
  useEffect(() => {
    const dir = pendingFocus.current;
    if (dir == null) return;
    pendingFocus.current = null;
    requestAnimationFrame(() => {
      const scope = document.querySelector<HTMLElement>(
        `[data-testid="button-editor"][data-button-id="${button.id}"]`,
      );
      if (!scope) return;
      const up = scope.querySelector<HTMLButtonElement>('[data-testid="move-up"]');
      const down = scope.querySelector<HTMLButtonElement>('[data-testid="move-down"]');
      const primary = dir === -1 ? up : down;
      const fallback = dir === -1 ? down : up;
      const target = primary && !primary.disabled ? primary : fallback && !fallback.disabled ? fallback : scope;
      target?.focus();
    });
    // index changes exactly when THIS card moved; other shifted cards have no
    // pendingFocus so they no-op.
  }, [index, button.id]);

  async function pickCheckpoint() {
    setPicking('ckpt');
    try {
      const picked = await pickResource({ resourceType: 'Checkpoint' });
      if (picked) {
        // A notice about the previous checkpoint's family no longer applies.
        setSamplerReset(null);
        setSavedInvalid(null);
        onChange((b) => ({ ...b, checkpoint: checkpointFromPick(picked) }));
      }
    } finally {
      setPicking(null);
    }
  }

  async function addLora() {
    if (button.loras.length >= MAX_LORAS) return;
    setPicking('lora');
    try {
      const picked = await pickResource({
        resourceType: 'LORA',
        baseModelGroup: button.checkpoint?.baseModel,
      });
      if (picked) {
        onChange((b) =>
          b.loras.some((l) => l.versionId === picked.versionId)
            ? b
            : { ...b, loras: [...b.loras, loraFromPick(picked)] },
        );
      }
    } finally {
      setPicking(null);
    }
  }

  function setLoraWeight(versionId: number, weight: number) {
    onChange((b) => ({
      ...b,
      loras: b.loras.map((l) =>
        l.versionId === versionId
          ? { ...l, weight: clampWeight(weight, l.minStrength ?? -1, l.maxStrength ?? 2) }
          : l,
      ),
    }));
  }

  function removeLora(versionId: number) {
    onChange((b) => ({ ...b, loras: b.loras.filter((l) => l.versionId !== versionId) }));
  }

  const p = button.params;
  const setParam = (patch: Partial<GenButton['params']>) =>
    onChange((b) => ({ ...b, params: { ...b.params, ...patch } }));

  const samplerControl = samplerControlFor(samplers, button.checkpoint);

  // Keep the stored sampler valid for the checkpoint's family: re-run whenever the
  // catalog arrives, the checkpoint changes or the value does. A value the family
  // does not offer is reset to its default VISIBLY (the host would otherwise swap
  // it silently), and a family with no sampler control drops the stored value.
  useEffect(() => {
    const control = samplerControlFor(samplers, button.checkpoint);
    const fix = samplerCorrection(control, button.params);
    if (!fix) return;
    onChange((b) => {
      const latest = samplerCorrection(samplerControlFor(samplers, b.checkpoint), b.params);
      return latest ? { ...b, params: latest.params } : b;
    });
    setSamplerReset(fix.reset !== null && fix.params.sampler ? { from: fix.reset, to: fix.params.sampler } : null);
    setSavedInvalid(
      fix.reset !== null && fix.params.sampler
        ? savedSamplerNote({ from: fix.reset, to: fix.params.sampler }, saved, button.checkpoint?.versionId)
        : null,
    );
    // `onChange` is a fresh closure every render, so it is not a dependency; the
    // inputs that decide the fix are.
  }, [samplers, button.checkpoint?.baseModel, button.checkpoint?.versionId, button.params.sampler]);

  // A save moved the baseline: keep the note only while the saved value is still
  // the one it names. A successful save of the corrected value clears it; a
  // failed save leaves `saved` (and so the note) as it was.
  useEffect(() => {
    setSavedInvalid((note) => note && savedSamplerNote(note, saved, button.checkpoint?.versionId));
  }, [saved]);

  const showsPrompt = exposesPrompt(button);
  const showsImage = exposesImage(button);

  return (
    <Card withBorder padding="md" data-testid="button-editor" data-button-id={button.id} tabIndex={-1}>
      <Stack gap={12}>
        <Group justify="space-between">
          <Badge>{`Button ${index + 1}`}</Badge>
          <Group gap={4}>
            <Button
              size="sm"
              variant="subtle"
              aria-label="Move button up"
              data-testid="move-up"
              disabled={index === 0}
              onClick={() => moveWithFocus(-1)}
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="subtle"
              aria-label="Move button down"
              data-testid="move-down"
              disabled={index === count - 1}
              onClick={() => moveWithFocus(1)}
            >
              ↓
            </Button>
            <Button
              size="sm"
              variant="subtle"
              color="error"
              aria-label="Remove button"
              data-testid="remove-button"
              onClick={onRemove}
            >
              ✕
            </Button>
          </Group>
        </Group>

        <TextInput
          label="Label"
          required
          value={button.label}
          data-testid="btn-label-input"
          onChange={(e) => {
            // Read now: the patch runs inside a state updater, after React has
            // released the event (its `currentTarget` is null by then).
            const label = e.currentTarget.value;
            onChange((b) => ({ ...b, label }));
          }}
        />

        <Select
          label="Workflow"
          aria-label="Workflow type"
          data-testid="btn-workflow-select"
          value={button.workflowType}
          onChange={(v) => onChange((b) => ({ ...b, workflowType: v as WorkflowType }))}
          options={WORKFLOW_TYPES.map((w) => ({
            value: w,
            label: w === 'txt2img' ? 'Text → Image' : 'Image → Image (img2img)',
          }))}
        />

        {/* checkpoint */}
        <Group justify="space-between">
          <div style={{ fontSize: 13 }}>
            <div style={{ color: c.muted }}>Checkpoint</div>
            <div data-testid="checkpoint-name">
              {button.checkpoint
                ? button.checkpoint.modelName ?? `#${button.checkpoint.versionId}`
                : 'None selected'}
            </div>
          </div>
          <Button
            size="sm"
            variant="light"
            data-testid="pick-checkpoint"
            loading={picking === 'ckpt'}
            onClick={pickCheckpoint}
          >
            {button.checkpoint ? 'Change' : 'Pick checkpoint'}
          </Button>
        </Group>

        {/* loras */}
        <Stack gap={8}>
          <Group justify="space-between">
            <div style={{ fontSize: 13, color: c.muted }}>
              LoRAs ({button.loras.length}/{MAX_LORAS})
            </div>
            <Button
              size="sm"
              variant="light"
              data-testid="add-lora"
              loading={picking === 'lora'}
              disabled={button.loras.length >= MAX_LORAS}
              onClick={addLora}
            >
              Add LoRA
            </Button>
          </Group>
          {button.loras.map((l) => (
            <LoraRow
              key={l.versionId}
              lora={l}
              c={c}
              onWeight={(w) => setLoraWeight(l.versionId, w)}
              onRemove={() => removeLora(l.versionId)}
            />
          ))}
        </Stack>

        <PromptTemplateEditor
          value={button.promptTemplate}
          c={c}
          onChange={(v) => onChange((b) => ({ ...b, promptTemplate: v }))}
        />

        {/* inferred-input hints */}
        <Stack gap={4} data-testid="input-hints">
          {showsPrompt && (
            <Hint c={c} testid="hint-prompt">
              A prompt box will appear because your template uses <code>{PROMPT_TOKEN}</code>.
            </Hint>
          )}
          {showsImage && (
            <Hint c={c} testid="hint-image">
              An image box appears because this button is img2img.
            </Hint>
          )}
          {!showsPrompt && !showsImage && (
            <Hint c={c} testid="hint-fixed">
              This button's prompt is fully fixed — no runner inputs. That's valid, just letting you
              know.
            </Hint>
          )}
        </Stack>

        {savedInvalid && (
          <Hint c={c} testid="sampler-saved-invalid">
            {`Saved sampler ${savedInvalid.from} isn't valid for this checkpoint, so the family default, ${savedInvalid.to}, is used.`}
          </Hint>
        )}

        <Collapse
          open={advanced}
          onOpenChange={setAdvanced}
          title={advanced ? 'Hide advanced params' : 'Advanced params'}
          data-testid="advanced-collapse"
        >
          <div
            data-testid="advanced-params"
            style={{
              display: 'grid',
              gap: 10,
              gridTemplateColumns: 'repeat(2, minmax(0,1fr))',
              marginTop: 8,
            }}
          >
            <Textarea
              label="Negative prompt"
              minRows={1}
              value={p.negativePrompt ?? ''}
              data-testid="param-negative"
              onChange={(e) => setParam({ negativePrompt: e.currentTarget.value })}
            />
            {samplerControl.kind === 'select' && (
              <div>
                <Select
                  label="Sampler"
                  data-testid="param-sampler"
                  data-sampler-control="select"
                  value={p.sampler ?? samplerControl.defaultValue}
                  options={samplerControl.options.map((o) => ({ value: o.value, label: o.label }))}
                  onChange={(v) => {
                    setSamplerReset(null);
                    setSavedInvalid(null);
                    setParam({ sampler: v });
                  }}
                />
                {samplerReset && (
                  <Hint c={c} testid="sampler-reset-notice">
                    {`Sampler reset to ${samplerReset.to}: ${samplerReset.from} isn't offered for this checkpoint.`}
                  </Hint>
                )}
              </div>
            )}
            {(samplerControl.kind === 'free' || samplerControl.kind === 'loading') && (
              <div>
                <TextInput
                  label="Sampler"
                  value={p.sampler ?? ''}
                  data-testid="param-sampler"
                  data-sampler-control="text"
                  onChange={(e) => setParam({ sampler: e.currentTarget.value })}
                />
                {samplerControl.kind === 'free' && (
                  <Hint c={c} testid="sampler-note">
                    {samplerControl.note}
                  </Hint>
                )}
              </div>
            )}
            {/* min/max come from PARAM_BOUNDS (single-sourced with the run-path
                clamp in lib/generator.ts) so authoring inputs and the untrusted
                clamp can never drift. */}
            <NumberField label="CFG" testid="param-cfg" value={p.cfgScale} min={PARAM_BOUNDS.cfgScale.min} max={PARAM_BOUNDS.cfgScale.max} onChange={(n) => setParam({ cfgScale: n })} />
            <NumberField label="Steps" testid="param-steps" value={p.steps} min={PARAM_BOUNDS.steps.min} max={PARAM_BOUNDS.steps.max} onChange={(n) => setParam({ steps: n })} />
            <NumberField label="Width" testid="param-width" value={p.width} min={PARAM_BOUNDS.width.min} max={PARAM_BOUNDS.width.max} step={64} onChange={(n) => setParam({ width: n })} />
            <NumberField label="Height" testid="param-height" value={p.height} min={PARAM_BOUNDS.height.min} max={PARAM_BOUNDS.height.max} step={64} onChange={(n) => setParam({ height: n })} />
            <NumberField label="Quantity" testid="param-quantity" value={p.quantity} min={PARAM_BOUNDS.quantity.min} max={PARAM_BOUNDS.quantity.max} onChange={(n) => setParam({ quantity: n })} />
            <NumberField
              label="Seed (blank = random)"
              testid="param-seed"
              value={p.seed ?? undefined}
              min={PARAM_BOUNDS.seed.min}
              onChange={(n) => setParam({ seed: n ?? null })}
            />
          </div>
        </Collapse>
      </Stack>
    </Card>
  );
}

/** The `{prompt}` template editor: a highlight overlay behind the textarea marks
 *  the token, an "Insert {prompt}" button splices it at the caret, and the
 *  overlay stays scroll-synced with the textarea. */
function PromptTemplateEditor({
  value,
  c,
  onChange,
}: {
  value: string;
  c: Palette;
  onChange: (v: string) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);

  function insertToken() {
    const el = taRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + PROMPT_TOKEN + value.slice(end);
    onChange(next);
    // Restore the caret just after the inserted token on the next frame (after
    // React re-renders the controlled textarea with the new value).
    requestAnimationFrame(() => {
      const node = taRef.current;
      if (!node) return;
      const pos = start + PROMPT_TOKEN.length;
      node.focus();
      try {
        node.setSelectionRange(pos, pos);
      } catch {
        /* setSelectionRange can throw on detached nodes — ignore. */
      }
    });
  }

  function syncScroll() {
    const ta = taRef.current;
    const hl = hlRef.current;
    if (ta && hl) {
      hl.scrollTop = ta.scrollTop;
      hl.scrollLeft = ta.scrollLeft;
    }
  }

  // 🔴 ONE TEXT LAYOUT FOR BOTH BOXES. The textarea is transparent: the caret is
  // laid out by IT, the glyphs the viewer reads by the overlay, so they line up
  // only while both wrap at the same width (feedback #180). Every text-layout property
  // lives here, and nothing on either element below may override one.
  //  - `scrollbarGutter: 'stable'` — the textarea scrolls once a template outgrows
  //    its rows and the overlay never does. Without a gutter BOTH always reserve,
  //    the textarea's scrollbar narrowed only its own content box (367 vs 382px
  //    measured in Brave) and the two wrapped differently: the caret at the end of
  //    a long template sat ~130px from the last visible glyph. Overlay scrollbars
  //    (macOS) reserve nothing on either box, which is also equal.
  //  - `overflowWrap` — the UA stylesheet gives a textarea `break-word` and a div
  //    `normal`; stated so neither box inherits a different default.
  const boxText: CSSProperties = {
    margin: 0,
    padding: '8px 10px',
    border: 'none',
    fontSize: 14,
    lineHeight: '20px',
    fontFamily: 'inherit',
    fontWeight: 'inherit',
    letterSpacing: 'normal',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowWrap: 'break-word',
    boxSizing: 'border-box',
    scrollbarGutter: 'stable',
  };

  return (
    <div data-testid="prompt-template-editor">
      <Group justify="space-between">
        <span style={{ fontSize: 13, fontWeight: 500 }}>Prompt template</span>
        <Button size="sm" variant="subtle" data-testid="insert-prompt-token" onClick={insertToken}>
          Insert {PROMPT_TOKEN}
        </Button>
      </Group>
      <div
        style={{
          position: 'relative',
          marginTop: 4,
          border: `1px solid ${c.border}`,
          borderRadius: 8,
          background: c.card,
          overflow: 'hidden',
        }}
      >
        <div
          ref={hlRef}
          aria-hidden
          data-testid="prompt-highlight"
          style={{
            ...boxText,
            position: 'absolute',
            inset: 0,
            overflow: 'hidden',
            color: c.fg,
            pointerEvents: 'none',
          }}
        >
          {renderHighlighted(value)}
        </div>
        <textarea
          ref={taRef}
          data-testid="btn-prompt-template"
          aria-label="Prompt template"
          value={value}
          rows={3}
          onChange={(e) => onChange(e.currentTarget.value)}
          onScroll={syncScroll}
          style={{
            ...boxText,
            position: 'relative',
            display: 'block',
            width: '100%',
            minHeight: 64,
            resize: 'vertical',
            background: 'transparent',
            color: 'transparent',
            caretColor: c.fg,
            outline: 'none',
          }}
        />
      </div>
      <div style={{ fontSize: 12, color: c.muted, marginTop: 4 }}>
        Use <code>{PROMPT_TOKEN}</code> where a runner's typed prompt should be inserted.
      </div>
    </div>
  );
}

/** Render the template text with each `{prompt}` token wrapped in a highlight. */
function renderHighlighted(text: string): ReactNode {
  if (!text) return null;
  const parts = text.split(PROMPT_TOKEN);
  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (part) out.push(<span key={`t${i}`}>{part}</span>);
    if (i < parts.length - 1) {
      out.push(
        <mark
          key={`m${i}`}
          data-testid="prompt-token-mark"
          style={{
            background: accentWash(28),
            color: 'inherit',
            borderRadius: 4,
            // NO horizontal padding/margin/border: in the overlay any of them
            // pushes every later glyph right of where the textarea puts the caret
            // (feedback #180). The 1px breathing room is painted, not laid out.
            boxShadow: `0 0 0 1px ${accentWash(28)}`,
          }}
        >
          {PROMPT_TOKEN}
        </mark>,
      );
    }
  });
  // A trailing newline needs a trailing char so the overlay's last line matches
  // the textarea's height.
  if (text.endsWith('\n')) out.push(<span key="pad">{'​'}</span>);
  return out;
}

interface SavedSamplerNote {
  from: string;
  to: string;
}

/**
 * The note, or `null` when it would not be about the SAVED value: the replaced
 * sampler must be the one this button was saved with, on the checkpoint it was
 * saved with. A reset the author's own checkpoint switch caused, a button never
 * saved, and a save that already wrote the corrected value all fail it.
 */
function savedSamplerNote(
  note: SavedSamplerNote,
  saved: GenButton | undefined,
  versionId: number | undefined,
): SavedSamplerNote | null {
  if (!saved) return null;
  if (note.from !== saved.params.sampler) return null;
  if (versionId !== saved.checkpoint?.versionId) return null;
  return note;
}

function Hint({ c, testid, children }: { c: Palette; testid: string; children: ReactNode }) {
  return (
    <div data-testid={testid} style={{ fontSize: 12, color: c.muted, lineHeight: 1.4 }}>
      {children}
    </div>
  );
}

function LoraRow({
  lora,
  c,
  onWeight,
  onRemove,
}: {
  lora: LoraRef;
  c: Palette;
  onWeight: (w: number) => void;
  onRemove: () => void;
}) {
  const min = lora.minStrength ?? -1;
  const max = lora.maxStrength ?? 2;
  return (
    <Card withBorder padding="sm" data-testid="lora-row" data-lora-id={lora.versionId}>
      <Stack gap={6}>
        <Group justify="space-between">
          <span style={{ fontSize: 13 }}>{lora.modelName ?? `LoRA #${lora.versionId}`}</span>
          <Button size="sm" variant="subtle" color="error" data-testid="remove-lora" aria-label="Remove LoRA" onClick={onRemove}>
            ✕
          </Button>
        </Group>
        <Group gap={10}>
          <Slider
            aria-label="LoRA weight"
            data-testid="lora-weight"
            min={min}
            max={max}
            step={0.05}
            value={lora.weight}
            onChange={onWeight}
            style={{ flex: 1 }}
          />
          <span data-testid="lora-weight-value" style={{ fontVariantNumeric: 'tabular-nums', color: c.muted, minWidth: 44, textAlign: 'right' }}>
            {lora.weight.toFixed(2)}
          </span>
        </Group>
      </Stack>
    </Card>
  );
}

function NumberField({
  label,
  testid,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  testid: string;
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
  onChange: (n: number | undefined) => void;
}) {
  return (
    <NumberInput
      label={label}
      data-testid={testid}
      value={value ?? null}
      min={min}
      max={max}
      step={step}
      onChange={(n) => onChange(n ?? undefined)}
    />
  );
}
