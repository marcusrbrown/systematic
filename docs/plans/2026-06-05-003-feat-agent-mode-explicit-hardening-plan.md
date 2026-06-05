---
title: "feat: Agent mode explicit hardening"
type: feat
status: active
date: 2026-06-05
origin: docs/brainstorms/2026-06-05-agent-mode-explicit-hardening-requirements.md
---

# feat: Agent mode explicit hardening

## Overview

Add explicit `mode: subagent` frontmatter to the 36 bundled agents that currently rely on the converter's implicit default, and enforce the invariant in the content-integrity gate. This is a zero-runtime-behavior-change v2.x hardening patch that removes a hidden converter dependency and de-risks the eventual v3.0.0 converter removal. The plan also records a precise converter-injected-field audit as a v3.0.0 finding.

## Problem Frame

The runtime converter (`src/lib/converter.ts`) injects `mode: subagent` as a fill-if-absent default for every bundled agent at load time. 15 of 51 bundled agents declare `mode: subagent` explicitly; the other 36 resolve to `subagent` only because the converter fills it (`transformAgentFrontmatter`: `result.mode = isAgentMode(data.mode) ? data.mode : agentMode`, with `agentMode: 'subagent'` passed from `config-handler.ts`). The v3.0.0 initiative removes the converter; doing so without first making `mode` explicit would let those 36 agents fall back to OpenCode's native default (`all`), making internal review/research/design agents primary-visible — a regression. Making `mode` explicit is behavior-preserving today and severs the converter dependency for v3.0.0. (see origin: docs/brainstorms/2026-06-05-agent-mode-explicit-hardening-requirements.md)

## Requirements Trace

**Implementation hardening (ships now):**
- R1. Add explicit `mode: subagent` to the 36 bundled agents that lack it; all 51 declare an explicit `mode:`.
- R2. Enforce explicit agent `mode` in the content-integrity gate, with unit coverage.

