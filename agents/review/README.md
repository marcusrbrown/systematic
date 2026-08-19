# Shared Review Persona Pool

`agents/review/` is a shared persona pool, not a single workflow roster.
Workflow-specific rosters live in the relevant skill catalogs.

These agents are not dispatched by `ce:review`:

- `systematic:review:architecture-strategist` — dispatched by `deepen-plan` and the `ce-plan` deepening workflow.
- `systematic:review:pattern-recognition-specialist` — dispatched by `deepen-plan`, the `ce-plan` deepening workflow, and `ce-compound`.
- `systematic:review:code-simplicity-reviewer` — dispatched by `ce-compound`.
