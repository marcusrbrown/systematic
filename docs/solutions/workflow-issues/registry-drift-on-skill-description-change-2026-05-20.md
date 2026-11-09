---
title: Generated-artifact drift when bundled skill or agent content changes
date: 2026-05-20
last_updated: 2026-11-09
category: workflow-issues
module: registry
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - Editing a SKILL.md or agent frontmatter description field
  - Editing the body of a bundled skill or agent, or adding, removing, or renaming a file under a skill's references directory
  - Editing even a comment in a source file that a generated bundle imports
  - Adding a new generated surface
  - CI fails on a drift check after an otherwise clean build, or reports a bundle was generated from different sources
tags:
  - registry
  - drift
  - skill-description
  - generated-artifacts
  - pi-subagents
  - ci-gate
  - source-digest
  - new-surface
---

# Generated-artifact drift when bundled skill or agent content changes

## Context

`scripts/generate-registry.ts` reads each skill's frontmatter `description` into `registry/registry.jsonc`. The registry check (`bun run registry:drift`, which runs `bun scripts/generate-registry.ts --check`) compares the generated output against the committed file and fails if they differ. CI reaches it through its single `bun run surfaces:drift` step, which checks every generated surface and names each failure. `bun run build` does not include registry generation, so a description change that passes `build` + `typecheck` + `lint` + `test` locally will fail CI.

**Agent descriptions reach a second generated surface.** Personas listed in `CURATED_PERSONAS` (`src/lib/pi-subagents-personas.ts`) are also exported as committed Pi fixtures under `tests/fixtures/pi-subagents-personas/`, which embed the description verbatim. That surface has its own source-side drift gate, `bun run pi-personas:drift` (`bun scripts/generate-pi-subagents-personas.ts --check`), with a matching `bun run pi-personas:generate`. `registry:drift` does not cover it, so run on its own it is the easier of the two to miss — editing one agent description turned a four-file change into eight. `surfaces:drift` lists the two as separate surfaces and checks both. The same render also produces the personas the npm package ships under `dist/pi-subagents/agents/` at build time; the tarball tests in `tests/unit/package-exports.test.ts` verify them against the fixtures, so no separate command checks that copy.

### The trigger is any bundled-content edit, not only a description

Descriptions are the most common cause, not the only one. Two broader triggers reach the same generated surfaces:

**A body edit drifts the Pi fixtures.** The Pi export embeds the full persona text, not just its metadata, and its drift gate compares a SHA-256 hash of the generated content against the committed fixture (`scripts/generate-pi-subagents-personas.ts:106-109`). Any body change alters that hash, so editing an agent's body — with frontmatter untouched — leaves the fixture stale. A branch that added a research scope to one agent's body did exactly this while every targeted test passed; it surfaced only when the full unit suite ran.

**A new file under a skill's `references/` drifts the registry.** The generator calls `walkDir` on each skill directory (`scripts/generate-registry.ts:149`) and records the resulting per-component file list, so adding a reference file changes registry output even when no description moved. On the same branch this produced seven test failures plus a `registry:drift` failure, all from one added schema file.

Both are invisible to targeted tests by construction: the drift is between committed generated output and source, and a test that exercises the generator does not compare its output to what is checked in.

**A bundle's source digest covers comment bytes.** Two surfaces are bundles whose drift check validates provenance, not byte equality: `validator` (`skills/ce-review/scripts/validate-review.mjs`) and `connect-helper` (`skills/ce-connect/scripts/connect.mjs`). Each bundle's banner carries a `// source-digest:` line, and `--check` recomputes the digest and compares it with that stamp; it never rebuilds. `computeSourceDigest` (`scripts/generate-ce-connect-helper.ts:352-372`) hashes the full text of every source file the entry imports, directly or transitively, plus the generator itself and each external dependency's declared range and installed version. The validator's generator does the same (`scripts/generate-ce-review-validator.ts:339-359`).

Because the hash is over file text, editing only a comment, a doc comment or whitespace in any of those files changes the digest while changing no behavior. A branch generated the connect bundle, then reworded a comment in one of the modules it imports. Every targeted test still passed, since the helper behaved identically, and CI's single drift step failed with:

