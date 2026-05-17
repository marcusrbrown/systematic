---
title: 'Build-time codegen for typed config validation: three traps to avoid'
date: 2026-05-16
category: best-practices
module: scripts/generate-config-schema.ts + src/lib/config-schema.ts
problem_type: best_practice
component: tooling
severity: high
related_components:
  - tooling
applies_when:
  - adding strict schema validation to a previously permissive runtime
  - generating schema or allow-lists from filesystem-scanned source
  - emitting committed code that other build steps import immediately
  - designing drift checks across multiple generated artifacts
  - exposing alias or qualified-ID surfaces in config validation
tags:
  - config-validation
  - codegen
  - esm-cache
  - drift-check
  - schema-generation
  - alias-resolution
  - tooling
---

# Build-time codegen for typed config validation: three traps to avoid

## Context

This guidance came out of the typed-config-validation arc in PR #384 / v2.15.0, when the `agents`, `disabled_agents`, and `disabled_skills` config surfaces moved from permissive `z.record(z.string(), ...)` shapes to strict literal-keyed `z.object({...}).strict()` shapes backed by build-time codegen.

The migration looked simple — walk `agents/` and `skills/` at codegen time, emit a `BUNDLED_AGENT_NAMES` const, and consume it in the Zod schema. In practice three subtle traps surfaced during `ce:review` and pre-merge verification:

- runtime behavior already accepted more than the docs implied (qualified `<category>/<name>` IDs alongside bare names)
- generator code read its own output through a static ESM import (first-run JSON Schema reflected stale `BUNDLED_AGENT_NAMES`)
- the drift gate's `--check` callback and the `main()` write path called the producer function with different option shapes, so drift detection misfired immediately after a fresh regeneration

That combination produced a nasty failure mode: configs that worked in v2.14.x became invalid under the new schema, the first run of the generator after an agents/ change shipped a stale published schema, and the safety check that should have caught both failed for the wrong reason.

## Guidance

Before migrating permissive config to strict validation, three rules need to hold simultaneously.

### 1. Audit the runtime's full input surface, not just the documented happy path

Don't trust what the docs claim the runtime accepts. Grep the runtime for alias maps, prefix matching, normalization helpers, fallback lookups, and any other input-acceptance path. Every form the runtime currently accepts must either appear in the strict allow-set or be explicitly deprecated with a migration story in the release notes.

In this case the runtime's `buildBundledAgentInventory` quietly populated `aliases[entry.id]` (qualified `<category>/<name>`) AND `aliases[entry.key]` (bare name). `validateExactAgentOverlays` resolved through `inventory.aliases[key]`, so both forms worked. Documented examples used both. The initial strict schema only included bare names — qualified-overlay configs became invalid silently.

### 2. Treat generator self-reads as cache-sensitive

If a generator writes a file and then imports code that depends on that file, static ESM imports stay stale. ESM module caches are keyed by resolved URL, not by file mtime. Rewriting `src/lib/bundled-names.ts` to disk does not invalidate the module the schema was imported from.

Two paths through:

- Use a cache-busted dynamic import after writing: `await import('../src/lib/config-schema.js?cache=' + Date.now())`. The query string forces a fresh module fetch.
- Better long-term: refactor the consumer to accept fresh inputs as parameters via a factory like `createSystematicConfigSchema({ agentNames, skillNames })`. The static export stays for runtime; the generator passes fresh discovery results.

### 3. Keep `--check` and write paths byte-identical

A drift gate works by computing "expected" content fresh from sources, reading the on-disk file, and comparing. For this to be sound, both call sites — the `--check` `produce()` callback and the `main()` write path — must call the producer with identical option shapes and defaults. Any divergence in inputs, defaults, sort order, or formatting and drift detection silently misfires.

Best long-term shape: factor the shared option-derivation into a single helper that both paths call. The asymmetry that bit this PR was possible because each call site assembled the option object independently.

## Why This Matters

The meta-principle is straightforward: **moving from permissive to strict validation freezes runtime behavior into a contract.** If the contract misses any of the three surfaces below, it lies.

