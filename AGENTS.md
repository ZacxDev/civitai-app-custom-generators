<!-- BEGIN civitai agent-setup — managed block, edits here are overwritten -->
## Building a Civitai App

This project is a **Civitai App**: a web app that runs in a sandboxed iframe
inside civitai.com. The host page and your app talk over `postMessage`.

### Docs — fetch these BEFORE writing code

This project is built on **`@civitai/sdk`** and **`@civitai/components`**, with
no UI framework. Their API reference ships with them, in `node_modules`:

- **`node_modules/@civitai/sdk/README.md`** — the host bridge. `initialize()`
  waits for the host's `BLOCK_INIT` and resolves with `app`; `app.onChange`
  fires on every snapshot change (theme, context, each token rotation — update
  the view in place, never rebuild it); `app.site` is the `/api/v1` REST API as
  the viewer; `app.requestGrants([...])` asks for a consent-gated scope;
  `app.storage` / `app.sharedStorage` are app storage; `app.host` is the host's
  own UI.
- **`node_modules/@civitai/components/custom-elements.json`** — every
  `<civitai-*>` element's tags, attributes, events and slots.

The manifest fields, the scopes and the message bridge are documented on the
docs site, and the `.md` suffix serves the plain-text source an agent can read
directly:

- Reference (manifest, scopes, message bridge, CLI):
  https://developer.civitai.com/apps/reference/
- Guide: https://developer.civitai.com/apps/guide/
- **`https://developer.civitai.com/apps/guide/earning.md`** — the three money
  rails. Fetch it before declaring a `goods` catalog. The three rules below are
  repeated in this file deliberately, because they are the ones a manifest can
  break while passing an older `civitai app validate`: a paid-for-access app (`kind: "app_unlock"`)
  is capped at **5000** Buzz rather than the general 50000, may declare **at
  most one** unlock per manifest, and MUST carry a `justification`. All three are
  enforced at submit; the published JSON Schema does not declare them.
- Example apps you can read end-to-end:
  https://developer.civitai.com/apps/examples
- Full doc index for agents: https://developer.civitai.com/llms.txt

### Commands

🔴 **Every row below starts with `civitai`. If your shell answers
`command not found`, the CLI is installed but its directory is not on this
shell's PATH** — the usual cause is an install into a prefix whose `bin` was
added to PATH for the installing shell only, which no later shell inherits. In
a shell where `civitai` DOES work, `command -v civitai` prints its full path;
add that directory to your shell profile so every later session can run these
commands too. `civitai agent-setup --fix-path` does that for you on macOS and
Linux: it writes a marker-guarded block into your shell startup files so a NEW
shell resolves `civitai` (add `--dry-run` to see the exact block first). On
Windows that flag is refused and writes no startup file, so add the directory
through the Windows environment-variable settings, or work inside WSL, where
this CLI is a Linux build.

Every row below is a `civitai` CLI command and is true in any Civitai App
project. How you RUN this app locally is not — it depends on what was scaffolded
here — so it has its own section, written from what is actually in this
directory.

| Task | Command |
|---|---|
| Scaffold a new app | `civitai app create <name>` |
| …choosing the template | `civitai app create <name> --template page-elements\|page-money\|page-vite\|static` |
| Check the manifest | `civitai app validate` |
| Package and submit for review | `civitai app submit` |
| Diagnose an incomplete store listing | `civitai app doctor` |
| Your local app inside the REAL host (needs a local dev server already running — see below) | `civitai app dev-tunnel` |

**Pick the template on purpose.** With no `--template`, `civitai app create`
scaffolds `page-elements` — web components, no UI framework. `page-money` is by
a wide margin the largest of the four: around forty files, with a README and an
`src/App.tsx` of tens of KB each. That is the right starting point when you are
building a Buzz-spending generation app in React, because it is a working one.
For anything else it is a large amount of sample code to read and then delete.

- `page-elements` — Vite + TypeScript, no UI framework: `@civitai/sdk` for the
  host bridge and `<civitai-*>` custom elements from `@civitai/components`, with
  a mock-host dev harness and a test. **The default.**
- `page-money` — the React alternative: Vite + React + TypeScript wired to the
  App SDK: estimate → consent → submit → poll → Buzz spend, with a mock-host dev
  harness. Reading it end-to-end is expensive; treat it as a reference you copy
  from, and delete what your app does not use.
- `page-vite` — Vite + React, a build step, no SDK wiring. The one to pick when
  you want React but not the money path.
- `static` — one `index.html` plus a little JS. No build step, nothing to
  install. The smallest thing that can be a Civitai App.

### Local development

`civitai agent-setup` read `package.json` in this directory. These are the
scripts it actually defines — no command outside this table is claimed to exist
here:

| Task | Command |
|---|---|
| Local dev against a MOCK host — synthetic replies, no real Buzz, no compute, no network | `npm run dev:harness` |
| Plain local preview — there is no host behind it, so nothing sends BLOCK_INIT | `npm run dev` |

`npm run` lists every script, including any this CLI does not recognise. The
descriptions are the meaning `civitai app create` gives those names; if you wrote
your own script under one of them, yours is what runs.

- **Commit the lockfile.** The platform builds with `npm ci` and will not build
  without one. If you switch package manager, set `buildCommand` and `outputDir`
  in the manifest and commit that lockfile instead.
- **Do not hand-edit the `@civitai/*` versions.** `civitai app create` carries
  the pins that are known to work together; a hand-picked version is how the
  money path breaks silently.


### Gotchas — these defy reasonable assumptions

- **Buzz is the user's, not yours.** A generation submitted by your app debits
  the *viewer's* Buzz via their token. Always show a cost preview before
  submitting — estimate first, then submit.
- **A newly declared scope is consent-gated.** Adding a scope to the manifest
  does not grant it: it is dropped from the token until the user consents, so
  you get a 403 while the manifest and the runtime both look correct.
- **A hung `app.host` call is usually a missing HOST handler, not your bug.** The host
  silently drops messages it cannot handle, so an unanswered request looks
  exactly like a broken component. Check the host side before rewriting yours.
- **Shared storage has a REST path, and it is the one to prefer.** There are 11
  routes under `/api/v1/blocks/shared-storage/` (append, counts, increment, item,
  list, report, top, unvote, update, vote, withdraw) and the platform is
  consolidating on them; the `app.sharedStorage` postMessage bridge still works,
  so both are valid. Each route is a thin adapter over the same server function
  the bridge message called, so a REST read cannot diverge from a bridge read.
  They authenticate with the **block token** and re-verify it as a block JWT — so
  an `auth: "oauth"` app cannot use them, and declaring any `apps:storage:*`
  scope alongside `auth: "oauth"` is refused when you submit.
- **Open the resource picker with NO base-model ecosystem by default.**
  `baseModelGroup` is a filter, so a hardcoded one hides every resource outside
  that family and the picker looks empty to the viewer. Pass it only when the
  app already holds a chosen checkpoint the pick must match, and derive it from
  that checkpoint's own `baseModel`.
- **`civitai app validate` is a local mirror. The server is authoritative.** A
  clean local validate is necessary, never sufficient.

<!-- END civitai agent-setup -->
