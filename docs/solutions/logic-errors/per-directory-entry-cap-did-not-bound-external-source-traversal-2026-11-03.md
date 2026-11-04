---
title: A per-directory entry cap did not bound an external source's traversal or reads
date: 2026-11-03
category: logic-errors
module: search-core
problem_type: logic_error
component: tooling
symptoms:
  - "100 directories of 10,000 non-Markdown files each would cost on the order of a million lstat calls and produce no records"
  - "A file that grew after discovery was read past the remaining shared and per-source byte allowance"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [search, external-sources, resource-bounds, entry-budget, read-allowance, toctou]
---

# A per-directory entry cap did not bound an external source's traversal or reads

## Problem
An external source points at a folder the user or a checkout controls. Its limits did not bound the work: a wide tree of files the source ignores kept the walk busy, and a file that grew after admission could be read past the remaining byte budget.

## Symptoms
- Discovery counted only accepted Markdown files, and each listing had its own cap that reset per directory. Fro Bot's arithmetic: 100 directories of 10,000 non-Markdown files each would cost on the order of a million `lstat` calls and return no records.
- Reads were checked against the size seen at discovery, so a file that grew afterwards was not stopped by the remaining shared or per-source allowance.

## What Didn't Work
- A cap per listing bounds one directory, not the walk, and the accepted-file ceiling never counts skipped entries.
- A size check at admission says what the file was, not what a later read returns.

## Solution
One entry budget per source is shared by every directory and root, and a spent budget opens nothing more (`newEntryBudget`, `src/lib/search-corpus.ts:223-251`; `src/lib/search-external.ts:283-296`). Each read is limited to `readAllowance`, the smallest of the per-file cap and the remaining per-source and per-call budgets (`src/lib/search-corpus.ts:785-795`). `readBytesBounded` reads at most that allowance plus one sentinel byte and rejects a file over it (`src/lib/search-bounded-read.ts:39-69`).

## Why This Works
Each limit is charged where the resource is spent, at the listing and at the read, instead of at an earlier admission step that can go stale. As the comment on `readAllowance` says, "a file can grow after discovery" (`src/lib/search-corpus.ts:739-740`).

Known limit: the budget is charged after a listing succeeds (`budget.remaining`, `src/lib/search-corpus.ts:243-245`), so a listing that fails partway leaves the entries it consumed uncharged.

## Prevention
- Ask of every limit on an untrusted tree: what costs, and is it counted where it is spent? A counter that resets per directory is not a bound.
- Test the real calls. `tests/unit/search-external.test.ts:987` uses `entryBudget: 100` and expects one warning, at most 101 entries read and no listing of the second root.
- Make the file grow between discovery and read. `watchReads` appends at `openSync` time (`tests/unit/search-external.test.ts:926-950`). The tests inject tiny budgets, so they show the limit applied, not a large overrun.
- `tests/unit/search-external.test.ts:1038` gives two sources that are each under the entry limit but together over it. Both load without warnings, which shows each source has its own budget.

## Related Issues
- [A per-reviewer cap reused as a run-level cap made large ce:review runs die at merge](per-reviewer-cap-reused-as-run-level-cap-2026-10-22.md): the same scope mistake.
- [Match filesystem safety evidence to the operation being guarded](../best-practices/match-filesystem-safety-evidence-to-the-operation-2026-09-10.md)
