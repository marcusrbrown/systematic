---
title: Recover delegated workflow receipts without weakening trust boundaries
date: 2026-07-31
category: integration-issues
module: workflow guard receipt recovery
problem_type: integration_issue
component: development_workflow
symptoms:
  - Successful delegated implementation, verification, and commit work did not satisfy the parent workflow unit
  - An earlier stale child receipt made the parent guard unavailable and discarded later valid receipts
  - A later explicit workflow declaration lost required operations or resource scopes after skill auto-start
  - Duplicate callbacks or restart replay could conflict with already recovered progression
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - receipt ledger
  - OpenCode adapter
  - delegated workspace isolation
tags:
  - workflow-guard
  - receipt-recovery
  - delegation
  - opencode
  - session-recovery
  - worktree-attestation
  - replay-safety
  - trust-boundary
---

# Recover delegated workflow receipts without weakening trust boundaries

## Problem

A foreground child session could successfully implement, verify, and commit a change while the protected parent workflow still reported every operation as missing. The adapter crossed child-session, parent-session, repository-revision, and restart-recovery boundaries as if they shared one identity and one immutable snapshot.

The safe fix could not simply trust the child's completion claim or relax receipt validation. It had to preserve later valid evidence while continuing to fail closed on lineage, workspace, seed, and replay violations.

## Symptoms

- A delegated write-verify-commit task completed, but the parent stayed at `waiting/missing-evidence` or became `guard-unavailable`.
- An early implementation receipt became stale after the child's later commit, and that stale receipt poisoned the whole chronological batch.
- Even the final commit receipt looked stale because it was compared with repository and worktree identities captured when the plugin started.
- Skill auto-start established a minimal unit, then a later explicit start either lost required operations and scopes or produced conflicting replay markers.
- Duplicate host callbacks or restart replay risked double-minting evidence.
- A child could report the requested worktree path while actually modifying another checkout.

## What Didn't Work

- **Rejecting the entire batch on any stale receipt.** Earlier receipts naturally become stale as a delegated task advances the repository. Rejecting the batch loses later valid evidence.
- **Skipping every mismatch without classifying it.** Stable workspace mismatch indicates the wrong trust domain and must remain fatal. Only mutable repository or worktree revision staleness is safely skippable.
- **Comparing with plugin-boot snapshots.** A successful child commit guarantees those snapshots are stale. Parent-local work before delegation creates the same problem.
- **Widening the generic receipt classifier.** That weakens all receipt paths instead of creating a narrow, revalidated recovery boundary.
- **Fabricating closure metadata for recovered operations.** Synthetic metadata can satisfy shape checks without proving the underlying operation.
- **Validating and minting one receipt at a time.** A later malformed receipt can fail after earlier candidates already mutated parent state.
- **Reusing one parent context for multiple mints.** Each accepted receipt changes live parent state, so the next observation must use a fresh context.
- **Trusting the path written in the child prompt or response.** A path claim is not evidence that writes landed in that checkout.
- **Treating a process restart as a clean session.** Restarting reloads plugin code, but resuming a conversation replays its persisted messages, tool metadata, and guard progression.

## Solution

### 1. Recover child evidence with the child's identity

`rollupForegroundTask` in `src/lib/opencode-workflow-guard.ts` verifies parent-child lineage, classifies the child's markers, extracts the receipt seed, and creates the recovery ledger with the child's recovered session salt:

```ts
const seed = extractReceiptReadbackSeed(ownMarkers)
const childLedger = createReceiptLedger({
  capabilityFlags: ['workflow-guard'],
  registrationIdentity,
  sessionSalt: seed.sessionSalt,
})
const recovered = childLedger.recoverReadback(ownMarkers)
```

Parent and child sessions intentionally use different salts. Reconstructing child receipts with the parent salt makes valid child evidence look forged.

### 2. Preflight the complete candidate batch

Before minting anything to the parent, the adapter filters recovered receipts to local workflow operations and validates those eligible candidates against current lineage and scope rules. The validation distinguishes stable and mutable identity:

- A workspace digest mismatch is fatal and makes the guard unavailable.
- A repository or worktree revision mismatch marks that receipt stale and skips it.
- Later chronological receipts continue through preflight.

This permits an implementation receipt to become stale after a child commit without discarding a later eligible commit receipt that matches current repository state. Preflight completes before the first parent mutation, preventing partial rollup from a batch that later proves malformed.