| Surface | Failure shape |
|---|---|
| Hidden runtime flexibility | Schema rejects inputs the runtime would have accepted; users hit parse errors with no migration guidance. |
| Generator read-after-write ordering | First-run output is stale; CI drift gate catches it but only after the artifact ships. |
| Drift-gate call-site parity | `--check` reports drift right after a clean regenerate; humans waste time chasing a phantom. |

The damage is asymmetric. The runtime surface miss breaks users in production. The codegen ordering trap ships stale artifacts. The drift-gate asymmetry erodes trust in the safety check. Each trap is independently fixable but, taken together, the three define a small playbook for strict-validation migrations.

## When to Apply

This applies whenever you are:

- migrating `z.record(...)`, permissive object schemas, or ad-hoc validation to strict `z.object(...).strict()`
- generating code or schemas from files that the generator itself writes
- adding `--check` / drift detection for generated assets
- changing any config surface that has aliases, normalization, qualified IDs, or backward-compatible shims

Especially dangerous cases:

- runtime accepts multiple identifiers for the same entity
- generator reads the file it just wrote
- check path assembles options independently from write path

## Examples

### Trap 1 — Strict schema must include every accepted identifier

Before, the strict schema only knew bare names:

```typescript
// src/lib/config-schema.ts (before — rejects qualified IDs)
agents: z.object({
  oracle: AgentOverlaySchema.optional(),
  'correctness-reviewer': AgentOverlaySchema.optional(),
  // ... 49 more bare names
}).strict().default({})
```

But the runtime alias resolver in `buildBundledAgentInventory` accepted both:

```typescript
// inferred from runtime
aliases[entry.id] = entry   // 'review/correctness-reviewer'
aliases[entry.key] = entry  // 'correctness-reviewer'
validateExactAgentOverlays(key) {
  return inventory.aliases[key]  // either works
}
```

After the fix the generator emits both sets and the schema consumes both:

```typescript
// src/lib/bundled-names.ts (generated)
export const BUNDLED_AGENT_NAMES = ['oracle', 'correctness-reviewer', /* ... */] as const
export const BUNDLED_AGENT_QUALIFIED_IDS = [
  'review/correctness-reviewer',
  'workflow/systematic-implementer',
  // ... 50 more
] as const

// src/lib/config-schema.ts
agents: z
  .object(
    Object.fromEntries(
      [...BUNDLED_AGENT_NAMES, ...BUNDLED_AGENT_QUALIFIED_IDS].map(
        (name) => [name, AgentOverlaySchema.optional()],
      ),
    ) as Record<
      | (typeof BUNDLED_AGENT_NAMES)[number]
      | (typeof BUNDLED_AGENT_QUALIFIED_IDS)[number],
      z.ZodOptional<typeof AgentOverlaySchema>
    >,
  )
  .strict()
  .default({}),

disabled_agents: z
  .array(z.enum([...BUNDLED_AGENT_NAMES, ...BUNDLED_AGENT_QUALIFIED_IDS] as const))
  .default([]),
```

### Trap 2 — Cache-bust the generator's schema import

Bad shape — the static import resolves `BUNDLED_AGENT_NAMES` once at module load, and `writeBundledNamesFile` does not invalidate the cache:

```typescript
// scripts/generate-config-schema.ts (before)
import { SystematicConfigSchema } from '../src/lib/config-schema.js'

async function main(): Promise<void> {
  const { agents, skills, agentQualifiedIds } = discoverBundledNames(PROJECT_ROOT)
  const previous = readCommittedBundledNamesCounts(PROJECT_ROOT)
  const bundledContent = generateBundledNamesContent(agents, skills, {
    ...previous,
    agentQualifiedIds,
  })
  writeBundledNamesFile(bundledContent, PROJECT_ROOT)

  // BUG: schema still references the pre-write BUNDLED_AGENT_NAMES
  const schemaContent = generateSchemaContent(version, SystematicConfigSchema)
  generateAndWrite(schemaContent, version, PROJECT_ROOT)
}
```

Safer shape — write first, then force a fresh module read via cache-busting query parameter:

