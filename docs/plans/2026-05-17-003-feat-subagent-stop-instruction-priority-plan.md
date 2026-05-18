---
title: 'feat(skills): add SUBAGENT-STOP block and Instruction Priority section to using-systematic'
type: feat
status: active
date: 2026-05-17
deepened: 2026-05-17
origin: docs/brainstorms/2026-05-17-subagent-stop-instruction-priority-requirements.md
---

# Add SUBAGENT-STOP block and Instruction Priority section to `using-systematic`

## Overview

Mirror upstream `obra/superpowers@v5.1.0`'s `<SUBAGENT-STOP>` block and `## Instruction Priority` section into `skills/using-systematic/SKILL.md`. Land mechanical bootstrap test assertions covering presence, ordering, and `INTERNAL_AGENT_SIGNATURES` non-regression. Build a two-condition behavioral probe in `tests/manual/` that measures whether the prose change reduces `systematic_skill` invocations inside `task()`-dispatched Systematic subagents.

Target release: v2.20.0 minor (`feat(skills):`).

## Problem Frame

Systematic's bootstrap injection wraps `skills/using-systematic/SKILL.md` body in a `<SYSTEMATIC_WORKFLOWS>` block and prepends it to `output.system[0]` for every session (`src/lib/bootstrap.ts:75-106`). OpenCode dispatches `task()`-spawned subagents through the same `experimental.chat.system.transform` pipeline, so Systematic-bundled subagents receive the full skill-awareness bootstrap including the `<EXTREMELY-IMPORTANT>` "1% rule" that mandates skill invocation before any action. A subagent dispatched for a focused implementation task does not benefit from being nudged toward defensive `systematic_skill` invocation; it benefits from completing the work it was given. Three reviewers in PR #394 flagged this when the foundation skills landed but the SUBAGENT-STOP pattern was deliberately left out of scope.

See origin: `docs/brainstorms/2026-05-17-subagent-stop-instruction-priority-requirements.md`.

## Requirements Trace

- R1. SUBAGENT-STOP block at top of `skills/using-systematic/SKILL.md` body, after frontmatter, immediately before `<EXTREMELY-IMPORTANT>` (origin R1).
- R2. `## Instruction Priority` section enumerating 3-tier precedence: user instructions (CLAUDE.md / GEMINI.md / AGENTS.md / direct requests) > Systematic skills > default system prompt (origin R2).
- R3. `INTERNAL_AGENT_SIGNATURES` skip mechanism continues to function unchanged after prose addition (origin R3).
- R4. Mechanical tests in `tests/unit/bootstrap.test.ts` assert presence, section presence, ordering, and `INTERNAL_AGENT_SIGNATURES` non-regression, all against the rendered `getBootstrapContent()` output AND against `shouldSkipBootstrap()` behavior with representative internal-agent prompts (origin R4).
- R5. Behavioral probe in `tests/manual/` using a two-condition design (Control vs Treatment on the same branch) measures whether SUBAGENT-STOP reduces `systematic_skill` invocations made inside `task()`-dispatched `systematic-implementer` subagent sessions (origin R5).

## Scope Boundaries

- Only `skills/using-systematic/SKILL.md` is touched for prose. Other Rigid-tier bundled skills (`test-driven-development`, `writing-skills`) and workflow skills (`ce:*`) do NOT get SUBAGENT-STOP blocks.
- No structural change to `src/lib/bootstrap.ts`. The design axis is prose-level mirror; structural detection remains the documented fallback if the probe shows the prose mechanism is ineffective.
- Multi-harness behavioral validation is not in scope. The probe runs only against OpenCode. Cross-harness portability is tracked separately.
- No new bundled skill, no new content-integrity gate rule, no new frontmatter field, no new runtime contract surface.
- Identity-provenance for the bundled `systematic-implementer` is bounded by fixture isolation, not runtime queries. The probe controls the temp project dir; no `.opencode/agents/` overrides exist in the fixture. Runtime cannot expose resolved agent source paths today.

## Context & Research

### Relevant Code and Patterns

