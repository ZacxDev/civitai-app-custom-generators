// The abuse seam: filing a published generator for PLATFORM moderator review.
//
// 🔴 WHAT THESE TESTS CAN AND CANNOT CLAIM. `createMockHost` checks no viewer on
// any SHARED_* handler, so an anonymous mutation SUCCEEDS against the mock while
// it rejects against the real host — the mock is MORE permissive on exactly the
// axis the signed-out case is about. So the signed-out test below asserts that no
// report AFFORDANCE is offered, which is a UI claim. It does NOT assert the
// transport rejects, because that is not observable here. The two are not
// interchangeable and the weaker one reads like the stronger one in a test name,
// so this comment exists to keep them apart.
//
// 🔴 The secondary testids are DERIVED from the trigger by the shared control:
// `published-report` yields `-confirm`, `-cancel`, `-done`, `-prompt`. Grep for
// the SUFFIX, never the composed value — a composed id appears nowhere in source,
// so searching for `published-report-done` returns zero whether the selector
// works or has just been deleted.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';

import { App, type AppDeps } from './App.js';
import { ANALYTICS_EVENTS } from './lib/analytics.js';
import { defaultParams } from './lib/generator.js';
import { CKPT_INFO, LORA_INFO, fakeShared, immediateSleep, memoryDraftStore, mockWorkflow } from './test-helpers.js';
import type { SharedListItem } from '@civitai/blocks-react';

const VIEWER_ID = 99;
const SOMEONE_ELSE = 7;

function publishedSeed(key: string, title: string, authorUserId = SOMEONE_ELSE): SharedListItem {
  return {
    key,
    authorUserId,
    value: {
      title,
      body: `${title} does neon things`,
      data: {
        v: 1,
        buttons: [
          {
            id: 'b1',
            label: 'Glow',
            workflowType: 'txt2img',
            checkpoint: { versionId: 1001, modelId: 500 },
            loras: [],
            promptTemplate: 'neon {prompt}',
            params: defaultParams(),
          },
        ],
      },
    },
    count: 2,
    viewerVoted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** `viewer: null` is the ANONYMOUS path. `undefined` would be a signed-in dev-viewer. */
function setup(
  seed: SharedListItem[] = [],
  opts: { viewer?: { id: number; username: string } | null; depsOver?: Partial<AppDeps> } = {},
) {
  const analytics = { track: vi.fn() };
  const shared = fakeShared(seed);
  const wf = mockWorkflow({ cost: 12, images: ['https://image.civitai.com/out.jpeg'] });
  const deps: Partial<AppDeps> = {
    resolveResources: async () => [],
    shared: shared.shared,
    updateSharedGenerator: shared.update,
    drafts: memoryDraftStore(),
    estimate: wf.estimate,
    submit: wf.submit,
    poll: wf.poll,
    pollIntervalMs: 0,
    sleep: immediateSleep,
    analytics,
    copyToClipboard: vi.fn(async (_t: string) => {}),
    navigate: vi.fn(),
    openPurchaseModal: vi.fn(async () => ({ purchased: false })),
    getHref: () => 'https://app.example/apps/run/custom-generators',
    getDeeplinkKey: () => null,
    ...opts.depsOver,
  };
  render(
    <Harness
      viewer={opts.viewer === undefined ? { id: VIEWER_ID, username: 'me' } : opts.viewer}
      theme="dark"
      consentGranted
      buzzBudget={1000}
      buzz={{ balance: 5000 }}
      buzzBalance={{ blue: 0, green: 0, yellow: 5000 }}
      cannedPicks={{ Checkpoint: CKPT_INFO, LORA: LORA_INFO }}
      showLog={false}
    >
      <App deps={deps} />
    </Harness>,
  );
  return { analytics, shared };
}

describe('report — the abuse seam on a public board', () => {
  it('is offered on a row the signed-in viewer does NOT own', async () => {
    setup([publishedSeed('shared:theirs', 'Someone else’s')]);
    const card = await screen.findByTestId('published-card');
    expect(within(card).getByTestId('published-report')).toBeInTheDocument();
  });

  it('is NOT offered on the viewer’s OWN row — an author has a real Remove instead', async () => {
    setup([publishedSeed('shared:mine', 'Mine', VIEWER_ID)]);
    const card = await screen.findByTestId('published-card');
    expect(within(card).queryByTestId('published-report')).toBeNull();
    // Positive control: the card rendered and its other actions ARE present, so
    // the null above is a real absence and not a card that never mounted.
    expect(within(card).getByTestId('vote-button')).toBeInTheDocument();
  });

  it('offers no report AFFORDANCE to a signed-out viewer (a UI claim — see the header)', async () => {
    setup([publishedSeed('shared:theirs', 'Someone else’s')], { viewer: null });
    const card = await screen.findByTestId('published-card');
    expect(within(card).queryByTestId('published-report')).toBeNull();
    expect(within(card).getByTestId('vote-button')).toBeInTheDocument(); // control
  });

  it('files the row through shared.report only AFTER the viewer confirms, and settles', async () => {
    const { shared, analytics } = setup([publishedSeed('shared:theirs', 'Someone else’s')]);
    const card = await screen.findByTestId('published-card');

    await userEvent.click(within(card).getByTestId('published-report'));
    // Arming alone must not file anything — the whole point of a two-step control.
    expect(shared.reported).toEqual([]);

    await userEvent.click(screen.getByTestId('published-report-confirm'));
    await waitFor(() => expect(screen.getByTestId('published-report-done')).toBeInTheDocument());
    expect(shared.reported).toEqual([{ key: 'shared:theirs', reason: undefined }]);
    expect(analytics.track).toHaveBeenCalledWith(ANALYTICS_EVENTS.REPORTED, { key: 'shared:theirs' });
  });

  it('does NOT settle when the host rejects — the report was not filed, so it must not say it was', async () => {
    const base = fakeShared([publishedSeed('shared:theirs', 'Someone else’s')]);
    const { shared } = setup([publishedSeed('shared:theirs', 'Someone else’s')], {
      depsOver: {
        shared: {
          ...base.shared,
          report: async () => {
            throw new Error('host says no');
          },
        },
      },
    });
    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('published-report'));
    await userEvent.click(screen.getByTestId('published-report-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('published-report-prompt')).toHaveTextContent(/could not send/i),
    );
    // The settled state is the lie we are guarding against: it must be absent.
    expect(screen.queryByTestId('published-report-done')).toBeNull();
    // And nothing reached the real seam.
    expect(shared.reported).toEqual([]);
  });
});
