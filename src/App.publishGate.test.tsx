// The publish-scope gate, end to end: the whole App, the REAL document-store
// adapters, and the SDK's contract fake behind `blocks/storage/*` (via
// `platform/testing.tsx`). Only the server and the host are fake.
//
// 🔴 WHAT IS UNDER TEST. `apps:storage:publish` is CONSENT-GATED: the host's first
// token never carries it, and the store refuses a shared create or edit without it
// (`consent_required`). So every path that writes to the shared board asks for it
// FIRST — a first publish, and an edit to a published generator — and a refusal
// to grant leaves NOTHING written to the board. The auto cover (a background edit)
// is covered in `App.features.test.tsx`: it never asks, it skips.
//
// ⚠️ A fake passing is evidence about the fake. The consent dialog here is a
// scripted host that either re-mints the token (`grantConsent: 'grant'`) or says
// consent is unavailable; nothing here has run against civitai's host.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { App, type AppDeps } from './App.js';
import { PUBLISH_CONSENT_MESSAGE, PUBLISH_CONTENT_REJECTED_MESSAGE } from './lib/storageErrors.js';
import {
  createFakeCivitai,
  DEFAULT_SCOPES,
  Harness,
  setHostSnapshot,
  type FakeCivitai,
  type FakeCivitaiOptions,
  type RecordedCall,
} from './platform/testing.js';
import { CKPT_INFO } from './test-helpers.js';

const ME = 99;
const PUBLISH = 'apps:storage:publish';
const WITHOUT_PUBLISH = DEFAULT_SCOPES.filter((s) => s !== PUBLISH);

function renderApp(options: FakeCivitaiOptions = {}) {
  /** One ordered record of consent requests and board writes, across both seams. */
  const timeline: string[] = [];
  const opts: FakeCivitaiOptions = {
    viewer: { id: ME, username: 'me' },
    cannedPicks: { Checkpoint: CKPT_INFO },
    onOutbound: (m) => {
      if (m.type === 'REQUEST_CONSENT') timeline.push(`consent:${((m.payload as { scopes?: string[] }).scopes ?? []).join(',')}`);
    },
    ...options,
  };
  const fake = createFakeCivitai(opts);
  const fetchWithTimeline = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.pathname.includes('/blocks/storage/records') && method !== 'GET') {
      timeline.push(`${method} ${decodeURIComponent(url.pathname.replace(/^.*\/blocks\/storage\//, ''))}`);
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
  const deps: Partial<AppDeps> = { resolveResources: async () => [] };
  render(
    <Harness {...opts} fake={fake} fetch={fetchWithTimeline} showLog={false}>
      <App deps={deps} />
    </Harness>,
  );
  return { fake, timeline };
}

const draftWrites = (fake: FakeCivitai) =>
  fake.calls.filter((c: RecordedCall) => c.method === 'PUT' && decodeURIComponent(c.path).startsWith('blocks/storage/kv/draft:'));

async function buildGenerator(name: string) {
  await userEvent.click(await screen.findByTestId('create-generator'));
  await screen.findByTestId('builder');
  await userEvent.type(screen.getByTestId('gen-name'), name);
  const editor = screen.getByTestId('button-editor');
  await userEvent.type(within(editor).getByTestId('btn-label-input'), 'Glow');
  await userEvent.click(within(editor).getByTestId('pick-checkpoint'));
  await waitFor(() => expect(within(editor).getByTestId('checkpoint-name')).toHaveTextContent('DreamShaper'));
  fireEvent.change(within(editor).getByTestId('btn-prompt-template'), { target: { value: 'neon {prompt}' } });
}

