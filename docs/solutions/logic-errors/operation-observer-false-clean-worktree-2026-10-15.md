---
title: The operation observer reported a changed worktree as unchanged or committed
date: 2026-10-15
category: logic-errors
module: workflow-guard
problem_type: logic_error
component: development_workflow
symptoms:
  - "Worktree edits made through the shell left the worktree digest unchanged, so receipts stayed fresh"
  - "Commit closure reported true for a tree with uncommitted changes, so a commit receipt was minted"
  - "Repository git config, refs and ignore files changed what the snapshot saw"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [workflow-guard, operation-observer, worktree-digest, commit-closure, git-plumbing, fail-closed]
---

# The operation observer reported a changed worktree as unchanged or committed

## Problem

The workflow guard trusts two values from the operation observer's local snapshot (`src/lib/opencode-operation-observer.ts`):

- `worktreeRevisionDigest`, which decides receipt staleness (`staleForChange` and `markStaleReceipts` in `src/lib/workflow-guard.ts`);
- `commitClosure`, which must be `true` before `validateCommit` in `src/lib/receipt-classifier.ts` mints a commit receipt.

An agent with a shell could change the tree and still get "unchanged" or "closed". Reported in #1099 and fixed in #1129.

## Symptoms

- A real edit left the digest unchanged, so evidence minted before the edit stayed fresh.
- `commitClosure` was `true` while the working tree differed from `HEAD`.
- Neither read reported an error.

## What Didn't Work

