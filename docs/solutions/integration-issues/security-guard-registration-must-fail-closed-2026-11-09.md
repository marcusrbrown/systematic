---
title: A guard whose registration can fail must fail closed, so do not run a safety installer through the never-throw wrapper
date: 2026-11-09
category: integration-issues
module: opencode-v2-adapter
problem_type: integration_issue
component: tooling
symptoms:
  - "Predicted failure path, not an observed run: if registering the execute.before tool guard rejected inside the never-throw wrapper, setup would log a single systematic: line and carry on, leaving the read-only agent callable with shell, write and web tools"
  - "Predicted: with the agent installed before the guard, there is a window with the agent present and no allowlist"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - opencode-v2
  - fail-closed
  - tool-guard
  - installer-order
  - never-throw
  - safety-hook
---

# A guard whose registration can fail must fail closed, so do not run a safety installer through the never-throw wrapper

## Problem

The OpenCode v2 adapter runs every installer through `createSafeGuard`, a wrapper that catches a failure, writes one `systematic:` line to standard error and returns `undefined`. That is the right default: one broken installer must not take the others down. It is the wrong behavior for the installer that registers the read-only tool guard. If that registration fails, the wrapper swallows it, and the read-only agent is already installed and callable, so a protection that was meant to be mandatory becomes decoration. The failure path below is reconstructed from the wrapper's code, not taken from a recorded failing run.

## Symptoms

Predicted, not observed. With the installer run through `guard.async`:

- A rejected `ctx.tool.hook('execute.before', ...)` call would produce one `systematic: toolGuard installer failed: <message>` line and nothing else. The line format is `reportFailure` (`src/lib/opencode-v2.ts:72-76`) and the label is `${slot} installer`, built in `setupOpenCodeV2`. The plugin would keep working and the agent would stay available.
- If `agents` ran ahead of the guard in the installer order, the agent would be exposed first.

## What Didn't Work

These are traps read off the code, not recorded attempts.

- **Throwing from the installer.** The outer wrapper catches it, because the loop wraps every slot in `guard.async`.
- **Reordering alone.** Installing the guard first is necessary, but a guard that failed to register would still be swallowed, and the agent would still be installed afterwards.
- **Relying on the guard hook's own throw.** The hook body is supposed to throw to refuse a call. That is a different thing from the registration failing, which happens once at setup and has to be handled there.

## Solution

Make the guard a prerequisite of the agents it protects, and take it out of the never-throw path.

1. **Install the guard first.** `INSTALLER_ORDER` starts with `toolGuard`, with a comment saying the protected agents are exposed only after it has registered (`src/lib/opencode-v2.ts:288-299`).
2. **Run it outside `guard.async`.** In `setupOpenCodeV2` the `toolGuard` slot is handled by `installGuardOrReport`, not by the wrapper (`src/lib/opencode-v2.ts:430-453`).
3. **On failure, log once and remove the protected agents from the plan.** `installGuardOrReport` catches the rejection, reports `tool guard registration failed: <message>; the read-only agents (connections-researcher) are not installed`, and returns `false` (`src/lib/opencode-v2.ts:455-475`). `withoutGuardedAgents` then returns a snapshot whose plan has no agent in `READ_ONLY_AGENT_NAMES`, and the later `agents` installer never sees it (`src/lib/opencode-v2.ts:477-488`).
4. **Let registration reject.** `installToolGuard` does not catch the failed `hook` call; it awaits it and lets the rejection out (`src/lib/opencode-v2-tool-guard.ts:77-79`). Only the registration is allowed to fail loudly; every other agent still installs.

## Why This Works

Whether the guard registered decides what the rest of setup may expose, so that decision has to be made by code that can see the failure. Moving the installer out of the wrapper puts the failure where the plan is built, and removing the agents turns "guard missing" into "agent missing", which is a degraded feature instead of an open one. Installing the guard before the agents closes the window in which the agent exists without it.

## Prevention

- A protective hook that gates a feature is not a normal installer. Install it before whatever it protects, run it outside any blanket never-throw wrapper, and on failure log once and withhold the protected thing.
- The guard's own refusal hook must throw too, and it must not be wrapped for the same reason (`src/lib/opencode-v2-tool-guard.ts:72-75`).
- Pin each branch with a unit test, not only the happy path. The `describe` block `the read-only tool guard is a prerequisite for the researcher` in `tests/unit/opencode-v2.test.ts:692-793` covers: the agent is installed when the guard registers; it is not installed when the hook call rejects, and the message is logged exactly once and names the cause; it is not installed when the host has no hook registry at all; the guard installer runs before the agents installer; and a guard installer that throws holds the agent back from the agents installer while other agents remain.
- When reviewing a "never throw" wrapper, list what it wraps and ask of each: if this fails silently, is the system more open than before? If yes, it does not belong inside.

## Related Issues

- [Plugin hooks silently swallow synchronous throws](opencode-plugin-hook-silent-defect-swallow-2026-05-19.md): the general rule to guard installers and callbacks, and the exception this doc adds.
- [On OpenCode v2 a session-level allow overrides an agent's deny](opencode-v2-session-allow-overrides-agent-deny-2026-11-09.md): why the guard exists.
- [Fail-closed components report their own state](../workflow-issues/fail-closed-components-report-their-own-state-2026-08-23.md): reporting what a fail-closed component did.
