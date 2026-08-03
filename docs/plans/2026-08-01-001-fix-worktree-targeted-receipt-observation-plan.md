---
title: 'fix: Observe worktree-targeted child operations in the receipt guard'
type: fix
status: active
date: 2026-08-01
deepened: 2026-08-01
---

# fix: Observe worktree-targeted child operations in the receipt guard

## Overview

The receipt guard mints cryptographic receipts proving guarded operations
(implementation / verification / commit) actually happened before a protected
workflow unit may complete. It observes real git state through a single
operation observer created once at plugin init, pinned to the parent checkout's
absolute path.

When a foreground `task` child stays host-rooted at the parent checkout but its
tools target an isolated nested git worktree (via `bash` `workdir` or absolute
file paths), the fixed observer reads the unchanged parent tree. Before-state
equals after-state, so every operation is a no-op, no receipts are minted, and
the parent unit ends `waiting/missing-evidence` (issue #678).

This plan makes the observer target the directory a tool actually operated on —
derived from host-observed tool inputs, validated as a registered worktree of the
parent repository, and pinned to the unit through a new authenticated receipt
field. It closes #678 without weakening the existing stable-workspace / mutable-
revision trust boundary.

## Problem Frame

The prior delegated-receipt fix (PR #719, documented in
`docs/solutions/integration-issues/delegated-receipt-rollup-live-state-recovery-2026-07-31.md`)
recovered child receipts across session and revision boundaries, but assumed the
child wrote into the **same** checkout the fixed observer reads. The isolated-
nested-worktree case is the unclosed remainder of #678.

Root cause, confirmed from source:

- `src/index.ts:72-74` creates one `createOpencodeOperationObserver` rooted at
  `worktree ?? directory` (the parent checkout). Its `targetDigest` becomes
  `workspaceIdentity`.
- `src/lib/opencode-operation-observer.ts` `snapshot()` always runs git at that
  fixed `targetDirectory`, regardless of which directory a tool touched.
- `prepareOperation` / `captureAfterOperation`
  (`src/lib/opencode-workflow-guard.ts:1958`, `2568`) snapshot that fixed
  observer for before/after.
- `src/lib/receipt-ledger.ts:1231` `implementationNoOpReason` rejects a receipt
  when `after.worktreeDigest === context.worktreeDigest` → `unchanged-worktree`.

Because the observed parent tree never changes when work lands in a foreign
worktree, the guard classifies real work as a no-op and mints nothing.

An Oracle design review established that the minimal "derive target from tool
args" fix is **exploitable**: a bare `--git-common-dir` check is spoofable by a
fake `.git` gitfile, and inherited `GIT_*` environment can make any directory
resolve as the parent repository. The safe fix therefore combines host-derived
observation with registered-worktree validation, `GIT_*` sanitization, and an
authenticated per-unit target identity.

## Requirements Trace

- R1. A guarded local operation whose tool targets an isolated worktree of the
  parent repository mints the correct implementation/verification/commit receipt.
  **Units:** U2, U4.
- R2. The observed directory is derived only from host-observed tool inputs
  (`bash.workdir`; write/edit/apply_patch file target(s)), never from model or
  child prose. **Units:** U2.
- R3. A derived target is trusted only after it is validated as a registered
  worktree of the parent repository (common-dir identity + `git worktree list`
  membership + `.git` linkage), with all `GIT_*` variables stripped from observer
  subprocesses. **Units:** U1, U2.
- R4. Each receipt carries an authenticated `operationTargetIdentity` bound into
  its salted integrity digest; a unit pins one local target and fails closed on a
  target switch. **Units:** U3, U4.
- R5. Parent rollup observes each child receipt's authenticated target (not the
  fixed parent observer); target/common-dir/registration mismatches are fatal,
  while repository/worktree revision staleness remains skippable. **Units:** U5.
- R6. The existing shared-parent-repo child rollup (u5) and all current fixed-
  observer behavior are preserved unchanged. **Units:** U4, U5, U6.
- R7. On an explicit tool target that resolves to an unrelated or invalid
  directory, the guard fails closed (marks unavailable); it does **not** fall
  back to the fixed parent observer. **Units:** U2, U4.

## Scope Boundaries

- Foreground `task` children only. Background/detached child lineage remains out
  of V1 scope, consistent with the existing guard.
- Local operations (`write`/`edit`/`apply_patch`/`bash`) and their
  implementation/verification/commit receipts. Remote operations (push,
  pr-creation, check/review readback) follow the same derived-target observer but
  add no new remote semantics here.
- No change to the observe-vs-protected default, disablement model, or Question
  attestation channel.

### Deferred to Separate Tasks

