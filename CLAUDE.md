# Custom Generators — agent guide

A Civitai **App Block**: a full-page app served at `/apps/run/custom-generators`
where users **build** named "generators" (a set of buttons, each carrying a
pinned checkpoint + weighted LoRA stack + prompt template + params), **publish**
them to shared storage, and **run** them. The platform has no concept of a
"generator" — the whole model lives here; the platform provides only generic
seams (resource picker, image upload, the Buzz workflow money path, shared/KV
storage).

Running a button **spends the viewer's Buzz**, so these are the load-bearing
invariants — read [`README.md`](./README.md) before touching any of them:

- **estimate → confirm → submit.** No Buzz leaves a balance without an explicit
  Confirm on a real estimate. `estimate()` **rejects** as of
  `@civitai/blocks-react@0.43.0`; every call site must `try/catch`
  (`src/lib/estimate.ts` owns the mapping — `.snapshot.error` is server-authored
  and UNSANITISED, so it is logged, never rendered).
- **Deterministic balance guard.** Confirm is blocked and a top-up offered when
  the estimate exceeds the balance (`src/lib/buzz.ts` classifies insufficient).
- **Untrusted-param clamp.** A published generator's `data` is opaque and
  unmoderated; `parsePublishedGenerator` re-clamps every numeric param to
  `PARAM_BOUNDS` in `src/lib/generator.ts`. Defense in depth behind the server
  cap and `page.buzzBudgetPerGen: 1000`.
- **The publish text/data split.** All user-visible text goes in `title`/`body`
  (the platform moderates it); `data` is opaque structured config only.
- **Upload purpose.** `useImageUpload()` = moderated cosmetic background;
  `useImageUpload({ purpose: 'generationSource' })` = the UNSCANNED img2img
  source. Do not collapse the two.

This repo is a **public OSS mirror** — block source only, no infrastructure
internals. Keep it that way.

## Get a shell

`pnpm` and `node` are **not on PATH** outside the dev shell. The flake pins the
toolchain:

```bash
direnv allow          # or: nix develop
pnpm install --frozen-lockfile
```

| Task | Command |
|---|---|
| The gates CI runs | `pnpm run typecheck && pnpm test && pnpm run build` |
| Types only | `pnpm run typecheck` |
| Mock host (SDK `<Harness>`) | `pnpm run dev:harness` → http://localhost:5188 |
| Platform approve-time validator | `civitai app validate` (the Go CLI, installed separately — the flake does not ship it) |

