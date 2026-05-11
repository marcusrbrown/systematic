---
title: OpenCode plugin loader treats named exports as additional plugin factories — load failure
date: 2026-05-11
category: integration-issues
module: systematic-plugin
problem_type: integration_issue
component: tooling
symptoms:
  - "plugin load failure: 'undefined is not an object (evaluating output.system.length)'"
  - Zero Systematic skills or slash commands available in OpenCode after launch
  - OpenCode log shows `service=plugin path=@fro.bot/systematic@2.12.1 ... failed to load plugin`
  - Skill count drops from 54 (working) to 10 (only OpenCode built-ins)
  - CI smoke test passes; user install fails
root_cause: scope_issue
resolution_type: code_fix
severity: critical
tags:
  - opencode
  - plugin-loader
  - esm-exports
  - named-exports
  - plugin-entry-point
  - regression-pattern
---

# OpenCode plugin loader treats named exports as additional plugin factories — load failure

## Problem

After PR #352 added `export const applyBootstrapContent` to `src/index.ts` (so unit tests could import it directly), the built `dist/index.js` exposed two top-level exports: `{ default, applyBootstrapContent }`. When OpenCode loaded the published v2.12.1 package, every named export was treated as an additional plugin factory. The loader invoked `applyBootstrapContent` with no arguments, hit `output.system.length` where `output` was `undefined`, threw, and the entire plugin — including the intended `default` export — failed to load. No skills, no slash commands, no `systematic_skill` tool.

## Symptoms

OpenCode log (`~/.local/share/opencode/log/`) on v2.12.1 install:

```
INFO  service=plugin path=@fro.bot/systematic@2.12.1
ERROR error=undefined is not an object (evaluating 'output.system.length') failed to load plugin
INFO  service=skill count=10 init
```

After reverting to v2.12.0:

```
INFO  service=skill count=54 init
```

CI was green on the broken release. The Node ESM smoke test ran `m.default(...)` directly and only checked that bundled agents and commands loaded under the default export. It did not assert anything about the *shape* of the export set, so a stowaway named export went unnoticed.

This was the **second occurrence** of the same pattern. v2.5.0 / PR #309 had previously broken plugin loading by exporting `INTERNAL_AGENT_SIGNATURES` from the entry. That fix moved the constant to `src/lib/bootstrap.ts` and added a comment "must NOT be re-exported from the plugin entry point." PR #352 added a different helper and didn't internalize the rule. The CI smoke test still didn't check export shape, so the second regression slipped through identically.

## What Didn't Work

- **Trusting the Node ESM smoke test.** It exercises `m.default(...)` and confirms the plugin works under that call shape — but doesn't model OpenCode's loader, which iterates *all* exports. A factory-shape test cannot catch a stowaway-export bug.
- **The earlier code comment "must NOT be re-exported from the plugin entry point."** A comment in `src/lib/bootstrap.ts` is invisible during entry-file edits. PR #352 added a new helper and exported it from `src/index.ts` without ever reading the comment that warned against this exact move.
- **Conventional unit tests on the helper.** PR #352's test imports were the *reason* the helper got exported. Tests pulling from `src/index.ts` is what introduced the regression.

## Solution

Three coordinated changes:

1. **Move `applyBootstrapContent` (and `findBootstrapMarkerBlock` + marker constants) out of `src/index.ts` and into `src/lib/bootstrap.ts`.** The entry point now imports the helper. After rebuild, `Object.keys(dist/index.js)` is exactly `["default"]`.

   ```diff
   - // src/index.ts
   - export const applyBootstrapContent = (
   -   output: { system: string[] },
   -   content: string,
   - ): void => { ... }

   + // src/lib/bootstrap.ts
   + export const applyBootstrapContent = (
   +   output: { system: string[] },
   +   content: string,
   + ): void => { ... }

   + // src/index.ts
   + import {
   +   applyBootstrapContent,
   +   getBootstrapContent,
   +   INTERNAL_AGENT_SIGNATURES,
   + } from './lib/bootstrap.js'
   ```

