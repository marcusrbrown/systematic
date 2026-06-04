---
title: Astro <Steps> dev-server crash ("expects a single ordered list") from an HMR escaped-slot regression
date: 2026-06-04
category: runtime-errors
module: docs-site
problem_type: runtime_error
component: documentation
symptoms:
  - 'AstroUserError: The <Steps> component expects its content to be a single ordered list (<ol>) but found no child elements'
  - Dev server crashes on Steps pages after an unrelated CSS edit triggers HMR
  - Killing and restarting the dev server does not fix it; the crash returns
  - HTTP 200 plus a grep for component markup falsely suggested the page was healthy
root_cause: wrong_api
resolution_type: dependency_update
severity: high
related_components:
  - tooling
  - development_workflow
tags:
  - astro
  - starlight
  - hmr
  - vite-cache
  - dom-verification
  - steps
---

# Astro <Steps> dev-server crash ("expects a single ordered list") from an HMR escaped-slot regression

## Problem

While iterating on docs-site CSS, the Starlight dev server (`bun run --cwd docs dev`) repeatedly crashed on any page using the `<Steps>` component (e.g. the installation page) with:

```
AstroUserError: The `<Steps>` component expects its content to be a single ordered list (`<ol>`) but found no child elements.
  at @astrojs/starlight/user-components/rehype-steps.ts:32
```

The crash is dev-only — the static build and the live site were never affected — which makes it easy to misdiagnose as a transient glitch.

## Symptoms

- Thrown from `@astrojs/starlight/user-components/rehype-steps.ts` when loading a `<Steps>` page.
- Triggered by saving an **unrelated** file (global `docs/src/styles/custom.css`) during a live dev session: the save fires HMR, which re-runs the MDX rehype pipeline, and `Astro.slots.render()` returns escaped/raw text instead of an `<ol>`, so `rehype-steps` sees zero list children and throws.
- `bun run docs:build` stayed clean throughout (111 pages built); the production site at `fro.bot/systematic` was never affected.

## What Didn't Work

1. **Killing + restarting the dev-server process alone.** It crashed again — a plain restart reuses vite's on-disk cache (`node_modules/.vite`), which holds the poisoned transform.
2. **Trusting HTTP 200 + `grep -c sl-steps` as proof the page rendered.** Astro's dev server returns **HTTP 200 with an error overlay injected into the body** when a page crashes. The status code is not a render signal, and a grep for component markup matched the overlay — a false "it works."
3. **Cache-clearing as a fix.** `rm -rf docs/node_modules/.vite docs/.astro node_modules/.vite` + one fresh server cleared it, but only until the **next** file edit re-poisoned HMR. That is a reset, not a fix.

## Solution

Root cause: an Astro **6.0.x dev/HMR escaped-slot regression** where `Astro.slots.render()` returns escaped text mid-HMR. Fixed upstream in **Astro 6.1.3+** (tracking issue [`withastro/astro#15986`](https://github.com/withastro/astro/issues/15986)). A Starlight version bump does **not** fix it.

Fix applied (PR #463):

```jsonc
// docs/package.json
- "astro": "^6.0.0",   // lockfile resolved astro@6.0.4
+ "astro": "^6.4.2",   // lockfile resolved astro@6.4.2
```

Commit prefix was `chore(deps):` — astro is a docs-only devDependency and is **not** part of the published npm package (its `files` ship only `dist`, `skills`, `agents`), so per semantic-release config this is correctly non-releasing.

Verification that the fix holds (run after the bump):

```bash
rm -rf docs/node_modules/.vite docs/.astro node_modules/.vite
bun run --cwd docs dev            # fresh server
# repeat >=4 times: fire HMR via an unrelated edit, then revert, then reload
printf '\n/* probe */\n' >> docs/src/styles/custom.css
git checkout -- docs/src/styles/custom.css
# reload the install page each cycle; assert the error string is absent in the rendered DOM
```

All 4 edit-reload cycles were clean; `bun run docs:build` still produced 111 pages.

## Why This Works

Upgrading Astro removes the dev/HMR slot-render regression that made `<Steps>` see empty children during hot reload. The static build path never had the bug — only the dev transform pipeline did — which is why `astro build` was always clean and the bug looked intermittent.

## Prevention

- Pin Astro to `>= 6.1.3` (this repo uses a `^6.4.2` floor).
- When forced to iterate on a broken Astro/HMR, drive design/CSS review off the **static preview** (`astro build` + preview server) — no HMR, no re-transform, no crash — instead of the HMR dev server.
- Verify docs-page health by reading the **rendered DOM/page content**, never by HTTP status alone (the dev server returns 200-with-overlay on crash). A browser DOM eval asserting the error string is absent, or `curl -s <url> | grep -c 'expects its content'` returning `0`, is the real check.
- When a "restart fixed it" claim is about a dev server, suspect on-disk caches (`.vite`, `.astro`): a process restart reuses them; clear them explicitly.

## Related Issues

- Upstream: [`withastro/astro#15986`](https://github.com/withastro/astro/issues/15986)
- Shipped in PR #463
- [Pre-push live-server screenshot QA](../best-practices/pre-push-live-server-screenshot-qa-2026-05-22.md) — sibling lesson: static gates miss runtime docs-site bugs
- [MDX heading-anchor crashes Astro build](../build-errors/mdx-heading-anchor-crashes-astro-build-2026-05-22.md) — sibling Astro/Starlight build failure
- [Astro redirect destinations missing base prefix](../integration-issues/astro-redirect-destinations-missing-base-prefix-2026-05-22.md) — sibling docs-site regression
