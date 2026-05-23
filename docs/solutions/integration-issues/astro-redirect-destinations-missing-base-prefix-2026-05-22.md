---
title: Astro `redirects` config does not prefix destinations with `base`
date: 2026-05-22
module: docs/astro.config.mjs
problem_type: integration_issue
component: documentation
severity: high
category: integration-issues
symptoms:
  - "`bun run docs:build` succeeds (`exit 0`)"
  - "Built redirect HTML emits destinations without the configured `base` path"
  - "Canonical href on the redirect page points at the wrong origin"
  - "Production would 404 anyone hitting the legacy URL"
root_cause: config_error
resolution_type: config_change
related_components:
  - astro
  - starlight
  - docs/astro.config.mjs
  - tests/unit/docs-redirects.test.ts
tags:
  - astro
  - redirects
  - base-path
  - docs-site
  - 404
  - production-bug
---

# Astro `redirects` config does not prefix destinations with `base`

## Problem

When a site has `base: '/systematic'` configured, the `redirects` block in `docs/astro.config.mjs` writes destination URLs verbatim — without prefixing the `base` path. Source URLs do get the prefix automatically. The result: legacy URLs produce 308 redirects to root-relative paths that don't exist on the deployed site, shipping production 404s.

## Symptoms

- `bun run docs:build` succeeds. Typecheck, lint, and content-integrity gates all pass.
- The built artifact tells the truth — for example `docs/dist/getting-started/configuration/index.html`:
  ```html
  <meta http-equiv="refresh" content="0;url=/reference/configuration/">
  <link rel="canonical" href="https://fro.bot/reference/configuration/">
  ```
  Note: no `/systematic/` prefix on either the refresh target or the canonical href.
- In a fresh `bun run docs:dev`:
  ```
  curl -sLI http://localhost:4321/systematic/getting-started/configuration/
  HTTP/1.1 308 Permanent Redirect
  location: /reference/configuration/        # ← wrong, missing /systematic/
  ```
- Live navigation lands on `/reference/configuration/` (a 404 in production).

## What Didn't Work

Assumed Astro would prefix both source and destination with `base`. False. Empirical inspection of the built HTML showed only the source keys were prefixed.

## Solution

Manually prepend `base` to every destination value:

**Before:**

```js
// docs/astro.config.mjs
export default defineConfig({
  base: '/systematic',
  redirects: {
    '/getting-started/configuration/': '/reference/configuration/',
    '/reference/systematic-config/': '/reference/configuration/',
  },
  // ...
})
```

**After:**

```js
export default defineConfig({
  base: '/systematic',
  redirects: {
    '/getting-started/configuration/': '/systematic/reference/configuration/',
    '/reference/systematic-config/': '/systematic/reference/configuration/',
  },
  // ...
})
```

Update the corresponding regression test (`tests/unit/docs-redirects.test.ts`) so the assertion matches the base-prefixed destination.

Verify the fix on the built artifact:

```bash
bun run docs:build
grep -E 'refresh|location' docs/dist/getting-started/configuration/index.html
# Should show /systematic/reference/configuration/ in both the meta-refresh
# and canonical href.
```

## Why This Works

Astro's `redirects` config has asymmetric `base` behavior:

- **Source keys** are resolved against `base` automatically. `'/getting-started/configuration/'` becomes the matched URL `/systematic/getting-started/configuration/` at runtime.
- **Destination values** are written verbatim into the redirect output (`<meta http-equiv="refresh">` content, `Location:` header on dev redirects, `<link rel="canonical">` href).

Destinations therefore need the `base` path written in by hand. This is documented behavior — `redirects` is a routing rewrite, not a sitemap-aware redirect map.

## Prevention

- When using `redirects` alongside a non-root `base`, always include the base path in destinations: `'/<base>/<path>'`, not just `'/<path>'`.
- Add a regression test that asserts every redirect destination starts with the configured `base` value. The existing test pattern in `tests/unit/docs-redirects.test.ts` is a starting point.
- Add a pre-push smoke step for any branch that touches `astro.config.mjs`:
  ```bash
  bun run docs:dev &
  sleep 8
  curl -sLI http://localhost:4321<base>/<legacy-url>/ | grep -i location
  # location: should include <base>
  ```
- For any docs change that touches `redirects`, `base`, `trailingSlash`, or route handlers, treat `docs:build` success as necessary-but-insufficient. The bug class is "build green, production 404."
- Recognition pattern: if a built `docs/dist/<source-path>/index.html` redirect file shows a destination URL that does not start with your configured `base`, this is the bug.

## Related

- [mdx-heading-anchor-crashes-astro-build-2026-05-22](../build-errors/mdx-heading-anchor-crashes-astro-build-2026-05-22.md) — another Astro/Starlight config gotcha on the same branch.
- [pre-push-live-server-screenshot-qa-2026-05-22](../best-practices/pre-push-live-server-screenshot-qa-2026-05-22.md) — the verification pattern that surfaced this bug.
