---
title: 'feat: Ship the review-artifact validator in the Claude Code bundle'
type: feat
status: active
date: 2026-08-24
origin: docs/brainstorms/2026-08-23-claude-code-mcp-server-requirements.md
---

# feat: Ship the review-artifact validator in the Claude Code bundle

## Overview

`ce:review` validates its own run artifact by invoking `systematic validate-review-artifact`.
The Claude Code bundle ships the prose that names that command but nothing that can run it,
so validation there records an absence rather than a result.

This adds a purpose-built validator executable to the bundle's `bin/`, which Claude Code adds
to the Bash tool's `PATH`. OpenCode and Pi are untouched.

Every fact this rests on was measured against a real install of Claude Code 2.1.163, including
`PATH` exposure, which was confirmed with a negative control: a bundled `bin/` entry ran as a
bare command in a Bash tool call while the plugin was installed, and returned `command not
found` with exit 127 after uninstall. The command was never on the shell's own `PATH`, so the
exposure is plugin-scoped rather than ambient.

## Problem Frame

A superseded plan (`docs/plans/2026-08-23-001-feat-claude-code-mcp-server-plan.md`) routed
this through an MCP server because a Claude Code bundle was assumed unable to carry an
executable. That premise was measured false against a real install of Claude Code 2.1.163:
marketplace install copies the entire plugin directory including undeclared directories,
preserves the executable bit, and `bin/` is documented as *"Executables added to the Bash
tool's `PATH`... invokable as bare commands in any Bash tool call while the plugin is
enabled."*

The real constraint is entry-point scope. The full CLI cannot ship as one file —
`jsonc-parser`'s UMD branch emits a runtime `require("./impl/format")` no bundler resolves
statically. An entry importing only the review-artifact schema builds to 0.27 MB minified
with no dynamic requires.

Two hazards would ship this inert, both measured rather than reasoned:

- `Bun.build({target:'node'})` emits **no shebang**. Executed as a bare command, the shell
  reads it as a shell script: `./out.js: line 1: //: Is a directory`.
- `writePluginFiles` drops the executable bit. `skills/git-worktree/scripts/worktree-manager.sh`
  is `-rwxr-xr-x` in source and `-rw-r--r--` in the built bundle.

## Requirements Trace

Carried from the origin document, restated for a bundled executable rather than a server.
Requirements about MCP launch and npm resolution (R1, R2, R2a) are dissolved by the delivery
change and are recorded in Scope Boundaries.

- R1. The bundle ships an executable that Claude Code can invoke as a bare command.
- R2. The executable is produced by the bundle build, not committed to `main`.
- R3. It has the same accept and reject behavior as the CLI subcommand, including path
  containment and the allowlist projection of validation errors. It must not echo artifact
  content and must not become a general file reader.
- R4. When the executable is absent or cannot run, the run continues and records validation
  as unavailable with a reason, using the field the artifact already defines.
- R5. No failure to find or run it blocks or stalls a review run.
- R5b. Absent is distinguishable from present-but-failed. Both degrade safely; they are
  different reasons.
- R6. OpenCode and Pi behavior is unchanged. Neither harness's tool registration is modified.
- R7. A build that cannot produce the executable fails the build rather than publishing a
  bundle without it.

## Scope Boundaries

- Any change to OpenCode's `tool` hook or Pi's tool registration.
- The workflow guard on Claude Code. Deferred, not impossible — see #854.
- Extracting `ce:review`'s synthesis pipeline into code. Separate work, see #795.
- Exposing skill loading. Claude Code has a native `Skill` tool.
- Changing how `resolveReviewArtifactPath` anchors containment. It stays on `cwd`; see the
  decision below.
- Widening the bundled entry beyond artifact validation. The contract names one command
  today.

### Dissolved by the Delivery Change

- MCP server delivery, `.mcp.json` declaration, and server lifecycle (origin R1).
- Launching from the published npm package (origin R2) and pinning an immutable version
  (origin R2a). The artifact is built from the same commit as the prose beside it, so there
  is no version to resolve.
- Post-startup hang handling (origin R5a). There is no resident process; a subprocess that
  hangs is bounded by the caller.

## Context & Research

### Relevant Code and Patterns

