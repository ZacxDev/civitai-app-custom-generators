// ReportButton — carried from `@civitai/blocks-react/ui`. The design system has
// no equivalent, in either the React bindings or the custom elements, so this is
// a local re-implementation rather than a rebind.
//
// 🔴 THE VISIBLE COPY IS CARRIED VERBATIM, AND THAT IS THE POINT OF THE
// COMPONENT. `report()` files a row for moderator review and does NOT hide it —
// so the confirm question, the failure line and the settled line each have to
// avoid implying a deletion. Those three strings, the two `aria-label`s and the
// five `data-testid` suffixes are reproduced exactly as the pack rendered them,
// because this app's Browse suites assert on them and because a reworded
// confirm is a different promise to the viewer. Do not "improve" the wording
// here.
//
// The attempt-token logic below is carried for the same reason — it is not
// defensive code, it is the fix for three real defects the pack's own comments
// record: a superseded request settling the control after the viewer cancelled,
// a stale failure resurfacing against a settled row, and a superseded attempt
// clearing the shared `busy` flag so Confirm re-enabled mid-flight and filed one
// row three times. `report()` is not documented idempotent, so a duplicate file
// is a real write.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Button, Group } from './primitives.js';
import { useBlocksStyles } from './styles.js';

/** Shared by the two text renders so they cannot drift apart. */
const NOTE_STYLE: CSSProperties = {
  whiteSpace: 'nowrap',
  fontSize: 12,
  lineHeight: 1.45,
  color: 'var(--civitai-color-text-dimmed)',
};

export interface ReportButtonProps {
  /**
   * What the row is, lower-case and singular — "generator", "prompt". Appears in
   * the confirm question and in both accessible names.
   *
   * 🔴 It is spliced into an `aria-label`, so it is NOT a place for arbitrary
   * text: a sentence here becomes the control's accessible name. Pass a bare noun.
   */
  noun: string;
  /**
   * Files the report. Fires ONLY after the viewer confirms. Reject to surface the
   * failure — a rejected report keeps the control armed rather than settling,
   * because one that closed quietly would read as filed.
   */
  onReport: () => Promise<void>;
  /**
   * This viewer has ALREADY reported this row. Renders the settled state directly
   * and skips the handshake.
   *
   * 🔴 THE SHARED STORE CANNOT TELL YOU THIS. `SharedListItem` carries
   * `viewerVoted` and has no report equivalent, so the only source is this app's
   * own per-viewer storage, recorded when `onReport` resolves. Without it the
   * settled state is local-only, so any remount resets the control to "Report"
   * and the same viewer can file the same row again.
   */
  reported?: boolean;
  /**
   * Test hook for the TRIGGER. The other four are DERIVED from it by suffix, so
   * two rows in one list stay distinguishable: `-confirm`, `-cancel`, `-done`,
   * `-prompt`.
   *
   * 🔴 Grep for the SUFFIX, never the composed value: a composed testid appears
   * nowhere in source as a literal.
   */
  'data-testid'?: string;
}

