// Analytics event vocabulary for the build → publish → run → vote funnel.
//
// The App wires `useBlockAnalytics().track` into an injectable `analytics` dep;
// these constants keep the event names in ONE place (so a dashboard query and
// the emit site can't drift) and the payload shapes typed. Fire-and-forget: the
// host forwards to its pipeline and the block never blocks on an ack.

export const ANALYTICS_EVENTS = {
  /** A viewer opened the Builder to create a new generator. */
  BUILD_STARTED: 'generator_build_started',
  /** A generator was published (first publish) or re-published (edit-in-place). */
  PUBLISHED: 'generator_published',
  /** A generator was opened into the Runner (from Discover, a draft, or a deeplink). */
  RUN_OPENED: 'generator_run_opened',
  /** A generation was confirmed + submitted (the spend point). */
  GENERATION_SUBMITTED: 'generation_submitted',
  /** A viewer up-voted / removed their up-vote on a published generator. */
  VOTED: 'generator_voted',
  /** A published generator was forked into the viewer's own draft. */
  FORKED: 'generator_forked',
  /** A shareable deeplink was copied. */
  SHARED: 'generator_shared',
  /** The app opened a generator from a `?g=` deeplink. */
  DEEPLINK_OPENED: 'generator_deeplink_opened',
  /** A render error was caught by the top-level ErrorBoundary (crash telemetry). */
  APP_CRASHED: 'app_crashed',
} as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

/** The injectable analytics seam (matches `useBlockAnalytics()`'s return). */
export interface Analytics {
  track: (eventName: string, properties?: Record<string, unknown>) => void;
}

/** A no-op analytics sink (default for tests / when the host has none). */
export const noopAnalytics: Analytics = { track: () => {} };
