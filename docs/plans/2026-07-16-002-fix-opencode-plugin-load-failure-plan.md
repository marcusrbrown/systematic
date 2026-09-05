---
title: 'fix: v3 OpenCode plugin load failure (optional-peer runtime import)'
type: fix
status: completed
date: 2026-07-16
---

# fix: v3 OpenCode Plugin Load Failure

## Overview

@fro.bot/systematic v3.0.0/3.0.1 never loads for OpenCode cache installs: `peerDependenciesMeta` (added for Pi harness portability in PR #623) makes `@opencode-ai/plugin` optional, the installer skips it, and `dist/index.js`'s top-level `import { tool } from "@opencode-ai/plugin/tool"` throws `ERR_MODULE_NOT_FOUND` at load. No skills, no `systematic_skill`, no bootstrap. Fix: eliminate the runtime import (the SDK's `tool()` is an identity function), add the isolated-install regression test CI lacked, ship 3.0.2, deprecate 3.0.0/3.0.1.

## Problem Frame

v2.33.3 declared `@opencode-ai/plugin` as a required peer — OpenCode's package cache auto-installed it, so the runtime import resolved. v3's Pi support intentionally made all peers optional so Pi consumers don't pull OpenCode's SDK; the runtime import shape defeats the intent on the OpenCode side. Empirical proof: bare-node import of the cached 3.0.1 entry fails with `Cannot find package '@opencode-ai/plugin'`; the log has zero v3 init lines. CI missed it because `tests/integration/opencode.test.ts:852` manually symlinks `@opencode-ai/plugin` into the fixture.

## Requirements Trace

- R1. OpenCode cache installs of the published package load under bare node with no optional peers present.
- R2. Optional-peer architecture preserved (Pi consumers still don't install the OpenCode SDK; OpenCode consumers don't install Pi's).
- R3. A regression test fails on any future top-level runtime import of an optional peer in the OpenCode artifact.
- R4. 3.0.0/3.0.1 deprecated on npm with an upgrade message after 3.0.2 verifies.

## Scope Boundaries

- Pi-side `typebox` externalization hardening: deferred (host-supplied in every real Pi install; not blocking).
- `@earendil-works/pi-coding-agent` stays external and optional — a Pi extension legitimately requires its host.
- No build-externals restructuring beyond what the fix needs.

## Key Technical Decisions

- Remove the `tool()` runtime import rather than bundle it (Oracle option D over A): the helper is `return input` + `tool.schema = z` (verified in SDK source and clonedep); returning the object directly, typed by the existing type-only `ToolDefinition` import, keeps the contract with zero runtime coupling. Bundling would conceal the dependency and pull the SDK's own zod copy.
- Keep `--external @opencode-ai/plugin` in the build so any future accidental runtime coupling fails loudly instead of silently bundling.
- Regression test lives in `tests/unit/package-exports.test.ts` (tarball already packed there): npm-install the tarball into a temp project with `--omit=dev`, assert `@opencode-ai/plugin` absent, import under bare node subprocess, require default-only export shape. Artifact-graph not-contains assertion as the fast secondary check.

## Implementation Units

- [x] **Unit 1: Regression test first (RED)**

**Goal:** Isolated-install test reproducing the production failure.

**Files:**
- Modify: `tests/unit/package-exports.test.ts`

**Approach:** Temp project outside repo; `npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false <tarball>`; assert `node_modules/@opencode-ai/plugin` absent; bare-node subprocess `import('@fro.bot/systematic')` asserting `typeof default === 'function'` and default-only keys; exit 0 required, stderr in failure output. Must FAIL with ERR_MODULE_NOT_FOUND before the fix.

**Test scenarios:** the unit IS the test — failure pre-fix, green post-fix.

**Verification:** test fails on current HEAD.

- [x] **Unit 2: Remove the runtime import (GREEN)**

**Goal:** `dist/index.js` graph contains no runtime `@opencode-ai/plugin` import.

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/skill-tool.ts`
- Test: Unit 1's test + `tests/unit/skill-tool.test.ts` (existing suite stays green)

**Approach:** Drop `import { tool } from '@opencode-ai/plugin/tool'`; keep `ToolDefinition` type-only; `import { z } from 'zod'`; return the definition object directly with `z.string().describe(...)` args. Add the artifact assertion (emitted JS graph not-contains `@opencode-ai/plugin`) to the package-exports suite.

**Test scenarios:**
- Happy path: Unit 1's isolated install loads; existing skill-tool suite green (tool description, args shape, execute behavior unchanged).
- Edge: `.d.ts` may retain type-only imports — assertion scoped to `.js` files only.

**Verification:** full gates (build, typecheck, lint, unit, integration) + Unit 1 green.

## System-Wide Impact

- **Unchanged invariants:** tool description/args/execute contract (`ToolDefinition`-typed), single default export, optional-peer package.json shape, Pi artifact untouched.
- **Integration coverage:** `tests/integration/opencode.test.ts` keeps its symlink fixture (validates offline host behavior, not install) — the new unit test owns install validation.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| npm-install-in-test flakiness/latency | `--ignore-scripts --no-audit --no-fund`, tarball already local; runs once in the packaging suite |
| SDK contract drift (tool() gains real behavior later) | `ToolDefinition` type-only import keeps compile-time checking; artifact assertion documents the boundary |

## Documentation / Operational Notes

- Release: `fix:` commit → semantic-release 3.0.2 on main merge.
- Post-verify: `npm deprecate @fro.bot/systematic@"3.0.0 || 3.0.1" "Broken OpenCode plugin load (ERR_MODULE_NOT_FOUND); upgrade to >=3.0.2"` — needs Marcus's go (public registry action).
- Post-release validation: fresh OpenCode cache install, `systematic_skill` registers, init log shows 3.0.2.

## Sources & References

- RCA evidence: cached 3.0.1 bare-node load failure; log analysis (zero v3 init lines); tarball diff 2.33.3↔3.0.1.
- Oracle fix assessment (2026-07-16 session record).
- Related: PR #623 (optional peers), `tests/integration/opencode.test.ts:852` (the masking symlink).
