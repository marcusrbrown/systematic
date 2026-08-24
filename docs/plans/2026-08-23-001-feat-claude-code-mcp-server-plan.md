---
title: 'feat: Ship an MCP server with the Claude Code plugin bundle'
type: feat
status: active
date: 2026-08-23
deepened: 2026-08-23
origin: docs/brainstorms/2026-08-23-claude-code-mcp-server-requirements.md
---

# feat: Ship an MCP server with the Claude Code plugin bundle

## Overview

Systematic's Claude Code bundle is markdown only. It emits a manifest, an output style, a
static-`printf` `SessionStart` hook, skills, and agents — so bundled prose naming the
`systematic` CLI cannot be satisfied there.

This adds a stdio MCP server to the bundle, declared in `.mcp.json` and launched by Claude
Code on enable. Its first tool mirrors `systematic validate-review-artifact`. OpenCode and
Pi are untouched.

## Problem Frame

Supporting a harness means adapting to its mechanisms. Anthropic documents two paths a
plugin has to executable capability — a bundled MCP server and hooks that run executables —
and the bundle uses neither. The gap is a build choice, not a harness limit.

The immediate symptom was corrected: the synthesis contract now states a condition rather
than an unconditional command, and the run artifact records whether validation ran. But
that addressed one instruction rather than the reason it failed.

See origin: `docs/brainstorms/2026-08-23-claude-code-mcp-server-requirements.md`.

## Requirements Trace

- R1. The bundle declares an MCP server that Claude Code launches on enable.
- R2. The server launches from the published npm package, not a committed binary.
- R2a. The launch resolves to an immutable version, never a floating tag.
- R3. The validation tool mirrors the CLI's accept/reject behavior, including path
  containment and the allowlist projection that keeps artifact content out of errors.
- R4. When the server is unavailable, the run records validation as unavailable with a
  reason and continues.
- R5. Launch failure never blocks or stalls a run.
- R5a. Post-startup failure degrades identically — never as passed.
- R5b. A tool that is absent is distinguishable from a tool that failed.
- R6. OpenCode and Pi *runtime* behavior is unchanged — no tool registration is modified
  and neither harness gains a dependency on the server. Their install requirements do
  change: `engines.node` is package-wide, so the `>=20` floor reaches every consumer.

## Scope Boundaries

- The workflow guard on Claude Code. Deferred, not impossible — `PreToolUse` can block and
  `PostToolUse` receives the tool response. The blocker is that the guard holds state in
  process. Tracked in issue #854.
- Replacing the in-process adapters on OpenCode or Pi with MCP.
- Exposing skill loading over MCP. Claude Code has a native `Skill` tool.

### Deferred to Separate Tasks

- Extracting `ce:review`'s synthesis pipeline into code — issue #795.
- Auditing bundled prose for non-CLI capability assumptions (shell, filesystem, network).
  A prior pass checked CLI invocations only.

## Context & Research

### Relevant Code and Patterns

- `scripts/build-claude-code-plugin.ts:508-538` — `generatePluginFiles()` builds the output
  map. A root-level `.mcp.json` is one more entry beside `.claude-plugin/plugin.json`.
- `scripts/build-claude-code-plugin.ts:81-87` — `buildPluginManifest()`, hand-written.
- `scripts/build-claude-code-plugin.ts:567-612` — `writePluginFiles()` stages to a sibling
  directory and swaps atomically. New outputs inherit this for free.
- `scripts/build-claude-code-plugin.ts:637-640` — the script currently takes no CLI
  arguments and reads no environment variables.
- `.github/workflows/docs.yaml:61-90` — the precedent for passing a CI value into a build
  script: `bun scripts/build-registry.ts --version "${{ steps... }}"`. Follow this shape.
- `.github/workflows/main.yaml:218-220` — the `release` job exposes `new-release-version`.
- `.github/workflows/main.yaml:289-290,305-306` — `publish-claude-code-plugin` already
  depends on `release` and gates on `new-release-published == 'true'`.
