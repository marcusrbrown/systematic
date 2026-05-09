---
title: feat: Add Provider Model Defaults and MCP Overlays
type: feat
status: active
date: 2026-05-09
origin: docs/plans/2026-05-09-001-feat-agent-model-configuration-plan.md
---

# feat: Add Provider Model Defaults and MCP Overlays

## Overview

Build the deferred second layer on top of merged agent configuration overlays through separate, safer follow-up PRs:

1. harden the overlay foundation from PR #343 review findings,
2. add explicit opt-in provider-aware model defaults,
3. spike MCP tool inventory access before implementing any MCP allowlist shortcut,
4. implement MCP overlays only if the spike proves final OpenCode MCP tool keys are mechanically available.

The first overlay PR intentionally shipped without provider-specific zero-config model defaults or `mcps` shortcuts because the safe OpenCode mapping was not proven at planning time. Follow-up research against OpenCode source clarifies some constraints: plugin `config(cfg)` runs after provider hooks/config assembly, permission rules are evaluated with last-match semantics, and MCP executable tool keys come from `mcp.tools()` as sanitized `<server>_<tool>` keys. It does **not** prove that Systematic's config hook can access final MCP tool inventory; that remains a blocking spike before any MCP permission emission.

## Problem Frame

Systematic users can now tune bundled agents through top-level `agents` and `categories` overlays, but two high-value knobs remain deferred:

- Provider-specific model defaults can specialize agents, but silently emitting model choices because a provider exists would surprise users and may change cost, privacy, latency, and data-routing behavior.
- MCP allowlists can narrow agent capabilities, but they must map to real OpenCode permission keys rather than inert metadata or guessed server-prefix patterns.

The follow-up should add these only where user intent is explicit and the runtime contract is mechanical and testable. It should also fold in the approved non-blocking concerns from PR #343 while the overlay code is still fresh.

## Requirements Trace

- R1. Preserve bundled agent markdown portability: no `model:` frontmatter in bundled agent files.
- R2. Treat model selection as trust-sensitive because it affects cost, privacy, data routing, and provider choice.
- R3. Project `.opencode/systematic.json` must not be able to set or erase higher-trust `model`, `permission`, `skills`, `mcps`, or provider-default policy fields.
- R4. Provider-specific built-in model defaults must be explicit opt-in through a Systematic config surface; configured OpenCode providers alone are not consent.
- R5. Provider defaults may emit model values only when the selected provider is configured in OpenCode config and has a known Systematic model-default table.
- R6. Ambiguous provider situations must fail closed: when more than one candidate provider is configured and no explicit Systematic provider-default selection exists, omit built-in model defaults and inherit.
- R7. Explicit user/custom `agents.<key>.model` and `categories.<id>.model` remain structurally validated but not availability-validated; OpenCode owns runtime behavior for explicit user choices.
- R8. Add `mcps` as a Systematic-managed capability shortcut only if implementation can access or derive final OpenCode MCP tool keys mechanically before emitting config.
- R9. If final MCP tool keys are unavailable during config handling, defer MCP overlays rather than emitting wildcard or guessed prefix rules.
- R10. `mcps` semantics, if shipped, are restrictive allowlists: omitted means inherit weaker behavior, `mcps: []` means deny configured MCP tools, and `mcps: ["server"]` means only the listed servers' tools are allowed from that layer.
- R11. MCP overlays, if shipped, must be security-sensitive like `permission` and `skills`; project config must not loosen or erase higher-trust MCP policy.
- R12. Preserve permission rule ordering: weaker layers first, stronger layers later, because OpenCode permission evaluation uses last matching rule.
- R13. Validate unknown MCP server names, disabled MCP servers, sanitized key collisions, malformed overlay values, and cross-layer permission conflicts before mutating OpenCode config.
- R14. Keep docs explicit that provider defaults and MCP overlays are configuration-time conveniences, not bundled frontmatter, runtime fallback chains, or native `agent.mcps` fields.
- R15. Address PR #343 non-blocking hardening where cheap: color validation/docs, temperature default tests, permission-ordering comments, and category `hidden` coverage.

## Scope Boundaries

