// The per-collection document SCHEMAS in `block.manifest.json`
// (`storage.collections.<name>.schema`, civitai/civitai#7491): the store refuses a
// create or put whose body does not match, with 400 `schema_violation`.
//
// 🔴 A SCHEMA THAT REFUSES A REAL WRITE BREAKS THE APP, AND ONE THAT ACCEPTS
// ANYTHING GUARDS NOTHING. So every case below runs one of two ways:
//   - "accepts": the document as the app's OWN code writes it — through the real
//     adapters onto the SDK's contract fake, read back raw, so it is the JSON that
//     crosses the wire (an `undefined` field is absent, as the store sees it) — plus
//     the shapes the go-live copy wrote and older rows that are still re-saved;
//   - "refuses": one defect per case, asserted down to the failing path and keyword,
//     so a schema that refuses for some other reason cannot hold the case green.
//
// ⚠️ THE EVALUATOR HERE IS AJV, NOT THE STORE. The installed `@civitai/sdk` fake
// does not enforce schemas yet (the TRIPWIRE at the bottom says so and fails when
// it starts to), and the store's own evaluator is server code. Ajv (draft 2020-12)
// implements every keyword of the subset with the store's semantics: lengths in
// code points, `pattern` with the `u` flag, keywords ignored on a value of another
// type, `required`/`additionalProperties` over own keys. The subset itself — which
// keywords exist, the depth, size and pattern bounds — is civitai's
// `parseCollectionSchema`; the mirror below is a local pre-check of it, and the
// authority is the submit.

import { describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

import { createFakeStorage } from '@civitai/sdk/testing';

import manifest from '../block.manifest.json';
import { listDrafts, saveDraft, type StoredDraft } from './lib/drafts.js';
import { EXAMPLE_GENERATORS } from './lib/examples.js';
import {
  buildPublishPayload,
  cloneConfigForFork,
  MAX_LORAS,
  newButton,
  newGenerator,
  parsePublishedGenerator,
  validateGenerator,
} from './lib/generator.js';
import { removeKeptImages, saveKeptRun, type KeptRun } from './lib/runs.js';
import { backfillLedgerIn } from './lib/storeListing.js';
import { createAppStorage } from './platform/appStorage.js';
import { KV_COLLECTION, RECORDS_COLLECTION } from './platform/docStore.js';
import { createGeneratorSocial, MEDIA_COLLECTION, MEDIA_IDS_PER_RUN } from './platform/generatorSocial.js';
import { createSharedStorage } from './platform/sharedStorage.js';
import type { SharedAppendValue } from './platform/types.js';
import type { GeneratorConfig } from './types.js';

// `recordPublishedMedia` reaches the store through the initialised client; the
// media case below hands it a collection that records the create body.
const hoisted = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('./platform/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./platform/client.js')>()),
  getClient: async () => hoisted.client,
}));

type Schema = Record<string, unknown>;
const collections = (manifest as unknown as { storage: { collections: Record<string, { write?: string; schema?: Schema }> } })
  .storage.collections;

const schemaOf = (name: string): Schema => {
  const schema = collections[name]?.schema;
  if (!schema) throw new Error(`storage.collections.${name} declares no schema`);
  return schema;
};

const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
const validators = new Map<string, ValidateFunction>();
function validatorFor(name: string): ValidateFunction {
  let v = validators.get(name);
  if (!v) {
    v = ajv.compile(schemaOf(name));
    validators.set(name, v);
  }
  return v;
}

/** Wire form: what the store receives (an `undefined` field is absent). */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function expectAccepted(name: string, data: unknown) {
  const v = validatorFor(name);
  const ok = v(data);
  expect(ok, `${name} refused a real write: ${JSON.stringify(v.errors)}`).toBe(true);
}

function expectRefused(name: string, data: unknown, at: { instancePath: string; keyword: string }) {
  const v = validatorFor(name);
  expect(v(data)).toBe(false);
  expect(v.errors?.map((e) => ({ instancePath: e.instancePath, keyword: e.keyword }))).toContainEqual(at);
}

const ALICE = { username: 'alice', id: 99 };
const ULID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

