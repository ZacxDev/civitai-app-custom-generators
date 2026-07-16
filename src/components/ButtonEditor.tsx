// Editor for ONE generator button. Presentation + local interaction only; all
// resource resolution comes in via the `pickResource` prop (the App wires it to
// useResourcePicker). Emits immutable patches through `onChange`.
//
// Runtime inputs are INFERRED, not toggled: the runner's prompt box shows iff
// the template carries a `{prompt}` token; the img2img source box shows iff the
// workflow is img2img. Inline hints explain what each button will surface.

import { useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { BlockResourceInfo, BlockResourcePickerType } from '@civitai/app-sdk/blocks';

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
} from '@civitai/blocks-react/ui';

import type { GenButton, LoraRef, WorkflowType } from '../types.js';
import {
  MAX_LORAS,
  PROMPT_TOKEN,
  WORKFLOW_TYPES,
  checkpointFromPick,
  clampWeight,
  exposesImage,
  exposesPrompt,
  loraFromPick,
} from '../lib/generator.js';
import type { Palette } from '../theme.js';

export interface ButtonEditorProps {
  button: GenButton;
  index: number;
  count: number;
  c: Palette;
  pickResource: (opts: {
    resourceType: BlockResourcePickerType;
    baseModelGroup?: string;
  }) => Promise<BlockResourceInfo | null>;
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
  onChange,
  onMove,
  onRemove,
}: ButtonEditorProps) {
  const [advanced, setAdvanced] = useState(false);
  const [picking, setPicking] = useState<null | 'ckpt' | 'lora'>(null);

  async function pickCheckpoint() {
    setPicking('ckpt');
    try {
      const picked = await pickResource({ resourceType: 'Checkpoint' });
      if (picked) onChange((b) => ({ ...b, checkpoint: checkpointFromPick(picked) }));
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

  const showsPrompt = exposesPrompt(button);
  const showsImage = exposesImage(button);

  return (
    <Card withBorder padding="md" data-testid="button-editor" data-button-id={button.id}>
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
              onClick={() => onMove(-1)}
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="subtle"
              aria-label="Move button down"
              data-testid="move-down"
              disabled={index === count - 1}
              onClick={() => onMove(1)}
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
          onChange={(e) => onChange((b) => ({ ...b, label: e.currentTarget.value }))}
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
            <TextInput
              label="Sampler"
              value={p.sampler ?? ''}
              data-testid="param-sampler"
              onChange={(e) => setParam({ sampler: e.currentTarget.value })}
            />
            <NumberField label="CFG" testid="param-cfg" value={p.cfgScale} min={1} max={30} onChange={(n) => setParam({ cfgScale: n })} />
            <NumberField label="Steps" testid="param-steps" value={p.steps} min={1} max={50} onChange={(n) => setParam({ steps: n })} />
            <NumberField label="Width" testid="param-width" value={p.width} min={64} max={2048} step={64} onChange={(n) => setParam({ width: n })} />
            <NumberField label="Height" testid="param-height" value={p.height} min={64} max={2048} step={64} onChange={(n) => setParam({ height: n })} />
            <NumberField label="Quantity" testid="param-quantity" value={p.quantity} min={1} max={4} onChange={(n) => setParam({ quantity: n })} />
            <NumberField
              label="Seed (blank = random)"
              testid="param-seed"
              value={p.seed ?? undefined}
              min={0}
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

  const boxText: CSSProperties = {
    margin: 0,
    padding: '8px 10px',
    border: 'none',
    fontSize: 14,
    lineHeight: '20px',
    fontFamily: 'inherit',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    boxSizing: 'border-box',
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
            background: 'rgba(116,143,255,0.35)',
            color: 'inherit',
            borderRadius: 4,
            padding: '0 1px',
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
