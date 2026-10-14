---
title: "fix: Digest identities and operation arguments of any size"
type: fix
status: completed
date: 2026-10-14
---

# fix: Digest identities and operation arguments of any size

## Overview

The workflow guard compares salted digests to detect changes, for example:

- a rewrite of a call's arguments between its before-hook and after-hook;
- a remote state change;
- a resource mismatch.

Two size limits break those comparisons:

- The receipt ledger's `digestIdentity` collapses every identity over 1024 characters to one constant digest, so long values compare equal.
- The guard's argument serializer gives up above 8192 characters, so the guard goes unavailable.

This plan makes `digestIdentity` hash identities of any length. It also removes the serializer's size budget, keeps its depth limit, and makes it reject values that aren't plain JSON.

## Problem Frame

Issue #1113: a `write`, `edit` or `apply_patch` call whose arguments exceed 8192 characters makes the guard unavailable for the rest of the session.
1. `stableSerialize` in `src/lib/opencode-workflow-guard.ts` returns undefined above its 8192 budget.
2. `argsFingerprint` then returns undefined.
3. `prepareOperation` records `operation-input-invalid`.

In an active epoch, a `ce:work` unit that writes a file over about 8 KiB can't mint any further receipts. Since PR #1116, inactive sessions skip observation before fingerprinting, so this now affects only sessions with guarded work.

Research and plan review found a second defect behind the first. In `src/lib/receipt-ledger.ts`, `digestIdentity` digests the literal `'invalid'` in place of any identity whose trimmed length exceeds `MAX_IDENTITY_LENGTH` (1024). It doesn't reject the identity. Receipt context identities are bounded when they are parsed (`parseContext`), so no stored receipt ever held a collapsed digest. Two in-memory comparisons can exceed the cap:

- **Args fingerprint.** Every argument set between 1025 and 8192 characters gets the same fingerprint. A before/after rewrite of such arguments goes undetected.
- **`stateFingerprint`** in `src/lib/workflow-guard.ts`. It joins remote operation state fields with `|`. When the joined text exceeds the cap, different states compare equal and receipts are not marked stale. A declared resource identity may be up to 1024 characters, so a long resource plus the other fields reaches the cap.

Each collapse fails open. A comparison that should report a difference reports none. The status digest also goes through `digestIdentity`, but its input stays small in practice.

A push or PR-creation composite (`<resource>:<revision>`) over 1024 characters is rejected when the receipt is minted, so it fails closed already. It stays that way.

## Requirements Trace

- R1. `digestIdentity` produces a digest that depends on the full trimmed identity at any length. Two different identities over 1024 characters produce different digests.
- R2. `digestIdentity` keeps today's digest for every identity whose trimmed length is 1024 or less. It keeps the `'invalid'` result for empty, whitespace-only (of any length), non-string or unknown-domain input.
- R3. A `write`, `edit` or `apply_patch` call whose arguments exceed 8192 characters is observed in an active epoch and mints its receipt. The guard stays available.
- R4. A before/after rewrite of large arguments fails closed with `call-lifecycle-mismatch`, wherever the difference falls.
- R5. These arguments stay unfingerprintable and keep the `operation-input-invalid` outcome:
  - nesting beyond 8 levels;
  - `undefined` values, functions, symbols and bigint;
  - objects that aren't plain, such as `Date`, `Map` and `Set`.
- R6. A remote state change is detected, and marks receipts stale, when the joined state text exceeds 1024 characters. The JSON field encoding removes boundary ambiguity as defense in depth; every boundary shift also changes a separately compared identity, so no public-API test can isolate it.

## Scope Boundaries

- `MAX_IDENTITY_LENGTH` stays as the bound on identities that are parsed or stored (`normalizedIdentity` on envelope and readback paths). Only the hashing path stops applying it.
- Push and PR-creation composites over 1024 characters keep failing at mint.
- No change to snapshot limits, the operation observation gate, receipt schema or protocol versions.
- `NaN` and `Infinity` still serialize as `null`. Host tool arguments are parsed JSON and can't contain them.

### Deferred to Separate Tasks

- Hook timeout isolation inside an active epoch: #1084.
- Snapshot read races and false cleans: #1099.

## Context & Research

### Relevant Code and Patterns

- `src/lib/receipt-ledger.ts`:
  - `MAX_IDENTITY_LENGTH` and `normalizedIdentity` (trim, then bound).
  - `digestIdentity` and its `'invalid'` fallback.
  - `digestContext`, which digests epoch, unit, workspace, repository, worktree and resource identities.
- `src/lib/receipt-readback.ts` `digestReceiptIdentity`: SHA-256 over salt plus identity, with no size limit. The salt stays applied.
- `src/lib/opencode-workflow-guard.ts`:
  - `stableSerialize`, `serializeStableArray` and `serializeStableRecord`, which thread the budget.
  - `argsFingerprint`.
  - The callers `prepareOperation` (`operation-input-invalid`) and `takeOperationToFinish`.
  - `isRecord`, which accepts any non-array object.
