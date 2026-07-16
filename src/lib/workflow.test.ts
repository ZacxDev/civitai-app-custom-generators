import { describe, expect, it, vi } from 'vitest';
import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import { isTerminalSnapshot, mapSnapshotStatus, pollToTerminal } from './workflow.js';

const snap = (status: BlockWorkflowSnapshot['status'], extra: Partial<BlockWorkflowSnapshot> = {}): BlockWorkflowSnapshot => ({
  workflowId: 'wf1',
  status,
  ...extra,
});

describe('mapSnapshotStatus', () => {
  it('maps host statuses to queue statuses', () => {
    expect(mapSnapshotStatus('pending')).toBe('submitting');
    expect(mapSnapshotStatus('processing')).toBe('processing');
    expect(mapSnapshotStatus('succeeded')).toBe('succeeded');
    expect(mapSnapshotStatus('failed')).toBe('failed');
    expect(mapSnapshotStatus('expired')).toBe('failed');
    expect(mapSnapshotStatus('canceled')).toBe('canceled');
  });
});

describe('isTerminalSnapshot', () => {
  it('recognises terminal states', () => {
    expect(isTerminalSnapshot('succeeded')).toBe(true);
    expect(isTerminalSnapshot('failed')).toBe(true);
    expect(isTerminalSnapshot('canceled')).toBe(true);
    expect(isTerminalSnapshot('expired')).toBe(true);
    expect(isTerminalSnapshot('processing')).toBe(false);
    expect(isTerminalSnapshot('pending')).toBe(false);
  });
});

describe('pollToTerminal', () => {
  it('polls until a terminal snapshot and reports each update', async () => {
    const seq = [snap('processing'), snap('processing'), snap('succeeded', { imageUrls: ['a.jpg'] })];
    let i = 0;
    const poll = vi.fn(async () => seq[i++]);
    const updates: BlockWorkflowSnapshot[] = [];
    const terminal = await pollToTerminal(poll, snap('pending'), {
      sleep: () => Promise.resolve(),
      delayMs: 0,
      onUpdate: (s) => updates.push(s),
    });
    expect(terminal.status).toBe('succeeded');
    expect(terminal.imageUrls).toEqual(['a.jpg']);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(updates).toHaveLength(3);
  });

  it('returns immediately when the first snapshot is already terminal', async () => {
    const poll = vi.fn();
    const terminal = await pollToTerminal(poll, snap('succeeded'), { sleep: () => Promise.resolve() });
    expect(terminal.status).toBe('succeeded');
    expect(poll).not.toHaveBeenCalled();
  });

  it('stops at maxPolls (the safety valve) to avoid an infinite loop', async () => {
    const poll = vi.fn(async () => snap('processing'));
    const terminal = await pollToTerminal(poll, snap('processing'), {
      sleep: () => Promise.resolve(),
      delayMs: 0,
      maxPolls: 3,
    });
    expect(terminal.status).toBe('processing');
    expect(poll).toHaveBeenCalledTimes(3);
  });

  // Regression: the OLD window was maxPolls=60 × delayMs=800 ≈ 48s. A real
  // img2img:edit gen (user 8753561, wf 8753561-20260715202132664) took ~146s and
  // SUCCEEDED, but the app stopped polling at ~48s and lost the result. The
  // window must now span minutes, so a workflow that only terminates well past
  // the old cap still resolves to its result.
  it('resolves a slow workflow that terminates long after the old ~48s / 60-poll cap', async () => {
    const succeedAtPoll = 90; // > the retired 60-poll cap
    let i = 0;
    const poll = vi.fn(async () =>
      ++i >= succeedAtPoll ? snap('succeeded', { imageUrls: ['edit.jpg'] }) : snap('processing'),
    );
    const terminal = await pollToTerminal(poll, snap('pending'), {
      sleep: () => Promise.resolve(),
      delayMs: 0, // deterministic: no elapsed-time budget consumed
      maxDurationMs: 10 * 60 * 1000,
    });
    expect(terminal.status).toBe('succeeded');
    expect(terminal.imageUrls).toEqual(['edit.jpg']);
    expect(poll).toHaveBeenCalledTimes(succeedAtPoll);
  });

  it('gives up on maxDurationMs while still processing and returns the LAST non-terminal snapshot (keeps workflowId)', async () => {
    const poll = vi.fn(async () => snap('processing'));
    const terminal = await pollToTerminal(poll, snap('processing'), {
      sleep: () => Promise.resolve(),
      delayMs: 10,
      maxDelayMs: 10, // no backoff → 10ms/poll
      maxDurationMs: 50, // guard `elapsed < 50` checked before each poll → 5 polls
    });
    expect(isTerminalSnapshot(terminal.status)).toBe(false);
    expect(terminal.status).toBe('processing');
    expect(terminal.workflowId).toBe('wf1');
    expect(poll).toHaveBeenCalledTimes(5);
  });

  it('backs off the poll delay up to maxDelayMs', async () => {
    const waits: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      waits.push(ms);
    });
    let i = 0;
    const poll = vi.fn(async () => (++i >= 5 ? snap('succeeded') : snap('processing')));
    await pollToTerminal(poll, snap('pending'), {
      sleep,
      delayMs: 1000,
      maxDelayMs: 4000,
      maxDurationMs: 10 * 60 * 1000,
    });
    // 1000 → 1500 → 2250 → 3375 → capped at 4000
    expect(waits).toEqual([1000, 1500, 2250, 3375, 4000]);
  });
});
