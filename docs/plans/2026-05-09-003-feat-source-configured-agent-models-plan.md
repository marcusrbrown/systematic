---
title: "feat: Add Source-Configured Agent Models"
type: feat
status: superseded
date: 2026-05-09
origin: docs/plans/2026-05-09-002-feat-provider-model-mcp-overlays-plan.md
---

# feat: Add Source-Configured Agent Models

## Overview

Add source-configured default `model` values for Systematic bundled agents by category. The defaults live in TypeScript/default-resolution code, not bundled agent markdown, and are emitted into OpenCode agent config only for Systematic-owned bundled agents. High-trust exact and category model overlays still override source defaults; project config still cannot steer model routing.

This plan deliberately excludes `fallback_models`, MCP overlays, provider probing, and runtime retry behavior. OpenCode supports `agent.<name>.model`; that is enough to ship source-configured primary models. Fallback support is separate future work and must not block this implementation.

## Problem Frame

PR #343 added top-level `agents` and `categories` overlays but intentionally left model choice inherited unless users configured explicit models. The next feature is to give Systematic's bundled agents opinionated, source-owned model defaults per role category while preserving the existing trust boundaries:

- bundled `agents/**/*.md` remain portable and model-free;
- source defaults are controlled by Systematic code, not project config;
- higher-trust user/config-dir config can override exact agents or whole categories;
- native same-name OpenCode agents remain user-owned replacements;
- no unsupported fallback metadata is emitted.

## Requirements Trace

- R1. Ship source-configured primary `model` defaults for all bundled agent categories: `design`, `docs`, `document-review`, `research`, `review`, and `workflow`.
- R2. Keep bundled agent markdown portable: no `model:` frontmatter in bundled `agents/**/*.md`, and no `model: inherit`.
- R3. Apply source model defaults automatically when no stronger high-trust exact/category `model` override exists.
- R4. Preserve existing trust boundary: project `.opencode/systematic.json` cannot set, erase, null, empty-string, or shadow `model` policy.
- R5. Keep explicit high-trust model overlays structurally validated but not availability-validated; OpenCode owns runtime provider/model availability failures.
- R6. Apply defaults only to Systematic-owned bundled agents. Native same-name OpenCode agents remain full replacements and receive no Systematic source model default.
- R7. Uncategorized bundled agents receive no category model default and continue inheriting the parent OpenCode model.
- R8. Validate every source default model string through the same structural `provider/model` rules as explicit overlays before emission.
- R9. Do not emit, document as supported, or silently accept `fallback_models` in this feature.
- R10. Update public docs to explain the source model table, override precedence, project-config restriction, and no-fallback scope.
- R11. Support `model: null` in high-trust user/config-dir config as an inheritance opt-out that restores OpenCode parent-model routing for a bundled agent or category.
- R12. Add migration guidance: users who relied on inherited parent-model routing for categorized bundled agents can set high-trust `categories.<id>.model: null` or exact `agents.<key>.model: null`; project config cannot do this.

## Scope Boundaries

- No `fallback_models` implementation, config field, docs example, or emitted metadata.
- No runtime fallback manager, event-hook retry supervisor, or second-provider replay behavior.
- No MCP overlay work.
- No provider detection, provider availability probing, remote catalog calls, or network checks during config handling or tests.
- No bundled agent frontmatter model fields.
- No prompt/description/options overlay expansion.
- No changes to OpenCode native agent replacement semantics.

### Deferred to Separate Tasks

- Runtime fallback behavior: separate plan/upstream OpenCode contract if/when we choose to pursue it.
- MCP inventory spike and MCP overlays: separate PR sequence.

## Context & Research

### Relevant Code and Patterns

- `src/lib/config-handler.ts` is the config emission choke point. `applyAgentOverlays()` currently starts from bundled markdown config, applies built-in temperature defaults, then category overlays, then exact overlays.
- `src/lib/agent-overlays.ts` owns overlay inventory, validation, category/exact resolution, and `inferBuiltInTemperature()`.
- `src/lib/config.ts` loads sourced Systematic config and protects security-sensitive fields. `model` is already protected from project config.
- `src/lib/agents.ts` parses optional agent frontmatter fields, but bundled agent files must omit `model`.
- `scripts/content-integrity.ts` enforces the bundled-agent `model` frontmatter ban.
- `tests/unit/config-handler.test.ts`, `tests/unit/agent-overlays.test.ts`, `tests/unit/config.test.ts`, and `tests/integration/opencode.test.ts` cover the overlay/config emission surface.

### Institutional Learnings