- `src/lib/bootstrap.ts:8-17` — `INTERNAL_AGENT_SIGNATURES` array (3 strings: title-generator, summarizer, summarize-conversation).
- `src/lib/bootstrap.ts:75-106` — `applyBootstrapContent()`. Strips all complete `<SYSTEMATIC_WORKFLOWS>` blocks from every `output.system[i]`, then appends the canonical block to `output.system[0]`.
- `src/lib/bootstrap.ts:126-168` — `getBootstrapContent()`. Returns `string | null`. Reads bundled `using-systematic/SKILL.md`, strips frontmatter, wraps body in `<SYSTEMATIC_WORKFLOWS>...</SYSTEMATIC_WORKFLOWS>`.
- `src/index.ts:85-109` — skip-check logic. Uses `output.system.join('\n').toLowerCase()` and substring match against `INTERNAL_AGENT_SIGNATURES`.
- `skills/using-systematic/SKILL.md` — current top-of-body is `<EXTREMELY-IMPORTANT>` at lines 6-12. SUBAGENT-STOP must land BEFORE that block.
- `tests/unit/bootstrap.test.ts:361-420` — existing `INTERNAL_AGENT_SIGNATURES` regression tests including the `shouldSkipBootstrap()` helper that mirrors `src/index.ts` logic.
- `tests/manual/companion-aware-probe.ts` — two-arm probe pattern with `opencode serve --port 0 --print-logs`, isolated temp project dirs, model `opencode/big-pickle`, JSONL-logfile-based invocation counting via probe-side stub plugin's tool registrations.

### Institutional Learnings

- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md` — bootstrap idempotency, LLM-visible-contract emphasis. Direct precedent for asserting exactly one bootstrap block in the system prompt.
- `docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md` — manual probes as sandboxed subprocess tests with explicit fixture scoping.
- `docs/solutions/integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md` — prose alone isn't enough when runtime contract is brittle; executable checks needed alongside prose.

### Upstream Reference

- `obra/superpowers@v5.1.0` at `.slim/clonedeps/repos/obra__superpowers/skills/using-superpowers/SKILL.md` — source pattern. Upstream places `## Instruction Priority` BEFORE `## How to Access Skills`.

## Key Technical Decisions