- **Trusting git for file identity (#1095).** A design that took identity from the git index, or from `git hash-object` with filters, was rejected after reviewers fooled it with a forged `.git/index` and with a repository clean filter. Identity stays on raw bytes.
- **Baselines captured when the observer starts.** Checks that compared against state captured at construction were defeated in review, because that state is agent-writable before capture and is reset by a restart. Those cases moved to #1126. See [stop patching after a second review round](../workflow-issues/stop-patching-after-second-review-round-2026-10-15.md).
- **Framing tests that encoded one layout.** The first collision tests reproduced the old NUL-separated bytes, so a different unframed layout still passed them.

## Solution

Each vector has a real-git fixture in `tests/unit/opencode-operation-observer.test.ts`.

| Vector | What it fooled | Fix |
|---|---|---|
| Replace refs, `core.fsmonitor`, `core.ignorecase` | `git replace` redirected `HEAD`'s tree, so `git diff --quiet HEAD` read closed. A repo fsmonitor hook ran inside observer git calls. Case folding hid new untracked files. | Every local snapshot git call runs with a forced prefix, applied once per observer at construction. Remote readbacks are unchanged. |
| Clean filters, intent-to-add | A clean filter normalized an edit back to the committed bytes, so the tree read closed | Closure compares the observer's own records with `HEAD`'s `ls-tree`. `git diff` is no longer called. |
| `git rm --cached` plus an ignore rule | A `HEAD` path vanished from every listing | The path set is index ∪ `HEAD` tree ∪ untracked |
| Ignore-rule edits | Editing `info/exclude`, `core.excludesFile` or an untracked `.gitignore` left the digest unchanged | Those bytes are identity facts. An absent source differs from an empty one. A FIFO, a device or a file over 1 MiB fails closed. Ignored files themselves are not hashed and never block closure (#1126). |
| Uninitialized submodule | It reported the parent's `HEAD` | A gitlink counts as checked out only when `<path>/.git` exists and the submodule's top level is that path. An empty directory is uninitialized, and a populated one with no `.git` fails closed. More than 32 gitlinks fail before any submodule is inspected. |
| Changes during the snapshot | A file swapped or rewritten mid-read | Reads use `O_NOFOLLOW` and `O_NONBLOCK` with an fstat dev/ino check. A final pass compares each stored stat with a fresh one and re-checks ancestor directories, listings, ignore sources, gitlinks and the repository anchor. Any difference is `worktree-unstable`. Where `O_NOFOLLOW` is undefined (Windows), only the stat comparison applies. |
| Unframed digest | Path, mode and content were separated only by NUL, so crafted content plus a deleted file reproduced the old digest. This predates #1099. | `hashField` length-prefixes every variable field of the worktree digest. The domain tag is `worktree:v3`. |
| In-session redirects | A `<gitdir>/commondir` rewrite moved `HEAD` to another repository and flipped closure to true | The top level, git dir and common dir are pinned at construction and compared on every snapshot and in the final pass (`target-unavailable`). A path under a symlinked ancestor directory fails closed. |
| Non-UTF-8 git output | It was decoded lossily and silently | A fatal decoder sets `invalidOutput`, which maps to `file-read-failed` |

Code review on #1129 also found availability problems, and they were fixed in the same PR. Two of them:

- Self-ignored `.gitignore` discovery from a subdirectory target needed `--full-name` and the pathspec `:(top,glob)**/.gitignore`.
- Some paths are displaced in the tree: a file↔directory swap, an absent submodule directory, or a submodule converted to ordinary files. These are now recorded as deletions, so the snapshot stays available and the digest is stable across the commit.

Some trees read not closed by design: files git normalizes on commit (CRLF), `core.filemode=false` mounts, and case-only renames on case-insensitive volumes. In each case a commit receipt is blocked; none produces a false one.

### Key code

From `src/lib/opencode-operation-observer.ts`, with comments omitted.

The forced prefix and its wrapper:

```ts
const FORCED_GIT_PREFIX = [
  '--no-replace-objects',
  '-c',
  'core.ignorecase=false',
  '-c',
  'core.fsmonitor=false',
] as const

function withForcedGitPrefix(
  runner: OperationObserverCommandRunner,
): OperationObserverCommandRunner {
  return (args, cwd, maxOutputBytes, timeoutMs) =>
    runner([...FORCED_GIT_PREFIX, ...args], cwd, maxOutputBytes, timeoutMs)
}
```

`hashField`, which frames each worktree-digest field:

```ts
export function hashField(
  hash: ReturnType<typeof createHash>,
  field: string | Uint8Array,
): void {
  const bytes = typeof field === 'string' ? Buffer.from(field) : field
  hash.update(`${bytes.byteLength}:`)
  hash.update(bytes)
}
```

`deriveCommitClosure` (body only), which computes closure from the records alone:

```ts
  if (head === undefined) return false
  let matched = 0
  for (const record of records) {
    const entry = headTree.get(record.path)
    if (entry === undefined || !recordMatchesTreeEntry(record, entry)) {
      return false
    }
    matched += 1
  }
  return matched === headTree.size
```

`verifyAnchorUnchanged` (body only), the final-pass anchor check:

```ts
  const { pin } = context
  if (
    anchor.toplevel !== pin.targetRoot ||
    anchor.gitDir !== pin.gitDir ||
    anchor.commonDir !== pin.commonDir
  ) {
    return { status: 'error', reasonCode: 'target-unavailable' }
  }
  return anchor.head === head ? { status: 'ok' } : UNSTABLE
```

## Why This Works

- **The prefix comes before the subcommand.** After the subcommand, `-c` means `--cached` for `ls-files`. Placed before it, the overrides win over repository-local, `config.worktree` and `include.path` values.
- **Closure is a comparison, not a question to git.** The index and the listings only decide which paths are observed. Whether a path matches is decided by the bytes the observer read (kind, mode and blob id) against `HEAD`'s tree. Every record must match an entry, and the count must equal the tree size, so the two sets are equal. The forced prefix neutralizes replace refs. Clean filters and index stat data play no part.
- **The final pass re-checks everything the snapshot relied on.** If a redirect moved the pin, the snapshot returns `target-unavailable`. Any other change returns `worktree-unstable`, which blocks the unit recoverably. Stat values are compared but never hashed, so touching a file without changing it leaves identity alone.
- **Length framing puts field boundaries into the hash**, so no field's content can imitate another field.

**Upgrade effect.** The digest domain changed to `worktree:v3`. A unit that was in progress across the upgrade has its completion rejected as `stale-receipt`. That rejection is retryable: the guard stays available, and the stale operations are rerun before completing again.

**Cost.** A snapshot spawns 12 git processes instead of 9.

## Prevention

- **Mutation-test the check behind each fixture.** Remove or weaken the check in the source, then confirm that its real-git test fails.
- **Test the invariant, not the encoding.** The framing tests feed field sequences through the production `hashField`. They assert that sequences with the same concatenation digest differently: a shifted boundary, a NUL at the boundary, a length-like prefix, a merged field and an empty field. A test that pins one byte layout passes again as soon as the layout changes. Only the NUL-at-boundary case caught a separator-only layout.
- **Check that a test isn't masked by another check.** The first `O_NOFOLLOW` test still passed with the flag removed, because the later fstat check caught the swap. The replacement spies on `fs.openSync` and asserts the flag directly.
- **Skip visibly.** Capability probes at module scope drive `test.skipIf(...)` for SHA-256, `mkfifo` and non-UTF-8 symlinks. A bare `return` inside a test reports a pass on machines that lack the capability.

### Not covered

The limits are listed in ARCHITECTURE.md under "Local observer snapshot":

- #1126: ignore rules that hide uncommitted work from closure, redirects made before the observer starts or across a restart, and dirty submodule contents.
- #1124: `worktree-unstable` and limit failures now block the unit recoverably instead of leaving the guard unavailable. A snapshot timeout, including a FIFO or device named `.gitignore`, still makes the guard unavailable (#1084).
- #1125: restored receipts are not rechecked at restore time.
- Residuals:
  - a write after the final pass;
  - a same-size rewrite within the filesystem's timestamp granularity;
  - a FIFO named `.gitignore`, which makes git block until the per-command timeout before the snapshot fails closed.

## Related Issues

- #1099 and #1129 (this fix); #1095 (rejected git-backed identity); #1125 and #1126 (deferred); #1124 (limit failures and `worktree-unstable` now block recoverably; snapshot timeouts stay fatal, #1084).
- [Worktree-targeted receipt observation](../integration-issues/worktree-targeted-receipt-observation-2026-08-02.md): structural worktree identity, with evidence and readbacks in one revision domain.
- [Delegated receipt rollup and live-state recovery](../integration-issues/delegated-receipt-rollup-live-state-recovery-2026-07-31.md): stable workspace identity versus mutable revision identity.
- [Workflow guard digest collapse](workflow-guard-digest-collapse-long-identities-2026-10-14.md): a comparison path must never map distinct values to one digest.