- Bundled agents must stay model-free; omitted `model` is the portable OpenCode inheritance path for markdown assets.
- Source-owned defaults belong in config/default-resolution, not in bundled markdown.
- Config mutation must validate first and assign after success to avoid partial OpenCode config mutation on errors.
- Config source precedence and agent overlay precedence are separate concerns: source merge is user → project → config-dir; emitted agent precedence is high-trust exact overlay → high-trust category overlay → built-in/source defaults → markdown → OpenCode inheritance.
- Native OpenCode same-name agents are replacements, not Systematic overlay targets.

### External References

- OpenCode agents docs: https://opencode.ai/docs/agents/
- OpenCode config schema: https://opencode.ai/config.json
- Prior model/default research from OMO Slim and Magic Context for current model IDs and role-based model choices.

## Source Model Table

These source defaults are primary model choices only. They are intentionally **not** fallback chains.

| Category | Default `model` | Rationale |
|----------|-----------------|-----------|
| `design` | `openai/gpt-5.5` | High-judgment UX/product/design work benefits from a strong general reasoning model. |
| `docs` | `openai/gpt-5.4-mini` | Documentation and summarization should start cheaper/faster. |
| `document-review` | `anthropic/claude-opus-4-7` | Requirements and plan critique benefit from strongest nuanced reasoning. |
| `research` | `openai/gpt-5.5` | Tool-heavy synthesis and source evaluation benefit from a strong general reasoning model. |
| `review` | `anthropic/claude-opus-4-7` | Code/security/adversarial review benefits from strongest reasoning. |
| `workflow` | `openai/gpt-5.4-mini` | Orchestration and bounded implementation should default cheaper/faster. |

## Key Technical Decisions

- **Source defaults are automatic package policy.** Source-configured models apply by bundled category when no stronger high-trust exact/category model override exists. This is the feature; do not add an opt-in gate unless implementation reveals a concrete breakage.
- **Defaults live in code, not markdown.** Keep bundled agents model-free and add a single audited TypeScript table keyed by category.
- **Built-in default layer owns model defaults.** Apply source models alongside existing built-in temperature defaults before category/exact overlays, so higher-trust overlays remain stronger.
- **Project config remains lower trust.** Project config still cannot set or erase `model`. If project config overlays a same key for non-sensitive fields, higher-trust model policy is preserved by existing protection.
- **No provider availability checks.** Source and explicit models are structurally validated as `provider/model`; OpenCode runtime reports unavailable provider/model errors.
- **No fallback leakage.** `fallback_models` remains unsupported in this feature and must not appear in emitted config or supported docs.

## Open Questions

### Resolved During Planning

- **Is this blocked on `fallback_models` support?** No. This plan ships primary `model` defaults only. Fallback behavior is explicitly out of scope.
- **Should source defaults apply automatically?** Yes. That is the requested source-configured model behavior. User/config-dir exact and category model overrides remain stronger.
- **Where should defaults live?** In source TypeScript default-resolution code, not bundled agent markdown.
- **Should provider availability be checked?** No. Validation remains structural only.

### Deferred to Implementation

- **Exact helper names and module boundaries:** choose the smallest shape that keeps validation reusable and readable.
- **Manual source-table sanity check:** implementation may use already-researched/current docs to catch obvious stale IDs, but must not add automated provider/catalog probing, network calls, or availability tests. If a listed ID is obviously stale, update the table to the current equivalent and document the substitution in the PR.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

The emitted model for a Systematic bundled agent should resolve in this order:

| Precedence | Source | Example |
|------------|--------|---------|
| 1 | High-trust exact overlay | `agents.correctness-reviewer.model` |
| 2 | High-trust category overlay | `categories.review.model` |
| 3 | Source category default | `review -> anthropic/claude-opus-4-7` |
| 4 | Bundled markdown | omitted for bundled assets |
| 5 | OpenCode inherited parent model | no `model` emitted |

Implementation shape:

1. Define source model defaults in `src/lib/agent-overlays.ts` or a tiny adjacent helper.
2. Validate the table using the same structural model-string validation as user overlays.
3. During `applyAgentOverlays()`, set `config.model` from the source table for categorized bundled agents at the built-in/source default layer. Source defaults intentionally take precedence over any bundled markdown `model` field; content integrity should prevent such markdown from shipping, but source policy still wins defensively before high-trust overlays apply.
4. Apply category and exact overlays after the source default so higher-trust explicit models override it.
5. Skip source defaults for native same-name replacements and uncategorized bundled agents.

## Implementation Units

- [ ] **Unit 1: Add source model default helpers**

**Goal:** Define and validate the source category model table without changing emitted config yet.