/** A generator with every field the Builder can set, picker metadata included. */
function fullConfig(): GeneratorConfig {
  return newGenerator({
    name: 'Neon Portraits',
    description: 'Glowing portraits.',
    promptPlaceholder: 'a person, a pet…',
    headerImageRef: { imageId: 11, url: 'https://image.example/11.jpeg' },
    coverImageId: 12,
    storeImage: { imageId: 13, url: 'https://image.example/13.jpeg' },
    buttons: [
      newButton({
        label: 'Glow',
        workflowType: 'img2img',
        checkpoint: { versionId: 1001, modelId: 500, modelName: 'DreamShaper', versionName: '8', baseModel: 'SD 1.5' },
        loras: Array.from({ length: MAX_LORAS }, (_, i) => ({
          versionId: 2000 + i,
          weight: 0.75,
          modelName: `L${i}`,
          versionName: 'v1',
          minStrength: 0,
          maxStrength: 1.5,
          trainedWords: ['neon'],
        })),
        promptTemplate: 'neon portrait of {prompt}',
        params: { negativePrompt: 'blurry', cfgScale: 6.5, steps: 30, sampler: 'Euler a', width: 832, height: 1216, seed: 42, quantity: 2 },
      }),
      // The Builder's defaults otherwise: an empty negative prompt, seed `null`.
      newButton({ checkpoint: { versionId: 1002, modelId: 501 } }),
    ],
  });
}

/**
 * A published row from before the current write path: a button still carrying the
 * retired `exposedInputs` flag, a minimal button with no id, params, template or
 * workflow type (the shape `platform/sharedStorage.test.ts` holds as legacy), and
 * the cover under the pre-rename `backgroundImageRef`. The board still reads it, and
 * the owner's first keep re-saves it with a `coverImageId` added (App.tsx
 * `fillEmptyCover`), so the schema must take it.
 */
const LEGACY_ROW = {
  title: 'Lego guy',
  body: 'Brick portraits.\nButtons:\n• Brick: lego minifig of {prompt}\n• Glow',
  data: {
    v: 1,
    buttons: [
      {
        id: 'btn_old_1',
        label: 'Brick',
        workflowType: 'txt2img',
        checkpoint: { versionId: 1001, modelId: 500, modelName: 'DreamShaper' },
        loras: [{ versionId: 2002, weight: 0.8, modelName: 'Neon', trainedWords: ['neon'] }],
        promptTemplate: 'lego minifig of {prompt}',
        params: { negativePrompt: '', cfgScale: 4, steps: 25, sampler: 'Euler', width: 1024, height: 1024, seed: null, quantity: 1 },
        exposedInputs: { prompt: true, image: false },
      },
      { label: 'Glow', loras: [{ versionId: 2002, weight: 0.8 }] },
    ],
    backgroundImageRef: { imageId: 77, url: 'https://image.example/77.jpeg' },
  },
};

const KEPT: KeptRun = {
  id: 'kept_mgq1x2_4_cd34',
  keptAt: 1_760_000_000_500,
  imageIds: [101, 102, 103],
  generatorName: 'Neon Portraits',
  generatorKey: ULID,
  buttonLabel: 'Glow',
  prompt: 'a cat',
};

function fakeStore() {
  const fake = createFakeStorage({ manifest, viewer: ALICE });
  const raw = (coll: string) => fake.storage.collection<Record<string, unknown>>(coll);
  return { fake, raw };
}

describe('collection schemas: where they are declared', () => {
  it('kv, records and generator_media declare one; generator_marks (write "none") cannot', () => {
    expect(Object.entries(collections).filter(([, c]) => c.schema).map(([n]) => n)).toEqual([
      'kv',
      'records',
      'generator_media',
    ]);
    expect(collections.generator_marks?.write).toBe('none');
  });
});

/**
 * A LOCAL MIRROR of civitai's `parseCollectionSchema` bounds — so a schema the
 * submit would refuse fails here first. Not the authority (that is the submit, and
 * the CLI's `civitai app validate` once it knows schemas); the submit-time ReDoS
 * analysis is not mirrored.
 */
const SUBSET_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'description',
]);

