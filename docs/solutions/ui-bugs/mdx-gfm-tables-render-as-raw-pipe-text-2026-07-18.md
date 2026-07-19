---
title: MDX GFM tables render as raw pipe text on the docs site
date: 2026-07-18
category: ui-bugs
module: docs
problem_type: ui_bug
component: documentation
symptoms:
  - "Hand-authored pipe tables in `.mdx` pages rendered as literal `<p>| Col | Col |` text"
  - "Built HTML contained zero `<table>` elements for authored `.mdx` tables"
  - "Generated `.md` reference pages rendered real tables, masking the bug"
root_cause: missing_include
resolution_type: dependency_update
severity: medium
tags:
  - mdx
  - remark-gfm
  - starlight
  - astro
  - tables
  - docs-site
---

# MDX GFM tables render as raw pipe text on the docs site

## Problem

Hand-authored GitHub-Flavored-Markdown pipe tables in `.mdx` content pages rendered as literal pipe text inside a `<p>` element instead of real `<table>` elements — across the live site (`reference/configuration`, `guides/main-loop`, `guides/v3-migration`, and the new Installation compatibility aid). Generated `.md` reference pages were unaffected, which masked the bug.

## Symptoms

- Built HTML showed `<p>| Category | Chain | Rationale | When to Override |` for a table that should have rendered as `<table>` (verified on production and in local `docs/dist`).
- `grep -c '<table' docs/dist/reference/configuration/index.html` returned `0`.
- The same raw-pipe rendering appeared on every hand-authored `.mdx` table, but not on generated `.md` reference pages.

## What Didn't Work

Two hypotheses had to be disambiguated before touching config:

- **"The content generator emits HTML tables."** Disproved: `docs/scripts/transform-content.ts:107-115` writes the source body through unchanged (`generatePage(..., body, ...)` returns `header + cleanedBody`), only normalizing whitespace. It does not convert markdown tables to HTML. So the `<table>` in generated `.md` pages was *not* evidence that the generator produced them.
- **"It's a `.md` vs `.mdx` GFM split."** Confirmed: the fix lives in the Astro markdown pipeline, not the generator. Authored `.mdx` was not receiving Astro's default GFM table parsing, while `.md` was.

Reading a generated reference page's source (plain pipe markdown, not HTML) plus `transform-content.ts` settled it in one check.

## Solution

Wire `remark-gfm` explicitly into the Astro markdown pipeline.

`docs/astro.config.mjs` (before → after):

```js
// before: markdown had only a rehype plugin
markdown: {
  rehypePlugins: [[rehypeMermaid, { /* ... */ }]],
}

// after: add the remark-gfm import + remarkPlugins
import remarkGfm from 'remark-gfm'
// ...
markdown: {
  remarkPlugins: [remarkGfm],
  rehypePlugins: [[rehypeMermaid, { /* ... */ }]],
}
```

`docs/package.json` — added `remark-gfm` (`^4.0.1`) to `devDependencies`.

Verified: `grep -c '<table' docs/dist/reference/configuration/index.html` went `0` → `1`; `guides/main-loop` `0` → `1`; `guides/v3-migration` → `2`; no raw `<p>|` tables remained; mermaid diagrams unaffected; 85 pages build clean. Shipped in PR #663.

## Why This Works

Astro enables GFM by default, but in this Astro 6 + Starlight + `@astrojs/mdx` setup that default was not reaching authored `.mdx` content (plain `.md` still got it). Declaring `remark-gfm` in `markdown.remarkPlugins` restores GFM table parsing for `.mdx` during the build. `remark-gfm` is the same plugin Astro uses internally, so there is no behavior surprise beyond the GFM features it enables (tables, strikethrough, autolinks, task lists).

## Prevention

- **Verify rendered tables against built HTML (`docs/dist/**/index.html`), not source.** A pipe table that looks correct in `.mdx` source can still render as raw text. Use `grep -c '<table' docs/dist/<page>/index.html` as the check.
- **`docs:generate` alone does not parse MDX** — run `bun run docs:build` before pushing docs changes.
- **Run `bun run lint` before pushing docs-config edits** — Biome formats `astro.config.mjs`, and a multi-line config value will fail the format gate in CI.

## Related Issues

- `docs/solutions/best-practices/auto-generated-install-commands-mdx-pitfalls-2026-06-06.md` — sibling MDX-pipeline pitfalls (`<name>` in table cells parses as JSX; copy buttons only attach to fenced blocks). Same "verify built HTML, not source" discipline.
- `docs/solutions/build-errors/mdx-heading-anchor-crashes-astro-build-2026-05-22.md` — another Astro/MDX parse-behavior gap.
- `docs/solutions/workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md` — "build passed" is not "artifact is correct."
