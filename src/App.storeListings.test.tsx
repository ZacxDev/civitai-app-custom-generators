// App Store sub-listings, driven through the whole App against the app's own fake
// platform: publish → upsert, withdraw → NO store call, and the once-per-session
// backfill on open. The REAL adapter (`platform/storeListings.ts`) and the real
// shared-storage adapter run; only the server is fake.
//
// 🔴 THE LOAD-BEARING PROPERTY: THE STORE IS BEST-EFFORT. A store failure of any
// kind — 4xx, 5xx, 503 "feature tables missing", a dead network, a request that
// never answers — must leave the in-app publish exactly as it was: the row
// written, the success notice shown, no error. Every failure arm below asserts
// all three, not just "no throw".
//
// 🔴 WHAT THIS IS NOT. A fake passing is evidence about the fake. Nothing here has
// run against civitai's sub-listing routes.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BlockPickedImageInfo } from '@civitai/app-sdk/blocks';

import { Harness, createFakeCivitai, type FakeCivitai, type FakeCivitaiOptions } from './platform/testing.js';
import { App, type AppDeps } from './App.js';
import { CKPT_INFO } from './test-helpers.js';
import { buildPublishPayload, defaultParams } from './lib/generator.js';
import { APPS_STORE_ITEMS_WRITE } from './scopes.js';

const ME = 99;
const SOMEONE_ELSE = 7;

const MANIFEST_SCOPES = [
  'ai:write:budgeted',
  'buzz:read:self',
  'apps:storage:read',
  'apps:storage:write',
  'apps:storage:shared:read',
  'apps:storage:shared:write',
  'posts:write:self',
];
const WITH_STORE = [...MANIFEST_SCOPES, APPS_STORE_ITEMS_WRITE];

function genValue(title: string, description = `${title} description`) {
  return buildPublishPayload({
    name: title,
    description,
    buttons: [
      { id: 'b1', label: 'Go', workflowType: 'txt2img', loras: [], promptTemplate: 'a {prompt}', params: defaultParams() },
    ],
  });
}

interface Setup {
  options?: FakeCivitaiOptions;
  /** Wrap the fake's fetch (to drop or hold sub-listing requests). */
  wrapFetch?: (inner: typeof fetch) => typeof fetch;
}

function renderApp({ options = {}, wrapFetch }: Setup = {}): FakeCivitai {
  const opts: FakeCivitaiOptions = {
    viewer: { id: ME, username: 'me' },
    scopes: WITH_STORE,
    cannedPicks: { Checkpoint: CKPT_INFO },
    ...options,
  };
  const fake = createFakeCivitai(opts);
  const deps: Partial<AppDeps> = { resolveResources: async () => [] };
  render(
    <Harness {...opts} fetch={wrapFetch ? wrapFetch(fake.fetch) : fake.fetch} showLog={false}>
      <App deps={deps} />
    </Harness>,
  );
  return fake;
}

function storeCalls(fake: FakeCivitai, op?: 'upsert' | 'withdraw' | 'mine') {
  return fake.calls.filter((c) =>
    op ? c.path === `blocks/sub-listings/${op}` : c.path.startsWith('blocks/sub-listings/'),
  );
}

/** Build a valid one-button generator in the Builder (the e2e path). */
async function buildGenerator(name: string, description: string) {
  await userEvent.click(await screen.findByTestId('create-generator'));
  await screen.findByTestId('builder');
  await userEvent.type(screen.getByTestId('gen-name'), name);
  fireEvent.change(screen.getByTestId('gen-description'), { target: { value: description } });
  const editor = screen.getByTestId('button-editor');
  await userEvent.type(within(editor).getByTestId('btn-label-input'), 'Glow');
  await userEvent.click(within(editor).getByTestId('pick-checkpoint'));
  await waitFor(() => expect(within(editor).getByTestId('checkpoint-name')).toHaveTextContent('DreamShaper'));
  fireEvent.change(within(editor).getByTestId('btn-prompt-template'), { target: { value: 'neon {prompt}' } });
}

/** The success notice is up, no error is, and the row is on the (fake) server. */
async function expectInAppPublishStood(fake: FakeCivitai, title: string) {
  expect(await screen.findByTestId('builder-notice')).toHaveTextContent('Published!');
  expect(screen.queryByTestId('builder-error')).toBeNull();
  expect(fake.rows().some((r) => r.value.title === title)).toBe(true);
}