function subsetProblems(schema: Schema): { problems: string[]; patterns: number } {
  const problems: string[] = [];
  let patterns = 0;
  const bytes = new TextEncoder().encode(JSON.stringify(schema)).length;
  if (bytes > 16 * 1024) problems.push(`${bytes} bytes`);
  const walk = (node: unknown, at: string, depth: number) => {
    if (depth > 16) return void problems.push(`${at}: deeper than 16`);
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return void problems.push(`${at}: not a schema object`);
    const n = node as Schema;
    for (const k of Object.keys(n)) if (!SUBSET_KEYWORDS.has(k)) problems.push(`${at}: keyword ${k}`);
    if (n.pattern !== undefined) {
      patterns += 1;
      try {
        new RegExp(String(n.pattern), 'u');
      } catch {
        problems.push(`${at}: pattern does not compile with u`);
      }
      if (!(typeof n.maxLength === 'number' && n.maxLength <= 1000)) problems.push(`${at}: pattern without maxLength <= 1000`);
    }
    if (n.properties && typeof n.properties === 'object') {
      for (const [k, sub] of Object.entries(n.properties)) walk(sub, `${at}.properties.${k}`, depth + 1);
    }
    if (n.items !== undefined) walk(n.items, `${at}.items`, depth + 1);
    if (n.additionalProperties !== undefined && typeof n.additionalProperties !== 'boolean') {
      walk(n.additionalProperties, `${at}.additionalProperties`, depth + 1);
    }
  };
  walk(schema, 'schema', 1);
  return { problems, patterns };
}

describe('collection schemas: inside the subset the store accepts', () => {
  it('the mirror itself reports a keyword, a bare pattern and a depth it must (positive control)', () => {
    let deep: Schema = { type: 'string' };
    for (let i = 0; i < 16; i++) deep = { type: 'array', items: deep };
    expect(subsetProblems({ type: 'object', properties: { a: { type: 'string', format: 'uri' }, b: { type: 'string', pattern: '^x$' } } }))
      .toEqual({ problems: ['schema.properties.a: keyword format', 'schema.properties.b: pattern without maxLength <= 1000'], patterns: 1 });
    expect(subsetProblems(deep).problems).toEqual([`schema${'.items'.repeat(16)}: deeper than 16`]);
  });

  it('every declared schema uses only subset keywords, within depth, size and pattern bounds', () => {
    let total = 0;
    for (const name of ['kv', 'records', 'generator_media']) {
      const { problems, patterns } = subsetProblems(schemaOf(name));
      expect(problems, name).toEqual([]);
      expect(patterns, name).toBeLessThanOrEqual(16);
      total += patterns;
    }
    expect(total).toBeLessThanOrEqual(32);
  });

  it('the evaluator counts characters as code points and compiles patterns with u, as the store does', () => {
    // A title of 200 emoji is 400 UTF-16 units: the store accepts it, so must this.
    expectAccepted('records', { title: '🎨'.repeat(200) });
    expectRefused('records', { title: '🎨'.repeat(201) }, { instancePath: '/title', keyword: 'maxLength' });
  });
});

describe('kv: accepts every document the app writes', () => {
  it('a draft, a kept run, a pruned kept run and the backfill ledger, as the adapters store them', async () => {
    const { fake, raw } = fakeStore();
    const kv = createAppStorage(() => fake.storage);
    const draft: StoredDraft = { id: 'gen_mgq1x2_3_ab12', config: fullConfig(), updatedAt: 1_760_000_000_000, publishedKey: ULID };
    await saveDraft(kv, draft);
    await saveDraft(kv, { id: 'gen_fresh', config: newGenerator(), updatedAt: 1 });
    await saveKeptRun(kv, KEPT);
    await saveKeptRun(kv, { id: 'kept_bare', keptAt: 2, imageIds: [7], generatorName: 'Untitled generator', buttonLabel: 'Go' });
    await removeKeptImages(kv, [KEPT], [101]);
    await backfillLedgerIn(kv).set({ v: 1, lastRunAt: 1_760_000_000_000, refused: [ULID] });

    const keys = ['draft:gen_mgq1x2_3_ab12', 'draft:gen_fresh', `kept:${KEPT.id}`, 'kept:kept_bare', 'store-backfill:v1'];
    for (const key of keys) {
      const doc = await raw(KV_COLLECTION).get(key);
      expect(doc, key).not.toBeNull();
      expectAccepted('kv', doc!.data);
    }
    // The pruned run really was rewritten (not left as it was).
    expect((await raw(KV_COLLECTION).get(`kept:${KEPT.id}`))!.data).toEqual({ value: { ...KEPT, imageIds: [102, 103] } });
  });

  it('a draft forked from an old published row (Make a copy)', () => {
    const parsed = parsePublishedGenerator(LEGACY_ROW as SharedAppendValue);
    expect(parsed).not.toBeNull();
    expectAccepted('kv', wire({ value: { id: 'gen_fork', config: cloneConfigForFork(parsed!), updatedAt: 3 } }));
  });

  it('each key family exactly as the go-live copy wrote it: data = {"value": <legacy value>}', async () => {
    const { fake, raw } = fakeStore();
    const ledger = { v: 1, lastRunAt: 1_760_000_000_000, refused: ['01JREFUSED0000000000000000'] };
    await raw(KV_COLLECTION).put('store-backfill:v1', { value: ledger });
    const kv = createAppStorage(() => fake.storage);
    expect(await backfillLedgerIn(kv).get()).toEqual(ledger);
    for (const value of [
      { id: 'gen_legacy', config: wire(fullConfig()), updatedAt: 1_755_000_000_000, publishedKey: ULID },
      KEPT,
      ledger,
    ]) {
      expectAccepted('kv', { value });
    }
    await raw(KV_COLLECTION).put('draft:gen_legacy', { value: { id: 'gen_legacy', config: wire(fullConfig()), updatedAt: 1 } });
    expect(await listDrafts(kv)).toHaveLength(1);
  });
});

