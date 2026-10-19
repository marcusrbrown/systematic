---
title: "fix: Observe the contents of submodules and nested repositories in the local snapshot"
type: fix
status: superseded
date: 2026-10-18
superseded_by: docs/solutions/best-practices/workflow-guard-removed-2026-10-19.md
superseded_date: 2026-10-19
---

> **Superseded (2026-10-19):** the operation observer this plan describes was removed with the workflow guard ([#1153](https://github.com/marcusrbrown/systematic/issues/1153)); see [the decision note](../solutions/best-practices/workflow-guard-removed-2026-10-19.md). The body below is preserved as history.

# fix: Observe the contents of submodules and nested repositories in the local snapshot

## Overview

The local snapshot will read the files inside initialized and unborn submodules, and inside untracked nested repositories, with the same hardened reader, budget and checks it uses for the parent. Honest edits inside them will change the worktree digest and make commit closure false. An uninitialized submodule will count as closed, so commit receipts can mint after a plain clone or in a new linked worktree. Redirects and ignore rules that hide work are documented as limits of an observation gate. This closes #1126.

## Problem Frame

The operation observer (`src/lib/opencode-operation-observer.ts`) digests an initialized submodule by its path and HEAD only. A probe at e70b0707 confirmed it: editing a tracked file inside an initialized submodule leaves the worktree digest unchanged and `commitClosure: true`. An unborn submodule fails the whole snapshot as terminal `command-failed`. An untracked nested repository fails it as terminal `file-read-failed`. An uninitialized submodule makes closure false, so a commit receipt never mints after a clone without `--recurse-submodules`, after `deinit`, or in a linked worktree created with `git worktree add`.

Issue #1126 also asked for anchors stored where the agent cannot write. With a shell running as the same user, no such location exists, and the guard is an observation gate, not a control against an agent trying to evade it. Redirects of a repository's root or admin directory, and ignore rules that hide work, become documented limits.

## Terms

- **Submodule state:** `uninitialized` (no checkout), `unborn` (a checkout with no commit), or `initialized` (a checkout with a HEAD commit).
- **Walked repository:** an initialized or unborn submodule, or an untracked nested repository, whose files the snapshot reads.
- **Anchor:** the toplevel, git dir, common dir and HEAD that `readRepositoryAnchor` reports for a repository.
- **Nested submodule** is a submodule inside a submodule. **Untracked nested repository** is a git checkout under a tracked directory that no gitlink records.

## Requirements Trace

- R1. Honest edits inside a walked repository (a tracked edit, an untracked file, a staged edit with the worktree also edited, an edit in a nested submodule) change the worktree digest and make commit closure false. A clean initialized submodule at the parent's recorded commit leaves closure unchanged.
- R2. Paths may come from git's index and listings; file identity comes only from raw bytes. Walked repositories use the parent's path-set rules, ignore-source hashing, read-race checks and final pass.
- R3. Files, gitlinks and bytes across the parent and every walked repository count against one shared budget. Caps do not change. Limit hits use the existing recoverable snapshot block.
- R4. An unborn submodule is available and not closed. An uninitialized submodule is closed when the parent is, and keeps a digest distinct from an initialized one.
- R5. A walked repository whose anchor changes between its first pass and its final pass is `worktree-unstable`. A walked repository whose toplevel is not its own path stays `file-read-failed`.
- R6. An untracked nested repository in the parent or in a walked repository is walked, not terminal, and always makes closure false.
- R7. Errors inside a walked repository use the parent's reason codes. No new reason code is added.
- R8. Docs state the new behavior, the cost and the remaining limits. The guidance tells the agent that submodule and nested-repository contents count toward the limits.
- R9. Every new check fails a named test when removed. Tests assert spawn counts, not wall time.

## Scope Boundaries

- No anchors stored across snapshots or restarts, and no ignore-rule policy. A redirect of a repository's root or admin directory between snapshots, and ignore rules (a committed `.gitignore`, `info/exclude`, `core.excludesFile`, a submodule's own `info/exclude`) hiding work, are documented limits.
- No change to caps, to the guard's set of recoverable reasons, or to the remote snapshot.
- Ignored files, including ignored nested repositories, stay outside the digest.
- Errors that are terminal in the parent stay terminal inside a walked repository: non-UTF-8 filenames, an invalid `info/exclude`, paths over the length limit, a populated directory without a checkout, a tracked directory replaced by a symlink. Recovery is changing that repository or disabling the guard.
- Clean states that differ from HEAD in raw bytes stay not closed inside a walked repository, as in the parent: sparse checkout, `core.filemode=false`, line-ending conversion. Commit receipts do not mint in such a repository.

## Context & Research

### Relevant Code and Patterns

- `readWorktreeSnapshot`, `readWorktreeListings`, `appendPathFact`, `runFinalPass`, `deriveCommitClosure`, `readRepositoryAnchor`, `readIgnoreSources`, `checkAncestorDirectories` in `src/lib/opencode-operation-observer.ts`. `RepositoryContext` carries a command directory, worktree root, `info/exclude` path and pin, but `readWorktreeSnapshot` creates its own budget, hash and verified-directory set per call.
- Gitlink handling today: `appendSubmoduleFact` → `inspectGitlink` (the `.git` stat, emptiness check and toplevel-equals-path check) → `readInitializedGitlink`; `verifyGitlinkUnchanged` in the final pass; `findDisplacedGitlinks`; the pre-spawn `maxGitlinks` check.
- The untracked listing prints a nested repository as `name/` with a trailing slash. Plain directories never appear that way, and an empty `.git` directory is listed as plain files. The self-ignored `.gitignore` filter already relies on the same convention.
- `WORKTREE_DIGEST_DOMAIN` is `worktree:v3`. `hashField` frames every variable field.
- The guard's recoverable reasons are `file-limit`, `file-output-limit`, `command-output-limit` and `worktree-unstable` (`src/lib/opencode-workflow-guard.ts`).
- Tests: `tests/unit/opencode-operation-observer.test.ts` helpers `addSubmodule` (absorbed layout), `createSubmoduleSource`, `createRegisteredWorktreeFixture`, `stageGitlinks`, `closureOf`, `digestOf`, `recordingRunner`, `setExcludesFile`; the characterization fixture's embedded gitlink; the "gitlink hardening" and commit-closure describes; seven pinned worktree digests.

### Institutional Learnings

- `docs/solutions/logic-errors/operation-observer-false-clean-worktree-2026-10-15.md`: raw-byte identity, path-set and race rules, length-prefixed framing; a domain-tag bump makes in-progress receipts stale once, retryably.
- `docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`: limit hits block the unit and clear on a clean snapshot; caps are not raised.
- `docs/solutions/best-practices/a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md`: mutation-prove each new check.
- `docs/solutions/workflow-issues/stop-patching-after-second-review-round-2026-10-15.md`: one review round, then cut rather than patch.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib/opencode-operation-observer.ts, src/lib/opencode-workflow-guard.ts (snapshot-blocking reasons), tests/unit/opencode-operation-observer.test.ts, ARCHITECTURE.md local observer snapshot section",
  "freshness": {
    "vcs_reference": "95d65b9e"
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
      "description": "Per-repository command directory, worktree root and info/exclude path",
      "disposition": "extend"
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
      "description": "Byte budget shared by reference within one snapshot call",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts:deriveCommitClosure",
      "description": "Closure from records against the HEAD tree",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "tests/unit/opencode-operation-observer.test.ts:addSubmodule, createSubmoduleSource, createRegisteredWorktreeFixture, closureOf, digestOf, recordingRunner",
      "description": "Real-git submodule fixtures and spawn-recording runner",
      "disposition": "reuse"
    }
  ]
}
```

## Key Technical Decisions

- **One walk state per snapshot.** `snapshot()` creates one state holding the byte, file and gitlink counts and passes it down. Each walked repository runs the snapshot body with its own root, command directory, HEAD, ignore sources and verified-directory set, and returns its digest, closure inputs, head and first-pass state. Its records stay repository-relative and outside the parent's record list, and `WorktreeRecord` gains no fields.
- **Recurse.** Nested submodules and untracked nested repositories are walked the same way. Top-level and nested gitlinks share `maxGitlinks`. Each repository's file count is checked before its reads, so "file-limit before any spawn" holds for the top level only.
- **Explicit submodule state.** `inspectGitlink` keeps its `.git` stat and toplevel-equals-path check, which stop an empty `.git` from resolving to the parent. It then reads the anchor through `readRepositoryAnchor`, which handles an unborn HEAD.
- **Fold at the gitlink.** At the gitlink's sorted position the parent hashes the gitlink fields, the state, and for a walked submodule its digest. The domain tag becomes `worktree:v4`. Every repository's digest changes, so units in progress during the upgrade get one retryable `stale-receipt`.
- **Closure composes.** Closed means the parent is closed over its own records; every initialized submodule is closed against its own HEAD tree and its HEAD equals the parent HEAD tree's gitlink id; no submodule is unborn; and no untracked nested repository exists. An uninitialized submodule counts as matching its HEAD gitlink. A dirty walked repository is not a failure: it is available, not closed, with a changed digest.
- **No anchors across snapshots.** A walked repository's anchor is compared between its own first pass and final pass only. A change is `worktree-unstable`. Pinning across snapshots would turn `git submodule absorbgitdirs` and module renames into terminal failures, and would only defend against deliberate redirects.
- **The walked repository's final pass replaces the HEAD-only recheck.** Order: ignore sources, ancestors, observations (recursively), listings, then the anchor. `inspectGitlink` stays for absent and uninitialized states.
- **Accept the cost.** About 9 net spawns per walked repository, plus about 35 ms per 1,000 files, measured on 60-file fixtures with git 2.56. No cap on walked repositories and no listing merge. Tests assert spawn counts. Before merge, measure a realistic submodule of about 2,000 files and record it in the docs.
- **No new reason codes.**

## Open Questions

### Resolved During Planning

- Scope, the terminal-error and shared-limit policy, the cost, dropping cross-snapshot anchors, and closing uninitialized submodules (confirmed).

### Deferred to Implementation

- The exact shape of the walk state and of the walked-repository result.

## Implementation Units

- [x] **Unit 1: Walk state and explicit submodule state**

**Goal:** One budget per snapshot, an explicit submodule state, an unborn submodule available instead of terminal, and an uninitialized submodule closed.

**Requirements:** R3, R4, R5, R7, R9

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-operation-observer.ts`
- Test: `tests/unit/opencode-operation-observer.test.ts`

