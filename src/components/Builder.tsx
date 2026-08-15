// The BUILDER screen: create/edit a generator (name, description, prompt-box
// placeholder, cosmetic background, an ordered list of buttons), then Save draft
// or Publish. Presentation + local state; persistence + moderation happen in the
// parent via onSaveDraft / onPublish. A live, NON-runnable preview pane renders
// the actual Runner layout so the author sees what runners will get.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BlockGenerationSourceImageInfo, BlockPendingImageInfo, BlockResourceInfo, BlockResourcePickerType, BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import { Alert, Badge, Button, Card, Group, Loader, Stack, TextInput, Textarea } from '@civitai/blocks-react/ui';

import type { BackgroundScanResult, GeneratorConfig, HeaderImageRef } from '../types.js';
import { moveButton, newButton, updateButton, validateGenerator } from '../lib/generator.js';
import type { Palette } from '../theme.js';
import { useIsMobile } from '../useMediaQuery.js';
import { ButtonEditor } from './ButtonEditor.js';
import { Runner } from './Runner.js';
import { SafeImage } from './SafeImage.js';

export interface BuilderProps {
  initial: GeneratorConfig;
  c: Palette;
  pickResource: (opts: {
    resourceType: BlockResourcePickerType;
    baseModelGroup?: string;
  }) => Promise<BlockResourceInfo | null>;
  uploadImage: () => Promise<BlockPendingImageInfo | null>;
  /** Resolve the moderation SCAN outcome for an accepted (pending) background image. */
  scanBackground: (img: BlockPendingImageInfo) => Promise<BackgroundScanResult>;
  /** Fail the inline scan with a timeout after this long (default 30s). */
  scanTimeoutMs?: number;
  onSaveDraft: (config: GeneratorConfig) => Promise<void>;
  onPublish: (config: GeneratorConfig) => Promise<void>;
  onBack: () => void;
}

/**
 * Inline background-scan state — a small deterministic enum driving the status
 * UI near the background field, kept SEPARATE from the persisted
 * `config.headerImageRef` so the upload modal can auto-close and the scan
 * runs in the background while the user keeps editing. Fail-closed: an image
 * becomes `headerImageRef` ONLY on the `scanned` transition; `blocked` /
 * `error` never persist and never disturb a previously-scanned background.
 */
type BgScanState =
  | { phase: 'idle' }
  | { phase: 'scanning'; img: BlockPendingImageInfo }
  | { phase: 'scanned' }
  | { phase: 'blocked'; reason?: string }
  | { phase: 'error'; message: string; img: BlockPendingImageInfo };

/** Reject `p` if it hasn't settled within `ms` — so a hung scan surfaces inline. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Image scan timed out — try uploading again.')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** No-op generation deps for the NON-runnable preview (pressing a button in the
 *  preview surfaces a note instead of estimating/spending — see Runner#preview). */
const previewSnapshot = async (): Promise<BlockWorkflowSnapshot> => ({ workflowId: 'preview', status: 'succeeded' });
const previewNoUpload = async (): Promise<BlockGenerationSourceImageInfo | null> => null;
const noop = () => {};

