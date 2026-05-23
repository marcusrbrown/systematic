---
title: MDX heading anchor syntax `{#anchor}` crashes the Astro build
date: 2026-05-22
module: docs/src/content/docs
problem_type: build_error
component: documentation
severity: high
category: build-errors
symptoms:
  - "`bun run docs:build` exits non-zero"
  - "Error: `[@mdx-js/rollup] Could not parse expression with acorn`"
  - "Error location points at the line containing `{#anchor}` on a heading"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - docs/src/content/docs/reference/configuration.mdx
  - astro
  - starlight
tags:
  - mdx
  - astro
  - starlight
  - heading-anchors
  - build-failure
  - acorn
---

# MDX heading anchor syntax `{#anchor}` crashes the Astro build

## Problem

A heading in an MDX page used the explicit-anchor syntax `## Typed Validation {#typed-validation}`. The Astro/MDX 3 pipeline parses the `{...}` block as a JSX expression, and `#typed-validation` is not valid JavaScript, so the docs build crashed before producing any pages.

## Symptoms

- `bun run docs:build` exits non-zero.
- Vite error output:
  ```
  [vite] ✗ Build failed in 463ms
  [@mdx-js/rollup] Could not parse expression with acorn
  file: docs/src/content/docs/reference/configuration.mdx:115:22
    Caused by:
    Unexpected token
      at pp$4.raise (acorn.mjs:3731:13)
      at pp$5.parseMaybeUnary (acorn.mjs:2802:100)
  ```
- The reported file/column points at the offending heading.

## What Didn't Work

Single diagnostic pass identified the cause — no failed attempts.

## Solution

Drop the explicit `{#...}` and let Starlight auto-slug the heading.

**Before:**

```mdx
## Typed Validation {#typed-validation}
```

**After:**

```mdx
## Typed Validation
```

Starlight's slugifier produces `#typed-validation` from the heading text "Typed Validation" — the same fragment value, no behavior change for inbound links that already target `#typed-validation`.

## Why This Works

MDX 3 treats `{...}` outside attribute positions as a JSX expression, which must be a valid JavaScript expression. The character `#` cannot start a JS expression, so acorn raises `Unexpected token`. The remark/markdown ecosystem's `{#anchor}` heading syntax (provided by `remark-attr` and similar plugins) is not part of MDX 3's default grammar.

Starlight already kebab-cases heading text into anchor slugs. Most "explicit anchors" in Starlight projects are redundant with what the framework would produce anyway.

## Prevention

- In Starlight MDX, do not write `{#anchor}` after heading text. Let Starlight derive the slug from the heading.
- When the auto-derived slug is wrong (rare), use the documented escape hatches:
  - Page-level: set `slug:` in the page's frontmatter.
  - In-page anchor with a different slug: insert an HTML `<span id="custom-slug"></span>` immediately before the heading.
- Add `bun run docs:build` to the pre-push checklist for any branch that adds or modifies MDX. `bun run docs:generate` alone does not parse MDX.
- Recognition pattern: any `[@mdx-js/rollup] Could not parse expression with acorn` error pointing at a heading line means a `{...}` block on or near that heading needs to go.

## Related

- [astro-redirect-destinations-missing-base-prefix-2026-05-22](../integration-issues/astro-redirect-destinations-missing-base-prefix-2026-05-22.md) — another Astro/Starlight config gotcha caught on the same branch.
- [pre-push-live-server-screenshot-qa-2026-05-22](../best-practices/pre-push-live-server-screenshot-qa-2026-05-22.md) — verification pattern that catches build/config bugs static gates miss.