describe('kv: refuses', () => {
  const draft = () => wire({ id: 'gen_a', config: fullConfig(), updatedAt: 1 });

  it('a document without the {value} envelope', () => {
    expectRefused('kv', draft(), { instancePath: '', keyword: 'required' });
  });
  it('a second top-level key beside value', () => {
    expectRefused('kv', { value: draft(), extra: 1 }, { instancePath: '', keyword: 'additionalProperties' });
  });
  it('a value that is not an object', () => {
    expectRefused('kv', { value: 'a string' }, { instancePath: '/value', keyword: 'type' });
  });
  it('a kept run whose image ids are strings, or empty', () => {
    expectRefused('kv', { value: { ...KEPT, imageIds: ['101'] } }, { instancePath: '/value/imageIds/0', keyword: 'type' });
    expectRefused('kv', { value: { ...KEPT, imageIds: [] } }, { instancePath: '/value/imageIds', keyword: 'minItems' });
  });
  it('a generator key that is not a store key', () => {
    expectRefused('kv', { value: { ...KEPT, generatorKey: 'two words' } }, { instancePath: '/value/generatorKey', keyword: 'pattern' });
  });
  it('a ledger of another version', () => {
    expectRefused('kv', { value: { v: 2, lastRunAt: 1, refused: [] } }, { instancePath: '/value/v', keyword: 'const' });
  });
  it('a draft whose button has more LoRAs than a button can hold', () => {
    const d = draft();
    d.config.buttons[0]!.loras.push({ versionId: 9999, weight: 1 });
    expectRefused('kv', { value: d }, { instancePath: '/value/config/buttons/0/loras', keyword: 'maxItems' });
  });
});

describe('records: accepts every document the app writes', () => {
  function shared() {
    const { fake, raw } = fakeStore();
    return { raw, shared: createSharedStorage({ docs: () => fake.storage, viewerId: () => ALICE.id }) };
  }

  it('a publish and an edit, through the adapter, for the full config and every example generator', async () => {
    const { raw, shared: board } = shared();
    expect(validateGenerator(fullConfig())).toEqual([]);
    for (const config of [fullConfig(), ...EXAMPLE_GENERATORS]) {
      const { key } = await board.append(buildPublishPayload(config));
      expectAccepted('records', (await raw(RECORDS_COLLECTION).get(key))!.data);
      await board.update(key, buildPublishPayload({ ...config, description: 'Edited.' }));
      expectAccepted('records', (await raw(RECORDS_COLLECTION).get(key))!.data);
    }
  });

  it('the longest text publish lets through: a 200-character name and a 4096-character body', () => {
    const config = newGenerator({
      name: '🎨'.repeat(200),
      buttons: [newButton({ label: 'Go', checkpoint: { versionId: 1, modelId: 2 }, promptTemplate: 'p' })],
    });
    config.description = 'd'.repeat(4096 - '\nButtons:\n• Go: p'.length);
    expect(validateGenerator(config)).toEqual([]);
    expectAccepted('records', wire(buildPublishPayload(config)));
  });

  it('an old row as the copy carried it, and its re-save with a cover added (fillEmptyCover)', async () => {
    const { raw, shared: board } = shared();
    expectAccepted('records', LEGACY_ROW);
    await raw(RECORDS_COLLECTION).put(ULID, LEGACY_ROW);
    const row = await board.get(ULID);
    await board.update(ULID, { ...row!.value, data: { ...(row!.value.data as object), coverImageId: 501 } }, { ifVersion: row!.version });
    const stored = (await raw(RECORDS_COLLECTION).get(ULID))!.data;
    expect((stored.data as { coverImageId?: number }).coverImageId).toBe(501);
    expectAccepted('records', stored);
  });
});