**Approach:**
- Create the walk state in `snapshot()` and thread it through the snapshot body.
- Carry the submodule state on the observation and hash it. Read the anchor through `readRepositoryAnchor` after the existing checks.
- Treat an uninitialized submodule as matching its HEAD gitlink in closure. An unborn submodule makes closure false.

**Execution note:** Test-first. The unborn-submodule and uninitialized-closure tests must fail on the current observer.

**Patterns to follow:** the parent's unborn-HEAD handling in `deriveCommitClosure`; the existing gitlink-limit `test.each`.

**Test scenarios:**
- Happy path: an unborn submodule is available, not closed, and digests differently from an uninitialized one.
- Happy path: a repository whose only difference from HEAD is an uninitialized submodule is closed.
- Edge case: a gitlink that changes from uninitialized to unborn between the first pass and the final pass is `worktree-unstable`.
- Control: the gitlink-count limit fails before any spawn, and exactly 32 is within the limit.
- Error path: a populated directory without a checkout, and an empty `.git` directory, stay `file-read-failed`.

**Verification:** observer tests pass; removing the state, the unborn literal or the uninitialized closure rule fails a named test.

- [x] **Unit 2: Walk submodule contents into the digest and closure**

**Goal:** Honest edits inside an initialized or unborn submodule, at any depth, change the digest and make closure false.

