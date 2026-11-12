---
title: Run state for a model-invoked helper is a lock held by the host, a rename as the commit, a deterministic slice, and a ledger that reopens on evidence
date: 2026-11-09
category: best-practices
module: ce-connect
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - "A skill drives a CLI helper through several short processes, and the helper must hold a lock across the model's turns between them"
  - "A run publishes an artifact and then updates an index, and a crash can fall between the two steps"
  - "A periodic sweep covers a corpus larger than one run's bounds"
  - "A dedup ledger is fed by nondeterministic model output and must not re-propose a rejected result"
tags: [lock, process-identity, atomic-rename, crash-recovery, ledger, rotation, ce-connect, model-invoked-cli]
---

# Run state for a model-invoked helper is a lock held by the host, a rename as the commit, a deterministic slice, and a ledger that reopens on evidence

## Context

The `ce:connect` helper (`src/ce-connect-helper.ts`) is a Node script that a skill runs as a series of separate commands: `begin`, then the researcher subagent, then `validate`, then `publish`. A model sits between the calls. Four design problems follow from that, and each had an obvious first answer that fails. This note records the answers that held. The failure of one of them in review is covered in [the post-commit failure doc](../logic-errors/post-commit-failure-left-the-committed-run-claiming-success-2026-11-09.md) and [the already-recorded ordering doc](../logic-errors/already-recorded-check-ran-before-ledger-reopen-2026-11-09.md).

## Guidance

### 1. The lock holder is the host, not the shell

Each helper call is a short process, and the shell that launched it exits right away. A lock that records the helper's pid, or the shell's, would look dead the moment the call returned. `findHolderPid` walks up the process tree and records the nearest ancestor that is not a shell (`src/ce-connect-helper.ts:255-276`); the host outlives the run. If the host dies, the lock is reclaimable. If it lives on after a crashed run, `ledger unlock` is the manual escape.

The lock itself is a directory with a holder file (`src/lib/connect-state.ts:407-446`, `createLock`). The holder records pid, the process start time, and a `randomUUID` nonce. `judgeLock` decides what to do with an existing lock (`src/lib/connect-state.ts:457-495`):

- A dead pid is reclaimable.
- A live pid with a different start time is a reused pid, and is reclaimable.
- A live pid whose start time cannot be read, or a holder file with no start time, is busy (`holder-unverifiable`). Doubt means busy.
- A lock directory with no readable holder is busy for ten minutes (`HOLDERLESS_LOCK_MAX_AGE_MS`, `src/lib/connect-state.ts:50`), because it may be someone mid-acquire. After that it is reclaimable.

Reclaim is a rename, not a delete. `reclaimLock` moves the lock directory to a unique name, then checks that the directory it moved is the one it judged stale: the holder nonce must match, or for a holderless lock the age must still hold (`movedIsJudged`). If not, it moves the directory back and reports `reclaim-contended` (`src/lib/connect-state.ts:497-557`). Two reclaimers cannot both win, and a lock taken by someone else between the judgment and the move is not destroyed. `forceUnlock` is the manual escape and also renames before it removes (`src/lib/connect-state.ts:629-651`).

### 2. Publishing is one rename; the ledger follows

`publishRun` stages `runs/<id>.tmp/`, renames it to `runs/<id>/`, and only then rewrites the ledger (`src/lib/connect-state.ts:1448-1518`). The rename is the commit. A crash has two windows, and each leaves a state the next run can read:

- Before the rename: nothing is committed. The next run removes the leftover `.tmp` directory (`pruneRuns`) and proposes the candidate as new.
- After the rename and before the ledger write: the run exists, the ledger does not know its candidates, and the next run proposes them once more. After that the ledger suppresses them.

Test both windows with a real process killed by `SIGKILL`, not a thrown error. `PublishOptions.hooks` has `beforeCommit` and `afterCommit` seams, and the test child kills itself from them (`tests/unit/connect-kill-recovery.test.ts:1-20`, `SIGKILL`; the two cases are at lines 142 and 175). A simulated throw runs `finally` blocks and cleanup that a real kill never reaches.

### 3. When the corpus is bigger than a run, the helper chooses the slice

One run is bounded at 6 families of at most 8 rules each, so at most 48 rules (`CONNECT_BOUNDS` in `src/lib/connect-evidence.ts:51-68`). Letting the model pick which rules to examine inside that cap makes coverage depend on model choice, so nobody can say what a run has covered. The helper picks instead (`planOffer`, `src/lib/connect-helper-core.ts:519-557`):

