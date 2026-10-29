---
title: Registry validators passed an opencode block that OCX 2.x rejects
date: 2026-10-29
category: integration-issues
module: registry
problem_type: integration_issue
component: tooling
symptoms:
  - "`ocx add systematic/plugin` exits 1 with `Unknown opencode config key \"plugins\"`"
  - "`bun run registry:validate` passes against the same manifest"
root_cause: missing_validation
resolution_type: code_fix
severity: medium
related_components:
  - docs
tags:
  - ocx
  - registry
  - validation
  - opaque-passthrough
  - consumer-contract
  - opencode-config
  - schema-mismatch
---

# Registry validators passed an opencode block that OCX 2.x rejects

## Problem

The `plugin` component in `registry/registry.jsonc` declared its OpenCode config as `"opencode": { "plugins": { "@fro.bot/systematic": {} } }`. OCX 2.x rejects that block, so the documented install, `ocx add systematic/plugin`, failed for every user. Our own registry checks reported the manifest as valid the whole time. The published 3.27.0 registry entry carried the bad block ([`registry/registry.jsonc` at v3.27.0](https://github.com/marcusrbrown/systematic/blob/v3.27.0/registry/registry.jsonc#L687-L690)).

## Symptoms

- `ocx add systematic/plugin` exits 1 with `Unknown opencode config key "plugins"` (per #1245).
- `bun run registry:validate` exits 0 on the same manifest.

## What Didn't Work

Trusting the registry gates. They never see the `opencode` block's contents, because the build script types it as an open map: `scripts/build-registry.ts:54` and `scripts/build-registry.ts:85` declare `opencode?: Record<string, unknown>` on the component and packument entries, and `scripts/build-registry.ts:547-548` copy `component.opencode` into the output without inspecting it. Any shape builds and validates, because the output mirrors the input.

The profiles hid the gap. They ship a literal `opencode.jsonc` file instead of an inline `opencode` block, so the one place that could have shown the mismatch was the one place that does not use the passthrough.

## Solution

Change the entry to the shape OCX accepts. The 3.27.0 entry was:

```jsonc
"opencode": { "plugins": { "@fro.bot/systematic": {} } }
```

The entry now at `registry/registry.jsonc:687-689` is:

```jsonc
"opencode": { "plugin": ["@fro.bot/systematic@latest"] }
```

A test pins the real entry, so the key and value type cannot drift again. `tests/unit/generate-registry.test.ts:604-624` reads the committed registry, finds the `plugin` component, and asserts that its `opencode` keys are exactly `['plugin']` and that every value is a string. The synthetic fixtures in that file use `plugin: ['@x/y']` too.

The guide (`docs/src/content/docs/guides/ocx-registry.mdx`) now documents `ocx add systematic/plugin`, `ocx init --global`, and the `--source <registry>/<profile> --global` form in place of `--from`, which OCX rejects for registry components (local probe, #1245). The working profile form needs `ocx init --global` first.

Verified with `ocx@2.0.15` against a locally built registry: `ocx add systematic/plugin` exited 0 in both project and global scope. The live component serves the `plugin` key at `latest` (3.27.1).

## Why This Works

The bundled `ocx@2.0.15` schema declares `plugin` as an array of strings or `[string, record]` pairs. It parses the `opencode` object with `.passthrough()` and then runs a `superRefine` that rejects every key outside its own known list, with the message "Unknown opencode config key ... not part of opencode's config schema". A plural `plugins` map is not on that list, so it fails at install time, not at parse time of our registry. Our validators never ran that refinement, so they could not fail.

The fix replaces the key and value with the shape the consumer accepts. The test closes the loop by pinning that shape in the repo, where a registry edit will trip it.

## Prevention

- Treat "our validator passed" as a claim about our own types. For a field passed through untyped to another tool, it says nothing about whether that tool accepts the value. Type the field to the consumer's shape, or pin the real entry in a test, as `tests/unit/generate-registry.test.ts:604-624` does.
- Pin both the key set and the value type. Pinning only the key would have left an object where the consumer wants an array.
- Before a registry release, run the consumer CLI against a locally built registry in a clean home directory, project scope and global scope. This is the installed-artifact check described in the related doc below.
- Check docs claims about a third-party tool against that tool's source and a live run. Command flags and written config keys both drifted here.

## Related Issues

- [`docs/solutions/workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md`](../workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md): build gates passing is not evidence the installed artifact works.
- [`docs/solutions/best-practices/verify-a-no-change-claim-against-the-consumer-2026-09-08.md`](../best-practices/verify-a-no-change-claim-against-the-consumer-2026-09-08.md): a claim about a boundary needs a check at the consumer.
- [`docs/solutions/documentation-gaps/opencode-plugin-config-key-is-singular-plugin-not-plugins-2026-07-18.md`](../documentation-gaps/opencode-plugin-config-key-is-singular-plugin-not-plugins-2026-07-18.md): the plural-versus-singular `plugin` key that the registry entry got wrong.
- #1245: the fix.