- Multiple distinct local targets satisfying one unit (a target-keyed revision
  map). This plan pins exactly one local target per unit; a multi-target identity
  map is a larger follow-up if a real workflow needs it.
- Sandboxed/traced confinement of arbitrary `bash` side effects. Receipt
  semantics remain "a recognized command succeeded when launched from the
  attested target," not "every I/O stayed inside it." **Existing mitigation
  (verified):** the receipt classifier (`src/lib/receipt-classifier.ts`) already
  allowlists exact command forms — the only permitted prefix is `cd
  <safe-relative>` (no absolute, `~`, or `..`; `isSafeRelativeCwd`), and `git` is
  matched by exact recognized forms only, so `git -C <dir> …` is unrecognized and
  mints nothing. The residual is confined to in-process side effects of an
  otherwise-recognized command (e.g. a test script that writes into another
  checkout) — which is exactly this deferred sandbox item, not a new hole opened
  by the derived-target observer.

## Context & Research

### Relevant Code and Patterns

- `src/lib/opencode-operation-observer.ts` — `createOpencodeOperationObserver`,
  `defaultCommandRunner` (`spawnSync`, inherits process env — the GIT_* leak),
  `RepositoryContext { commandDirectory, worktreeRoot }`, `snapshot()`.
- `src/lib/opencode-workflow-guard.ts` — `prepareOperation` (1958),
  `captureAfterOperation` (2568), `buildOperationObservation` (2611),
  `rollupForegroundTask` (1404), `PendingOperation` (277).
- `src/lib/receipt-ledger.ts` — `CanonicalReceiptFields` (124-139),
  `mintReceipt` (1266), `digestContext` (1074), `digestAfter` (1200),
  `implementationNoOpReason` (1231), `commitNoOpReason` (1242).
- `src/lib/receipt-readback.ts` — `mintIntegrity` (salted SHA-256 over the
  serialized envelope, 668-676), `CANONICAL_REQUIRED_KEYS` / `_OPTIONAL_KEYS`
  (266-284), `cloneCanonical` (520), `parseEnvelope` (552), `serializeEnvelope`
  (641).
- `src/lib/workflow-guard.ts` — `currentIdentityReason` (1296),
  `currentOperationContext` (1308), `observeTrustedRecoveredOperation` (3430).

### Institutional Learnings

- `docs/solutions/integration-issues/delegated-receipt-rollup-live-state-recovery-2026-07-31.md`
  — the trust-boundary discipline this plan must preserve: stable workspace
  mismatch is fatal, mutable revision staleness is skippable, batch preflight
  before any mint, fresh parent context per mint, never trust child prose.
- `docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md`
  — isolate by real runtime boundaries, not shallow tree checks.

### External References

- Vendored OpenCode source `.slim/clonedeps/repos/anomalyco__opencode/`:
  `packages/core/src/tool/bash.ts` (relative `workdir` resolves from session
  Location; external/absolute needs approval), `packages/opencode/src/patch/index.ts`
  (`apply_patch` optional `workdir`, multi-file `patchText`). Use to confirm the
  exact per-tool argument keys during implementation.

## Key Technical Decisions

- **Host-derived target + registered-worktree validation (Oracle option A+),
  not bare common-dir.** Common-dir equality is necessary but demonstrably
  insufficient (fake gitfile spoof). Trust requires common-dir identity **and**
  `git worktree list` membership **and** `.git` linkage validation.
- **Authenticated `operationTargetIdentity`, not repository-scoped workspace.**
  Keep `workspaceIdentity` as the stable parent lineage identity; add a separate
  authenticated target identity. Repository-scoping the workspace (option C)
  would weaken the principal boundary and is rejected.
- **In v2, every local receipt carries an explicit `operationTargetIdentity` —
  including parent-target operations.** Absence must **not** mean "parent target"
  in v2; that would let a receipt omit the field to dodge target validation.
  Parent-target operations get an explicit parent-checkout target identity.
  Absence is meaningful only through the v1 legacy read shim below. (Architect
  review: the biggest single correction — absence as an implicit mode is an
  evidence-omission bypass.)
- **Version bump ships with a one-version backward-read shim (resolved, not
  deferred).** No version constant in this repo has ever been bumped; all
  parsers hard-reject on version inequality, and durable v1 markers persist in
  session ToolPart metadata, so a live user can carry v1 receipts into v2 code.
  Therefore: mint only v2 going forward; read v1 only for recovery; a v1 receipt
  with no target field maps to **parent-target only** after workspace/parent
  validation; v1 receipts are **rejected for foreign/worktree-targeted recovery**
  because they cannot prove a target identity. Keep the v1 acceptance narrow,
  documented, and removable. Hard-rejecting v1 outright is only acceptable if we
  explicitly accept "upgrade invalidates in-flight guarded units" — we do not.
