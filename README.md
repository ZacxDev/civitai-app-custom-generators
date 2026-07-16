# Custom Generators — a Civitai App Block

A first-party **Civitai App Block**: a full-page app, hosted inside a sandboxed
iframe on civitai.com, where users **build**, **publish**, and **run** image
generation "generators".

A *generator* is a named set of buttons, each carrying a full image-generation
payload — a pinned checkpoint, a weighted LoRA stack, a prompt template with an
optional `{prompt}` slot, and generation params. An author builds one in the
**Builder**, publishes it to shared app storage, and anyone can then **discover**
it and **run** it (spending their own Buzz).

> **The platform has no concept of a "generator."** That entire model is owned by
> this app. The Civitai App Blocks platform only provides generic, capability-scoped
> seams (a resource picker, a moderated image upload, a Buzz generation-workflow
> bridge, per-app private + cross-user shared storage). This repo is meant as a
> **reference** for those primitives — see [`src/App.tsx`](src/App.tsx), which owns
> every host hook, and [`src/lib/generator.ts`](src/lib/generator.ts), the pure,
> unit-tested core.

This is an open-source reference extraction of a shipping first-party block; it
builds standalone against the **published** `@civitai/app-sdk` +
`@civitai/blocks-react` packages.

## App Blocks platform primitives this demonstrates