**Requirements:** R1, R2, R3, R5, R7, R9

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/opencode-operation-observer.ts`
- Test: `tests/unit/opencode-operation-observer.test.ts`

**Approach:**
- Walk each initialized or unborn submodule, fold its digest at the gitlink, and bump the domain tag to `worktree:v4`.
- Compose closure as in Key Technical Decisions.
- Replace the HEAD-only recheck with the walked repository's final pass, including the anchor comparison.
- In `buildCharacterizationFixture` and every `addSubmodule` caller, set each submodule's own `core.excludesFile` and pin its `info/exclude`, so recaptured digests do not depend on the machine. Recapture the seven pinned digests.

**Execution note:** Test-first. Each discriminating test must fail on the current observer.

**Patterns to follow:** `readWorktreeSnapshot` and `runFinalPass`; the real-submodule closure test in the commit-closure describe.

**Test scenarios:**
- Happy path: a tracked edit inside an initialized submodule changes the digest and makes closure false; restoring it restores both.
- Happy path: an untracked file inside a submodule does the same.
- Happy path: a staged edit with the worktree also edited does the same.
- Happy path: an edit inside a nested submodule does the same.
- Edge case: two submodules each under `maxFiles` but together over it give `file-limit`; together over the byte limit give `file-output-limit`.
- Edge case: a nested gitlink pushing the total over `maxGitlinks` gives `file-limit`.
- Edge case: an edit to the submodule's `info/exclude` changes the digest.
- Edge case: a submodule file that changes between the first pass and the final pass is `worktree-unstable`.
- Edge case: a submodule whose git dir changes between its first pass and its final pass is `worktree-unstable`.
- Error path: a non-UTF-8 tracked filename, an invalid `info/exclude`, and a path over the length limit inside a submodule are `file-read-failed`.
- Integration: an embedded `.git` submodule, an absorbed submodule and a submodule of a linked worktree are all walked; `git submodule absorbgitdirs` between two snapshots changes nothing but the record of where the admin directory lives and does not fail.
- Integration: the net spawn count per walked submodule matches the expected count.
- Control: a staged-only edit whose worktree bytes equal HEAD stays closed; a clean submodule at the recorded commit stays closed; a submodule HEAD that differs from the parent's gitlink is not closed; a file ignored inside a submodule stays outside the digest.

**Verification:** observer tests pass; removing the fold, the sub-closure term, the shared file count, the walked final pass or the anchor comparison each fails a named test.

- [x] **Unit 3: Walk untracked nested repositories**

**Goal:** An untracked nested repository in the parent or in a walked repository is walked instead of failing the snapshot.

**Requirements:** R6, R9

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/opencode-operation-observer.ts`
- Test: `tests/unit/opencode-operation-observer.test.ts`

