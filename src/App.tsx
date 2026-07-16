// Custom Generators — top-level full-page app.
//
// Owns every SDK hook (block context/token, resource picker, image upload,
// generation-resource rehydrate, the Buzz workflow money path, shared + per-user
// storage, consent) and routes between three screens: Browse → Builder / Runner.
// The hooks are collapsed into an injectable `deps` bag so component + e2e tests
// can drive the exact same App with canned picks/uploads/workflows, OR against
// the real SDK mock host.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BlockGenerationSourceImageInfo,
  BlockPendingImageInfo,
  BlockResourceInfo,
  BlockResourcePickerType,
  BlockWorkflowSnapshot,
  WorkflowBody,
} from '@civitai/app-sdk/blocks';

import {
  useBlockContext,
  useBlockResize,
  useBlockToken,
  useBuzzBalance,
  useBuzzWorkflow,
  useGenerationResources,
  useImageUpload,
  useRequestConsent,
  useRequestSignIn,
  useResourcePicker,
  useSharedStorage,
  useAppStorage,
} from '@civitai/blocks-react';
import type { SharedAppendValue, SharedListItem, UseSharedStorage } from '@civitai/blocks-react';

import { AI_WRITE_BUDGETED, hasGenerateScope } from './scopes.js';
import { palette, pageStyle, contentStyle } from './theme.js';
import type { BackgroundScanResult, GeneratorConfig } from './types.js';
import { newGenerator, newId } from './lib/generator.js';
import {
  buildPublishPayload,
  collectVersionIds,
  parsePublishedGenerator,
  rehydrateConfig,
} from './lib/generator.js';
import type { DraftStore, StoredDraft } from './lib/drafts.js';
import { deleteDraft as deleteDraftFn, listDrafts, saveDraft as saveDraftFn } from './lib/drafts.js';
import { Browse } from './components/Browse.js';
import { Builder } from './components/Builder.js';
import { Runner } from './components/Runner.js';

export interface AppDeps {
  pickResource: (opts: {
    resourceType: BlockResourcePickerType;
    baseModelGroup?: string;
  }) => Promise<BlockResourceInfo | null>;
  /**
   * DISPLAY upload → an EARLY-RESOLVE pending handle (`{ status:'pending',
   * imageId, url }`): the image is persisted (imageId known) and the host modal
   * has auto-closed, but the moderation scan is still in flight. Used for the
   * cosmetic background (shown to other users); the verdict arrives async via
   * `scanBackground(handle)` and only a `'scanned'` verdict is ever persisted.
   */
  uploadImage: () => Promise<BlockPendingImageInfo | null>;
  /**
   * Resolve the moderation SCAN outcome for the pending DISPLAY background handle
   * returned by `uploadImage()`, AFTER the host modal auto-closed. Lets the
   * builder show inline scan status (scanning → scanned/blocked) WITHOUT blocking
   * the user, and gates persistence fail-closed (only `'scanned'` attaches).
   *
   * Default (see `deps` below): subscribes to the host's async scan verdict via
   * `useImageUpload({ asyncScan: true }).scanStatus(handle)` — re-callable to
   * retry a transient error/timeout.
   */
  scanBackground: (img: BlockPendingImageInfo) => Promise<BackgroundScanResult>;
  /** Fail the inline background scan with a timeout after this long (test seam). */
  bgScanTimeoutMs?: number;
  /**
   * generationSource upload → an UNSCANNED private img2img source image
   * (`{ url, width, height }`; the orchestrator scans it at gen time). Used only
   * for the Runner's img2img source, never for the public background.
   */
  uploadSourceImage: () => Promise<BlockGenerationSourceImageInfo | null>;
  resolveResources: (ids: number[]) => Promise<BlockResourceInfo[]>;
  estimate: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  submit: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  poll: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
  shared: UseSharedStorage;
  /**
   * In-place UPDATE of an already-published shared generator (same key, no new
   * row). Kept as an injectable seam so the edit-in-place publish logic is fully
   * built + tested now; the real host wiring (`useSharedStorage().update`) lands
   * with @civitai/blocks-react 0.24 — see the App-level TODO.
   */
  updateSharedGenerator: (key: string, value: SharedAppendValue) => Promise<void>;
  drafts: DraftStore;
  requestConsent: (opts: { scopes: string[] }) => void;
  requestSignIn: () => void;
  /** Test seams for the poll loop. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AppProps {
  /** Override any hook-backed dependency (component + e2e test seam). */
  deps?: Partial<AppDeps>;
}

type View = 'browse' | 'builder' | 'runner';

interface EditTarget {
  id: string;
  config: GeneratorConfig;
  publishedKey?: string;
}

interface RunTarget {
  config: GeneratorConfig;
  sharedContentKey?: string;
}

