// The App Blocks DOCUMENT STORE, as this app reaches it: `app.storage.collection(name)`
// over `/api/v1/blocks/storage/*` (`@civitai/sdk` 0.14+), and the two collections the
// manifest declares.
//
// 🔴 THE COLLECTION NAMES AND SHAPES ARE A CONTRACT WITH SOMETHING OUTSIDE THIS REPO.
// Existing viewers' data is copied out of the legacy stores by a separate, hand-run
// step at go-live, and that copy writes exactly what `appStorage.ts` and
// `sharedStorage.ts` read. `block.manifest.json` → `storage.collections` must keep
// declaring exactly these two, and `src/manifest.test.ts` pins that declaration
// literally.

import { StorageError } from '@civitai/sdk';
import type { DocumentStorage } from '@civitai/sdk';

import { getClient } from './client.js';

/** The viewer's private key/value collection (`visibility: "private"`). */
export const KV_COLLECTION = 'kv';
/** The shared board of published generators (`visibility: "shared"`, `write: "own"`, `marks: ["vote"]`). */
export const RECORDS_COLLECTION = 'records';

/**
 * The store's hard page ceiling (`limits.listLimitMax`). 🔴 A LARGER `limit` IS
 * REFUSED `invalid_request`, NOT CLAMPED — measured against the SDK's contract fake
 * — so every list in this app clamps to it before sending.
 */
export const DOC_LIST_LIMIT_MAX = 100;

/** The document store, bound to the initialised client. */
export async function getDocStorage(): Promise<DocumentStorage> {
  const app = await getClient();
  return app.storage;
}

/**
 * How a `rate_limited` refusal is retried in place: at most {@link maxRetries}
 * more attempts, and only when the store names a wait no longer than
 * {@link maxWaitSeconds}.
 *
 * 🔴 BOUNDED IN BOTH DIRECTIONS ON PURPOSE. The store answers two kinds of 429 and
 * they want opposite handling. `details.reason: "contention"` (other writes to the
 * same documents) clears in a second or two and is safe to retry. A spent viewer
 * window — reads 300/min, private writes 120/min — names `Retry-After: 60`, and
 * parking a viewer's click for a minute behind a spinner is worse than telling
 * them; so a long wait rejects straight away and the caller renders its copy.
 */
export interface RateLimitRetryPolicy {
  maxRetries: number;
  maxWaitSeconds: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RATE_LIMIT_RETRY: RateLimitRetryPolicy = {
  maxRetries: 2,
  maxWaitSeconds: 5,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Is `err` the store's 429? */
export function isRateLimited(err: unknown): err is StorageError {
  return err instanceof StorageError && err.code === 'rate_limited';
}

/**
 * Run `op`, retrying a short `rate_limited` refusal within `policy`. Every other
 * failure, and a 429 past the policy, rejects unchanged.
 *
 * 🔴 ONLY FOR OPERATIONS THAT ARE SAFE TO REPEAT: reads, a private `put` of a
 * whole value, a `delete`. A shared `create` is NOT routed through this — a 429 on
 * it means the author's shared-write budget is spent (a refill every six minutes),
 * which no in-place retry outlasts.
 */
export async function withRateLimitRetry<T>(
  op: () => Promise<T>,
  policy: RateLimitRetryPolicy = DEFAULT_RATE_LIMIT_RETRY,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      if (!isRateLimited(err) || attempt >= policy.maxRetries) throw err;
      const wait = err.retryAfter ?? 1;
      if (wait > policy.maxWaitSeconds) throw err;
      await policy.sleep(Math.max(0, wait) * 1000);
    }
  }
}