**Requirements:** R1, R2, R5, R8, R9

**Dependencies:** None

**Files:**
- Modify: `src/lib/agent-overlays.ts`
- Test: `tests/unit/agent-overlays.test.ts`

**Approach:**
- Add one source-owned table keyed by bundled category IDs, plus an invariant that every discovered bundled category is either in the table or explicitly listed as intentionally inheriting.
- Reuse or extract the existing model-string validator so source defaults and explicit overlays share the same structural rule.
- Expose a small helper for looking up a category default; return `undefined` for unknown/uncategorized agents.
- Do not add `fallback_models` to allowed overlay fields or table values.

**Patterns to follow:**
- `inferBuiltInTemperature()` and its branch tests.
- Existing overlay model validation in `agent-overlays.ts`.

**Test scenarios:**
- Happy path: every bundled category returns the expected source model.
- Edge case: unknown category returns no source model.
- Edge case: every discovered bundled category is explicitly covered by the source table or an intentional-inherit allowlist.
- Error path: a malformed source model string fails validation in a test-only invariant path.

**Verification:**
- Source defaults are centralized, validated, model-only, and category coverage is intentional.

- [ ] **Unit 2: Emit source models through built-in defaults**

**Goal:** Apply source model defaults to bundled Systematic agents while preserving exact/category override precedence and native replacement behavior.