### 3. Mint through a narrow trusted recovery seam

Each surviving receipt obtains a fresh parent operation context immediately before observation:

```text
for each surviving child receipt:
  read the parent operation context now
  observe the recovered operation with the current parent context and revision snapshot
```

`observeTrustedRecoveredOperation` remains an internal adapter-to-guard seam. It is not exposed as a model or host tool, and the guard still revalidates the active epoch, unit, operation shape, workspace, resource scope, terminal state, and current progression before accepting evidence.

Capturing the parent's operation-before identities immediately before child readback also preserves parent-local implementation that occurred after plugin startup but before delegation.

### 4. Make declaration recovery monotonic and replay-exact

`applyUnitStart` and `unitDeclarationExtends` in `src/lib/receipt-readback.ts` allow a later explicit start to extend an auto-started unit only while the unit is pristine:

- Existing required operations must remain present.
- Existing resource scopes must remain unchanged.
- New operations or scopes may be added before evidence is minted.
- Redeclaration after evidence is rejected.
- An identical declaration with a different transition digest is conflicting, not idempotent.
- Exact duplicate markers remain idempotent.

This preserves durable replay semantics without allowing a later declaration to shrink or replace the unit's trust boundary.

### 5. Attest delegated writes outside the receipt mechanism

Receipt recovery proves accepted workflow evidence; it does not prove that a write-capable child honored the requested filesystem location. Keep that as a separate orchestration contract: require expected-root, actual-root, and changed-file attestation, then independently inspect both the expected checkout and primary/source checkout before accepting the result. See `skills/orchestrating-subagents/SKILL.md` for the canonical contract.

### Verification evidence

The merged fix was verified with focused receipt and recovery unit tests, all real-host receipt-recovery integration tests, the full repository suite (**1,828 passed, 0 failed, 1 skipped**), type checking, Biome, content integrity, CI, and independent architecture, correctness, security, and test-quality reviews.

The workspace-attestation guidance was pressure-tested by giving a child the wrong default checkout and confirming that it selected the expected root, inspected both checkouts, and refused blind transfer or cleanup.

A fresh post-merge interactive dogfood cycle remains a separate acceptance follow-up. Automated and CI evidence must not be described as proof that this final dogfood has already passed.

## Why This Works

The fix separates identities that had been complected:

- **Session identity:** child receipts are reconstructed with the child salt; parent receipts are newly minted by the trusted adapter.
- **Stable workspace identity:** a mismatch remains fatal because it crosses the resource trust boundary.
- **Mutable revision identity:** stale repository or worktree revisions can be skipped while later valid evidence survives.
- **Live parent state:** parent-local changes and earlier accepted receipts are reflected before each mint.
- **Progression identity:** monotonic declaration upgrades preserve prior operations and scopes, while exact transition digests make replay deterministic.
- **Filesystem identity:** independent root and diff checks verify where child writes actually landed.

The parent credits only evidence it can reconstruct and re-attest. It does not trust child prose, weaken general classification, or invent missing proof.

## Prevention

- Cover chronological batches containing both stale and current receipts; assert that stale mutable revisions are skipped while stable workspace mismatches fail closed.
- Include parent-local implementation before delegated commit in real-host tests so boot-snapshot regressions cannot hide.
- Test malformed later receipts to prove batch preflight prevents partial parent mutation.
- Test multiple surviving receipts so each mint must use current parent context.
- Test exact duplicate callbacks, conflicting transition digests, restart replay, monotonic declaration growth, and redeclaration after evidence.
- Cross-reference, rather than duplicate, adjacent safeguards: workspace attestation belongs in `skills/orchestrating-subagents/SKILL.md`; clean-session and restart-recovery setup belongs in the isolated-subprocess learning; installed-runtime verification belongs in the installed-artifact learning.

## Related Issues

- [Issue #678: ce:work can advance on completion claims with no executed tools](https://github.com/marcusrbrown/systematic/issues/678)
- [PR #719: preserve delegated receipt evidence](https://github.com/marcusrbrown/systematic/pull/719)
- [PR #722: harden delegation isolation guidance](https://github.com/marcusrbrown/systematic/pull/722)
- [Isolate harness subprocess and packaged-runtime fixtures](../integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md)
- [Verify installed artifacts, not just build gates](../workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md)
- [Subagent skill tool permissions require explicit per-agent configuration](../workflow-issues/subagent-skill-permission-scoping-2026-05-20.md)
