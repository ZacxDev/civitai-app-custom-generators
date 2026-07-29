// Buzz-spend helpers (pure). The primary insufficient-funds guard is
// DETERMINISTIC and lives on the run path: compare the workflow's `estimatedCost`
// to the viewer's balance BEFORE enabling Confirm (see Runner). This module is
// only the fallback classifier for the rare case where a submit still fails
// server-side with an insufficient-Buzz rejection (an estimate/balance race, or
// a balance that dropped between estimate and submit).
//
// NOTE (heuristic): the host's workflow snapshot exposes only a free-text
// `error` string — there is no typed error CODE for "insufficient Buzz" yet. So
// this match is a STRING heuristic. It's centralised here (single point to
// update) and case-insensitive/substring so it survives minor copy changes. The
// deterministic pre-submit balance check is what actually prevents the spend;
// this just lets the failed-card offer a top-up instead of a generic error.
// TODO: switch to a typed error code once the SDK snapshot exposes one.

const INSUFFICIENT_PATTERNS = [/insufficient\s+buzz/i, /not\s+enough\s+buzz/i];

/** Does this workflow error read as an insufficient-Buzz rejection? */
export function isInsufficientBuzzError(message: string | undefined | null): boolean {
  if (!message) return false;
  return INSUFFICIENT_PATTERNS.some((re) => re.test(message));
}