describe('first publish', () => {
  it('a token WITHOUT the publish grant asks for it first, then publishes on the SAME press', async () => {
    const { fake, timeline } = renderApp({ scopes: WITHOUT_PUBLISH, grantConsent: 'grant' });
    await buildGenerator('Asked First');
    await userEvent.click(screen.getByTestId('publish'));
    expect(await screen.findByTestId('builder-notice')).toHaveTextContent('Published!');
    // The consent request PRECEDES the board write — the write never goes out
    // without the scope and comes back refused.
    expect(timeline).toEqual([`consent:${PUBLISH}`, 'POST records']);
    expect((await fake.rows()).map((r) => r.value.title)).toEqual(['Asked First']);
  });

  it('a refused (unavailable) grant writes NOTHING to the board and says so in fixed copy; the draft is kept', async () => {
    const { fake, timeline } = renderApp({ scopes: WITHOUT_PUBLISH, grantConsent: 'unavailable' });
    await buildGenerator('Not Allowed');
    await userEvent.click(screen.getByTestId('publish'));
    expect(await screen.findByTestId('builder-error')).toHaveTextContent(PUBLISH_CONSENT_MESSAGE);
    expect(timeline).toEqual([`consent:${PUBLISH}`]);
    expect(await fake.rows()).toEqual([]);
    expect(draftWrites(fake)).toHaveLength(1);
  });

  /** NEGATIVE CONTROL: with the grant already on the token, nothing is asked. */
  it('a token that already carries the grant publishes without a consent request', async () => {
    const { timeline } = renderApp({ grantConsent: 'grant' });
    await buildGenerator('Already Granted');
    await userEvent.click(screen.getByTestId('publish'));
    expect(await screen.findByTestId('builder-notice')).toHaveTextContent('Published!');
    expect(timeline).toEqual(['POST records']);
  });
});

describe('editing a published generator', () => {
  /**
   * 🔴 THE EDIT PATH IS GATED TOO. A grant can be lost after a first publish (a
   * revoked consent reaches the next token), and the edit is a shared write like
   * the create: without the scope it must ask, and on a refusal it must not touch
   * the published row.
   */
  it('a re-publish after the grant is gone asks again, and a refusal leaves the row untouched', async () => {
    const { fake, timeline } = renderApp({ grantConsent: 'unavailable' });
    await buildGenerator('Original');
    await userEvent.click(screen.getByTestId('publish'));
    expect(await screen.findByTestId('builder-notice')).toHaveTextContent('Published!');
    const [row] = await fake.rows();

    // The grant disappears from the token.
    act(() => {
      const token = fake.transport.snapshot.get().token!;
      setHostSnapshot({ token: { ...token, scopes: WITHOUT_PUBLISH } });
    });

    const name = screen.getByTestId('gen-name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.click(screen.getByTestId('publish'));
    expect(await screen.findByTestId('builder-error')).toHaveTextContent(PUBLISH_CONSENT_MESSAGE);
    expect(timeline).toEqual(['POST records', `consent:${PUBLISH}`]);
    expect((await fake.rows()).map((r) => [r.key, r.value.title])).toEqual([[row!.key, 'Original']]);
  });

  it('with the grant given, the edit updates the SAME row in place (no second create)', async () => {
    const { fake, timeline } = renderApp({ grantConsent: 'grant' });
    await buildGenerator('First');
    await userEvent.click(screen.getByTestId('publish'));
    await screen.findByTestId('builder-notice');
    const [row] = await fake.rows();
    act(() => {
      const token = fake.transport.snapshot.get().token!;
      setHostSnapshot({ token: { ...token, scopes: WITHOUT_PUBLISH } });
    });
    const name = screen.getByTestId('gen-name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Second');
    await userEvent.click(screen.getByTestId('publish'));
    await waitFor(async () => expect((await fake.rows()).map((r) => r.value.title)).toEqual(['Second']));
    expect(timeline).toEqual(['POST records', `consent:${PUBLISH}`, `PUT records/${row!.key}`]);
  });
});

describe('a refusal from the store reaches the author as fixed copy', () => {
  it('content_rejected: the author reads the app’s sentence, and nothing is published', async () => {
    const { fake } = renderApp();
    await buildGenerator('contract-blocked-term');
    await userEvent.click(screen.getByTestId('publish'));
    expect(await screen.findByTestId('builder-error')).toHaveTextContent(PUBLISH_CONTENT_REJECTED_MESSAGE);
    expect(await fake.rows()).toEqual([]);
  });

  it('not_eligible (account too new): the reason, in the app’s words', async () => {
    renderApp({ docStore: { untrustedReason: 'account_too_new' } });
    await buildGenerator('Too Soon');
    await userEvent.click(screen.getByTestId('publish'));
    expect(await screen.findByTestId('builder-error')).toHaveTextContent(
      'Your Civitai account is too new to publish yet. Try again in a few days.',
    );
  });
});
