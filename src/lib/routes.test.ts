import { describe, expect, it } from 'vitest';

import { parseAppRoute, routeForPage, type AppRoute } from './routes.js';

describe('parseAppRoute', () => {
  it('maps the browse sections', () => {
    expect(parseAppRoute('')).toEqual({ kind: 'browse', section: 'discover' });
    expect(parseAppRoute('mine')).toEqual({ kind: 'browse', section: 'mine' });
    expect(parseAppRoute('gallery')).toEqual({ kind: 'browse', section: 'kept' });
  });

  it('maps runner, draft-runner and builder pages', () => {
    expect(parseAppRoute('g/KEY_1-2')).toEqual({ kind: 'runner', key: 'KEY_1-2' });
    expect(parseAppRoute('d/gen_abc')).toEqual({ kind: 'draft-runner', draftId: 'gen_abc' });
    expect(parseAppRoute('build')).toEqual({ kind: 'builder', draftId: null });
    expect(parseAppRoute('build/gen_abc')).toEqual({ kind: 'builder', draftId: 'gen_abc' });
  });

  it.each([null, undefined, 'settings', 'generate', 'mine/x', 'build/', 'build/a/b', 'd/', 'd/a b', '../mine', '/mine'])(
    'rejects %s',
    (sub) => {
      expect(parseAppRoute(sub as string | null)).toBeNull();
    },
  );

  it('round-trips every page shape', () => {
    const pages: AppRoute[] = [
      { kind: 'browse', section: 'discover' },
      { kind: 'browse', section: 'mine' },
      { kind: 'browse', section: 'kept' },
      { kind: 'runner', key: 'K1' },
      { kind: 'draft-runner', draftId: 'gen_1' },
      { kind: 'builder', draftId: null },
      { kind: 'builder', draftId: 'gen_1' },
    ];
    for (const p of pages) expect(parseAppRoute(routeForPage(p))).toEqual(p);
  });
});