- `src/lib/workflow-guard.ts`: `stateFingerprint` (a closure in `createWorkflowGuard`; observable through `observeReadback` → `observeState` → `markStaleReceipts`), `ledgerResourceIdentity` (bounded at mint).
- Tests and helpers:
  - `tests/unit/opencode-workflow-guard.test.ts`:
    - helpers `activateWorkEpoch`, `observeOperationTool` and `observeOperationToolWithArgs`;
    - `ledger(adapter).listReceipts()`;
    - `operationSnapshot`;
    - `prepareApplyPatchTargetDirectory`;
    - the test "arguments that cannot be fingerprinted".
  - `observeOperationToolWithArgs` hardcodes `apply_patch`.
  - `expectNoCause` is local to the `operation observation gate` describe block.
  - A receipt needs a changed worktree digest across the before and after snapshots, as in the existing implementation-receipt tests.

### Institutional Learnings

- `docs/solutions/integration-issues/workflow-guard-skipped-skills-over-32kb-2026-09-26.md`: put a size cap on the evidence it bounds, never on a shared success or comparison check. Test the large payload succeeding, not only the absence of failure.
- `docs/solutions/integration-issues/plugin-tool-output-truncated-before-after-hook-2026-09-26.md`: before/after correlation stays keyed by `sessionID` plus `callID`. Argument equality is a rewrite check, not an identity.
- `docs/solutions/integration-issues/worktree-targeted-receipt-observation-2026-08-02.md`: evidence that can't be validated fails closed.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib (receipt-ledger identity digest, guard args fingerprint, workflow-guard composite identities)",
  "freshness": {
    "vcs_reference": "15b1ec85b75fdc8fe5556ffc3d5fd05076527d12"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 8,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/receipt-ledger.ts digestIdentity",
      "description": "Salted per-session identity digest shared by every guard comparison",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/receipt-readback.ts digestReceiptIdentity",
      "description": "Unbounded salted SHA-256 that digestIdentity already delegates to",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts stableSerialize",
      "description": "Sorted-key canonical serializer used only by the args fingerprint",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-operation-observer.ts digest",
      "description": "Unbounded content digest",
      "disposition": "insufficient",
      "insufficiency_reason": "Not exported, owned by the observer, and unsalted"
    }
  ]
}
```

## Key Technical Decisions

- **Fix the collapse in the ledger, not in each caller.** `digestIdentity` is the one place every comparison passes through. Hashing the full trimmed identity fixes the args fingerprint and both composites at once, and the next caller can't collapse either. The cap keeps bounding parsed and stored identities, where a length limit is meaningful. (Decided by Marcus.)
- **Keep identities of 1024 characters or fewer byte-identical.** Short digests are unchanged, so live receipts and markers keep validating across the upgrade. Only identities that used to collapse get a new digest.
- **Drop the serializer's size budget and keep its depth limit.** The canonical text only feeds a digest. The arguments are already in the host's memory, so the cost is one serialization plus a hash. (Decided by Marcus.)
- **Reject objects that aren't plain.** Today `Date`, `Map` and `Set` serialize as `{}` and collide. Rejecting them makes them unfingerprintable, which fails closed. An object is plain when its prototype is `null` or its prototype's prototype is `null`, which also accepts plain objects from another realm. Parsed JSON never contains anything else, so real calls are unaffected.
- **Encode the state fields unambiguously.** `stateFingerprint` joins unescaped fields with `|`, so different field splits can produce the same text. It digests the JSON encoding of the field list instead. This fingerprint is in-memory only, so nothing persisted changes.

## Implementation Units

- [x] **Unit 1: Digest identities of any length**

**Goal:** `digestIdentity` no longer collapses long identities.

**Requirements:** R1, R2, R6

**Dependencies:** None

**Files:**
- Modify: `src/lib/receipt-ledger.ts`
- Modify: `src/lib/workflow-guard.ts`
- Test: `tests/unit/receipt-ledger.test.ts`
- Test: `tests/unit/workflow-guard.test.ts`

**Approach:**
- In `digestIdentity`, trim the identity. Digest the trimmed string, with no length bound, when it is non-empty and the domain is known. Otherwise digest `'invalid'` as today.
- Leave `normalizedIdentity` and its other callers unchanged.
- In `stateFingerprint`, digest the JSON encoding of the field list instead of the `|`-joined text.

**Execution note:** Test-first. The over-cap tests must fail on the current code.

**Patterns to follow:**
- Ledger tests: `createLedgerWithSalt`, `getSessionSalt`, and the salt-correlation test in `tests/unit/receipt-ledger.test.ts`. Import `digestReceiptIdentity` from `receipt-readback`, and pin with trimmed input because it does not trim.
- Core tests: `activateWork`, `startUnit`, the `prUnit()` pattern and the operation-scoped readback propagation tests in `tests/unit/workflow-guard.test.ts`.

**Test scenarios:**
- Happy path: two 2000-character identities that differ only in their last character produce different digests, in the `call` domain and the `resource` domain.
- Edge case: a 1024-character identity and a short identity digest exactly as they do on the current code, pinned against `digestReceiptIdentity` with the session salt.
- Edge case: an identity of 1030 characters with 10 leading spaces digests like its trimmed 1020-character form.
- Edge case: empty input, 2000 spaces, non-string input and an unknown domain all digest to the `'invalid'` value.
- Integration: through `observeReadback`, a check-readback unit with a 1000-character declared resource identity is read back with `checkState` changing from success to pending. Its receipt is marked stale. Vary the check state, not the resource, because resource changes are detected separately.

**Verification:**
- The new tests fail before the change and pass after it.
- Every existing ledger, readback and workflow-guard test passes unchanged.

- [x] **Unit 2: Fingerprint operation arguments of any size**

**Goal:** Large operation arguments are observed in an active epoch, and rewrites of them are detected.

**Requirements:** R3, R4, R5

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Remove the budget parameter and its threading from `stableSerialize` and its two helpers. Keep the depth check and every existing undefined case.
- Return undefined for an object that isn't plain, as defined in Key Technical Decisions.
- Add `tool` as a trailing optional parameter of `observeOperationToolWithArgs`, defaulting to `apply_patch`, so existing positional calls keep working. Place the new tests inside the `operation observation gate` describe block, or hoist `expectNoCause` and its cause helper.

**Execution note:** Test-first. The large-argument and rewrite tests must fail on the current code.

**Patterns to follow:**
- Active-epoch implementation-receipt tests that use a before snapshot and a changed after snapshot (`operationSnapshot()`, then one with different repository and worktree digests).
- The existing `apply_patch` body-change mismatch test.
- `prepareApplyPatchTargetDirectory` for patch targets under a real directory.

**Test scenarios:**
- Happy path: in an active epoch, a `write` with 64 KiB of content is observed. It mints an implementation receipt, the guard stays out of `unavailable`, and no cause is recorded.
- Happy path: the same holds for an `edit` whose `newString` is 64 KiB.
- Happy path: the same holds for an `apply_patch` whose patch text is 64 KiB, targeting a file under a directory that exists.
- Error path: a 64 KiB `write` whose after-hook content differs from the before-hook's only in its last character fails closed with `call-lifecycle-mismatch`. The difference sits past index 8192, so a truncating hash would miss it.
- Error path: a `write` whose `content` is a `Date` records `operation-input-invalid` as its first unavailable cause. So does a class instance.
- Edge case: a `write` whose args are an `Object.create(null)` record is fingerprinted and observed normally.
- Edge case: arguments nested deeper than 8 levels still record `operation-input-invalid`. The existing test with an `undefined`-valued key passes unchanged.
- Integration: a duplicate after-hook for an observed 64 KiB `write` replays silently.

**Verification:**
- The new tests fail before the change and pass after it.
- Reverting Unit 1 alone makes the last-character rewrite test fail. This shows both fixes are needed.
- Guard, workflow-guard and observer unit suites pass. `typecheck:all` and Biome are clean.

- [x] **Unit 3: Record the identity and fingerprint rules**

**Goal:** `ARCHITECTURE.md` states that identity digests and argument fingerprints cover their full input, and lists which arguments stay unfingerprintable.

**Requirements:** R1, R5

**Dependencies:** Units 1 and 2

**Files:**
- Modify: `ARCHITECTURE.md`

**Approach:**
- In the receipt-backed workflow guard section, add one sentence next to the `operation-input-invalid` cause. It names the arguments that record the cause: nesting beyond 8 levels, `undefined`, functions, symbols, bigint, and objects that aren't plain. It also says that larger arguments are fingerprinted in full.
- Where the ledger's salted identity digests are described, state that a digest covers the full identity at any length. The 1024-character bound applies only to identities the ledger parses or stores.

**Test expectation:** none. Documentation only.

**Verification:**
- markdownlint and content-integrity are clean.

## System-Wide Impact

- **Interaction graph:**
  - Every `digestIdentity` caller. Receipt context and observation identities are bounded at parse, so their digests never change. Only in-memory inputs over 1024 characters change result: args fingerprints, state fingerprints and the status digest.
- **State lifecycle risks:**
  - Args and state fingerprints live in memory only. No stored receipt or marker held a collapsed digest, so nothing persisted needs migration.
- **Behavior changes that fail closed:**
  - A large `apply_patch` whose session location changes between hooks now records a mismatch. Before, it passed because both fingerprints collapsed.
  - A long or boundary-shifted remote state that actually changed now marks receipts stale.
- **Unchanged invariants:**
  - Call correlation stays keyed by call ID.
  - Receipt schema and protocol versions and `normalizedIdentity` bounds on parsed input are unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A short identity's digest changes by accident and invalidates live receipts | The Unit 1 edge case pins short-identity digests against the current derivation |
| Very large arguments cost one serialization and one SHA-256 per hook | Linear, and small next to the snapshots the same hook already takes |

## Sources & References

- Related issues:
  - #1113
  - #1105 (PR #1116)
  - #1084
  - #1099
- Related code:
  - `src/lib/receipt-ledger.ts`: `digestIdentity`.
  - `src/lib/opencode-workflow-guard.ts`: `stableSerialize`, `argsFingerprint`.
  - `src/lib/workflow-guard.ts`: `stateFingerprint`.
