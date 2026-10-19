---
title: Removing a top-level config key without breaking existing configs
date: 2026-10-19
category: best-practices
module: config-system
problem_type: design_pattern
component: tooling
severity: high
applies_when:
  - A feature is removed and user, custom, or project config files may still set its top-level key
  - The config schema rejects unknown keys with `.strict()`
  - The removal must not be a breaking change
tags: [config-compatibility, strict-schema, removed-settings, deprecation, zod, json-schema]
---

# Removing a top-level config key without breaking existing configs

## Context

The workflow guard was removed in #1169 (issue #1153). Existing config files still set `workflow_guard`. The top-level schema in `src/lib/config-schema.ts` ends with `.strict()`, so deleting the property would have made every one of those files fail to load and stopped the plugin from starting. The removal had to ship as a minor release with no breaking change. The key therefore had to keep loading from every config source, with any value, and do nothing.

[The workflow guard was removed](workflow-guard-removed-2026-10-19.md) records what was removed and why. This note records how the key was retired.

## Guidance

Keep the key as a deprecated stub, warn about it, and remove every reader.

1. **Keep a schema stub.** Replace the property's schema with `z.unknown().optional()`, marked `deprecated: true`, with a description that says it does nothing. Keep `.strict()`, so a misspelled key still fails.
2. **List the key** in `REMOVED_CONFIG_KEYS` in `src/lib/removed-names.ts`.
3. **Detect presence, not value.** Record which listed keys each loaded file carries, using `Object.hasOwn` on the raw object.
4. **Warn once per file per load.**
   - Dedupe on the file's canonical path, so two config paths that resolve to the same file warn once.
   - Name the file and the key, never print the value, and link to the reference.
   - Send the warning through the raw warning sink, so the cap on project warnings can't swallow it.
5. **Remove every reader.** Delete the key from the config types, defaults, and merge, from the protected and authority field lists, and from the capability snapshot.
6. **Keep the reference section.** Leave the key in `TOP_LEVEL_KEYS` in `docs/scripts/generate-config-reference.ts`, so the generated reference still has a section for a property the schema still lists. Exempt deprecated fields from the generator's examples check, so the published schema doesn't suggest a value that does nothing.
7. **Regenerate** the JSON schema and `configuration.mdx`, and add a hand-written "Removed Settings" section that the warning links to.
8. **Mark the history.** Give docs whose subject was the removed feature `status: superseded`, `superseded_by`, and `superseded_date`, and add a banner between the frontmatter and the H1. For docs whose lesson still applies, add a dated note banner instead, and leave docs that only mention the feature alone.

## Why This Matters

- **Deleting the property breaks every config that sets it.** The load throws, so the plugin never starts.
- **Loosening `.strict()` hides typos** in every other key.
- **Echoing the value** copies user-written config into logs.
- **Keeping a reader alive** makes "ignored" a promise the code can break later.

The stub keeps old files loading. The warning tells the user to clean up. Nothing reads the value, so even a malformed one is harmless.

## When to Apply

- A top-level key loses its feature and existing files may still set it.
- For a removed *value* inside a list, such as a stale name in `disabled_agents` or `disabled_skills`, use the value mapping that `src/lib/removed-names.ts` already has. This pattern covers a whole key.

## Examples

The stub, abbreviated (JSDoc omitted). From `src/lib/config-schema.ts`:

```ts
const removedWorkflowGuardSchema = z.unknown().optional().meta({
  description:
    'Removed. The workflow guard no longer exists, so this setting has no effect and is ignored. Delete it from your config to silence the warning it triggers.',
  deprecated: true,
})
```

Presence detection, abbreviated. From `loadConfigSource` in `src/lib/config.ts`:

```ts
removedKeys: REMOVED_CONFIG_KEYS.filter((key) =>
  Object.hasOwn(rawConfig, key),
),
```

The dedupe in `warnRemovedKeys`, abbreviated, from `src/lib/config.ts`:

```ts
const identity = `${source.canonicalPath}\0${key}`
if (reported.has(identity)) continue
```

The warning it emits, with the file path sanitized and the value never printed:

```text
[systematic] `workflow_guard` in config (<path>) has been removed and is ignored. Delete it from that file to silence this warning. See https://fro.bot/systematic/reference/configuration#removed-settings for details.
```

Under `invalidSource: 'report'`, a file that fails schema validation for another reason is dropped before the warning runs, so it gets no removed-key warning. Under the default `'throw'`, the load fails instead. `systematic capabilities` passes a silent sink.

The examples exemption, abbreviated. From `checkExamples` in `docs/scripts/generate-config-reference.ts`:

```ts
// A removed setting has nothing worth suggesting as a value.
if (schema.deprecated === true) return
```

Tests that keep the parts in step, all in `tests/unit/config-schema.test.ts`:

- Every key in `REMOVED_CONFIG_KEYS` is a schema property. This checks presence only. The deprecated marker is checked by the generated-schema test.
- Any value passes through unchanged.
- An omitted key stays omitted.
- A misspelled key is still `unrecognized_keys`.

`tests/unit/config.test.ts` covers the warning: the canonical-path dedupe, that the value is never echoed, and that the warning survives the project warning cap.

## Related

- #1169 and #1153.
- [Typed config validation with build-time codegen](typed-config-validation-build-time-codegen-2026-05-16.md).
- [Configuration reference: Removed Settings](https://fro.bot/systematic/reference/configuration#removed-settings).
