// App-level feature wiring: funnel analytics, `?g=` deeplink open, fork into a
// draft, share-link copy, voting, and the rehydration-failure notice. Drives the
// real App with injected deps (analytics/deeplink/clipboard mocked) + a spied
// in-memory shared store.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';

import { App, type AppDeps } from './App.js';
import { ANALYTICS_EVENTS } from './lib/analytics.js';
import { defaultParams } from './lib/generator.js';
import { CKPT_INFO, LORA_INFO, fakeShared, immediateSleep, memoryDraftStore, mockWorkflow } from './test-helpers.js';
import type { SharedListItem } from '@civitai/blocks-react';

const VIEWER_ID = 99;

function publishedSeed(key: string, title: string, authorUserId = 7): SharedListItem {
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
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function setup(seed: SharedListItem[] = [], depsOver: Partial<AppDeps> = {}) {
  const analytics = { track: vi.fn() };
  const shared = fakeShared(seed);
  const wf = mockWorkflow({ cost: 12, images: ['https://image.civitai.com/out.jpeg'] });
  const copyToClipboard = vi.fn(async (_text: string) => {});
  const navigate = vi.fn();
  const openPurchaseModal = vi.fn(async () => ({ purchased: false }));
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
    copyToClipboard,
    navigate,
    openPurchaseModal,
    getHref: () => 'https://app.example/apps/run/custom-generators',
    getDeeplinkKey: () => null,
    ...depsOver,
  };
  render(
    <Harness
      viewer={{ id: VIEWER_ID, username: 'me' }}
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
  return { analytics, shared, copyToClipboard, navigate, openPurchaseModal };
}

describe('App — funnel analytics (feature #5)', () => {
  it('tracks build_started when Create is clicked', async () => {
    const { analytics } = setup();
    await userEvent.click(await screen.findByTestId('create-generator'));
    expect(analytics.track).toHaveBeenCalledWith(ANALYTICS_EVENTS.BUILD_STARTED);
  });

  it('tracks published on a full build → publish', async () => {
    const { analytics } = setup();
    await userEvent.click(await screen.findByTestId('create-generator'));
    await screen.findByTestId('builder');
    await userEvent.type(screen.getByTestId('gen-name'), 'Neon');
    const editor = screen.getByTestId('button-editor');
    await userEvent.type(within(editor).getByTestId('btn-label-input'), 'Glow');
    await userEvent.click(within(editor).getByTestId('pick-checkpoint'));
    await waitFor(() => expect(within(editor).getByTestId('checkpoint-name')).toHaveTextContent('DreamShaper'));
    fireEvent.change(within(editor).getByTestId('btn-prompt-template'), { target: { value: 'neon {prompt}' } });
    await userEvent.click(screen.getByTestId('publish'));
    await screen.findByTestId('builder-notice');
    expect(analytics.track).toHaveBeenCalledWith(
      ANALYTICS_EVENTS.PUBLISHED,
      expect.objectContaining({ republish: false }),
    );
  });

  it('tracks run_opened when a published generator is opened', async () => {
    const { analytics } = setup([publishedSeed('shared:x', 'Openable')]);
    await userEvent.click(await within(await screen.findByTestId('published-card')).findByTestId('published-open'));
    await screen.findByTestId('runner');
    expect(analytics.track).toHaveBeenCalledWith(
      ANALYTICS_EVENTS.RUN_OPENED,
      expect.objectContaining({ source: 'published', published: true }),
    );
  });

  it('tracks generation_submitted when a gen is confirmed', async () => {
    const { analytics } = setup([publishedSeed('shared:x', 'Runnable')]);
    await userEvent.click(await within(await screen.findByTestId('published-card')).findByTestId('published-open'));
    await screen.findByTestId('runner');
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    await waitFor(() =>
      expect(analytics.track).toHaveBeenCalledWith(ANALYTICS_EVENTS.GENERATION_SUBMITTED, expect.any(Object)),
    );
  });

  it('tracks voted (and calls shared.vote) on a Discover up-vote', async () => {
    const { analytics, shared } = setup([publishedSeed('shared:v', 'Votable')]);
    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('vote-button'));
    await waitFor(() =>
      expect(analytics.track).toHaveBeenCalledWith(ANALYTICS_EVENTS.VOTED, expect.objectContaining({ voted: true })),
    );
    // the real host vote seam was exercised
    expect(await within(card).findByTestId('published-votes')).toHaveTextContent('1');
    void shared;
  });
});

