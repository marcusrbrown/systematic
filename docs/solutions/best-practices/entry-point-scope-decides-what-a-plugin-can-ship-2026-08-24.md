---
title: Entry-point scope decides what a plugin bundle can ship
date: 2026-08-24
last_updated: 2026-08-24
category: best-practices
module: claude-code-harness
problem_type: tooling_decision
component: tooling
severity: medium
tags:
  - claude-code
  - plugin-packaging
  - bin
  - bundling
  - node-modules
  - jsonc-parser
  - entry-point
  - err-module-not-found
applies_when:
  - Shipping an executable or script inside a plugin bundle the host installs by copying
  - A design reaches for MCP or a server purely to obtain execution capability
  - A bundled entry point fails at runtime with a module or package resolution error
  - The published dist/ externalizes runtime dependencies but the install target has no node_modules
---

## Context

A design called for adding an MCP server to the Claude Code bundle because the bundle
supposedly could not execute anything. One local install proved otherwise.

Claude Code 2.1.163, real marketplace install from a scratch local marketplace:

| Question | Answer | How it was settled |
|---|---|---|
| Does install copy only manifest-declared components? | No — the whole tree | Probe: undeclared `bin/` and `dist/` both landed in the cache |
| Does the executable bit survive? | Yes — `-rwxr-xr-x` | Probe |
| Is `bin/` reachable? | Yes, added to the Bash tool's `PATH` | Documented |

The install path was `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, and
`plugin.json` declared neither directory.

Two were undocumented; probing settled them.

## Guidance

The remaining problem was packaging, not execution.

Shipping the existing CLI failed three times:

| Attempt | Failure | Cause |
|---|---|---|
| Copy `dist/cli.js` alone | `ERR_MODULE_NOT_FOUND` | It imports a sibling chunk `dist/index-<hash>.js` |
| Copy all of `dist/` (1.5 MB) | `Cannot find package 'js-yaml'` | Published `dist/` externalizes runtime deps; npm resolves them from `node_modules`, and a bundle has none |
| `bun build src/cli.ts --target=node` | `Cannot find module './impl/format'` | `jsonc-parser` is UMD; its AMD branch calls `require("./impl/format")` at runtime, which no bundler resolves statically |

`--conditions=module,import` did not change resolution.

The fix is not a better bundler flag. It is a narrower entry point:

```bash
# Fails: the whole CLI, 0.76 MB, one unresolvable runtime require
bun build src/cli.ts --target=node --outfile=cli.js

# Works: an entry importing only the module this surface needs
bun build src/validate-entry.ts --target=node --outfile=validator.js
# 0.50 MB, zero dynamic requires
```

Wrap it so the path resolves from the script, not the working directory:

```bash
#!/usr/bin/env bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/../dist/validator.js" "$@"
```

Then verify the installed artifact from a foreign directory with no `node_modules` in
scope, checking exit codes and not just output.

## Why This Matters

The full CLI transitively pulls in `jsonc-parser` for JSONC config loading and
`tree-sitter` for the OpenCode-only workflow guard. The Claude Code bundle uses
neither.

The unshippable dependencies came from **entry-point scope**, not the feature itself.
A general-purpose entry inherits every dependency any of its subcommands needs, and one
UMD module with a runtime `require` anywhere in that graph makes the whole artifact
unshippable.

This also cuts the other way: a dependency that looks fatal may simply be out of scope.
`jsonc-parser` was never a blocker for artifact validation — it was a blocker for
`config show`, which the bundle does not ship.

## When to Apply

Reach for this when a design adds a server, a transport, or an install step to obtain
capability the host already provides, and when a bundled script fails to resolve a
module that is plainly present in the source tree.

Probe install behavior rather than inferring it. Whether a host copies the whole tree,
preserves permissions, or exposes a directory on `PATH` is cheap to measure and
expensive to assume.

## Examples

Before — reasoning from the artifact that already exists:

```text
bin/wrapper -> dist/cli.js -> dist/index-<hash>.js -> js-yaml, zod, jsonc-parser
                                                       (absent: no node_modules)
```

After — reasoning from the capability being shipped:

```text
bin/wrapper -> dist/validator.js   (self-contained, 0.50 MB)
```

The probe that settled it, end to end:

```bash
claude plugin marketplace add /tmp/proto-mkt
claude plugin install proto-probe@proto-mkt

find ~/.claude/plugins/cache/proto-mkt/proto-probe/0.0.1 -type f
#   /bin/systematic-validate      <- undeclared, present
#   /dist/validator.js            <- undeclared, present
ls -l .../bin/                    # -rwxr-xr-x, exec bit preserved

cd / && .../bin/systematic-validate '{"schema_version":1}'
#   INVALID issues=16
#   exit=1
```

## Related

- [Build and publish a harness plugin from CI instead of committing it](./claude-code-plugin-build-and-publish-architecture-2026-07-18.md) — the build and publish topology this packaging decision sits inside
- [Verify installed artifacts, not just build gates](../workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md) — the general form of the probe used here
- [An unvalidated artifact contract has no conforming producers](./unvalidated-artifact-contracts-have-no-conforming-producers-2026-08-23.md) — explains why artifact contracts need runtime-checkable availability conditions; the Claude Code bundle now ships its own validator alongside the prose
