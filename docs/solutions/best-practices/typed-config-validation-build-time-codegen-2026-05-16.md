---
title: 'Build-time codegen for typed config validation: four traps to avoid'
date: 2026-05-16
last_updated: 2026-05-17
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
  - parsing or introspecting formatter-controlled auto-generated code
tags:
  - config-validation
  - codegen
  - esm-cache
  - drift-check
  - schema-generation
  - alias-resolution
  - tooling
  - formatter-introspection
  - latent-bugs
---

# Build-time codegen for typed config validation: four traps to avoid

## Context

This guidance came out of the typed-config-validation arc in PR #384 / v2.15.0, when the `agents`, `disabled_agents`, and `disabled_skills` config surfaces moved from permissive `z.record(z.string(), ...)` shapes to strict literal-keyed `z.object({...}).strict()` shapes backed by build-time codegen.

The migration looked simple — walk `agents/` and `skills/` at codegen time, emit a `BUNDLED_AGENT_NAMES` const, and consume it in the Zod schema. In practice three subtle traps surfaced during `ce:review` and pre-merge verification:

- runtime behavior already accepted more than the docs implied (qualified `<category>/<name>` IDs alongside bare names)
- generator code read its own output through a static ESM import (first-run JSON Schema reflected stale `BUNDLED_AGENT_NAMES`)
- the drift gate's `--check` callback and the `main()` write path called the producer function with different option shapes, so drift detection misfired immediately after a fresh regeneration

That combination produced a nasty failure mode: configs that worked in v2.14.x became invalid under the new schema, the first run of the generator after an agents/ change shipped a stale published schema, and the safety check that should have caught both failed for the wrong reason.

A fourth trap surfaced in PR #394 (v2.17.0) when Fro Bot's review caught a latent bug in the same generator: a regex used to count bundled entries in the auto-generated source file was quote-style-sensitive but the file was formatter-controlled. The shrink-protection guard built on top of that regex was silently inert. This update folds that learning in as Trap #4 alongside the original three.

## Guidance

Before migrating permissive config to strict validation, four rules need to hold simultaneously.

### 1. Audit the runtime's full input surface, not just the documented happy path

Don't trust what the docs claim the runtime accepts. Grep the runtime for alias maps, prefix matching, normalization helpers, fallback lookups, and any other input-acceptance path. Every form the runtime currently accepts must either appear in the strict allow-set or be explicitly deprecated with a migration story in the release notes.

In this case the runtime's `buildBundledAgentInventory` quietly populated `aliases[entry.id]` (qualified `<category>/<name>`) AND `aliases[entry.key]` (bare name). `validateExactAgentOverlays` resolved through `inventory.aliases[key]`, so both forms worked. Documented examples used both. The initial strict schema only included bare names — qualified-overlay configs became invalid silently.

### 2. Treat generator self-reads as cache-sensitive

If a generator writes a file and then imports code that depends on that file, static ESM imports stay stale. ESM module caches are keyed by resolved URL, not by file mtime. Rewriting `src/lib/bundled-names.ts` to disk does not invalidate the module the schema was imported from.

**Preferred fix — schema factory**: Refactor the consumer to accept fresh inputs as parameters via a factory like `createSystematicConfigSchema({ agentNames, qualifiedAgentIds, skillNames })`. The static export stays for runtime; the generator passes fresh discovery results directly to the factory. No module re-evaluation needed.

```typescript
// src/lib/config-schema.ts
export function createSystematicConfigSchema(opts: {
  agentNames: readonly string[]
  qualifiedAgentIds: readonly string[]
  skillNames: readonly string[]
}) {
  const { agentNames, qualifiedAgentIds, skillNames } = opts
  return z.object({
    agents: z.object(
      Object.fromEntries(
        [...agentNames, ...qualifiedAgentIds].map((name) => [name, AgentOverlaySchema.optional()]),
      ) as Record<string, z.ZodOptional<typeof AgentOverlaySchema>>,
    ).strict().default({}),
    disabled_agents: z.array(
      z.enum([...agentNames, ...qualifiedAgentIds] as unknown as readonly [string, ...string[]]),
    ).default([]),
    // ...
  }).strict()
}

// Static export for runtime — built from committed bundled-names.ts at module load.
export const SystematicConfigSchema = createSystematicConfigSchema({
  agentNames: BUNDLED_AGENT_NAMES,
  qualifiedAgentIds: BUNDLED_AGENT_QUALIFIED_IDS,
  skillNames: BUNDLED_SKILL_NAMES,
})
```

```typescript
// scripts/generate-config-schema.ts — generator uses factory directly
import { createSystematicConfigSchema } from '../src/lib/config-schema.js'

async function main(): Promise<void> {
  const { agents, agentQualifiedIds, skills } = discoverBundledNames(PROJECT_ROOT)
  writeBundledNamesFile(/* ... */)

  // Build a fresh schema from the just-discovered names. No cache-busting needed.
  const freshSchema = createSystematicConfigSchema({
    agentNames: agents,
    qualifiedAgentIds: agentQualifiedIds,
    skillNames: skills,
  })
  generateAndWrite(generateSchemaContentFromSchema(version, freshSchema), version)
}
```

This pattern was introduced in PR #393 after the project initially used the cache-bust workaround below.

