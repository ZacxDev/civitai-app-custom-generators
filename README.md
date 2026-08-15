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
| scopes | `ai:write:budgeted`, `buzz:read:self`, `apps:storage:read`, `apps:storage:write`, `apps:storage:shared:read`, `apps:storage:shared:write` |

## SDK

Pinned to the published contract: `@civitai/app-sdk@^0.27.0` +
`@civitai/blocks-react@^0.36.0` (+ `@civitai/theme@^0.2.0` for the design
tokens). Hooks used: `useBlockContext`, `useBlockToken`, `useResourcePicker`,
`useImageUpload`, `useGenerationResources`, `useBuzzWorkflow`, `useBuzzBalance`,
`useBuzzPurchase`, `useSharedStorage`, `useAppStorage`, `useBlockAnalytics`,
`useCivitaiNavigate`, `useRequestConsent` / `useRequestSignIn`, `useBlockResize`.
UI is composed on the `@civitai/blocks-react/ui` component pack, which as of 0.36
delegates its theming to `@civitai/theme`'s `--civitai-*` design tokens — the
app chrome (`theme.ts`) reads those same tokens (no hand-coded palette).

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
  more") / My generators (drafts + own published, paginated). Each published
  card has **up-vote** (optimistic + rollback), **Share** (copies a `?g=<key>`
  deeplink), and **Make a copy** (fork into your own draft) affordances. The
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
(poll loop), `lib/drafts.ts` (per-user KV), `lib/deeplink.ts` (`?g=` parse +
share-URL build), `lib/buzz.ts` (insufficient-Buzz classifier), `lib/meta.ts`
(best-effort OG/meta), and `lib/analytics.ts` (funnel event vocabulary). A React
`ErrorBoundary` (`components/ErrorBoundary.tsx`) wraps the app so a thrown render
error shows a recoverable fallback instead of a blank iframe.

## Deeplinks + OG/meta

A published generator is linkable with `?g=<sharedKey>`. On mount the app reads
that param and, once the shared list has loaded, deep-opens the matching
generator directly in the Runner (then cleans the address bar). The "Share"
affordance copies a self-referential `?g=` URL. `lib/meta.ts` sets
`document.title` + `og:*` tags for the opened generator.

- **Limitation:** the block can only deep-open a key present in the loaded
  Discover page (the shared store exposes `list`/`getCount(s)` but no
  fetch-single-row-by-key seam). A key past the first page currently leaves the
  user on Browse.
- **OG caveat:** real crawler-facing Open Graph must come from the host's SSR (a
  crawler never runs the iframe JS); `setGeneratorMeta` is a best-effort,
  live-document update for in-app share / same-tab navigation only.

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

```bash
npm install
npm run dev:harness   # mock host (createMockHost) serves the FULL protocol offline
npm run test          # vitest: node (pure) + jsdom (component/e2e) projects
npm run typecheck
npm run build
```

## Tests

`npm run test` → **168 tests, 2 projects**:

- **node** (pure): `lib/generator` (prompt composition, weight clamp, picker
  seeding, submit-body construction incl. img2img/sharedContentKey/overrides,
  publish split + round-trip, validation, rehydrate, list helpers),
  `lib/clamp` (untrusted-param range clamp), `lib/deeplink` (`?g=` parse +
  share-URL round-trip), `lib/buzz` (insufficient classifier), `lib/workflow`
  (status map + poll loop), `lib/drafts` (KV round-trip), `manifest`
  (defineBlock gate + scopes + budget cap).
- **jsdom** (component + e2e via `@civitai/blocks-react/testing` mock host):
  Builder (config round-trip, LoRA seed + clamp, publish split, draft save/load,
  cosmetic image + cancelled upload, focus-after-reorder a11y), Runner
  (submit-body construction, estimate→confirm→submit→poll queue, img2img gating,
  advanced overrides, consent gate + mid-session revocation, balance guard,
  insufficient-Buzz top-up, partial-failure messaging, result actions), Browse
  (delete flow, voting optimistic + rollback, sort/search/pagination, tablist
  a11y), App features (funnel analytics, deeplink open, fork, share, rehydrate
  notice), ErrorBoundary (throw → fallback → retry), `lib/meta`, rehydrate (real
  `useGenerationResources` hook via stubbed fetch), and a full **build → publish
  → discover → open → run** e2e against the mock host.

## Component pack + Track U

As of `@civitai/blocks-react@0.36` the `/ui` pack provides **Slider**, **Select**,
**NumberInput**, **SegmentedControl**, **Collapse**, and **Modal** — so the app
composes entirely on the pack (no more hand-rolled range/select/number inputs).
The still-missing primitives (**Toast**, **Tooltip**, **Image**) are being added
to `@civitai/components` in a parallel effort (**Track U**); the interim
hand-rolls (the "Copied!" share confirmation, raw `<img>` result/cover grids)
carry `TODO(track-u)` markers to adopt those once published.

## Not verified without a live host

- The **real authed generation / publish** path (real Buzz spend, real
  moderation of the published text + the uploaded background) — the run/publish
  UI is **Turnstile-gated**, so headless verification is blocked. That needs the
  mod dogfood + a human Turnstile click-through (a separate step; **do not
  submit/deploy from here**).
- `useGenerationResources` hits `GET /api/v1/blocks/generation-resources` — tested
  against a **stubbed** fetch, not a live endpoint.