Every host capability is a React hook from
[`@civitai/blocks-react`](https://www.npmjs.com/package/@civitai/blocks-react),
assembled into an injectable dependency bag in [`src/App.tsx`](src/App.tsx) so the
whole app is testable against the SDK's mock host.

| Primitive | Hook | Used for |
|---|---|---|
| **Cross-user shared storage** | `useSharedStorage()` | The community list of published generators. Exposes `list` / `append` / `update` / `vote` / `unvote` / `withdraw` / `getCount(s)` — an append-only, votable, author-scoped datastore. **Publish** = `append({ title, body, data })`; **edit in place** = `update(key, …)`; **delete** = `withdraw(key)`; **vote** = `vote(key)`. |
| **Buzz generation-workflow bridge** | `useBuzzWorkflow()` | The money path. `estimate(body)` → `submit(body)` → `poll(workflowId)` runs a generation and prices/charges the viewer's Buzz. The block never sees credentials — the host injects the token + viewer identity. |
| **Resource picker** | `useResourcePicker()` | The host's checkpoint / LoRA picker modal. Returns validated `{ versionId, modelId, strength, minStrength, maxStrength, … }` used to pin resources and seed LoRA weights. |
| **Moderated image upload + async scan** | `useImageUpload({ asyncScan: true })` | The cosmetic **header image** (public content, so scanned + moderated). `open()` early-resolves a *pending* handle (image persisted, scan in flight); `scanStatus(handle)` streams the verdict. The app is fail-closed — only a `scanned` verdict is ever persisted. A second `useImageUpload({ purpose: 'generationSource' })` uploads the **unscanned** img2img source (a private generation input the orchestrator scans at gen time). |
| **Per-generator spend attribution** | `WorkflowBody.sharedContentKey` | The runner stamps each generation with the published generator's shared-storage key so spend is attributed back to the generator (and its creator). |
| **Per-app private KV storage** | `useAppStorage()` | Per-viewer drafts (a not-yet-published or published-and-editable generator). See [`src/lib/drafts.ts`](src/lib/drafts.ts). |
| **Consent + auth** | `useRequestConsent()` / `useRequestSignIn()` | The generation scope (`ai:write:budgeted`) is **consent-gated** — the first token is minted without it; the runner checks the live token scopes and requests consent before spending. |
| **Context / theme / resize** | `useBlockContext()`, `useBlockToken()`, `useBuzzBalance()`, `useBlockResize()` | Viewer + theme, live token scopes, Buzz balance, and iframe auto-resize. |

## Architecture

Three screens, routed by [`src/App.tsx`](src/App.tsx):

- **Browse** ([`src/components/Browse.tsx`](src/components/Browse.tsx)) — *Discover*
  (published generators, newest-first with vote counts + cover images) and *My
  generators* (the viewer's own drafts + published rows, each with an in-place
  **Delete** that calls `withdraw`).
- **Builder** ([`src/components/Builder.tsx`](src/components/Builder.tsx) +
  [`ButtonEditor.tsx`](src/components/ButtonEditor.tsx)) — name, description, prompt
  placeholder, a cosmetic header image, and an ordered list of buttons (checkpoint
  picker, weighted LoRA stack, `{prompt}` template editor, workflow type, advanced
  params). Ships with a live, non-runnable preview that renders the real Runner.
- **Runner** ([`src/components/Runner.tsx`](src/components/Runner.tsx)) — the header
  cover banner, a shared prompt input, an img2img source picker, an advanced-params
  reveal, the button row, and an in-session output queue (estimate → confirm cost →
  submit → poll → results).

The pure, node-testable core lives in [`src/lib/generator.ts`](src/lib/generator.ts)
(submit-body construction, prompt composition, weight clamping, the publish
text/data split) with [`lib/workflow.ts`](src/lib/workflow.ts) (poll loop) and
[`lib/drafts.ts`](src/lib/drafts.ts) (KV drafts).

### The stored value shape (moderation boundary)

`buildPublishPayload()` writes a shared-storage record `{ title, body, data }`:

- **`title` / `body`** → **all user-visible text** (name, description, every button
  label, every prompt template). This is what the platform's text content-safety
  belt moderates.
- **`data`** → the **opaque, app-owned structured config** — buttons with resource
  ids + weights, params, and the `headerImageRef`. Unmoderated; it must carry no
  user-visible text that isn't *also* in `title`/`body`.

`parsePublishedGenerator()` reconstructs the config from `data` on open. Resource
ids in `data` are **discovery-only hints** — the server re-validates and re-prices
every id at estimate/submit.

### Back-compat migration

`data` is a versioned blob (`v: 1`), and the read path is deliberately tolerant so
an already-published row never breaks on a schema change:

- **Header image rename** — the cover image was originally stored under
  `backgroundImageRef`; it's now `headerImageRef`. The read path accepts **both**
  (`data.headerImageRef ?? data.backgroundImageRef`) and only ever *writes* the new
  field.
- **Inferred inputs** — a legacy per-button `exposedInputs` flag was replaced by
  inferring the prompt box from the `{prompt}` token and the image box from the
  img2img workflow type; `migrateStoredButton()` drops the flag while preserving the
  author's intent.

See the migration tests in
[`src/lib/generator.test.ts`](src/lib/generator.test.ts).

## Develop

Requires Node 22+. `npm install` first.

### Recommended: `dev-tunnel` (prod-fidelity live dev) — the default flow

`civitai app dev-tunnel` runs your **local** dev server inside the **real**
production `PageBlockHost` at `civitai.com/apps/dev/<blockId>`, over an ephemeral
`dev-<hex>.civit.ai` reverse tunnel. You get the actual host — real viewer, real
consent prompts, the real resource picker + image upload, and the real Buzz
generation bridge — hot-reloading your local edits. This is how you should build
day-to-day.

> **🔒 The dev-tunnel is invite-only beta.** It needs a moderator or
> **app-dev-tester** account (the tunnel gate is account-scoped). If you don't
> have beta access yet, use the [mock harness](#zero-setup-alternative-the-mock-harness)
> below — it needs no account and runs fully offline.

**1. Install the `civitai` CLI** (a self-contained Go binary — pick one; no
self-updater, so re-run to upgrade):

```bash
brew install civitai/tap/civitai          # macOS / Linuxbrew
# or
npm  install -g @civitai/cli              # any Node environment
# or
go   install github.com/civitai/cli/cmd/civitai@latest
```

**2. Start the tunnel-ready dev server** (sets `Access-Control-Allow-Origin: *`
+ a `frame-ancestors` CSP so the prod host can embed + CORS-fetch the bundle, and
routes HMR over the `wss://…:443` tunnel):

```bash
npm run dev:tunnel
```

**3. Open the tunnel** in a second terminal (from the repo root — it defaults the
`blockId` from [`block.manifest.json`](block.manifest.json), here
`custom-generators`):

```bash
civitai app dev-tunnel            # or: civitai app dev-tunnel custom-generators
```

**4. Open the printed URL** — `https://civitai.com/apps/dev/custom-generators` —
in a browser **signed in** to your beta-enabled Civitai account. Edit any file
under `src/` and the block live-reloads inside the real host.

### Zero-setup alternative: the mock harness

No account, no beta access, no network — the published mock host
(`@civitai/blocks-react/testing`) answers the **full** block protocol locally
(viewer, consent, resource picker, image upload, the Buzz workflow, and
shared/KV storage), so no live host or injected HTTP fakes are needed. Use this
if you're exploring the repo or don't have dev-tunnel beta access:

```bash
npm run dev:harness   # offline mock host at http://localhost:5188
```

### Other scripts

```bash
npm run dev           # plain Vite — no mock host, no tunnel headers (rarely needed directly)
npm test              # vitest: a `node` (pure) project + a `jsdom` (component/e2e) project
npm run typecheck     # tsc --noEmit
npm run build         # tsc --noEmit && vite build  → dist/
```

The dev server pins host + port (`localhost:5188`, `--strictPort`) because the SDK
iframe transport drops any `postMessage` whose origin isn't allow-listed
(`VITE_BLOCK_ALLOWED_PARENT_ORIGINS`; see [`.env.example`](.env.example) — it
defaults to `https://civitai.com`, which the tunnel's parent origin needs). The
dev-tunnel embeddability headers + the tunnel-gated HMR websocket live in
[`src/dev-embed.ts`](src/dev-embed.ts) (single source of truth, unit-tested in
[`src/dev-embed.test.ts`](src/dev-embed.test.ts)) and are wired in
[`vite.config.ts`](vite.config.ts); they are **dev-only** (`server.*` never
applies to `vite build`), so the production bundle is untouched. There are no
secrets in this repo — the host injects the block token + viewer identity at
runtime.

## Build & submit (Civitai CLI)

Blocks are validated and submitted with the [`civitai` CLI](https://github.com/civitai/cli):

```bash
brew install civitai/tap/civitai

civitai app validate      # lint block.manifest.json + the build output
civitai app submit        # build (npm run build) + upload dist/ for review
```

The manifest ([`block.manifest.json`](block.manifest.json)) declares the block id,
the requested scopes, `buildCommand: "npm run build"`, and `outputDir: "dist"`.
Publishing a block goes through Civitai's moderation review.

## Links

- SDK contract — [`@civitai/app-sdk`](https://www.npmjs.com/package/@civitai/app-sdk)
- React hooks + UI pack — [`@civitai/blocks-react`](https://www.npmjs.com/package/@civitai/blocks-react)
- CLI — [`github.com/civitai/cli`](https://github.com/civitai/cli)

## License

[Apache-2.0](LICENSE) © 2026 Zach Lowden.