**Alternative — cache-busted dynamic import**: If refactoring the consumer into a factory is impractical, force a fresh module read by appending a query string to the import URL after writing:

```typescript
// scripts/generate-config-schema.ts (historical alternative — prefer factory above)
writeBundledNamesFile(bundledContent, PROJECT_ROOT)

// ESM module caches are keyed by URL; appending ?cache=<timestamp> forces a
// fresh import that re-reads bundled-names.ts.
const schemaModuleUrl = `../src/lib/config-schema.js?cache=${Date.now()}`
const schemaModule = await import(schemaModuleUrl)
const freshSchema = schemaModule.SystematicConfigSchema

generateAndWrite(generateSchemaContentFromSchema(version, freshSchema), version)
```

This project shipped this pattern in v2.15.0 (PR #384) and migrated to the factory in PR #393. The cache-bust approach works but is fragile: it relies on the runtime's URL-keyed module cache treating query strings as distinct entries, which is a Bun/Node implementation detail rather than an ESM spec guarantee.

### 3. Don't introspect formatter-controlled auto-generated code with quote-sensitive regex

If the generator parses its own committed output to make decisions (count entries, detect shrinks, compare prior state), the parser must match the formatter's actual output style — not what the source code looks like before formatting.

In this case, `readCommittedBundledNamesCounts(rootDir)` parsed the committed `src/lib/bundled-names.ts` file and counted entries in the `BUNDLED_AGENT_NAMES` and `BUNDLED_SKILL_NAMES` arrays. The inner counter was:

```ts
// Broken — single-quote only:
const countEntries = (block: string): number =>
  block.split('\n').filter((line) => /^\s*'[^']+',\s*$/.test(line)).length
```

But the generated file is Biome-formatted before commit. Biome's default output uses **double quotes**:

```ts
export const BUNDLED_AGENT_NAMES = [
  "adversarial-document-reviewer",
  "adversarial-reviewer",
  // ...
]
```

So `countEntries` returned 0 for every entry. The function's caller — the shrink guard that prevents accidental removal of bundled agents or skills without an explicit `--allow-shrink` flag — was effectively dead code. Every regeneration looked like a first run with no committed-counts baseline, so the shrink protection silently passed through.

The fix is quote-agnostic:

```ts
// Works with both single and double quote styles:
const countEntries = (block: string): number =>
  block.split('\n').filter((line) => /^\s*['"][^'"]+['"],\s*$/.test(line)).length
```

The general lesson generalizes beyond quotes. Any code that introspects auto-generated source by regex is vulnerable to formatter output changes:

- Quote style (`'` vs `"`)
- Trailing comma policy
- Whitespace conventions (indentation, padding inside brackets)
- Semicolon style
- Comment style (`//` vs `/*`)
- Line-ending style (`\n` vs `\r\n`)

Defensive patterns:

- Make regexes quote-agnostic, whitespace-tolerant, trailing-character-tolerant
- Test against actual formatter output, NOT against synthetic fixtures hand-written in your IDE
- Prefer side-channel metadata over scraping: emit a separate `.json` count file alongside the generated source, or include a structured comment header like `// COUNT: 50`
- Best of all: parse the AST. If you control the generator, you already know the shape

The shrink guard's failure mode here was the most insidious kind: a guard that silently returns "no baseline" / "first run" / "empty result" rather than throwing. The bug doesn't fire on its own — it just makes the guard inert. You only notice when something else catches the consequence, or by code review from someone who knows what the formatter emits.

### 4. Keep `--check` and write paths byte-identical

A drift gate works by computing "expected" content fresh from sources, reading the on-disk file, and comparing. For this to be sound, both call sites — the `--check` `produce()` callback and the `main()` write path — must call the producer with identical option shapes and defaults. Any divergence in inputs, defaults, sort order, or formatting and drift detection silently misfires.

Best long-term shape: factor the shared option-derivation into a single helper that both paths call. The asymmetry that bit this PR was possible because each call site assembled the option object independently.

## Why This Matters

The meta-principle is straightforward: **moving from permissive to strict validation freezes runtime behavior into a contract.** If the contract misses any of the four surfaces below, it lies.

| Surface | Failure shape |
|---|---|
| Hidden runtime flexibility | Schema rejects inputs the runtime would have accepted; users hit parse errors with no migration guidance. |
| Generator read-after-write ordering | First-run output is stale; CI drift gate catches it but only after the artifact ships. |
| Formatter-controlled introspection | Regex-based parsers built on the wrong quote/style assumptions silently return empty results; guards built on top of them become dead code. |
| Drift-gate call-site parity | `--check` reports drift right after a clean regenerate; humans waste time chasing a phantom. |

The damage is asymmetric. The runtime surface miss breaks users in production. The codegen ordering trap ships stale artifacts. The formatter-introspection trap turns a safety guard into a no-op without any visible signal. The drift-gate asymmetry erodes trust in the safety check. Each trap is independently fixable but, taken together, the four define a small playbook for strict-validation migrations.

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
- PR #393 — refactored the generator to remove the cache-bust workaround entirely; introduced `createSystematicConfigSchema` factory.
- Follow-up issues: #385 (verbose enum suppression for `disabled_*` typos), #386 (multi-key extraction in unrecognized-key hints).
