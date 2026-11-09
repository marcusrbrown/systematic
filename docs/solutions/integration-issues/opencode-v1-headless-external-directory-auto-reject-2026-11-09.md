---
title: Headless OpenCode v1 auto-rejects reads outside the project, so allow external_directory for allowed projects and the state directory
date: 2026-11-09
category: integration-issues
module: opencode-v1-adapter
problem_type: integration_issue
component: configuration
symptoms:
  - "permission requested: external_directory (<path>/docs/solutions/*); auto-rejecting"
  - "The researcher's read of a checkout outside the working directory was rejected and the parent's final answer lacked the marker"
  - "A headless run whose work file lay in the state directory ended with no final line and the lock still held"
root_cause: config_error
resolution_type: config_change
severity: high
tags:
  - opencode-v1
  - headless
  - external-directory
  - permissions
  - symlink
  - state-directory
---

# Headless OpenCode v1 auto-rejects reads outside the project, so allow external_directory for allowed projects and the state directory

## Problem

A skill that reads other projects' checkouts and keeps its work files under a state directory touches paths outside the project the session runs in. OpenCode v1 (observed on 1.19.5) asks permission before such a read, using the `external_directory` permission. A headless `opencode run` has nobody to answer, so the host rejects the ask itself. The rejected read looks like a missing file or a refused tool, and when the rejected path is the skill's own work file the whole session ends.

## Symptoms

- Standard error carries `permission requested: external_directory (<path>/docs/solutions/*); auto-rejecting`. The exit code is 0 and nothing hangs.
- The researcher's tool call is rejected, so the parent's answer does not contain the planted marker.
- When the rejected read was the parent's own read of a work file in the state directory, the session ended before any final line. No digest was published and the lock stayed held until the next run found its holder gone (`skills/ce-connect/references/headless-and-outcomes.md:26-36`).

## What Didn't Work

Pitfalls, not recorded attempts: the researcher and the parent need separate allows, and symlinked temp paths must be resolved before testing.

- **Reading the failure as an agent-permission problem.** The researcher's `permission:` denies are not the cause; the rejected ask is a different permission.
- **Fixing only the agent.** The agent's own entry covers what the researcher reads. The parent session reads and writes the work files, and the agent's definition does not apply to it.
- **Testing with temp paths as spelled.** A fixture project under a symlinked temp directory (`/var` resolves to `/private/var` on macOS) is outside the project to v1 when spelled `/var/...`, and raises the ask even when the data is "inside".

## Solution

Two allows, in two places, because two sessions are involved.

1. **In the agent's frontmatter**, so the researcher can read allowed projects outside the working directory (`agents/research/connections-researcher.md:15`, the `external_directory: allow` line; the loader keeps this key in `src/lib/validation.ts:107-111`).
2. **In the user's own host config**, for the state directory the parent uses, with an absolute path:

   ```json
   { "permission": { "external_directory": { "<state directory>/*": "allow" } } }
   ```

   With that line a headless run on 1.19.5 ran the whole pipeline and ended `Connect complete`. Systematic never writes this line for the user; the skill's reference tells the user to add it (`skills/ce-connect/references/headless-and-outcomes.md:26-36`).

The agent-level allow widens reads to any path, which is already the documented limit that read tools are not path-scoped.

## Why This Works

`external_directory` is a separate ask from the tool permissions, and v1 resolves an unanswerable ask by rejecting it. The agent's allow answers the ask for the researcher's session; the host-config allow answers it for the parent's. Naming the state directory (not `*`) keeps the second allow narrow.

## Prevention

- Pin both halves. `a headless run reads a git checkout outside the project and the marker reaches the parent, with every denied tool still refused` shows the read works and nothing else is lifted (`tests/integration/opencode-v1-isolation.test.ts:340-372`). `without external_directory: allow the same read is auto-rejected, which pins what the entry does` shows the entry is what lets it through, by asserting the `permission requested: external_directory .*auto-rejecting` line (`tests/integration/opencode-v1-isolation.test.ts:374-397`, using `withoutExternalDirectoryAllow`, which throws if there is no entry to remove).
- In integration tests, resolve temp directories with `fs.realpathSync` before building paths (`tests/integration/opencode-v1-isolation.test.ts:168-179`).
- Document the host-config line wherever a headless run is described, and make the failure path release its lock or say it did not.
- Scope: observed on 1.19.5 only. On v2 2.2.5, `opencode run --standalone` read the external checkout with no prompt; in server or SDK mode an `ask` waited about 60 seconds for its own timeout (both observed once while probing the host, not re-checked).

## Related Issues

- [Support a host only after an observed deny](../best-practices/support-a-host-only-after-an-observed-deny-2026-11-09.md): the evidence that keeps the v1 row honest.
- [Isolated OpenCode subprocess fixtures](isolated-opencode-subprocess-fixtures-2026-05-14.md): fixture setup these tests run on.
