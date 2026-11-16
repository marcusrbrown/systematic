# Persona Catalog

13 reviewer personas organized into a three-persona core, cross-cutting conditional, and stack-specific conditional layers, plus CE-specific conditional agents. The orchestrator uses this catalog to select which reviewers to spawn for each review.

## Shared persona pool

The `agents/review/` directory is a shared persona pool, not `ce:review`'s roster. Directory placement does not imply that a persona is selectable by `ce:review`. These shared personas are dispatched by other workflows and intentionally do not appear in this catalog's `ce:review` selection tables:

- `systematic:review:architecture-strategist` — dispatched by `deepen-plan` and `ce:plan`'s deepening workflow for architectural analysis.
- `systematic:review:pattern-recognition-specialist` — dispatched by `deepen-plan`, `ce:plan`'s deepening workflow, and `ce:compound` for consistency, duplication, and pattern analysis.
- `systematic:review:code-simplicity-reviewer` — dispatched by `ce:compound` for code-heavy issues.

## Always-on (3 core personas)

Selected on every review regardless of diff content. These three are the only reviewers with no selection condition.

| Persona | Agent | Focus |
|---------|-------|-------|
| `correctness` | `systematic:review:correctness-reviewer` | Logic errors, edge cases, state bugs, error propagation, intent compliance |
| `testing` | `systematic:review:testing-reviewer` | Coverage gaps, weak assertions, brittle tests, missing edge case tests |
| `project-standards` | `systematic:review:project-standards-reviewer` | AGENTS.md compliance -- frontmatter, references, naming, cross-platform portability, tool selection |

## Conditional (9 personas)

Spawned only when the orchestrator identifies a relevant surface in the diff. The orchestrator reads the pinned manifest and the per-path diff of the paths selection turns on, and reasons about selection -- this is agent judgment, not keyword matching. Record `selection_reason` and a non-empty `selection_surface` for each selected conditional persona.

| Persona | Agent | Select when diff touches... |
|---------|-------|---------------------------|
| `maintainability` | `systematic:review:maintainability-reviewer` | Materially adds or reshapes abstractions, raises cross-module coupling, adds state/control-flow complexity, changes naming or ownership structure, or performs a broad refactor. Dead-code removal alone does not select it. |
| `security` | `systematic:review:security-reviewer` | Auth middleware, public endpoints, user input handling, permission checks, secrets management |
| `performance` | `systematic:review:performance-reviewer` | Database queries, ORM calls, loop-heavy data transforms, caching layers, async/concurrent code |
| `api-contract` | `systematic:review:api-contract-reviewer` | Route definitions, serializer/interface changes, event schemas, exported type signatures, API versioning |
| `data-migrations` | `systematic:review:data-migrations-reviewer` | Migration files, schema changes, backfill scripts, data transformations |
| `reliability` | `systematic:review:reliability-reviewer` | Error handling, retry logic, circuit breakers, timeouts, background jobs, async handlers, health checks |
| `adversarial` | `systematic:review:adversarial-reviewer` | >=50 added or changed lines of executable production code (deleted lines do not count), excluding tests, generated files, lockfiles, instruction/prose Markdown, JSON schemas, and config; OR regardless of file type for auth, payments, data mutations, external APIs, or another explicitly high-risk domain |
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
2. **For each cross-cutting conditional persona**, read the diff and decide whether the persona's domain is relevant. This is a judgment call, not a keyword match. A deletion-only or docs-only change selects only the core three unless a semantic risk override fires (see Deletion-only and docs-only changes below); a structural refactor may add `maintainability`; an auth feature may add `security` and `reliability`.
3. **For each stack-specific conditional persona**, use file types and changed patterns as a starting point, then decide whether the diff actually introduces meaningful work for that reviewer. Do not spawn language-specific reviewers just because one config or generated file happens to match the extension.
4. **For CE conditional agents**, select `agent-native-reviewer` for agent-facing capability changes, `learnings-researcher` for bug/regression/hardening or recurring-defect work, and `deployment-verification-agent` for migrations or data backfills. Their output is unstructured; report their selection reason/surface in the team and Coverage rather than a dispatch record.
5. **Record selection metadata.** Every selected structured conditional persona records `selection_reason` and a non-empty `selection_surface`; core personas may omit both.
6. **Announce the team** before spawning with a one-line rationale and the triggering repository-relative paths/surfaces per selected conditional. Distinguish core reviewers, selected conditionals, an explicit "no conditional selected" case, and selected-but-failed/malformed/validation-unavailable reviewers. Never label an unselected reviewer as failed.
7. **Reviewer count is an outcome, not a target.** Never restore a fixed floor; a smaller selected set is not automatically better or worse than a larger one.