describe('records: refuses', () => {
  const payload = () => wire(buildPublishPayload(fullConfig()));

  it('a row without a title, or with an empty one', () => {
    const rest: Record<string, unknown> = { ...payload() };
    delete rest.title;
    expectRefused('records', rest, { instancePath: '', keyword: 'required' });
    expectRefused('records', { ...payload(), title: '' }, { instancePath: '/title', keyword: 'minLength' });
  });
  it('text past the bounds', () => {
    expectRefused('records', { ...payload(), title: 'a'.repeat(201) }, { instancePath: '/title', keyword: 'maxLength' });
    expectRefused('records', { ...payload(), body: 'a'.repeat(4097) }, { instancePath: '/body', keyword: 'maxLength' });
  });
  it('a key outside {title, body, data}', () => {
    expectRefused('records', { ...payload(), author: 'someone' }, { instancePath: '', keyword: 'additionalProperties' });
  });
  it('a data blob of another version, or without buttons', () => {
    expectRefused('records', { ...payload(), data: { ...payload().data as object, v: 2 } }, { instancePath: '/data/v', keyword: 'const' });
    expectRefused('records', { ...payload(), data: { v: 1 } }, { instancePath: '/data', keyword: 'required' });
    expectRefused('records', { ...payload(), data: { v: 1, buttons: 'nope' } }, { instancePath: '/data/buttons', keyword: 'type' });
  });
  it('a button with an unknown workflow, too many LoRAs, or a fractional checkpoint id', () => {
    const at = (button: Record<string, unknown>) => ({ ...payload(), data: { v: 1, buttons: [button] } });
    expectRefused('records', at({ workflowType: 'video' }), { instancePath: '/data/buttons/0/workflowType', keyword: 'enum' });
    expectRefused(
      'records',
      at({ loras: Array.from({ length: MAX_LORAS + 1 }, (_, i) => ({ versionId: i, weight: 1 })) }),
      { instancePath: '/data/buttons/0/loras', keyword: 'maxItems' },
    );
    expectRefused('records', at({ checkpoint: { versionId: 1.5, modelId: 2 } }), { instancePath: '/data/buttons/0/checkpoint/versionId', keyword: 'type' });
  });
  it('an image id that is not a positive whole number', () => {
    expectRefused('records', { ...payload(), data: { v: 1, buttons: [], storeImageId: 0 } }, { instancePath: '/data/storeImageId', keyword: 'minimum' });
    expectRefused('records', { ...payload(), data: { v: 1, buttons: [], coverImageId: '12' } }, { instancePath: '/data/coverImageId', keyword: 'type' });
  });
});

describe('generator_media: accepts what recordPublishedMedia creates', () => {
  it('for a store-minted key and an example generator key, from 1 and from 6 kept images', async () => {
    const created: unknown[] = [];
    hoisted.client = { storage: { collection: (name: string) => (name === MEDIA_COLLECTION ? { create: async (d: unknown) => void created.push(wire(d)) } : undefined) } };
    const social = createGeneratorSocial();
    await social.recordPublishedMedia(ULID, [101]);
    await social.recordPublishedMedia('example:0', [1, 2, 3, 4, 5, 6]);
    expect(created).toHaveLength(2);
    for (const doc of created) expectAccepted('generator_media', doc);
  });
});