export function Builder({ initial, c, pickResource, uploadImage, scanBackground, scanTimeoutMs = 30_000, onSaveDraft, onPublish, onBack }: BuilderProps) {
  const [config, setConfig] = useState<GeneratorConfig>(initial);
  const [busy, setBusy] = useState<null | 'save' | 'publish' | 'bg'>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scan, setScan] = useState<BgScanState>({ phase: 'idle' });
  const isMobile = useIsMobile();
  const [showPreview, setShowPreview] = useState(false);

  // Monotonic id so a stale scan (superseded by a newer upload) is ignored, and
  // a mounted flag so a scan resolving after unmount doesn't setState.
  const scanSeq = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const validationErrors = useMemo(() => validateGenerator(config), [config]);

  const patchButtons = (next: GeneratorConfig['buttons']) => setConfig((c0) => ({ ...c0, buttons: next }));

  // Run the moderation scan for an accepted image in the background. Only a
  // clean result attaches the image (fail-closed); blocked/error/timeout surface
  // inline without touching a previously-scanned background.
  function runScan(img: BlockPendingImageInfo, seq: number) {
    withTimeout(scanBackground(img), scanTimeoutMs).then(
      (result) => {
        if (!mountedRef.current || seq !== scanSeq.current) return;
        if (result.status === 'scanned') {
          const ref: HeaderImageRef = { imageId: img.imageId, url: img.url };
          setScan({ phase: 'scanned' });
          setConfig((c0) => ({ ...c0, headerImageRef: ref }));
        } else {
          setScan({ phase: 'blocked', reason: result.reason });
        }
      },
      (e) => {
        if (!mountedRef.current || seq !== scanSeq.current) return;
        setScan({ phase: 'error', message: errMsg(e), img });
      },
    );
  }

  async function pickHeaderImage() {
    setBusy('bg');
    setError(null);
    let img: BlockPendingImageInfo | null;
    try {
      img = await uploadImage();
    } catch (e) {
      setError(errMsg(e));
      setBusy(null);
      return;
    }
    setBusy(null);
    // A cancelled/dismissed upload resolves null — handle gracefully (no-op):
    // leave any prior background + scan state untouched.
    if (!img) return;
    // Accepted → the host upload modal has auto-closed. Surface the scan inline
    // and let the user keep editing while it runs; DON'T persist yet.
    const seq = ++scanSeq.current;
    setScan({ phase: 'scanning', img });
    runScan(img, seq);
  }

  function retryScan() {
    if (scan.phase !== 'error') return;
    const { img } = scan;
    const seq = ++scanSeq.current;
    setScan({ phase: 'scanning', img });
    runScan(img, seq);
  }

  function removeHeaderImage() {
    scanSeq.current += 1; // cancel any in-flight scan
    setScan({ phase: 'idle' });
    setConfig((c0) => ({ ...c0, headerImageRef: undefined }));
  }

  async function doSave() {
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      await onSaveDraft(config);
      setNotice('Draft saved.');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function doPublish() {
    if (validationErrors.length > 0) return;
    setBusy('publish');
    setError(null);
    setNotice(null);
    try {
      await onPublish(config);
      setNotice('Published! Others can now find and run your generator.');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  const editor = (
    <Stack gap={16} data-testid="builder-editor">
      <div
        data-testid="builder-concept-hint"
        style={{ fontSize: 13, lineHeight: 1.5, color: c.muted }}
      >
        Each button below is a saved generation preset — a checkpoint, optional LoRAs, and a prompt
        template. Runners tap a button, type into your prompt box, and get that image.
      </div>
      <TextInput
        label="Generator name"
        required
        value={config.name}
        data-testid="gen-name"
        onChange={(e) => {
          const name = e.currentTarget.value;
          setConfig((c0) => ({ ...c0, name }));
        }}
      />
      <Textarea
        label="Description"
        minRows={2}
        value={config.description}
        data-testid="gen-description"
        onChange={(e) => {
          const description = e.currentTarget.value;
          setConfig((c0) => ({ ...c0, description }));
        }}
      />
      <TextInput
        label="Prompt box placeholder"
        description="Optional hint shown inside the runner's prompt box (e.g. “a fox in the snow”)."
        value={config.promptPlaceholder ?? ''}
        data-testid="gen-prompt-placeholder"
        onChange={(e) => {
          const promptPlaceholder = e.currentTarget.value;
          setConfig((c0) => ({ ...c0, promptPlaceholder }));
        }}
      />

      {/* cosmetic header/cover image */}
      <Card withBorder padding="md" data-testid="header-card">
        <Group justify="space-between">
          <div style={{ fontSize: 13 }}>
            <div style={{ fontWeight: 600 }}>Header image</div>
            <div style={{ color: c.muted }}>Cosmetic cover banner shown at the top of your generator — scanned + moderated because it's public.</div>
          </div>
          <Group gap={8}>
            {config.headerImageRef && (
              <Button
                variant="subtle"
                size="sm"
                color="error"
                data-testid="remove-header-image"
                onClick={removeHeaderImage}
              >
                Remove
              </Button>
            )}
            <Button variant="light" size="sm" data-testid="upload-header-image" loading={busy === 'bg'} onClick={pickHeaderImage}>
              {config.headerImageRef ? 'Replace' : 'Upload'}
            </Button>
          </Group>
        </Group>

        {/* Inline scan status — the upload modal auto-closes on accept and the
            scan resolves here in the background; only a Scanned image persists. */}
        {scan.phase === 'scanning' && (
          <Group gap={8} data-testid="header-scanning" data-scan-phase="scanning" style={{ marginTop: 10, alignItems: 'center' }}>
            {/* The in-flight thumbnail is dimmed to read as "pending / not yet
                applied" alongside the spinner. This `opacity` is a deliberate
                non-color affordance on an <img> (not opacity-muted text) — the
                one allowed exception to the zero-opacity token rule. */}
            <img
              src={scan.img.url}
              alt=""
              style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, opacity: 0.5 }}
            />
            <Loader size="sm" />
            <span style={{ fontSize: 13, color: c.muted }}>Scanning image… you can keep editing.</span>
          </Group>
        )}
        {scan.phase === 'scanned' && (
          <div data-testid="header-scanned" data-scan-phase="scanned" style={{ marginTop: 10 }}>
            <Badge color="success" size="sm">Scanned</Badge>
          </div>
        )}
        {scan.phase === 'blocked' && (
          <Alert color="error" title="Image blocked" data-testid="header-blocked" data-scan-phase="blocked" style={{ marginTop: 10 }}>
            {scan.reason ?? 'This image was rejected by moderation and was not used as your header.'}
          </Alert>
        )}
        {scan.phase === 'error' && (
          <Alert color="warning" title="Couldn't verify image" data-testid="header-scan-error" data-scan-phase="error" style={{ marginTop: 10 }}>
            <Group justify="space-between" style={{ alignItems: 'center' }}>
              <span>{scan.message}</span>
              <Button variant="light" size="sm" data-testid="retry-header-scan" onClick={retryScan}>
                Retry
              </Button>
            </Group>
          </Alert>
        )}

        {config.headerImageRef && (
          <SafeImage
            data-testid="header-preview"
            src={config.headerImageRef.url}
            alt="Generator header"
            style={{ marginTop: 10, width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 8 }}
          />
        )}
      </Card>

      {/* buttons */}
      <Stack gap={12}>
        {config.buttons.map((b, i) => (
          <ButtonEditor
            key={b.id}
            button={b}
            index={i}
            count={config.buttons.length}
            c={c}
            pickResource={pickResource}
            onChange={(patch) => patchButtons(updateButton(config.buttons, b.id, patch))}
            onMove={(dir) => patchButtons(moveButton(config.buttons, i, i + dir))}
            onRemove={() => patchButtons(config.buttons.filter((x) => x.id !== b.id))}
          />
        ))}
        <Button variant="light" data-testid="add-button" onClick={() => patchButtons([...config.buttons, newButton()])}>
          + Add button
        </Button>
      </Stack>

      {validationErrors.length > 0 && (
        <Alert color="warning" title="Fix before publishing" data-testid="validation-errors">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {validationErrors.map((e, i) => (
              // Index key: two buttons can produce the SAME error string (e.g. two
              // unlabelled buttons → identical "needs a label"), and a duplicate
              // `key={e}` silently drops all but the first from the list.
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
    </Stack>
  );

  const preview = (
    <Card withBorder padding="md" data-testid="builder-preview">
      <div style={{ fontSize: 12, color: c.muted, marginBottom: 10, fontWeight: 600 }}>Live preview</div>
      <Runner
        config={config}
        c={c}
        preview
        // Authoring surface: the author previews their OWN just-uploaded (and
        // fail-closed-moderated) cover, so the local in-session url is used here.
        // In Discover/Runner-of-published the banner is resolved from the
        // moderated `imageId` instead (see App/Runner `headerUrl`). NOTE: a cover
        // carried in from a FORKED generator is shown only to the forking author
        // in their own editor — recorded as an owed follow-up to imageId-resolve
        // the Builder preview too.
        headerUrl={config.headerImageRef?.url ?? null}
        canGenerate
        buzzBalance={null}
        onRequestConsent={noop}
        uploadSourceImage={previewNoUpload}
        estimate={previewSnapshot}
        submit={previewSnapshot}
        poll={previewSnapshot}
        onBack={noop}
      />
    </Card>
  );

  return (
    <Stack gap={16} data-testid="builder">
      <Group justify="space-between">
        <Button variant="subtle" size="sm" data-testid="builder-back" onClick={onBack}>
          ← Back
        </Button>
        <Group gap={8}>
          {isMobile && (
            <Button variant="subtle" size="sm" data-testid="toggle-preview" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? 'Hide preview' : 'Show preview'}
            </Button>
          )}
          <Button
            variant="light"
            size="sm"
            data-testid="save-draft"
            loading={busy === 'save'}
            onClick={doSave}
          >
            Save draft
          </Button>
          <Button
            size="sm"
            data-testid="publish"
            loading={busy === 'publish'}
            disabled={validationErrors.length > 0}
            onClick={doPublish}
          >
            Publish
          </Button>
        </Group>
      </Group>

      {error && (
        <Alert color="error" data-testid="builder-error">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert color="success" data-testid="builder-notice" withCloseButton onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      {isMobile ? (
        <Stack gap={16}>
          {editor}
          {showPreview && preview}
        </Stack>
      ) : (
        <div
          data-testid="builder-split"
          style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}
        >
          {editor}
          <div style={{ position: 'sticky', top: 12 }}>{preview}</div>
        </div>
      )}
    </Stack>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}
