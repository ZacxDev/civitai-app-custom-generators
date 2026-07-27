// Shared test doubles (NOT a test file — no *.test suffix, so not collected).
// In-memory implementations of the injectable App deps so component/e2e tests
// drive the exact production App with canned picks/uploads/workflows/storage.

import type {
  BlockGenerationSourceImageInfo,
  BlockPendingImageInfo,
  BlockResourceInfo,
  BlockResourcePickerType,
  BlockUploadedImageInfo,
  BlockWorkflowSnapshot,
  WorkflowBody,
  WorkflowBodyTextToImage,
} from '@civitai/app-sdk/blocks';
import type { SharedAppendValue, SharedListItem, UseSharedStorage } from '@civitai/blocks-react';

import type { DraftStore } from './lib/drafts.js';

export const CKPT_INFO: BlockResourceInfo = {
  versionId: 1001,
  modelId: 500,
  modelName: 'DreamShaper',
  versionName: '8',
  baseModel: 'SD 1.5',
  modelType: 'Checkpoint',
};

export const LORA_INFO: BlockResourceInfo = {
  versionId: 2002,
  modelId: 900,
  modelName: 'Neon Glow',
  versionName: 'v2',
  baseModel: 'SD 1.5',
  modelType: 'LORA',
  strength: 0.8,
  minStrength: 0,
  maxStrength: 1.5,
  trainedWords: ['neon'],
};

/**
 * DISPLAY upload result — the MODERATED projection the host delivers as the
 * `'scanned'` verdict (and, via `createMockHost`'s `cannedImageUpload`, the
 * source for the pending handle's imageId/url). Used for the cosmetic public
 * background.
 */
export const UPLOADED_IMAGE: BlockUploadedImageInfo = {
  imageId: 424242,
  nsfwLevel: 1,
  contentRating: 'pg',
  url: 'https://image.civitai.com/uploaded.jpeg',
};

/**
 * DISPLAY upload EARLY-RESOLVE handle — what `useImageUpload({ asyncScan:true })
 * .open()` resolves with (image persisted, scan still in flight). Shares
 * `imageId`/`url` with {@link UPLOADED_IMAGE} so a `'scanned'` verdict persists a
 * `headerImageRef` with those same values.
 */
export const PENDING_IMAGE: BlockPendingImageInfo = {
  status: 'pending',
  imageId: UPLOADED_IMAGE.imageId,
  url: UPLOADED_IMAGE.url,
};

/**
 * generationSource (UNSCANNED) upload result — used for the img2img source.
 * Deliberately NON-square, NON-1024 dims so a test can prove the source image
 * carries the REAL returned `{ width, height }`, not a hardcoded 1024×1024.
 */
export const GENERATION_SOURCE_IMAGE: BlockGenerationSourceImageInfo = {
  url: 'https://image.civitai.com/source-input.jpeg',
  width: 832,
  height: 1216,
};

/** A picker that returns a canned pick per resource type (null = dismissed). */
export function cannedPicker(map: Partial<Record<BlockResourcePickerType, BlockResourceInfo | null>>) {
  return async ({ resourceType }: { resourceType: BlockResourcePickerType }) =>
    map[resourceType] ?? null;
}

/** In-memory per-viewer KV store implementing the DraftStore contract. */
export function memoryDraftStore(): DraftStore {
  const map = new Map<string, unknown>();
  return {
    async get(key) {
      return (map.has(key) ? map.get(key) : null) as never;
    },
    async set(key, value) {
      map.set(key, value);
      return { ok: true } as const;
    },
    async delete(key) {
      const had = map.has(key);
      map.delete(key);
      return { ok: true, deleted: had } as const;
    },
    async list(opts) {
      const prefix = opts?.prefix ?? '';
      return { keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

/** In-memory app-scoped shared store that records appends + in-place updates. */
export function fakeShared(seed: SharedListItem[] = [], opts: { failWithdraw?: string } = {}) {
  const items: SharedListItem[] = [...seed];
  const appended: SharedAppendValue[] = [];
  const updated: Array<{ key: string; value: SharedAppendValue }> = [];
  /** Keys passed to `withdraw`, in call order — for asserting the delete wiring. */
  const withdrawn: string[] = [];
  /** The injectable `updateSharedGenerator` seam — mutates the SAME row in place. */
  const update = async (key: string, value: SharedAppendValue): Promise<void> => {
    updated.push({ key, value });
    const idx = items.findIndex((i) => i.key === key);
    if (idx >= 0) items[idx] = { ...items[idx], value, updatedAt: new Date() };
  };
  const shared: UseSharedStorage = {
    async list() {
      return { items: [...items] };
    },
    async getCount() {
      return 0;
    },
    async getCounts() {
      return {};
    },
    async append(value) {
      appended.push(value);
      const key = `shared:${items.length}`;
      items.unshift({ key, authorUserId: 99, value, count: 0, createdAt: new Date(), updatedAt: new Date() });
      return { key };
    },
    update,
    async vote() {
      return 1;
    },
    async unvote() {
      return 0;
    },
    async withdraw(key) {
      withdrawn.push(key);
      if (opts.failWithdraw) throw new Error(opts.failWithdraw);
      const idx = items.findIndex((i) => i.key === key);
      const deleted = idx >= 0;
      if (deleted) items.splice(idx, 1); // mirror the host: the row is gone
      return { ok: true, deleted };
    },
  };
  return { shared, appended, items, updated, withdrawn, update };
}

export interface MockWorkflowOpts {
  cost?: number;
  images?: string[];
  /** Number of polls before succeeded (>=1). */
  polls?: number;
  /** When set, submit resolves to a failed snapshot with this error. */
  failSubmit?: string;
}

/** Capturing estimate/submit/poll triple with a deterministic poll sequence. */
export function mockWorkflow(opts: MockWorkflowOpts = {}) {
  // This app only ever builds the `textToImage` member of the WorkflowBody
  // discriminated union (app-sdk 0.26+), so record the captured bodies as that
  // member — lets tests assert on member-only fields (params/additionalResources
  // /sourceImage/sharedContentKey) without re-narrowing at every call site.
  const calls = { estimate: [] as WorkflowBodyTextToImage[], submit: [] as WorkflowBodyTextToImage[] };
  const polls = opts.polls ?? 1;
  let pollCount = 0;

  const estimate = async (body: WorkflowBody): Promise<BlockWorkflowSnapshot> => {
    calls.estimate.push(body as WorkflowBodyTextToImage);
    return { workflowId: 'wf', status: 'pending', cost: { total: opts.cost ?? 10 } };
  };
  const submit = async (body: WorkflowBody): Promise<BlockWorkflowSnapshot> => {
    calls.submit.push(body as WorkflowBodyTextToImage);
    pollCount = 0;
    if (opts.failSubmit) return { workflowId: 'wf', status: 'failed', error: opts.failSubmit };
    return { workflowId: 'wf', status: 'pending' };
  };
  const poll = async (): Promise<BlockWorkflowSnapshot> => {
    pollCount += 1;
    if (pollCount >= polls) return { workflowId: 'wf', status: 'succeeded', imageUrls: opts.images ?? ['https://image.civitai.com/out.jpeg'] };
    return { workflowId: 'wf', status: 'processing' };
  };
  return { calls, estimate, submit, poll };
}

export const immediateSleep = () => Promise.resolve();