2. **Update the test file's import path** so it follows the symbol:

   ```diff
   - import { applyBootstrapContent } from '../../src/index.js'
   + import { applyBootstrapContent } from '../../src/lib/bootstrap.js'
   ```

3. **Harden the CI Node smoke test** to assert default-only exports. This is the structural gate that would have caught both this regression and the v2.5.0 one:

   ```js
   const m = await import('./dist/index.js')
   const exportKeys = Object.keys(m).sort()
   const expected = ['default']
   if (JSON.stringify(exportKeys) !== JSON.stringify(expected)) {
     throw new Error(
       'Plugin entry must export only `default`. Got: ' +
       JSON.stringify(exportKeys) +
       '. Extra named exports break OpenCode plugin loading (the loader ' +
       'treats them as additional plugin factories and crashes when ' +
       'invoking them with no input). Move helpers to src/lib/.'
     )
   }
   if (typeof m.default !== 'function') {
     throw new Error('Default export must be a function. Got: ' + typeof m.default)
   }
   ```

The error message is intentionally verbose because it has to teach a future contributor (or AI agent) what the loader actually does — the rule isn't obvious from reading OpenCode's plugin documentation.

## Why This Works

OpenCode's plugin loader enumerates exports from a plugin module and treats each one as a plugin factory candidate. When the entry exposes only `default`, there's exactly one factory to invoke, with the correct input shape. When the entry exposes named symbols too, the loader invokes each one — and a utility helper has a totally different signature from a plugin factory. The first failure aborts the whole plugin load, including the legitimate `default` export.

Moving helpers to `src/lib/` is the right structural answer because:
- The bundler externalizes nothing extra (helpers are inlined into `dist/index.js` either way)
- Unit tests import directly from `src/lib/*.ts`, which never goes through the plugin loader
- The entry stays an "anti-shaped" interface — exactly one default export, nothing else

The CI gate works because it asserts a *property of the build artifact* rather than a *property of the entry source*. Even if a future contributor exports a helper from `src/index.ts`, the build output is the canary, and the gate fails fast with an explanation of why.

## Prevention

1. **Plugin entrypoint files (`src/index.ts`) must contain a default export only.** Helpers, constants, types, and test-visible internals belong in `src/lib/`. This rule is structural, not aesthetic — OpenCode's loader makes it a correctness requirement.

2. **CI smoke tests for plugins must assert export shape, not just call signature.** Asserting that `m.default()` works is necessary but not sufficient. The full assertion is `Object.keys(m) === ['default']`.

3. **When a comment warns "must NOT be re-exported," promote the warning to an executable check.** The bootstrap.ts comment about `INTERNAL_AGENT_SIGNATURES` was honest documentation; it did not prevent the regression. The CI gate added in this fix is the executable form of the same warning.

4. **For published-package regressions, check `npm view <pkg> version` and `dist/index.js` exports before the user's bug report.** When a release ships and behavior changes, `node -e "import('./dist/index.js').then(m => console.log(Object.keys(m)))"` against the installed copy answers "did our export surface change" in seconds.

## Cross-references

- Memory `#2065` (replaced as `#2687` post-PR #352) — the v2.5.0 lesson about `INTERNAL_AGENT_SIGNATURES`. The comment that came out of that incident is in `src/lib/bootstrap.ts:7-11`.
- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md` — the PR #335 origin of `plugInOnce`, which PR #352 inverted into per-load registration. That inversion is what brought `applyBootstrapContent` into existence as a testable symbol that needed an export.
- `docs/solutions/integration-issues/opencode-config-schema-rejects-ad-hoc-agent-colors-2026-05-09.md` — the v2.9.2 launch-time regression. Same shape: CI green, npm publish, user install breaks. Both regressions share a root cause class: tests asserted source-level properties, not behavior of the published artifact against the real OpenCode launch lifecycle.
- PR #352 (`refactor(plugin):` → no semantic-release, so the named-export change shipped only when PR #354's `fix:` triggered v2.12.1).
- PR #354 (the `fix:` commit that triggered v2.12.1 — its diff is irrelevant to this regression, but its release trigger was the proximate cause of users seeing the bug).
