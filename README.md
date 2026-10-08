# Custom Generators — Civitai App Block

A first-party **page App Block** where users **build "generators"** (named buttons
that each carry an image-generation payload), **publish** them app-scoped, and
**run** them. The platform has **no concept of a "generator"** — the whole
generator model lives in this app; the platform only provides generic seams
(resource picker, image upload, the Buzz workflow money path, shared/KV storage).

Phase **2a** scope: **image** generation (txt2img + img2img). Video/audio/3D are a
later phase.

## Manifest

| Field | Value |
|---|---|
| slug / blockId | `custom-generators` |
| type | page app (`page.path: "/"`), mobile-first |
| category | `generation` |
| trust tier | `unverified` (shared storage requires the opaque-origin sandbox) |
| `page.buzzBudgetPerGen` | `1000` (the platform cap) |
| scopes | `ai:write:budgeted`, `buzz:read:self`, `apps:storage:read`, `apps:storage:write`, `apps:storage:shared:read`, `apps:storage:shared:write`, `posts:write:self`, `apps:store:items:write` |

## SDK

Pinned to the published contract: `@civitai/app-sdk@^0.59.0` +
`@civitai/blocks-react@^0.43.0` (+ `@civitai/theme@^0.2.1`,
`@civitai/components@^0.3.1` and `@civitai/components-react@^0.3.1` for the
design system). Hooks used: `useBlockContext`, `useBlockToken`, `useResourcePicker`,
`useImageUpload`, `useGenerationResources`, `useBuzzWorkflow`, `useBuzzBalance`,
`useBuzzPurchase`, `useSharedStorage`, `useAppStorage`,
`useCivitaiNavigate`, `useRequestConsent` / `useRequestSignIn`, `useBlockResize`.
UI is composed on the `@civitai/blocks-react/ui` component pack, which as of 0.36
delegates its theming to `@civitai/theme`'s `--civitai-*` design tokens — the
app chrome (`theme.ts`) reads those same tokens (no hand-coded palette).

