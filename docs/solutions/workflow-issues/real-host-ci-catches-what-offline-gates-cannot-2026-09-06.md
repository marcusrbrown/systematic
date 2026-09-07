---
title: "A real-host CI job catches launcher, stdin, and signal bugs that every offline gate passes"
module: integration-test-harness
date: 2026-09-06
problem_type: workflow_issue
component: testing_framework
severity: medium
tags:
  - bunx
  - launcher-pid
  - process-group
  - stdin-eof
  - sigint
  - host-contract
  - real-host
  - pinning-test
applies_when:
  - "A launcher pid (the child you spawned) is compared to a pid observed from inside the launched process"
  - "Spawning a CLI that may read stdin, such as opencode run, from a test or fixture"
  - "A test simulates an interrupt with process.emit('SIGINT') or process.emit('SIGTERM')"
  - "Unit tests, typecheck, lint, review, and a local integration run are all green and a real-host CI job is red"
  - "Deciding whether a bug found by the real-host job also needs a host-free regression test"
---

# A real-host CI job catches launcher, stdin, and signal bugs that every offline gate passes

## Context

The host-contract plan (`docs/plans/2026-09-04-001-refactor-ci-owned-host-contract-suite-plan.md`)
switched the integration suite to `bunx opencode-ai@<pin>` (#928) and an in-process scripted
provider (#930). Both changes passed every offline gate — unit tests, `typecheck:all`, lint,
content-integrity, review, offline skip runs — and merged. The required `host-contract` job
(#931) then ran that code against a real pinned `opencode-ai` on Ubuntu and was red on four
bugs no offline gate could reach; one of them had passed a full local real-host run on macOS.

| Symptom in CI | Cause | Fix |
|---|---|---|
| Every `runOpencode()` test hangs the full 180 s with zero stdout/stderr, then `exitCode -1` | `child_process.spawn` default stdio leaves the child's stdin an open pipe with no writer; `opencode run` waits for EOF forever | `stdio: ['ignore', 'pipe', 'pipe']` (#932) |
| `error: Executable not found in $PATH: "opencode"` | One spawn site still ran the bare binary after the `bunx` conversion | Route it through `bunx opencode-ai@<pin>` (#932) |
| All tests pass, then the runner exits 130 with no failing assertion | A test called `process.emit('SIGINT')`; `process` is one emitter per Bun worker, so the fixture's global safety-net handler ran and called `process.exit(130)` | Invoke only the listener under test (#933) |
| `expected [6419, 6447] received [6420, 6448]` | The test asserted the launcher pid equals the pid seen inside opencode; on Linux `bunx` forks the binary as a child (+1) | Assert process-group membership instead of pid identity (#936) |

## Guidance

1. **Never assert a launcher pid equals the in-process pid.** That relationship belongs to the
   launcher and the platform. Measured for `bunx opencode-ai@1.18.27 serve`: on macOS it is one
   process (pid 44691, ppid 1, pgid 44691 — `bunx` execs in place); on Ubuntu `bunx` forks
   `opencode-ai` as a child, so the in-process pid is the launcher pid plus one. The fixture spawns
   with `detached: true`, so the launcher is the process-group leader and the durable claim is
   membership, captured before the host is stopped:

   ```ts
   // tests/integration/receipt-workflow-recovery.test.ts
   const firstHostGroup = processGroupMemberPids(firstPid) // captured BEFORE firstHost.stop()
   ...
   expect(firstHostGroup).toContain(loadedPids[0])
   ```

   `processGroupMemberPids` reads `ps -eo pid,pgid` (portable across BSD and GNU `ps`). Recording
   `process.ppid` in the probe and asserting `pid === launcher || ppid === launcher` is a valid
   shell-free alternative. Leave `host.pid` meaning the group leader — reaping depends on it.

2. **Close stdin for any spawned CLI that might read it.** An open, unwritten pipe never reaches
   EOF. `spawnOpencodeChild` in `tests/integration/fixtures/receipt-workflow-host.ts` now passes
   `stdio: ['ignore', 'pipe', 'pipe']`; with the default stdio the same command hangs to the
   timeout, with `'ignore'` it completes in about 24 s.

3. **Never `process.emit` a terminal signal in a test.** `process` is one emitter per Bun worker,
   so the emit reaches every listener — including a fixture safety net installed by an earlier test
   file and never removed, which is why this only fails at full-suite scope. Diff the listener set
   around the install and call only the one you added:

   ```ts
   // tests/integration/eval-runner.test.ts
   const priorSigintListeners = new Set(process.listeners('SIGINT'))
   const removeSignalHandlers = installEvalSignalHandlers()
   const [installedSigintListener] = process
     .listeners('SIGINT')
     .filter((listener) => !priorSigintListeners.has(listener))
   ```

4. **A green local run on one OS is not evidence for another.** The pid assertion passed 137/137
   on macOS and failed only on Ubuntu. Treat the CI host as its own contract.

5. **When the real-host job finds a bug, pin it with a host-free test where the mechanism is
   reachable without a host.** The host job proves the integration; a unit test protects `main`
   without one. The stdin hang is pinned that way in `tests/unit/receipt-workflow-host.test.ts`,
   alongside pins for two hazards the same fixture work surfaced (a `Bun.serve` + sync-spawn
   deadlock on the test thread, and group reaping on timeout) and, in
   `tests/unit/receipt-workflow-host-no-spawn.test.ts`, the invariant that importing the fixture
   spawns nothing. The other three bugs are guarded only by the integration tests that fixed
   them; the bare-binary and `process.emit` classes are pinnable host-free by a source scan over
   `tests/` (no argv beginning with bare `opencode`; no `process.emit` of a terminal signal),
   which is queued follow-up. Prove each pin bidirectionally: fails with the fix reverted, passes
   with it restored.

Diagnostic traps:

- `bun test ... | tail` reports `tail`'s exit code. Redirect to a file and inspect `$?`.
- A fail-closed reaper reports its own state (`exitCode -1`, `unavailable`), not the cause of the
  hang it cleaned up — see
  [fail-closed components report their own state](./fail-closed-components-report-their-own-state-2026-08-23.md).

## Why This Matters

Four real bugs shipped in merged code past unit tests, type checking, lint, review, and offline
skip runs. Those gates cannot exercise a real binary's stdin semantics, a spawn site that only
executes with a real host, a signal broadcast that only manifests across test files, or a
launcher's fork-versus-exec behaviour on another OS. The required real-host job is the only gate
with that reach, and it found all four before it had itself merged. The cost of learning each one
in CI was 15–20 minutes per iteration; the host-free pinning tests are what make the second
occurrence cost seconds.

## When to Apply

- Spawning `opencode-ai` or any CLI that may read stdin from a test or fixture
- Comparing pids across a launcher boundary (`bunx`, `npx`, a shell wrapper, a supervisor)
- Simulating interrupts or termination in a test that shares a process with other suites
- Adding or fixing host-dependent integration tests, or reading a red `host-contract` run
- Turning a manual local host check into a required CI contract

## Examples

**stdin — close it**

```ts
const child = spawn(command, rest, {
  cwd,
  env,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
```

**pid — assert group membership, not identity** (replaces
`expect(loadedPids).toEqual([firstPid, secondHost.pid])`)

```ts
expect(loadedPids).toHaveLength(2)
expect(loadedPids[0]).not.toBe(loadedPids[1])
expect(firstHostGroup).toContain(loadedPids[0])
expect(secondHostGroup).toContain(loadedPids[1])
```

**signal — call the listener, not the emitter**: capture the listener installed by the code
under test (Guidance 3) and invoke it directly instead of `process.emit('SIGINT')`.

## Related

- [Host-contract evidence is CI-owned](./host-contract-evidence-is-ci-owned-2026-09-04.md) — the
  mechanism this job runs under: pin in `package.json`, `bunx` launcher, guard conditions, when a
  green check is evidence. This doc covers the bug classes that mechanism exists to catch.
- [Availability guards must check executability](../integration-issues/availability-guards-must-check-executability-2026-08-16.md)
  — a shallow host check that green-lights a suite which cannot actually run.
- [Isolated OpenCode subprocess fixtures](../integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md)
  — the fixture these launches go through.
- [Pi real-runtime integration harness](../best-practices/pi-real-runtime-integration-harness-2026-07-16.md)
  — the same "real runtime over mocks" argument for the Pi adapter.
- [A capability that works has not named its cause](./a-capability-that-works-has-not-named-its-cause-2026-08-24.md)
  — a positive local result does not identify the mechanism; the macOS pass here is an instance.
- [Verify installed artifacts, not just build gates](./verify-installed-artifacts-not-just-build-gates-2026-07-18.md)
  — probe runtime channels empirically before designing around them.
- [#935](https://github.com/marcusrbrown/systematic/issues/935) — open follow-up: move the job's
  inline guard script into `scripts/` under lint, typecheck, and unit tests.