describe('publish → store upsert', () => {
  it('upserts the published generator with its g/<key> route, title and tagline', async () => {
    const fake = renderApp();
    await buildGenerator('Neon Portraits', 'Glowing portraits in one tap.');
    await userEvent.click(screen.getByTestId('publish'));
    await expectInAppPublishStood(fake, 'Neon Portraits');

    await waitFor(() => expect(storeCalls(fake, 'upsert').length).toBe(1));
    const key = fake.rows().find((r) => r.value.title === 'Neon Portraits')!.key;
    expect(storeCalls(fake, 'upsert')[0]!.body).toStrictEqual({
      itemKey: key,
      title: 'Neon Portraits',
      tagline: 'Glowing portraits in one tap.',
      subPath: `g/${key}`,
    });
    expect(await screen.findByTestId('builder-store-notice')).toHaveTextContent(/moderator/i);
  });

  it('an edit + republish upserts the SAME item key with the new title', async () => {
    const fake = renderApp();
    await buildGenerator('First Name', 'Desc.');
    await userEvent.click(screen.getByTestId('publish'));
    await waitFor(() => expect(storeCalls(fake, 'upsert').length).toBe(1));
    const key = (storeCalls(fake, 'upsert')[0]!.body as { itemKey: string }).itemKey;

    const name = screen.getByTestId('gen-name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Second Name');
    await userEvent.click(screen.getByTestId('publish'));
    await waitFor(() => expect(storeCalls(fake, 'upsert').length).toBe(2));
    expect(storeCalls(fake, 'upsert')[1]!.body).toMatchObject({ itemKey: key, title: 'Second Name', subPath: `g/${key}` });
    // Still one shared row: the edit updated in place.
    expect(fake.rows().length).toBe(1);
  });

  it.each([
    ['503 (store tables missing)', { status: 503, code: 'unavailable' }, false],
    ['403 not_enabled', { status: 403, code: 'not_enabled' }, false],
    ['429 rate_limited', { status: 429, code: 'rate_limited' }, true],
    ['400 text_rejected', { status: 400, code: 'text_rejected' }, true],
    ['409 conflict', { status: 409, code: 'conflict' }, true],
    ['500', { status: 500 }, true],
  ] as const)('an upsert %s leaves the in-app publish intact', async (_label, fail, noticeShown) => {
    const fake = renderApp({ options: { subListings: { fail: { upsert: fail } } } });
    await buildGenerator('Sturdy', 'Desc.');
    await userEvent.click(screen.getByTestId('publish'));
    await expectInAppPublishStood(fake, 'Sturdy');
    await waitFor(() => expect(storeCalls(fake, 'upsert').length).toBe(1));
    if (noticeShown) {
      expect(await screen.findByTestId('builder-store-notice')).toHaveTextContent(/still published here/);
    } else {
      // Settle a tick, then assert silence: "unavailable" is not the author's problem.
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId('builder-store-notice')).toBeNull();
    }
    expect(screen.queryByTestId('builder-error')).toBeNull();
  });

  it('a network failure on upsert leaves the in-app publish intact', async () => {
    const fake = renderApp({
      wrapFetch: (inner) =>
        (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          if (url.includes('sub-listings/upsert')) throw new TypeError('Failed to fetch');
          return inner(input, init);
        }) as typeof fetch,
    });
    await buildGenerator('Offline', 'Desc.');
    await userEvent.click(screen.getByTestId('publish'));
    await expectInAppPublishStood(fake, 'Offline');
    expect(await screen.findByTestId('builder-store-notice')).toHaveTextContent(/still published here/);
  });

  it('🔴 an upsert that NEVER answers does not hold up the in-app publish', async () => {
    const fake = renderApp({
      wrapFetch: (inner) =>
        (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          if (url.includes('sub-listings/upsert')) return new Promise<Response>(() => {});
          return inner(input, init);
        }) as typeof fetch,
    });
    await buildGenerator('Patient', 'Desc.');
    await userEvent.click(screen.getByTestId('publish'));
    await expectInAppPublishStood(fake, 'Patient');
  });

  it('a later Save draft does not keep showing the previous publish’s store line', async () => {
    const fake = renderApp();
    await buildGenerator('Saver', 'Desc.');
    await userEvent.click(screen.getByTestId('publish'));
    await waitFor(() => expect(storeCalls(fake, 'upsert').length).toBe(1));
    await screen.findByTestId('builder-store-notice');
    await userEvent.click(screen.getByTestId('save-draft'));
    await waitFor(() => expect(screen.getByTestId('builder-notice')).not.toHaveTextContent('Published!'));
    expect(screen.queryByTestId('builder-store-notice')).toBeNull();
  });

  it('makes NO store call when the token lacks the store scope', async () => {
    const fake = renderApp({ options: { scopes: MANIFEST_SCOPES } });
    await buildGenerator('No Scope', 'Desc.');
    await userEvent.click(screen.getByTestId('publish'));
    await expectInAppPublishStood(fake, 'No Scope');
    await new Promise((r) => setTimeout(r, 20));
    expect(storeCalls(fake)).toEqual([]);
  });
});

