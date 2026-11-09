---
title: A failure after the commit point left the committed run claiming success, and a failed step could leave the lock held
date: 2026-11-09
category: logic-errors
module: ce-connect
problem_type: logic_error
component: tooling
symptoms:
  - "The committed digest and run record said `Outcome: complete` while the reply said `Connect degraded` because the ledger could not be written"
  - "A ledger that grew past 16 MiB was written successfully and then could not be read back"
  - "A degraded run that could not read one project dropped that project's coverage records, so the sweep repeated work"
  - "An invalid `validate` request left the run's lock held, and the next `begin` answered busy until `ledger unlock`"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [ce-connect, two-phase-publish, commit-point, post-commit-failure, lock-release, ledger, truthful-artifacts]
---

# A failure after the commit point left the committed run claiming success, and a failed step could leave the lock held

## Problem

`publish` commits a run by renaming `runs/<id>.tmp/` to `runs/<id>/`, then rewrites the ledger, then releases the lock. Everything after the rename can fail, and the first version had no way back to the artifact it had already committed. The run directory is what a person reads later, so it must not say `complete` when bookkeeping failed. The same family of mistake in a neighbouring path left the lock held.

## Symptoms

- With the ledger write failing after the rename, the helper's reply said `Connect degraded` with the reason `ledger-write-failed`. The committed `digest.md` said `Outcome: complete`, and `run.json` had `"outcome": "complete"`.
- The ledger was written without checking its size against the 16 MiB limit that the reader enforces (`MAX_LEDGER_BYTES`). Once it crossed the limit, `publish` reported success and every later read failed, and `ledger clear` was the only way out, which discards the history.
- A run that could not inventory one project published a partial rule index. The coverage update then dropped every coverage record that was absent from that index, including the unreadable project's, so when the project came back its rules looked new.
- An invalid `validate` request (a body that parsed, with `batches: 'not-a-list'`, for example) returned `invalid-request`. The lock taken at `begin` stayed held, and the next `begin` returned `busy`.

## What Didn't Work

- **Changing only the reply.** The first version set the final outcome to `degraded` after a ledger failure and rendered the summary from the model it had built before the commit. The reply and the files disagreed, and the files are what stay on disk.

## Solution

**Rewrite the committed artifacts to say what happened.** `commitRun` publishes, then if the ledger was not written it adds the degrade reason `ledger-write-failed`, rebuilds both files from the same model with the outcome `degraded`, and replaces them in place (`src/ce-connect-helper.ts:1883-1977`). The replacement is `rewriteRunFiles`: each file is written to a temporary name inside the run directory and renamed over the original, owner-only, and only for names already in the run (`src/lib/connect-state.ts:1522-1555`). The reply also carries `runRecordCurrent: false` if even the rewrite failed, so the caller knows the run directory may be stale.

**Check the size before replacing the ledger.** `writeLedger` serializes first and throws if the text is over the limit the reader accepts, so the file on disk stays the one that can be read (`src/lib/connect-state.ts:1007-1018`). `publishRun` turns that into `ledger: { written: false }`, which the step above reports. A `decide` that would grow the ledger past the limit fails with `write-failed` and keeps the old file.

**Prune coverage only where the run saw everything.** The coverage update carries three fields: the projects that were inventoried in full (`prunable`), rules whose files were skipped or changed (`retain`), and whether records with no project key may be dropped (`pruneUnattributed`). Ordinary pruning drops a record only if its rule is absent from a project that was read in full, and keeps records of incompletely inventoried projects. Records with no project key follow `pruneUnattributed`. If coverage exceeds its cap (`MAX_COVERAGE`, 20,000), the oldest records for rules not in the current index are still evicted (`applyCoverage`, `src/lib/connect-state.ts:1339-1399`; the scope is built in `scanAll`, `src/ce-connect-helper.ts:934-968`). A truncated inventory, or skipped files that cannot all be named, make a project not prunable.

**Say whether the lock was released, on every failure.** `releaseAndFail` releases the lock and puts `lockReleased` in the reply (`src/ce-connect-helper.ts:867-881`). A `validate` request that cannot be used but still names a valid lock handle goes through `refuseValidate`, which releases that lock (`src/ce-connect-helper.ts:1646-1670`). When the handle itself cannot be read, or the run or nonce is not the caller's, the reply says `lockReleased: false`. The skill acts on that field: it runs `ledger unlock` for its own run only when a failed `validate` does not confirm release (`skills/ce-connect/SKILL.md:156`, `skills/ce-connect/references/headless-and-outcomes.md:82`).

## Why This Works

A committed artifact is a statement to a later reader. Once it is committed, the only honest options are to make it true or to say it is unreliable, and the rewrite makes it true. The size check makes the write a precondition and not a hope: an operation that succeeds into a state its own reader rejects has failed, whatever it reports. Coverage pruning needs a reason to forget, and "the run did not see it" is not one. The lock reply turns an invisible state into a field a model can act on without guessing.

## Prevention

- **Break the step after the commit and read the files.** The test makes the ledger path a directory after the rename, runs `publish`, and then reads the committed `digest.md` and `run.json`: both must show `degraded` and `ledger-write-failed`, the reply summary must say so, and the directory must hold exactly the two files with mode 0600 and no temporary file (`tests/unit/ce-connect-helper-ops.test.ts:1722-1770`).
- **Make the limit testable.** A test helper that writes a ledger near the limit lets the tests assert that a publish and a decision that would cross it fail and leave the old file byte for byte (`tests/unit/ce-connect-helper-ops.test.ts:1771-1827`).
- **Test recovery, not just loss.** The coverage test renames a project's `.git` away, runs, and asserts that the coverage of the unreadable project survives, restores it, and asserts it is still there. A companion case asserts that coverage for a learning deleted from a healthy project is still dropped (`tests/unit/ce-connect-helper-ops.test.ts:1830-1900`).
- **Give each failure path a lock assertion.** The three `validate` failures each assert the `lockReleased` value, and the one with an unreadable handle asserts that the next `begin` is `busy` until `ledger unlock` (`tests/unit/ce-connect-helper-ops.test.ts:2036-2097`).
- **Design rule.** For any two-phase publish, write down the failure of each step after the commit and name the artifact that will tell the truth about it. If a step can fail and the lock is held, the reply must say whether it was released.

## Related Issues

- [Run state for a model-invoked helper](../best-practices/run-state-for-a-model-invoked-helper-2026-11-09.md): the lock and the rename-as-commit design this builds on.
- [A fail-closed component reports its own state, not the failure that caused it](../workflow-issues/fail-closed-components-report-their-own-state-2026-08-23.md): the same instinct, applied to a dependency.