- `scripts/build-claude-code-plugin.ts:508-538` — `generatePluginFiles`, pure and sync,
  returns `Map<string, Buffer>`. New fixed files are added at `:511-524`.
- `scripts/build-claude-code-plugin.ts:301-307` — `isTranslatableFile` matches only
  `skills/*/*.md`, `agents/*.md`, `output-styles/systematic.md`. A `bin/` entry passes
  through `translateBundle` and `checkGeneratedNamespace` byte-for-byte.
- `scripts/build-claude-code-plugin.ts:576-580` — `writePluginFiles` calls
  `fs.writeFileSync(outPath, content)` with no mode. No test asserts modes.
- `scripts/build-claude-code-plugin.ts:69-87` — `buildPluginManifest` emits no version and
  declares no component paths, so no manifest change is needed.
- `.github/workflows/main.yaml:284-306` — `publish-claude-code-plugin` runs only
  `bun run claude-code:build`. It does not run `bun run build`, and the `build` job's `dist/`
  is not uploaded, so nothing may depend on `dist/`.
- `.github/workflows/main.yaml:308-328` — the pre-publish guard checks a fixed required-file
  list. It does not assert anything under `bin/`.
- `src/cli.ts:400` — `artifactRoot` resolves `.context/systematic/ce-review` relative to the
  passed `cwd`; `:411` returns *"Review artifact directory is unavailable"* when absent.
- `skills/ce-review/references/synthesis-artifact-contract.md:213-224` — the availability
  check and the four `validation.status` values.

### Institutional Learnings

- `docs/solutions/best-practices/entry-point-scope-decides-what-a-plugin-can-ship-2026-08-24.md`
  — the measurements this plan rests on, and the rule that reachability is written as a
  runtime-checkable condition rather than a harness list.
- `docs/solutions/integration-issues/availability-guards-must-check-executability-2026-08-16.md`
  — *"checks only that the command exists on `PATH`. A version manager can place a shim there
  that fails on every invocation, so the guard passes."* The check must prove it runs.
- `docs/solutions/workflow-issues/fail-closed-components-report-their-own-state-2026-08-23.md`
  — a component reports its own state, not the fault beneath it. A missing executable records
  unavailable with a reason, never a validation failure.
- `docs/solutions/best-practices/claude-code-plugin-build-and-publish-architecture-2026-07-18.md`
  — *"Build to gitignored staging; never commit the bundle... the build is the source of
  truth."* The executable is generated at bundle time, so no committed artifact and no drift
  gate.
