---
title: OpenCode plugin config key is `plugin` on v1 and `plugins` on v2
date: 2026-07-18
last_updated: 2026-10-29
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

# OpenCode plugin config key is `plugin` on v1 and `plugins` on v2

> **OpenCode v2 reads a different key.** The incident below is OpenCode v1. A v2 host (2.2.0 and later) reads a plural `plugins` array, and Systematic supports both hosts from one package. The key is a property of the host line, so check which line a doc or config targets before choosing it. See [OpenCode v2](#opencode-v2).

## Context

Systematic's install docs and both shipped registry profiles told users to add the plugin under a plural `plugins` array in `opencode.json`. OpenCode v1's config schema only reads a **singular** `plugin` array, so the plural key is silently ignored on v1 — the plugin never loads, with no error. This shipped in the README, three docs pages, and the `standalone`/`omo` registry profiles that users install directly, so anyone following the instructions got a config that silently did nothing.

## Guidance

On OpenCode v1 (1.18.29 and later), use the singular `plugin` key:

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

### OpenCode v2

On OpenCode v2 (2.2.0 and later), the key is the plural `plugins`:

```json
{ "plugins": ["@fro.bot/systematic@latest"] }
```

The key is `plugins` on v2 (HARNESSES.md, OpenCode v2 section). `systematic setup --harness opencode` writes only `plugin` and refuses an existing `plugins` (`src/lib/setup.ts:315-319`). With OCX 2.0.15, both the `systematic/plugin` component and the `standalone` and `omo` profiles write the singular `plugin` key (local `ocx@2.0.15` probe, #1245), and OCX rejects `plugins` in a component manifest. OCX against an OpenCode v2 host is still unprobed.

## Why This Matters

The failure is **silent**: OpenCode does not warn on an unknown `plugins` key, the docs build stays green, and tests pass (they exercise the correct singular form). A user following the docs sees no error — the plugin just isn't there. Broken install instructions in the README and shipped registry profiles are among the highest-blast-radius docs bugs, because they are the literal first thing a new user copies.

## When to Apply

- Any time you write or review OpenCode plugin install config.
- Whenever documenting a third-party tool's config key — verify against that tool's actual schema/source, not memory or naming intuition. Plural "plugins" is the intuitive guess; it was wrong on v1 and is right on v2, so the host line decides.

## Examples

Ground truth confirming the singular key on v1:

- OpenCode runtime reads `config.plugin` — [`config.ts` lines 101–108 at v1.18.8](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/src/config/config.ts#L101-L108).
- OpenCode's config schema: `plugin: Schema.optional(Schema.Array(PluginSpec))` — [`index.tsx` lines 53–58 at v1.18.8](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/tui/src/config/index.tsx#L53-L58).
- Systematic's setup code writes only the v1 `plugin` key and refuses an existing `plugins` entry — `src/lib/setup.ts:315-319`: *"`plugins` (plural) is the OpenCode v2 key. Setup writes only the OpenCode v1 `plugin` key and left this file unchanged."* When this doc was written the same check rejected the plural as unsupported; it now names it as the v2 key.
- Systematic's v1 OpenCode integration tests build `{ plugin: [pluginPath] }` — `tests/integration/opencode.test.ts:327,332`.

The clinching signal: the project's own code enforced the singular key while its docs taught the plural. When your runtime already validates a shape, the docs must match the shape the code enforces. That still holds with two hosts: the code and the docs both have to name the key for the host line they describe.

## Related

- `docs/solutions/integration-issues/registry-validator-passthrough-hid-ocx-schema-mismatch-2026-10-29.md` — the registry component that declared the plural key, and why the registry checks passed.
- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md` — plugin config/loader semantics (how OpenCode resolves the `plugin` array across sources).
- `docs/solutions/developer-experience/local-systematic-overrides-global-2026-05-14.md` — OpenCode config source precedence.
- `docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md` — verifying real OpenCode loader behavior rather than assuming.
