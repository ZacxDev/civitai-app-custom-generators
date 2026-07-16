// End-to-end: drive the FULL build → publish → discover → open → run loop
// against the real SDK mock host (createMockHost via <Harness>). Only the
// generation-resource rehydrate fetch (a direct network call) and the poll
// clock are stubbed via deps; the resource picker, image upload, shared storage,
// and the Buzz workflow money path are all served by the mock host.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';

import { App, type AppDeps } from './App.js';
import {
  CKPT_INFO,
  GENERATION_SOURCE_IMAGE,
  LORA_INFO,
  UPLOADED_IMAGE,
  immediateSleep,
} from './test-helpers.js';

function renderApp() {
  const deps: Partial<AppDeps> = {
    // Avoid the real generation-resources network fetch in jsdom; names come
    // from the published `data` blob anyway.
    resolveResources: async () => [],
    pollIntervalMs: 0,
    sleep: immediateSleep,
  };
  render(
    <Harness
      viewer={{ id: 99, username: 'me' }}
      theme="dark"
      consentGranted
      buzzBudget={1000}
      buzz={{ balance: 5000 }}
      buzzBalance={{ blue: 0, green: 0, yellow: 5000 }}
      generation={{ costPerGen: 12, images: ['https://image.civitai.com/e2e-out.jpeg'] }}
      cannedPicks={{ Checkpoint: CKPT_INFO, LORA: LORA_INFO }}
      // The mock host serves BOTH upload purposes: DISPLAY (moderated background)
      // and generationSource (unscanned img2img source, real dims).
      cannedImageUpload={UPLOADED_IMAGE}
      cannedGenerationSourceUpload={GENERATION_SOURCE_IMAGE}
      showLog={false}
    >
      <App deps={deps} />
    </Harness>,
  );
}

describe('e2e: build → publish → discover → open → run', () => {
  it('completes the whole loop against the mock host', async () => {
    renderApp();

    // 1. create + configure a generator
    await userEvent.click(await screen.findByTestId('create-generator'));
    await screen.findByTestId('builder');
    await userEvent.type(screen.getByTestId('gen-name'), 'E2E Neon');
    const editor = screen.getByTestId('button-editor');
    await userEvent.type(within(editor).getByTestId('btn-label-input'), 'Glow');
    await userEvent.click(within(editor).getByTestId('pick-checkpoint'));
    await waitFor(() => expect(within(editor).getByTestId('checkpoint-name')).toHaveTextContent('DreamShaper'));
    // fireEvent.change (not userEvent.type): the `{prompt}` token would be parsed
    // as a special-key sequence by userEvent.
    fireEvent.change(within(editor).getByTestId('btn-prompt-template'), { target: { value: 'neon glow {prompt}' } });

    // 2. publish (through the real mock-host shared store)
    await userEvent.click(screen.getByTestId('publish'));
    await screen.findByTestId('builder-notice');

    // 3. back → the published generator appears in Discover
    await userEvent.click(screen.getByTestId('builder-back'));
    const card = await screen.findByTestId('published-card');
    expect(card).toHaveTextContent('E2E Neon');

    // 4. open it into the runner
    await userEvent.click(within(card).getByTestId('published-open'));
    await screen.findByTestId('runner');
    expect(screen.getByTestId('runner-title')).toHaveTextContent('E2E Neon');

    // 5. run a generation: fill the required prompt → estimate → confirm → submit → poll → result
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    await userEvent.click(screen.getByTestId('gen-button'));
    const cost = await screen.findByTestId('queue-cost');
    expect(cost).toHaveTextContent('12');
    await userEvent.click(screen.getByTestId('queue-confirm'));
    const results = await screen.findByTestId('queue-results', {}, { timeout: 3000 });
    expect(within(results).getAllByTestId('result-image').length).toBeGreaterThan(0);
  });

  it('runs an img2img generator whose source uploads via the generationSource purpose', async () => {
    renderApp();

    // 1. build an img2img generator (workflow=img2img + exposed image input)
    await userEvent.click(await screen.findByTestId('create-generator'));
    await screen.findByTestId('builder');
    await userEvent.type(screen.getByTestId('gen-name'), 'E2E Remix');
    const editor = screen.getByTestId('button-editor');
    await userEvent.type(within(editor).getByTestId('btn-label-input'), 'Remix');
    await userEvent.selectOptions(within(editor).getByTestId('btn-workflow-select'), 'img2img');
    await userEvent.click(within(editor).getByTestId('pick-checkpoint'));
    await waitFor(() => expect(within(editor).getByTestId('checkpoint-name')).toHaveTextContent('DreamShaper'));
    fireEvent.change(within(editor).getByTestId('btn-prompt-template'), { target: { value: 'restyle {prompt}' } });

    // 2. publish → back → open into the runner
    await userEvent.click(screen.getByTestId('publish'));
    await screen.findByTestId('builder-notice');
    await userEvent.click(screen.getByTestId('builder-back'));
    const card = await screen.findByTestId('published-card');
    expect(card).toHaveTextContent('E2E Remix');
    await userEvent.click(within(card).getByTestId('published-open'));
    await screen.findByTestId('runner');

    // 3. the run button is disabled until BOTH required inputs (prompt + source) exist
    expect(screen.getByTestId('gen-button')).toBeDisabled();
    await userEvent.type(screen.getByTestId('runner-prompt'), 'a fox');
    expect(screen.getByTestId('gen-button')).toBeDisabled(); // still missing the source

    // 4. upload the img2img source via the generationSource purpose (real mock host)
    await userEvent.click(screen.getByTestId('upload-source'));
    await screen.findByTestId('source-thumb');
    await waitFor(() => expect(screen.getByTestId('gen-button')).toBeEnabled());

    // 5. run: estimate → confirm → poll → rendered result
    await userEvent.click(screen.getByTestId('gen-button'));
    await userEvent.click(await screen.findByTestId('queue-confirm'));
    const results = await screen.findByTestId('queue-results', {}, { timeout: 3000 });
    expect(within(results).getAllByTestId('result-image').length).toBeGreaterThan(0);
  });
});