- `src/cli.ts:388-448` — `resolveReviewArtifactPath()`: containment root, traversal
  rejection, symlink walk, realpath canonicalization, regular-file check.
- `src/cli.ts:503-555` — `runValidateReviewArtifact()` and the four exit codes.
- `src/cli.ts:538-545` — Zod issue projection: path and code only, authored `custom`
  messages, never artifact content.
- `src/lib/review-artifact-schema.ts` — `ReviewArtifactSchema`, the validation authority.
- `tests/integration/pi.test.ts:523-690` — JSONL-over-stdio harness using `Bun.spawn` with
  piped stdio, request-ID correlation, and timeouts. Closest precedent for testing MCP.
- `tests/unit/package-exports.test.ts:116-320` — builds, packs, installs, and executes the
  published package in a subprocess.
- `tests/integration/claude-code.test.ts` — asserts generated bundle structure; notes that
  Claude Code has no headless RPC harness in CI.

### Institutional Learnings

- [`claude-code-plugin-build-and-publish-architecture`](../solutions/best-practices/claude-code-plugin-build-and-publish-architecture-2026-07-18.md)
  — "Don't emit facts the build can't state truthfully." `package.json` version is a
  `0.0.0-semantic-release` placeholder, which is why the manifest omits `version`. This
  plan does not add a manifest `version`; it stamps a launch reference sourced from CI.
  Those are different things — one versions a distribution channel, one pins a dependency.
- [`unvalidated-artifact-contracts-have-no-conforming-producers`](../solutions/best-practices/unvalidated-artifact-contracts-have-no-conforming-producers-2026-08-23.md)
  — enforcement code must live where the published package can execute it. The server goes
  in `src/`, shipped through `dist/`, never `scripts/`.
- [`verify-installed-artifacts-not-just-build-gates`](../solutions/workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md)
  — build, drift, typecheck, and lint can all pass while the emitted bundle is wrong once
  installed. Unit 6 exists because of this.
- [`cross-harness-tools-frontmatter-divergence`](../solutions/integration-issues/cross-harness-tools-frontmatter-divergence-2026-08-16.md)
  — identical bundled prose can mean opposite things per harness. Unit 5's wording must
  work on all three rather than assuming one.

### External References

- MCP TypeScript SDK — `@modelcontextprotocol/server` v2.0.0. Dependencies are
  `zod ^4.2.0` and `@modelcontextprotocol/core`. `engines.node` is `>=20`.
  https://github.com/modelcontextprotocol/typescript-sdk
- Tool authoring — `registerTool(name, config, handler)`; `inputSchema` is a Zod schema.
  https://ts.sdk.modelcontextprotocol.io/v2/servers/tools
- Error semantics — a recoverable tool failure is a *successful* result carrying
  `isError: true`, which the model sees. Thrown handler errors convert to the same shape.
  Protocol errors are a separate channel the model never sees.
  https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/errors.md
- stdio servers must log to `stderr`; writing to `stdout` corrupts the JSON-RPC stream.
  https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server
- Claude Code plugin MCP config, and the documented expansions `${CLAUDE_PLUGIN_ROOT}`,
  `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}` in `command`, `args`, and `env`.
  https://code.claude.com/docs/en/mcp