- **Unit pins one local target; target switch fails closed — an intentional V1
  limitation.** The first trusted local target pins the unit; a later local op
  resolving to a different worktree fails closed with an explicit message
  (unit pinned to target X, operation targeted Y; split into separate units or
  await multi-target support). This rejects some legitimate mixed-checkout
  workflows (e.g. parent-side docs write + worktree code change); accepting them
  safely needs a target-keyed progression map, which is deferred. Failing closed
  is correct over laundering evidence from checkout A into checkout B.
- **The pin lives in durable unit progression state AND the receipt, not just
  `PendingOperation`.** Durable progression state is the authoritative
  cross-restart/replay enforcement (`pinnedOperationTargetIdentity`); the receipt
  canonical field is the authenticated per-operation evidence; `PendingOperation`
  holds only the observer instance for before/after convenience. An in-memory-only
  pin lets restart forget target A and admit target B into the same unit.
- **No fixed-observer fallback on explicit-but-invalid target.** Falling back
  could mint evidence from an incidental parent change during an unrelated
  operation. Absent any override, the natural parent target remains the fast path.
- **Strip `GIT_*` from observer subprocesses.** At minimum `GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG*`.
- **Same observer instance for before and after.** Store the resolved target and
  observer in `PendingOperation`; re-derivation from after-args is rejected.
- **Rollup validation ordering is fixed:** (1) child lineage/salt/readback
  integrity, (2) stable parent workspace identity, (3) target identity present +
  registered + common-dir match + unit-pin match, (4) *only then* repository/
  worktree revision staleness as skippable. Target mismatch is **fatal**, never
  treated as skippable mutable-revision staleness (that ordering inversion is a
  bypass).

## Open Questions

### Resolved During Planning

- Is receipt integrity an HMAC that a new field must be wired into separately?
  No — `mintIntegrity` is a salted SHA-256 over the whole serialized envelope, so
  adding `operationTargetIdentity` to `CanonicalReceiptFields` is covered
  automatically, but every canonical-field enumerator (parse/clone/serialize/
  compare/version-check across ledger + readback) must be updated, **including the
  closed-set gate `hasExactKeys` (`receipt-readback.ts:362-373`) and
  `CANONICAL_OPTIONAL_KEYS` (280-284), which will otherwise reject the new field.**
- Does adding a canonical field break durable readback compatibility? Yes —
  `RECEIPT_SCHEMA_VERSION` / `RECEIPT_PROTOCOL_VERSION`, the readback versions,
  and `MARKER_PROTOCOL_VERSION` are hard-checked (strict equality only; no bump
  has ever occurred in this repo). Adding the field requires a coordinated bump
  of all of them.
- **Version-bump compatibility: one-version backward-read shim** (moved out of
  Deferred — it is design-gating, not an implementation detail). See Key
  Technical Decisions. Mint v2 only; read v1 for recovery as parent-target only;
  reject v1 for foreign-target recovery. Durable v1 markers in session ToolPart
  metadata make a hard break lose in-flight guarded units, which we reject.
- **Optional-field serialization has one canonical representation.**
  `serializeEnvelope` emits absent optional fields as `null` and `parseEnvelope`
  treats absent/undefined consistently, so `undefined` / absent / `null` must not
  become three semantic states for `operationTargetIdentity`. Mirror the existing
  `worktreeDigest` `?? null` normalization exactly; add a test that insertion
  order does not change the serialized string or integrity digest.

### Deferred to Implementation