- Order every rule: first those never covered, or whose file hash changed since they were covered, then covered rules from least recently covered to most recent.
- Inside each group, take one rule per project in turn (round-robin by project root, rules by path), so a slice spans projects.
- Offer the head of that order. The order depends only on the index and the coverage records, never on the model, so repeated runs sweep the whole index and wrap to the oldest.

Three rules keep this honest:

- Coverage is recorded only on commit, in the same ledger rewrite as the run (`applyCoverage`, `src/lib/connect-state.ts:1339-1399`). A run that fails to commit covers nothing.
- Only the offered rules must be covered. The rest of the index waits for a later run and is not a reason to degrade this one (`src/ce-connect-helper.ts:1713-1729`, `checkCoverage` is called with `snapshot.offer.offered`).
- A rule whose candidate was lost because its evidence changed during the run is held back and not counted as covered (`heldBackRuleIds` in the same span).

The digest carries a `Sweep:` line, covered X of Y rules and about N runs left (`renderSweepLine`, `src/lib/connect-helper-core.ts:611-620`), so a person can see that a clean run covers a slice and not the corpus. In a four-project evaluation set that included 12 planted documents, the ledger recorded all 376 indexed rules as covered over nine runs. That is bookkeeping from the researcher's self-report: the helper checks that a complete batch names every offered rule, not that each one was searched.

### 4. A ledger entry reopens on evidence, never on model variance

Three choices keep a nondeterministic researcher from re-proposing what a person already decided.

- **Rule ids come from the helper and depend on location only.** `ruleIdFor` hashes the project root and the relative path (`src/lib/connect-helper-core.ts:79-89`). An edited learning keeps its id, so it reopens its entry instead of creating a new one. A candidate must carry an id from the issued index (`unknown-rule-id`, in `parseHeader`, `src/lib/connect-helper-core.ts:1118-1145`) and the id must belong to one of its own sources (`rule-source-mismatch`, in `checkCandidate`, `src/lib/connect-helper-core.ts:1180-1245`), so the model cannot choose its own identity.
- **Identity excludes fingerprints.** `candidateIdentity` hashes kind, target, rule id and the normalized (role, path) of each source (`src/lib/connect-state.ts:767-785`). A changed file is the same entry.
- **Reopen only on a change both runs can see.** `classifyCandidate` compares source fingerprints, and compares target-evidence fingerprints only for paths that both the stored entry and the new candidate cite (`sameTargetEvidence`, `src/lib/connect-state.ts:1063-1072`). If nothing the two runs share changed, the standing is `suppressed` whatever the prior status (promoted, rejected or candidate). A changed source reopens as "sources changed" with a refresh pointer when the prior entry was promoted. A source with no fingerprint is `unresolved`, not `changed` (`src/lib/connect-state.ts:1103-1157`).

`ledger show` pages the ledger 500 entries at a time with `total` and `nextOffset` (`MAX_LEDGER_ENTRIES_SHOWN`, `src/ce-connect-helper.ts:2211-2250`).

## Why This Matters

Each wrong first answer fails quietly. A lock held by a short-lived pid is stolen by the next call. A publish that deletes before it renames can leave no run and no ledger. A model-chosen slice makes "covered" mean "the model felt like it". A ledger keyed on content re-proposes a lesson every time the researcher cites a different file. None of these raises an error in a single-process unit test.

## When to Apply

- A skill or command invokes a helper repeatedly across model turns and the helper needs mutual exclusion, an audit trail and recovery.
- A pipeline commits an artifact and then updates an index, and the index may lag the artifact.
- A scheduled or repeated process must cover more input than one run can bear, and coverage should be explainable.
- A ledger deduplicates results of a nondeterministic process.

## Examples

An unreadable start time returns `holder-unverifiable`, not a reclaim (`judgeLock`, `src/lib/connect-state.ts:457-495`).

## Related

- [Match filesystem safety evidence to the operation](./match-filesystem-safety-evidence-to-the-operation-2026-09-10.md): the same helper's reads are contained by operation.
- [An async read that commits on return must detect any change made while it waited](./async-commit-aba-version-fence-2026-10-15.md): adjacent state-fence design for in-process commits.