- `npx -y <package>@<version>` is a documented server `command`. First run can fail while
  the package downloads; `MCP_TIMEOUT` governs startup. Whether npx caches a pinned version
  across launches is **not documented**.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "build-new-within-scope",
  "scope": "src/, scripts/, and the generated claude-code/ bundle",
  "freshness": {
    "vcs_reference": "1e3d512d4187e82c184719a113238656fe0d9ad0"
  },
  "budget": {
    "max_search_passes": 4,
    "max_candidate_inspections": 8,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/cli.ts",
      "description": "Owns validate-review-artifact as a process entry point, resolving a contained path and exiting with a status code.",
      "disposition": "insufficient",
      "insufficiency_reason": "Reaches consumers only through the npm bin entry. The Claude Code bundle installs markdown from an orphan branch and carries no executable, so this entry point is unreachable there."
    },
    {
      "path_or_symbol": "src/lib/skill-tool.ts",
      "description": "Owns registration of the systematic_skill tool for OpenCode.",
      "disposition": "insufficient",
      "insufficiency_reason": "Registers through OpenCode's tool hook, which Claude Code does not provide. The registration mechanism is harness-specific, not the tool body."
    },
    {
      "path_or_symbol": "src/lib/pi-delegate-tool.ts",
      "description": "Owns registration of the bounded systematic_delegate tool for Pi.",
      "disposition": "insufficient",
      "insufficiency_reason": "Uses Pi's extension registration API. Pi's tool mapping is fixed to built-in names and fails closed on unknown tools, so it offers no path to another harness."
    },
    {
      "path_or_symbol": "scripts/build-claude-code-plugin.ts",
      "description": "Owns assembly of the Claude Code bundle: manifest, output style, hooks, skills, and agents.",
      "disposition": "insufficient",
      "insufficiency_reason": "Emits markdown and a static hook. It has no mechanism for exposing a callable tool to the model, so it cannot own this concern even though this work extends it to emit one more file."
    },
    {
      "path_or_symbol": "buildHooksJson",
      "description": "Emits the bundle's SessionStart hook as a static printf of declarative facts.",
      "disposition": "insufficient",
      "insufficiency_reason": "Hooks execute commands and can observe or block tool calls, but do not expose callable tools to the model. A hook cannot answer a validation request the model initiates."
    }
  ],
  "excluded_scopes": [
    {
      "scope": ".slim/clonedeps/repos/",
      "reason": "Read-only vendored clones of dependency source, present for inspection only. Not this project's code and not modifiable."
    },
    {
      "scope": "docs/plans/",
      "reason": "Searched for prior intent rather than reusable implementation. Three prior plans mention MCP; all defer server bundling explicitly and none contain an implementation."
    }
  ]
}
```

No MCP server, protocol implementation, or callable-capability surface for Claude Code
exists in this repository. `@modelcontextprotocol/sdk` appears in `bun.lock` only as an
indirect optional peer of `@google/genai` — lockfile metadata, not an installed dependency.

## Key Technical Decisions

- **`@modelcontextprotocol/server` v2, and bump `engines.node` to `>=20`.** Two
  dependencies, one of which (`zod`) is already a runtime dependency here. The v1 line
  (`@modelcontextprotocol/sdk@1.30.0`) keeps `>=18` but pulls ajv, express, hono, cors,
  jose, raw-body, ajv-formats, and cross-spawn into a package with five lean runtime
  dependencies — a web-server stack for a stdio server that needs none of it. Node 18
  reached end of life in April 2025, so the current floor is already stale.

- **Containment anchors on an injected project directory, not `process.cwd()`.**
  Verified defect: `src/cli.ts:400` resolves the root as
  `path.resolve(cwd, '.context', 'systematic', 'ce-review')`. Running the built CLI from a
  foreign working directory against a valid absolute artifact path returns
  `Review artifact directory is unavailable`. An MCP server's working directory belongs to
  Claude Code's launcher, so without this the feature would be silently inert on every run.
  The bundle passes `${CLAUDE_PROJECT_DIR}` through the server's `env`.

- **The server fails closed on a bad root; it does not fall back to `cwd`.** For a resident
  server this is an access-control decision, not a convenience. Falling back would bind
  containment to whatever directory the launcher happened to use — reintroducing the defect
  above as a silent default. `SYSTEMATIC_PROJECT_DIR` must be present, non-empty, absolute,
  and resolve through realpath to an existing directory. Anything else is a startup refusal
  with a reason, which the run records as unavailable. The fallback belongs in Unit 1's
  module signature, where the caller passes the root explicitly — not in the server.

- **A symlinked ancestor is not a problem *on the `cwd` path*.** Measured: `process.cwd()`
  returns a realpath-resolved directory, so `pathContainsSymlink` (`src/cli.ts:361-376`)
  only ever walks a canonical prefix. Verified on macOS, where temp directories live under
  the `/var` → `/private/var` symlink.

  That measurement does not cover the injected root, which is the path this work actually
  uses. An environment variable carries whatever the launcher put in it, canonical or not.
  The server therefore realpaths the root before deriving the containment directory, and
  Unit 2 covers a non-canonical injected root explicitly. Recorded with its scope stated,
  because the narrower claim was true and the broader one was not.

- **Share the validation module; do not shell out.** The server imports
  `ReviewArtifactSchema` directly. Spawning the CLI from the server would double process
  cost and put CLI stdout into a stream where stdout is protocol.

- **Exit codes become structured tool results, not process exits.** A server that exits on
  a failed validation kills itself for the rest of the session.

- **The build fails rather than stamps a placeholder.** `package.json` version on `main` is
  `0.0.0-semantic-release`. If the version input is absent, the build must error.

- **The non-release CI gate passes an unpublishable sentinel.** `claude-code:build` also
  runs as a build gate outside a release, where no published version exists. That gate
  proves the bundle assembles, so it must keep running. It passes an explicit sentinel, and
  the existing pre-publish guard refuses any bundle whose `.mcp.json` carries it. A sentinel
  bundle can be built but never published — which is what the gate needs and no more.

- **The Node floor is a package-wide change, not a Claude Code one.** `engines.node` has no
  per-entry-point scope, so bumping it to `>=20` applies to OpenCode and Pi consumers who
  will never launch the server. This is accepted deliberately rather than incidentally:
  Node 18 reached end of life in April 2025. It belongs in release notes as a compatibility
  change, not buried in a diff.

- **The package becomes a runtime delivery channel for one harness.** A Claude Code hotfix
  or pin change now rides the same release train as OpenCode and Pi. Accepted, and recorded
  so that a future need for independent cadence is recognized as a known consequence rather
  than a surprise. The escape hatch, if it is ever needed, is a separate package or a
  non-`npx` command — not a change to this design.

## Open Questions

### Resolved During Planning

- **What does the launch pin against?** The npm version published by the same CI run,
  passed as a build flag. `publish-claude-code-plugin` already depends on `release` and
  runs only when a version was cut, so the value is in scope at build time.
- **Wrap the CLI or share the module?** Share the module — see decisions.
- **Where does the declaration live?** A root-level `.mcp.json`. It keeps the hand-written
  manifest hand-written and puts the one generated, version-bearing file on its own.

- **Does `npx` re-resolve a pinned version on every session start?** No. Measured on npm
  11.19.0 against the real published package:

  | Condition | Result |
  |---|---|
  | Cold, cache cleared | 5139 ms, one cache entry created |
  | Warm | 682 / 430 / 426 ms |
  | Cached, `--offline` forced | runs, **zero** npm errors |
  | Uncached, `--offline` forced | fails with `ENOTCACHED` naming the tarball URL |

  A pinned exact version is cached and launches entirely from cache with no registry
  round trip. npm's documentation states the flag semantics but guarantees none of this,
  so it is an observed property of one npm version rather than a contract — which is
  enough, because the degraded path is already required.

  This narrows the risk: the exposure is *first* launch, not every session.

- **Does a plugin-bundled server require approval?** No documented approval gate exists for
  plugin-bundled servers. `Pending approval` is documented for project-scoped `.mcp.json`
  servers, resolved by running `claude` interactively and reset with
  `claude mcp reset-project-choices`. Headless contexts — `claude -p`, the Agent SDK, cloud
  sessions — load project servers without prompting.

  That is an absence of documentation, not a documented absence. Unit 5's wording therefore
  treats any not-yet-connected server as unavailable rather than assuming it will connect.

### Deferred to Implementation

- Whether a pending server's tools appear in the session registry or are absent from it.
  Undocumented either way, and it decides whether R5b's "absent" and "failed" reasons are
  distinguishable in that state. Observable only against a real install.
- Whether an untrusted workspace changes plugin-server behavior. Documented for
  project-scoped servers; silent for plugin-bundled ones.
- Whether `@modelcontextprotocol/core` needs to be a direct dependency or arrives
  transitively.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not
> implementation specification. The implementing agent should treat it as context, not code
> to reproduce.*

```
Claude Code session start
  └─ reads claude-code/.mcp.json          ← generated, carries the pinned version
       └─ spawns: npx -y @fro.bot/systematic@<version> systematic-mcp
            env: SYSTEMATIC_PROJECT_DIR = ${CLAUDE_PROJECT_DIR}
                 │
                 └─ dist/mcp.js
                      ├─ StdioServerTransport      (stdout is protocol; logs to stderr)
                      └─ registerTool('validate_review_artifact', { inputSchema: Zod })
                           └─ src/lib/mcp-validate-artifact.ts
                                ├─ containment root from SYSTEMATIC_PROJECT_DIR
                                ├─ ReviewArtifactSchema.safeParse
                                └─ returns structured status, never process.exit
