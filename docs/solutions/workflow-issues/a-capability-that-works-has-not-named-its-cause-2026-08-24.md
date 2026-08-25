---
title: A capability that works has not yet named its cause
date: 2026-08-24
category: workflow-issues
module: claude-code-harness
problem_type: workflow_issue
component: development_workflow
severity: high
tags:
  - negative-control
  - capability-claim
  - platform-boundary
  - claude-code
  - bin-path
  - mechanism-isolation
  - empirical-probing
  - install-behavior
applies_when:
  - A design depends on a platform or harness not supporting something
  - A positive probe result is being used to infer which component supplied a capability
  - A measurement is being generalized past the exact path or environment it covered
  - Deciding whether a limit belongs to the host or to your own build
---

# A capability that works has not yet named its cause

## Context

Three claims about what the Claude Code harness could not do were asserted in one session.
All three were false, and each was actually this repository's own choice:

| Claim | What was actually true |
|---|---|
| The bundle cannot run an executable | `scripts/build-claude-code-plugin.ts` emits only markdown. Nothing stops it emitting more. |
| The workflow guard is impossible there | `PreToolUse`/`PostToolUse` observe and can block. The blocker is that `src/lib/workflow-guard.ts` holds state in-process. |
| Reaching a bundled executable needs MCP | Marketplace install copies the whole directory and `bin/` lands on the Bash tool's `PATH`. |

The first claim carried real cost. An MCP server, a Node version floor bump, an `npx` launch
pin, and a new runtime dependency were designed on top of it, reviewed by six personas, and
merged as a plan. One local install retired the whole thing.

This repository already had the rule that would have prevented it:
[Verify installed artifacts, not just build gates](./verify-installed-artifacts-not-just-build-gates-2026-07-18.md)
said, five weeks earlier, *"Probe unproven runtime channels empirically before designing
around them. Don't assume a host honors a mechanism."* It was tagged `claude-code` and
`empirical-probing`, and it was not consulted.

## Guidance

A claim that a system *cannot* do something is a boundary claim, and your own build choices
are easiest to mistake for the platform's right there. Before designing around one, name the
boundary — build output, install behavior, process lifetime, hook visibility, transport, state
persistence — and test that against the installed artifact.

Then separate capability from implementation. "Claude Code cannot observe tool calls" is a
capability claim; "our guard's in-process state cannot survive hook invocation" is a design
problem with a cost.

**A positive result does not identify a mechanism.** This is the operative half the earlier
doc stops short of. A command that runs might be ambient. Confirm by removing the suspected
cause and re-testing:

```
plugin installed    -> PROBE_BIN_RAN_OK marker=livetest   exit 0
plugin uninstalled  -> command not found                  exit 127
shell's own PATH    -> never present, either way
```

Only the pair proves the plugin put the command there; either line alone fits another
explanation.

Keep every measurement scoped to what it actually covered. Two builds on one machine under
one toolchain are not reproducibility. A result about `process.cwd()`, which is
realpath-resolved, says nothing about an injected root on a different code path.

## Why This Matters

A boundary mistake does not produce a small error. It produces architecture: a transport, a
dependency, a version floor, and every failure mode those carry, all to route around a
constraint that was never there. Review misses it because each step looks plausible — six
personas reviewed the design without questioning the premise.

Attribution errors are quieter and survive longer. An unverified capability keeps working
right up until the thing actually responsible for it changes, and then the failure appears
somewhere unrelated to the assumption that caused it.

## When to Apply

Whenever a design rests on a platform "not supporting" something. Whenever a probe comes back
positive and is about to be written down as a property. Whenever a measurement is about to be
stated more generally than the conditions it was taken under.

The cost asymmetry is the whole argument. Probing install behavior took one local install.
The design built on not probing it took a brainstorm, a plan, a six-persona review, and a
merge — and then had to be retired.

## Examples

Before:

> Claude Code bundles cannot run executables, so validation requires an MCP server.

After:

> The builder emits a static bundle, so executable support is untested. Build a minimal
> bundled entry, install it, run it, then uninstall and run it again.

Before:

> Claude Code cannot observe or block workflow tools.

After:

> Its hooks can. The guard's in-process state has to be externalized before it survives
> hook-driven invocation.

Before:

> A symlinked ancestor is never a problem.

After:

> `process.cwd()` is realpath-resolved on the path that was tested. An injected root is a
> different path and needs its own test.

## Related

- [Verify installed artifacts, not just build gates](./verify-installed-artifacts-not-just-build-gates-2026-07-18.md)
  — carries the probe-before-designing half of this rule, five weeks earlier. This doc adds
  the mechanism-isolation half it stops short of.
- [Entry-point scope decides what a plugin bundle can ship](../best-practices/entry-point-scope-decides-what-a-plugin-can-ship-2026-08-24.md)
  — the measurements from this same arc, and what they said about packaging.
- [A perfect measurement means a broken instrument](../best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md)
  — a clean result indicting the instrument. Adjacent: that one distrusts the result, this one
  distrusts the attribution.
- [Version-pinned evidence must be re-proven](../workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md)
  — evidence and the version it was taken at move together.