export function ReportButton({
  noun,
  onReport,
  reported = false,
  'data-testid': testId,
}: ReportButtonProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const doneRef = useRef<HTMLSpanElement | null>(null);

  /**
   * Monotonic id of the CURRENT attempt. Every settle compares against it and
   * no-ops if it has moved on.
   *
   * 🔴 A single "abandoned" BOOLEAN is not enough: reset at the top of each
   * attempt it protects exactly one abandoned request and only until the next
   * confirm, so cancel → re-arm → confirm let the FIRST request settle the
   * control and, on the rejecting path, clear the shared `busy` so Confirm
   * re-enabled mid-flight. An id per attempt cannot do that — anything that ends
   * an attempt bumps it, and a superseded settle is inert.
   */
  const attemptRef = useRef(0);
  const settled = done || reported;

  useBlocksStyles();

  const ids = testId
    ? {
        trigger: testId,
        confirm: `${testId}-confirm`,
        cancel: `${testId}-cancel`,
        done: `${testId}-done`,
        prompt: `${testId}-prompt`,
      }
    : {
        trigger: 'report-button',
        confirm: 'report-confirm',
        cancel: 'report-cancel',
        done: 'report-done',
        prompt: 'report-confirm-prompt',
      };

  // 🔴 Move focus with the control, at BOTH transitions. Each step replaces the
  // element the viewer just activated, so without this a keyboard user is
  // dropped to <body> and must Tab from the top of the document.
  //
  // 🔴 Keyed on `confirming` ALONE, deliberately. Keying it on `busy` too meant
  // the effect re-fired when a request finished, so a viewer who pressed Confirm
  // and then moved focus elsewhere had it YANKED BACK on rejection.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  // 🔴 Confirm carries `loading`, which sets the native `disabled`, so the
  // browser BLURS it the moment a request starts. Move focus to Cancel — which
  // stays enabled precisely so the in-flight state has a live control — or the
  // viewer is dropped to <body> with nothing tabbable.
  useEffect(() => {
    if (busy) cancelRef.current?.focus();
  }, [busy]);

  // 🔴 Server truth ENDS the handshake rather than hiding it. Without this the
  // strip stays mounted underneath: a later `reported: false` resurrected a stale
  // "Could not send" against a control the viewer had seen settle, and a
  // rejection arriving after the flip landed behind an unmounted strip.
  //
  // Bumping the attempt is not redundant with clearing `busy`/`failed`: the
  // attempt is superseded, so its `finally` never clears the shared `busy` and
  // its rejection never clears `failed`. Re-arm and you get Confirm disabled with
  // a spinner, or "Could not send" for a report never submitted in that attempt.
  useEffect(() => {
    if (reported) {
      attemptRef.current += 1;
      setConfirming(false);
      setFailed(false);
      setBusy(false);
    }
  }, [reported]);

  if (settled) {
    return (
      <span
        ref={doneRef}
        tabIndex={-1}
        data-testid={ids.done}
        role="status"
        style={{ ...NOTE_STYLE, outline: 'none' }}
      >
        Reported for review
      </span>
    );
  }

  if (!confirming) {
    return (
      <Button
        size="sm"
        variant="subtle"
        onClick={() => setConfirming(true)}
        data-testid={ids.trigger}
        aria-label={`Report this ${noun} to moderators`}
      >
        Report
      </Button>
    );
  }

  const confirm = async () => {
    const attempt = (attemptRef.current += 1);
    /** This attempt is still the one on screen. */
    const current = () => attemptRef.current === attempt;
    setBusy(true);
    setFailed(false);
    try {
      await onReport();
      // 🔴 Superseded — the viewer cancelled, or the parent settled us. Settling
      // here would report an action this viewer withdrew from.
      if (!current()) return;
      setDone(true);
      setConfirming(false);
    } catch {
      // Same on the failure side: a rejection belonging to an abandoned or
      // superseded attempt must not resurrect a strip, nor mark a live attempt
      // failed.
      if (!current()) return;
      setFailed(true);
    } finally {
      // 🔴 Load-bearing, not defensive. A superseded attempt clearing the shared
      // `busy` is what re-enabled Confirm while a newer request was still
      // running, which is how one row got filed three times.
      if (current()) setBusy(false);
    }
  };

  return (
    <Group gap={6} align="center" wrap={false} data-testid={ids.prompt}>
      <span style={NOTE_STYLE} {...(failed ? { role: 'alert' } : {})}>
        {failed ? 'Could not send — try again?' : `Send this ${noun} to moderators for review?`}
      </span>
      <Button
        ref={confirmRef}
        size="sm"
        loading={busy}
        onClick={confirm}
        data-testid={ids.confirm}
        aria-label={`Confirm reporting this ${noun} to moderators`}
      >
        Report
      </Button>
      <Button
        ref={cancelRef}
        size="sm"
        variant="subtle"
        // 🔴 DELIBERATELY NOT disabled in flight. It was, briefly, to stop a late
        // resolve settling a cancelled report — but a reply that never arrives
        // left BOTH buttons disabled and the control wedged with no way back
        // short of a remount. The attempt token closes the race without taking
        // the escape hatch away.
        onClick={() => {
          attemptRef.current += 1;
          setBusy(false);
          setFailed(false);
          setConfirming(false);
        }}
        data-testid={ids.cancel}
        aria-label="Cancel the report"
      >
        Cancel
      </Button>
    </Group>
  );
}
