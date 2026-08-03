---
title: Receipt guard missed worktree-targeted child operations
date: 2026-08-02
category: docs/solutions/integration-issues
module: workflow-guard
problem_type: integration_issue
component: development_workflow
symptoms:
  - Protected workflow units ended waiting/missing-evidence despite the child committing real work
  - Operations in an isolated nested git worktree looked like no-ops to the guard
  - Completion later rejected with stale-receipt after receipts were minted
  - Test fixtures failed with file-read-failed when the nested worktree was not gitignored
root_cause: scope_issue
resolution_type: code_fix
severity: high
tags:
  - workflow-guard
  - receipts
  - git-worktree
  - observer
  - opencode
  - trust-boundary
---

# Receipt guard missed worktree-targeted child operations

## Problem

The receipt-backed workflow guard proves that guarded operations
(implementation / verification / commit) actually happened before a protected
workflow unit may complete. It observed git state through a **single** operation
observer created once at plugin init and pinned to the parent checkout's
absolute path. When a foreground `task` child stayed host-rooted at the parent
checkout but its tools targeted an isolated nested git worktree (via a `bash`
`workdir` or absolute file paths), the fixed observer read the unchanged parent
tree — so every operation looked like a no-op, no receipts were minted, and the
unit ended `waiting/missing-evidence` (issue #678).

## Symptoms

- A foreground child does real work in `.worktrees/<x>` (its own branch) and
  commits, but the parent unit never leaves `waiting/missing-evidence`.
- `implementationNoOpReason` classifies the operation as `unchanged-worktree`
  because `after.worktreeDigest === context.worktreeDigest`.
- After the observer was taught to mint against the worktree, completion then
  rejected with `stale-receipt`.
- Integration fixtures that created a nested worktree without gitignoring
  `.worktrees/` failed with `file-read-failed` in the parent observer's
  untracked-file walk.

## What Didn't Work

- **The naive "just derive the target from the tool args" fix is exploitable.**
  A bare `git rev-parse --git-common-dir` equality check is spoofable with a fake
  `.git` gitfile that points at the parent's git dir but is not a real registered
  worktree. Ambient `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` in the
  observer subprocess env can also make an unrelated directory resolve as the
  parent repository. Deriving *which path was mentioned* is not the same as
  validating *which worktree is real*.
- **Stamping the parent revision at completion caused a false stale delta.** The
  guard tracks a single current revision vector
  (`currentRepositoryIdentity` / `currentWorktreeIdentity`) seeded from the
  parent. Once receipts were minted against the *worktree* revision, a completion
  readback stamped from the *parent* observer produced a false `changedWorktree`
  delta → `markStaleReceipts` → completion rejected `stale-receipt`. Evidence and
  the completion readback must live in the same revision domain.
- **Suppressing `markStaleReceipts` is wrong.** Within a worktree the revision
  legitimately advances between implementation (pre-commit) and commit
  (post-commit); the existing stale logic handles that correctly once the domain
  is consistent. Skipping it would let genuine post-evidence edits through.

## Solution

A layered fix that observes the directory the tool actually operated on,
validates it as a real registered worktree, and threads an authenticated target
identity through mint, rollup, and completion — without weakening the stable
workspace / mutable revision trust boundary.

1. **Registered-worktree validation + `GIT_*` sanitization**
   (`src/lib/opencode-operation-observer.ts`). A candidate directory is trusted
   only when common-directory identity **and** `git worktree list --porcelain -z`
   membership **and** `.git` linkage (bidirectional backlink) all agree. All
   `GIT_*` variables are stripped from observer subprocesses so ambient env
   cannot spoof the parent repo. Fake gitfiles and poisoned env fail closed.

2. **Host tool target derivation**
   (`deriveOpencodeOperationTarget`, `src/lib/opencode-workflow-guard.ts`).
   Resolve the worktree a `bash` / `write` / `edit` / `apply_patch` operation
   acted on from `workdir` / file targets (every file target for a multi-file
   patch), failing closed on escaping, mixed-worktree, or git-admin paths.

3. **Authenticated `operationTargetIdentity` canonical field**
   (`src/lib/receipt-ledger.ts`, `src/lib/receipt-readback.ts`). A new canonical
   receipt field bound into the salted SHA-256 integrity digest, with a
   coordinated `RECEIPT_SCHEMA_VERSION` / `RECEIPT_PROTOCOL_VERSION` /
   `MARKER_PROTOCOL_VERSION` bump 1 → 2 and a v1 backward-read shim (legacy
   receipts recover as parent-target only; v1 foreign-target evidence is
   rejected). **Invariant: local operations require the field; remote operations
   must omit it.** Absence is never an implicit "parent-target" mode — a v2 local
   receipt missing the field is rejected.

4. **Durable single-target unit pin**
   (`pinnedOperationTargetIdentity` in `UnitState`, `src/lib/workflow-guard.ts`).
   The first trusted local operation pins the unit's target in durable
   progression state (surviving restart via `parseRecoveryUnit`); a later local
   operation resolving to a different worktree fails closed. Mixing parent and
   worktree targets in one unit is intentionally rejected.

5. **Worktree-aware foreground child rollup**
   (`rollupForegroundTask`). Each recovered child receipt is rolled up against
   its own authenticated target snapshot (validated as a registered worktree),
   not the fixed parent observer. Target / registration mismatch is fatal;
   only repository / worktree revision staleness is skippable.

6. **Effective completion observer**
   (`completionReadbacks`). For a unit pinned to a non-parent worktree,
   completion resolves one effective observer (the pinned registered worktree)
   and anchors the global **and** remote final readbacks to that target's
   revision, while keeping `workspaceIdentity` the stable parent identity. The
   parent observer is still used for the workspace-stability check only.

## Why This Works

The fix cleanly separates three identities that were previously conflated in one
fixed-root observer:

- **`workspaceIdentity`** — the stable parent-checkout lineage boundary. Never
  moves per operation; receipts are namespaced to it.
- **`operationTargetIdentity`** — the authenticated worktree the evidence was
  produced in. Mismatch is **fatal**.
- **`repositoryIdentity` / `worktreeIdentity`** — mutable revision digests.
  Staleness is **skippable** once the target matches.

Because the completion readback is anchored to the same target that minted the
evidence, there is no cross-root false delta. Because the target identity is
authenticated (integrity-covered) and validated as a registered worktree, a
confused or malicious child cannot launder work from an unrelated repo/worktree
into the parent unit. Every path where a target cannot be validated or observed
fails closed to `unavailable` — nothing completes a unit on evidence that did not
happen.

## Prevention

- **A single fixed-root observer is wrong for multi-worktree work.** Observe the
  directory the tool actually operated on, derived from host tool inputs (never
  model or child prose).
- **Validate worktrees structurally, not by path.** Common-dir equality alone is
  spoofable; require `git worktree list` membership and `.git` linkage, and strip
  `GIT_*` from git subprocesses.
- **Adding a canonical receipt field is a cross-cutting change.** Thread it
  through every enumerator (parse / clone / serialize / compare / mint / digest),
  the `hasExactKeys` closed-set gate and `CANONICAL_OPTIONAL_KEYS`, and bump
  `RECEIPT_SCHEMA_VERSION` / `RECEIPT_PROTOCOL_VERSION` / `MARKER_PROTOCOL_VERSION`
  together with a v1 read shim (durable markers persist in session metadata, so a
  hard break strands in-flight units).
- **Never overload optional-field absence across local vs remote semantics.**
  Scope "field required" to local operations; remote operations must omit it.
- **Anchor completion readbacks to the same revision domain as the evidence.**
  Do not compare a parent-root before digest against a worktree after digest.
- **`.worktrees/` must be gitignored** so the parent observer's untracked-file
  walk skips nested worktrees (mirrors the real repo's `.gitignore`). Test
  fixtures that create a nested worktree must gitignore it too, or the observer
  returns `file-read-failed`.
- **Keep the attack matrix as durable regression tests:** spoofed `.git`
  gitfiles (parent and linked-worktree admin dir), poisoned `GIT_*` env,
  submodule / nested-repo targets, symlink escapes, `apply_patch` spanning two
  worktrees, target switch mid-unit, mid-acquisition target change, registration
  substitution, and cross-root content-vs-HEAD staleness.

## Related Issues

- Issue #678 — the bug fixed here.
- PR #741 — the fix (released v3.5.6).
- Issue #740 — follow-up hardening (marker v1 read shim; observer worktree-
  registry refresh + transient-failure retry). Both degrade to `unavailable`
  today and are out of scope for this fix.
- [`delegated-receipt-rollup-live-state-recovery-2026-07-31.md`](./delegated-receipt-rollup-live-state-recovery-2026-07-31.md)
  — the **predecessor layer** (PR #719): delegated-receipt rollup across session
  and revision boundaries for the *same* checkout. That doc's fixed-root observer
  framing is superseded by this one (foreign nested worktree), but its
  stale-revision and live-state recovery lessons still stand — this is the next
  layer, not a contradiction.
- [`isolated-opencode-subprocess-fixtures-2026-05-14.md`](./isolated-opencode-subprocess-fixtures-2026-05-14.md)
  — supporting subprocess-isolation / restart-recovery baseline.