**Requirements:** R1, R3, R4, R5, R6, R7, R8, R9

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/config-handler.ts`
- Test: `tests/unit/config-handler.test.ts`
- Test: `tests/integration/opencode.test.ts`

**Approach:**
- In `applyAgentOverlays()`, apply the source category model default at the built-in default layer, near temperature defaults. Do not merge source defaults through `DEFAULT_CONFIG`, `loadConfigWithSources()`, or ordinary user/project/custom overlay state.
- Apply source defaults only for bundled agents with known categories.
- Preserve current category and exact overlay application order so explicit high-trust `model` values override source defaults. A high-trust `variant` applies only alongside the resolved model; project `variant` should be protected with other model-routing fields.
- Preserve native same-name replacement behavior; Systematic should not overlay source defaults onto user-owned native agents.
- Update integration expectations that previously asserted no emitted model under zero config.

**Patterns to follow:**
- Current temperature default application in `applyAgentOverlays()`.
- Native same-name replacement tests and overlay conflict tests in `config-handler.test.ts`.

**Test scenarios:**
- Happy path: zero Systematic config emits source model defaults for bundled agents in all six categories.
- Happy path: `loadConfig()` / `loadConfigWithSources()` with no high-trust model overlay returns no source-default model overlays; source defaults appear only during bundled agent emission.
- Happy path: high-trust exact `model` overrides a source default for one bundled agent.
- Happy path: high-trust category `model` overrides source defaults for every bundled agent in that category.
- Happy path: high-trust category overlay with non-model fields, such as `temperature`, does not erase the source model.
- Edge case: uncategorized bundled agent receives no source model default and inherits OpenCode model.
- Edge case: native same-name OpenCode replacement receives no Systematic source model default, even when a category default exists.
- Edge case: source defaults defensively replace any bundled markdown model before high-trust overlays apply, while content-integrity still forbids bundled markdown models.
- Error path: invalid source model table prevents config mutation before assigning `config.agent`.
- Integration: zero-config OpenCode agent output includes expected source model defaults and no `fallback_models` key.

**Verification:**
- Emitted config follows precedence: exact overlay > category overlay > source model default > markdown/inheritance.

- [ ] **Unit 3: Keep trust-boundary and unsupported-field tests explicit**

**Goal:** Lock the lower-trust project-config behavior, model-adjacent `variant` protection, and no-fallback scope around the new source defaults.

**Requirements:** R4, R5, R9

**Dependencies:** Unit 2

**Files:**
- Modify: `tests/unit/config.test.ts`
- Modify: `tests/unit/agent-overlays.test.ts`

**Approach:**
- Keep existing project-config `model` rejection tests intact.
- Add `variant` to the protected model-routing field set unless implementation proves OpenCode `variant` cannot steer model behavior; project config must not set or erase it.
- Add one delta test proving project config cannot erase or override a source default or higher-trust model while changing allowed non-sensitive fields.
- Add explicit unsupported-field tests for `fallback_models` in `agents` and `categories` overlays so future fallback work cannot sneak in through loose object merging.
- Add an emitted-config scan proving Systematic-owned bundled agents never include `fallback_models` under zero config or with overlays.

**Patterns to follow:**
- Existing `SECURITY_OVERLAY_FIELDS` project rejection coverage in `config.test.ts`.
- Unknown overlay field validation in `agent-overlays.test.ts`.

**Test scenarios:**
- Security path: project config cannot set `agents.<key>.model`, `categories.<id>.model`, `agents.<key>.variant`, or `categories.<id>.variant`.
- Security path: project same-key overlay cannot erase a source default or higher-trust exact `model` while changing allowed non-sensitive fields.
- Error path: `agents.<key>.fallback_models` is rejected as unsupported.
- Error path: `categories.<id>.fallback_models` is rejected as unsupported.
- Integration/unit path: emitted Systematic bundled agents contain no `fallback_models` key.

**Verification:**
- Source defaults do not weaken the existing project-config trust boundary.

- [ ] **Unit 4: Update docs for source model defaults**

**Goal:** Document the source model table, precedence, override paths, `model: null` inheritance opt-out, migration guidance, and no-fallback scope.

**Requirements:** R1, R2, R3, R4, R5, R9, R10, R11, R12

**Dependencies:** Unit 2

**Files:**
- Modify: `README.md`
- Modify: `docs/src/content/docs/getting-started/configuration.mdx`
- Modify: `skills/writing-systematic-skills/references/foundation-conventions.md` *(only if needed to clarify that runtime source defaults do not permit bundled markdown `model` fields)*

**Approach:**
- Update examples that currently say emitted bundled agents omit `model` by default.
- Show the source model table and the override precedence.
- Keep the bundled markdown rule explicit: authors still omit `model` in agent files.
- State that Systematic does not support `fallback_models`, inherited retry semantics, runtime fallback behavior, or fallback to the parent model when a source model is unavailable.
- State that explicit and source model IDs are structurally validated and may still fail at OpenCode runtime if unavailable.

**Patterns to follow:**
- Existing agent overlay documentation sections in README and configuration guide.

**Test scenarios:**
- Test expectation: none -- documentation-only changes. Existing docs build verifies site integrity.

**Verification:**
- Public docs match emitted behavior and do not imply fallback support.

## System-Wide Impact

- **Interaction graph:** Config loading, overlay validation, bundled agent config emission, docs generation expectations, and integration output all see the new source model defaults.
- **Error propagation:** Malformed source defaults should fail before mutating OpenCode config. Unavailable providers/models remain OpenCode runtime errors.
- **State lifecycle risks:** No persistent state or data migration. Main risk is accidental provider/model routing surprise; docs, release notes, and override paths make the source policy explicit.
- **API surface parity:** Exact and category model overlays continue to work. Native OpenCode same-name agents remain replacements. Bundled markdown remains model-free.
- **Integration coverage:** Unit tests cover helper validation and precedence; integration verifies zero-config emitted agents include source models and no fallback metadata.
- **Unchanged invariants:** Project config cannot control `model`, `variant`, `permission`, or `skills`; content-integrity continues banning bundled agent `model` frontmatter.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Source defaults route agents to provider IDs a user has not configured | Document provider/model defaults, trust-boundary implications, and override path; runtime availability remains OpenCode-owned. |
| Model IDs churn | Use current researched IDs; do structural validation in tests and record any obvious manual source-table correction in the PR. No automated provider probing. |
| Source defaults accidentally weaken project-config trust boundary | Keep and extend project-source rejection/preservation tests, including `variant`. |
| Defaults accidentally apply to native user-owned agents | Add native same-name replacement coverage. |
| Future fallback work leaks into this PR | Keep `fallback_models` unsupported and add negative tests. |

## Documentation / Operational Notes

- PR description should call out the behavior change as trust-sensitive: zero-config bundled agents now emit source-owned category model defaults and may send agent context to the listed providers instead of inheriting the parent model.
- Release notes should list the category model table, say no Systematic fallback/retry occurs, and show how to override via user/config-dir config if users want different routing.
- Do not describe fallback chains as supported.

## Sources & References

- Origin plan: `docs/plans/2026-05-09-002-feat-provider-model-mcp-overlays-plan.md`
- Prior foundation plan: `docs/plans/2026-05-09-001-feat-agent-model-configuration-plan.md`
- Related code: `src/lib/config-handler.ts`
- Related code: `src/lib/agent-overlays.ts`
- Related code: `src/lib/config.ts`
- Related code: `src/lib/agents.ts`
- Related tests: `tests/unit/config-handler.test.ts`
- Related tests: `tests/unit/agent-overlays.test.ts`
- Related tests: `tests/unit/config.test.ts`
- Related tests: `tests/integration/opencode.test.ts`
- OpenCode agents docs: https://opencode.ai/docs/agents/
- OpenCode config schema: https://opencode.ai/config.json
