// Browse — the A1 "delete published generator" flow (confirm-gated withdraw) and
// the header cover image on published cards. Drives the REAL App wiring
// (handleDeletePublished → shared.withdraw + optimistic list removal + rollback)
// through a spied in-memory shared store.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';

import { App, type AppDeps } from '../App.js';
import { fakeShared, memoryDraftStore, mockWorkflow } from '../test-helpers.js';
import type { SharedListItem } from '@civitai/blocks-react';
import type { GeneratorData } from '../types.js';

const VIEWER_ID = 99;

function publishedItem(
  key: string,
  title: string,
  over: { authorUserId?: number; data?: GeneratorData } = {},
): SharedListItem {
  return {
    key,
    authorUserId: over.authorUserId ?? VIEWER_ID,
    value: { title, body: 'a desc', data: over.data ?? { v: 1, buttons: [] } },
    count: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function setup(seed: SharedListItem[], sharedOpts: { failWithdraw?: string } = {}) {
  const shared = fakeShared(seed, sharedOpts);
  const wf = mockWorkflow();
  const deps: Partial<AppDeps> = {
    resolveResources: async () => [],
    shared: shared.shared,
    updateSharedGenerator: shared.update,
    drafts: memoryDraftStore(),
    estimate: wf.estimate,
    submit: wf.submit,
    poll: wf.poll,
  };
  render(
    <Harness viewer={{ id: VIEWER_ID, username: 'me' }} theme="dark" consentGranted showLog={false}>
      <App deps={deps} />
    </Harness>,
  );
  return { shared };
}

async function gotoMine() {
  await userEvent.click(await screen.findByTestId('tab-mine'));
}

describe('Browse — delete published generator (A1, confirm-gated withdraw)', () => {
  it('confirm → calls withdraw(key) and optimistically removes the card', async () => {
    const { shared } = setup([publishedItem('shared:mine', 'My Gen')]);
    await gotoMine();

    // the own-published card exposes a Delete affordance
    const card = await screen.findByTestId('published-card');
    expect(card).toHaveTextContent('My Gen');
    await userEvent.click(within(card).getByTestId('published-delete'));

    // a confirm modal gates the destructive action
    await screen.findByTestId('delete-published-modal');
    await userEvent.click(screen.getByTestId('confirm-delete-published'));

    // withdraw was called with the row's ULID key, and the card is gone
    await waitFor(() => expect(shared.withdrawn).toEqual(['shared:mine']));
    await waitFor(() => expect(screen.queryByTestId('published-card')).not.toBeInTheDocument());
  });

  it('cancel → does NOT call withdraw and keeps the card', async () => {
    const { shared } = setup([publishedItem('shared:mine', 'My Gen')]);
    await gotoMine();

    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('published-delete'));
    await screen.findByTestId('delete-published-modal');
    await userEvent.click(screen.getByTestId('cancel-delete-published'));

    // modal closes; withdraw never fired; the card is still present
    await waitFor(() => expect(screen.queryByTestId('delete-published-modal')).not.toBeInTheDocument());
    expect(shared.withdrawn).toEqual([]);
    expect(screen.getByTestId('published-card')).toBeInTheDocument();
  });

  it('withdraw failure → rolls back the removal and surfaces the error', async () => {
    const { shared } = setup([publishedItem('shared:mine', 'My Gen')], { failWithdraw: 'Host rejected the delete.' });
    await gotoMine();

    const card = await screen.findByTestId('published-card');
    await userEvent.click(within(card).getByTestId('published-delete'));
    await screen.findByTestId('delete-published-modal');
    await userEvent.click(screen.getByTestId('confirm-delete-published'));

    // it attempted the withdraw, then rolled the list back and showed the error
    await waitFor(() => expect(shared.withdrawn).toEqual(['shared:mine']));
    expect(await screen.findByTestId('browse-error')).toHaveTextContent('Host rejected the delete.');
    expect(screen.getByTestId('published-card')).toBeInTheDocument();
  });

  it('does NOT offer a Delete affordance on the Discover tab (only own published)', async () => {
    // A generator authored by someone else — appears in Discover, never deletable.
    setup([publishedItem('shared:other', 'Someone Elses', { authorUserId: 7 })]);
    const card = await screen.findByTestId('published-card');
    expect(within(card).queryByTestId('published-delete')).not.toBeInTheDocument();
  });
});

describe('Browse — header cover image on published cards', () => {
  it('renders the cover from headerImageRef', async () => {
    setup([
      publishedItem('shared:cover', 'Covered', {
        data: { v: 1, buttons: [], headerImageRef: { imageId: 1, url: 'https://image.civitai.com/cover.jpeg' } },
      }),
    ]);
    const cover = await screen.findByTestId('published-cover');
    expect(cover).toHaveAttribute('src', 'https://image.civitai.com/cover.jpeg');
  });

  it('BACK-COMPAT: renders the cover from a legacy backgroundImageRef row', async () => {
    setup([
      publishedItem('shared:legacy', 'Legacy Cover', {
        // legacy row: cover under the pre-rename field
        data: { v: 1, buttons: [], backgroundImageRef: { imageId: 1, url: 'https://image.civitai.com/legacy.jpeg' } },
      }),
    ]);
    const cover = await screen.findByTestId('published-cover');
    expect(cover).toHaveAttribute('src', 'https://image.civitai.com/legacy.jpeg');
  });
});
