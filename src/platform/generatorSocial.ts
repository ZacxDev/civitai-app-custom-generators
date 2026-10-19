// Generator social signals on the DOCUMENT STORE, in two collections declared
// in block.manifest.json (`storage.collections`) beside `kv` and `records`:
//
//   - `generator_marks` (shared, write "none", marks ["downvote"],
//     counters ["anchor"]): per-viewer DOWNVOTES on a published generator,
//     keyed by the generator's `records` key. The `records` upvote is the
//     `vote` mark on the generator's own document, which only up-counts, so
//     downvotes live here as a mark —
//     one per viewer per generator, with the count and the viewer's own
//     state read back on every document. A mark needs an existing document;
//     in a write-"none" collection the first INCREMENT creates one, so the
//     first downvote on a generator bootstraps its document with the
//     otherwise-unused `anchor` counter, then marks it.
//   - `generator_media` (shared, write "own", index on `generatorKey`):
//     one document per KEPT RUN, written by the viewer who kept it, naming
//     the generator and the published Image ids the keep produced. Browse
//     reads these back per generator so a card can show real published
//     output — the board alone cannot know this: kept runs are per-viewer
//     private storage, and only the generator's author can update the
//     generator's own document.
//
// 🔴 `generator_marks` documents share their key with a `records` document.
// civitai resolves an App Store item key across ITEM collections only
// (civitai/civitai#6296); without that, every downvoted generator's key would
// be ambiguous and its store card refused.
//
// Both collections exist only once a manifest declaring them is APPROVED
// (the server reads the approved manifest), so before that every call is
// refused `collection_not_declared` / `not_eligible` — callers treat this
// whole service as best-effort and fail closed to "no signal".

import { StorageError } from '@civitai/sdk';
import { getClient } from './client.js';
import type {
  DownvoteState,
  GeneratorMediaDoc,
  GeneratorSocial,
} from './types.js';

export const DOWNVOTE_COLLECTION = 'generator_marks';
export const MEDIA_COLLECTION = 'generator_media';
export const DOWNVOTE_MARK = 'downvote';
const ANCHOR_COUNTER = 'anchor';
/** Thumbnails a card shows at most — the strip is a presence signal, not a gallery. */
export const MEDIA_THUMBNAILS_PER_GENERATOR = 3;
/** Image ids recorded per kept run (a run's first outputs are its face). */
export const MEDIA_IDS_PER_RUN = 4;

function isNotFound(e: unknown): boolean {
  return e instanceof StorageError && e.code === 'not_found';
}

export function createGeneratorSocial(): GeneratorSocial {
  return {
    async getDownvotes(keys) {
      const out: Record<string, DownvoteState> = {};
      if (keys.length === 0) return out;
      const app = await getClient();
      const col = app.storage.collection(DOWNVOTE_COLLECTION);
      // getMany caps at 100 keys per call; the board never reaches it, but
      // chunk rather than assume.
      for (let i = 0; i < keys.length; i += 100) {
        const slice = keys.slice(i, i + 100);
        const docs = await col.getMany(slice);
        docs.forEach((doc, j) => {
          if (!doc) return;
          out[slice[j]] = {
            count: doc.marks[DOWNVOTE_MARK] ?? 0,
            downvoted: doc.viewer?.marks.includes(DOWNVOTE_MARK) ?? false,
          };
        });
      }
      return out;
    },

    async setDownvote(key, on) {
      const app = await getClient();
      const col = app.storage.collection(DOWNVOTE_COLLECTION);
      try {
        const res = on ? await col.mark(key, DOWNVOTE_MARK) : await col.unmark(key, DOWNVOTE_MARK);
        return { count: res.count ?? 0 };
      } catch (e) {
        // First downvote on this generator: no document exists yet. In a
        // write-"none" collection an increment creates it — then mark.
        if (on && isNotFound(e)) {
          await col.increment(key, ANCHOR_COUNTER, 1);
          const res = await col.mark(key, DOWNVOTE_MARK);
          return { count: res.count ?? 0 };
        }
        throw e;
      }
    },

    async getPublishedMedia(keys) {
      const out: Record<string, number[]> = {};
      if (keys.length === 0) return out;
      const app = await getClient();
      const col = app.storage.collection<GeneratorMediaDoc>(MEDIA_COLLECTION);
      await Promise.all(
        keys.map(async (key) => {
          const page = await col.list({
            where: { generatorKey: key },
            sort: '-createdAt',
            limit: 3,
          });
          const ids: number[] = [];
          for (const doc of page.items) {
            for (const id of doc.data.imageIds ?? []) {
              if (typeof id === 'number' && !ids.includes(id)) ids.push(id);
              if (ids.length >= MEDIA_THUMBNAILS_PER_GENERATOR) break;
            }
            if (ids.length >= MEDIA_THUMBNAILS_PER_GENERATOR) break;
          }
          if (ids.length > 0) out[key] = ids;
        }),
      );
      return out;
    },

    async recordPublishedMedia(generatorKey, imageIds) {
      const app = await getClient();
      const col = app.storage.collection<GeneratorMediaDoc>(MEDIA_COLLECTION);
      await col.create({
        generatorKey,
        imageIds: imageIds.slice(0, MEDIA_IDS_PER_RUN),
      });
    },
  };
}