```

Outcome mapping, replacing process exits:

| CLI exit | Condition | Tool result |
|---|---|---|
| 0 | Artifact valid | success, `status: passed` |
| 1 | Schema invalid | `isError: true`, `status: failed`, projected issues |
| 2 | Path refused / unreadable / malformed JSON | `isError: true`, `status: rejected` with a reason |
| 3 | No `schema_version` | `isError: true`, `status: legacy` |

## Implementation Units

- [ ] **Unit 1: Validation tool module**

**Goal:** A harness-agnostic module that validates a review artifact and returns a
structured outcome instead of exiting.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Create: `src/lib/mcp-validate-artifact.ts`
- Test: `tests/unit/mcp-validate-artifact.test.ts`
- Modify: `ARCHITECTURE.md` — codemap entry (gate-enforced)
- Modify: `src/lib/AGENTS.md` — module table row (gate-enforced)

**Approach:**
- Accept an artifact path and an explicit containment root. Do not read `process.cwd()`
  inside the module; the caller supplies the root so tests and the server agree.
- Reuse the containment rules from `src/cli.ts:388-448` — traversal rejection, symlink
  walk, realpath canonicalization, regular-file check. Extract rather than duplicate if the
  extraction is clean; if it is not, duplicate deliberately and note it.
- Return a discriminated result covering passed, failed, rejected, and legacy. Never call
  `process.exit`, never write to stdout.
- Project Zod issues to path and code, with `custom` messages only, exactly as
  `src/cli.ts:538-545` does. Artifact content must never appear in a result.

**Patterns to follow:** `src/cli.ts:388-555`; `src/lib/review-artifact-schema.ts`.

**Test scenarios:**
- Happy path: a conforming artifact under the root returns passed.
- Edge case: an artifact lacking `schema_version` returns legacy, not failed.
- Error path: a path outside the root is rejected, and the message names no file content.
- Error path: a `..` segment is rejected before any filesystem access.
- Error path: a symlinked final component is rejected.
- Error path: malformed JSON is rejected with a reason distinguishable from a read failure.
- Integration: a schema-invalid artifact returns projected issues carrying only path and
  code, asserted by planting a distinctive string in the artifact and confirming its
  absence from the result.
- Edge case: a root that does not exist returns a reason rather than throwing.

**Verification:** The module has no `process.exit` and no stdout write. Every rejection
path returns a reason. `bun scripts/content-integrity.ts` passes, confirming both
registration surfaces.

---

- [ ] **Unit 2: MCP server entry point**

**Goal:** A stdio MCP server exposing the validation tool.

**Requirements:** R3, R5a

**Dependencies:** Unit 1

**Files:**
- Create: `src/mcp.ts`
- Modify: `package.json` — add `@modelcontextprotocol/server`, bump `engines.node` to
  `>=20`, add the `systematic-mcp` bin entry, add `src/mcp.ts` to the build
- Test: `tests/integration/mcp-server.test.ts`

**Approach:**
- Build with `--target node`, matching `src/pi.ts` rather than the `--target bun` entries.
  The server runs under Node via `npx`.
- Register one tool with a Zod `inputSchema`. The SDK accepts Zod directly, so the schema
  is authored once.
- Require `SYSTEMATIC_PROJECT_DIR`: non-empty, absolute, and realpath-resolvable to an
  existing directory. Refuse startup with a reason otherwise. Do not fall back to `cwd` —
  for a resident server that would silently bind containment to the launcher's directory.
- Realpath the root before deriving the containment directory. The injected value carries
  whatever the launcher supplied and is not guaranteed canonical.
- Log to stderr only. A stdout write corrupts the JSON-RPC stream, and the failure mode is
  a protocol error rather than a visible bug.
- Map outcomes per the design table. A failed validation is a successful tool call with
  `isError: true` — not a thrown error and never a process exit.

**Execution note:** Implement the outcome mapping test-first. The passed/failed/rejected
distinction is the unit's whole contract and is easy to collapse.

**Patterns to follow:** `tests/integration/pi.test.ts:523-690` for the stdio harness —
`Bun.spawn` with piped stdio, request-ID correlation, and a timeout.

**Test scenarios:**
- Happy path: the server starts, responds to a tool-list request, and advertises the tool.
- Happy path: a valid artifact returns a success result.
- Error path: an invalid artifact returns `isError: true` and the server stays alive for a
  subsequent call — the regression that matters most.
- Error path: a refused path returns a rejection carrying no artifact content.
- Integration: nothing is written to stdout except JSON-RPC frames, asserted by parsing
  every stdout line as JSON.
- Edge case: with `SYSTEMATIC_PROJECT_DIR` set to a directory other than `cwd`, containment
  resolves against the env value. This is the defect from Key Technical Decisions.
- Error path: unset, empty, or relative `SYSTEMATIC_PROJECT_DIR` refuses startup with a
  reason rather than falling back to `cwd`.
- Error path: a `SYSTEMATIC_PROJECT_DIR` naming a nonexistent directory refuses startup.
- Edge case: a symlinked injected root resolves through realpath, and an artifact beneath
  it validates rather than being rejected as containing a symlink. The `cwd` measurement
  does not cover this path.

**Verification:** The server survives a failed validation and answers a following request.
Every stdout line parses as JSON.

---

- [ ] **Unit 3: Emit `.mcp.json` with a pinned version**

**Goal:** The bundle declares the server, pinned to the version CI just published.

**Requirements:** R1, R2, R2a

**Dependencies:** Unit 2 (the bin name must exist before it is referenced)

**Files:**
- Modify: `scripts/build-claude-code-plugin.ts`
- Test: `tests/integration/claude-code.test.ts`

**Approach:**
- Add a `--version` flag, following `.github/workflows/docs.yaml:61-90`'s precedent with
  `scripts/build-registry.ts`. The script currently takes no arguments.
- Never read `package.json` for this value — on `main` it is `0.0.0-semantic-release`.
  Absent flag means the build fails with a clear message, per "don't emit facts the build
  can't state truthfully".
- Add `.mcp.json` to the map in `generatePluginFiles()`. It inherits atomic staging from
  `writePluginFiles()`.
- Declare `command: npx`, `args: ['-y', '@fro.bot/systematic@<version>', 'systematic-mcp']`,
  and `env: { SYSTEMATIC_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}' }`.
