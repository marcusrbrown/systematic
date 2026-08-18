---
title: Generated-artifact drift when bundled skill or agent content changes
date: 2026-05-20
last_updated: 2026-08-18
category: workflow-issues
module: registry
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - Editing a SKILL.md description field
  - Editing an agent frontmatter description field
  - Editing the body of a bundled skill or agent, not only its frontmatter
  - Adding, removing, or renaming a file under a skill's references directory
  - Running the build without also running registry or Pi fixture generation
  - CI fails on a drift check after an otherwise clean build
tags:
  - registry
  - drift
  - skill-description
  - agent-description
  - skill-body
  - generated-artifacts
  - generate-registry
  - pi-subagents
  - ci-gate
---

# Generated-artifact drift when bundled skill or agent content changes

## Context

`scripts/generate-registry.ts` reads each skill's frontmatter `description` into `registry/registry.jsonc`. The CI "Registry drift check" step (`bun scripts/generate-registry.ts --check`) compares the generated output against the committed file and fails if they differ. `bun run build` does not include registry generation, so a description change that passes `build` + `typecheck` + `lint` + `test` locally will fail CI.

**Agent descriptions reach a second generated surface.** Personas listed in `CURATED_PERSONAS` (`src/lib/pi-subagents-personas.ts`) are also exported as committed Pi fixtures under `tests/fixtures/pi-subagents-personas/`, which embed the description verbatim. That surface has its own source-side drift gate, run as `bun scripts/generate-pi-subagents-personas.ts --check`. It is not covered by `registry:drift` and has no npm script alias, so it is the easier of the two to miss — editing one agent description turned a four-file change into eight.

### The trigger is any bundled-content edit, not only a description

Descriptions are the most common cause, not the only one. Two broader triggers reach the same generated surfaces:

**A body edit drifts the Pi fixtures.** The Pi export embeds the full persona text, not just its metadata, and its drift gate compares a SHA-256 hash of the generated content against the committed fixture (`scripts/generate-pi-subagents-personas.ts:103-105`). Any body change alters that hash, so editing an agent's body — with frontmatter untouched — leaves the fixture stale. A branch that added a research scope to one agent's body did exactly this while every targeted test passed; it surfaced only when the full unit suite ran.

**A new file under a skill's `references/` drifts the registry.** The generator calls `walkDir` on each skill directory (`scripts/generate-registry.ts:149`) and records the resulting per-component file list, so adding a reference file changes registry output even when no description moved. On the same branch this produced seven test failures plus a `registry:drift` failure, all from one added schema file.

Both are invisible to targeted tests by construction: the drift is between committed generated output and source, and a test that exercises the generator does not compare its output to what is checked in.

## Guidance

After any SKILL.md frontmatter change, run:

```bash
bun scripts/generate-registry.ts
```

Then commit the updated `registry/registry.jsonc` alongside the skill change. The full local gate sequence that matches CI is:

```bash
bun run build && bun run typecheck && bun run lint && bun test tests/unit && bun scripts/generate-registry.ts --check
```

For an **agent** change of any kind — description or body — and for any change to a skill's file set, regenerate and check both surfaces:

```bash
bun scripts/generate-registry.ts
bun scripts/generate-pi-subagents-personas.ts

bun run registry:drift
bun scripts/generate-pi-subagents-personas.ts --check
```

When delegating skill or agent edits to subagents, include the generator commands in the verification checklist explicitly — the standard `build` + `typecheck` + `lint` + `test` gate does not cover either surface.

### A passing drift check is not proof that nothing else moved

`registry:drift` proves the committed output is **fresh** relative to source. It does not prove that no identifier changed — a rename regenerates cleanly and passes just the same. For a description-only edit, inspect the regenerated diff and confirm the stronger invariant: only `description` values changed, no component `name`, `files`, or dependency entries changed, and no Pi fixture filename changed.

A changed fixture filename signals an identity or sanitization change rather than ordinary description drift. That distinction matters because bundled agents reach five separate identifier namespaces with no shared alias layer, so an accidental rename is a cross-harness migration rather than a metadata edit.

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
- [`docs/solutions/best-practices/vendor-npm-packaged-skill-as-generated-artifact-2026-07-28.md`](../best-practices/vendor-npm-packaged-skill-as-generated-artifact-2026-07-28.md) — the same generate-and-drift discipline applied to an npm-packaged vendored skill, with a second drift signal on the attribution version
