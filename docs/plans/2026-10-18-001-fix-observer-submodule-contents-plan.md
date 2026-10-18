---
title: "fix: Observe the contents of submodules and nested repositories in the local snapshot"
type: fix
status: active
date: 2026-10-18
---

# fix: Observe the contents of submodules and nested repositories in the local snapshot

## Overview

The local snapshot will read the files inside initialized submodules and untracked nested repositories, using the same hardened reader, caps and checks it uses for the parent. Honest edits inside them will change the worktree digest and make commit closure read not closed. Redirects made before a submodule is first seen, and ignore rules that hide work, are documented as limits of an observation gate. This closes #1126.

## Problem Frame

The operation observer (`src/lib/opencode-operation-observer.ts`) digests an initialized submodule by its path and HEAD only. A probe at e70b0707 confirmed the result: editing a tracked file inside an initialized submodule leaves the worktree digest unchanged and `commitClosure: true`. An unborn submodule fails the whole snapshot as terminal `command-failed`. An untracked nested repository in the parent fails it as terminal `file-read-failed`.

Issue #1126 also asked for anchors stored where the agent cannot write. With a shell running as the same user, no such location exists, and the guard is an observation gate, not a control against an agent trying to evade it. Pre-observer redirects and ignore-rule hiding therefore become documented limits, not deferred work.

## Terms

- **Submodule state:** `uninitialized` (no checkout), `unborn` (a checkout with no commit), or `initialized` (a checkout with a HEAD commit).
- **Walked repository:** an initialized or unborn submodule, or an untracked nested repository, whose files the snapshot reads.
- **Pin:** the toplevel, git dir and common dir recorded for a walked repository and compared on later snapshots.

## Requirements Trace

- R1. Honest edits inside a walked repository (tracked edit, untracked file, staged edit with the worktree edited, nested submodule edit) change the worktree digest and make commit closure false. A clean walked repository leaves closure unchanged.
- R2. Walked repositories use the parent's raw-byte reader, path-set rules, ignore-source hashing, read-race checks and final pass. Identity never comes from git's index or filters.
- R3. Files, gitlinks and bytes across the parent and every walked repository count against one shared budget. The caps do not change. Limit hits use the existing recoverable snapshot block.
- R4. An unborn submodule is available and not closed. An uninitialized submodule keeps today's behavior.
- R5. A walked repository's pin is captured the first time it is seen, compared on every later snapshot and in the final pass, and never updated. A mismatch is terminal `target-unavailable`.
- R6. An untracked nested repository in the parent or in a walked repository is walked, not terminal. It always makes closure false.
- R7. Errors inside a walked repository use the parent's reason codes. No new reason code is added.
- R8. Docs state the new behavior, the cost and the remaining limits, and the guidance tells the agent that submodule contents count toward the limits.
- R9. Every new check fails a named test when removed. Tests assert spawn counts, not wall time.

## Scope Boundaries

