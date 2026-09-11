---
title: Match filesystem safety evidence to the operation being guarded
date: "2026-09-10"
category: best-practices
module: ce-review-cleanup
problem_type: best_practice
component: testing_framework
severity: high
applies_when:
  - "Testing filesystem readers, writers, or cleanup helpers"
  - "A test copies a production guard instead of invoking the guarded operation"
  - "Fault injection would otherwise mutate a shared test worker"
  - "Using filenames, timestamps, or cache metadata to justify maintenance"
tags:
  - ce-review-cleanup
  - filesystem-safety
  - fault-injection
  - node-fs
  - fifo
  - inode
  - timestamps
  - aft
---

# Match filesystem safety evidence to the operation being guarded

## Context

The cleanup reader needed to survive a regular file being replaced by a FIFO between
`lstatSync` and `openSync`. A test demonstrated that `O_NONBLOCK` prevented the hang, but copied
the flag calculation instead of calling the production reader. It could stay green if the
production flag disappeared.

The replacement test calls the real `deriveStatusLabel` with a real walked snapshot and forces
the replacement at its actual stat-to-open boundary. Removing the production `O_NONBLOCK`
addition made that retained test time out; restoring it returned `unknown` and closed the fd.

During cache maintenance, a filename alone was not evidence that contents were unused, and a
timestamp-format difference was not evidence of mutation.

## Guidance

**State the claim before choosing the evidence.** A passing test, a file's age, or an empty
open-handle report answers a limited question—not whether an entire operation is safe.

| Claim | Insufficient evidence | Evidence used here |
|---|---|---|
| The reader handles FIFO substitution | A copied `open()` demonstration | Fault injection into the real reader; removing its guard breaks the retained test |
| A read can safely supply bytes for an append | Size observed before opening | Opened-fd size bound, complete read, post-read size/mode checks, and a write-time recheck |
| A replacement has a different inode | Delete, then recreate at the same name | Keep the original inode allocated while creating the replacement |

**Inject the fault in a disposable process, not the shared test worker.** The Node tests mutate
the default `node:fs` object's syscall function and call `syncBuiltinESMExports()` so the
production module's named import observes it. The fixtures remain real files. This avoids
timing-dependent churn and production-only test hooks without affecting sibling tests.

**Test the observable result and cleanup.** An injected read failure must return the documented
sentinel and close the fd—not merely execute a `catch`. The EIO test also restores the binding
and confirms that the reader again returns the fixture's real `completed` label.

**Use one metadata representation throughout a comparison.** On the observed Node/macOS
runtime, ordinary stats rendered an mtime as `.747Z`, while BigInt stats rendered the same
file's timestamp as `.746Z`. Comparing those formatted strings produced a false drift alarm.
The deletion preflight instead compared exact `mtimeNs`/`ctimeNs` and device/inode identity.

## Why This Matters

Path checks and descriptor checks serve different purposes. Keep the pre-open regular-file
check: opening first can block before an fd is available to inspect. `O_NOFOLLOW` does not
prevent a FIFO open from blocking. Where available, `O_NONBLOCK` closes that particular window;
the subsequent type and identity checks reject the substituted object.

Likewise, bounded reads must reject incomplete or changed snapshots. In the ignore helper,
growth that stayed below the cap initially returned a stale prefix, and a short read was
misclassified as a symlink. The corrected reader returns no trusted bytes on either change;
the caller reports `write-conflict`. Checking the actual composed append also prevents the
helper from writing a file beyond its own read limit.

These checks do not establish atomic filesystem safety. Cleanup still requires the stated
offline precondition and separate deletion approval. A preview token or status label does not
authenticate that approval, and an empty handle snapshot cannot prove that no future reader
will open a file.

## When to Apply

- A safety test can pass after the production protection is removed.
- A file can change between inspection and consumption.
- A rare I/O failure needs deterministic coverage without shared-worker mutation.
- Maintenance decisions depend on metadata whose meaning varies by version or representation.

## Examples

### Intercept the real reader's boundary

Excerpt from the isolated Node child in `tests/unit/ce-review-cleanup-preview.test.ts`. The full
test supplies imports, temporary fixtures, the walked snapshot, restoration of both changed
bindings, fd-close assertions, and a timeout. This fragment is not a standalone program.

```js
fs.lstatSync = function (p, options) {
  if (p !== summaryPath) return originalLstatSync(p, options);
  const stat = originalLstatSync(p, options);
  fs.renameSync(p, p + '.aside');
  execFileSync('mkfifo', [p]);
  return stat;
};
syncBuiltinESMExports();

const label = deriveStatusLabel(candidateAbsPath, walked.entries);
```

`mkfifo` is an external fixture capability, not a Node filesystem API. The test explicitly skips
when it is unavailable. The injected fault and production-mutation check establish this reader's
behavior on the exercised platform, not a universal guarantee for every device or filesystem.

### Classify cache files through their current consumer

During AFT maintenance, a `migrated.backup.sqlite-shm` file was actively mapped. Its name did not
make it disposable. Separately, the running v0.55.1 binary and its
[version-matched search-index implementation](https://github.com/cortexkit/aft/blob/44bbbe5cb68435ef45c877271aefdac295c0d287/crates/aft/src/search_index.rs)
established that the current reader uses self-contained `cache.bin`, not old standalone
`lookup.bin` and `postings.bin` companions.

After explicit approval and fresh identity/handle checks, only those two companions in one
temporary-workspace cache were removed: about 11.7 GiB, with `cache.bin` verified unchanged.
That version-specific decision did not authorize other deletions. The preceding ten-minute
measurement showed only about 1.5 MiB of store growth; the retained footprint did not prove a
runaway growth mechanism or identify the migration that left the files behind.

## Related

- [Verify a no-change claim against the consumer](verify-a-no-change-claim-against-the-consumer-2026-09-08.md) — consumer-side evidence for preservation and trust-boundary claims.
- [A perfect measurement is evidence about the instrument](a-perfect-measurement-means-a-broken-instrument-2026-08-16.md) — a clean result can expose a blind measurement rather than a clean system.
- [Safe pi-subagents persona export lifecycle](../integration-issues/pi-subagents-export-config-security-lifecycle-2026-07-30.md) — a different mutation protocol using manifest ownership, locks, and rollback; not interchangeable with offline cleanup.
