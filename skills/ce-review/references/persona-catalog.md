# Persona Catalog

13 reviewer personas organized into always-on, cross-cutting conditional, and stack-specific conditional layers, plus CE-specific agents. The orchestrator uses this catalog to select which reviewers to spawn for each review.

## Shared persona pool

The `agents/review/` directory is a shared persona pool, not `ce:review`'s roster. Directory placement does not imply that a persona is selectable by `ce:review`. These shared personas are dispatched by other workflows and intentionally do not appear in this catalog's `ce:review` selection tables:

- `systematic:review:architecture-strategist` — dispatched by `deepen-plan` and `ce-plan`'s deepening workflow for architectural analysis.
- `systematic:review:pattern-recognition-specialist` — dispatched by `deepen-plan`, `ce-plan`'s deepening workflow, and `ce-compound` for consistency, duplication, and pattern analysis.
- `systematic:review:code-simplicity-reviewer` — dispatched by `ce-compound` for code-heavy issues.

## Always-on (4 personas + 2 CE agents)

Spawned on every review regardless of diff content.

**Persona agents (structured JSON output):**

| Persona | Agent | Focus |
|---------|-------|-------|
| `correctness` | `systematic:review:correctness-reviewer` | Logic errors, edge cases, state bugs, error propagation, intent compliance |
| `testing` | `systematic:review:testing-reviewer` | Coverage gaps, weak assertions, brittle tests, missing edge case tests |
| `maintainability` | `systematic:review:maintainability-reviewer` | Coupling, complexity, naming, dead code, premature abstraction |
| `project-standards` | `systematic:review:project-standards-reviewer` | AGENTS.md compliance -- frontmatter, references, naming, cross-platform portability, tool selection |

**CE agents (unstructured output, synthesized separately):**

| Agent | Focus |
|-------|-------|
| `systematic:review:agent-native-reviewer` | Verify new features are agent-accessible |
| `systematic:research:learnings-researcher` | Search docs/solutions/ for past issues related to this PR's modules and patterns |

## Conditional (8 personas)

Spawned when the orchestrator identifies relevant patterns in the diff. The orchestrator reads the full diff and reasons about selection -- this is agent judgment, not keyword matching.

| Persona | Agent | Select when diff touches... |
|---------|-------|---------------------------|
| `security` | `systematic:review:security-reviewer` | Auth middleware, public endpoints, user input handling, permission checks, secrets management |
| `performance` | `systematic:review:performance-reviewer` | Database queries, ORM calls, loop-heavy data transforms, caching layers, async/concurrent code |
| `api-contract` | `systematic:review:api-contract-reviewer` | Route definitions, serializer/interface changes, event schemas, exported type signatures, API versioning |
| `data-migrations` | `systematic:review:data-migrations-reviewer` | Migration files, schema changes, backfill scripts, data transformations |
| `reliability` | `systematic:review:reliability-reviewer` | Error handling, retry logic, circuit breakers, timeouts, background jobs, async handlers, health checks |
| `adversarial` | `systematic:review:adversarial-reviewer` | Diff has >=50 changed lines of executable code (not prose/instruction Markdown, JSON schemas, or config), OR touches auth, payments, data mutations, external API integrations, or other high-risk domains regardless of file type |
| `cli-readiness` | `systematic:review:cli-readiness-reviewer` | CLI command definitions, argument parsing, CLI framework usage, command handler implementations |
| `previous-comments` | `systematic:review:previous-comments-reviewer` | **PR-only.** Reviewing a PR that has existing review comments or review threads from prior review rounds. Skip entirely when no PR metadata was gathered in Stage 1. |

## Stack-Specific Conditional (1 persona)

These reviewers keep their original opinionated lens. They are additive with the cross-cutting personas above, not replacements for them.

| Persona | Agent | Select when diff touches... |
|---------|-------|---------------------------|
| `kieran-typescript` | `systematic:review:kieran-typescript-reviewer` | TypeScript components, services, hooks, utilities, or shared types |

## CE Conditional Agents (migration-specific)

These CE-native agents provide specialized analysis beyond what the persona agents cover. Spawn them when the diff includes database migrations, schema.rb, or data backfills.

| Agent | Focus |
|-------|-------|
| `systematic:review:deployment-verification-agent` | Produces Go/No-Go deployment checklist with SQL verification queries and rollback procedures |

## Selection rules

1. **Always spawn all 4 always-on personas** plus the 2 CE always-on agents.
2. **For each cross-cutting conditional persona**, the orchestrator reads the diff and decides whether the persona's domain is relevant. This is a judgment call, not a keyword match.
3. **For each stack-specific conditional persona**, use file types and changed patterns as a starting point, then decide whether the diff actually introduces meaningful work for that reviewer. Do not spawn language-specific reviewers just because one config or generated file happens to match the extension.
4. **For CE conditional agents**, spawn when the diff includes migration files (`db/migrate/*.rb`, `db/schema.rb`) or data backfill scripts.
5. **Announce the team** before spawning with a one-line justification per conditional reviewer selected.