- No anchors stored outside the session, and no ignore-rule policy. Redirects made before a repository is first seen, a restart emptying the pins, removing and recreating a repository to re-pin it, and ignore rules (a committed `.gitignore`, `info/exclude`, `core.excludesFile`, a submodule's own `info/exclude`) hiding work are documented limits.
- No change to caps, to the guard's set of recoverable reasons, or to the remote snapshot.
- Ignored files, including ignored nested repositories, stay outside the digest.
- Errors that are terminal in the parent stay terminal inside a walked repository: non-UTF-8 filenames, an invalid `info/exclude`, paths over the length limit, a populated directory without a checkout.

## Context & Research

### Relevant Code and Patterns

- `readWorktreeSnapshot`, `readWorktreeListings`, `appendPathFact`, `runFinalPass`, `deriveCommitClosure`, `readRepositoryAnchor`, `readIgnoreSources`, `checkAncestorDirectories` in `src/lib/opencode-operation-observer.ts`. `RepositoryContext` already carries a command directory, worktree root, `info/exclude` path and pin, so the walk can reuse the snapshot body per repository.
- Gitlink handling today: `appendSubmoduleFact` → `inspectGitlink` → `readInitializedGitlink` (one `rev-parse --show-toplevel --verify -q HEAD` with the submodule as cwd), `verifyGitlinkUnchanged` in the final pass, `findDisplacedGitlinks`, the pre-spawn `maxGitlinks` check.
- `SnapshotBudget` is shared by reference for bytes only. `maxFiles` and `maxGitlinks` are checked once against the parent path set.
- `WORKTREE_DIGEST_DOMAIN` is `worktree:v3`. `hashField` frames every variable field.
- The guard's recoverable reasons are `file-limit`, `file-output-limit`, `command-output-limit` and `worktree-unstable` (`src/lib/opencode-workflow-guard.ts`).
- Tests: `tests/unit/opencode-operation-observer.test.ts` helpers `createSubmoduleSource`, `addSubmodule`, `stageGitlinks`, `closureOf`, `digestOf`, `interceptingRunner`, `recordingRunner`; the "gitlink hardening" and commit-closure describes; seven pinned worktree digests in the characterization test.

### Institutional Learnings

- `docs/solutions/logic-errors/operation-observer-false-clean-worktree-2026-10-15.md`: raw-byte identity, path-set and race rules, length-prefixed framing; a domain-tag bump makes in-progress receipts stale once, retryably.
- `docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`: limit hits block the unit and clear on a clean snapshot; caps are not raised.
- `docs/solutions/best-practices/a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md`: mutation-prove each new check.
- `docs/solutions/workflow-issues/stop-patching-after-second-review-round-2026-10-15.md`: keep the scope narrow and cut rather than patch a second round.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib/opencode-operation-observer.ts, src/lib/opencode-workflow-guard.ts (snapshot-blocking reasons), tests/unit/opencode-operation-observer.test.ts, ARCHITECTURE.md local observer snapshot section",
  "freshness": {
    "vcs_reference": "e70b070720c06868d5ad7cb90455c9d039faaa15"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 12,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:readWorktreeSnapshot, readWorktreeListings, appendPathFact, runFinalPass",
      "description": "The hardened per-repository snapshot body: path set, raw-byte facts, race checks and final pass",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:RepositoryContext",
      "description": "Per-repository command directory, worktree root, info/exclude path and pin",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:readRepositoryAnchor",
      "description": "One rev-parse yielding toplevel, git dir, info/exclude path, inside-worktree, common dir and HEAD, including unborn",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:inspectGitlink, readInitializedGitlink, verifyGitlinkUnchanged",
      "description": "Gitlink state detection and HEAD-only final-pass recheck",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:SnapshotBudget",
      "description": "Byte budget shared by reference across the snapshot",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:deriveCommitClosure",
      "description": "Closure from records against the HEAD tree",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:captureRootPin, verifyAnchorUnchanged",
      "description": "Parent pin captured at construction and compared per snapshot and in the final pass",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "tests/unit/opencode-operation-observer.test.ts:addSubmodule, createSubmoduleSource, closureOf, digestOf, recordingRunner",
      "description": "Real-git submodule fixtures and spawn-recording runner",
      "disposition": "reuse"
    }
  ]
}
```

## Key Technical Decisions

- **Reuse the snapshot body per walked repository.** Each walked repository gets its own root, command directory, pin, HEAD, ignore sources and ancestor set. Records stay repository-relative and are not added to the parent's record list, because the parent's closure compares records with the parent HEAD tree.
- **Recurse, bounded by the shared gitlink cap.** A nested submodule is walked like any other. Digesting nested submodules by HEAD only would reintroduce the blind spot.
- **One shared budget.** Files, gitlinks and bytes count across every walked repository. Each repository's file count is checked before its reads. The 32-gitlink check for nested levels runs when they are discovered, so "file-limit before any spawn" holds for the top level only.
- **Explicit submodule state.** The observation carries `uninitialized`, `unborn` or `initialized`. The first-pass check uses `readRepositoryAnchor`, which handles an unborn HEAD, and requires the path to be inside a work tree whose toplevel is the path. An unborn submodule hashes a distinct literal.
- **Fold at the gitlink.** At the gitlink's sorted position the parent hashes the gitlink fields and then the walked repository's digest. The domain tag becomes `worktree:v4`. Every repository's digest changes, so units in progress during the upgrade get one retryable `stale-receipt`.
- **Closure composes.** Closed means the parent is closed over its own records, every walked submodule is closed against its own HEAD tree, and every submodule HEAD equals the parent HEAD tree's gitlink id. An unborn submodule or any untracked nested repository makes it false. A dirty walked repository is not a failure: it is available, not closed, with a changed digest.
- **Untracked nested repositories are walked.** They appear in the untracked listing as a directory entry. They are walked with the same walker and always make closure false.
- **Pins are keyed by the path chain from the top root.** They are staged during the walk and committed only when the whole snapshot succeeds. After a success, pins for repositories not walked in that snapshot are dropped. A mismatch is terminal `target-unavailable`, as for the parent. A pin is never updated.
- **The walked repository's final pass replaces the HEAD-only recheck.** It checks ignore sources, ancestors, observations (recursively), listings, then the anchor, comparing the pin before HEAD. `inspectGitlink` stays for absent and uninitialized states.
- **Accept the cost.** About 9 net spawns (about +42 ms) per walked repository, plus about 35 ms per 1,000 files, measured on this repository. No cap on walked repositories, and no listing merge. Tests assert spawn counts.
- **No new reason codes, and no fields added to `WorktreeRecord`.** Walked-repository data travels in a separate structure, because existing tests compare the record shape exactly.

## Open Questions

### Resolved During Planning

- Scope: submodule and nested-repository walk plus documented limits, one PR, no new issues, close #1126 (confirmed).
- Terminal errors inside walked repositories, shared limits, terminal pin mismatch, accepted cost (confirmed).

### Deferred to Implementation

- The exact shape of the walked-repository structure and how its state reaches the final pass.
- How an untracked nested repository is recognized in the listing output; it must be distinguished from an untracked plain directory.

## Implementation Units

- [ ] **Unit 1: Shared budget and explicit submodule state**

**Goal:** Budget counts files and gitlinks cumulatively, and an unborn submodule is available instead of terminal.

**Requirements:** R3, R4, R7, R9

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-operation-observer.ts`
- Test: `tests/unit/opencode-operation-observer.test.ts`