🔴 **`estimate()` REJECTS as of `@civitai/blocks-react@0.43.0`.** A host reply
carrying no usable price used to resolve as a cost-less "success"
(civitai/civitai#4159); it now throws `WorkflowEstimateError` with a `.code`
(`'failed' | 'no-cost'`) and the host's verbatim `.snapshot` . Every `estimate()`
call site must sit in a `try/catch` — moderator **review preview** answers every
workflow request with a failure, so a missing `catch` turns a reviewer's first
click into an unhandled rejection. `src/lib/estimate.ts` owns the mapping:
`.snapshot.error` is server-authored and UNSANITISED, so it is logged and never
rendered; the viewer sees copy keyed off `.code`.

`useImageUpload` is used with TWO purposes:

- **`useImageUpload()`** (DISPLAY, moderated) → the Builder's cosmetic background,
  which is public content shown to other users (scanned + moderated).
- **`useImageUpload({ purpose: 'generationSource' })`** (UNSCANNED) → the Runner's
  img2img SOURCE image, a private generation input. Returns the image's REAL
  intrinsic `{ url, width, height }` (the orchestrator scans the OUTPUT at gen
  time).

## Screens

- **Browse** (`components/Browse.tsx`) — Discover (published generators with
  vote counts, **search**, **sort by Newest/Popular**, and paginated "Show
  more") / My generators (paginated drafts + own published). The own-published
  list is its OWN server-filtered read (`list({ mine: true })`), not a filter
  over the Discover page — the board read is one page, so a client filter lost
  every generator of yours that had scrolled past it. Each published
  card has **up-vote** (optimistic + rollback), **Share** (copies a
  `https://civitai.com/apps/run/<slug>/g/<key>` link), and **Make a copy** (fork into your own draft) affordances. The
  Discover/Mine switcher is an ARIA tablist (roving tabindex + arrow keys).
  Create → Builder; Open → Runner; Edit → Builder.
- **Builder** (`components/Builder.tsx` + `ButtonEditor.tsx`) — name, description,
  cosmetic background upload, an ordered list of buttons. Each button:
  checkpoint (picker), a weighted LoRA stack (picker + weight slider seeded from
  the picker's recommended strength/min/max), prompt template (`{prompt}`
  token), workflow type, exposed inputs (prompt / image), advanced params. Save
  draft / Publish.
- **Runner** (`components/Runner.tsx`) — cosmetic background, a shared prompt
  input, an img2img source-image picker, an "advanced" params reveal, the button
  row, and an in-session **output queue** (estimate → confirm cost → submit →
  poll → results). The confirm step has a **deterministic balance guard** (blocks
  Confirm + offers a Buzz top-up via `useBuzzPurchase` when the estimate exceeds
  the balance), classifies an **insufficient-Buzz** failure distinctly (typed
  top-up card, not a generic error), messages **partial failures** ("N of M
  images generated — the rest were refunded"), and offers **result actions**
  (download / re-run same inputs / open in the on-site Civitai generator).

Core logic is centralized (and unit-tested) in `lib/generator.ts` (pure —
including the untrusted-param **range clamp**, see below), `lib/workflow.ts`
(poll loop), `lib/drafts.ts` (per-user KV), `lib/deeplink.ts` (`g/<key>` route +
`?g=` parse, share-URL build), `lib/buzz.ts` (insufficient-Buzz classifier), `lib/meta.ts`
(best-effort OG/meta). A React `ErrorBoundary` (`components/ErrorBoundary.tsx`)
wraps the app so a thrown render error shows a recoverable fallback instead of a
blank iframe.

This app emits **no analytics or funnel telemetry**. It used to carry an
`ANALYTICS_EVENTS` vocabulary and eleven `track()` call sites behind a
`useBlockAnalytics()` hook whose whole body was `if (import.meta.env.DEV)
console.debug(...)` — inert in production, consumed by nothing. All of it is
deleted. A caught render error is recovered on screen and reported nowhere.

## Deeplinks + OG/meta

A published generator is linkable at
`https://civitai.com/apps/run/<slug>/g/<sharedKey>`. The host forwards the path
after the slug to the block as `subPath` (in the init context, then as a
`ROUTE_CHANGED` push on every later change); `src/platform/route.ts` exposes it
as `useHostRoute()`. Once the shared list has loaded the app deep-opens the
matching generator in the Runner. Only the exact shape `g/<key>` (key
`[A-Za-z0-9_-]{1,64}`) is routed; any other path opens nothing.

- **`?g=<sharedKey>` still works** as a fallback (links shared before 0.9.2).
  When both are present the host route wins.
- **The app writes the route back.** Opening a published generator sends an
  app-scoped `NAVIGATE` to `g/<key>`, and returning to Browse sends one to the
  app root, so the address bar tracks what is open and browser Back closes the
  Runner. The host's shallow push echoes as `ROUTE_CHANGED`, which the app
  ignores when it already matches the screen.
- **Share** copies `https://civitai.com/apps/run/<slug>/g/<key>`; the slug is the
  host's `context.slug`, falling back to the manifest `blockId`.

`lib/meta.ts` sets `document.title` + `og:*` tags for the opened generator.

- **Known defect (not a platform limit):** the deeplink resolvers in
  `src/App.tsx` match the key against the loaded Discover page only, so a key past
  that page leaves the viewer on Browse. ⚠️ This used to be written up here as a
  missing host seam — "the shared store exposes `list`/`getCount(s)` but no
  fetch-single-row-by-key" — and that is **false**: `shared.get(key)` is live in
  `src/platform/sharedStorage.ts` (over `GET blocks/shared-storage/item`). The call
  sites simply do not use it yet. Fixing them also has to decide what to show when
  `get` returns `null`, which it does for a withdrawn or moderated row as well as a
  missing one.
- **OG caveat:** real crawler-facing Open Graph must come from the host's SSR (a
  crawler never runs the iframe JS); `setGeneratorMeta` is a best-effort,
  live-document update for in-app share / same-tab navigation only.

## App Store sub-listings (0.10.0)

A published generator also goes to the civitai App Store as its own card, badged
"in Custom Generators" (server: civitai/civitai#5511). The card links to
`/apps/run/<slug>/g/<key>?sl=<id>`, so it opens the generator through the
deeplink route above. Scope: `apps:store:items:write` (sensitive, so justified in
the manifest; consent-exempt; never minted for dev, tunnel or review tokens).

- **Publish / edit** → `POST blocks/sub-listings/upsert` with `itemKey` (the
  shared key), `title` (the name, ≤80), `tagline` (the description, ≤140, left
  out when empty) and `subPath: g/<key>`. No `imageId` (a generator cover is not
  an image in a published post, which the server requires) and no
  `contentRating` (unset inherits the app's own). Every new item and every edit
  to an approved one waits for a moderator; the Builder says so in one line
  under "Published!".
- **Withdraw** → no store call. civitai's shared-storage withdraw takes the
  author's card down itself, server-side, before it answers.
- **Backfill** → off the "Published by me" read, the app calls
  `GET blocks/sub-listings/mine` and upserts the viewer's published generators
  that have no card yet: at most 10 per run, at most one run per 6 hours across
  page loads (a ledger under `store-backfill:v1` in the viewer's app storage),
  and an item the store refused is not retried by the backfill. The server counts
  every upsert, refused or not, against 30 writes/hour and 100/day. A viewer with
  no published generators never reaches the store routes.
- **Best-effort, always.** Store calls run after the shared-storage write has
  succeeded and are not awaited, so no store failure (503 while the feature's
  tables are missing, 403 when the app is not enabled, 429, 5xx, a dead network)
  can fail or delay the in-app publish. "Unavailable" answers are silent.
- **No store call without the scope on the token**, which is the normal state
  outside an approved production build.
- `@civitai/app-sdk` 0.59.0 lists the scope (`BLOCK_SCOPES.APPS_STORE_ITEMS_WRITE`),
  so `src/scopes.ts` takes it from the SDK and the local `defineBlock` gate checks
  it like every other scope.
- **Inherits the deeplink defect above:** a card for a generator past the loaded
  Discover page opens on Browse instead of the generator.

## Untrusted-param clamp (defense in depth)

A published generator's structured `data` is opaque + unmoderated, so
`parsePublishedGenerator` **range-clamps** every numeric param
(`quantity`/`steps`/`width`/`height`/`cfgScale`, LoRA stack ≤ 5) to the SAME
bounds the Builder enforces (single-sourced as `PARAM_BOUNDS` in
`lib/generator.ts`). This is defense-in-depth behind the estimate + confirm +
server cap — a forged row cannot build an over-limit submit body.

## The publish text/data split (moderation boundary)

`buildPublishPayload()` writes a shared-storage `{ title, body, data }` record:

- `title` / `body` → **all user-visible text** (name, description, every button
  label, every prompt template). This is what the platform's text
  content-safety belt moderates.
- `data` → the **opaque structured config** (buttons with resource ids +
  weights, params, exposed inputs, `backgroundImageRef`). Unmoderated, app-owned
  — and carries no visible text that isn't *also* in `title`/`body`.

`parsePublishedGenerator()` reconstructs the config from `data` on open.

## How the runner builds a submit body

`buildSubmitBody(button, opts)` (pure) produces the `WorkflowBody`:

- `kind: 'textToImage'`, `modelId`/`modelVersionId` from the pinned checkpoint.
- `additionalResources[]` = the weighted LoRA stack (each re-clamped, capped at 5).
- `params` = author params, with runner **advanced overrides** merged on top.
- `sharedContentKey` = the published generator's shared_kv key → **creator
  attribution (G5)**.
- `sourceImage` = the UNSCANNED `generationSource` upload (real `{ url, width,
  height }`) **only for an img2img button** — a private generation input the
  orchestrator scans at gen time (txt2img never carries one; img2img is signalled
  purely by `sourceImage`'s presence, per the SDK contract).

Resource ids are **discovery-only** hints — the server re-validates + re-prices
every id at estimate/submit.

## Develop

The toolchain is pinned by a nix flake — `direnv allow` (or `nix develop`) puts
node and pnpm on PATH; `.nvmrc` is the single authority for the node major.

```bash
pnpm install --frozen-lockfile
pnpm run dev:harness  # the app's own fake platform (src/platform/testing.tsx) serves it offline
pnpm test             # vitest: node (pure) + jsdom (component/e2e) projects
pnpm run typecheck
pnpm run build
```

## Tests

`pnpm test` → **2 projects** (the count is deliberately not quoted here: it moved
every round and nothing asserts on it — read it off the run):

- **node** (pure): `lib/generator` (prompt composition, weight clamp, picker
  seeding, submit-body construction incl. img2img/sharedContentKey/overrides,
  publish split + round-trip, validation, rehydrate, list helpers),
  `lib/clamp` (untrusted-param range clamp), `lib/deeplink` (`?g=` parse +
  share-URL round-trip), `lib/buzz` (insufficient classifier), `lib/workflow`
  (status map + poll loop), `lib/drafts` (KV round-trip), `manifest`
  (defineBlock gate + scopes + budget cap).
- **jsdom** (component + e2e via the app's own fake platform,
  `src/platform/testing.tsx` — a fake `fetch` plus a scripted transport; there is
  no published mock host, and `@civitai/blocks-react` is not a dependency):
  Builder (config round-trip, LoRA seed + clamp, publish split, draft save/load,
  cosmetic image + cancelled upload, focus-after-reorder a11y), Runner
  (submit-body construction, estimate→confirm→submit→poll queue, img2img gating,
  advanced overrides, consent gate + mid-session revocation, balance guard,
  insufficient-Buzz top-up, partial-failure messaging, result actions), Browse
  (delete flow, voting optimistic + rollback, sort/search/pagination, tablist
  a11y), App features (build → publish → run, deeplink open, fork, share,
  rehydrate notice), ErrorBoundary (throw → fallback → retry), `lib/meta`, rehydrate (real
  `useGenerationResources` hook via stubbed fetch), and a full **build → publish
  → discover → open → run** e2e against that same fake platform.

## Component pack + Track U

As of `@civitai/blocks-react@0.36` the `/ui` pack provides **Slider**, **Select**,
**NumberInput**, **SegmentedControl**, **Collapse**, and **Modal** — so the app
composes entirely on the pack (no more hand-rolled range/select/number inputs).
**Toast**, **Tooltip** and **Image** shipped in `@civitai/components@0.3.0`
(Track U) and the app consumes them from `@civitai/components-react` — the
hand-rolled interims are gone.

🔴 **They need a SINGLE resolved `@civitai/components`.** Both
`@civitai/blocks-react`'s `injectBlocksStyles()` and `@civitai/components-react`'s
`useComponentStyles()` inject through the same `style[data-civitai-components]`
marker, so whichever runs first wins and the second no-ops. When the installer
nests an older copy under `blocks-react` (the case in
`civitai/civitai-app-starters#247`), the older, smaller stylesheet is the one
that lands and Tooltip/Toast/Image render **unstyled** — a tooltip becomes
visible layout text with no console error. Keep `@civitai/components` deduped to
ONE version: `pnpm why @civitai/components` must print a single resolution with
no nested copy.

## Not verified without a live host

- The **real authed generation / publish** path (real Buzz spend, real
  moderation of the published text + the uploaded background) — the run/publish
  UI is **Turnstile-gated**, so headless verification is blocked. That needs the
  mod dogfood + a human Turnstile click-through (a separate step; **do not
  submit/deploy from here**).
- `useGenerationResources` hits `GET /api/v1/blocks/generation-resources` — tested
  against a **stubbed** fetch, not a live endpoint.
