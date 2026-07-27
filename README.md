# Custom Generators — a Civitai App Block

**A complete, open-source example of a [Civitai](https://civitai.com) App Block.**
Read it to learn how a real block is wired to the host platform — the resource
picker, moderated image uploads, cross-user shared storage, and the Buzz
generation bridge — all against the *published* SDK packages, with a mock host so
you can run it in two commands.

🔗 **Live:** [custom-generators.civit.ai](https://custom-generators.civit.ai) ·
[civitai.com/apps/run/custom-generators](https://civitai.com/apps/run/custom-generators)

## New to App Blocks?

An **App Block** is a small web app that Civitai hosts inside a **sandboxed
iframe** on civitai.com. Your block is just a static SPA; everything it needs from
the platform — who's viewing, their Buzz balance, the model/LoRA picker, image
uploads, storage, the ability to run a generation — arrives through a
**host↔block bridge** (postMessage under the hood). In this repo that bridge is a
set of React hooks from `@civitai/blocks-react`. The block never holds
credentials: the host injects the viewer identity and a scoped token at runtime.

This particular block lets users **build**, **publish**, and **run**
image-generation *generators*. A *generator* is a named set of buttons, each
carrying a full generation payload — a pinned checkpoint, a weighted LoRA stack, a
prompt template with an optional `{prompt}` slot, and generation params. An author
builds one in the **Builder**, publishes it to shared storage, and anyone can then
**discover** it and **run** it (spending their own Buzz).

> **The platform has no concept of a "generator."** That entire model is owned by
> this app. The platform only provides generic, capability-scoped seams (a
> resource picker, a moderated image upload, a Buzz workflow bridge, per-app
> private + cross-user shared storage). This repo is a **reference** for wiring
> those seams — [`src/App.tsx`](src/App.tsx) owns every host hook, and
> [`src/lib/generator.ts`](src/lib/generator.ts) is the pure, unit-tested core.

## Quickstart

No account, no network, no config — the published mock host answers the full
block protocol locally, so you can see the app running immediately:

```bash
git clone https://github.com/ZacxDev/civitai-app-custom-generators
cd civitai-app-custom-generators
npm install
npm run dev:harness      # → mock host at http://localhost:5188
```

Want to build against the *real* production host with live reload? See
[Develop](#develop) below.

## What this demonstrates → where to look

Every host capability is a React hook from
[`@civitai/blocks-react`](https://www.npmjs.com/package/@civitai/blocks-react),
assembled into an injectable dependency bag in [`src/App.tsx`](src/App.tsx) (so the
whole app is testable against the SDK's mock host). If you're here hunting "how do
I do X in a block," jump straight to the file:

| Capability | Primitive | Where to look |
|---|---|---|
| **Cross-user shared storage** — the community list of published generators | `useSharedStorage()` | [`App.tsx`](src/App.tsx) (`list`/`append`/`update`/`withdraw`), [`Browse.tsx`](src/components/Browse.tsx) (render + covers) |
| **Buzz generation-workflow bridge** — the money path | `useBuzzWorkflow()` | [`Runner.tsx`](src/components/Runner.tsx) (estimate → confirm → submit → poll), [`lib/workflow.ts`](src/lib/workflow.ts) (poll loop) |
| **Resource picker** — the checkpoint / LoRA modal | `useResourcePicker()` | [`ButtonEditor.tsx`](src/components/ButtonEditor.tsx) (via the `pickResource` prop) |
| **Moderated image upload + async scan** — the public header image | `useImageUpload({ asyncScan: true })` | [`Builder.tsx`](src/components/Builder.tsx) (fail-closed persist on `scanned`) |
| **Unscanned generation-source upload** — the private img2img source | `useImageUpload({ purpose: 'generationSource' })` | [`Runner.tsx`](src/components/Runner.tsx) |
| **Per-app private KV storage** — per-viewer drafts | `useAppStorage()` | [`lib/drafts.ts`](src/lib/drafts.ts) |
| **Per-generator spend attribution** | `WorkflowBody.sharedContentKey` | [`lib/generator.ts`](src/lib/generator.ts) (`buildSubmitBody`) |
| **Consent + sign-in gating** for the generation scope | `useRequestConsent()` / `useRequestSignIn()` | [`scopes.ts`](src/scopes.ts), [`App.tsx`](src/App.tsx) |
| **Context / token / balance / auto-resize** | `useBlockContext()`, `useBlockToken()`, `useBuzzBalance()`, `useBlockResize()` | [`App.tsx`](src/App.tsx) |

A few notes worth calling out:

- **Shared storage** is append-only, votable, and author-scoped. `useSharedStorage()`
  exposes `list` / `append` / `update` / `withdraw` / `vote` / `unvote` /
  `getCount(s)`. **Publish** = `append({ title, body, data })`; **edit in place** =
  `update(key, …)`; **delete** = `withdraw(key)`.
- **The Buzz bridge** never sees credentials. `estimate(body)` prices a generation,
  `submit(body)` charges the viewer's Buzz, `poll(workflowId)` runs to a terminal
  snapshot. The host injects the token + viewer identity.
- **Image moderation is fail-closed.** The header image is public content, so
  `open()` early-resolves a *pending* handle (image persisted, scan in flight) and
  `scanStatus(handle)` streams the verdict — only a `scanned` verdict is ever
  persisted. The img2img source is a private generation input, uploaded
  *unscanned* (the orchestrator scans it at gen time).
- **The generation scope (`ai:write:budgeted`) is consent-gated.** The first token
  is minted without it; the runner checks the live token scopes and requests
  consent before spending.

## Architecture

Three screens, routed by [`src/App.tsx`](src/App.tsx):

- **Browse** ([`Browse.tsx`](src/components/Browse.tsx)) — *Discover* (published
  generators, newest-first with vote counts + cover images) and *My generators*
  (the viewer's own drafts + published rows, each with an in-place **Delete** that
  calls `withdraw`).
- **Builder** ([`Builder.tsx`](src/components/Builder.tsx) +
  [`ButtonEditor.tsx`](src/components/ButtonEditor.tsx)) — name, description, prompt
  placeholder, a cosmetic header image, and an ordered list of buttons (checkpoint
  picker, weighted LoRA stack, `{prompt}` template editor, workflow type, advanced
  params). Ships with a live, non-runnable preview that renders the real Runner.
- **Runner** ([`Runner.tsx`](src/components/Runner.tsx)) — the header cover banner,
  a shared prompt input, an img2img source picker, an advanced-params reveal, the
  button row, and an in-session output queue (estimate → confirm cost → submit →
  poll → results).

The pure, node-testable core lives in [`lib/generator.ts`](src/lib/generator.ts)
(submit-body construction, prompt composition, weight clamping, the publish
text/data split), with [`lib/workflow.ts`](src/lib/workflow.ts) (poll loop) and
[`lib/drafts.ts`](src/lib/drafts.ts) (KV drafts).

### The stored value shape (moderation boundary)

`buildPublishPayload()` writes a shared-storage record `{ title, body, data }`:

- **`title` / `body`** → **all user-visible text** (name, description, every button
  label, every prompt template). This is what the platform's text content-safety
  belt moderates.
- **`data`** → the **opaque, app-owned structured config** (a versioned blob:
  buttons with resource ids + weights, params, the `headerImageRef`). Unmoderated —
  it must carry no user-visible text that isn't *also* in `title`/`body`.

`parsePublishedGenerator()` reconstructs the config from `data` on open. Resource
ids in `data` are **discovery-only hints** — the server re-validates and re-prices
every id at estimate/submit.

### Back-compat migration

`data` is a versioned blob (`v: 1`), and the read path is deliberately tolerant so
an already-published row never breaks on a schema change:

- **Header-image rename** — the cover was originally stored under
  `backgroundImageRef`; it's now `headerImageRef`. The read path accepts **both**
  (`data.headerImageRef ?? data.backgroundImageRef`) and only ever *writes* the new
  field.
- **Inferred inputs** — a legacy per-button `exposedInputs` flag was replaced by
  inferring the prompt box from the `{prompt}` token and the image box from the
  img2img workflow type; `migrateStoredButton()` drops the flag while preserving the
  author's intent.

See the migration tests in
[`lib/generator.test.ts`](src/lib/generator.test.ts).

## Develop

Requires **Node 22+**. Run `npm install` first.

### Recommended: `dev-tunnel` — prod-fidelity live dev

`civitai app dev-tunnel` runs your **local** dev server inside the **real**
production host at `civitai.com/apps/dev/<blockId>`, over an ephemeral
`dev-<hex>.civit.ai` reverse tunnel. You get the actual host — real viewer, real
consent prompts, the real resource picker + image upload, and the real Buzz
generation bridge — hot-reloading your local edits. This is the day-to-day flow.

> **🔒 The dev-tunnel is invite-only beta.** It needs a moderator or
> **app-dev-tester** account (the tunnel gate is account-scoped). No beta access
> yet? Use the [Quickstart harness](#quickstart) — it needs no account and runs
> fully offline.

**1. Install the `civitai` CLI** (a self-contained Go binary — pick one; there's no
self-updater, so re-run to upgrade):

```bash
brew install civitai/tap/civitai          # macOS / Linuxbrew
# or
npm  install -g @civitai/cli              # any Node environment
# or
go   install github.com/civitai/cli/cmd/civitai@latest
```

**2. Start the tunnel-ready dev server** (sets `Access-Control-Allow-Origin: *`
plus a `frame-ancestors` CSP so the prod host can embed + CORS-fetch the bundle,
and routes HMR over the `wss://…:443` tunnel):

```bash
npm run dev:tunnel
```

**3. Open the tunnel** in a second terminal (from the repo root — it defaults the
`blockId` from [`block.manifest.json`](block.manifest.json), here
`custom-generators`):

```bash
civitai app dev-tunnel            # or: civitai app dev-tunnel custom-generators
```

**4. Open the printed URL** — `https://civitai.com/apps/dev/custom-generators` — in
a browser **signed in** to your beta-enabled Civitai account. Edit any file under
`src/` and the block live-reloads inside the real host.

### Scripts

```bash
npm run dev:harness   # offline mock host at http://localhost:5188 (Quickstart)
npm run dev:tunnel    # tunnel-ready dev server for `civitai app dev-tunnel`
npm run dev           # plain Vite — no mock host, no tunnel headers (rarely needed directly)
npm test              # vitest: a `node` (pure-logic) project + a `dom` (jsdom component/e2e) project
npm run typecheck     # tsc --noEmit
npm run build         # tsc --noEmit && vite build  → dist/
```

The dev server pins host + port (`localhost:5188`, `--strictPort`) because the SDK
iframe transport drops any `postMessage` whose origin isn't allow-listed
(`VITE_BLOCK_ALLOWED_PARENT_ORIGINS`; see [`.env.example`](.env.example), which
defaults to `https://civitai.com` — the tunnel's parent origin). The dev-tunnel
embeddability headers + the tunnel-gated HMR websocket live in
[`src/dev-embed.ts`](src/dev-embed.ts) (single source of truth, unit-tested in
[`src/dev-embed.test.ts`](src/dev-embed.test.ts)) and are wired into
[`vite.config.ts`](vite.config.ts). They are **dev-only** (`server.*` never applies
to `vite build`), so the production bundle is untouched. There are no secrets in
this repo — the host injects the block token + viewer identity at runtime.

## Build & submit (Civitai CLI)

Blocks are validated and submitted with the [`civitai` CLI](https://github.com/civitai/cli)
(the same Go binary as above — OAuth login can submit, but it can't spend):

```bash
civitai app validate      # lint block.manifest.json + the build output
civitai app submit        # build (npm run build) + upload dist/ for review
```

The manifest ([`block.manifest.json`](block.manifest.json)) declares the block id,
the requested scopes, `buildCommand: "npm run build"`, and `outputDir: "dist"`.
Publishing goes through Civitai's moderator review, then deploys to
`<blockId>.civit.ai`.

## Links

- Developer docs — [developer.civitai.com](https://developer.civitai.com)
- Live app — [custom-generators.civit.ai](https://custom-generators.civit.ai)
- SDK contract — [`@civitai/app-sdk`](https://www.npmjs.com/package/@civitai/app-sdk)
- React hooks + UI pack — [`@civitai/blocks-react`](https://www.npmjs.com/package/@civitai/blocks-react)
- CLI — [`github.com/civitai/cli`](https://github.com/civitai/cli)

## License

[Apache-2.0](LICENSE) © 2026 Zach Lowden.
</content>
</invoke>
