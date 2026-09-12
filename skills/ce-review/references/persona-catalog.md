# Persona Catalog

13 reviewer personas organized into a three-persona core, cross-cutting conditional, and stack-specific conditional layers, plus CE-specific conditional agents. The orchestrator uses this catalog to select which reviewers to spawn for each review.

## Shared persona pool

The `agents/review/` directory is a shared persona pool, not `ce:review`'s roster. Directory placement does not imply that a persona is selectable by `ce:review`. These shared personas are dispatched by other workflows and intentionally do not appear in this catalog's `ce:review` selection tables:

- `systematic:review:architecture-strategist` — dispatched by `deepen-plan` and `ce-plan`'s deepening workflow for architectural analysis.
- `systematic:review:pattern-recognition-specialist` — dispatched by `deepen-plan`, `ce-plan`'s deepening workflow, and `ce-compound` for consistency, duplication, and pattern analysis.
- `systematic:review:code-simplicity-reviewer` — dispatched by `ce-compound` for code-heavy issues.

## Always-on (3 core personas)

Selected on every review regardless of diff content. These three are the only reviewers with no selection condition.

| Persona | Agent | Focus |
|---------|-------|-------|
| `correctness` | `systematic:review:correctness-reviewer` | Logic errors, edge cases, state bugs, error propagation, intent compliance |
| `testing` | `systematic:review:testing-reviewer` | Coverage gaps, weak assertions, brittle tests, missing edge case tests |
| `project-standards` | `systematic:review:project-standards-reviewer` | AGENTS.md compliance -- frontmatter, references, naming, cross-platform portability, tool selection |

## Conditional (9 personas)

Spawned only when the orchestrator identifies a relevant surface in the diff. The orchestrator reads the full diff and reasons about selection -- this is agent judgment, not keyword matching. Record `selection_reason` and a non-empty `selection_surface` for each selected conditional persona.

| Persona | Agent | Select when diff touches... |
|---------|-------|---------------------------|
| `maintainability` | `systematic:review:maintainability-reviewer` | Materially adds or reshapes abstractions, raises cross-module coupling, adds state/control-flow complexity, changes naming or ownership structure, removes dead code, or performs a broad refactor. Do not select it for a tiny prose or fixture correction with no structural decision and no user- or agent-facing or other specialist surface. |
| `security` | `systematic:review:security-reviewer` | Auth middleware, public endpoints, user input handling, permission checks, secrets management |
| `performance` | `systematic:review:performance-reviewer` | Database queries, ORM calls, loop-heavy data transforms, caching layers, async/concurrent code |
| `api-contract` | `systematic:review:api-contract-reviewer` | Route definitions, serializer/interface changes, event schemas, exported type signatures, API versioning |
| `data-migrations` | `systematic:review:data-migrations-reviewer` | Migration files, schema changes, backfill scripts, data transformations |
| `reliability` | `systematic:review:reliability-reviewer` | Error handling, retry logic, circuit breakers, timeouts, background jobs, async handlers, health checks |
| `adversarial` | `systematic:review:adversarial-reviewer` | >=50 changed lines of executable production code, excluding tests, generated files, lockfiles, instruction/prose Markdown, JSON schemas, and config; OR regardless of file type for auth, payments, data mutations, external APIs, or another explicitly high-risk domain |
| `cli-readiness` | `systematic:review:cli-readiness-reviewer` | CLI command definitions, argument parsing, CLI framework usage, command handler implementations |
| `previous-comments` | `systematic:review:previous-comments-reviewer` | **PR-only.** Reviewing a PR that has existing review comments or review threads from prior review rounds. Skip entirely when no PR metadata was gathered in Stage 1. |

## Stack-Specific Conditional (1 persona)

These reviewers keep their original opinionated lens. They are additive with the cross-cutting personas above, not replacements for them.

| Persona | Agent | Select when diff touches... |
|---------|-------|---------------------------|
| `kieran-typescript` | `systematic:review:kieran-typescript-reviewer` | TypeScript components, services, hooks, utilities, or shared types |