- `docs/solutions/best-practices/unvalidated-artifact-contracts-have-no-conforming-producers-2026-08-23.md:128-129`
  — states the bundle is *"built deliberately without npm coupling and carries no executable."*
  This plan makes the second half of that sentence false.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "repository root, focused on scripts/, tests/, .github/workflows/, and src/",
  "freshness": {
    "vcs_reference": "76d8d0a3099331b53cacf99631665773554e5e6a"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "scripts/build-claude-code-plugin.ts:508-538",
      "description": "Composes the bundle file map keyed by bundle-relative path.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "scripts/build-claude-code-plugin.ts:567-612",
      "description": "Writes buffers through atomic staging and rename-aside replacement.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": ".github/workflows/main.yaml:284-362",
      "description": "Builds the bundle in a fresh job and publishes it to the orphan branch.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "tests/unit/build-claude-code-plugin.test.ts:92-251",
      "description": "Asserts generated file presence, content fidelity, and determinism.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "scripts/build-registry.ts:391-485",
      "description": "Copies generated component files into dist/registry.",
      "disposition": "insufficient",
      "insufficiency_reason": "Copies content but never establishes executable file modes."
    },
    {
      "path_or_symbol": ".github/workflows/docs.yaml:100-144",
      "description": "Publishes generated docs output to a branch worktree.",
      "disposition": "insufficient",
      "insufficiency_reason": "Shows branch publication but no executable artifact construction."
    }
  ]
}
```

## Key Technical Decisions

- **The bundled command gets a distinct name, not `systematic`.** A bare `systematic` on the
  Bash tool's `PATH` collides with a globally installed npm binary, and `PATH` order decides
  the winner. Whichever wins, the bundled prose and the executable answering it could come
  from different versions. A distinct name is always the one shipped beside the prose.

- **The artifact is built in memory with `Bun.build()` at bundle time.** Measured at 0.27 MB
  minified with no dynamic requires, and byte-identical across two consecutive builds on one
  Bun version and one platform. No `dist/` dependency, which matters because the publish job
  has no `dist/` to consume.

- **Determinism is scoped to a fixed toolchain, and CI does not currently fix one.**
  `.github/workflows/main.yaml:300` uses `oven-sh/setup-bun` with no `bun-version`, so the
  publish job installs whatever Bun is current. Bundler output may therefore change with no
  input change. That is not harmful — the guard still runs and the artifact is still correct —
  but it means "unchanged input produces no commit" holds per toolchain, not absolutely.

- **`generatePluginFiles` stays pure and sync.** `Bun.build()` is awaited in the script's
  entrypoint and the resulting buffer is passed in as an argument. The function keeps its
  heavy unit coverage without every test needing to run a bundler.

- **The build prepends a shebang and writes `bin/` entries with mode `0o755`.** Both are
  measured requirements, not defensive extras. Without either, the command is present and
  unrunnable.

- **Containment stays anchored to `cwd`.** Changing `resolveReviewArtifactPath` to discover a
  repository root would alter CLI behavior on every harness for a case outside this plan. The
  contract states the command runs from the repository root, where `.context/` lives and the
  invoking agent already operates. When it does not, `src/cli.ts:411` returns a clear message
  and the run records unavailable with that reason — visible, not silent.

- **The availability check probes execution, not presence.** Per the learning above, a name on
  `PATH` proves nothing. The contract has the parent run the command and read its result.

- **The pre-publish CI guard asserts the `bin/` entry.** Without it, a build that silently
  produced no executable would publish to the branch users install from.

## Open Questions

### Resolved During Planning

- Should this be an MCP server? No. Measured: the bundle carries and runs executables. See
  the superseded plan.
- Can the full CLI ship? No. `jsonc-parser`'s UMD branch blocks static bundling. A
  purpose-built entry does not import it.
- Does committing a 0.27 MB artifact bloat the orphan branch? Less than feared. The workflow
  commits only on change, and consecutive builds on a fixed toolchain are byte-identical, so
  it grows when the schema, its dependencies, or the bundler changes — not per release.
- Is `cwd` the right containment anchor here? Yes, unlike the MCP case where `cwd` belonged
  to the launcher. A Bash tool call runs in the project directory.

### Deferred to Implementation

- The exact binary name. It must not be `systematic`; the specific string is a naming choice
  best made against the contract prose as it is written.
- Whether the entry re-uses `resolveReviewArtifactPath` directly or a narrowed export. That
  depends on what importing `src/cli.ts` drags in, which is only knowable by building it.
- Whether the integration suite can execute the built artifact in CI, or only assert its
  shape.
- Whether to pin `bun-version` for the publish job. Pinning makes artifact changes
  attributable to source changes; leaving it unpinned keeps the job consistent with every
  other job in the workflow, which is also unpinned. Changing it for one job only would be an
  inconsistency worth deciding deliberately rather than by default.

## Implementation Units

- [ ] **Unit 1: Build the validator entry and add it to the bundle**

**Goal:** The bundle contains a runnable validator executable.

**Requirements:** R1, R2, R3, R7

**Dependencies:** None

**Files:**
- Create: `src/claude-code-validator.ts`
- Modify: `scripts/build-claude-code-plugin.ts`
- Modify: `STRUCTURE.md` (Entry Points table — a fourth `src/` entry point)
- Modify: `src/cli.ts` — likely; see the note below
- Test: `tests/unit/build-claude-code-plugin.test.ts`

This list is not exhaustive. The containment helpers the entry needs —
`resolveReviewArtifactPath`, `hasParentDirectoryTraversal`, and `pathContainsSymlink` — are
private to `src/cli.ts` and exported nowhere, so reusing them means either exporting them or
extracting them. Which is right depends on what importing them drags in, which is the open
question below. If extraction wins, a new `src/lib/` module also carries the `ARCHITECTURE.md`
codemap and `src/lib/AGENTS.md` module-table obligations, both gate-enforced by
`bun scripts/content-integrity.ts`.

**Approach:**
- The entry imports only `src/lib/review-artifact-schema.ts` and the containment helper. It
  must not import `src/cli.ts` wholesale — that reintroduces `jsonc-parser`.
- `Bun.build()` runs in the script's entrypoint, not inside `generatePluginFiles`. The buffer
  is passed in as a parameter so the pure function stays sync and testable.
- The build prepends `#!/usr/bin/env node` to the buffer before it enters the file map.
- A build failure throws and exits non-zero. It never emits a bundle without the entry.
- Exit codes and the error projection match the CLI subcommand exactly: 0 valid, 1 invalid,
  2 usage or unreadable, 3 legacy artifact without `schema_version`.