- Leave `buildPluginManifest()` alone. The manifest still carries no `version`.

**Patterns to follow:** `scripts/build-registry.ts` for flag parsing;
`scripts/build-claude-code-plugin.ts:508-538` for the output map.

**Test scenarios:**
- Happy path: given a version, the emitted `.mcp.json` pins exactly that version.
- Error path: omitting the flag fails the build rather than emitting a placeholder.
- Error path: a malformed version is rejected rather than passed through.
- Edge case: the manifest still has no `version` key after this change.
- Integration: the emitted args reference the same bin name `package.json` declares —
  asserted by reading both, not by matching a literal.
- Happy path: the sentinel version builds successfully, so the non-release gate passes.
- Error path: a bundle carrying the sentinel is rejected by the publish guard — the
  assertion that keeps a gate build from ever shipping.

**Verification:** A build without `--version` fails. A build with one emits a pinned
`.mcp.json`, and the manifest is unchanged.

---

- [ ] **Unit 4: Pass the published version from CI**

**Goal:** The publish job supplies the version the release job produced.

**Requirements:** R2a

**Dependencies:** Unit 3

**Files:**
- Modify: `.github/workflows/main.yaml`

**Approach:**
- At `.github/workflows/main.yaml:305-306`, pass
  `needs.release.outputs.new-release-version` into the build.