**Deferred documentation (tracked finding, no behavior change):**
- R3. Record the converter-injected-field audit (especially the `temperature` heuristic) as a v3.0.0 finding, in a tracked artifact (this plan's audit table).

## Scope Boundaries

- Not touching `src/lib/converter.ts` — converter removal is v3.0.0 work.
- Not hardening `temperature`/`steps`/`tools`/`permission`/`hidden` values — verified and documented as a v3.0.0 finding (R3), no values added here.
- Not changing any agent's runtime behavior — the converter already resolves these 36 to `subagent`, so making it explicit is a no-op at runtime today.
- This patch does NOT make Systematic v3.0.0-ready; `temperature` (computed for every agent) remains an open converter dependency.

### Deferred to Separate Tasks

- Hardening `temperature` and the other converter-injected fields: v3.0.0 converter-removal work, tracked via R3 + the parent v3 brainstorm (`docs/brainstorms/2026-05-21-v3-converter-removal-and-excision-requirements.md`).

## Context & Research

### Relevant Code and Patterns

- `scripts/content-integrity.ts` — `checkAgentModel` (line ~952) is the exact pattern R2 mirrors: iterates `targets.markdown`, gates on `isAgentFile(relPath)`, checks a frontmatter field, returns violations. `checkAgentColors`/`checkAgentStemUniqueness` are sibling examples. Wired into `main()` alongside `agentModelViolations`/`agentColorViolations` (line ~1124).
- `src/lib/agents.ts` — `extractAgentFrontmatter` / `AgentFrontmatter` (the `mode` field already typed as `'subagent' | 'primary' | 'all'`).
- `tests/unit/content-integrity.test.ts` — existing `checkAgentModel`/`checkAgentColors` test blocks are the pattern for R2's coverage.

### Institutional Learnings

- Adding a runtime/gate invariant: mirror the rule in the content-integrity gate so an asset cannot pass CI while violating the contract (the gate is the durable enforcement surface, not the data alone).

## Key Technical Decisions

- **R1 is purely additive** — only the `mode: subagent` line is added to each of the 36 files; no other frontmatter touched. The 15 agents already declaring `mode` are untouched.
- **R2 mirrors `checkAgentModel`** — new `checkAgentMode` function using the same `isAgentFile` predicate and `main()` wiring, rather than overloading the existing model check. Keeps each invariant a discrete, clearly-messaged rule.
- **R2 requires `mode: subagent` specifically** for bundled agents (not just any `mode`), matching the converter's prior default and the actual bundle (all 51 are subagents). A future intentionally-primary bundled agent would be a deliberate gate change, not an accident.
- **R3 is documentation-only** — the field audit lands as a tracked finding for the v3.0.0 plan, not scope creep here.

## Open Questions

### Resolved During Planning

- Where does R2 plug in? — A new `checkAgentMode` mirroring `checkAgentModel`, wired into `main()` and the violation reporting, using `isAgentFile`.
- Which files need R1? — The 36 enumerated via the gate's agent-file predicate (all under `agents/<category>/`), verified against the 15/36/51 split.
- How is "zero behavior change" verified? — Resolved-value equivalence (parsed config identical), not byte-identical emitted strings, because the converter still runs and may reorder YAML keys.

### Deferred to Implementation

- Exact violation message wording for `checkAgentMode` — settle during implementation, matching the tone of the existing `checkAgentModel` message.

## Implementation Units

- [ ] **Unit 1: Add explicit `mode: subagent` to the 36 agents**

**Goal:** Every bundled agent declares an explicit `mode:` field; the 36 that relied on the converter default now state `mode: subagent`.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: the 36 agent markdown files under `agents/research/`, `agents/design/`, `agents/document-review/`, `agents/docs/`, `agents/review/`, `agents/workflow/` that lack `mode:` (enumerate via the gate's agent-file predicate; do not touch the 15 that already declare it).

**Approach:**
- Insert `mode: subagent` into each file's YAML frontmatter (consistent placement, e.g., after `description`). Additive only — no other field changes.

**Patterns to follow:**
- The 15 agents already declaring `mode: subagent` — match their frontmatter placement/style.

**Test scenarios:**
- Test expectation: none — pure frontmatter data addition, no behavioral change. The zero-behavior-change claim is mechanically enforced by Unit 2's equivalence test.

**Verification:**
- Every agent entry declares an explicit `mode:` field (checked by the gate's agent-file predicate, not a broad `grep` over `agents/`).

- [ ] **Unit 2: Enforce explicit agent mode in the content-integrity gate**

**Goal:** A bundled agent missing an explicit `mode:` field fails content-integrity, locking in the hardening so future agents cannot regress to the converter default.

**Requirements:** R2

**Dependencies:** Unit 1 (gate must pass on the hardened tree). Land both units in one PR so CI never sees the gate active against an un-hardened tree.

**Files:**
- Modify: `scripts/content-integrity.ts` (add `checkAgentMode`, wire into `main()` + violation reporting)
- Test: `tests/unit/content-integrity.test.ts`

**Approach:**
- Add `checkAgentMode(rootDir, targets.markdown)` mirroring `checkAgentModel`: iterate markdown targets, skip non-agent files via `isAgentFile`, parse frontmatter, flag any agent whose `mode` is absent or not `subagent`. Wire its violations into `main()` alongside the existing agent-check aggregation and the stderr reporting block.

**Execution note:** Implement test-first — add the failing fixture-agent test before the gate function.

**Patterns to follow:**
- `checkAgentModel` / `checkAgentColors` in `scripts/content-integrity.ts` and their test blocks in `tests/unit/content-integrity.test.ts`.

**Test scenarios:**
- Happy path: hardened tree (all agents declare `mode: subagent`) → zero mode violations.
- Error path: fixture agent with no `mode:` field → one violation with a clear message.
- Error path: fixture agent with `mode:` set to a non-`subagent` value (e.g., `all`) → one violation.
- Edge case: non-agent markdown under `agents/` (e.g., a template/README, if any) → not flagged (gated by `isAgentFile`).
- Integration (equivalence — enforces Unit 1's zero-behavior-change claim): convert a fixture agent with NO `mode` using `agentMode: 'subagent'`, then convert the same fixture with explicit `mode: subagent`; parse both emitted configs and assert resolved-value equality (the explicit form must produce the same resolved `mode` and every other field).

**Verification:**
- Content-integrity passes on the hardened tree and fails on a fixture agent missing/with-wrong `mode:`.
- The equivalence test proves explicit `mode: subagent` resolves identically to the converter-defaulted form.
- Full unit suite green.

- [ ] **Unit 3: Record the converter-injected-field audit as a v3.0.0 finding**

**Goal:** The converter-injected-field audit (especially the `temperature` heuristic) is documented precisely enough that the v3.0.0 plan can act on it without re-deriving it.

**Requirements:** R3

**Dependencies:** None (documentation)

**Files:**
- Modify: this plan (the audit table below travels with the PR) and/or `docs/solutions/` — a **tracked** artifact. Do NOT record the audit solely in `docs/brainstorms/` (gitignored — it would not travel with the repo and the v3.0.0 work would lose the finding). Optionally mirror into the v3 brainstorm for local continuity.

**Approach:**
- Record the verified converter behavior per field in this tracked plan (and/or a `docs/solutions/` doc): `mode` resolved by this patch; `temperature` always computed via `inferTemperature`, HIGH risk; `description`/`steps`/`tools`/`permission`/`hidden` per the audit. Note the "not v3.0.0-ready until temperature hardened" boundary so the v3.0.0 plan inherits it. The Converter-Injected-Field Audit table is recorded directly in this plan (below) so it is captured in a tracked artifact regardless of brainstorm state.

**Test scenarios:**
- Test expectation: none — documentation only.

**Verification:**
- The v3.0.0 plan/brainstorm contains the field audit; content-integrity passes (no broken refs).

## System-Wide Impact

- **Interaction graph:** Only the converter's mode-fill path is affected conceptually; at runtime nothing changes because the converter already resolves these agents to `subagent`. The gate gains one new agent-frontmatter check.
- **API surface parity:** No public API change. The bundled-agent frontmatter contract gains an explicit `mode` requirement enforced by CI.
- **Unchanged invariants:** All agent runtime behavior, model inheritance (agents still omit `model`), colors, and stem-uniqueness are unchanged. This patch only makes an already-resolved value explicit and gate-enforced.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| R2 gate rejects a legitimately non-subagent bundled agent | Verified all 51 bundled agents are subagents; a future primary agent would require a deliberate gate change, which is correct. |
| "Behavior change" from explicit `mode` reordering emitted YAML | Success criterion is resolved-value equivalence (parsed config), not byte-identical strings; the converter still runs in this patch. |
| Implementer chases a phantom registry-regen step | None needed: `generate-registry.ts` consumes only agent `description` + file path, not `mode`, so adding `mode:` cannot change registry output. No registry regeneration required for this patch. |

## Converter-Injected-Field Audit (v3.0.0 finding — R3)

Verified against `src/lib/converter.ts` (`transformAgentFrontmatter`, `inferTemperature`). Recorded here in a tracked artifact so the v3.0.0 converter-removal plan inherits it without re-deriving. Converter removal must address every HIGH/MEDIUM field below; **`temperature` in particular blocks v3.0.0 readiness.**

| Field | Converter behavior when absent | v3.0.0 removal risk |
|-------|-------------------------------|---------------------|
| `mode` | fill-if-absent `subagent` | HIGH — **resolved by this patch (R1/R2)** |
| `temperature` | **always computed** via `inferTemperature(name, description)` → 0.1 / 0.2 / 0.3 / 0.6 (default 0.3) | HIGH — removal silently reverts every agent without explicit `temperature` to the OpenCode default |
| `description` | synthesizes `"<name> agent"` | LOW (cosmetic) |
| `steps` | maps legacy `maxTurns`/`maxSteps` → `steps`; no static default | LOW |
| `tools` | normalizes array form → map form; no default set | LOW–MEDIUM (agents using array-form `tools`) |
| `permission` | maps CC `permissionMode` → `permission` | LOW–MEDIUM (agents using `permissionMode`) |
| `hidden` | derives from `disable-model-invocation` | LOW (rename only) |

## Sources & References

- **Origin document:** docs/brainstorms/2026-06-05-agent-mode-explicit-hardening-requirements.md
- Related code: `src/lib/converter.ts` (`transformAgentFrontmatter`, `inferTemperature`), `scripts/content-integrity.ts` (`checkAgentModel`), `src/lib/config-handler.ts`
- Parent v3 scope: docs/brainstorms/2026-05-21-v3-converter-removal-and-excision-requirements.md