**Patterns to follow:**
- `scripts/build-claude-code-plugin.ts:511-524` for adding a fixed bundle file.
- `src/cli.ts` for exit codes and the `{path, code}` allowlist projection.

**Test scenarios:**
- Happy path: the generated file map contains the `bin/` entry and its buffer is non-empty.
- Happy path: the first line of the `bin/` buffer is the shebang.
- Edge case: the `bin/` entry passes through `translateBundle` byte-for-byte and is not
  namespace-checked.
- Edge case: two builds of unchanged input produce byte-identical `bin/` content.
- Error path: a `Bun.build()` failure propagates and the build exits non-zero rather than
  emitting a bundle without the entry.
- Integration: the built artifact validates a known-good artifact and rejects a known-bad
  one, with the documented exit codes.
- Integration: the error output contains only `path` and `code`, never artifact content.

**Verification:**
- The real repository build emits the `bin/` entry with a shebang.
- Running the built artifact against a valid and an invalid artifact returns the same
  verdicts and exit codes as the CLI subcommand.

- [ ] **Unit 2: Preserve the executable bit when writing the bundle**

**Goal:** The shipped executable is executable.

**Requirements:** R1

**Dependencies:** Unit 1

**Files:**
- Modify: `scripts/build-claude-code-plugin.ts`
- Test: `tests/unit/build-claude-code-plugin.test.ts`

**Approach:**
- `writePluginFiles` currently writes every file mode-blind at `:576-580`. Entries under
  `bin/` are written `0o755`; everything else keeps current behavior.
- This is deliberately narrow. Restoring source modes for every file is a larger behavior
  change, and no skill script needs it — they are invoked as `bash <path>`.

**Test scenarios:**
- Happy path: a `bin/` entry is written with the executable bit set.
- Edge case: a non-`bin/` entry is unaffected and keeps the current mode.
- Integration: after a real build, the `bin/` entry is executable on disk.

**Verification:**
- `stat` on the built `bin/` entry shows an executable mode.
- Existing bundle tests still pass unchanged.

- [ ] **Unit 3: Assert the executable before publishing**

**Goal:** A build that lost the executable cannot reach the branch users install from.

**Requirements:** R7

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `.github/workflows/main.yaml`

**Approach:**
- Add the `bin/` entry to the required-file list in the pre-publish guard at `:308-328`.
- Assert it is executable, not merely present. A present-but-unrunnable file is the failure
  mode Unit 2 exists to prevent, so the guard must be able to see it.
- The guard proves the artifact is correct in the repository. It cannot prove Claude Code
  still puts `bin/` on the Bash tool's `PATH` — that is host behavior, measured at 2.1.163 and
  not pinned by anything in this repository. Record the confirming check and the version it
  passed at, so a future host change is attributable rather than mysterious.

**Test scenarios:**
- Test expectation: none — workflow configuration with no unit-testable surface. Verified by
  the guard failing on a bundle missing the entry.

**Verification:**
- The guard fails when the entry is absent or not executable, and passes on a correct bundle.
- On a real install, the bundled command runs as a bare command in a Bash tool call. Confirmed
  at Claude Code 2.1.163; re-confirm when the host major version moves.

- [ ] **Unit 4: State reachability in the contract**

**Goal:** The parent knows how to reach the validator on Claude Code, and what to record when
it cannot.

**Requirements:** R3, R4, R5, R5b, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `skills/ce-review/references/synthesis-artifact-contract.md`

