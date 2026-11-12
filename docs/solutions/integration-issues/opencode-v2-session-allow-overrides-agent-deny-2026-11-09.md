---
title: On OpenCode v2 a session-level allow overrides an agent's deny, so a read-only subagent needs an execute.before allowlist
date: 2026-11-09
category: integration-issues
module: opencode-v2-adapter
problem_type: integration_issue
component: tooling
symptoms:
  - "With the agent's own deny entries present, a session that allowed shell, edit and webfetch let the subagent write a marker file, hit a local fetch server and add a git worktree"
  - "The proof for that run ended with the verdict code isolation-breach and the child had been reached"
  - "With only bash, edit and webfetch denied, the child was still offered websearch and subagent"
  - "Denying execute did not help: the same host-native tools reappeared as opencode_worktree_create and its siblings"
  - "A shell: entry in agent frontmatter vanished from the translated rules with no error"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags:
  - opencode-v2
  - permissions
  - subagent
  - tool-guard
  - code-mode
  - read-only
  - least-privilege
---

# On OpenCode v2 a session-level allow overrides an agent's deny, so a read-only subagent needs an execute.before allowlist

## Problem

A plugin-bundled subagent that must stay read-only declared `permission:` denies in its frontmatter. On OpenCode v1 those denies hold. On OpenCode v2 (observed on 2.2.5) they are not a boundary. v2 evaluates an ordered rule list with last match winning, and a session's rules come after the agent's, so a session-level allow lifts every deny the agent set. Separately, Code Mode `execute` reaches host-native `opencode_*` tools that no frontmatter key names, and one of them writes into the project's `.git`.

## Symptoms

- The negative control `without the guard a session-level allow lifts the definition denies and the breach reproduces` (`tests/integration/opencode-v2.test.ts:1499-1524`, the control under the `runConnectIsolation` call) wrote the shell marker file, reached the fetch server and added a git worktree, with the agent's deny entries intact. The proof verdict was `isolation-breach`.
- A child with only `bash`, `edit` and `webfetch` denied was still offered `websearch` and `subagent`. In server mode an unanswered `websearch` ask waited about 60 seconds for its own timeout (observed once while probing the host, not re-checked). `subagent` would let the child start an agent that has a shell.
- Denying `execute` alone changed nothing: the host-native tools then appeared directly, as `opencode_worktree_create`, `opencode_session_move` and `opencode_session_rename`. Denying those three by name left the other `opencode_*` tools.
- The frontmatter key for the shell tool is `bash:`. The v2 translator renames it to `shell` (`src/lib/opencode-v2-permissions.ts:26-29`, `RENAMED_ACTIONS`). A literal `shell:` key is not a known permission key, so the loader drops it without an error.
- Before the fix, `normalizePermission` (`src/lib/validation.ts:87-129`) had no `websearch` key, so a `websearch: deny` line was dropped the same way.

## What Didn't Work

- **Writing the deny list from an assumed tool set.** The first list named `bash`, `edit` and `webfetch`. The list was incomplete until the child's real tool list was read on the host: `websearch`, `subagent` and `execute` were all missing.
- **Spelling the v2 name in frontmatter.** `shell:` does not survive the loader. The definition has to say `bash:`.
- **Denying individual tools.** Denying `execute`, or the three obvious `opencode_*` tools, leaves either the Code Mode route or the other host-native tools open. The `opencode_*` namespace is not something a deny list can enumerate for a future host.
- **Expressing an allowlist in frontmatter.** The robust shape is `*: deny` plus a short allow list, but `normalizePermission` keeps only a fixed set of keys. Accepting `*` and arbitrary action names would be a design change to the shared loader, and it would still be ordinary rules that a session allow overrides.

## Solution

Keep the `permission:` denies as a first layer, add the two missing keys, and enforce the boundary with a plugin hook that session rules cannot reach.

```yaml
# agents/research/connections-researcher.md (frontmatter)
permission:
  bash: deny
  edit: deny
  webfetch: deny
  websearch: deny   # new: the loader now keeps this key
  task: deny        # new: v2 spells it subagent
  external_directory: allow
```