- No release plumbing is needed. The output already exists at lines 218-220 and the job
  already depends on `release` and gates on `new-release-published == 'true'`.
- The build job at lines 86-88 also runs `claude-code:build` as a gate outside a release,
  where no published version exists. That gate proves the bundle assembles and must keep
  running, so it passes an explicit sentinel version.
- Extend the existing pre-publish guard (`.github/workflows/main.yaml:308-333`) to refuse
  any bundle whose `.mcp.json` carries the sentinel. A sentinel bundle builds but can never
  publish, which is exactly what the gate needs.

**Test scenarios:**
- Test expectation: none — workflow YAML has no unit-test surface here. The sentinel's
  rejection is asserted in Unit 3, where the build and its output are testable.

**Verification:** The publish job passes a real version. The non-release gate builds with
the sentinel. The pre-publish guard rejects a sentinel-bearing bundle.

---

- [ ] **Unit 5: Contract wording for two invocation paths**

**Goal:** The synthesis contract describes both a CLI and an MCP tool without asserting
which harness has which.

**Requirements:** R3, R4, R5, R5b, R6

**Dependencies:** None

**Files:**
- Modify: `skills/ce-review/references/synthesis-artifact-contract.md`

**Approach:**
- The current wording checks whether `systematic` is on `PATH`. Under MCP there is no PATH
  check — a tool either exists in the session or does not. Followed literally on Claude
  Code, the parent would skip validation and record `unavailable` while a working tool sat
  in the session.
