---
title: Zod JSON Schema $ref deduplication needs ref-aware post-processors
date: 2026-05-17
category: best-practices
module: scripts/generate-config-schema.ts
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - Emitting JSON Schema from Zod 4 with `reused: 'ref'` enabled
  - Post-processing the emitted schema by walking property paths
  - Mutating `required` arrays, injecting `allOf` conditionals, or otherwise rewriting schema nodes after emission
  - Schemas carry `.describe()` / `.default()` / `.examples()` metadata alongside structural bodies
  - Maintaining AJV/runtime parity between Zod validation and the generated JSON Schema
tags:
  - json-schema
  - zod
  - schema-generation
  - ref-dedup
  - code-generation
---

# Zod JSON Schema $ref deduplication needs ref-aware post-processors

## Context

Zod 4's `z.toJSONSchema(schema, { reused: 'ref' })` changes the shape of the emitted schema tree. Schemas that appear multiple times (overlay shapes used across N config keys, shared union branches, etc.) are extracted to a `definitions` block once and referenced via `$ref` everywhere they appear. The default `reused: 'inline'` keeps every reuse inlined, producing tractable-looking but enormous schemas.

The published Systematic config schema collapsed from **16,749 lines to 1,508 lines (91% reduction)** by flipping that one option. The agent overlay shape was inlined ~100 times (50 bundled agents × 2 contexts: `agents.<bundled-name>` direct + `categories.<id>.agents.<id>`). After dedup, every referrer points at a single `definitions/__schemaN` entry.

The friction surfaces immediately afterward. Any code that walks the emitted schema by property path — `schema.properties.agents.properties[name].properties.model.anyOf` — stops working because intermediate levels become `{$ref: ...}` nodes without their own `properties`. Worse, when a Zod schema carries metadata (`.describe()`, `.default()`, `.examples()`), the emitter wraps the structural body in `allOf: [{$ref: ...}]`: the metadata sits on the wrapper, the structural body sits in the referenced definition. So a single resolution step is not enough — walkers must unwrap *both* the ref AND the metadata wrapper to reach the schema's real structure.

This breaks any post-processor that ran on inline schemas: cross-field constraint injection, required-array pruning, reference rewriting, and anything else that mutates emitted nodes by path traversal. The size win is real, but the post-processor retrofit is mandatory — and the failure mode is silent: the schema gets smaller, and validation contract drift is the bug.

## Guidance

When you flip `reused: 'ref'`, do these four things together:

1. **Add a single canonical `resolveRef` helper** that follows BOTH `$ref` indirection AND single-element `allOf: [{$ref}]` metadata-wrapper unwrapping. Loop-bounded with a generous safety cap.
2. **Thread the schema root into every post-processor** so they can resolve refs (refs are root-relative paths like `#/definitions/__schemaN`).
3. **Mutate the resolved shared definition once** — propagation via ref happens automatically when N referrers all point at the same object. Use a `WeakSet` to de-dup mutations across multiple call sites that resolve to the same definition.
4. **Warn loudly on depth exhaustion**. Silent ref-resolution failure means silently dropped constraints. A bounded loop without observability is a future regression in a bottle.

```ts
const result = z.toJSONSchema(schema, {
  target: 'draft-7',
  // Deduplicate repeated schema shapes by extracting them to definitions.
  // Without this, the agents.<key> overlay (and its embedded sub-schemas)
  // is inlined once per bundled agent (~100x), bloating the schema by ~15K
  // lines. With `reused: 'ref'`, repeated shapes become a single definition
  // referenced via $ref, collapsing the schema to a fraction of its size.
  reused: 'ref',
  override: (ctx) => {
    if (ctx.path.length === 0) {
      ctx.jsonSchema.$id = schemaId
    }
  },
})
```