**Toolchain pins.** `.nvmrc` is the single authority for the node major — the
flake reads it with `builtins.readFile`, and CI reads it via
`actions/setup-node`'s `node-version-file`. pnpm's major is stated twice
(`flake.nix`'s `pnpmMajor` and the `pnpm/action-setup` step) because the action
reads only its own input or a `packageManager` field this repo deliberately does
**not** declare — adding one would change what the *platform's* builder does,
since `block.manifest.json`'s `buildCommand: pnpm run build` runs against the
same `package.json`. `src/toolchain-lockstep.test.ts` fails if those two drift,
or if someone hardcodes a node version back into the workflow.

Only `x86_64-linux` is exercised. The flake evaluates for `aarch64-linux` and
`aarch64-darwin` too; `x86_64-darwin` is absent because nixpkgs-unstable dropped
it.

## Where a change belongs

Most work that *looks* like a bug here is a gap one layer down. Canonical
checkouts live at `~/workspace/civit/<repo-name>`; sibling directories with a
suffix are topic worktrees of the same remotes, usually on someone's branch.

| The change is about | Repo | Local |
|---|---|---|
| This block's builder, runner, browse, deeplinks, money UI | **`ZacxDev/civitai-app-custom-generators`** (here) | — |
| A hook, a type, the mock host, the design system — anything imported from `@civitai/*` | **`civitai/civitai-app-starters`** | `civitai-app-starters` |
| Host/server behavior: the `/apps/run` page surface, block token + scope enforcement, the page money path, app storage, the workflow read-model, submit/approval | **`civitai/civitai`** | `civitai` |
| `civitai app init/validate/submit`, login, dev tunnel | **`civitai/cli`** (Go) | `cli` |
| Public developer docs (developer.civitai.com) | **`civitai/civitai-developer-docs`** | `civitai-developer-docs` |

**All five `@civitai/*` dependencies ship from the one starters repo** —
`packages/civitai-app-sdk`, `civitai-blocks-react`, `civitai-components`,
`civitai-components-react`, `civitai-theme`. A missing hook, a wrong type, a
mock host that doesn't simulate something: that is a PR there, not a workaround
here. The shared-storage "fetch one row by key" seam this app wants for `?g=`
deeplinks past page one is a host gap, not a bug here.

Useful landmarks in `civitai/civitai`: `src/pages/apps/run` (the page surface),
`src/pages/api/blocks/manifest-schema.ts` + `submit-version.ts`,
`src/server/services/blocks/`.

Sibling app blocks worth reading for prior art — they hit the same platform
edges and several guards here were ported from them:
`ZacxDev/civitai-app-gen-matrix`, `…-model-benchmarking`,
`…-playable-collections`, `…-sensei`, `…-requests`.

## Documentation sources, in authority order

1. **The installed package itself.** `node_modules/@civitai/<pkg>/dist/*.d.ts`
   and its `README.md` are the only source guaranteed to describe *the version
   this repo builds against*. Check `package.json` for that version first.
   Subpaths matter: `@civitai/app-sdk` exports `./blocks`, `./scopes`,
   `./orchestrator`, `./schemas/app-block/v1.json`; `@civitai/blocks-react`
   exports `./ui` and `./testing`.
2. **https://developer.civitai.com/apps/** — `guide/{quickstart,concepts,embedding,theming,text-to-image,comfy-cloud}`
   and `reference/{hooks,manifest,messages,scopes,components,generation,cli}`.
   Best for *why* and for the message-bridge contract. ⚠️ The generated pages
   carry a `sources:` front-matter naming the package version they were built
   from, and it **lags** the version here — when the page and the `.d.ts`
   disagree, the `.d.ts` wins.
3. **The starters repo** — `docs/build-your-first-app-block.md`,
   `starters/examples/*` (one runnable example per feature), and
   `starters/civitai-block-starter` (what `civitai app init` clones). Real code
   beats prose for "how is this hook meant to be used".
4. **The host implementation** in `civitai/civitai` — last-resort ground truth
   for server behavior the docs don't specify (which errors the orchestrator
   returns, what a scope actually gates, how a workflow snapshot is shaped).

For React 19 / Vite / Vitest specifics, use the `context7` MCP tools rather than
recalling from memory.

## Verifying a change

`pnpm test` runs **two vitest projects** (declared in `vite.config.ts`) and both
must be read — a failure in one is invisible in the other:

- **`node`** — `src/**/*.test.ts`, pure logic, no DOM. Every money-safety
  decision lives here on purpose (`lib/generator.ts`, `lib/estimate.ts`,
  `lib/buzz.ts`, `lib/clamp`, `lib/workflow.ts`, `lib/drafts.ts`).
- **`dom`** — `src/**/*.test.tsx`, jsdom + Testing Library, driving
  Builder/Runner/Browse against the SDK mock host, plus a full build → publish →
  discover → open → run e2e.

**What cannot be verified here:** the real Buzz spend and the real publish
moderation path are Turnstile + auth gated. No local run, harness run, or test
proves a button actually charged correctly — that needs a human in a real
mod-gated host. `useGenerationResources` is tested against a **stubbed** fetch,
not a live endpoint. Say so plainly rather than reporting a green suite as if it
covered the money path.

New guards should pin a *relationship* that cannot rot on a routine bump, and be
watched failing before they are trusted. `src/toolchain-lockstep.test.ts` and
the release-version block at the bottom of `src/manifest.test.ts` are the
pattern to copy — both explain, in the file, the incident they exist to prevent.

## Release protocol

- `block.manifest.json` and `package.json` versions move **together**. The
  `release versions` describe in `src/manifest.test.ts` enforces it; a release
  that bumps one is a shippable defect that has actually shipped before.
- `block.manifest.json`'s `buildCommand` is **`pnpm run build`** — that line is
  what the *platform's* builder runs. Changing it changes production.
- Bumping any `@civitai/*` dependency: `pnpm install` re-checks pnpm's
  `minimumReleaseAge` freshness gate, which refuses very fresh versions. This
  repo needs no `pnpm-workspace.yaml` exclusion list today; if a bump is
  refused, add one (`packages: ['.']` + `minimumReleaseAgeExclude`) rather than
  disabling the gate. Keep `@civitai/components` deduped to ONE resolution —
  two copies race on the same `style[data-civitai-components]` marker and the
  loser's components render unstyled.
- `.env.production` bakes the allowed parent origins into the bundle at build
  time. Wrong value = the transport drops every host message and the iframe
  renders blank.