- **Exact per-tool argument keys in the running host.** The vendored core uses
  `args.path` for write/edit while current tests and guard code reference
  `filePath`; `apply_patch` may carry `workdir` plus multi-file `patchText`.
  Confirm the real keys in OpenCode v1.18.x (memory #7248) before finalizing
  target derivation; derive from **every** file target, not one representative.
- Whether common-dir identity should compare `dev`/`ino` in addition to the
  canonical path (stronger against path-equal spoofs) — decide when writing the
  validation helper against real fixtures.
- Whether the schema/protocol bump ships as a hard bump + backward-read shim
  (current design) or a staged dual-read/dual-write migration. The shim covers
  parent-target legacy v1 receipts; a staged dual-read would further reduce
  upgrade risk but adds transitional complexity. Decide from observed persistence
  of in-flight guarded units at upgrade time.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review,
> not implementation specification. The implementing agent should treat it as
> context, not code to reproduce.*

```
tool.execute.before (write/edit/apply_patch/bash)
  └─ deriveTarget(host tool args)          # U2: workdir | file target(s)
       ├─ none/relative-to-parent → parent checkout (fast path, unchanged)
       └─ explicit override → canonicalize (realpath, resolve symlinks)
             └─ validateRegisteredWorktree(candidate)   # U1
                  ├─ strip GIT_* ; git rev-parse checks
                  ├─ common-dir == parent common-dir
                  ├─ toplevel ∈ parent `git worktree list --porcelain`
                  └─ .git linkage back-reference intact
             ── invalid/unrelated ─→ markUnavailable (NO fallback)   # R7
       └─ observer(targetDir).snapshot()  → PendingOperation{ target, observer, before }
             └─ pin unit target ; switch ⇒ fail closed                # U4

tool.execute.after
  └─ same PendingOperation.observer.snapshot() → after
       └─ buildOperationObservation binds context + operationTargetIdentity  # U3
            └─ ledger mints receipt (integrity digest now covers target id)

task.after (foreground child rollup)                                  # U5
  └─ for each recovered child receipt:
       observe the receipt's authenticated target (not fixed observer)
       fatal:  workspace / target / common-dir / registration mismatch
       skip:   repository / worktree revision staleness (after target matches)
       mint through observeTrustedRecoveredOperation (batch-preflighted)
```

## Implementation Units

**Terminology anchor** (one meaning per term, used consistently below):
- **`workspaceIdentity`** — the stable parent-checkout lineage digest, fixed at
  plugin init. Never changes per operation. The principal trust boundary.
- **`targetRoot`** — the canonical absolute filesystem path of the worktree a
  specific operation acted on (parent checkout or a nested worktree).
- **`operationTargetIdentity`** — the authenticated digest of `targetRoot`,
  carried as a canonical receipt field and pinned to the unit
  (`pinnedOperationTargetIdentity` in `UnitState`). This is what rollup compares.
- **`repositoryIdentity` / `worktreeIdentity`** — mutable revision digests of the
  target's HEAD/tree; staleness is skippable, target identity mismatch is not.

- [ ] **Unit 1: Git-sanitized observer with worktree-structure validation**

**Goal:** Give the observer a trustworthy way to validate that an arbitrary
candidate directory is a registered worktree of the parent repository, with
`GIT_*` stripped from every git subprocess.

**Requirements:** R3.

**Dependencies:** None.

**Files:**
- Modify: `src/lib/opencode-operation-observer.ts`
- Test: `tests/unit/opencode-operation-observer.test.ts`

**Approach:**
- Strip the `GIT_*` allowlist (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`,
  `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
  `GIT_CONFIG*`) in `defaultCommandRunner` and `defaultRemoteCommandRunner` by
  passing an explicit sanitized `env`.
- Capture immutable parent identity at observer creation: canonical worktree
  root, `--absolute-git-dir`, `--path-format=absolute --git-common-dir`
  (optionally common-dir `dev`/`ino`), and the parent's
  `git worktree list --porcelain -z`.
- Add a validation helper that, from a candidate directory: requires
  `--is-inside-work-tree` true; resolves canonical `--show-toplevel`,
  `--absolute-git-dir`, `--git-common-dir`; requires common-dir match to the
  parent; requires canonical top-level to be a member of the parent worktree
  list; validates `.git` linkage (main: git dir == common dir; linked: git dir
  under `<common>/worktrees/…` with intact backlink).

**Patterns to follow:** existing `runCommand` / `readRevision` error-result
shape; `createSeparatedGitFixture` for exotic git layouts.

**Test scenarios:**
- Happy path: candidate is a real registered linked worktree of the parent →
  validation succeeds; common-dir and toplevel match.
- Happy path: parent main checkout validates as its own registered worktree.
- Edge case: root symlink to a legitimate worktree canonicalizes to the same
  identity.
- Error path: independent unrelated repository → common-dir mismatch → rejected.
- Error path: independent nested repo inside the parent checkout → rejected.
- Error path: submodule target (common dir under `.git/modules/…`) → rejected.
- Error path (security): fake `.git` gitfile pointing directly at the parent
  `.git` → passes bare common-dir but fails registration/linkage → rejected.
- Error path (security): fake `.git` gitfile pointing at a registered linked-
  worktree admin dir → rejected.
- Error path (security): poisoned ambient `GIT_DIR` / `GIT_WORK_TREE` /
  `GIT_COMMON_DIR` / `GIT_INDEX_FILE` cannot make an unrelated cwd validate as
  the parent (assert via injected env in the command runner).

**Verification:** validation helper accepts only registered same-repository
worktrees and rejects every spoof fixture; all git subprocesses run with `GIT_*`
stripped.

- [ ] **Unit 2: Host tool target derivation**

**Goal:** Resolve the canonical directory a guarded tool actually operated on
from host-observed arguments, or the parent checkout when there is no override.

**Requirements:** R1, R2, R3, R7.

**Dependencies:** Unit 1.

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Add a target-derivation function keyed by tool:
  - `bash` → resolve `args.workdir`; absent → the trusted session/parent target.
  - `write` / `edit` → resolve the file target's existing containing directory
    (canonicalize existing parent for a new file), then normalize to git
    top-level.
  - `apply_patch` → derive **every** file target (plus optional `workdir`);
    require all targets to resolve to one worktree.
- Canonicalize with `realpath`, resolving existing symlinks; reject a final
  target that escapes the validated root or lands in git admin storage.
- No override (missing `workdir`, relative paths under the parent) → parent
  checkout fast path (preserves u5).
- Explicit override that fails Unit 1 validation → signal fail-closed (caller
  marks unavailable); never fall back to the fixed observer.

**Execution note:** Implement test-first — derivation branches and the fail-
closed vs fast-path fork are the core correctness surface.

**Patterns to follow:** existing `bashCommand` arg extraction; `isLocalOperationTool`.

**Test scenarios:**
- Happy path: `bash` with `workdir` = registered worktree → that worktree.
- Happy path: relative `bash` `workdir` resolves identically to the session
  Location (parent) → parent target.
- Happy path: `write`/`edit` file inside a registered worktree → that worktree
  top-level.
- Edge case: two files in different subdirectories of the same worktree → one
  target.
- Edge case: absent override → parent checkout (u5 fast path).
- Error path: `apply_patch` with targets spanning two worktrees → fail closed.
- Error path (security): explicit target resolves to an unrelated/invalid dir →
  fail closed, no fallback.
- Error path (security): final file symlink escapes the registered root →
  rejected.

**Verification:** derivation returns the correct worktree for every valid case,
the parent for no-override cases, and fails closed for invalid explicit targets
with no fixed-observer fallback.

- [ ] **Unit 3: `operationTargetIdentity` authenticated canonical field**

**Goal:** Add a target identity to the receipt's canonical fields so it is
covered by the salted integrity digest and survives serialize → marker →
child readback → parent recovery.

**Requirements:** R4.

**Dependencies:** None (can land in parallel with U1/U2; U4 consumes it).

**Files:**
- Modify: `src/lib/receipt-ledger.ts`
- Modify: `src/lib/receipt-readback.ts`
- Test: `tests/unit/receipt-ledger.test.ts`
- Test: `tests/unit/receipt-readback.test.ts`

**Approach:**
- Add `operationTargetIdentity` to `CanonicalReceiptFields`. **Schema shape vs
  protocol rule are distinct:** the field is *optional in the shared canonical
  type* (so the v1 backward-read shim can parse legacy receipts that lack it),
  but *required by the v2 mint and v2 readback paths* for every local receipt
  (parent-target included). Do not conflate "optional in the type" with "optional
  at runtime" — a v2 local receipt missing the field is rejected, not treated as
  parent-target. Thread it through **every** `worktreeDigest` edit site (the
  exact precedent checklist, verified against source):
  - `receipt-ledger.ts`: type decls (132, 241); `envelopesEqual` (404-425);
    `storedReceiptFromEnvelope` (492-504); `compareDigestedContexts` (862-877);
    `parseEnvelope` (928-987); `digestContext` (1074-1089); `digestAfter`
    (1200-1215); `mintReceipt` (1266-1309); `recoverReceipt` (1358-1390);
    `recoverReadback` (1392-1432).
  - `receipt-readback.ts`: `CANONICAL_OPTIONAL_KEYS` (280-284);
    **`hasExactKeys` closed-set gate (362-373) — rejects the field if omitted**;
    `cloneCanonical` (520-539); `parseEnvelope` (552-618); `serializeEnvelope`
    (641-666, emit `?? null` like `worktreeDigest`).
  - `workflow-guard.ts`: revision/scope comparison sites that must consider the
    target semantically (`compareReceiptRepositoryScope` 1838-1858, and the
    stale-clear path 1628-1640) — decide per-site whether target participates.
- Bump `RECEIPT_SCHEMA_VERSION` / `RECEIPT_PROTOCOL_VERSION`, the readback
  schema/protocol versions, and `MARKER_PROTOCOL_VERSION` in lockstep; update
  every hard version check (`receipt-ledger.ts` 899-918, 928-987;
  `receipt-readback.ts` 552-618, 620-638, 741-764, 773-806, 826-852, 953-964;
  `opencode-workflow-guard.ts` marker checks at 52/761/885/1733/3012/3037).
- Implement the **v1 backward-read shim**: v2 mint path requires the field; v1
  readback maps absent field → parent-target only after workspace/parent
  validation, and rejects v1 for foreign-target recovery.
- Because `mintIntegrity` digests the whole serialized envelope, verify the new
  field changes the integrity digest and that mismatched target identities fail
  readback. Preserve the single canonical serialization (`?? null`) so absent /
  undefined / null do not become distinct semantic states.

**Execution note:** Test-first for tamper-evidence, version-bump rejection, and
the v1 shim before wiring all enumerators.

**Patterns to follow:** the existing `worktreeDigest` optional-field threading is
the exact template — mirror it at every site above.

**Test scenarios:**
- Happy path: minted v2 receipt carries `operationTargetIdentity`; round-trips
  through serialize → parse unchanged.
- Happy path: mint marker → child-style readback recovers the field intact.
- Edge case: insertion order of canonical fields does not change the serialized
  string or the integrity digest.
- Edge case (compat): a v1 receipt with no target field recovers as parent-target
  after workspace validation.
- Error path (security): a v1 receipt used for foreign-target recovery is
  rejected (cannot prove target identity).
- Error path (security): flipping `operationTargetIdentity` in a serialized
  envelope changes the integrity digest and fails validation.
- Error path (security): a v2 local receipt omitting the field is rejected (no
  implicit parent-target fallback).
- Error path: version mismatch after the bump is rejected as incompatible; a v2
  receipt missing the field at `hasExactKeys` is rejected.

**Verification:** the field is covered by integrity, survives full readback, the
v1 shim admits only parent-target legacy evidence, and version/closed-set checks
reject incompatible or field-omitting envelopes.

- [ ] **Unit 4: Per-operation observer wiring and unit target pinning**

**Goal:** Use a derived-target observer for before/after, bind
`operationTargetIdentity` into the observation, and pin one local target per unit.

**Requirements:** R1, R4, R6, R7.

**Dependencies:** Units 1, 2, 3.

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Modify: `src/lib/workflow-guard.ts` (authoritative pin: `UnitState`,
  `parseRecoveryUnit`, and the transition that sets/enforces it)
- Modify: `src/lib/receipt-readback.ts` (progression-marker serialize/recover of
  the pin so it survives restart — mirror the `requiredOperations` /
  `resourceScopes` threading through `applyUnitStart` / `unitDeclarationExtends`
  and the progression-base parse/`hasOnlyFields` gate)
- Test: `tests/unit/opencode-workflow-guard.test.ts`
- Test: `tests/unit/workflow-guard.test.ts`
- Test: `tests/unit/receipt-readback.test.ts`

**Approach:**
- In `prepareOperation`, derive the target (U2), obtain/reuse an observer for
  that directory, snapshot before, and store `{ targetRoot, targetIdentity,
  observer, before }` in `PendingOperation` (observer convenience only).
- In `captureAfterOperation`, reuse the stored observer instance; revalidate the
  target still resolves to the same registered worktree; reject path replacement
  / worktree removal / symlink retargeting between hooks.
- In `buildOperationObservation`, set `operationTargetIdentity` (explicit even
  for parent-target ops — no implicit absence) and bind `worktreeIdentity` /
  `repositoryIdentity` from the target snapshot while keeping `workspaceIdentity`
  = parent fixed digest.
- **Pin the unit's local target in the authoritative `UnitState`
  (`pinnedOperationTargetIdentity`)**, not just in memory, so a restart cannot
  forget target A and admit target B. On first trusted local operation, set the
  pin; a later local operation resolving to a different target fails closed with
  an explicit message. Thread the pin through the same recovery path as
  `requiredOperations`/`resourceScopes`: authoritative state + `parseRecoveryUnit`
  in `workflow-guard.ts`, and the progression-marker serialize/recover in
  `receipt-readback.ts` (including its `hasOnlyFields`/closed-set gate).
- Enforce the pin at restart: `parseRecoveryUnit` must reject a recovered unit
  whose subsequent evidence targets a different identity, so the boundary holds
  across replay, not only in a single live session.
- Keep the fixed observer as the fast path when the derived target is the parent
  checkout, so u5 and all current unit tests are unaffected.

**Execution note:** Characterization-first — capture current fixed-observer
behavior for the parent-target path before refactoring, and add a restart/replay
test proving the durable pin survives, before wiring worktree targets.

**Patterns to follow:** existing `PendingOperation` lifecycle and `sealOperation`
/ `takePendingOperation` discipline.

**Test scenarios:**
- Happy path: operation targeting a registered worktree mints an implementation
  receipt (before≠after on the worktree).
- Happy path (regression): parent-target operation still mints exactly as today
  (u5 fast path).
- Edge case: two operations on the same pinned target both mint.
- Error path (security): target A implementation then target B verification/commit
  → second fails closed (target switch).
- Error path: worktree removed/recreated at the same path between before and
  after → rejected.
- Error path (security): explicit invalid target concurrent with an incidental
  parent change → no fallback receipt.

**Verification:** worktree-targeted operations mint; parent-targeted operations
are unchanged; target switches and between-hook tampering fail closed.

- [ ] **Unit 5: Worktree-aware foreground child rollup**

**Goal:** Roll up child receipts against each receipt's authenticated target
instead of the fixed parent observer, preserving the fatal-vs-skippable
classification.

**Requirements:** R5, R6.

**Dependencies:** Units 1, 3, 4.

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`
- Test: `tests/integration/receipt-workflow-recovery.test.ts`

**Approach:**
- In `rollupForegroundTask`, for each recovered child receipt, snapshot the
  receipt's authenticated target (validated via U1) rather than
  `options.observer`.
- Classify: workspace digest mismatch, missing/mismatched target identity,
  target no longer a registered same-repo worktree, common-dir mismatch →
  **fatal** (markUnavailable). Repository/worktree revision staleness (after
  target identity matches) → **skippable**, preserving the existing chronological
  batch behavior.
- Preflight the whole batch before minting; mint through
  `observeTrustedRecoveredOperation` with a fresh parent context per mint (as
  today).
- Do not compare a parent-root before digest against an isolated-worktree after
  digest — pin/compare within the receipt's own target.

**Patterns to follow:** the existing preflight/candidate loop in
`rollupForegroundTask` (1487-1546) and the fatal-vs-stale distinction documented
in the 2026-07-31 solution doc.

**Test scenarios:**
- Happy path (integration): parent-rooted child + isolated worktree write/verify/
  commit → parent mints implementation/verification/commit.
- Happy path (regression, integration): existing u5 shared-parent write rollup
  unchanged.
- Happy path: stale earlier implementation + current commit in the worktree →
  commit still rolls up.
- Error path (security): child receipt with correct parent workspace digest but
  missing/wrong target identity → fatal.
- Error path (security): target A receipt cannot validate against target B even
  when revision digests are identical.
- Error path: malformed later receipt in the batch → preflight prevents partial
  parent mutation.

**Verification:** worktree-targeted child work rolls up into the parent unit;
shared-parent u5 is unchanged; every spoof/malformed case fails closed without
partial mutation.

- [ ] **Unit 6: Dogfood reproduction and attack-matrix consolidation**

**Goal:** Lock in a failing-then-passing reproduction of #678 and consolidate the
negative/attack matrix into durable regression coverage.

**Requirements:** R1, R5, R6, R7.

**Dependencies:** Units 1-5.

**Files:**
- Test: `tests/integration/receipt-workflow-recovery.test.ts`
- Test: `tests/unit/opencode-operation-observer.test.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- Add the exact #678 integration reproduction: parent starts a protected unit,
  runs a foreground child whose tools target `.worktrees/<x>` on its own branch;
  assert the parent mints the required receipts and the unit can complete.
- Ensure every security scenario from U1/U2/U4/U5 has an owned regression test;
  fill any gaps.
- Confirm restart/recovery preserves target identity (resume the accepted
  conversation and re-read parent mints are stable).

**Execution note:** Start from a failing reproduction test on the pre-fix
behavior to prove the test bites before U1-U5 land.

**Patterns to follow:** `startMockModelServer` / `startOpencodeServer` /
`createIsolatedFixture` / `receiptMintSummaries` harness in
`tests/integration/receipt-workflow-recovery.test.ts`.

**Test scenarios:**
- Integration: #678 reproduction fails before the fix, passes after.
- Integration: two worktrees with identical HEAD and contents remain distinct by
  target digest.
- Integration: restart/recovery preserves target identity and stable mints.

**Verification:** the #678 reproduction passes; the full negative matrix is
covered; restart replay is stable.

## System-Wide Impact

- **Interaction graph:** `tool.execute.before/after` for local operation tools,
  `task.after` rollup, and the receipt ledger/readback serialization path are all
  touched. Remote push/PR observation inherits the derived-target observer.
- **Error propagation:** target validation failures and between-hook tampering
  must reach `markUnavailable` (fail-closed), never silently downgrade to the
  fixed observer.
- **State lifecycle risks:** unit target pinning adds per-unit state; ensure it is
  captured in the same durable progression that survives restart, and that batch
  rollup remains preflighted so a late failure cannot leave partial mints.
- **API surface parity:** the new canonical field must be threaded through every
  enumerator in both ledger and readback; a missed site silently drops the field
  from one path and breaks recovery.
- **Integration coverage:** the real-host recovery harness is the only place that
  proves the parent-rooted-session / worktree-targeted-tool combination end to
  end — unit tests with stubbed runners cannot.
- **Unchanged invariants:** `workspaceIdentity` remains the stable parent lineage
  identity (not repository-scoped); the observe-vs-protected default, disablement
  model, and Question attestation channel are unchanged; the fixed-observer parent
  path stays the fast path.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Bare common-dir check spoofable by fake gitfile | Require `git worktree list` membership + `.git` linkage validation, not just common-dir (U1). |
| Inherited `GIT_*` laundering an unrelated dir as parent | Strip the `GIT_*` allowlist in both command runners; test with injected poisoned env (U1). |
| New canonical field missed at one enumerator → broken recovery | Enumerate all edit sites from the `worktreeDigest` precedent map (U3), including the `hasExactKeys` closed-set gate that would otherwise reject the field; readback round-trip test. |
| Schema/protocol version bump breaks durable persisted v1 receipts in session metadata | Ship the resolved one-version backward-read shim (v1 → parent-target only, reject v1 foreign-target); version-mismatch + v1-shim tests (U3). |
| Optional field becomes an evidence-omission bypass (omit to dodge target validation) | v2 requires the field for all local ops incl. parent-target; single canonical `?? null` serialization; omit-field-rejected test (U3, U4). |
| In-memory-only target pin forgotten on restart → target B admitted into unit A | Pin lives in durable unit progression state (`pinnedOperationTargetIdentity`); restart/replay pin-survival test (U4). |
| Single-target pinning rejects legitimate mixed-checkout workflows | Documented intentional V1 limitation with explicit failure message; multi-target map deferred; mixed-target rejection test (U4). |
| Bash command-internal escape (script writes into another checkout) launders a receipt | Accepted residual: the classifier already blocks `git -C`/absolute `cd` (only exact recognized forms + safe-relative `cd` mint); in-process side effects of a recognized command are the deferred sandbox item, not a new hole. Receipt semantics are "recognized command succeeded from the attested target," not "all I/O stayed inside it." |
| Per-target observer regresses u5 shared-parent rollup | Parent-target fast path preserved; characterization-first before refactor; u5 regression test kept green (U4, U5). |
| Wrong per-tool arg key (`filePath` vs `path`) in real host | Confirm keys against OpenCode v1.18.x before finalizing derivation; derive from every file target (U2, deferred question). |
| Partial rollup mutation on a malformed batch | Preserve batch preflight before first mint; malformed-later-receipt test (U5). |

## Documentation / Operational Notes

- After merge, add a `docs/solutions/` entry extending the 2026-07-31 delegated-
  receipt learning with the foreign-worktree observation layer and the spoof
  matrix.
- Regenerate config schema / registry only if a version-bump surfaces a
  user-visible field (unlikely — receipt internals are not user config).
- **Upgrade staging (receipt version bump):** because durable v1 markers persist
  in session ToolPart metadata, a user resuming a conversation across the upgrade
  can carry v1 receipts into v2 code. The v1 backward-read shim admits only
  parent-target legacy evidence; v1 foreign-target evidence is unrecoverable and
  fails closed (guarded unit re-derives evidence rather than silently completing).
  This is the accepted upgrade behavior — no in-flight unit is silently
  completed, at worst it must re-run a recognized operation. Call this out in the
  release notes for the version-bump release.

## Sources & References

- Issue: [#678](https://github.com/marcusrbrown/systematic/issues/678)
- Prior fix: [PR #719](https://github.com/marcusrbrown/systematic/pull/719),
  documented in
  `docs/solutions/integration-issues/delegated-receipt-rollup-live-state-recovery-2026-07-31.md`
- Handoff: `.context/handoffs/678-receipt-guard-worktree-observer-regression.md`
- Prior guard plan: `docs/plans/2026-07-25-001-feat-receipt-backed-workflow-guard-plan.md`
- Key code: `src/index.ts:72-98`, `src/lib/opencode-operation-observer.ts`,
  `src/lib/opencode-workflow-guard.ts` (`rollupForegroundTask` 1404,
  `prepareOperation` 1958, `captureAfterOperation` 2568,
  `buildOperationObservation` 2611), `src/lib/receipt-ledger.ts` (124-139, 1231),
  `src/lib/receipt-readback.ts` (`mintIntegrity` 668-676)
- Vendored host source: `.slim/clonedeps/repos/anomalyco__opencode/`
