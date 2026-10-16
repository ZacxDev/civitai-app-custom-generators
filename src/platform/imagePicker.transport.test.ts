// `pickPostedImage` read off the bridge, against `src/platform/testing.tsx`'s fake
// host — which models civitai's `resolveImagePickerRequest` for `publicOnly`
// (civitai/civitai#6134): a Private-post image is not offered under
// `publicOnly: true`, and a non-boolean `publicOnly` is refused, not ignored.
//
// Nothing here has run against a real civitai host. What it pins is the exact
// payload this app SENDS, and that the fake it is tested against honours it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BlockPickedImageInfo } from '@civitai/app-sdk/blocks';

import { __configurePlatform, getPlatformTransport } from './client.js';
import { pickPostedImage } from './imagePicker.js';
import { createFakeCivitai, SITE_URL, type FakeCivitaiOptions } from './testing.js';

// Pairwise-distinct ids, so a mutant that returns the wrong pick cannot pass.
const PUBLIC_ID = 40_401;
const PRIVATE_ID = 40_917;

const posted = (imageId: number): BlockPickedImageInfo => ({
  source: 'posted',
  url: `https://image.civitai.com/x/${imageId}.jpeg`,
  width: 512,
  height: 768,
  nsfwLevel: 1,
  imageId,
});
const inPrivatePost = (imageId: number) => ({ ...posted(imageId), privatePost: true });

let outbound: { type: string; payload: unknown }[] = [];

function install(opts: FakeCivitaiOptions = {}) {
  outbound = [];
  const fake = createFakeCivitai({
    viewer: { id: 99, username: 'me' },
    onOutbound: (m) => outbound.push(m),
    ...opts,
  });
  __configurePlatform({ transport: fake.transport, fetch: fake.fetch, siteUrl: SITE_URL });
}

beforeEach(() => install());
afterEach(() => __configurePlatform({}));

describe('pickPostedImage', () => {
  it('asks for POSTED images from public posts only — `publicOnly` is the literal `true`', async () => {
    install({ cannedImagePicks: [posted(PUBLIC_ID)] });
    await pickPostedImage();
    const calls = outbound.filter((m) => m.type === 'OPEN_IMAGE_PICKER');
    expect(calls).toHaveLength(1);
    // Whole-payload equality: no `multiple`, nothing else, and a boolean — the
    // host refuses `'true'` or `1` outright.
    expect(calls[0]!.payload).toStrictEqual({ sources: ['posted'], publicOnly: true });
  });

  it('skips a Private-post image the fake host would otherwise offer first', async () => {
    install({ cannedImagePicks: [inPrivatePost(PRIVATE_ID), posted(PUBLIC_ID)] });
    expect(await pickPostedImage()).toStrictEqual(posted(PUBLIC_ID));
  });

  it('with only a Private-post image in the library, nothing is offered (a dismissal)', async () => {
    install({ cannedImagePicks: [inPrivatePost(PRIVATE_ID)] });
    expect(await pickPostedImage()).toBeNull();
  });
});

describe('the fake host’s OPEN_IMAGE_PICKER (civitai `resolveImagePickerRequest`)', () => {
  const ask = (payload: unknown) => getPlatformTransport().request('OPEN_IMAGE_PICKER', payload);

  it('control: WITHOUT `publicOnly`, the Private-post image IS offered — and its marker never reaches the app', async () => {
    install({ cannedImagePicks: [inPrivatePost(PRIVATE_ID), posted(PUBLIC_ID)] });
    expect(await ask({ sources: ['posted'] })).toStrictEqual({ selected: posted(PRIVATE_ID) });
    expect(await ask({ sources: ['posted'], publicOnly: false })).toStrictEqual({ selected: posted(PRIVATE_ID) });
  });

  it('`publicOnly` narrows the posted source only: a generated image is still offered', async () => {
    const generated: BlockPickedImageInfo = {
      source: 'generated',
      url: 'https://orchestration.civitai.com/out/7.png',
      width: 512,
      height: 512,
      nsfwLevel: 1,
    };
    install({ cannedImagePicks: [inPrivatePost(PRIVATE_ID), generated] });
    expect(await ask({ sources: ['posted', 'generated'], publicOnly: true })).toStrictEqual({ selected: generated });
  });

  it.each([['the string "true"', 'true'], ['1', 1], ['null', null]])(
    'refuses a non-boolean `publicOnly` (%s) instead of ignoring it',
    async (_label, value) => {
      install({ cannedImagePicks: [posted(PUBLIC_ID)] });
      await expect(ask({ sources: ['posted'], publicOnly: value })).rejects.toThrow(/publicOnly must be a boolean/);
    },
  );
});