- No runtime fallback manager, retry chain, or provider failover orchestration.
- No provider default emitted solely from provider detection; explicit Systematic opt-in is required.
- No MCP server installation or bundling. Users still configure MCP servers in OpenCode.
- No MCP overlay implementation unless final MCP tool keys are mechanically available during config handling or through a stable OpenCode API.
- No wildcard/prefix MCP permission grants unless a proof test shows OpenCode permission semantics make them safe against key collisions and future-tool privilege expansion.
- No native bundled agent `model:` frontmatter.
- No prompt/description/options overlay expansion.
- No attempt to validate explicit user model IDs against live provider APIs.

### Deferred to Separate Tasks

- Runtime model fallback chains: separate design if OpenCode exposes a first-class fallback config surface.
- MCP tool-level allowlists: this plan only considers whole-server allowlists after final tool-key inventory is available.
- MCP overlays themselves are deferred if the spike cannot prove safe inventory access.

## Context & Research

### Relevant Code and Patterns

- `src/lib/agent-overlays.ts` owns overlay field validation, bundled-agent inventory, exact/category resolution, and built-in temperature defaults.
- `src/lib/config-handler.ts` applies overlays to OpenCode `config.agent` and translates managed `skills` into `permission.skill` rules.
- `src/lib/config.ts` merges sourced `agents`/`categories` overlays and protects security-sensitive overlay fields from project config.
- `scripts/content-integrity.ts` enforces bundled agent `model:` bans and duplicate bundled agent stem checks.
- `tests/unit/agent-overlays.test.ts`, `tests/unit/config-handler.test.ts`, and `tests/unit/config.test.ts` cover overlay validation, permission ordering, and source trust behavior.

### Institutional Learnings

- Bundled agents must stay model-free; hard-coded frontmatter `model` values hurt portability and have broken older OpenCode versions.
- Config-hook logic must be non-destructive and singleton-safe; overlay mutation should stage local copies and assign only after validation succeeds.
- Prompt-only capability policy is insufficient. Permission-affecting behavior needs explicit OpenCode permission rules and tests.
- MCP references must resolve to configured capabilities rather than markdown references or assumed servers.

### OpenCode Source Findings

- Plugin config hooks run after provider hooks/config assembly, so `cfg.provider` can be inspected during `config(cfg)`. This is not consent to select a model provider.
- OpenCode agent config supports `model` and `permission`; runtime agent models are provider/model pairs.
- Permission config normalizes shorthand into rules; runtime evaluation uses wildcard matching and `findLast`, so later rules override earlier rules.
- OpenCode MCP tool execution uses the final `mcp.tools()` key map. Exposed keys are sanitized as `<server>_<tool>` with non-alphanumeric, non-underscore, non-hyphen characters converted to `_`.
- OpenCode source also has an internal MCP cache path using `server:tool`; permission mapping should target the final `mcp.tools()` key only if Systematic can access that final map or reproduce it with proven inputs.

### Fro Bot PR #343 Non-Blocking Concerns

- `isOpenCodeColor` accepts any alphabetic-starting string and may accept invalid-looking values.
- `validatePositiveInteger` has an unnecessary cast.
- Alias collisions across sources are intentionally caught at plugin load, but this should remain documented behavior.
- `inferBuiltInTemperature` is implicit regex behavior and lacks branch tests.
- Permission ordering relies on Map insertion order; this is correct but deserves a maintenance comment.
- Missing tests: temperature branches, color edge cases, and category `hidden` acceptance.

## Key Technical Decisions

- **Split delivery into separate PRs.** Hardening, provider defaults, MCP spike, and MCP implementation have different risk profiles and should not block each other.
- **Model routing is trust-sensitive.** Add `model` and provider-default policy fields to the protected overlay field set so project config cannot steer provider/model choices without user/custom config consent.
- **Provider defaults are explicit opt-in.** Add a small Systematic config surface such as `agent_defaults.model_provider: "openai"` to select a provider for built-in agent model defaults. Exact final naming can change during implementation, but the config must be top-level, source-aware, and protected from project config.
- **No automatic provider choice from detection alone.** Provider detection only validates that an explicitly selected provider appears configured. Multiple configured providers are not resolved by preference order unless the user/custom config selects one.
- **Explicit model overlays remain pass-through.** User/custom model overlays are structurally validated and emitted unchanged; Systematic does not ping provider APIs or rewrite explicit values.
- **MCP overlays require a spike gate.** Do not implement `mcps` until a spike proves access to final MCP tool keys or a stable equivalent during config handling.
- **No wildcard MCP grants by default.** Prefix/wildcard rules can expand privileges via future tools or sanitized key collisions. Prefer enumerated concrete keys; if enumeration is impossible, defer.
- **MCP overlays are restrictive allowlists.** If shipped, `mcps` should deny all configured MCP tool keys first, then allow concrete keys for selected servers, ordered so stronger layers win.
- **Same-layer and cross-layer policy conflicts need explicit rules.** Reject same-overlay ambiguity between managed `mcps` and explicit MCP tool permissions. Define and test cross-layer ordering for explicit permissions versus managed shortcuts.

