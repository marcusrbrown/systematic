---
title: OpenCode plugin config key is singular plugin, not plugins
date: 2026-07-18
category: documentation-gaps
module: opencode-plugin-config
problem_type: documentation_gap
component: documentation
severity: medium
applies_when:
  - "Writing OpenCode install instructions in docs, README, or shipped config"
  - "Defining the plugin array in an opencode.json / opencode.jsonc profile"
  - "Documenting any third-party tool's config key from memory"
tags:
  - opencode
  - config
  - plugin
  - install-docs
  - registry
---

# OpenCode plugin config key is singular plugin, not plugins

## Context

Systematic's install docs and both shipped registry profiles told users to add the plugin under a plural `plugins` array in `opencode.json`. OpenCode's config schema only reads a **singular** `plugin` array, so the plural key is silently ignored — the plugin never loads, with no error. This shipped in the README, three docs pages, and the `standalone`/`omo` registry profiles that users install directly, so anyone following the instructions got a config that silently did nothing.

## Guidance

Use the singular `plugin` key for OpenCode plugin config, everywhere:

```json
{ "plugin": ["@fro.bot/systematic@latest"] }
```

Not `"plugins"`. The fix (PR #665) swept every user-facing occurrence to singular:

- `README.md`
- `docs/src/content/docs/getting-started/installation.mdx` (prose + JSON)
- `docs/src/content/docs/index.mdx`
- `docs/src/content/docs/guides/agent-install.mdx` (prose + JSON)
- `registry/files/profiles/standalone/opencode.jsonc`
- `registry/files/profiles/omo/opencode.jsonc`

The repo's own `opencode.json` and the integration tests already used the singular form correctly — only the human-facing docs and registry profiles had drifted to the plural.

## Why This Matters

The failure is **silent**: OpenCode does not warn on an unknown `plugins` key, the docs build stays green, and tests pass (they exercise the correct singular form). A user following the docs sees no error — the plugin just isn't there. Broken install instructions in the README and shipped registry profiles are among the highest-blast-radius docs bugs, because they are the literal first thing a new user copies.

## When to Apply

- Any time you write or review OpenCode plugin install config.
- Whenever documenting a third-party tool's config key — verify against that tool's actual schema/source, not memory or naming intuition. Plural "plugins" is the intuitive guess and it is wrong here.

## Examples

Ground truth confirming the singular key:

- OpenCode runtime reads `config.plugin` — `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/config/config.ts:101-108`.
- OpenCode's config schema: `plugin: Schema.optional(Schema.Array(PluginSpec))` — `.slim/clonedeps/repos/anomalyco__opencode/packages/tui/src/config/index.tsx:53-58`.
- Systematic's own setup code **already rejects** the plural at runtime — `src/lib/setup.ts:296-316`: *"`plugins` (plural) is not supported by OpenCode's schema; use singular `plugin`."*
- Systematic's OpenCode integration test uses `{ plugin: [pluginPath] }` — `tests/integration/opencode.test.ts:751-759`.

The clinching signal: the project's own code enforced the singular key while its docs taught the plural. When your runtime already validates a shape, the docs must match the shape the code enforces.

## Related

- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md` — plugin config/loader semantics (how OpenCode resolves the `plugin` array across sources).
- `docs/solutions/developer-experience/local-systematic-overrides-global-2026-05-14.md` — OpenCode config source precedence.
- `docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md` — verifying real OpenCode loader behavior rather than assuming.
