---
title: Pre-push live-server screenshot QA catches production bugs static gates miss
date: 2026-05-22
last_updated: 2026-06-04
module: development workflow
problem_type: best_practice
component: development_workflow
severity: medium
category: best-practices
applies_when:
  - "branch changes URL-shape config (`redirects`, `base`, `trailingSlash`, route handlers)"
  - "branch adds or modifies MDX content with `{...}` expressions or custom components"
  - "branch has layout-affecting CSS or component changes"
  - "branch ships user-visible docs-site changes"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - docs/astro.config.mjs
  - docs/src/content/docs
  - agent-browser
tags:
  - workflow
  - screenshot-qa
  - live-server
  - docs-testing
  - pre-push
  - verification
---

# Pre-push live-server screenshot QA catches production bugs static gates miss

## Context

A docs-cleanup branch had passed every static gate — `bun run build`, `bun run typecheck`, `bun run lint`, `bun scripts/content-integrity.ts`, the full test suite, the `ce:review` autofix loop — and was ready for push. The user asked for screenshots of the affected docs pages before the PR. Spinning up `bun run docs:dev`, navigating each changed page with `agent-browser`, and probing redirect URLs with `curl -L` surfaced a real production bug: `redirects` destinations were missing the configured `base` path, so the legacy URLs would have 308'd to 404s in production. Build had been green the whole time.

The screenshot step caught a bug that the entire static gate stack had not.

## Guidance

For any branch that changes one of:

- URL-shape config (`redirects`, `base`, `trailingSlash`, route handlers)
- MDX content with custom components, `{...}` expressions, or non-trivial markdown features
- Layout-affecting CSS or component changes
- SEO frontmatter on user-visible pages
- Generated MDX regions (sentinel-injected content)

add a live-server smoke step before the push command runs:

```bash
# 1. Start the dev server in the background
bun run docs:dev &
DEV_PID=$!

# 2. Wait for it to come up
sleep 8
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4321<base>/

# 3. Probe URL behavior, especially redirects
curl -sLI http://localhost:4321<base>/<legacy-url>/ | grep -i location

# 4. Visually inspect changed pages (agent-browser or manual)
agent-browser set viewport 1440 900
agent-browser open http://localhost:4321<base>/<changed-page>/
agent-browser wait 2500
agent-browser screenshot --full <changed-page>.png

# 5. Tear down
kill $DEV_PID
```

When using `agent-browser batch` with `--json`, chain all navigation+screenshot commands into a single call so the dev server doesn't get torn down between subprocess boundaries.

**HTTP 200 is not a render signal.** Astro's dev server returns `200` even when a page crashes — it injects an error overlay into the body. Step 2's `%{http_code}` check confirms the server is *up*, not that the page *rendered*. To confirm a render, inspect the actual page content: assert the error text is absent (`curl -s <url> | grep -c 'expects its content'` → `0`, or a browser DOM eval), never the status code alone. See [starlight-steps-astro-hmr-regression-2026-06-04](../runtime-errors/starlight-steps-astro-hmr-regression-2026-06-04.md).

**When HMR itself is unstable**, iterate on the static preview (`astro build` + preview server) instead of the dev server — no HMR re-transform, so a known dev-only crash (e.g. the Astro 6.0.x `<Steps>` slot regression) can't keep re-poisoning the page mid-review.

## Why This Matters

Build success and unit test pass are necessary but not sufficient for documentation-site changes. Static gates cannot observe:

- Whether a redirect's destination URL is reachable
- Whether a heading anchor resolves to an existing slug
- Whether layout breakages render correctly across viewport sizes
- Whether MDX renders the intended visual tree (a `{...}` JSX expression bug may pass build but render wrong)
- Whether a sentinel-injected region survived a generator round-trip with the expected content

Catching a redirect bug in dev costs five minutes. Catching it in production costs a hotfix release plus the cache-busting half-life of every CDN edge that served the bad redirect.

## When to Apply

| Apply | Skip |
| --- | --- |
| `astro.config.mjs` changes (especially `redirects`, `base`, `trailingSlash`) | Pure prose edits to existing pages |
| New MDX pages | Source-code changes that don't touch the docs build |
| MDX with `{...}` expressions or custom components | Dependency bumps with no rendering effect |
| Layout/component/CSS changes | README-only changes (not part of the rendered docs site) |
| Sentinel-injected generated regions | Internal architecture docs the user never sees |
| Pre-PR for any user-facing docs change | |

## Examples

**Caught a production redirect bug:** On the same branch this guidance was written from, `bun run docs:build` succeeded and the unit test suite was 949/949 green. The `redirects` entries in `docs/astro.config.mjs` looked correct in isolation. Probing the dev server with `curl -sLI http://localhost:4321/systematic/getting-started/configuration/` revealed `location: /reference/configuration/` — missing the `/systematic/` base prefix. See [astro-redirect-destinations-missing-base-prefix-2026-05-22](../integration-issues/astro-redirect-destinations-missing-base-prefix-2026-05-22.md).

**Caught an MDX parse error before PR:** The same workflow surfaced an MDX heading anchor that crashed `docs:build` itself. See [mdx-heading-anchor-crashes-astro-build-2026-05-22](../build-errors/mdx-heading-anchor-crashes-astro-build-2026-05-22.md). That one would have been caught by adding `docs:build` to the pre-push checklist alone — but live-server navigation is the broader-spectrum check.

## Related

- [iterative-oracle-plan-review](../workflow-patterns/iterative-oracle-plan-review.md) — the generic verification-pattern precedent for "review the live thing, not the spec for the thing."
- [astro-redirect-destinations-missing-base-prefix-2026-05-22](../integration-issues/astro-redirect-destinations-missing-base-prefix-2026-05-22.md) — the canonical example of build-pass / production-404.
- [mdx-heading-anchor-crashes-astro-build-2026-05-22](../build-errors/mdx-heading-anchor-crashes-astro-build-2026-05-22.md) — second build-class example from the same branch.