**Approach:**
- Recognize a trailing-slash entry in the untracked listing as a nested repository, walk it, and make closure false.
- Update the existing test that pins the parent case as `file-read-failed`.

**Execution note:** Test-first. The parent nested-repository test must flip.

**Test scenarios:**
- Happy path: an untracked nested repository in the parent is available, not closed, and an edit inside it changes the digest.
- Happy path: an untracked nested repository inside a submodule is walked the same way.
- Edge case: nested repositories count toward the shared gitlink and file budgets.
- Control: an ignored nested repository stays outside the digest; untracked files in a plain directory keep today's behavior.

**Verification:** observer tests pass; removing the recognition fails a named test.

- [x] **Unit 4: Guard path for submodules**

**Goal:** Show the guard-level effects: a submodule over a limit blocks and then clears, and a dirty submodule keeps a commit from closing.

**Requirements:** R1, R3, R9

**Dependencies:** Unit 2

**Files:**
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Drive the guard with a real observer and a lowered file limit. Shrink the submodule with a direct filesystem write between hook calls, then refresh status.

**Test scenarios:**
- Integration: the unit is blocked with `file-limit`; after the submodule shrinks, status clears the block and the unit completes.
- Integration: a dirty submodule makes the commit operation's observed closure false (model on "projects observer commitClosure through the operation observation").

**Verification:** guard tests pass.

- [x] **Unit 5: Docs and guidance**

**Goal:** Docs describe the walk, its cost and its limits, and the guidance names submodule contents in the limit recovery.

**Requirements:** R8

**Dependencies:** Units 1–4

**Files:**
- Modify: `ARCHITECTURE.md` (local observer snapshot section)
- Modify: `docs/solutions/logic-errors/operation-observer-false-clean-worktree-2026-10-15.md`
- Modify: `docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`
- Modify: `docs/solutions/workflow-issues/stop-patching-after-second-review-round-2026-10-15.md`
- Modify: `skills/using-systematic/SKILL.md`
- Modify: `tests/unit/bootstrap.test.ts` and `tests/unit/__snapshots__/bootstrap.test.ts.snap`
- Modify: `docs/plans/2026-10-14-002-fix-observer-false-clean-plan.md` (the upgrade sentence that says "unavailable")

**Approach:**
- Describe the walk, closure composition, the uninitialized rule, the within-snapshot anchor check, the measured cost and the `worktree:v4` upgrade effect.
- Replace "#1126 open" statements with the documented limits listed in Scope Boundaries.
- Add one clause to the guidance: submodule and nested-repository contents count toward the snapshot limits. Keep the line `IF A SKILL APPLIES TO YOUR TASK…` intact.

**Test expectation:** the bootstrap pin and snapshot change with the guidance; no behavior test.

**Verification:** markdownlint, `bun scripts/content-integrity.ts` and the bootstrap test pass.

## System-Wide Impact

- **Interaction graph:** every snapshot (operation hooks, status refresh, completion, plugin init, child rollup) pays the walk, and all of it runs through `spawnSync`.
- **Error propagation:** limit hits and races block recoverably; parent-terminal errors stay terminal.
- **Unchanged invariants:** caps, the guard's recoverable reasons, raw-byte identity, ignored content outside the digest, remote snapshots.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A large submodule blocks the unit until it shrinks; otherwise the user must disable the guard | Accepted. The guidance names it, and Unit 4 proves the block clears. |
| Snapshot cost grows with submodule count | Accepted, measured on a realistic submodule before merge, documented; spawn counts asserted. |
| Third-party submodule content with a non-UTF-8 or over-length path makes the guard unavailable | Accepted and documented in Scope Boundaries, with named tests. |
| The domain-tag bump stales every in-progress unit once | Retryable `stale-receipt`; documented in Unit 5. |

## Sources & References

- Issue: #1126 (with Fro Bot's triage). Related: #1099, #1124, #1095.
- Related code: `src/lib/opencode-operation-observer.ts`, `src/lib/opencode-workflow-guard.ts`.