## Deletion-only and docs-only changes

Classify the change from the changed paths and the diff alone. Never classify from the PR title, body, comments or commit messages: a PR that calls itself "docs only" or "dead code cleanup" is classified by its paths. Read each path's status from the pinned manifest. The manifest shows no mode, symlink, submodule or binary change, so read that path's diff headers (`deleted file mode`, `new file mode`, `old mode` and `new mode`, `rename from`, `Binary files`, `Subproject commit`) whenever a manifest status of `M` or `T` could hide one.

- A change is deletion-only when every changed path has status D, with no mode, symlink, submodule or file-type change. Lines removed from a file that still exists make that path M, so that change is not deletion-only.
- A change is docs-only when every changed path is documentation prose that no agent or operator follows as an instruction. Skill and agent definitions, agent instruction files, workflow prompts and operational runbooks are behavior-bearing, so they are not docs-only. The test is whether an agent or operator would behave differently after the change.
- A deletion-only or docs-only change selects only the core three, however many files or lines it touches, unless a semantic risk override fires. Dead-code removal alone does not select `maintainability`, and deleted lines do not count toward the `adversarial` size threshold.
- Semantic risk overrides read the deleted lines as well as the added ones, and they apply to behavior-bearing docs on both sides of the diff. Removing an authorization check, permission check, guard or input validation selects `security`, and `adversarial` through its high-risk-domain trigger. Removing a retry, timeout or migration step selects `reliability` or `data-migrations`. Removing or changing a public interface selects `api-contract`. A change to agent instructions, skill text or operational docs that widen permissions, execution or trust selects `security`, plus `agent-native-reviewer` where agent or operator behavior changes. `learnings-researcher` and `agent-native-reviewer` fire for docs only through this behavior-bearing path.
- Do not shortcut ambiguous cases: binary-only, rename-only, generated-only, mode-only, symlink, submodule and file-type changes use normal selection, even when no line was added.
- `previous-comments` selection depends on PR comments only and is independent of this classification.

## Selection scenarios

| Scenario | Selected |
|----------|----------|
| Deletion-only change (every path has status D, no mode, symlink, submodule or file-type change), however many files or lines, with no semantic risk | `correctness`, `testing`, `project-standards` only; no runtime probe |
| Deletion-only change removing 80 lines of production code | `correctness`, `testing`, `project-standards` only; deleted lines do not count toward the `adversarial` size threshold |
| Docs-only change (every path is documentation prose that no agent or operator follows as an instruction) | `correctness`, `testing`, `project-standards` only; no runtime probe |
| Deletion-only change whose deleted lines remove a guard, authorization check, permission check or validation | core plus `security` and `adversarial` |
| Mixed change that removes a guard and adds code | Both sides are evaluated: core plus `security`, plus whatever the added code triggers |
| Docs change to an agent instruction file, skill definition or operational runbook | Normal selection; not docs-only |
| Skill text, agent instructions or operational docs that widen permissions, execution or trust | core plus `security` and CE `agent-native-reviewer` |
| Docs-only or deletion-only change on a PR with existing review comments | core plus `previous-comments` |
| Binary-only, rename-only or generated-only change | Normal selection |
| Mode-only, symlink, submodule or file-type change, with no line added | Normal selection |
| PR text such as "docs only" or "dead code cleanup" on a change that touches a code path | The change is classified by its paths, so normal selection applies |
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

Only the parent runs a probe, and only for a concrete finding. It names the exact command, the claim the command tests, and a named test file rather than a suite, and it records the result in Coverage. A named file whose runner expands to a suite is not a probe. Run at most one probe per finding, deduplicated across reviewers. A denied, unavailable, or inconclusive probe leaves the finding uncertain and is never reported as a pass. Never run a probe on a fork PR or a PR from an author without write access. Reviewers and CE agents report the claim and the command they would use and never run it; the full criteria are in the skill's Stage 3.
