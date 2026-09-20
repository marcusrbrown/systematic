---
title: Share a constant across a dependency-forbidden boundary with a guarded import-free module
date: 2026-09-20
category: best-practices
module: config-system
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - A constant must be read by a module that cannot take on the producer's dependencies
  - You are about to hand-copy a list, allowlist, or field registry into a second file
  - Adding a top-level field to a config schema with several registration surfaces
  - Writing a guard whose justification names a downstream failure
symptoms:
  - "A stale copy of a shared list breaks a build step unrelated to where it was edited"
  - "A new config field appears in the generated JSON Schema but has no heading in the generated reference"
related_components:
  - tooling
  - documentation
tags: [config, duplication, drift, dependency, guard, codegen, registration]
---

# Share a constant across a dependency-forbidden boundary with a guarded import-free module

## Context

`src/lib/capability-snapshot.ts` validates config-observation data against an
allowlist of protected field paths and throws on an unknown key. It is deliberately
import-free, because `src/lib/config.ts` — the natural home for that list — imports
`jsonc-parser`, and pulling that dependency graph into the snapshot would compromise
its purity as a read-only serializer.

The list was therefore hand-copied into both files. When
`allow_project_profiles` was added and only one copy was updated, the failure
surfaced in `bun run build`'s `tsc --emitDeclarationOnly` step and in
`tests/unit/package-exports.test.ts` — not in the config tests anyone would be
running while editing config code. An earlier drift in the same pair had already
caused `systematic capabilities` to print `Capabilities diagnostic unavailable` with
no stated cause.

The same change also had to touch `TOP_LEVEL_KEYS` in
`docs/scripts/generate-config-reference.ts`, a hardcoded display-order array the
reference generator renders sections from. Omitting it produces a field that exists
in the generated JSON Schema but has no heading in the generated reference — output
that looks complete.

## Guidance

**Extract a dependency-free module and have both sides import it.** The list now
lives in `src/lib/config-protected-fields.ts`, which imports nothing.
`src/lib/config.ts` imports and re-exports it so existing consumers are unaffected;
`src/lib/capability-snapshot.ts` gains its one and only import
(`src/lib/capability-snapshot.ts:6`). The two copies cannot disagree because there
is one copy.

**Prefer removing the duplication to testing that duplicates agree.** A parity test
detects drift after it exists and depends on someone reading its failure correctly.
Extraction removes the state that can drift.

**Guard the property the module exists for.** The module is only useful while it
stays import-free, and nothing about TypeScript enforces that. A test reads the
source from disk and fails on any `import ... from`, bare `import`, dynamic
`import(`, or `require(`. It strips comments first, because the module's own doc
comment discusses imports in prose.

Reading runtime exports would not work here: an added-but-unused import changes the
dependency graph without changing what the module exports.

**Do not justify a guard with a failure that cannot happen.** The guard's first
version claimed a violation would crash the bundled Claude Code validator at runtime.
It would not — that entry's closure (`src/ce-review-validator.ts`) never reaches
`capability-snapshot.ts`, and `src/cli.ts`, its only importer, already imports
`./lib/config.js` directly. The real reason is narrower and true: the snapshot is a
pure serializer, and an import in the module it consumes transitively gives it a
dependency graph it is asserted not to have.

A stated reason that is specific and checkable invites a reader to check it. If it is
false, the most reasonable conclusion available to that reader is that the guard is
obsolete.

## Why This Matters

Duplication of this particular list is not cosmetic. One copy governs what gets
stripped from project config — a trust boundary — and the other governs what gets
reported about it. Drift lets the code enforce one story and report another.

The registration surfaces compound it. Adding one top-level config field touched the
Zod schema, four separate registrations inside `config.ts`, the duplicated snapshot
list, and a hardcoded array in a docs generator. Two of those failed in places with
no obvious connection to the edit. The cost is not the edits; it is that a missed one
fails somewhere you are not looking.

## When to Apply

Extract a dependency-free module when:

- Two or more modules need the same constant.
- At least one of them cannot take the other's dependencies.
- The constant is semantically load-bearing — an allowlist, a protected-field
  registry, a capability catalog — rather than incidental.

Guard the dependency-freeness when the module exists *because* of that property.
Assert it by reading the source, not by inspecting runtime exports.

## Examples

Before — two copies, one boundary:

```ts
// src/lib/config.ts
export const CONFIG_PROTECTED_FIELD_PATHS = [...] as const

// src/lib/capability-snapshot.ts  (no imports, by design)
const CONFIG_PROTECTED_FIELD_PATHS = [...] as const   // hand-maintained twin
```

After — one definition, both sides importing:

```ts
// src/lib/config-protected-fields.ts  — imports nothing
export const CONFIG_PROTECTED_FIELD_PATHS = [...] as const

// src/lib/capability-snapshot.ts:6
import { CONFIG_PROTECTED_FIELD_PATHS } from './config-protected-fields.js'
```

The guard, in `tests/unit/capability-snapshot.test.ts`:

```ts
const source = readFileSync(
  new URL('../../src/lib/config-protected-fields.ts', import.meta.url),
  'utf8',
)
// strip comments first — the module's doc comment discusses "import" in prose
const withoutComments = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')
// then assert against static, bare, dynamic import and require
```

Verified by adding an import and observing the failure, then restoring and
confirming the restore was byte-identical.

## Related

- [`typed-config-validation-build-time-codegen-2026-05-16.md`](./typed-config-validation-build-time-codegen-2026-05-16.md)
  — generated config validation and drift checks. This doc covers the adjacent case
  where the shared value cannot be generated because one consumer must stay
  dependency-free.
- [`../workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md`](../workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md)
  — another instance of one edit needing to reach a generated surface elsewhere.
