// One-time onboarding panel for the Discover surface: explains the concept a
// first-time viewer is missing ("what IS a custom generator?") and lets them
// "Make a copy" of a seeded example to learn by remixing. Dismissible. Styled
// entirely off `--civitai-*` tokens (via ../theme) so it flips with `[data-theme]`.

import { Button, Card, Group, Stack } from '@civitai/blocks-react/ui';
import type { SharedListItem } from '@civitai/blocks-react';

import { token, radius, metaText, type Palette } from '../theme.js';
import { CLASS_RISE, motionClass, useMotion } from '../motion.js';
import { formatCostRange, generatorCostRange } from '../lib/cost.js';

export interface IntroPanelProps {
  c: Palette;
  /** Seeded example generators to "Make a copy" of (may be empty). */
  examples: SharedListItem[];
  /** Fork an example into the viewer's own editable draft. */
  onTryExample: (item: SharedListItem) => void;
  /** Start a brand-new generator. */
  onCreate: () => void;
  /** Dismiss the panel for this session. */
  onDismiss: () => void;
}

export function IntroPanel({ c, examples, onTryExample, onCreate, onDismiss }: IntroPanelProps) {
  const motion = useMotion();
  return (
    // Entrance only. Dismissing UNMOUNTS the panel (see Browse), and an EXIT
    // animation would mean keeping it mounted past the click — which changes the
    // documented dismiss contract its tests pin. Restraint: fade it in, drop it out.
    <Card withBorder padding="md" data-testid="intro-panel" className={motionClass(motion, CLASS_RISE)}>
      <Stack gap={12}>
        <Group justify="space-between" align="flex-start" gap={12} wrap={false}>
          <Stack gap={4} style={{ minWidth: 0 }}>
            <strong style={{ fontSize: 15 }}>What&apos;s a custom generator?</strong>
            <span style={{ ...metaText }}>
              A custom generator is a little panel of one-click buttons someone built. Each button is
              a saved generation preset — a checkpoint, optional LoRAs, and a prompt template — so you
              just type your idea and run it. Build your own, or make a copy of an example below to remix.
            </span>
          </Stack>
          <Button size="sm" variant="subtle" data-testid="intro-dismiss" onClick={onDismiss}>
            Got it
          </Button>
        </Group>

        {examples.length > 0 && (
          <Stack gap={8} data-testid="intro-examples">
            <span style={{ fontSize: 13, fontWeight: 600, color: c.muted }}>Try an example</span>
            {examples.map((ex) => {
              const cost = formatCostRange(generatorCostRange(ex.value));
              const desc = (ex.value.body ?? '').split('\n')[0];
              return (
                <Group
                  key={ex.key}
                  justify="space-between"
                  align="center"
                  gap={10}
                  wrap={false}
                  data-testid="intro-example"
                  style={{ border: `1px solid ${token.border}`, borderRadius: radius.md, padding: '8px 10px' }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{ex.value.title || 'Example generator'}</div>
                    {desc && <div style={{ ...metaText }}>{desc}</div>}
                    {cost && (
                      <div style={{ ...metaText, fontVariantNumeric: 'tabular-nums' }} data-testid="intro-example-cost">
                        {cost}
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="light"
                    data-testid="intro-example-copy"
                    onClick={() => onTryExample(ex)}
                  >
                    Make a copy
                  </Button>
                </Group>
              );
            })}
          </Stack>
        )}

        <Group gap={8}>
          <Button size="sm" data-testid="intro-create" onClick={onCreate}>
            Build your own
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