```text
skills/ce-connect/scripts/connect.mjs was generated from different sources (expected <12 hex>, found <12 hex>). Run `bun run ce-connect-helper:build` to update it.
```

The fix is to regenerate after the final source edit, not after the last edit that mattered. Late comment-only commits, such as wording fixes made while addressing review, are the usual trigger. `bun run surfaces:affected --run` maps the edited module to the surface through its `triggers` (`scripts/lib/generated-surfaces.ts:156-176` for `connect-helper`) and rewrites the bundle; `bun run surfaces:drift` then confirms it. Regenerating changes the bundle's bytes, so anything else that pins those bytes needs the same refresh. The cross-project connections evaluation does: its registration records a digest of the files a run executes, the bundle among them, and `tests/unit/connect-eval-fixture.test.ts:423-435` fails until the last `Frozen files digest` line in `tests/manual/connect-eval/PRE-REGISTRATION.md` matches the tree. Append a new line under the results heading with the new digest; never edit the registered one above it.

## Guidance

The generated surfaces are declared once, in `scripts/lib/generated-surfaces.ts`, and three commands read that list. After any edit to bundled content, before committing or opening a PR, run:

```bash
bun run surfaces:affected --run
bun run surfaces:drift
```

`affected --run` maps your uncommitted, staged, untracked and committed-since-`origin/main` changes to the surfaces they can make stale, regenerates just those (plus any downstream surface, in list order), then checks them. `drift` then checks all of them, the way CI does. Commit the regenerated files alongside the content change.

If `affected` cannot resolve `origin/main`, for example in a shallow clone, run `bun run surfaces:regen` and then `drift`. The full local gate that matches CI is `bun run build && bun run typecheck && bun run lint && bun test tests/unit && bun run surfaces:drift`.

An **agent** change of any kind — description or body — and any change to a skill's file set reaches both the registry and the Pi fixtures, so both are regenerated and checked by the sequence above without naming them. The individual scripts (`registry:generate`, `registry:drift`, `pi-personas:generate`, `pi-personas:drift`) stay callable when you want one surface alone.

When delegating skill or agent edits to subagents, put `bun run surfaces:affected --run` and `bun run surfaces:drift` in the verification checklist explicitly — the standard `build` + `typecheck` + `lint` + `test` gate does not cover either surface.

### A passing drift check is not proof that nothing else moved

`registry:drift` proves the committed output is **fresh** relative to source. It does not prove that no identifier changed — a rename regenerates cleanly and passes just the same. For a description-only edit, inspect the regenerated diff and confirm the stronger invariant: only `description` values changed, no component `name`, `files`, or dependency entries changed, and no Pi fixture filename changed.

A changed fixture filename signals an identity or sanitization change rather than ordinary description drift. That distinction matters because bundled agents reach five separate identifier namespaces with no shared alias layer, so an accidental rename is a cross-harness migration rather than a metadata edit.

### Adding a new generated surface

A new generated output belongs in the one list, and several gates fail until it is registered everywhere they look. Each item names the test that fails without it, or says that no gate checks it.

