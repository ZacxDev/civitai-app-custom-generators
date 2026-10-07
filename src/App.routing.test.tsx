// Host-route deep links (0.9.2): `/apps/run/<slug>/g/<key>` on civitai.com.
//
// The host forwards the path after the app's slug as `subPath`: in the init
// context, then as a `ROUTE_CHANGED` push. These drive the REAL App against the
// fake platform's transport (`Harness subPath=…` for init, `pushFromHost` for
// later changes), so `platform/route.ts` runs for real; only `navigate`, the
// clipboard and the `?g=` reader are injected.
//
// What this does NOT prove: that civitai.com's host sends these shapes, or that
// its shallow push echoes `ROUTE_CHANGED` the way the effects here assume. The
// shapes were read from civitai/civitai `PageBlockHost.tsx` (`send('ROUTE_CHANGED',
// { subPath })`) and `pageBlockHostLogic.ts` (`resolveNavigateRequest`), not run.

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Harness, pushFromHost, setHostSnapshot } from './platform/testing.js';

import { App, type AppDeps } from './App.js';
import { defaultParams } from './lib/generator.js';
import { fakeShared, immediateSleep, memoryDraftStore, mockWorkflow } from './test-helpers.js';
import type { SharedListItem } from './platform/index.js';

// ULID-shaped, as the server mints them — the shape the `g/<key>` route carries.
const KEY_A = '01JABCDEFGHJKMNPQRSTVWXYZ0';
const KEY_B = '01JZZZZZZZZZZZZZZZZZZZZZZ1';