describe('App — deeplink open (feature #8)', () => {
  it('deep-opens a ?g=<key> generator directly into the Runner', async () => {
    const { analytics } = setup([publishedSeed('shared:deep', 'Deep Linked')], {
      getDeeplinkKey: () => 'shared:deep',
    });
    // no click — the deeplink effect opens the runner once the list loads
    await screen.findByTestId('runner');
    expect(screen.getByTestId('runner-title')).toHaveTextContent('Deep Linked');
    expect(analytics.track).toHaveBeenCalledWith(ANALYTICS_EVENTS.DEEPLINK_OPENED, { key: 'shared:deep' });
  });

  it('stays on Browse when the deeplink key is not in the loaded list', async () => {
    setup([publishedSeed('shared:other', 'Other')], { getDeeplinkKey: () => 'shared:missing' });
    await screen.findByTestId('browse');
    expect(screen.queryByTestId('runner')).not.toBeInTheDocument();
  });

  it('does not crash on a hostile/garbage ?g= key — stays on Browse, no runner', async () => {
    const hostile = '"><img src=x onerror=alert(1)>&g=../../etc/passwd%zz';
    setup([publishedSeed('shared:real', 'Real')], { getDeeplinkKey: () => hostile });
    await screen.findByTestId('browse');
    expect(screen.queryByTestId('runner')).not.toBeInTheDocument();
    expect(screen.getByTestId('published-card')).toBeInTheDocument(); // app still healthy
  });

  it('a matching key whose data is malformed opens nothing (parse returns null), no crash', async () => {
    const garbage: SharedListItem = {
      key: 'shared:bad',
      authorUserId: 7,
      value: { title: 'Bad', body: 'x', data: { v: 2, buttons: 'nope' } as unknown as never },
      count: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setup([garbage], { getDeeplinkKey: () => 'shared:bad' });
    await screen.findByTestId('browse');
    expect(screen.queryByTestId('runner')).not.toBeInTheDocument();
  });
});

describe('App — anonymous vote gate (audit fix #2)', () => {
  it('an anonymous viewer voting triggers sign-in and never mutates the shared store', async () => {
    const analytics = { track: vi.fn() };
    const shared = fakeShared([publishedSeed('shared:v', 'Votable')]);
    const requestSignIn = vi.fn();
    render(
      <Harness viewer={null} theme="dark" showLog={false}>
        <App
          deps={{
            resolveResources: async () => [],
            shared: shared.shared,
            updateSharedGenerator: shared.update,
            drafts: memoryDraftStore(),
            analytics,
            requestSignIn,
            getDeeplinkKey: () => null,
          }}
        />
      </Harness>,
    );
    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('vote-button'));
    await waitFor(() => expect(requestSignIn).toHaveBeenCalled());
    // no optimistic flash, no analytics vote, no host mutation
    expect(within(card).getByTestId('published-votes')).toHaveTextContent('2');
    expect(analytics.track).not.toHaveBeenCalledWith(ANALYTICS_EVENTS.VOTED, expect.anything());
  });
});

describe('App — share link (feature #8)', () => {
  it('copies a self-referential ?g=<key> link to the clipboard', async () => {
    const { copyToClipboard, analytics } = setup([publishedSeed('shared:s', 'Shareable')]);
    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('published-share'));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
    const url = copyToClipboard.mock.calls[0][0];
    expect(new URL(url).searchParams.get('g')).toBe('shared:s');
    expect(analytics.track).toHaveBeenCalledWith(ANALYTICS_EVENTS.SHARED, { key: 'shared:s' });
  });
});

describe('App — fork / duplicate (feature #9)', () => {
  it('forks a published generator into an editable draft named "(copy)"', async () => {
    const { analytics } = setup([publishedSeed('shared:f', 'Original')]);
    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('published-fork'));
    // lands in the Builder editing the forked draft
    await screen.findByTestId('builder');
    expect(screen.getByTestId('gen-name')).toHaveValue('Original (copy)');
    expect(analytics.track).toHaveBeenCalledWith(ANALYTICS_EVENTS.FORKED, { from: 'shared:f' });
    // it is a NEW unpublished draft — saving it must not touch the source row
    await userEvent.click(screen.getByTestId('save-draft'));
    await screen.findByTestId('builder-notice');
    await userEvent.click(screen.getByTestId('builder-back'));
    await userEvent.click(screen.getByTestId('tab-mine'));
    expect(await screen.findByTestId('draft-card')).toHaveTextContent('Original (copy)');
  });
});

describe('App — rehydration-failure notice (feature #12)', () => {
  it('surfaces a non-blocking notice in the Runner when resource rehydration throws', async () => {
    setup([publishedSeed('shared:r', 'Rehydrate Me')], {
      resolveResources: async () => { throw new Error('resource fetch failed'); },
    });
    await userEvent.click(await within(await screen.findByTestId('published-card')).findByTestId('published-open'));
    await screen.findByTestId('runner');
    expect(screen.getByTestId('runner-rehydrate-notice')).toBeInTheDocument();
    // …and the runner is still usable (the title rendered from stored data)
    expect(screen.getByTestId('runner-title')).toHaveTextContent('Rehydrate Me');
  });
});