1. **Add the entry** to `GENERATED_SURFACES` (`scripts/lib/generated-surfaces.ts:53-207`) with `name`, `regenScript`, `checkScript`, `outputs` and `triggers`. Both scripts must exist in `package.json` (`tests/unit/generated-surfaces.test.ts:97-110`). Put the entry after every surface whose outputs match one of its triggers: regeneration runs in list order, and the same file asserts that every derived dependency edge points forward (`tests/unit/generated-surfaces.test.ts:346-365`).
2. **Keep every glob live.** Each `triggers` and `outputs` entry must match at least one real file, or the dead-glob tests fail (`tests/unit/generated-surfaces.test.ts:163-186`). Paths are brace-free, and only the two glob-valued outputs are allowed to keep a `*` (`tests/unit/generated-surfaces.test.ts:112-125`), so a third glob output needs that assertion revisited.
3. **Update the pinned list and count.** The same test file pins the exact surface names in order (`tests/unit/generated-surfaces.test.ts:84-95`) and the number of generators that have a check mode (`tests/unit/generated-surfaces.test.ts:269-274`). That second test scans `scripts/` and `docs/scripts/` for check-mode generators and requires each to be some surface's check script, and each surface's check script to be such a generator.
4. **Add the output to the autoheal never-hand-edit list** in `.github/workflows/fro-bot.yaml` (the `Never manually edit generated artifacts` bullet, `.github/workflows/fro-bot.yaml:625-644`). `tests/unit/generated-surfaces-wiring.test.ts:343-345` fails and names each uncovered `<surface>: <output>` pair.
5. **Do not add a per-surface CI step.** CI, `postupgrade` and the autoheal prompt all call `surfaces:regen` or `surfaces:drift`, which read the list. The wiring tests report a workflow that calls a surface's check script directly (`tests/unit/generated-surfaces-wiring.test.ts:149-156`).
6. **Update the prose count.** `AGENTS.md` (the "Generated surfaces" paragraph: "Eight committed files", "checks all eight") and `STRUCTURE.md` (the entry for `scripts/lib/generated-surfaces.ts`) state how many surfaces exist. No gate checks that prose, so search for the old number.
7. **Register a new `src/lib/` source module** if the generator's entry pulls one in: an `ARCHITECTURE.md` codemap entry and a `src/lib/AGENTS.md` module-table row. `bun scripts/content-integrity.ts` enforces both.
8. **Prove a runnable bundle runs where it ships.** If the output is a script a skill executes, add a packaging test that runs it under real Node from each distributed shape. `tests/unit/ce-connect-helper-packaging.test.ts` is the pattern (it locates the bundle through `HELPER_REL` at `tests/unit/ce-connect-helper-packaging.test.ts:33`): its header says it runs the bundle from the OCX-selected skill tree, from a real `npm pack` archive and from the generated Claude Code plugin bundle. If the bundler inlines a dependency, check it executes with no `node_modules` beside it ([entry-point scope](../best-practices/entry-point-scope-decides-what-a-plugin-can-ship-2026-08-24.md) covers the UMD case).
9. **Regenerate and check:** `bun run surfaces:regen`, then `bun run surfaces:drift`, and commit the output with the generator.

## Why This Matters

The registry is the source of truth for OCX component installation. A stale description means users installing via `npx ocx add frontend-design` get outdated metadata. The CI gate catches this, but discovering the failure only in CI wastes a push cycle.

## When to Apply

- Any edit to `skills/*/SKILL.md` frontmatter `description` field
- Any edit to `agents/*/*.md` frontmatter `description` field
- After adding or removing a skill or agent
- After any edit, comments included, to a file a generated bundle imports
- When adding a generated output of any kind

## Examples

**Failure scenario:**

1. Update `skills/frontend-design/SKILL.md` description to mention OKLCH and absolute bans
2. Run `bun run build && bun run typecheck && bun run lint && bun test` — all pass
3. Push to PR — CI's `surfaces:drift` step fails and names the registry surface

**Correct sequence:**

1. Update `skills/frontend-design/SKILL.md` description
2. Run `bun run surfaces:affected --run` — regenerates `registry/registry.jsonc` with the new description, then checks it
3. Commit both files together
4. Run `bun run surfaces:drift`, then push — CI passes

## Related

- `scripts/generate-ce-connect-helper.ts` and `scripts/generate-ce-review-validator.ts` — the two bundle generators whose drift check compares a source digest
- `scripts/generate-registry.ts` — the generator script
- `scripts/lib/generated-surfaces.ts` — the list of generated surfaces behind `surfaces:affected`, `surfaces:regen` and `surfaces:drift`
- `registry/registry.jsonc` — the generated output
- PR #418 — where this gap was caught
- [`docs/solutions/best-practices/vendor-npm-packaged-skill-as-generated-artifact-2026-07-28.md`](../best-practices/vendor-npm-packaged-skill-as-generated-artifact-2026-07-28.md) — the same generate-and-drift discipline applied to an npm-packaged vendored skill, with a second drift signal on the attribution version
