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

/**
 * In-memory per-viewer KV store built to the HOST's list contract, not to a
 * convenient approximation of it.
 *
 * 🔴 THE PAGING BEHAVIOUR IS THE CONTRACT, AND A FAKE THAT IGNORES IT CAN ONLY
 * CONFIRM WHAT THE FAKE BELIEVES. This one mirrors civitai's `apps.router`
 * `storage.list` exactly:
 *   - `ORDER BY key` ascending, paging forward with `key > cursor`;
 *   - `cursor` / `nextCursor` are the base64 of a key;
 *   - `nextCursor` is emitted IF AND ONLY IF the page filled
 *     (`rows.length === limit`), so it means "there may be more", never "there
 *     is more".
 *
 * This used to ignore `limit` and `cursor` entirely and never emit a cursor — so
 * every DOM/integration test ran against a store with no horizon at all, and the
 * multi-page walk in `lib/runs.ts` was unobservable from them. `lib/runs.test.ts`
 * carried its own faithful copy; there is now one.
 */
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
      const after = opts?.cursor ? decodeStoreCursor(opts.cursor) : '';
      const limit = opts?.limit ?? 1000;
      const all = [...map.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
      const page = all.slice(0, limit);
      return {
        keys: page.map((key) => ({ key })),
        nextCursor:
          page.length === limit ? encodeStoreCursor(page[page.length - 1] as string) : undefined,
      };
    },
  };
}

/** base64 of a key, the shape the host's `storage.list` emits as `nextCursor`. */
function encodeStoreCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64');
}

function decodeStoreCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64').toString('utf8');
}

/** In-memory app-scoped shared store that records appends + in-place updates. */
export function fakeShared(
  seed: SharedListItem[] = [],
  opts: {
    failWithdraw?: string;
    /**
     * Make `list()` hand back a `nextCursor`, i.e. the board has MORE rows than
     * this page. The app reads ONE page and then ranks/filters inside it, so
     * this is the only way to express the case where "top" is a ranking over a
     * recency-limited window rather than over the board.
     */
    hasMore?: boolean;
  } = {},
) {
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
  /** Keys passed to `report`, with their reason — for asserting the abuse seam. */
  const reported: Array<{ key: string; reason?: string }> = [];
  const shared: UseSharedStorage = {
    async list() {
      return { items: [...items], ...(opts.hasMore ? { nextCursor: 'more' } : {}) };
    },
    async get(key) {
      return items.find((i) => i.key === key) ?? null;
    },
    async report(key, reason) {
      reported.push({ key, reason });
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
      items.unshift({ key, authorUserId: 99, value, count: 0, viewerVoted: false, createdAt: new Date(), updatedAt: new Date() });
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
  return { shared, appended, items, updated, withdrawn, reported, update };
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