- State both capabilities as conditions rather than naming harnesses. Per the cross-harness
  learning, prose that assumes per-harness behavior is how divergence gets encoded.
- Keep the existing `validation.status` semantics. `not_attempted` still means a capability
  was present and unused; `unavailable` still means none was reachable — including a server
  present but not yet approved, and a server present without the tool registered.
- State that an unreachable capability is recorded and the run continues. This is where R5
  lives: nothing else in the plan tells the parent not to stall, and a contract that only
  describes the reachable path leaves the unreachable one to improvisation.
- Do not restate any of this in `skills/ce-review/SKILL.md`; it links by design.

**Test scenarios:**
- Test expectation: none — instruction prose with no executable surface. `bun
  scripts/content-integrity.ts` covers structural validity.

**Verification:** The wording names no harness. Both paths are conditions. `unavailable`
and `not_attempted` keep their existing meanings.

---

- [ ] **Unit 6: Installed-artifact verification**

**Goal:** Prove the published package actually launches and answers, rather than proving
the build succeeded.

**Requirements:** R1, R2, R3

**Dependencies:** Units 1-4

**Files:**
- Modify: `tests/unit/package-exports.test.ts`

**Approach:**
- Build, pack, and install the package into a temporary directory, then execute the bin the
  `.mcp.json` names — the pattern already at `tests/unit/package-exports.test.ts:116-320`.