**Approach:**
- The current wording at `:213-224` says the executable ships through the npm `bin` entry and
  that a markdown-only harness will not have it. That becomes false for Claude Code.
- Resolution order is explicit: the bundled command first, then the npm-installed subcommand.
  Stating the order matters because both can be present at once, and the bundled one ships
  beside the prose being executed. The parent runs whichever it resolves rather than testing
  for presence, because a name on `PATH` can be a shim that fails on every invocation.
- Absent and present-but-failed are recorded as different reasons under
  `validation.status: "unavailable"`. Neither is ever recorded as `failed` — that value means
  the artifact was validated and did not conform.
- The command runs from the repository root. When it does not, the CLI reports the directory
  is unavailable and that reason is recorded.

**Test scenarios:**
- Test expectation: none — bundled prose with no executable surface. Verified by
  content-integrity and by reading the rendered contract.

**Verification:**
- `bun scripts/content-integrity.ts` is clean.
- The contract no longer claims a bundled-markdown harness cannot have the executable.

- [ ] **Unit 5: Correct the stale no-executable claim**

**Goal:** No shipped doc asserts the bundle carries no executable.

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `docs/solutions/best-practices/unvalidated-artifact-contracts-have-no-conforming-producers-2026-08-23.md`

**Approach:**
- Lines 128-129 state the bundle is *"built deliberately without npm coupling and carries no
  executable."* Its surrounding recommendation — write instructions as runtime-checkable
  conditions — survives and is reinforced. Only the premise needs correcting.
- The correction is one passage, not a rewrite. The doc's subject is artifact contracts, not
  bundle packaging.

**Test scenarios:**
- Test expectation: none — documentation.

**Verification:**
- `bun scripts/content-integrity.ts` is clean and the doc's own frontmatter limits still hold.

## System-Wide Impact

- **Interaction graph:** The bundle build gains an async step in its entrypoint.
  `generatePluginFiles` keeps its signature shape and its sync purity.
- **Error propagation:** A build failure fails the build. A runtime failure records
  unavailable with a reason and the review run continues.
- **State lifecycle risks:** The publish job commits only when content changes, so an
  unchanged artifact adds nothing to the orphan branch.
- **API surface parity:** None. The npm CLI is unchanged and OpenCode and Pi see no
  difference.
- **Integration coverage:** Executing the built artifact end to end is the only thing that
  proves the shebang and mode are both right; a shape assertion alone would have passed for
  both measured hazards.
- **Unchanged invariants:** `src/index.ts` keeps its single default export. Agent frontmatter
  stays model-free. `resolveReviewArtifactPath` keeps its current anchoring and error text.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The executable ships present but unrunnable | Measured — shebang and mode are explicit units, and the CI guard asserts executability rather than presence |
| A future Claude Code version stops exposing `bin/` on `PATH` | Host behavior this repository does not control; the release-time check names the version it passed at, and the contract already degrades to unavailable with a reason |
| A silent build failure publishes a bundle without it | The build throws rather than emitting a partial bundle, and the pre-publish guard fails closed |
| The bundled name collides with a global npm binary | A distinct name, so the prose and the executable answering it always ship together |
| Invocation from a subdirectory fails containment | Degrades visibly to unavailable with the CLI's own reason, and the contract states the invocation directory |
| The entry silently regains an unbundlable dependency | A determinism and shape assertion on the built buffer, plus the build failing rather than emitting a broken entry |

## Documentation / Operational Notes

- Units 4 and 5 are the documentation surface. No user-facing install change: the bundle is
  published by the existing workflow and installed through the existing marketplace ref.
- Build changes must land before or with the contract prose. Prose first would instruct
  Claude Code to reach for something not yet shipped, which is the failure #851 fixed.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-08-23-claude-code-mcp-server-requirements.md` —
  untracked in this repository (`.gitignore:45`), so a reader cloning the repo will not find
  it. Its requirements are restated above.
- Superseded plan: `docs/plans/2026-08-23-001-feat-claude-code-mcp-server-plan.md`
- Measurements: `docs/solutions/best-practices/entry-point-scope-decides-what-a-plugin-can-ship-2026-08-24.md`
- Related issues: #854 (guard portability), #795 (synthesis extraction)
- Claude Code plugin reference: https://code.claude.com/docs/en/plugins