describe('withdraw → no store call', () => {
  // civitai's shared-storage withdraw takes the author's store card down itself
  // (it awaits that mirror before answering), so the app makes no store call of
  // its own: a second one would only spend one of the author's 30/h store writes.
  async function withdrawFirstPublished() {
    await userEvent.click(await screen.findByTestId('tab-mine'));
    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('published-delete'));
    await userEvent.click(await screen.findByTestId('confirm-delete-published'));
  }

  it('a successful in-app withdraw makes no store call and stands', async () => {
    const fake = renderApp({
      options: {
        shared: { seed: [{ key: 'kPub', authorUserId: ME, value: genValue('Mine') }] },
        subListings: { seed: [{ itemKey: 'kPub', status: 'approved' }] },
      },
    });
    await withdrawFirstPublished();
    await waitFor(() => expect(fake.rows()).toEqual([]));
    expect(fake.calls.filter((c) => c.path === 'blocks/shared-storage/withdraw')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(storeCalls(fake, 'withdraw')).toEqual([]);
    expect(screen.queryByTestId('browse-error')).toBeNull();
    expect(screen.queryByTestId('published-card')).toBeNull();
  });

  it('a FAILED in-app withdraw makes no store call', async () => {
    const fake = renderApp({
      options: { shared: { seed: [{ key: 'kPub', authorUserId: ME, value: genValue('Mine') }] } },
      wrapFetch: (inner) =>
        (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          if (url.includes('shared-storage/withdraw')) {
            return new Response(JSON.stringify({ error: 'nope' }), { status: 500, headers: { 'content-type': 'application/json' } });
          }
          return inner(input, init);
        }) as typeof fetch,
    });
    await withdrawFirstPublished();
    await screen.findByTestId('browse-error');
    expect(storeCalls(fake, 'withdraw')).toEqual([]);
  });
});