```ts
/**
 * Upper bound on how many levels of `$ref` / `allOf-wrapper` indirection
 * resolveRef() will follow before giving up. Set generously above observed
 * Zod-emitted chains (ref → wrapper → ref → ... ~3 levels in practice) to
 * absorb future generator changes without becoming a magic-number cliff.
 */
const MAX_SCHEMA_REF_RESOLUTION_DEPTH = 8

function resolveRef(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
): Record<string, unknown> | null {
  let current: Record<string, unknown> | null = node

  for (
    let i = 0;
    current !== null && i < MAX_SCHEMA_REF_RESOLUTION_DEPTH;
    i++
  ) {
    const ref = current['$ref']
    if (typeof ref === 'string') {
      const prefix = '#/definitions/'
      if (!ref.startsWith(prefix)) return null
      const defKey = ref.slice(prefix.length)
      const definitions = asObject(root.definitions)
      if (definitions === null) return null
      current = asObject(definitions[defKey])
      continue
    }

    // Unwrap a trivial single-ref allOf wrapper. Zod uses this shape when a
    // schema has metadata (description, default, examples) at the wrapper
    // level and the structural body (properties, additionalProperties) at the
    // wrapped level.
    const allOf = current['allOf']
    if (Array.isArray(allOf) && allOf.length === 1) {
      const wrapped = asObject(allOf[0])
      if (wrapped !== null && '$ref' in wrapped) {
        current = wrapped
        continue
      }
    }

    return current
  }

  console.warn(
    `[generate-config-schema] resolveRef exhausted MAX_SCHEMA_REF_RESOLUTION_DEPTH (${MAX_SCHEMA_REF_RESOLUTION_DEPTH}). ` +
      'A schema node was not resolved; downstream post-processors will skip it. ' +
      'If this triggers after a Zod upgrade, raise the depth bound.',
  )
  return null
}
```

For post-processors that need to mutate the resolved definition:

```ts
const mutated = new WeakSet<Record<string, unknown>>()

const applyConstraint = (node: Record<string, unknown> | null): void => {
  if (node === null) return
  const target = resolveRef(root, node)
  if (target === null || mutated.has(target)) return
  mutated.add(target)
  injectMyConstraint(root, target)
}
```

The WeakSet matters because a single definition may be referenced from many call sites (each agent overlay key + the category overlay context, in this case). Without it, the same `allOf` block gets injected N times into one definition.

## Why This Matters

`reused: 'ref'` is the difference between a schema you can publish on a CDN and one that bricks IDE autocomplete and clogs npm tarballs. The 91% reduction here is not unusual — any schema with bundled-name enums or shared overlay shapes will see similar wins.

But the cost of skipping the post-processor retrofit is silent correctness drift. In one specific case in this repo:

- `addOverlayCrossFieldConstraints` (variant-requires-explicit-model) — failed to fire after the refactor because `properties.agents.properties.<bundled-name>` was now `{$ref: ...}` not an object with its own `properties`. The cross-field validation gap was caught only because AJV parity tests covered the variant-without-model rejection path.
- `removeDefaultFieldsFromRequired` (prune defaulted fields from `required` arrays) — same class of bug; `bootstrap.required` incorrectly listed `enabled` despite the field having a runtime default. Caught by a parity test that asserted `bootstrap: {}` should be accepted.

Both bugs were "the schema got smaller and superficially worked" — exactly the kind of regression that ships without intervention. AJV parity tests are the cheap, mechanical insurance: assert byte-identical accept/reject behavior between `SystematicConfigSchema.safeParse()` and AJV's `validate()` over a fixture set covering happy paths, defaults, refinements, and cross-field constraints.

The `console.warn` on depth exhaustion is observability insurance. The current emitted chain depth is ~3 (ref → wrapper → ref). The safety bound is 8. If a future Zod version starts emitting deeper chains, the warning surfaces it instead of silently losing post-processing mutations on the affected nodes.

## When to Apply

- You emit JSON Schema from Zod 4 with `reused: 'ref'`
- You post-process the emitted schema by walking property paths
- Your schemas use `.default()`, `.describe()`, or `.examples()` (these are what trigger the `allOf: [{$ref}]` wrapper shape)
- You need AJV / runtime parity, especially for cross-field constraints or required-array semantics