**Approach:**
- Extend the shared budget to files, gitlinks and bytes.
- Inspect a gitlink through `readRepositoryAnchor` and carry an explicit state. Hash `unborn` distinctly.
- An unborn submodule makes closure false.

**Execution note:** Test-first. The unborn-submodule test must fail on the current observer.

**Patterns to follow:** the parent's unborn-HEAD handling in `deriveCommitClosure`; the existing gitlink-limit `test.each`.

**Test scenarios:**
- Happy path: an initialized submodule whose checkout has no commit is available, not closed, and digests differently from an uninitialized one.
- Edge case: a gitlink that changes from uninitialized to unborn between the first pass and the final pass is `worktree-unstable`.
- Edge case: the existing limit tests (count over `maxGitlinks` fails before any spawn; exactly 32 is within limit) stay green.
- Error path: a populated directory without a checkout stays `file-read-failed`.

**Verification:** observer tests pass; removing the explicit state or the unborn literal fails a named test.

- [ ] **Unit 2: Walk submodule contents into the digest and closure**

**Goal:** Honest edits inside an initialized or unborn submodule, at any depth, change the digest and make closure false.

**Requirements:** R1, R2, R3, R7, R9

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/opencode-operation-observer.ts`
- Test: `tests/unit/opencode-operation-observer.test.ts`

**Approach:**
- Run the snapshot body for each walked submodule with its own context. Fold its digest at the gitlink position. Bump the domain tag to `worktree:v4`.
- Compose closure as described in Key Technical Decisions.
- Replace the HEAD-only final-pass recheck with the walked repository's own final pass.
- Recapture the seven pinned characterization digests. Pin the submodule's `.git/info/exclude` in the fixtures, because its template varies by git version.

**Execution note:** Test-first. Each dirty-submodule test must fail on the current observer.

**Patterns to follow:** `readWorktreeSnapshot` and `runFinalPass`; the real-submodule closure test in the commit-closure describe.

**Test scenarios:**
- Happy path: a tracked edit inside an initialized submodule changes the digest and makes closure false; restoring it restores both.
- Happy path: an untracked file inside a submodule does the same.
- Happy path: a staged edit with the worktree also edited does the same. A staged-only edit whose worktree bytes equal HEAD stays closed.
- Happy path: an edit inside a nested submodule changes the digest and makes closure false.
- Edge case: a clean submodule at the committed commit stays closed; a moved submodule HEAD stays not closed.
- Edge case: a file ignored inside the submodule stays outside the digest; an edit to the submodule's `info/exclude` changes the digest.
- Edge case: submodule files count toward `maxFiles` and bytes toward `maxTotalFileBytes`. Going over gives `file-limit` / `file-output-limit` with the parent under its own limit.
- Edge case: a submodule file that changes between the first pass and the final pass is `worktree-unstable`.
- Integration: an embedded `.git` directory submodule, an absorbed (`modules/`) submodule and a submodule of a linked worktree are all walked.
- Integration: net spawn count per walked submodule matches the expected count.

**Verification:** observer tests pass; removing the fold, the sub-closure term, the shared file count, or the walked final pass each fails a named test.

- [ ] **Unit 3: Pins for walked repositories**

**Goal:** A walked repository whose toplevel, git dir or common dir changes after it was first seen is detected, without false failures for repositories that legitimately appear or disappear.

**Requirements:** R5, R9

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/opencode-operation-observer.ts`
- Test: `tests/unit/opencode-operation-observer.test.ts`

**Approach:**
- Key pins by path chain, stage them during the walk, commit them on whole-snapshot success, and drop pins for repositories not walked in that snapshot. Compare in the first pass and the final pass. Never update on mismatch.

**Execution note:** Test-first, through `createOpencodeOperationObserver` (the records test hook keeps no state).

**Test scenarios:**
- Happy path: retargeting a submodule's gitfile to another admin directory between snapshots gives `target-unavailable`.
- Edge case: a submodule removed in one snapshot and added back in a later one is pinned again without failing.
- Edge case: a snapshot that fails partway commits no new pins.
- Edge case: a redirect between a submodule's first pass and final pass gives `target-unavailable`.