function seed(key: string, title: string): SharedListItem {
  return {
    key,
    authorUserId: 7,
    value: {
      title,
      body: `${title} body`,
      data: {
        v: 1,
        buttons: [
          {
            id: 'b1',
            label: 'Go',
            workflowType: 'txt2img',
            checkpoint: { versionId: 1001, modelId: 500 },
            loras: [],
            promptTemplate: 'x {prompt}',
            params: defaultParams(),
          },
        ],
      },
    },
    count: 0,
    viewerVoted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function setup(opts: { subPath?: string; deeplinkKey?: string | null; rows?: SharedListItem[] } = {}) {
  const shared = fakeShared(opts.rows ?? [seed(KEY_A, 'Alpha'), seed(KEY_B, 'Bravo')]);
  const wf = mockWorkflow({ cost: 12, images: ['https://image.civitai.com/out.jpeg'] });
  const navigate = vi.fn();
  const copyToClipboard = vi.fn(async (_text: string) => {});
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
    navigate,
    copyToClipboard,
    getHref: () => 'https://custom-generators.civit.ai/',
    getDeeplinkKey: () => opts.deeplinkKey ?? null,
  };
  render(
    <Harness viewer={{ id: 99, username: 'me' }} theme="dark" subPath={opts.subPath}>
      <App deps={deps} />
    </Harness>,
  );
  return { navigate, copyToClipboard };
}

async function runnerTitle(): Promise<string> {
  await screen.findByTestId('runner');
  return screen.getByTestId('runner-title').textContent ?? '';
}

describe('host route — init subPath', () => {
  it('opens the generator named by a g/<key> subPath', async () => {
    setup({ subPath: `g/${KEY_B}` });
    expect(await runnerTitle()).toContain('Bravo');
  });

  it('subPath wins over ?g= when both are present', async () => {
    setup({ subPath: `g/${KEY_B}`, deeplinkKey: KEY_A });
    expect(await runnerTitle()).toContain('Bravo');
  });

  it('?g= still opens when the subPath carries no route (the fallback)', async () => {
    setup({ subPath: '', deeplinkKey: KEY_A });
    expect(await runnerTitle()).toContain('Alpha');
  });

  it.each([
    ['g/', 'empty key'],
    [`g/${'a'.repeat(65)}`, '65-char key'],
    ['../x', 'traversal'],
    [`g/${KEY_A}/b`, 'extra segment'],
    [`x/${KEY_A}`, 'wrong prefix'],
  ])('a malformed subPath %s (%s) opens nothing and navigates nowhere', async (subPath) => {
    // A row exists for EVERY key a looser parser could extract — `KEY_A` (the
    // prefix of the extra-segment and wrong-prefix cases) and the 65-char key —
    // so a broken bound or anchor would really open something here rather than
    // miss the list and pass for the wrong reason.
    const { navigate } = setup({
      subPath,
      rows: [seed(KEY_A, 'Alpha'), seed('a'.repeat(65), 'Long')],
    });
    await screen.findAllByTestId('published-card');
    // `openConfig` is async (it awaits rehydration), so an absence read on the
    // same tick as the list proves nothing. Let any open settle first.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByTestId('runner')).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('host route — ROUTE_CHANGED after init', () => {
  it('opens the generator a later ROUTE_CHANGED names', async () => {
    setup();
    await screen.findAllByTestId('published-card');
    expect(screen.queryByTestId('runner')).not.toBeInTheDocument();
    act(() => pushFromHost('ROUTE_CHANGED', { subPath: `g/${KEY_A}` }));
    expect(await runnerTitle()).toContain('Alpha');
  });

  it('a pushed route survives a later snapshot emit (token/theme) instead of reverting to the init route', async () => {
    setup({ subPath: `g/${KEY_A}` });
    expect(await runnerTitle()).toContain('Alpha');
    act(() => pushFromHost('ROUTE_CHANGED', { subPath: '' }));
    await screen.findByTestId('browse');
    // The snapshot still holds the INIT context (`g/<KEY_A>`). If the hook
    // re-read it on this emit, the stale route would re-open Alpha.
    act(() => setHostSnapshot({ theme: 'light' }));
    await screen.findByTestId('browse');
    expect(screen.queryByTestId('runner')).not.toBeInTheDocument();
  });

  it('ROUTE_CHANGED to the app root closes a keyed Runner (browser Back)', async () => {
    setup({ subPath: `g/${KEY_A}` });
    await runnerTitle();
    act(() => pushFromHost('ROUTE_CHANGED', { subPath: '' }));
    await screen.findByTestId('browse');
    expect(screen.queryByTestId('runner')).not.toBeInTheDocument();
  });

  it('a malformed ROUTE_CHANGED payload or an unknown route does nothing', async () => {
    const { navigate } = setup({ subPath: `g/${KEY_A}` });
    await runnerTitle();
    act(() => pushFromHost('ROUTE_CHANGED', { subPath: 42 }));
    act(() => pushFromHost('ROUTE_CHANGED', null));
    act(() => pushFromHost('ROUTE_CHANGED', { subPath: 'settings' }));
    expect(await runnerTitle()).toContain('Alpha');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('host route — the app writes it back', () => {
  it('opening a generator navigates to g/<key>, and Back navigates to the root', async () => {
    const { navigate } = setup();
    const card = (await screen.findAllByTestId('published-card')).find((c) => c.textContent?.includes('Alpha'))!;
    await userEvent.click(within(card).getByTestId('published-open'));
    await runnerTitle();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`g/${KEY_A}`));
    // The host echoes the shallow push; the echo must not re-open or re-navigate.
    act(() => pushFromHost('ROUTE_CHANGED', { subPath: `g/${KEY_A}` }));
    await userEvent.click(screen.getByTestId('runner-back'));
    await screen.findByTestId('browse');
    await waitFor(() => expect(navigate).toHaveBeenLastCalledWith(''));
    expect(navigate.mock.calls).toEqual([[`g/${KEY_A}`], ['']]);
  });

  it('a page opened AT g/<key> does not re-navigate to the route it is already on', async () => {
    const { navigate } = setup({ subPath: `g/${KEY_A}` });
    await runnerTitle();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('host route — share links', () => {
  it('copies https://civitai.com/apps/run/<slug>/g/<key>, with the slug from the host', async () => {
    const { copyToClipboard } = setup();
    const card = (await screen.findAllByTestId('published-card')).find((c) => c.textContent?.includes('Bravo'))!;
    await userEvent.click(within(card).getByTestId('published-share'));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
    expect(copyToClipboard.mock.calls[0]![0]).toBe(
      `https://civitai.com/apps/run/custom-generators/g/${KEY_B}`,
    );
  });
});