## CE Conditional Agents (3)

These CE-native agents provide specialized analysis beyond what the persona agents cover. Their output is unstructured and synthesized separately; they never receive a raw-return dispatch record. Announce and report their selection reason/surface in the team and Coverage instead.

| Agent | Select when diff includes... |
|-------|------------------------------|
| `systematic:review:agent-native-reviewer` | A user- or agent-facing UI, CLI, tool, or workflow capability, or a changed access path where agent parity or discoverability is material. Do not select it for every review. |
| `systematic:research:learnings-researcher` | Bug, regression, or hardening work; a recurring failure class; a change to a documented solution or module; or a plan/PR that cites relevant prior art. Do not select it for every review. |
| `systematic:review:deployment-verification-agent` | Database migrations (`db/migrate/*.rb`, `db/schema.rb`) or data backfill scripts. |

## Selection rules

1. **Always select exactly the three core personas:** `correctness`, `testing`, and `project-standards`. Nothing else is always-on.
2. **For each cross-cutting conditional persona**, read the diff and decide whether the persona's domain is relevant. This is a judgment call, not a keyword match. A tiny prose or fixture correction is core-only only when it has no structural decision and no user- or agent-facing behavior, access change, or other specialist surface; a structural refactor may add `maintainability`; an auth feature may add `security` and `reliability`.
3. **For each stack-specific conditional persona**, use file types and changed patterns as a starting point, then decide whether the diff actually introduces meaningful work for that reviewer. Do not spawn language-specific reviewers just because one config or generated file happens to match the extension.
4. **For CE conditional agents**, select `agent-native-reviewer` for agent-facing capability changes, `learnings-researcher` for bug/regression/hardening or recurring-defect work, and `deployment-verification-agent` for migrations or data backfills. Their output is unstructured; report their selection reason/surface in the team and Coverage rather than a dispatch record.
5. **Record selection metadata.** Every selected structured conditional persona records `selection_reason` and a non-empty `selection_surface`; core personas may omit both.
6. **Announce the team** before spawning with a one-line rationale and the triggering repository-relative paths/surfaces per selected conditional. Distinguish core reviewers, selected conditionals, an explicit "no conditional selected" case, and selected-but-failed/malformed/validation-unavailable reviewers. Never label an unselected reviewer as failed.
7. **Reviewer count is an outcome, not a target.** Never restore a fixed floor; a smaller selected set is not automatically better or worse than a larger one.

## Selection scenarios

| Scenario | Selected |
|----------|----------|
| Tiny prose or fixture correction with no structural decision and no user- or agent-facing or other specialist surface | `correctness`, `testing`, `project-standards` only; no runtime probe |
| Structural refactor adding or reshaping abstractions, coupling, state, or control flow | core plus `maintainability` |
| Agent-facing UI/CLI/tool/workflow capability or changed access path | core plus CE `agent-native-reviewer` |
| Bug, regression, or hardening work; recurring failure class; documented solution/module touched; plan/PR citing prior art | core plus CE `learnings-researcher` |
| Auth surface | core plus `security` |
| Migration or backfill | core plus `data-migrations` and CE `deployment-verification-agent` |
| Public API/route/serializer/type-signature change | core plus `api-contract` |
| Error handling, retries, timeouts, background jobs | core plus `reliability` |
| Query, loop, caching, or concurrency hot path | core plus `performance` |
| Renderer or asset-delivery change needing runtime evidence | a focused execution probe (independent of reviewer selection); a change that separately triggers a conditional still selects that reviewer |

## Execution probes (separate parent decision)

A focused execution probe is independent of reviewer selection. A pure renderer or asset-delivery change with no conditional surface may be core plus a probe, but a change that separately triggers `agent-native-reviewer`, `security`, or another conditional still selects those reviewers. An execution probe is not a reviewer and never substitutes for risk-critical reviewer coverage; selecting a probe never adds `maintainability` and never restores a reviewer floor. When selected, record the probe target and its permission boundary in Coverage.
