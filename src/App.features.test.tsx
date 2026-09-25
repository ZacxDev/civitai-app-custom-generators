// App-level feature wiring: build → publish → run, `?g=` deeplink open, fork into
// a draft, share-link copy, voting, and the rehydration-failure notice. Drives the
// real App with injected deps (deeplink/clipboard mocked) + a spied in-memory
// shared store.
//
// THIS FILE USED TO BE THE FUNNEL-ANALYTICS SUITE. Nine of its assertions read an
// `analytics.track` spy, and the sink behind it recorded nothing in production —
// the hook body was `if (import.meta.env.DEV) console.debug(...)`. The shim, the
// event vocabulary and every emit site are deleted, so those assertions are gone
// rather than re-pointed. Two tests whose ONLY assertion was the spy went with
// them: `build_started` (the click it made is covered incidentally by the publish
// journey below) and `generation_submitted` (whose behaviour the `Runner.*` suites
// own). The rest kept their behavioural assertions and were renamed to claim only
// those.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Harness } from './platform/testing.js';

import { App, type AppDeps } from './App.js';
import { defaultParams } from './lib/generator.js';
import { CKPT_INFO, LORA_INFO, fakeShared, immediateSleep, memoryDraftStore, mockWorkflow } from './test-helpers.js';
import type { SharedListItem } from './platform/index.js';

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
    viewerVoted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function setup(seed: SharedListItem[] = [], depsOver: Partial<AppDeps> = {}) {
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
  return { shared, copyToClipboard, navigate, openPurchaseModal };
}

describe('App — build → publish → run → vote wiring', () => {
  it('publishes a full build and confirms it on screen', async () => {
    setup();
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
  });

  it('opens a published generator into the Runner', async () => {
    setup([publishedSeed('shared:x', 'Openable')]);
    await userEvent.click(await within(await screen.findByTestId('published-card')).findByTestId('published-open'));
    await screen.findByTestId('runner');
  });

  it('up-votes through the shared seam and shows the authoritative new count', async () => {
    setup([publishedSeed('shared:v', 'Votable')]);
    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('vote-button'));
    // The count comes back from the fake server's own row rather than an
    // optimistic flash — the seam assertion the deleted spy assertion sat beside.
    expect(await within(card).findByTestId('published-votes')).toHaveTextContent('1');
  });
});

describe('App — deeplink open (feature #8)', () => {
  it('deep-opens a ?g=<key> generator directly into the Runner', async () => {
    setup([publishedSeed('shared:deep', 'Deep Linked')], {
      getDeeplinkKey: () => 'shared:deep',
    });
    // no click — the deeplink effect opens the runner once the list loads
    await screen.findByTestId('runner');
    expect(screen.getByTestId('runner-title')).toHaveTextContent('Deep Linked');
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
      viewerVoted: false,
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
            requestSignIn,
            getDeeplinkKey: () => null,
          }}
        />
      </Harness>,
    );
    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('vote-button'));
    await waitFor(() => expect(requestSignIn).toHaveBeenCalled());
    // no optimistic flash, no host mutation — the count is still the seeded 2
    expect(within(card).getByTestId('published-votes')).toHaveTextContent('2');
  });
});

describe('App — share link (feature #8)', () => {
  it('copies a self-referential ?g=<key> link to the clipboard', async () => {
    const { copyToClipboard } = setup([publishedSeed('shared:s', 'Shareable')]);
    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('published-share'));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
    const url = copyToClipboard.mock.calls[0][0];
    expect(new URL(url).searchParams.get('g')).toBe('shared:s');
  });
});

describe('App — fork / duplicate (feature #9)', () => {
  it('forks a published generator into an editable draft named "(copy)"', async () => {
    setup([publishedSeed('shared:f', 'Original')]);
    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('published-fork'));
    // lands in the Builder editing the forked draft
    await screen.findByTestId('builder');
    expect(screen.getByTestId('gen-name')).toHaveValue('Original (copy)');
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