- Cover only what Units 1-3 structurally cannot: that the *published* artifact contains the
  entry point and that it runs from an install rather than from source. Unit 2 already
  proves protocol behavior and Unit 3 already proves emission; do not restate either here.
- Resolve the bin name from the emitted `.mcp.json` rather than hardcoding it, so a rename
  in either place fails.

**Test scenarios:**
- Integration: the packed tarball contains the server entry point — `files` omissions are
  invisible to every other test in this plan.
- Integration: `package.json` `bin` declares the name `.mcp.json` invokes.
- Integration: the installed server starts under Node and answers one tool-list request.
  One round trip is enough; Unit 2 owns protocol coverage.
- Edge case: `engines.node` is `>=20`, matching the SDK floor.

**Verification:** The installed server answers over stdio. Nothing in this unit reads from
`src/`.

## System-Wide Impact

- **Interaction graph:** Claude Code sessions gain a spawned subprocess at startup.
  OpenCode and Pi are untouched — neither loads `.mcp.json` and neither gains a dependency
  on the server.
- **Error propagation:** Failures cross a process boundary as tool results rather than
  exceptions. A failed validation must never terminate the server, or the session loses
  validation for every subsequent turn.
- **State lifecycle risks:** The server is stateless — read, parse, validate, return. Two
  concurrent calls are safe. The pre-existing risk that two runs write the same artifact
  path is unchanged by this work and out of scope.
- **API surface parity:** The CLI subcommand and the MCP tool become two entry points to
  one validation module. They must not drift; sharing the module rather than shelling out
  is what prevents it.
- **Install surface:** `engines.node` moves to `>=20` for every consumer, including the two
  harnesses this work otherwise leaves alone. This is the only way any of them observes the
  change.
- **Unchanged invariants:** `bin.systematic` keeps its meaning. The plugin manifest still
  omits `version`. `SECURITY_OVERLAY_FIELDS`, the config priority order, and the OpenCode
  hook set are untouched.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Node floor bump breaks a consumer on 18 | `engines.node` is package-wide, so this reaches OpenCode and Pi consumers who never launch the server. Node 18 reached end of life in April 2025. Ship it as a named compatibility change in release notes, not as a diff detail. |
| Claude Code needs a pin cadence independent of the package | Recorded as a known consequence rather than solved now. The escape hatch is a separate package or a non-`npx` command; nothing in this design forecloses either. |
| Injected containment root is empty, relative, or non-canonical | The server refuses startup rather than falling back, and realpaths the root before use. Both are Unit 2 scenarios. |
| First launch has no registry | Measured: an uncached pinned version fails `--offline` with `ENOTCACHED`. R4 and R5 cover it — the run records unavailable and continues. Subsequent launches are cache-served and unaffected. |
| A pending or untrusted server behaves unlike a failed one | No approval gate is documented for plugin-bundled servers, but the registry semantics of a pending server are not documented either. Unit 5 treats not-yet-connected as unavailable, which is correct under either behavior. |
| Server and CLI drift | They share one module. Unit 6 asserts the installed artifact rather than the source. |
| Containment anchored on the wrong directory | The defect that would have made this inert. Fixed in Unit 1 by taking the root as a parameter, and covered by a Unit 2 scenario. |

## Documentation / Operational Notes

- `ARCHITECTURE.md` needs the new module in its codemap and a note that the Claude Code
  bundle now carries an MCP declaration. Both surfaces are gate-enforced; Unit 1 carries
  them.
- `HARNESSES.md` records verified per-harness capability and should reflect that Claude
  Code gains a callable tool.
- The `engines.node` bump is user-visible and belongs in the release notes, not only the
  diff.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-08-23-claude-code-mcp-server-requirements.md`
- Related issues: #854 (guard portability), #795 (synthesis pipeline extraction)
- Related PRs: #851 (conditional validator instruction), #853 (validation status field)
- MCP SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code hooks: https://code.claude.com/docs/en/hooks
