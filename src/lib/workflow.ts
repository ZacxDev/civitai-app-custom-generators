// Runner-side workflow orchestration helpers (pure + injectable). The Runner
// component owns the estimate → confirm → submit → poll dance; these functions
// map the host snapshot into the app's queue-item status and drive the poll
// loop with an injectable clock so the loop is deterministically testable.

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import type { QueueStatus } from '../types.js';

const TERMINAL: ReadonlySet<BlockWorkflowSnapshot['status']> = new Set([
  'succeeded',
  'failed',
  'expired',
  'canceled',
]);

export function isTerminalSnapshot(status: BlockWorkflowSnapshot['status']): boolean {
  return TERMINAL.has(status);
}

/**
 * Human-readable label for a queue item's status. The raw machine tokens
 * (`estimating`/`confirming`/`submitting`/`processing`) leak implementation
 * detail and read as jargon in the status pill — this maps each to plain
 * language the runner understands. The raw token still rides on the card's
 * `data-status` attribute for tests/automation.
 */
export function queueStatusLabel(status: QueueStatus): string {
  switch (status) {
    case 'estimating':
      return 'Estimating…';
    case 'confirming':
      return 'Waiting for you to confirm';
    case 'submitting':
      return 'Submitting…';
    case 'processing':
      return 'Generating…';
    case 'stalled':
      return 'Still generating…';
    case 'succeeded':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'canceled':
      return 'Canceled';
    default:
      return status;
  }
}

/** Map a host workflow snapshot status → the app's queue-item status. */
export function mapSnapshotStatus(status: BlockWorkflowSnapshot['status']): QueueStatus {
  switch (status) {
    case 'pending':
      return 'submitting';
    case 'processing':
      return 'processing';
    case 'succeeded':
      return 'succeeded';
    case 'canceled':
      return 'canceled';
    case 'failed':
    case 'expired':
    default:
      return 'failed';
  }
}

export interface PollOptions {
  /** Called after every poll with the fresh snapshot (for UI updates). */
  onUpdate?: (snap: BlockWorkflowSnapshot) => void;
  /** Injectable clock — tests pass an immediate resolver. */
  sleep?: (ms: number) => Promise<void>;
  /** Initial delay between polls (ms). Backs off up to `maxDelayMs`. */
  delayMs?: number;
  /** Upper bound for the (backing-off) delay between polls (ms). */
  maxDelayMs?: number;
  /**
   * Total time to keep polling a NON-terminal workflow before giving up (ms).
   * This is the PRIMARY bound — generations (esp. `img2img:edit` / queued
   * OpenAI gens) routinely run well past a minute, so this must be generous.
   * Time is accounted from the injected delays (deterministic under tests).
   */
  maxDurationMs?: number;
  /**
   * Safety ceiling on the number of polls so a mis-injected zero delay can't
   * spin forever. In production `maxDurationMs` is the real bound; this only
   * bites in degenerate (delay-less) test setups.
   */
  maxPolls?: number;
}

/** Initial poll interval — a couple seconds is responsive without hammering. */
export const DEFAULT_DELAY_MS = 2000;
/** Backoff ceiling — never wait longer than this between polls. */
export const DEFAULT_MAX_DELAY_MS = 5000;
/** ~10 minutes: long enough for slow edit / queued generations to terminate. */
export const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;
/** Pure safety valve (see `maxPolls`); duration is the real bound. */
export const DEFAULT_MAX_POLLS = 1000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll a just-submitted workflow to a terminal state. Returns the terminal
 * snapshot, OR — if the duration/poll cap trips while the workflow is still
 * pending/processing — the last NON-terminal snapshot (the caller must detect
 * this via `isTerminalSnapshot` and surface a "still generating" state rather
 * than a blank/failed one; the snapshot still carries the live `workflowId`).
 * Never throws for a `failed` snapshot — the caller inspects `.status` /
 * `.error`.
 */
export async function pollToTerminal(
  poll: (workflowId: string) => Promise<BlockWorkflowSnapshot>,
  first: BlockWorkflowSnapshot,
  opts: PollOptions = {},
): Promise<BlockWorkflowSnapshot> {
  const sleep = opts.sleep ?? defaultSleep;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const maxDelayMs = Math.max(delayMs, opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const maxPolls = opts.maxPolls ?? DEFAULT_MAX_POLLS;

  let cur = first;
  let elapsedMs = 0;
  let polls = 0;
  let wait = delayMs;
  while (!isTerminalSnapshot(cur.status) && elapsedMs < maxDurationMs && polls < maxPolls) {
    await sleep(wait);
    elapsedMs += wait;
    cur = await poll(cur.workflowId);
    opts.onUpdate?.(cur);
    polls += 1;
    // Modest backoff so a long generation doesn't hammer the poll endpoint.
    wait = Math.min(Math.round(wait * 1.5), maxDelayMs);
  }
  return cur;
}