describe('generator_media: refuses', () => {
  const doc = { generatorKey: ULID, imageIds: [101] };
  it('no generator key, or one that is not a store key', () => {
    expectRefused('generator_media', { imageIds: [1] }, { instancePath: '', keyword: 'required' });
    expectRefused('generator_media', { ...doc, generatorKey: 'k'.repeat(129) }, { instancePath: '/generatorKey', keyword: 'maxLength' });
    expectRefused('generator_media', { ...doc, generatorKey: 'a/b' }, { instancePath: '/generatorKey', keyword: 'pattern' });
  });
  it('more image ids than a run records, none, or a non-id', () => {
    expectRefused('generator_media', { ...doc, imageIds: [1, 2, 3, 4, 5] }, { instancePath: '/imageIds', keyword: 'maxItems' });
    expectRefused('generator_media', { ...doc, imageIds: [] }, { instancePath: '/imageIds', keyword: 'minItems' });
    expectRefused('generator_media', { ...doc, imageIds: [0] }, { instancePath: '/imageIds/0', keyword: 'minimum' });
  });
  it('any other field', () => {
    expectRefused('generator_media', { ...doc, url: 'https://image.example/1.jpeg' }, { instancePath: '', keyword: 'additionalProperties' });
  });
});

/**
 * 🔴 THE APP'S OWN CAPS AND THE SCHEMA'S MUST BE ONE NUMBER. A schema tighter than
 * the app refuses a write the app thinks is fine (the viewer gets a failed publish
 * or a lost keep); a schema looser than the app guards less than it says. Pinned as
 * relationships, measured on the app's behaviour where the cap is behaviour.
 */
describe('collection schemas: the bounds equal the app’s own', () => {
  const props = (s: Schema) => s.properties as Record<string, Schema>;
  const buttonOf = (buttons: Schema) => props(buttons.items as Schema);

  it('a button holds at most MAX_LORAS LoRAs, in a published row and in a draft', () => {
    const recordButtons = props(props(schemaOf('records')).data!).buttons!;
    const draftButtons = props(props(props(schemaOf('kv')).value!).config!).buttons!;
    expect(buttonOf(recordButtons).loras!.maxItems).toBe(MAX_LORAS);
    expect(buttonOf(draftButtons).loras!.maxItems).toBe(MAX_LORAS);
  });

  it('a media document holds at most MEDIA_IDS_PER_RUN image ids', () => {
    expect(props(schemaOf('generator_media')).imageIds!.maxItems).toBe(MEDIA_IDS_PER_RUN);
  });

  it('publish refuses exactly the title and body lengths the records schema refuses', () => {
    const title = props(schemaOf('records')).title!.maxLength as number;
    const body = props(schemaOf('records')).body!.maxLength as number;
    const button = newButton({ label: 'Go', checkpoint: { versionId: 1, modelId: 2 }, promptTemplate: 'p' });
    const withName = (name: string) => validateGenerator(newGenerator({ name, buttons: [button] }));
    expect(withName('a'.repeat(title))).toEqual([]);
    expect(withName('a'.repeat(title + 1))).toHaveLength(1);
    const withBody = (n: number) =>
      validateGenerator(newGenerator({ name: 'X', description: 'd'.repeat(n - '\nButtons:\n• Go: p'.length), buttons: [button] }));
    expect(withBody(body)).toEqual([]);
    expect(withBody(body + 1)).toHaveLength(1);
  });
});

/**
 * TRIPWIRE (not a regression test): the installed `@civitai/sdk` contract fake
 * ignores `schema`, so neither these tests' fake nor the dev harness / mock host
 * (`src/platform/testing.tsx`, which builds the same fake over this same
 * `block.manifest.json`) refuses a schema-violating write yet. civitai-app-starters
 * #789 makes the fake enforce the manifest's schemas with the store's own messages.
 * When an SDK bump makes THIS case fail, every fake-backed test in the repo starts
 * running under the schemas with no change here: replace this case with the same
 * write asserted refused `schema_violation`.
 */
describe('TRIPWIRE: the installed SDK fake', () => {
  it('does not enforce collection schemas yet', async () => {
    const { raw } = fakeStore();
    await raw(KV_COLLECTION).put('draft:unwrapped', { notWrapped: true });
    expect((await raw(KV_COLLECTION).get('draft:unwrapped'))?.data).toEqual({ notWrapped: true });
  });
});