```typescript
// scripts/generate-config-schema.ts (after)
async function main(): Promise<void> {
  const { agents, skills, agentQualifiedIds } = discoverBundledNames(PROJECT_ROOT)
  const previous = readCommittedBundledNamesCounts(PROJECT_ROOT)
  const bundledContent = generateBundledNamesContent(agents, skills, {
    ...previous,
    allowShrink,
    agentQualifiedIds,
  })
  writeBundledNamesFile(bundledContent, PROJECT_ROOT)

  // ESM module caches are keyed by URL; appending ?cache=<timestamp> forces a
  // fresh import that re-reads bundled-names.ts.
  const schemaModuleUrl = `../src/lib/config-schema.js?cache=${Date.now()}`
  const schemaModule = await import(schemaModuleUrl)
  const freshSchema = schemaModule.SystematicConfigSchema

  const schemaContent = generateSchemaContent(version, freshSchema)
  generateAndWrite(schemaContent, version, PROJECT_ROOT)
}
```

### Trap 3 — Make drift checks call the producer the same way as writes

Bad shape — the `--check` callback dropped `agentQualifiedIds`:

```typescript
// scripts/generate-config-schema.ts (before, line ~668)
{
  produce: (rootDir) => {
    const { agents, skills } = discoverBundledNames(rootDir)
    const previous = readCommittedBundledNamesCounts(rootDir)
    return generateBundledNamesContent(agents, skills, previous)
    // ↑ agentQualifiedIds defaulted to []; write path included all 50
  },
  pathOnDisk: path.join(rootDir, BUNDLED_NAMES_RELATIVE_PATH),
  displayName: BUNDLED_NAMES_RELATIVE_PATH,
}
```

Corrected shape — both call sites pass identical options:

```typescript
// scripts/generate-config-schema.ts (after)
{
  produce: (rootDir) => {
    const { agents, skills, agentQualifiedIds } = discoverBundledNames(rootDir)
    const previous = readCommittedBundledNamesCounts(rootDir)
    return generateBundledNamesContent(agents, skills, {
      ...previous,
      agentQualifiedIds,
    })
  },
  // ...
}
```

Regression test asserts byte-identical output from both paths:

```typescript
test('--check path and write path produce byte-identical bundled-names content', () => {
  const { agents, skills, agentQualifiedIds } = discoverBundledNames(PROJECT_ROOT)
  const previous = readCommittedBundledNamesCounts(PROJECT_ROOT)
  const checkContent = generateBundledNamesContent(agents, skills, {
    ...previous,
    agentQualifiedIds,
  })
  const onDisk = fs.readFileSync(
    path.join(PROJECT_ROOT, 'src/lib/bundled-names.ts'),
    'utf-8',
  )
  expect(checkContent).toBe(onDisk)
})
```

This shape is integration-flavored — it runs against the live filesystem and assumes `src/lib/bundled-names.ts` was freshly regenerated before the test runs. A pure-unit variant would seed an in-memory or temp-dir set of agents and skills and assert two parallel producer calls return identical strings without touching the committed file. Pick whichever fits the suite's existing style; the parity property is the same either way.

## Related

- [OpenCode /config HttpApi rejects ad-hoc bundled agent color names](../integration-issues/opencode-config-schema-rejects-ad-hoc-agent-colors-2026-05-09.md) — strict-schema migration on the downstream consumer side. Same "inventory the runtime-emitted surface before tightening" lesson, mirrored upstream.
- [Trust-sensitive overlay fields in plugin configuration](./layered-trust-boundaries-overlay-config-2026-05-09.md) — companion guidance for `SECURITY_OVERLAY_FIELDS` allowlisting. Typed validation preserves the trust boundary by rejecting typos at parse time before the overlay-application phase.
- [Plugin provider availability discovery and source-default resolution](./provider-availability-source-defaults-2026-05-12.md) — generator-owned dual outputs pattern. Useful precedent for runtime discovery driving generated artifacts.
- [Code Review Fixes for OCX Registry Support](../code-quality/ocx-registry-review-fixes.md) — earlier codegen + drift-gate work. The current doc formalizes the parity rule that registry codegen implicitly relied on.
- PR #384 — implementation reference for all three lessons.
- Follow-up issues: #385 (verbose enum suppression for `disabled_*` typos), #386 (multi-key extraction in unrecognized-key hints).