export function App({ deps: depsOverride }: AppProps = {}) {
  const { ready, viewer, theme } = useBlockContext();
  const token = useBlockToken();
  const picker = useResourcePicker();
  // Two purpose-typed upload seams: the moderated DISPLAY upload for the public
  // cosmetic background, and the UNSCANNED generationSource upload for the
  // img2img source image (real intrinsic dims, orchestrator-scanned at gen time).
  const imageUpload = useImageUpload({ asyncScan: true });
  const sourceUpload = useImageUpload({ purpose: 'generationSource' });
  const genResources = useGenerationResources();
  const workflow = useBuzzWorkflow();
  const sharedHook = useSharedStorage();
  const appStorage = useAppStorage();
  const buzz = useBuzzBalance();
  const { requestConsent } = useRequestConsent();
  const { requestSignIn } = useRequestSignIn();

  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  const c = palette(theme !== 'light');

  // Assemble the dependency bag (hooks by default; tests override any field).
  const deps: AppDeps = useMemo(
    () => ({
      pickResource: picker.open,
      uploadImage: imageUpload.open,
      // The display upload now EARLY-RESOLVES with a pending handle and the scan
      // verdict streams in async. Subscribe to it via scanStatus and map the
      // host verdict onto the app's fail-closed BackgroundScanResult: 'scanned'
      // persists, 'blocked' rejects inline, any transient error/timeout throws →
      // the app's 'error' phase + Retry (scanStatus is re-callable).
      scanBackground: async (h) => {
        const r = await imageUpload.scanStatus(h);
        if (r.status === 'scanned') return { status: 'scanned' };
        if (r.status === 'blocked') return { status: 'blocked', reason: r.reason };
        throw new Error(r.message ?? 'Image scan failed');
      },
      uploadSourceImage: sourceUpload.open,
      resolveResources: genResources.fetch,
      estimate: workflow.estimate,
      submit: workflow.submit,
      poll: workflow.poll,
      shared: sharedHook,
      // In-place UPDATE of the viewer's own published generator (same key, no new
      // row) — the fix for "editing creates a new one". `update` takes the same
      // `{ title, body?, data? }` shape `buildPublishPayload` produces for append,
      // is author-scoped, and reuses the `apps:storage:shared:write` scope.
      updateSharedGenerator: sharedHook.update,
      drafts: appStorage as unknown as DraftStore,
      requestConsent,
      requestSignIn,
      ...depsOverride,
    }),
    // The hook objects are stable across renders (SDK contract); depsOverride is
    // fixed per test. Intentionally not spreading identities into the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [depsOverride],
  );
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const canGenerate = hasGenerateScope(token.scopes);

  // ---- view state ----
  const [view, setView] = useState<View>('browse');
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [running, setRunning] = useState<RunTarget | null>(null);

  // ---- browse data ----
  const [shared, setShared] = useState<SharedListItem[]>([]);
  const [myDrafts, setMyDrafts] = useState<StoredDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!ready || view !== 'browse') return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [sharedRes, drafts] = await Promise.all([
          depsRef.current.shared.list({ limit: 50 }),
          viewer ? listDrafts(depsRef.current.drafts) : Promise.resolve<StoredDraft[]>([]),
        ]);
        if (cancelled) return;
        setShared(sharedRes.items);
        setMyDrafts(drafts);
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, view, viewer, reloadKey]);

  const myPublished = useMemo(
    () => (viewer ? shared.filter((s) => s.authorUserId === viewer.id) : []),
    [shared, viewer],
  );

  // ---- navigation ----
  const openBuilderNew = useCallback(() => {
    setEditing({ id: newId('gen'), config: newGenerator() });
    setView('builder');
  }, []);

  const openBuilderEdit = useCallback((draft: StoredDraft) => {
    setEditing({ id: draft.id, config: draft.config, publishedKey: draft.publishedKey });
    setView('builder');
  }, []);

  const openConfig = useCallback(async (config: GeneratorConfig, sharedContentKey?: string) => {
    let resolved = config;
    try {
      const ids = collectVersionIds(config);
      if (ids.length > 0) {
        const infos = await depsRef.current.resolveResources(ids);
        resolved = rehydrateConfig(config, infos);
      }
    } catch {
      // Rehydration is best-effort — open with the stored (already-named) config.
    }
    setRunning({ config: resolved, sharedContentKey });
    setView('runner');
  }, []);

  const openPublished = useCallback(
    (item: SharedListItem) => {
      const config = parsePublishedGenerator(item.value);
      if (!config) {
        setError('This generator could not be opened (unrecognised format).');
        return;
      }
      void openConfig(config, item.key);
    },
    [openConfig],
  );

  const openDraft = useCallback(
    (draft: StoredDraft) => {
      void openConfig(draft.config, draft.publishedKey);
    },
    [openConfig],
  );

  const backToBrowse = useCallback(() => {
    setView('browse');
    setEditing(null);
    setRunning(null);
    reload();
  }, [reload]);

  // ---- persistence ----
  const persistDraft = useCallback(
    async (config: GeneratorConfig, publishedKey?: string): Promise<StoredDraft> => {
      const target = editing;
      const draft: StoredDraft = {
        id: target?.id ?? newId('gen'),
        config,
        updatedAt: Date.now(),
        publishedKey: publishedKey ?? target?.publishedKey,
      };
      await saveDraftFn(depsRef.current.drafts, draft);
      setEditing((e) => (e ? { ...e, config, publishedKey: draft.publishedKey } : e));
      return draft;
    },
    [editing],
  );

  const handleSaveDraft = useCallback(
    async (config: GeneratorConfig) => {
      await persistDraft(config);
      reload();
    },
    [persistDraft, reload],
  );

  const handlePublish = useCallback(
    async (config: GeneratorConfig) => {
      // Draft first (so it lands in "My generators" even if the publish fails) —
      // upserts the SAME draft id, carrying any existing publishedKey.
      const draft = await persistDraft(config);
      const payload = buildPublishPayload(config);
      if (draft.publishedKey) {
        // Already published → UPDATE the same shared row in place. This is the
        // fix for "editing creates a new one": never append a duplicate.
        await depsRef.current.updateSharedGenerator(draft.publishedKey, payload);
      } else {
        // First publish → append, then remember the minted key on the draft so a
        // future edit updates in place instead of duplicating.
        const { key } = await depsRef.current.shared.append(payload);
        await persistDraft(config, key);
      }
      reload();
    },
    [persistDraft, reload],
  );

  const handleDeleteDraft = useCallback(
    async (draft: StoredDraft) => {
      await deleteDraftFn(depsRef.current.drafts, draft.id);
      reload();
    },
    [reload],
  );

  // Withdraw one of the viewer's OWN published generators (the shared_kv row).
  // Optimistically drop it from the list, then call `withdraw(key)`; on failure
  // restore the list and surface the host error. A local draft that pointed at
  // this row keeps its config but is unlinked (the published copy is gone).
  const handleDeletePublished = useCallback(async (item: SharedListItem) => {
    let prev: SharedListItem[] = [];
    setShared((list) => {
      prev = list;
      return list.filter((s) => s.key !== item.key);
    });
    setError(null);
    try {
      await depsRef.current.shared.withdraw(item.key);
    } catch (e) {
      setShared(prev); // rollback the optimistic removal
      setError(errMsg(e));
    }
  }, []);

  const requestGenerateConsent = useCallback(() => {
    if (!viewer) {
      deps.requestSignIn();
      return;
    }
    deps.requestConsent({ scopes: [AI_WRITE_BUDGETED] });
  }, [viewer, deps]);

  const buzzTotal =
    buzz.balance != null ? buzz.balance.blue + buzz.balance.green + buzz.balance.yellow : null;

  // ---- render ----
  if (!ready) {
    return (
      <div ref={rootRef} data-theme={theme} style={pageStyle(c)}>
        <div style={{ margin: 'auto', opacity: 0.7 }} data-testid="app-loading">
          Loading Custom Generators…
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} data-theme={theme} style={pageStyle(c)}>
      <div style={contentStyle}>
        {view === 'browse' && (
          <Browse
            c={c}
            loading={loading}
            error={error}
            discover={shared}
            myDrafts={myDrafts}
            myPublished={myPublished}
            viewerId={viewer?.id ?? null}
            onCreate={openBuilderNew}
            onOpenPublished={openPublished}
            onOpenDraft={openDraft}
            onEditDraft={openBuilderEdit}
            onDeleteDraft={handleDeleteDraft}
            onDeletePublished={handleDeletePublished}
            onRetry={reload}
          />
        )}

        {view === 'builder' && editing && (
          <Builder
            initial={editing.config}
            c={c}
            pickResource={deps.pickResource}
            uploadImage={deps.uploadImage}
            scanBackground={deps.scanBackground}
            scanTimeoutMs={deps.bgScanTimeoutMs}
            onSaveDraft={handleSaveDraft}
            onPublish={handlePublish}
            onBack={backToBrowse}
          />
        )}

        {view === 'runner' && running && (
          <Runner
            config={running.config}
            sharedContentKey={running.sharedContentKey}
            c={c}
            canGenerate={canGenerate}
            buzzBalance={buzzTotal}
            onRequestConsent={requestGenerateConsent}
            uploadSourceImage={deps.uploadSourceImage}
            estimate={deps.estimate}
            submit={deps.submit}
            poll={deps.poll}
            onBack={backToBrowse}
            pollIntervalMs={deps.pollIntervalMs}
            sleep={deps.sleep}
          />
        )}
      </div>
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}
