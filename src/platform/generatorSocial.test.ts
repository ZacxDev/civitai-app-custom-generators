// Unit tests for the document-store social service (`generatorSocial.ts`).
//
// The client seam (`./client.js`) is mocked, so these pin the SERVICE's own
// logic — the not_found bootstrap for a first downvote, the count/viewer
// mapping off `getMany`, media dedupe + cap — against an in-memory fake of
// the collection surface. Nothing here has run against civitai: the real
// collections exist only once a manifest declaring them is approved.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageError } from '@civitai/sdk';

import { createGeneratorSocial, DOWNVOTE_COLLECTION, MEDIA_COLLECTION } from './generatorSocial.js';

const hoisted = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('./client.js', () => ({
  getClient: async () => hoisted.client,
}));

interface MarkDoc {
  marks: Record<string, number>;
  viewerMarks: Set<string>;
}

class FakeMarksCollection {
  docs = new Map<string, MarkDoc>();
  increments: Array<[string, string, number]> = [];

  async getMany(keys: readonly string[]) {
    return keys.map((k) => {
      const d = this.docs.get(k);
      if (!d) return null;
      return { marks: { ...d.marks }, viewer: { marks: [...d.viewerMarks] } };
    });
  }

  async mark(key: string, name: string) {
    const d = this.docs.get(key);
    if (!d) throw new StorageError(404, 'not_found', 'no document', null);
    d.viewerMarks.add(name);
    d.marks[name] = (d.marks[name] ?? 0) + 1;
    return { marked: true as const, count: d.marks[name] };
  }

  async unmark(key: string, name: string) {
    const d = this.docs.get(key);
    if (!d) throw new StorageError(404, 'not_found', 'no document', null);
    if (d.viewerMarks.delete(name)) d.marks[name] = Math.max(0, (d.marks[name] ?? 0) - 1);
    return { marked: false as const, count: d.marks[name] ?? 0 };
  }

  async increment(key: string, counter: string, by: number) {
    this.increments.push([key, counter, by]);
    if (!this.docs.has(key)) this.docs.set(key, { marks: {}, viewerMarks: new Set() });
    return { value: by };
  }
}

class FakeMediaCollection {
  docs: Array<{ generatorKey: string; imageIds: number[] }> = [];

  async create(data: { generatorKey: string; imageIds: number[] }) {
    this.docs.unshift({ ...data });
    return { data };
  }

  async list(query: { where?: { generatorKey?: string }; limit?: number }) {
    const key = query.where?.generatorKey;
    const items = this.docs
      .filter((d) => d.generatorKey === key)
      .slice(0, query.limit ?? 30)
      .map((d) => ({ data: { generatorKey: d.generatorKey, imageIds: [...d.imageIds] } }));
    return { items };
  }
}

let marks: FakeMarksCollection;
let media: FakeMediaCollection;

beforeEach(() => {
  marks = new FakeMarksCollection();
  media = new FakeMediaCollection();
  hoisted.client = {
    storage: {
      collection: (name: string) => (name === DOWNVOTE_COLLECTION ? marks : name === MEDIA_COLLECTION ? media : undefined),
    },
  };
});

describe('generatorSocial — downvotes', () => {
  it('reads count + the viewer’s own state back from getMany; missing docs are absent', async () => {
    marks.docs.set('k1', { marks: { downvote: 3 }, viewerMarks: new Set(['downvote']) });
    marks.docs.set('k2', { marks: { downvote: 1 }, viewerMarks: new Set() });
    const social = createGeneratorSocial();
    const out = await social.getDownvotes(['k1', 'k2', 'gone']);
    expect(out).toEqual({
      k1: { count: 3, downvoted: true },
      k2: { count: 1, downvoted: false },
    });
  });

  it('marks and unmarks on an existing document, returning the count', async () => {
    marks.docs.set('k1', { marks: {}, viewerMarks: new Set() });
    const social = createGeneratorSocial();
    await expect(social.setDownvote('k1', true)).resolves.toEqual({ count: 1 });
    await expect(social.setDownvote('k1', false)).resolves.toEqual({ count: 0 });
    expect(marks.increments).toHaveLength(0);
  });

  it('🔴 the FIRST downvote bootstraps the document via the anchor increment, then marks', async () => {
    const social = createGeneratorSocial();
    await expect(social.setDownvote('fresh', true)).resolves.toEqual({ count: 1 });
    expect(marks.increments).toEqual([['fresh', 'anchor', 1]]);
    expect(marks.docs.get('fresh')?.viewerMarks.has('downvote')).toBe(true);
  });

  it('an unmark on a missing document propagates not_found (no bootstrap for off)', async () => {
    const social = createGeneratorSocial();
    await expect(social.setDownvote('gone', false)).rejects.toMatchObject({ code: 'not_found' });
    expect(marks.increments).toHaveLength(0);
  });
});

describe('generatorSocial — published media', () => {
  it('dedupes image ids across a generator’s kept runs, newest first, capped at 3', async () => {
    media.docs = [
      { generatorKey: 'k1', imageIds: [10, 11] },
      { generatorKey: 'k1', imageIds: [12, 10, 13] },
      { generatorKey: 'k2', imageIds: [20] },
    ];
    const social = createGeneratorSocial();
    const out = await social.getPublishedMedia(['k1', 'k2', 'none']);
    expect(out).toEqual({ k1: [10, 11, 12], k2: [20] });
  });

  it('records a kept run, slicing to the first 4 image ids', async () => {
    const social = createGeneratorSocial();
    await social.recordPublishedMedia('k1', [1, 2, 3, 4, 5, 6]);
    expect(media.docs).toEqual([{ generatorKey: 'k1', imageIds: [1, 2, 3, 4] }]);
  });
});