## Open Questions

### Resolved During Planning

- **Can provider configuration be inspected in the plugin config hook?** Yes, OpenCode source shows provider hooks/config are applied before plugin `config(cfg)`, so configured provider IDs can be inspected. This does not justify implicit model defaults.
- **Which MCP key shape should permissions target?** Target the final `mcp.tools()` output key, sanitized as `<server>_<tool>`, but only if final keys are actually available or derivable with collision checks.
- **Do permission rules support override ordering?** Yes, runtime evaluation uses last matching rule.
- **Should provider defaults and MCP overlays ship together?** No. They are independent and should be split to avoid coupling lower-risk model-default work to security-sensitive MCP work.

### Deferred to Implementation

- **Exact OpenCode `cfg.provider` object shape:** Confirm against installed types/source during implementation and keep model-default inference conservative.
- **Exact protected config field shape:** Choose final field names for provider-default opt-in while preserving the policy in this plan.
- **MCP inventory feasibility:** Prove whether final `mcp.tools()` keys are accessible or mechanically derivable during config handling. If not, stop before implementing `mcps`.
- **Default model table:** Define a small provider/model table during provider-default implementation, with tests and docs. Keep the first table conservative.

## Phased Delivery

### PR 1: Overlay hardening

Addresses Fro Bot NBCs and trust-boundary tightening with minimal product surface change.

### PR 2: Explicit provider model defaults

Adds opt-in provider-default policy and built-in model table without MCP changes.

### PR 3: MCP inventory spike

Proves or disproves safe access to final MCP tool keys and permission matching behavior.

### PR 4: MCP overlays, only if PR 3 succeeds

Implements restrictive `mcps` allowlists using concrete MCP tool keys and collision-safe validation.

## Implementation Units

- [ ] **Unit 1: Harden existing overlay validators and trust fields**

**Goal:** Address PR #343 non-blocking concerns and protect model-routing fields from project config.

**Requirements:** R2, R3, R15

**Dependencies:** None

**Files:**
- Modify: `src/lib/agent-overlays.ts`
- Modify: `src/lib/config-handler.ts`
- Modify: `src/lib/config.ts`
- Modify: `README.md`
- Modify: `docs/src/content/docs/getting-started/configuration.mdx`
- Test: `tests/unit/agent-overlays.test.ts`
- Test: `tests/unit/config-handler.test.ts`
- Test: `tests/unit/config.test.ts`

**Approach:**
- Remove the unnecessary numeric cast in positive integer validation.
- Add an inline comment around `permissionFromRules`/`setPermissionRule` documenting the Map insertion-order contract and OpenCode last-match permission semantics.
- Add branch coverage for `inferBuiltInTemperature` values: low review/security, planning/research, docs/writing, creative/design, and fallback.
- Add color edge-case tests. If tightening validation, keep it aligned with OpenCode accepted values; otherwise document the intentionally permissive name behavior in code and docs.
- Add category-level `hidden` acceptance coverage.
- Add `model` to the protected overlay fields in `src/lib/config.ts`, preserving higher-trust model policy across project same-key overlays and rejecting project-level model overlays.
- Document that project config can tune non-sensitive presentation/runtime fields but cannot choose model/provider or permission/capability policy.

**Patterns to follow:**
- Existing tests in `tests/unit/agent-overlays.test.ts` for validation error messages and accepted fields.
- Existing source-trust tests in `tests/unit/config.test.ts`.
- Existing permission ordering tests in `tests/unit/config-handler.test.ts`.

**Test scenarios:**
- Happy path: `hidden` is accepted in a category overlay.
- Edge case: color rejects empty, whitespace-prefixed, and purely numeric values.
- Edge case: all temperature heuristic branches return expected values.
- Security path: project config containing `model` is rejected.
- Security path: project same-key overlay cannot erase user/custom `model` policy.
- Maintenance path: permission ordering test still proves stronger rules win.

**Verification:**
- Overlay unit tests cover Fro Bot's missing-test list.
- Project config cannot steer model/provider routing.
- Bundled agent `model:` content-integrity ban remains intact.