- **Probe dispatch via `task()` tool invocation, not `--agent` flag.** `systematic-implementer` has `mode: subagent`. `opencode run --agent systematic-implementer` silently falls back to the default primary agent (`localAgent()` in `packages/opencode/src/cli/cmd/run.ts:507-527` returns undefined for subagent-mode entries). The probe spawns a primary agent that uses the `task` tool with `subagent_type: systematic-implementer` and counts `systematic_skill` invocations that occur inside the resulting subagent session.
- **Probe instrumentation via `tool.execute.before` global hook, filtered by child session ID.** OpenCode's plugin system fires `tool.execute.before` for every tool invocation across the session graph (`packages/plugin/src/index.ts:222-280`; `packages/opencode/src/session/prompt.ts:569-588`). The hook payload includes `sessionID`. A probe-local plugin records `{tool, sessionID, callID}` for every `input.tool === 'systematic_skill'`. The probe captures the child session ID returned in the parent `task` tool result and filters counts to only rows where `sessionID === childSessionID`. This excludes any `systematic_skill` invocations the primary agent itself might make (e.g., the primary agent's bootstrap could also nudge it to invoke skills before calling `task`). Single counter file inline in the probe; no separate `probe-systematic-skill-counter.ts` file.
- **Identity-provenance via fixture isolation, not runtime queries.** OpenCode's agent `Info` schema (`packages/opencode/src/agent/agent.ts:28-48`) does NOT expose resolved source file paths. The probe controls the temp project dir per the existing companion-aware-probe pattern; no user-level or project-level agent overrides can leak into the fixture. The claim is "isolated fixture avoids known overrides," not "resolved path verified."
- **Probe asserts subagent's actual system prompt contains SUBAGENT-STOP before counting.** If a concurrent refactor changes which agents receive bootstrap (e.g., subagents skip entirely), the probe would see 0 invocations and report success while the prose change had zero effect. The probe captures the subagent session's system prompt (via a sentinel injected by the counter plugin's `tool.execute.before` hook on the first event in the child session, or via the SDK event stream) and asserts it literally contains the SUBAGENT-STOP marker. If the assertion fails, the run is excluded and a warning is logged.
- **Pass criterion: both absolute AND relative bounds, with explicit INCONCLUSIVE band.** Absolute "Treatment ≤ Control + 1" alone allows 2x regressions to pass (Control=0.8, Treatment=1.6). Combine: pass requires `(Treatment - Control) ≤ 1` AND `Treatment ≤ 1.25 × max(Control, 1)`. Fail: `(Treatment - Control) ≥ 2` OR `Treatment > 1.5 × max(Control, 1)`. Anything in between is INCONCLUSIVE — block merge of the probe artifact until conditions are tightened or design redone.
- **Variance check on BOTH conditions via run-level standard deviation.** Compute `stddev` across the 5 runs of each condition. If either condition's stddev > 1.0, the result is INCONCLUSIVE regardless of means. Range-based variance (|max - min|) is too permissive — [0,0,0,1,0] and [0,1,0,1,0] both have range 1 but the latter is materially noisier on a binary signal.
- **N=5 is a smoke probe, not statistical confidence.** Five runs cannot reliably distinguish small behavioral shifts. The probe is FALSIFIABLE for large effects (clearly above/below thresholds) but explicitly NOT a statistical-confidence claim. Probe documentation states this directly. If results are repeatedly INCONCLUSIVE at N=5, the follow-up is either bumping N (committing more runtime + cost) or redesigning the experiment, not interpreting N=5 noise as signal.
- **Upstream structural order: `## Instruction Priority` BEFORE `## How to Access Skills`.** Matches upstream `obra/superpowers` SKILL.md placement at lines 18-28 of the clonedep.
- **Harness-wording adaptation rule, constrained.** Replace "Superpowers" with "Systematic" mechanically. For harness-specific references (e.g., upstream's "Claude Code prefers..."): rewrite to match Systematic's OpenCode runtime context if Systematic provides the same guarantee ("the systematic_skill tool prefers..."); generalize to "your harness" ONLY if the upstream sentence is genuinely about the consuming harness AND every consumer harness can provide the same guarantee. If neither condition holds (e.g., upstream describes a permission-halt behavior that only Claude Code enforces), DELETE the sentence rather than generalize it falsely. Do NOT add rewrite-intent comments to the SKILL.md body — body comments survive frontmatter stripping and end up in every agent's injected bootstrap. Document the adaptation choices in this plan doc or in a `docs/solutions/` learning after merge.
- **Mechanical tests run against `getBootstrapContent()` output (pre-injection) AND `applyBootstrapContent` output (post-injection) AND `shouldSkipBootstrap()` behavior.** Pre-injection covers presence + section-ordering invariants. Post-injection (via `applyBootstrapContent` against a representative `output.system` array) catches injection-assembly bugs. `shouldSkipBootstrap()` behavioral check exercises the actual `src/index.ts:85-109` skip path with each of the 3 known internal-agent system prompts plus a SUBAGENT-STOP-bearing primary-agent prompt.

## Open Questions

### Resolved During Planning

- **Q1: Instrumentation surface** → `tool.execute.before` global hook in a probe-local plugin, observing `input.tool === 'systematic_skill'`.
- **Q3: Identity-provenance check** → fixture isolation (temp project dir with no agent overrides), not runtime path queries.

### Deferred to Implementation

- **Q2: Exact prompts for Control and Treatment.** Constraint: Control is a focused implementation task with no skill-aware framing (e.g., "Add a single TODO comment to the file path I specify"). Treatment uses skill-triggering language (e.g., "Implement this feature following all best practices and our project conventions"). Implementer iterates the Control prompt until it reliably shows ≤1/5 invocations as a sanity check. Both prompts dispatch via the primary agent calling `task({ subagent_type: 'systematic-implementer', prompt: <prompt>, ... })`.
- **Q4: Exact wording of SUBAGENT-STOP body and Instruction Priority section.** Constraint: mirror upstream meaning. Apply the harness-wording adaptation rule above. SUBAGENT-STOP body: one line matching upstream intent ("If you were dispatched as a subagent to execute a specific task, skip this skill."). Instruction Priority section: 3-tier list, "Systematic skills" replaces "Superpowers skills", harness-specific sentences adapted per the rule. Final wording lives in the SKILL.md edit, not the plan.

## Implementation Units

- [ ] **Unit 1: Add SUBAGENT-STOP block + Instruction Priority section + mechanical bootstrap assertions**

**Goal:** Prose change in `skills/using-systematic/SKILL.md` plus matching mechanical tests in `tests/unit/bootstrap.test.ts` covering R1, R2, R3, R4.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `skills/using-systematic/SKILL.md`
- Modify: `tests/unit/bootstrap.test.ts`
- Test: `tests/unit/bootstrap.test.ts`

**Approach:**
- Add `<SUBAGENT-STOP>...</SUBAGENT-STOP>` block immediately after frontmatter close and immediately before the existing `<EXTREMELY-IMPORTANT>` block at line 6.
- Add `## Instruction Priority` section BEFORE the existing `## How to Access Skills` section (matches upstream placement at `obra/superpowers@v5.1.0` SKILL.md lines 18-28).
- Body of SUBAGENT-STOP: mirror upstream meaning.
- Body of Instruction Priority: 3-tier precedence list adapting upstream's structure with "Systematic skills" naming and the harness-wording adaptation rule.
- Mechanical tests:
  - Load `getBootstrapContent()`. Assert returned string contains `<SUBAGENT-STOP>` (presence).
  - Assert returned string contains `## Instruction Priority` (section presence).
  - Assert `indexOf('<SUBAGENT-STOP>')` < `indexOf('<EXTREMELY-IMPORTANT>')` (top-level ordering).
  - Assert `indexOf('## Instruction Priority')` < `indexOf('## How to Access Skills')` (section-level ordering matching upstream).
  - Exercise `shouldSkipBootstrap()` with each of the 3 known internal-agent prompts ("You are a title generator", "You are a helpful AI assistant tasked with summarizing conversations", "Summarize what was done in this conversation"). Assert all 3 return `true` (skip path still works).
  - Exercise `shouldSkipBootstrap()` with a primary-agent-shape prompt that does NOT contain any of the 3 signatures. Assert it returns `false`.

**Execution note:** Test-first. Write RED tests for all assertions BEFORE editing the SKILL.md. Run the unit suite to confirm tests fail with clear messages, then add prose to drive them green.

**Patterns to follow:**
- Existing `INTERNAL_AGENT_SIGNATURES` test pattern at `tests/unit/bootstrap.test.ts:361-420`. The `shouldSkipBootstrap()` helper is reusable for the behavioral assertions.
- Existing wrapper-presence and frontmatter-stripping assertions at `tests/unit/bootstrap.test.ts:30-355` for style consistency.

**Test scenarios:**
- Happy path: `getBootstrapContent()` returns a non-null string containing both `<SUBAGENT-STOP>` and `## Instruction Priority`.
- Happy path: both ordering invariants hold (`<SUBAGENT-STOP>` before `<EXTREMELY-IMPORTANT>`; `## Instruction Priority` before `## How to Access Skills`).
- Happy path: `shouldSkipBootstrap()` returns `true` for each of the 3 internal-agent prompts.
- Happy path: `shouldSkipBootstrap()` returns `false` for a primary-agent prompt that doesn't contain the signatures.
- Edge case: `bootstrap.enabled: false` → `getBootstrapContent()` returns null (unchanged regression check).
- Edge case: custom `bootstrap.file` path → the SUBAGENT-STOP assertions scope only to the bundled `using-systematic/SKILL.md` path; custom-file paths are explicitly out of scope.

**Verification:**
- `bun test tests/unit/bootstrap.test.ts` passes including the new assertions.
- `bun test` full suite passes with no regressions.
- `bun run typecheck` clean.
- `bun src/cli.ts list skills` still lists `using-systematic` with no errors.

- [ ] **Unit 2: Two-condition behavioral probe in `tests/manual/`**

**Goal:** Probe artifact that measures whether SUBAGENT-STOP reduces `systematic_skill` invocations inside `task()`-dispatched `systematic-implementer` subagent sessions. Two conditions (Control vs Treatment) on the same branch, 5 runs each, with both absolute+relative thresholds and variance checks.

**Requirements:** R5

**Dependencies:** Unit 1 (probe runs against the feature branch with SUBAGENT-STOP already added)

**Files:**
- Create: `tests/manual/subagent-stop-probe.ts` (single file: probe runner + inline counter plugin definition)

**Approach:**
- Mirror the structure of `tests/manual/companion-aware-probe.ts` for isolation, subprocess spawning, per-run fixture setup, and JSONL parsing.
- Counter plugin defined inline (not a separate file). The plugin exposes a `tool.execute.before` hook that, on every invocation where `input.tool === 'systematic_skill'`, appends `{tool, sessionID, callID, timestamp}` to a JSONL logfile (path passed via env var, matching `probe-companion-tools.ts` pattern).
- Each probe run:
  1. Set up isolated temp project dir with `OPENCODE_CONFIG_CONTENT` enabling the local Systematic build AND loading the inline counter plugin.
  2. Dispatch via the SDK to a primary agent (e.g., the default agent in the fixture).
  3. The primary agent is instructed to invoke `task({ subagent_type: 'systematic-implementer', prompt: <Control or Treatment prompt> })` once.
  4. Capture the child session ID from the `task` tool's result metadata.
  5. The subagent session runs to completion. The counter plugin records every `systematic_skill` invocation across the session graph.
  6. The probe reads the JSONL logfile and FILTERS rows to only those where `sessionID === childSessionID` from step 4. This excludes any `systematic_skill` invocations the primary agent may have made.
  7. The probe captures the subagent's system prompt (via SDK event stream or by injecting a sentinel marker through the counter plugin on the first event in the child session) and asserts it contains the literal SUBAGENT-STOP marker. If the assertion fails, the run is excluded with a warning logged.
- Run Control 5 times with a neutral prompt; run Treatment 5 times with a skill-triggering prompt.
- Compute Control mean, Control stddev, Treatment mean, Treatment stddev (standard deviation, not range).
- Apply pass/fail/INCONCLUSIVE rules from Key Decisions.
- Report per-run counts, means, stddevs, and verdict to stdout. Probe header comment includes: "N=5 is a smoke probe, not statistical confidence. Probe falsifies large effects; small effects require N≥20 or experiment redesign."

**Execution note:** Run probe locally after Unit 1 lands on the feature branch. Iterate the Control prompt during a quick pre-run sanity check until Control reliably shows ≤1/5 invocations with stddev ≤1.

**Patterns to follow:**
- `tests/manual/companion-aware-probe.ts` for isolation, temp dir handling, `OPENCODE_CONFIG_CONTENT` injection, two-arm reporting shape.
- `tests/manual/probe-companion-tools.ts` for the plugin-side JSONL writer pattern (env-var-driven logfile path).

**Test scenarios:**
- Test expectation: none — this IS the test artifact. The probe's runtime output is the verification.

**Verification:**
- Probe runs end-to-end without errors against the feature branch.
- Per-run JSONL parse succeeds for every spawned subagent session.
- Each counted run includes a verified child session ID match AND a verified SUBAGENT-STOP-present-in-subagent-system-prompt assertion.
- Verdict reported per pass/fail/INCONCLUSIVE rules.
- Final stdout reports per-run counts, means, stddevs, exclusions (failed identity checks or failed prompt assertions), and verdict.
- If verdict is PASS or FAIL (stable), the result is summarized in the PR body and compounded as a `docs/solutions/` learning after merge. If verdict is INCONCLUSIVE on first run, a second run is attempted; two consecutive INCONCLUSIVE results trigger a follow-up smart note for probe redesign — no compound doc is written for unstable inconclusive results.

- [ ] **Unit 3: PR-checklist for routine verification**

**Goal:** Capture small documentation-touching checks as a PR-checklist.

**Requirements:** Implicit follow-up from R1+R2

**Dependencies:** Unit 1, Unit 2

**Files:**
- (None — PR-checklist only.)

**Approach:**
- PR description includes:
  - `bun run docs:build` succeeds (full docs pipeline including the rendered SKILL.md change).
  - `bun run registry:drift` clean (registry should still reflect unchanged component count).

**Test scenarios:**
- Test expectation: none — checklist items, not behavioral changes.

**Verification:**
- Both checklist items checked in PR body before merge.

## System-Wide Impact

- **Interaction graph:** The new SUBAGENT-STOP block is read by every agent receiving the bootstrap. `INTERNAL_AGENT_SIGNATURES` skip path for OpenCode-internal agents (title-generator, summarizer) is verified by Unit 1's behavioral assertions exercising `shouldSkipBootstrap()` directly.
- **Error propagation:** None. Prose change has no error-propagation surface; the probe runs out-of-band.
- **State lifecycle risks:** None.
- **API surface parity:** None. No exported API changes.
- **Integration coverage:** The probe is the integration coverage for the prose change's behavioral effect.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Probe shows Treatment ≈ Control (null result). Prose may not move behavior at all. | Frame probe as falsifying, not validating. Null result is itself a publishable learning — document in PR body and capture as a `docs/solutions/` compound after merge. The prose change still ships because parity with upstream + multi-harness instruction-precedence value is independent of behavioral effect. |
| Probe variance too noisy for a verdict (INCONCLUSIVE). | Iterate Control prompt until variance ≤1. If Treatment variance also exceeds 1 after Control stabilizes, file a smart note for probe redesign and ship the prose change without behavioral validation, documenting the gap. |
| Adding `<SUBAGENT-STOP>` substring to using-systematic body accidentally collides with `INTERNAL_AGENT_SIGNATURES` strings. | Unit 1's behavioral assertions exercise `shouldSkipBootstrap()` with each of the 3 signature prompts plus a primary-agent prompt. The proposed SUBAGENT-STOP wording does not contain "title generator", "summarizing conversations", or "Summarize what was done" (verified at edit time + by the assertion at test time). |
| Concurrent in-flight refactor to `applyBootstrapContent` changes how the bootstrap is assembled into `output.system[0]`, leaving Unit 1's pre-injection mechanical tests green while invalidating the actual subagent-visible invariant. | Add a behavioral assertion in Unit 1 that calls `applyBootstrapContent` against a representative `output.system` array and asserts the rendered post-injection string still has SUBAGENT-STOP before `<EXTREMELY-IMPORTANT>`. This catches injection-side reordering bugs that pre-injection tests would miss. |

## Documentation / Operational Notes

- `docs/solutions/`: capture a compound learning after merge regardless of probe result. Stable null result is a learning about limits of prose-only subagent control; stable positive result is a learning about effective patterns. Either way, document.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-05-17-subagent-stop-instruction-priority-requirements.md`
- Related code:
  - `src/lib/bootstrap.ts:8-17` (INTERNAL_AGENT_SIGNATURES)
  - `src/lib/bootstrap.ts:75-106` (applyBootstrapContent)
  - `src/lib/bootstrap.ts:126-168` (getBootstrapContent)
  - `src/index.ts:85-109` (skip-check logic)
  - `skills/using-systematic/SKILL.md` (target file)
  - `tests/unit/bootstrap.test.ts:361-420` (existing INTERNAL_AGENT_SIGNATURES tests)
  - `tests/manual/companion-aware-probe.ts` (probe isolation pattern)
  - `tests/manual/probe-companion-tools.ts` (plugin JSONL writer pattern)
- Related PRs:
  - PR #394 — foundation skills import, flagged SUBAGENT-STOP as deliberately out-of-scope
  - PR #321 — companion-aware-probe + manual-probe template, probe infrastructure precedent
- External docs:
  - `obra/superpowers@v5.1.0` upstream `using-superpowers/SKILL.md` at `.slim/clonedeps/repos/obra__superpowers/skills/using-superpowers/SKILL.md` — source pattern
  - `anomalyco/opencode@v1.15.1` clonedep at `.slim/clonedeps/repos/anomalyco__opencode/` — `run.ts`, `agent.ts`, `prompt.ts`, plugin hook surface
