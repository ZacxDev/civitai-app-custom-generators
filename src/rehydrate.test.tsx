// Exercises the REAL useGenerationResources() hook end-to-end: under the mock
// host (which supplies the validated host origin + block token) with a stubbed
// global fetch standing in for `GET /api/v1/blocks/generation-resources`. Proves
// the rehydrate wiring (buildGenerationResourcesUrl + responseToResources) that
// the App uses to re-resolve a saved generator's resources on open.

import { useEffect, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Harness } from '@civitai/blocks-react/testing';
import { useGenerationResources } from '@civitai/blocks-react';

function Probe() {
  const { fetch } = useGenerationResources();
  const [out, setOut] = useState<string>('loading');
  useEffect(() => {
    fetch([1001, 2002])
      .then((r) => {
        if (r.length) setOut(r.map((x) => `${x.versionId}:${x.modelName}:${x.strength ?? ''}`).join('|'));
      })
      .catch(() => {});
  }, [fetch]);
  return <div data-testid="out">{out}</div>;
}

describe('useGenerationResources — real hook, stubbed fetch', () => {
  it('fetches the generation-resources endpoint and maps the widened projection', async () => {
    const body = {
      items: [
        { versionId: 1001, modelId: 500, modelName: 'DreamShaper', versionName: '8', baseModel: 'SD 1.5', modelType: 'Checkpoint' },
        { versionId: 2002, modelId: 900, modelName: 'Neon Glow', versionName: 'v2', baseModel: 'SD 1.5', modelType: 'LORA', strength: 0.8, minStrength: 0, maxStrength: 1.5, trainedWords: ['neon'] },
      ],
    };
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Harness viewer={{ id: 99, username: 'me' }} showLog={false}>
        <Probe />
      </Harness>,
    );

    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('1001:DreamShaper'));
    expect(screen.getByTestId('out')).toHaveTextContent('2002:Neon Glow:0.8');

    const url = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('/api/v1/blocks/generation-resources');
    expect(url).toContain('ids=');
  });
});