- [ ] **Unit 2: Add explicit provider-default opt-in**

**Goal:** Add provider-aware built-in model defaults without silent zero-config provider selection.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R14

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/agent-overlays.ts`
- Modify: `src/lib/config-handler.ts`
- Modify: `src/lib/config.ts`
- Test: `tests/unit/agent-overlays.test.ts`
- Test: `tests/unit/config-handler.test.ts`
- Test: `tests/unit/config.test.ts`

**Approach:**
- Add a source-aware Systematic provider-default config surface, tentatively `agent_defaults.model_provider`.
- Protect the provider-default field from project config, same as `model`, `permission`, `skills`, and later `mcps`.
- Add a provider-default resolver beside `inferBuiltInTemperature`, but keep it separate so temperature defaults remain provider-independent.
- Emit built-in model defaults only when user/custom config explicitly selects a provider and OpenCode config contains that provider.
- Preserve precedence: explicit exact overlay model > explicit category overlay model > safe opt-in provider default > markdown/inheritance.
- Omit model defaults when the selected provider is absent, when provider config shape is unknown, or when no provider-default policy is set.
- Do not rewrite explicit user model values and do not probe remote provider APIs.

**Patterns to follow:**
- `inferBuiltInTemperature` and overlay application flow in `src/lib/agent-overlays.ts` and `src/lib/config-handler.ts`.
- Source-aware overlay merge logic in `src/lib/config.ts`.

**Test scenarios:**
- Happy path: user/custom config selects provider `openai`, OpenCode config contains `provider.openai`, and an agent with no explicit model receives a known built-in model default.
- Happy path: exact agent `model` overrides category and provider defaults.
- Happy path: category `model` overrides provider defaults.
- Edge case: no provider-default policy leaves `model` omitted even when OpenCode has configured providers.
- Edge case: selected provider missing from OpenCode config leaves `model` omitted or fails with a clear validation error; choose one behavior and document it before implementation.
- Edge case: multiple providers configured without explicit provider-default policy leaves `model` omitted.
- Security path: project config cannot set or erase provider-default policy.
- Error path: malformed explicit model still fails structural validation.
- Integration: emitted agent config never comes from bundled agent frontmatter.

**Verification:**
- Zero-config environments still inherit models.
- Provider defaults require explicit user/custom opt-in.
- Bundled agent `model:` content-integrity ban remains intact.

- [ ] **Unit 3: Document provider model defaults**

**Goal:** Update docs for explicit provider-default behavior before starting MCP work.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R14

**Dependencies:** Unit 2

**Files:**
- Modify: `README.md`
- Modify: `docs/src/content/docs/getting-started/configuration.mdx`

**Approach:**
- Document provider-aware model defaults as opt-in and conservative.
- Document that configured OpenCode providers alone do not change model inheritance.
- Document that explicit user/custom model overlays are passed through structurally and may still fail at OpenCode runtime if the provider/model is unavailable.
- Document project-config restrictions for `model`, provider defaults, `permission`, and `skills`.

**Patterns to follow:**
- Existing agent overlay docs added by PR #343.

**Test scenarios:**
- Test expectation: none -- documentation-only changes. Existing docs build verifies syntax and generated site integrity.

**Verification:**
- Docs clearly distinguish inherited models, opt-in provider defaults, and explicit user overrides.

- [ ] **Unit 4: Spike MCP tool-key inventory and permission safety**

**Goal:** Prove whether MCP overlays can be implemented safely in Systematic's config hook.

**Requirements:** R8, R9, R10, R11, R12, R13, R14

**Dependencies:** Unit 1

**Files:**
- Create: `tests/manual/mcp-permission-key-probe.ts` *(or equivalent manual probe artifact if automated tests are impractical)*
- Modify: `docs/plans/2026-05-09-002-feat-provider-model-mcp-overlays-plan.md` *(only to record spike result before continuing)*

**Approach:**
- Verify whether the plugin `config(cfg)` hook can access final MCP tool keys or only server definitions.
- Verify the installed OpenCode permission evaluator accepts the intended concrete tool keys and last-match rule ordering.
- Verify sanitized key collisions can be detected before emitting permissions.
- Verify disabled MCP servers are distinguishable and should be rejected or treated as absent.
- Do not implement `mcps` overlay support in this unit.

**Patterns to follow:**
- Manual probe style from `tests/manual/companion-aware-probe.ts`.
- Existing empirical probe workflow in project memories for OpenCode plugin behavior.

**Test scenarios:**
- Spike path: configured MCP server with known tools exposes final keys available to plugin code, or proves they are unavailable.
- Spike path: disabled server is distinguishable from enabled server.
- Spike path: two sanitized names that would collide are detected or proven impossible through OpenCode validation.
- Spike path: permission evaluator uses last matching rule for concrete MCP tool keys.

**Verification:**
- If final tool keys are available or mechanically derivable, document the exact source and continue to Unit 5.
- If final tool keys are not available, stop: leave `mcps` deferred and do not ship guessed wildcard behavior.

- [ ] **Unit 5: Add MCP server allowlist overlays**

**Goal:** Support restrictive `mcps` overlays by translating configured MCP server allowlists into permission rules for concrete final OpenCode MCP tool keys.

**Requirements:** R8, R10, R11, R12, R13, R14

**Dependencies:** Unit 4 succeeds

**Files:**
- Modify: `src/lib/agent-overlays.ts`
- Modify: `src/lib/config-handler.ts`
- Modify: `src/lib/config.ts`
- Test: `tests/unit/agent-overlays.test.ts`
- Test: `tests/unit/config-handler.test.ts`
- Test: `tests/unit/config.test.ts`

**Approach:**
- Add `mcps` to the overlay allow-list as an array of configured MCP server IDs only after the spike proves final key inventory.
- Build MCP inventory from the proven source, not from guessed server prefixes.
- Reject disabled MCP servers and unknown MCP server IDs.
- Detect sanitized key collisions before emitting rules.
- Translate `mcps` into concrete permission rules for final MCP tool keys. Deny all configured MCP tool keys first, then allow keys for selected server IDs.
- Preserve weaker-to-stronger layer ordering so exact overlays override category/default rules.
- Reject same-overlay ambiguity where an overlay sets both managed `mcps` and explicit permission entries targeting MCP tool keys.
- Define and test cross-layer behavior for managed `mcps` versus explicit MCP permissions. Explicit higher-trust user/custom denies must not be silently loosened by generated rules.
- Add `mcps` to protected overlay fields so project config cannot set or erase MCP policy.

**Patterns to follow:**
- Managed `skills` shortcut in `src/lib/config-handler.ts`.
- Project security overlay restrictions in `src/lib/config.ts`.
- Spike results from Unit 4.

**Test scenarios:**
- Happy path: `mcps: ["context7"]` emits deny rules for configured MCP keys followed by allows for concrete `context7` tool keys.
- Happy path: category allows MCP A/B and exact allows only A; exact-layer rules win by order.
- Edge case: empty `mcps: []` denies all configured MCP tool keys.
- Edge case: omitted `mcps` inherits weaker-layer MCP rules.
- Edge case: disabled MCP server is rejected or treated as absent according to Unit 4 decision.
- Error path: unknown MCP server ID fails before mutating config.
- Error path: sanitized key collision fails fast.
- Error path: project config containing `mcps` is rejected.
- Error path: project same-key overlay cannot erase user/custom `mcps` policy.
- Error path: same overlay object with managed `mcps` and explicit MCP tool permission fails.
- Error path: cross-layer explicit deny is not loosened by lower-trust or weaker-layer managed `mcps`.
- Integration: invalid MCP overlay leaves `config.agent`, `config.command`, `config.skills.paths`, and `config.mcp` unmodified.

**Verification:**
- Unit and integration tests prove MCP overlay emission uses concrete final MCP tool keys and last-match ordering.
- No `agent.mcps` field is emitted.

- [ ] **Unit 6: Document MCP overlays**

**Goal:** Update docs for restrictive MCP allowlists only if MCP overlays ship.

**Requirements:** R8, R10, R11, R12, R13, R14

**Dependencies:** Unit 5

**Files:**
- Modify: `README.md`
- Modify: `docs/src/content/docs/getting-started/configuration.mdx`

**Approach:**
- Document `mcps` as a Systematic permission shortcut, not a native OpenCode agent field.
- Show examples for omitted `mcps`, `mcps: []`, and `mcps: ["context7"]`.
- Make restrictive semantics explicit: selected servers narrow available MCP tools at that layer.
- Document project-config restrictions for `mcps`.
- Document that MCP servers must already be configured in OpenCode.

**Patterns to follow:**
- Existing agent overlay and skills allowlist docs.

**Test scenarios:**
- Test expectation: none -- documentation-only changes. Existing docs build verifies syntax and generated site integrity.

**Verification:**
- Docs do not imply Systematic installs MCP servers or emits native `agent.mcps` fields.

- [ ] **Unit 7: Final integrity and release safety checks**

**Goal:** Ensure each shipped PR preserves package invariants.

**Requirements:** R1, R3, R11, R12, R13, R14

**Dependencies:** Relevant implementation/docs units for each PR

**Files:**
- Modify: `scripts/content-integrity.ts` *(only if new static invariants need checks)*
- Test: `tests/unit/content-integrity.test.ts` *(only if integrity checks change)*

**Approach:**
- Keep the bundled-agent `model:` ban unchanged.
- Add content-integrity coverage only for static invariants that cannot be caught by runtime tests.
- Run the full project verification suite and docs/registry drift checks for each PR.

**Patterns to follow:**
- Existing content-integrity checks for model bans and duplicate agent stems.

**Test scenarios:**
- Content-integrity path: bundled agent `model:` remains rejected.
- Content-integrity path: any new static invariant introduced by this follow-up has a failing fixture/test.

**Verification:**
- Build, typecheck, lint, tests, docs build, content integrity, registry drift, and registry validation all pass.

## System-Wide Impact

- **Interaction graph:** Systematic config loading feeds overlay validation, bundled agent emission, and OpenCode permission evaluation. Provider defaults depend on source-aware Systematic config plus incoming OpenCode provider config. MCP overlay behavior depends on final MCP tool inventory if available.
- **Error propagation:** Invalid overlay config should fail fast during plugin config handling with source-path and key-path context. Explicit user model availability remains an OpenCode runtime concern.
- **State lifecycle risks:** Config mutation must remain atomic; invalid provider/MCP overlays must not partially mutate `config.agent`, `config.command`, `config.skills`, or `config.mcp`.
- **API surface parity:** Exact agent overlays and category overlays need matching behavior for `model` and `mcps`, except exact-only fields such as `disable` remain exact-only.
- **Integration coverage:** Unit tests should cover validation, but config-handler tests must prove emitted OpenCode config shape and permission ordering. MCP needs a spike/probe before unit tests can safely assert emitted permissions.
- **Unchanged invariants:** Bundled agents remain model-free; project config remains lower trust for provider/model and permission-affecting fields; registry generation should not change unless docs/assets inputs change.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Provider defaults surprise users by changing model inheritance | Require explicit user/custom provider-default opt-in; configured providers alone do not select models. |
| Project config routes prompts to a different provider | Treat `model` and provider-default policy as protected fields. |
| Provider config shape differs across OpenCode versions | Keep resolver conservative and covered by tests; unknown shapes produce no default. |
| Multiple configured providers create arbitrary selection | Omit model defaults unless user/custom config chooses a provider. |
| MCP key mapping is unavailable in config hook | Spike first; if final keys are unavailable, keep `mcps` deferred. |
| Wildcard MCP grants expand privileges through future tools | Prefer enumerated concrete keys; do not ship guessed prefix grants. |
| Sanitized MCP key collisions cross server boundaries | Detect collisions before emitting rules. |
| Permission order regresses | Add explicit comments and tests around last-match semantics. |
| Temperature heuristics stay too implicit | Add branch tests and an inline reference table/comment. |

## Documentation / Operational Notes

- This is a developer-facing config feature with no persistent production service.
- Provider-default PR notes should emphasize explicit opt-in and project-config restrictions.
- MCP PR notes should emphasize restrictive allowlist semantics and that MCP servers must already be configured in OpenCode.
- PR descriptions should include post-merge validation notes to watch plugin load failures, overlay config issues, provider routing surprises, and MCP permission reports in GitHub issues/PR comments.

## Sources & References

- Origin plan: `docs/plans/2026-05-09-001-feat-agent-model-configuration-plan.md`
- Merged PR: https://github.com/marcusrbrown/systematic/pull/343
- Fro Bot review: https://github.com/marcusrbrown/systematic/pull/343#pullrequestreview-4257599753
- Related code: `src/lib/agent-overlays.ts`
- Related code: `src/lib/config-handler.ts`
- Related code: `src/lib/config.ts`
- Related tests: `tests/unit/agent-overlays.test.ts`
- Related tests: `tests/unit/config-handler.test.ts`
- Related tests: `tests/unit/config.test.ts`