The hook is an allowlist keyed on the exact agent name. `installToolGuard` registers one `execute.before` hook (`src/lib/opencode-v2-tool-guard.ts:77-79`). `decideToolCall` allows only the tools in `READ_ONLY_TOOL_ALLOWLIST` for an agent named in `READ_ONLY_AGENT_NAMES`, refuses every other tool including ones it has never heard of, and leaves other agents alone (`src/lib/opencode-v2-tool-guard.ts:31-64`). The hook body throws to refuse a call (`src/lib/opencode-v2-tool-guard.ts:72-75`, `refuseOutsideAllowlist`).

What the host does with that hook, checked against 2.2.5 sources and live runs:

- It fires for the model's direct calls, for tools the agent was never offered, and for each call made from inside Code Mode, which arrives under its host-native `opencode_*` name with the same agent id.
- A throw becomes that one call's error message. The session keeps running and the model can read the message.
- It does not consult permission rules, so a session-level allow cannot reach it.

The hook must be registered directly. If it ran through a never-throw wrapper the refusal would be swallowed and the call would proceed. Whether registration succeeded matters just as much: see [a guard whose registration can fail must fail closed](security-guard-registration-must-fail-closed-2026-11-09.md).

## Why This Works

The failure came from treating a rule list as a boundary. Rules are ordered, user-controlled and per-session, and the tool namespace they match against grows with the host. An allowlist enforced in code, at the point every call passes through, does not depend on rule order or on knowing every tool name. The remaining deny entries still do useful work: they make the host stop offering the tools, which saves the model a refused call, and they are the real boundary on v1.

## Prevention

- Do not call a v2 subagent "denied by definition". If it must be read-only, give it a guard keyed on its exact name and say so where the support claim is made.
- Read the child's actual tool list on the host before finishing a deny list. Do not stop at the list you assumed.
- Keep a negative control that reproduces the breach with the same session allows, using an agent the guard does not name. In this repo the control is the test cited above, and its guarded twins are `a session-level allow does not lift the guarded researcher when it runs directly` (`tests/integration/opencode-v2.test.ts:1527-1543`, the `runConnectIsolation` call with `mode: 'direct'`) and `a session-level allow does not lift the guarded researcher when a parent with that rule dispatches it` (`tests/integration/opencode-v2.test.ts:1545-1567`, which asserts `run.packaged` is the committed definition).
- Pin the translation: the unit test asserts a `shell` deny and a `subagent` deny appear in the translated rules and that no `bash` action remains (`tests/unit/connect-host-isolation.test.ts:63-87`), and that a `shell:` frontmatter key is dropped (`tests/unit/connect-host-isolation.test.ts:89-99`).
- Do not carry a result across majors; see [host support evidence](../best-practices/support-a-host-only-after-an-observed-deny-2026-11-09.md). On v1 the `permission:` map restricts a plugin agent, and a blanket allow in the user's host config does not lift it (`tests/integration/opencode-v1-isolation.test.ts:308-318`, the `hostPermission` test). On v2 the same denies are only a first layer.
- The hook covers only the named agent, including a user agent with the same name, and cannot stop a tool from being offered. A scripted model made the calls, so the proofs show what the host enforces, not what a live model would choose.

## Related Issues

- [Cross-harness `tools:` frontmatter divergence](cross-harness-tools-frontmatter-divergence-2026-08-16.md): what a string `tools:` line does on each host.
- [Subagent skill permission scoping](../workflow-issues/subagent-skill-permission-scoping-2026-05-20.md): per-agent skill permissions, which v2 does enforce.
- [Silent defect swallow in plugin hooks](opencode-plugin-hook-silent-defect-swallow-2026-05-19.md): why the guard's hook is the one callback that must throw.
- [Schemas need adversarial probes](../best-practices/schemas-need-adversarial-probes-not-just-compilation-2026-08-16.md): the silent-drop class this loader fell into.
- [Support a host only after observed evidence that its tool limits hold](../best-practices/support-a-host-only-after-an-observed-deny-2026-11-09.md): how this proof feeds the support table.
