---
title: Registry drift when SKILL.md description changes
date: 2026-05-20
category: workflow-issues
module: registry
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - Editing a SKILL.md description field
  - Running the build without also running registry generation
  - CI fails on "Registry drift check" after an otherwise clean build
tags:
  - registry
  - drift
  - skill-description
  - generate-registry
  - ci-gate
---

# Registry drift when SKILL.md description changes

## Context

`scripts/generate-registry.ts` reads each skill's frontmatter `description` into `registry/registry.jsonc`. The CI "Registry drift check" step (`bun scripts/generate-registry.ts --check`) compares the generated output against the committed file and fails if they differ. `bun run build` does not include registry generation, so a SKILL.md description change that passes `build` + `typecheck` + `lint` + `test` locally will fail CI.

## Guidance

After any SKILL.md frontmatter change, run:

```bash
bun scripts/generate-registry.ts
```

Then commit the updated `registry/registry.jsonc` alongside the skill change. The full local gate sequence that matches CI is:

```bash
bun run build && bun run typecheck && bun run lint && bun test tests/unit && bun scripts/generate-registry.ts --check
```

When delegating skill edits to subagents, include `bun scripts/generate-registry.ts` in the verification checklist explicitly — the standard `build` + `typecheck` + `lint` + `test` gate does not cover it.

## Why This Matters

The registry is the source of truth for OCX component installation. A stale description means users installing via `npx ocx add frontend-design` get outdated metadata. The CI gate catches this, but discovering the failure only in CI wastes a push cycle.

## When to Apply

- Any edit to `skills/*/SKILL.md` frontmatter `description` field
- Any edit to `agents/*/*.md` frontmatter `description` field
- After running `bun scripts/generate-registry.ts` for other reasons (adding/removing skills or agents)

## Examples

**Failure scenario:**

1. Update `skills/frontend-design/SKILL.md` description to mention OKLCH and absolute bans
2. Run `bun run build && bun run typecheck && bun run lint && bun test` — all pass
3. Push to PR — CI "Registry drift check" fails

**Correct sequence:**

1. Update `skills/frontend-design/SKILL.md` description
2. Run `bun scripts/generate-registry.ts` — updates `registry/registry.jsonc` with the new description
3. Commit both files together
4. Push — CI passes

## Related

- `scripts/generate-registry.ts` — the generator script
- `registry/registry.jsonc` — the generated output
- PR #418 — where this gap was caught