If your generator does no post-processing — pure Zod-to-JSON-Schema emission with no mutation afterward — `reused: 'ref'` is a free win. The retrofit cost only applies when you walk and mutate.

## Examples

**Before** (works only with `reused: 'inline'`):

```ts
const modelNode = schema.properties.agents.properties[name].properties.model
const anyOf = modelNode.anyOf  // undefined when intermediate levels are $ref
```

**After** (works with both):

```ts
const agentsNode = getSchemaNode(root, ['properties', 'agents'])
const agentsBody = agentsNode === null ? null : resolveRef(root, agentsNode)
const agentProperties = asObject(agentsBody?.['properties'])
if (agentProperties !== null) {
  for (const key of Object.keys(agentProperties)) {
    const overlay = asObject(agentProperties[key])
    if (overlay === null) continue
    const resolved = resolveRef(root, overlay)
    // ... safe to walk resolved.properties.model.anyOf now
  }
}
```

**Actual post-processor pattern** from `scripts/generate-config-schema.ts`:

```ts
function getNonNullModelBranch(
  root: Record<string, unknown>,
  overlayNode: Record<string, unknown>,
): Record<string, unknown> | null {
  const properties = asObject(overlayNode.properties)
  const modelNode = asObject(properties?.model)
  if (modelNode === null) return null

  // With `reused: 'ref'`, the model field is several layers of ref/wrapper
  // indirection (overlay.properties.model → ref → allOf wrapper → ref → anyOf).
  const modelBody = resolveRef(root, modelNode)
  const anyOf = modelBody?.anyOf
  if (!Array.isArray(anyOf)) return null

  for (const candidate of anyOf) {
    const branch = asObject(candidate)
    if (branch === null) continue
    // The string branch may itself be a $ref to a definition holding the
    // type/pattern constraints; resolve it before checking type.
    const resolved = resolveRef(root, branch)
    if (resolved?.type === 'string') return cloneSchemaNode(resolved)
  }

  return null
}
```

**Verification pattern.** Pair the refactor with AJV parity tests that cover the post-processed paths. Sample fixture (using `bun:test` style):

```ts
test('parity: bundled agent variant-without-model rejected', () => {
  const config = { agents: { 'correctness-reviewer': { variant: 'v2' } } }
  expect(SystematicConfigSchema.safeParse(config).success).toBe(false)
  expect(ajvValidate(config)).toBe(false)
})

test('parity: bootstrap empty object accepted (enabled has runtime default)', () => {
  const config = { bootstrap: {} }
  expect(SystematicConfigSchema.safeParse(config).success).toBe(true)
  expect(ajvValidate(config)).toBe(true)
})
```

If either parity check disagrees post-refactor, a post-processor has gone ref-blind. The fix is always: thread `root` into the post-processor, resolve the node via `resolveRef`, mutate the resolved definition.

## Related

- [docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md](typed-config-validation-build-time-codegen-2026-05-16.md) — sibling doc covering schema-factory pattern + `--check` drift prevention. This doc extends it with `$ref` dedup and ref-aware post-processing.
- [docs/solutions/integration-issues/opencode-config-schema-rejects-ad-hoc-agent-colors-2026-05-09.md](../integration-issues/opencode-config-schema-rejects-ad-hoc-agent-colors-2026-05-09.md) — example of downstream schema validation breakage when emitted config / schema contracts drift.
- [docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md](../workflow-issues/reconciliation-sync-reference-integrity-20260417.md) — general reference-integrity precedent: post-process verification that every reference resolves on disk.
- GitHub issue [#389](https://github.com/marcusrbrown/systematic/issues/389) — `Refactor: factory-pattern for SystematicConfigSchema to remove cache-busting workaround` (closed by PR #393, which set up the factory pattern this doc's $ref refactor depends on).
- PR [#394](https://github.com/marcusrbrown/systematic/pull/394) — the merge that shipped the $ref dedup + ref-aware post-processors as part of v2.17.0.