**Verification:** observer tests pass; removing the comparison, the staging or the sweep fails a named test.

- [ ] **Unit 4: Walk untracked nested repositories**

**Goal:** An untracked nested repository in the parent or in a walked repository is walked instead of failing the snapshot.

**Requirements:** R6, R9

**Dependencies:** Unit 3

**Files:**
- Modify: `src/lib/opencode-operation-observer.ts`
- Test: `tests/unit/opencode-operation-observer.test.ts`

**Approach:**
- Recognize the nested repository from the untracked listing, walk it with the same walker and pins, and make closure false.
- Update the existing test that pins the parent case as `file-read-failed`.

**Execution note:** Test-first. The parent nested-repository test must flip from `file-read-failed` to available.

**Test scenarios:**
- Happy path: an untracked nested repository in the parent is available, not closed, and an edit inside it changes the digest.
- Happy path: an untracked nested repository inside a submodule is walked the same way.
- Edge case: an untracked plain directory keeps today's behavior.
- Edge case: an ignored nested repository stays outside the digest.
- Edge case: nested repositories count toward the shared gitlink and file budgets.

**Verification:** observer tests pass; removing the recognition fails a named test.

- [ ] **Unit 5: Guard path for a submodule over the limits**

**Goal:** Show that a submodule pushing the repository over a limit blocks the unit and that the block clears once it shrinks.

**Requirements:** R3, R9

**Dependencies:** Unit 2

**Files:**
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Drive the guard with a real observer over a fixture whose submodule exceeds a lowered file limit, then shrink it through an unobserved operation and refresh status.

**Test scenarios:**
- Integration: the unit is blocked with `file-limit`; after the submodule shrinks, status clears the block and the unit completes.
- Integration: a dirty submodule makes the commit operation's observed closure false (model on "projects observer commitClosure through the operation observation").

**Verification:** guard tests pass.

- [ ] **Unit 6: Docs and guidance**

**Goal:** Docs describe the walk, its cost and its limits, and the guidance names submodule contents in the limit recovery.

**Requirements:** R8

**Dependencies:** Units 1–5

**Files:**
- Modify: `ARCHITECTURE.md` (local observer snapshot section)
- Modify: `docs/solutions/logic-errors/operation-observer-false-clean-worktree-2026-10-15.md`
- Modify: `docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`
- Modify: `docs/solutions/workflow-issues/stop-patching-after-second-review-round-2026-10-15.md`
- Modify: `skills/using-systematic/SKILL.md`
- Modify: `tests/unit/bootstrap.test.ts` (byte pin and snapshot)
- Modify: `docs/plans/2026-10-14-002-fix-observer-false-clean-plan.md` (the upgrade sentence that says "unavailable")

**Approach:**
- Describe the walk, closure composition, pins, cost and the `worktree:v4` upgrade effect.
- Replace "#1126 open" statements with the documented limits: pre-first-sighting redirects, restart emptying pins, remove-and-recreate re-pinning, ignore-rule hiding, terminal errors inside walked repositories, the shared limits, and closure now counting CRLF, `core.filemode=false`, sparse-checkout and scratch files inside submodules.
- Add one clause to the guidance: submodule and nested-repository contents count toward the snapshot limits.

**Test expectation:** the bootstrap pin test changes with the guidance; no behavior test.

**Verification:** markdownlint, `bun scripts/content-integrity.ts` and the bootstrap test pass.

## System-Wide Impact

- **Interaction graph:** every snapshot (operation hooks, status refresh, completion, plugin init, child rollup) pays the walk.
- **Error propagation:** limit hits and races block recoverably; pin mismatches and parent-terminal errors stay terminal.
- **State lifecycle risks:** pins live in the observer instance and are emptied by a restart.
- **Unchanged invariants:** caps, the guard's recoverable reasons, raw-byte identity, ignored content outside the digest, remote snapshots.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A large submodule blocks a repository permanently | Accepted. The guidance names it, and the guard-level test proves the block clears once the repository is under the limit. |
| Snapshot cost grows with submodule count (about 1.7 s at 32) | Accepted and documented; spawn counts are asserted. |
| Legitimate layout changes trip a pin | Pins are staged, committed only on success, swept when a repository disappears, and keyed by path chain. Absorbed, embedded and linked-worktree layouts are tested. |
| The domain-tag bump stales every in-progress unit once | Retryable `stale-receipt`; stated in the PR body and docs. |

## Sources & References

- Issue: #1126 (with Fro Bot's triage). Related: #1099, #1124, #1095.
- Related code: `src/lib/opencode-operation-observer.ts`, `src/lib/opencode-workflow-guard.ts`.