describe('reconcile on open', () => {
  const MY_THREE = [
    { key: 'k1', authorUserId: ME, value: genValue('One') },
    { key: 'k2', authorUserId: ME, value: genValue('Two') },
    { key: 'k3', authorUserId: ME, value: genValue('Three') },
    { key: 'k4', authorUserId: SOMEONE_ELSE, value: genValue('Theirs') },
  ];

  it('upserts only the author’s published items missing from the store, once per session', async () => {
    const fake = renderApp({
      options: {
        shared: { seed: MY_THREE },
        subListings: { seed: [{ itemKey: 'k2', status: 'approved' }] },
      },
    });
    await waitFor(() => expect(storeCalls(fake, 'upsert').length).toBe(2));
    expect(storeCalls(fake, 'upsert').map((c) => (c.body as { itemKey: string }).itemKey).sort()).toEqual(['k1', 'k3']);
    expect(storeCalls(fake, 'upsert')[0]!.body).toMatchObject({ subPath: expect.stringMatching(/^g\/k[13]$/) });

    // A reload of the board (Builder → Back re-runs the load effect) must not re-run it.
    const listsBefore = fake.calls.filter((c) => c.path === 'blocks/shared-storage/list').length;
    await userEvent.click(screen.getByTestId('create-generator'));
    await userEvent.click(await screen.findByTestId('builder-back'));
    await waitFor(() =>
      expect(fake.calls.filter((c) => c.path === 'blocks/shared-storage/list').length).toBeGreaterThan(listsBefore),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(storeCalls(fake, 'mine').length).toBe(1);
    expect(storeCalls(fake, 'upsert').length).toBe(2);
  });

  it('never calls the store for a signed-in viewer who has published nothing', async () => {
    const fake = renderApp({
      options: { shared: { seed: [{ key: 'k4', authorUserId: SOMEONE_ELSE, value: genValue('Theirs') }] } },
    });
    await screen.findByTestId('discover-list');
    await waitFor(() => expect(fake.calls.filter((c) => c.path === 'blocks/shared-storage/list').length).toBe(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(storeCalls(fake)).toEqual([]);
  });

  it('never calls the store for an anonymous viewer', async () => {
    const fake = renderApp({ options: { viewer: null, shared: { seed: MY_THREE } } });
    await screen.findByTestId('discover-list');
    await new Promise((r) => setTimeout(r, 20));
    expect(storeCalls(fake)).toEqual([]);
  });

  it('never calls the store when the token lacks the store scope', async () => {
    const fake = renderApp({ options: { scopes: MANIFEST_SCOPES, shared: { seed: MY_THREE } } });
    await screen.findByTestId('discover-list');
    await waitFor(() => expect(fake.calls.filter((c) => c.path === 'blocks/shared-storage/list').length).toBe(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(storeCalls(fake)).toEqual([]);
  });

  it('🔴 a backfill recorded in the viewer’s storage within the interval is not re-run on a new page load', async () => {
    const fake = renderApp({
      options: {
        shared: { seed: MY_THREE },
        storage: { seed: { 'store-backfill:v1': { v: 1, lastRunAt: Date.now() - 60_000, refused: [] } } },
      },
    });
    await screen.findByTestId('discover-list');
    await waitFor(() => expect(fake.calls.some((c) => c.path === 'blocks/app-storage/get')).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(storeCalls(fake)).toEqual([]);
  });

  it('records the run in the viewer’s storage so the next page load skips it', async () => {
    const fake = renderApp({ options: { shared: { seed: MY_THREE } } });
    await waitFor(() => expect(storeCalls(fake, 'upsert').length).toBe(3));
    await waitFor(() =>
      expect(
        fake.calls.some(
          (c) => c.path === 'blocks/app-storage/set' && (c.body as { key?: string }).key === 'store-backfill:v1',
        ),
      ).toBe(true),
    );
  });

  it('a 503 from `mine` stops the backfill and leaves Browse untouched', async () => {
    const fake = renderApp({
      options: { shared: { seed: MY_THREE }, subListings: { fail: { mine: { status: 503, code: 'unavailable' } } } },
    });
    await waitFor(() => expect(storeCalls(fake, 'mine').length).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(storeCalls(fake, 'upsert')).toEqual([]);
    expect(screen.queryByTestId('browse-error')).toBeNull();
    expect(screen.getByTestId('discover-list').textContent).toContain('One');
  });
});

describe('optional App Store card image', () => {
  // An id no other constant in this suite equals (see the RULES on fixture
  // distinctness): a mutant that sends a hardcoded or the header's id cannot pass.
  const MY_POSTED = 31_337;
  const posted = (imageId: number | undefined, url = `https://image.civitai.com/x/${imageId}.jpeg`): BlockPickedImageInfo => ({
    source: 'posted',
    url,
    width: 1024,
    height: 1024,
    nsfwLevel: 1,
    ...(imageId !== undefined ? { imageId } : {}),
  });
  const generated: BlockPickedImageInfo = {
    source: 'generated',
    url: 'https://orchestration.civitai.com/out/1.png',
    width: 1024,
    height: 1024,
    nsfwLevel: 1,
  };

  async function chooseStoreImage() {
    await userEvent.click(await screen.findByTestId('pick-store-image'));
  }

  it('asks the host picker for POSTED images only, previews the pick, and sends its imageId', async () => {
    const outbound: { type: string; payload: unknown }[] = [];
    const fake = renderApp({
      options: {
        // The generated image comes FIRST: a picker opened without the `posted`
        // filter would hand it back, and it has no id the store could take.
        cannedImagePicks: [generated, posted(MY_POSTED)],
        subListings: { publicImages: [{ imageId: MY_POSTED, userId: ME }] },
        onOutbound: (m) => outbound.push(m),
      },
    });
    await buildGenerator('Pictured', 'With a store image.');
    await chooseStoreImage();
    expect(await screen.findByTestId('store-image-preview')).toHaveAttribute(
      'src',
      `https://image.civitai.com/x/${MY_POSTED}.jpeg`,
    );
    const pickerCalls = outbound.filter((m) => m.type === 'OPEN_IMAGE_PICKER');
    expect(pickerCalls).toHaveLength(1);
    expect(pickerCalls[0]!.payload).toMatchObject({ sources: ['posted'] });
    expect((pickerCalls[0]!.payload as Record<string, unknown>).multiple).toBeUndefined();

    await userEvent.click(screen.getByTestId('publish'));
    await expectInAppPublishStood(fake, 'Pictured');
    await waitFor(() => expect(storeCalls(fake, 'upsert').length).toBe(1));
    const key = fake.rows().find((r) => r.value.title === 'Pictured')!.key;
    expect(storeCalls(fake, 'upsert')[0]!.body).toStrictEqual({
      itemKey: key,
      title: 'Pictured',
      tagline: 'With a store image.',
      subPath: `g/${key}`,
      imageId: MY_POSTED,
    });
    expect(fake.subListings().get(key)!.imageId).toBe(MY_POSTED);
    expect(await screen.findByTestId('builder-store-notice')).toHaveTextContent(/moderator/i);
  });

  it('sends NO imageId key when no image is chosen (the card keeps the parent cover)', async () => {
    const fake = renderApp({ options: { cannedImagePicks: [posted(MY_POSTED)] } });
    await buildGenerator('Plain', 'No store image.');
    expect(screen.getByTestId('store-image-card')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('publish'));
    await waitFor(() => expect(storeCalls(fake, 'upsert').length).toBe(1));
    expect(Object.keys(storeCalls(fake, 'upsert')[0]!.body as object)).not.toContain('imageId');
  });

  it('removing the image and republishing sends no imageId, which clears the card image', async () => {
    const fake = renderApp({
      options: {
        cannedImagePicks: [posted(MY_POSTED)],
        subListings: { publicImages: [{ imageId: MY_POSTED, userId: ME }] },
      },
    });
    await buildGenerator('Toggled', 'Desc.');
    await chooseStoreImage();
    await screen.findByTestId('store-image-preview');
    await userEvent.click(screen.getByTestId('publish'));
    await waitFor(() => expect(storeCalls(fake, 'upsert').length).toBe(1));
    const key = (storeCalls(fake, 'upsert')[0]!.body as { itemKey: string }).itemKey;
    expect(fake.subListings().get(key)!.imageId).toBe(MY_POSTED);

    await userEvent.click(screen.getByTestId('remove-store-image'));
    expect(screen.queryByTestId('store-image-preview')).toBeNull();
    await userEvent.click(screen.getByTestId('publish'));
    await waitFor(() => expect(storeCalls(fake, 'upsert').length).toBe(2));
    expect(Object.keys(storeCalls(fake, 'upsert')[1]!.body as object)).not.toContain('imageId');
    expect(fake.subListings().get(key)!.imageId).toBeNull();
  });

  it('a pick with no image id (not a posted image) is refused inline and never attached', async () => {
    const fake = renderApp({ options: { cannedImagePicks: [posted(undefined)] } });
    await buildGenerator('No Id', 'Desc.');
    await chooseStoreImage();
    expect(await screen.findByTestId('store-image-error')).toHaveTextContent(/published posts/);
    expect(screen.queryByTestId('store-image-preview')).toBeNull();
    await userEvent.click(screen.getByTestId('publish'));
    await waitFor(() => expect(storeCalls(fake, 'upsert').length).toBe(1));
    expect(Object.keys(storeCalls(fake, 'upsert')[0]!.body as object)).not.toContain('imageId');
  });

  it('a host refusal of the picker shows app copy, not the host’s string', async () => {
    renderApp({ options: { imagePickerError: 'unsupported on this host' } });
    await buildGenerator('Refused', 'Desc.');
    await chooseStoreImage();
    const err = await screen.findByTestId('store-image-error');
    expect(err).toHaveTextContent(/Couldn’t open your images/);
    expect(err).not.toHaveTextContent(/unsupported/);
  });

  it('a dismissed picker changes nothing', async () => {
    renderApp({ options: { cannedImagePicks: [] } });
    await buildGenerator('Dismissed', 'Desc.');
    await chooseStoreImage();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('store-image-preview')).toBeNull();
    expect(screen.queryByTestId('store-image-error')).toBeNull();
  });

  it.each([
    ['image_not_public', [], /finished review/],
    ['image_not_yours', [{ imageId: MY_POSTED, userId: SOMEONE_ELSE }], /posted yourself/],
  ] as const)('the store refusing the image (%s) is told to the author, and the in-app publish stands', async (_code, publicImages, copy) => {
    const fake = renderApp({
      options: { cannedImagePicks: [posted(MY_POSTED)], subListings: { publicImages: [...publicImages] } },
    });
    await buildGenerator('Refused Pic', 'Desc.');
    await chooseStoreImage();
    await screen.findByTestId('store-image-preview');
    await userEvent.click(screen.getByTestId('publish'));
    await expectInAppPublishStood(fake, 'Refused Pic');
    const notice = await screen.findByTestId('builder-store-notice');
    expect(notice).toHaveTextContent(copy);
    expect(notice).toHaveTextContent(/still published here/);
    expect(screen.queryByTestId('builder-error')).toBeNull();
  });

  it('offers no picker when the token lacks the store scope', async () => {
    renderApp({ options: { scopes: MANIFEST_SCOPES, cannedImagePicks: [posted(MY_POSTED)] } });
    await buildGenerator('No Scope Pic', 'Desc.');
    expect(screen.queryByTestId('store-image-card')).toBeNull();
    expect(screen.queryByTestId('pick-store-image')).toBeNull();
  });
});
