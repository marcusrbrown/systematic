---
title: "feat: pi-subagents interop — export Systematic personas + runtime detection"
type: feat
status: active
date: 2026-07-28
deepened: 2026-07-28
origin: docs/brainstorms/2026-07-28-pi-subagents-interop-requirements.md
---

# feat: pi-subagents interop — export Systematic personas + runtime detection

## Overview

Make Systematic's compound-engineering personas usable by the `pi-subagents` Pi extension (mature parallel/multi-model delegation), without weakening Systematic's own bounded delegation. Two sequenced increments: (1) an **opt-in generated export** that emits a curated subset of Systematic personas as `pi-subagents`-compatible flat agent files, plus setup wiring and docs; (2) **runtime presence detection** via the Pi shared event bus that adjusts Pi model guidance when `pi-subagents` is present, with version-gated graceful degradation. The bounded `systematic_delegate` stays the untouched default throughout.

## Problem Frame

On OpenCode, Systematic delegates via the host `task()` tool (parallel + background). On Pi, `systematic_delegate` is deliberately bounded (sequential, 20-turn cap, same-model, depth-1 containment, re-entry guard — PR #629), making Pi the degraded delegation harness. A Systematic user asked whether we'd adopt `pi-subagents` (a mature third-party Pi extension: parallel/background subagents, per-subagent model, personas, steering, worktree isolation; MIT, 0.x). Systematic's durable value is the personas + workflow loop, not the delegation transport — and the bounded delegate's *safety* is itself part of that value. So the chosen direction is **interop, not absorption**: the ecosystem owns the parallel-delegation engine; Systematic makes its personas usable by it while keeping the bounded delegate as the default. See origin: `docs/brainstorms/2026-07-28-pi-subagents-interop-requirements.md`.

## Requirements Trace

- R1. `systematic_delegate` and all its bounds/tests remain unchanged; this plan only adds interop (origin R1).
- R2. Export a **curated subset** of personas as `pi-subagents`-compatible flat `systematic-<name>.md` files, generated from `agents/` source (origin R2).
- R3. Exported files are model-free, consistent with the bundled-agent invariant (origin R3).
- R4. Export is opt-in only via an explicit command/flag; no write is triggered by detection, `.pi/agents/` existence, or extension load (origin R4).
- R5. Filenames are namespaced and sanitized to a strict safe charset; the resolved write target must stay under the user-selected root (no traversal, no symlink escape) (origin R5).
- R6. Export writes a manifest, is idempotent, and provides cleanup + a re-export/refresh command that detects drift between a user's exported copy and current source; exported files are user-owned and may drift until re-exported (origin R6).
- R7. Export scope (project `.pi/agents/` vs global `$PI_CODING_AGENT_DIR/agents/`) is user-chosen; target dir + files to create/overwrite are shown before writing (origin R7).
- R8. Personas pass **compatibility screening** before export: each candidate is classified info / warning / critical by its dependence on Systematic-only tooling and orchestration. Critical-coupled personas are **excluded** from the export set, not rewritten; warning personas may export with a generated compatibility note; only surface token-level references (e.g. `ce:*` mentions in policy prose) are lightly adapted. The generator does not rewrite orchestration semantics (origin R2 + deepening findings).
- R9. Runtime detection subscribes to `subagents:ready` and verifies via `subagents:rpc:ping`, used only to nudge + adjust guidance; never authorizes writes (origin R8).
- R10. Guidance advertises the `pi-subagents` path only in the `present-supported` state (detection + ping version mapping to a tested guidance template); all other states get no operational Agent-tool instructions. When absent, degrade with no error (origin R9, R10 + version-drift finding).
- R11. The interop path never hard-fails, blocks, or errors on `pi-subagents` absent/version-mismatch/contract-change; `pi-subagents` is never bundled or a hard/peer dependency (origin R10).
- R12. The `systematic_delegate` re-entry boundary (`noExtensions` depth-1) is verified by an explicit test; the plan states narrowly that this bounds `systematic_delegate`'s own recursion, not global end-to-end depth (origin R11 + adversarial finding).
- R13. Docs + `HARNESSES.md` + the Pi capability profile reflect "bounded built-in delegate + optional mature delegation via pi-subagents", the export/setup pairing, a documented **tested pi-subagents version range**, and that the combined delegation path is outside Systematic's bounded-delegate guarantees (origin R12 + deepening).
- R14. Personas that critically depend on Systematic-only orchestration/tooling are excluded from the export set by default; the curated include list carries a per-persona compatibility rationale, and the generator check-fails if a curated persona gains a new critical incompatibility (deepening finding).

## Scope Boundaries

- Not modifying `systematic_delegate`'s bounds or adding parallelism/multi-model to Systematic's own delegate.
- Not bundling `pi-subagents` or adding it as a hard/peer dependency.
- Not auto-emitting persona files on detection, `.pi/agents/` existence, or extension load.
- Not overwriting user-authored agent files or writing outside the user's chosen scope.
- Not building a merged persona catalog between `systematic_delegate` and `pi-subagents`.
- Not depending on undocumented `pi-subagents` internals beyond the documented `pi.events` bus + the ecosystem-convention channels.
- **The export does not promise semantic equivalence.** It emits a curated subset of personas that are usable as standalone/subagent personas after compatibility screening. It is not a prompt-rewrite engine and does not repair personas that depend on Systematic's orchestration loop, skill loading, task tracking, or bounded-execution guarantees.
- Systematic does not bundle or guarantee `pi-subagents` behavior beyond the tested interop contract; versions outside the tested range are unsupported-but-nonfatal.

### Deferred to Separate Tasks

- Global end-to-end delegation-depth bound across the combined `pi-subagents` + `systematic_delegate` surface: characterized here (test), but any *enforcement* control is a separate future effort if wanted.
- Exporting the full ~37-agent persona set (beyond the curated delegation subset): future iteration if demand appears.

## Context & Research

### Relevant Code and Patterns

- `scripts/build-claude-code-plugin.ts` — `flattenAgents()` (`:410-501`), `foldIdentity()` NFC+case-fold collision (`:399-408`), `writePluginFiles()` atomic temp-then-swap (`:541-612`), `parseFrontmatter` usage. Reuse-as-is: flatten, collision, atomic write. CC-specific (do NOT reuse): `translateBundle()`, `checkGeneratedNamespace()`.
- `scripts/generate-agent-browser-skill.ts` — generate/`--check`-drift/write shape (`:209-373`) + `if (import.meta.main)` entrypoint guard. Mirror for the export generator + manifest + drift.
- `scripts/generate-registry.ts` — pure-generator + `--check` + compare-normalization shape (`:139-402`). Mirror for drift.
- `src/lib/setup.ts` — `atomicWrite()`/`writeTempAndRename()` (`:188-230`), `setupPi()` (`:390-475`), `setupHarness()` (`:477-503`), idempotent update. Reuse for opt-in wiring. `src/cli.ts:57-85` `setupCommand()` — arg parsing currently accepts only `setup --harness <one arg>`; widen or add a command.
- `src/pi.ts` — extension registration (`:54-117`), bootstrap assembly (`:62-71`), `pi.on('before_agent_start', …)` injection (`:73-83`), `pi.registerTool(...)` (`:85-117`). `pi.events` (EventBus) is available on the ExtensionAPI for Increment 2.
- `src/lib/bootstrap.ts` — `readHarnessProfile()` (`:114-132`), `composeSystemPromptWithBootstrap()` (`:163-180`).
- `skills/using-systematic/references/pi-profile.md:5-10`, `HARNESSES.md:27-34`, `docs/src/content/docs/getting-started/installation.mdx:122-145`, `docs/src/content/docs/index.mdx:124-135` — doc/profile edit targets.

### Institutional Learnings

- `unguarded-generator-main-repairs-drift-when-imported-by-tests-2026-07-28.md` — guard the generator entrypoint with `if (import.meta.main)`; keep exports pure.
- `vendor-npm-packaged-skill-as-generated-artifact-2026-07-28.md` — source-of-truth generator + `--check` drift + manifest.
- `verify-installed-artifacts-not-just-build-gates-2026-07-18.md` — inspect the emitted persona files in their installed context, not just CI-green.
- `pi-real-runtime-integration-harness-2026-07-16.md` — verify Increment 2 against the real Pi runtime (real CLI boot, RPC), not fake-SDK adapters.
- `opencode-plugin-hook-silent-defect-swallow-2026-05-19.md` — optional extension coupling must be explicit try/catch + observable; never silent-swallow or hard-fail.
- `layered-trust-boundaries-overlay-config-2026-05-09.md` / `local-systematic-overrides-global-2026-05-14.md` — keep setup/config writes trust-scoped; generated output may replace prior generated output, never user-owned config.
- `third-party-bundled-skills-light-adaptation-2026-05-17.md` — keep adaptation mechanical and bounded; count rewrite categories; preserve provenance (reinforces exclude-over-transform).

### External References

- `pi.events` EventBus is documented (`earendil-works/pi` `packages/coding-agent/docs/extensions.md`; `ExtensionAPI.events: EventBus`, `on/emit(channel, handler)`). Channels `subagents:ready`, `subagents:rpc:ping`, `subagents:rpc:ping:reply:<requestId>` (reply `{success, data:{version:2}}`) are **ecosystem conventions** used by `tintinweb/pi-subagents`, `tintinweb/pi-tasks`, `luongnv89/pi-extensions` — not SDK-enforced lifecycle events.

## Key Technical Decisions

- **Interop, not absorption**: bounded delegation is a product guarantee; default guidance stays the bounded delegate, pi-subagents is explicit opt-in (origin KD1).
- **Generated-compat-artifact is the only viable mechanism**: `pi-subagents` reads fixed flat dirs with no registration API, so export = emit flat files from source, drift-checkable (origin KD2).
- **Exclude over transform**: personas that critically depend on Systematic's orchestration/tooling are excluded from the export set rather than rewritten — heavy transformation forks a prompt dialect and creates a maintenance trap; exclusion keeps the export boundary honest and delete-friendly. Prefer a broad subset of self-contained personas (research/review/document-review + a few workflow) and exclude orchestration-, skill-, or environment-coupled ones.
- **Compatibility screening + light adaptation, not a rewrite engine**: the generator classifies each candidate (info/warning/critical), lightly adapts only surface token references, annotates warnings, and refuses/excludes critical. It never silently strips behavioral instructions (leaky-boundary risk).
- **Version-template guidance, not a boolean**: model-facing guidance is selected from a source-controlled compatibility table (tested pi-subagents version/protocol → supported guidance template). Unknown/incompatible versions get no operational Agent-tool instructions — stale guidance that mis-describes the `Agent` tool is worse than none.
- **Detection is best-effort and non-fatal**: `pi.events` coupling wrapped in explicit try/catch, observable, never blocking (plugin-hook-silent-swallow learning).
- **Drift is source-side only**: exported files become user-owned; a re-export/refresh command surfaces drift — the export is not "drift-locked" on the user's machine (adversarial correction).

## Open Questions

### Resolved During Planning

- Can Systematic subscribe to `subagents:ready`? Yes — `pi.events.on(...)` on the ExtensionAPI (documented bus; channels are conventions). Increment 2 is feasible without an upstream SDK change.
- Persona scope? Curated subset, exclusion-first: broad set of self-contained research/review/document-review personas + a few workflow; orchestration/skill/env-coupled personas excluded (concrete include/exclude list in Unit 1, grounded in real coupling density).
- Verbatim vs transform? Neither — compatibility screening + light adaptation + exclude-on-critical (deepening correction to the brainstorm's "compat-transform").
- Guidance trigger? `present-supported` only, via a version-template compatibility table (not a boolean known-good).

### Deferred to Implementation

- Exact CLI surface: widen `setup --harness pi --with-subagents` vs a dedicated `pi export-agents` command — decide against `src/cli.ts` arg-parser shape during implementation.
- Exact curated persona list membership (which workflow/review/research agents) — finalize from `agents/` during implementation.
- Manifest file location + format (project vs global; JSON shape) — mirror the agent-browser/registry manifest shape.
- Exact pi-subagents frontmatter fields to emit beyond `description` (whether to set `tools`/`skills`) — determine from a concrete one-persona export validated against pi-subagents parsing.
- Known-good version predicate + tested version range — the compatibility table (tested pi-subagents version/protocol → guidance template) is populated and documented at implementation from the observed pi-subagents version; versions outside the range are unsupported-but-nonfatal.
- Exact `tools` frontmatter mapping for exported personas (pi-subagents supports a `tools` field; whether to emit it or omit) — decide from a concrete one-persona export validated against pi-subagents parsing.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Increment 1 (opt-in export) — build/CLI time, no runtime coupling:
  agents/<category>/<name>.md  (curated subset)
        │  parseFrontmatter + foldIdentity collision (reuse from CC build)
        ▼
  screen(persona): classify info/warning/critical; EXCLUDE critical
        │  light-adapt surface token refs only (never strip behavior)
        ▼
  emit: systematic-<sanitized-name>.md  (model-free frontmatter + body)
        │  sanitize filename (lowercase alnum+hyphen; reject sep/dot; verify under root)
        ▼
  user-chosen dir (.pi/agents/ | $PI_CODING_AGENT_DIR/agents/)  [preview → confirm → atomic write]
        + manifest (what we generated)   → cleanup / re-export / --check drift

  Triggered ONLY by explicit `setup --harness pi --with-subagents` or `pi export-agents`.

Increment 2 (runtime detection) — src/pi.ts, best-effort/non-fatal:
  pi.events.on("subagents:ready", → mark present)          [try/catch, observable]
  pi.events.emit("subagents:rpc:ping",{requestId})
  pi.events.on("subagents:rpc:ping:reply:<id>", → version) [timeout → absent]
        ▼
  if present AND version known-good AND personas exported:
      inject conditional Pi guidance: "you may drive Systematic personas via
      pi-subagents Agent tool for parallel/multi-model; systematic_delegate
      remains the bounded default"
  else: bounded-default guidance only (no error, no nudge beyond docs)
```

## Implementation Units

### Phase 1 — Opt-in export + setup + docs (shippable increment)

- [x] **Unit 1: Persona export generator (pure core)**

**Goal:** A pure generator that reads a curated persona subset from `agents/`, runs compatibility screening (info/warning/critical), excludes critical-coupled personas, lightly adapts only surface token references, and produces sanitized, namespaced, model-free `systematic-<name>.md` content + a manifest recording per-persona compatibility status — with a `--check` drift mode. No writes to user dirs yet (returns content/structures).

**Requirements:** R2, R3, R5, R6, R8, R14

**Dependencies:** None

**Files:**
- Create: `scripts/generate-pi-subagents-personas.ts`
- Test: `tests/unit/generate-pi-subagents-personas.test.ts`

**Approach:**
- Reuse `parseFrontmatter` + `foldIdentity` collision logic from `scripts/build-claude-code-plugin.ts` (extract-shared if clean, else import the helpers). Note: the CC build only does identifier translation + verbatim bodies (no semantic rewrite) — there is no precedent for a deep body transform, which reinforces exclusion-over-transform.
- Curated subset is an explicit source-of-truth include list with a compatibility rationale per persona. Recommended include (self-contained): `research/*` except `slack-researcher`; `review/*` except `agent-native-reviewer`, `project-standards-reviewer`, `kieran-typescript-reviewer`; all `document-review/*`; `workflow/spec-flow-analyzer`, `workflow/bug-reproduction-validator`, `workflow/pr-comment-resolver`. Recommended exclude (orchestration/skill/env-coupled): `workflow/systematic-implementer` (parent-orchestrator bound), `design/design-iterator` (skill+agent-browser coupled), `review/agent-native-reviewer` + `review/project-standards-reviewer` + `review/kieran-typescript-reviewer` (Systematic/repo-specific), `research/slack-researcher` (Slack MCP env). Final membership decided at implementation.
- Compatibility screening: classify each candidate info (harmless mention) / warning (behavior may differ, still operable) / critical (depends on unavailable orchestration/tooling — parent-dispatch assumptions, `load the skill`, task-tracking, bounded-execution). Export only if severity < critical; critical is excluded and recorded in the manifest.
- Light adaptation: adapt only surface token-level references (e.g. `ce:*` in policy prose); never strip behavioral instructions.
- Sanitizer: lowercase alphanumeric + hyphen; reject path separators and dot segments; emitted name is `systematic-<sanitized>`.
- Frontmatter mapping: `agents/*` files carry `name`, `description`, `mode: subagent`, `temperature`, sometimes `tools`/`color`, and NO `model`. Emit `name`/`description` + body; drop `mode`/`temperature`/`color` (no pi-subagents equivalent); decide `tools` mapping at implementation. Model-free is preserved.
- Manifest: generated relative filenames + content hash per file + per-persona compatibility status (exported/warning/excluded-critical) (mirror agent-browser/registry manifest shape).
- Entrypoint guarded with `if (import.meta.main)`; all helpers are pure exports. Screening lives as a pure function near the generator, not in `src/pi.ts`.

**Execution note:** Test-first — assert generator output (filenames, model-free frontmatter, manifest entries, sanitization, collision refusal, transform) before wiring writes.

**Patterns to follow:** `scripts/generate-agent-browser-skill.ts` (generate/check/guard), `scripts/build-claude-code-plugin.ts` (flatten/collision).

**Test scenarios:**
- Happy path (golden fixture): a representative self-contained persona → expected exported `systematic-<name>.md` (model-free frontmatter + adapted body); manifest lists it as exported.
- Edge case (no-op fixture): a persona with no incompatible constructs is byte-stable except generated frontmatter/header.
- Edge case (false-positive): a harmless mention of "task" or "delegate" in prose is NOT stripped.
- Edge case (false-negative / critical): a persona with orchestration assumptions (`dispatched by a parent`, `load the skill`) is classified critical and EXCLUDED, not exported; recorded in manifest.
- Edge case: persona name with unsafe chars → sanitized; a name that collides after fold → refused with a clear error.
- Error path: missing/empty frontmatter `name` → throws.
- Manifest assertion: exported files record compatibility status; excluded criticals are listed with reason.
- Drift: `--check` against matching committed fixture → exit 0; perturbed → exit 1 naming the stale file; a curated persona gaining a NEW critical incompatibility → check-red.
- Integration: importing the module runs no write side effects (entrypoint guard).

**Verification:** Unit tests green including golden + false-positive/negative + critical-exclusion fixtures; `--check` correctly passes/fails and flags new critical coupling; importing the module writes nothing.

- [ ] **Unit 2: Export command + safe user-dir writes**

**Goal:** Wire the generator into an explicit opt-in CLI surface that previews target dir + files, refuses to overwrite user files by default, writes atomically under the user-chosen root, and supports cleanup + re-export/refresh.

**Requirements:** R4, R5, R6, R7, R11

**Dependencies:** Unit 1

**Files:**
- Modify: `src/cli.ts` (opt-in surface), `src/lib/setup.ts` (write/cleanup helpers)
- Create: `tests/unit/pi-subagents-export.test.ts` (or extend `tests/unit/setup.test.ts`)

**Approach:**
- Reuse `atomicWrite()`/`writeTempAndRename()` from `src/lib/setup.ts`.
- Resolve + validate the write target stays under the selected root (project `.pi/agents/` or global `$PI_CODING_AGENT_DIR/agents/`); reject traversal/symlink escape before writing.
- Preview: list files to be created/overwritten; default refuse-overwrite of existing files (esp. non-Systematic ones).
- Cleanup uses the manifest to remove only Systematic-generated files; re-export/refresh regenerates and reports drift vs the user's copies.
- Opt-in only: nothing here runs at extension load or on detection.

**Execution note:** Test-first on the path-safety + refuse-overwrite + idempotency behaviors.

**Patterns to follow:** `src/lib/setup.ts` `setupPi()` idempotent update; `local-systematic-overrides-global` (generated-vs-user-owned distinction).

**Test scenarios:**
- Happy path: export to a temp project `.pi/agents/` → namespaced files written; manifest recorded; re-run is idempotent (no changes).
- Edge case: pre-existing user file `reviewer.md` → not overwritten; a stale `systematic-*.md` from a removed persona → cleanup removes it, user files untouched.
- Error path: computed target escapes the selected root (traversal/symlink) → refused, nothing written.
- Error path: unwritable dir → fails cleanly, no partial state (atomic).
- Integration: export → edit a generated file → refresh detects drift and reports it.

**Verification:** Files land only under the chosen root; user files never clobbered; cleanup/refresh behave per manifest; no writes without the explicit command.

- [ ] **Unit 3: Docs + capability profile + delegation-boundary test**

**Goal:** Document the recommended pairing and update capability surfaces; add the explicit `noExtensions` boundary test and the combined-path characterization.

**Requirements:** R12, R13

**Dependencies:** Unit 2

**Files:**
- Modify: `skills/using-systematic/references/pi-profile.md`, `HARNESSES.md`, `docs/src/content/docs/getting-started/installation.mdx`, `docs/src/content/docs/index.mdx`
- Create: docs page/section for the pi-subagents pairing (under `docs/src/content/docs/`)
- Modify/Create test: extend `tests/unit/pi-delegate-session.test.ts` (boundary) and `tests/integration/pi.test.ts` (combined-path characterization)

**Approach:**
- Update delegation-capability wording to "bounded built-in delegate + optional mature delegation via pi-subagents"; document opt-in export, ownership/drift of exported files, and the safe-provisioning model.
- Boundary test: assert a `systematic_delegate` child (built `noExtensions: true`) cannot resolve extensions or re-enter `systematic_delegate` (strengthen existing coverage; state the guarantee narrowly).
- Combined-path characterization: extend the parent→child integration pattern to characterize top-level pi-subagents + a nested Systematic persona (document that end-to-end depth is not globally bounded by this boundary).

**Execution note:** Characterization-first for the combined-path test (capture observed behavior; do not assert a global bound the code doesn't enforce).

**Patterns to follow:** `tests/unit/pi-delegate-session.test.ts:14-34` (boundary), `tests/integration/pi.test.ts:943-995` (parent→child).

**Test scenarios:**
- Happy path (docs): profile/HARNESSES/install/index render the new wording; content-integrity clean.
- Integration: `systematic_delegate` child cannot load an extension or re-enter the delegate tool (boundary holds).
- Integration (characterization): top-level pi-subagents with a nested Systematic persona — record depth behavior; no false global-bound assertion.

**Verification:** Docs build + content-integrity green; boundary test passes; combined-path test documents actual behavior.

### Phase 2 — Runtime detection + conditional guidance

- [ ] **Unit 4: pi-subagents presence detection (best-effort, non-fatal)**

**Goal:** Detect `pi-subagents` at runtime via `pi.events` (`subagents:ready` + `subagents:rpc:ping`), capturing a version, wrapped so any failure/absence is silent-degraded and observable — never blocking.

**Requirements:** R9, R10, R11

**Dependencies:** Unit 1-3 (guidance consumes exported-personas awareness); technically independent of Unit 2's writes.

**Files:**
- Create: `src/lib/pi-subagents-detect.ts`
- Modify: `src/pi.ts` (subscribe on registration)
- Create: `tests/unit/pi-subagents-detect.test.ts`

**Approach:**
- On extension registration, `pi.events.on("subagents:ready", …)` sets a present flag; emit `subagents:rpc:ping` with a `requestId` and listen on `subagents:rpc:ping:reply:<requestId>` for `{data:{version}}`, with a bounded timeout → treat as absent/unknown.
- Detection ladder (5 states): `present-supported` (ready + ping reply + version maps to a tested guidance template) | `present-unknown` / `ready-unverified` (ready seen but ping timeout/bad shape) | `present-unsupported` (version received but outside tested range) | `absent` (no ready event) | `bus-error` (detection machinery threw). Only `present-supported` enables operational interop guidance; `present-unsupported`/`present-unknown` get at most a non-mutating docs nudge; `absent` is byte-identical baseline; `bus-error` is non-fatal bounded default.
- Request/reply hygiene (per best-practices research): correlation-id-bound ping, bounded timeout, defensive/shape-tolerant reply parse (unknown ≠ broken), first valid reply wins (dedupe late/duplicate), and listener/correlation-entry cleanup on settle (no leak).
- All `pi.events` interaction wrapped in try/catch with observable logging; channel-name/contract mismatch degrades to `present-unsupported`/`bus-error`, never throws.

**Execution note:** Test-first with a fake `pi.events` bus (mirror `tests/unit/pi.test.ts` fake ExtensionAPI); real-runtime coverage in Unit 5.

**Patterns to follow:** `tests/unit/pi.test.ts:33-48` fake ExtensionAPI; `opencode-plugin-hook-silent-defect-swallow` (observable non-fatal).

**Test scenarios:**
- Happy path: `subagents:ready` + ping reply with a tested version → `present-supported`.
- Edge case: `ready` fires but ping times out or reply shape is unrecognized → `present-unknown` (no operational guidance).
- Edge case: ping reply with a version outside the tested range → `present-unsupported` (no operational guidance; observable note).
- Edge case: duplicate/late reply after timeout → ignored (first valid wins); no listener leak after settle.
- Error path: `pi.events.on`/`emit` throws or bus absent → `bus-error`, no throw escapes, logged.
- Integration: no `subagents:ready` at all → `absent`; default behavior unchanged.

**Verification:** State machine correct across all cases; no unhandled throw; default path untouched when absent.

- [ ] **Unit 5: Conditional Pi guidance + real-runtime verification**

**Goal:** Inject version-templated conditional guidance into the Pi bootstrap only in the `present-supported` state; verify the end-to-end behavior against the real Pi runtime.

**Requirements:** R10, R11, R13

**Dependencies:** Unit 4

**Files:**
- Modify: `src/pi.ts` (compose conditional guidance into the bootstrap/before_agent_start injection)
- Modify: `src/lib/bootstrap.ts` if a composition seam is needed
- Modify: `tests/integration/pi.test.ts` (real-runtime detection + guidance)

**Approach:**
- Only in `present-supported`, select a guidance template from a source-controlled compatibility table (tested version/protocol → template id → supported `Agent`-tool wording). The guidance is capability-scoped and conservative: it must not hardcode `Agent`-tool params, must say the pi-subagents path is outside Systematic's bounded-delegate guarantees and subject to pi-subagents' own limits/config, and must still name `systematic_delegate` as the bounded default. All other states get no operational Agent-tool instructions.
- Compose into the existing `composeSystemPromptWithBootstrap` / `before_agent_start` path; do not disturb the base profile block in any non-supported state.
- Real-runtime test: boot the packaged Systematic Pi extension alongside a stub emitting `subagents:ready` + ping reply; assert the model-facing system prompt gains the interop guidance only in the known-good case, and is unchanged when absent.

**Execution note:** Real-runtime verification (per `pi-real-runtime-integration-harness`), not fake-SDK only.

**Patterns to follow:** `tests/integration/pi.test.ts:103-147, 234-298, 512-657`; `src/pi.ts:62-83` bootstrap injection.

**Test scenarios:**
- Happy path: `present-supported` → system prompt contains the version-matched interop guidance, names `systematic_delegate` as default, and states the pi-subagents path is outside bounded guarantees.
- Edge case: `present-unsupported` and `present-unknown` → no operational interop guidance (at most a docs nudge).
- Edge case: `absent` → system prompt byte-identical to today's baseline.
- Integration (real runtime): packaged extension + stub emitting ready/ping → operational guidance appears only in `present-supported`; version outside range → no operational guidance.

**Verification:** Guidance is version-gated and additive; absent case is a no-op vs baseline; real-runtime test passes.

## System-Wide Impact

- **Interaction graph:** Increment 2 adds `pi.events` subscriptions in `src/pi.ts` at registration; Increment 1 adds a CLI/setup path. Neither touches `systematic_delegate` execution.
- **Error propagation:** All `pi.events` coupling is try/catch + observable; failures degrade to bounded default, never propagate to the host agent loop.
- **State lifecycle risks:** Export writes are atomic (temp-then-swap) with manifest-driven cleanup; partial writes cannot leave mixed state; user files are never touched.
- **API surface parity:** OpenCode delegation (`task()`) is unaffected; this is Pi-only interop. The Pi capability profile + HARNESSES.md are updated for parity of documentation.
- **Integration coverage:** Real-runtime Pi test for detection+guidance; combined-path characterization for delegation depth.
- **Unchanged invariants:** `systematic_delegate` bounds (sequential, 20-turn, same-model, depth-1, re-entry guard) and all its tests are untouched; bundled-agent model-free frontmatter invariant preserved in exports.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| pi-subagents channel names / reply shape are ecosystem conventions, not SDK-guaranteed | Version-gate guidance; treat any mismatch as absent; non-fatal try/catch; document the convention dependency |
| Exported personas drift on user machines after source changes | Manifest + re-export/refresh command surfaces drift; docs state files are user-owned and may drift until re-exported |
| Exported persona body references a tool/orchestration absent under pi-subagents | Compatibility screening classifies info/warning/critical; critical personas excluded (not rewritten); warnings annotated and reported in the manifest |
| Filename from persona name causes traversal/clobber | Strict sanitizer + resolved-target-under-root check + refuse-overwrite by default |
| Users attribute pi-subagents misbehavior to Systematic | Docs clearly scope the pairing and mark exported files as generated/user-owned |
| pi-subagents 0.x contract changes across versions | Version-template guidance keyed to a documented tested version range; `present-unsupported` state gives no operational guidance; defensive shape-tolerant reply parse; never a hard/peer dependency |
| Combined delegation path (top-level pi-subagents → nested Systematic persona) is not Systematic-bounded | Guidance explicitly states the pi-subagents path is outside Systematic's bounded-delegate guarantees and governed by pi-subagents' own limits/config; combined depth is characterized (test), not enforced; docs frame it as a power-user path with different blast radius |
| Compat screening over-strips (corrupts prose) or under-detects (exports orchestration-coupled persona) | Screening classifies info/warning/critical and excludes critical rather than rewriting; golden + false-positive + false-negative + critical-exclusion fixtures pin both behavior and non-behavior; `--check` fails on new critical coupling |
| `pi.events` request/reply leaks listeners or accepts stale replies | Correlation-id-bound ping, bounded timeout, first-valid-wins dedupe, listener cleanup on settle |

## Documentation / Operational Notes

- New docs page for the pi-subagents pairing (install, export command, ownership/drift model, safety) + updates to `pi-profile.md`, `HARNESSES.md`, `installation.mdx`, `index.mdx`.
- Consider a `--check` drift gate for the export generator in CI (source-side only), mirroring registry/agent-browser drift — decide during implementation.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-28-pi-subagents-interop-requirements.md](../brainstorms/2026-07-28-pi-subagents-interop-requirements.md)
- Related code: `scripts/build-claude-code-plugin.ts`, `scripts/generate-agent-browser-skill.ts`, `src/lib/setup.ts`, `src/cli.ts`, `src/pi.ts`, `src/lib/bootstrap.ts`, `src/lib/pi-delegate-session.ts`
- Related PRs: #629 (bounded Pi delegation), #637 (Pi real-runtime harness), #660 (Claude Code flatten/collision precedent), #700 (agent-browser generator/drift precedent)
- External: `earendil-works/pi` `packages/coding-agent/docs/extensions.md` (`pi.events` EventBus); `tintinweb/pi-subagents`, `tintinweb/pi-tasks`, `luongnv89/pi-extensions` (channel conventions)
