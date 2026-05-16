---
title: 'Zsh `for` Loops Silently Fail on Unquoted Variables: 41 Unconverted Files Shipped Past Verification'
date: 2026-04-17
severity: high
category: integration-issues
component: batch-conversion-tooling
tags:
  - zsh
  - bash
  - shell-scripting
  - batch-operations
  - silent-failure
  - verification-gap
  - batch-conversion
last_refreshed: 2026-05-16
environment: 'macOS / zsh 5.9 / bun 1.x'
symptoms:
  - 'Batch `sed` conversion reports success but zero files actually modified'
  - 'Downstream verification grep returns zero results, falsely signaling "clean"'
  - '41 files containing residual `Claude Code`, `compound-engineering:`, `CLAUDE.md`, `AskUserQuestion`, `${CLAUDE_PLUGIN_ROOT}` refs shipped into a commit after both conversion and verification "passed"'
  - 'Issue discovered only when a downstream consumer spot-reviewed the diff and flagged untouched references'
root_cause: 'Zsh does NOT word-split unquoted `$variable` in `for` loops by default (unlike bash). A loop like `FILES=$(git diff --name-only); for f in $FILES; do ... done` iterates ONCE in zsh, with `$f` bound to the entire multi-line string. `[ -f "$f" ] || continue` returns false (the multi-line blob is not a file path), the loop body is skipped, and every `sed` or `grep` inside never runs. Because BOTH the conversion loop AND the verification loop used the same broken pattern, both failed together — producing a misleadingly "clean" verification signal.'
resolution_type: workflow_improvement
confidence: verified
related:
  - docs/solutions/integration-issues/converter-code-block-tool-name-capitalization-20260210.md
  - docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md
  - docs/solutions/workflow-patterns/truth-reset-scope-split-20260417.md
---

# Zsh `for` Loops Silently Fail on Unquoted Variables: 41 Unconverted Files Shipped Past Verification

## Problem

A batch shell script intended to apply 10+ `sed` rewrites across ~73 files (final CEP→Systematic reconciliation sync) reported success. An immediately-following verification `grep` loop reported "clean — zero residual refs". The commit landed.

A subsequent spot review revealed 41 of those 73 files still contained unconverted `Claude Code` branding, `compound-engineering:` plugin prefixes, `CLAUDE.md` path references, `AskUserQuestion` tool names inside backticks, and `${CLAUDE_PLUGIN_ROOT}` path examples — 200+ individual lines. Both the conversion AND the verification had run on effectively **zero files**.

## Symptoms

- `sed` exit code 0 across 10+ passes
- Verification `grep` returns empty output
- No error messages at all
- Diff scope accurate: 73 files listed, but per-file content unchanged
- Issue visible only by opening a sample converted file and reading the content

## What Didn't Work

**Assumption: "tests pass, build green, zero grep hits means conversion worked."** The quality gate (build + typecheck + lint + 331/331 unit tests + 28/28 integration tests) all passed because **string substitution in markdown content has no compile-time or test signal**. The grep "clean" was also a false positive — see root cause.

**Assumption: "the converter handles this — no need to verify line counts."** The converter *did* handle the subset of conversions it processes (it skips fenced code blocks by design, documented in a separate learning). The batch sed was supposed to be the safety net that caught what the converter skipped. When the safety net itself failed silently, the two-layer system collapsed to zero coverage.

## Solution

Replace the broken zsh `for` pattern with `find | while read` (or equivalent). Three safe patterns:

```bash
# WRONG (zsh silent failure — loop runs ONCE with $f = entire multi-line string)
FILES=$(git diff --name-only)
for f in $FILES; do
  [ -f "$f" ] || continue
  sed -i '' -e 's/old/new/g' "$f"
done

# RIGHT (option 1: find | while read — portable across zsh and bash)
find skills agents -type f -name '*.md' | while IFS= read -r f; do
  [ -f "$f" ] || continue
  sed -i '' -e 's/old/new/g' "$f"
done

# RIGHT (option 2: find -exec — no shell loop at all)
find skills agents -type f -name '*.md' -exec sed -i '' -e 's/old/new/g' {} +

# RIGHT (option 3: force word-split in zsh — only use if you control the shell)
FILES=$(git diff --name-only)
for f in ${=FILES}; do    # ${=VAR} forces word-split in zsh
  [ -f "$f" ] || continue
  sed -i '' -e 's/old/new/g' "$f"
done
```

## Why This Works

Bash `for f in $VAR` performs implicit word-splitting on `$IFS` characters (space, tab, newline). Zsh does not — it treats `$VAR` as a single token unless you explicitly request splitting (`${=VAR}` or `${(z)VAR}`) or use array expansion. Migrating a batch shell script from bash to zsh (or writing one in zsh without testing it) without knowing this difference produces silent single-iteration loops.

`find | while read` sidesteps the split semantics entirely — `read` consumes one line per iteration regardless of shell. `find -exec ... +` skips the shell loop layer altogether, letting `find` pass file paths directly to `sed`.

## Prevention

**Verify batch conversions with a SECOND grep that uses a DIFFERENT iteration pattern than the one that applied the conversion.** If both use the same broken iteration, both fail silently together. For example:

```bash
# Applied conversions via find | while read:
find skills -type f -name '*.md' | while IFS= read -r f; do sed -i '' 's/X/Y/g' "$f"; done

# Verify with recursive grep (no iteration loop at all):
grep -rl 'X' skills/ && echo "BUG: still found X after conversion" && exit 1

# Or verify with a different loop pattern (xargs):
find skills -type f -name '*.md' -print0 | xargs -0 grep -l 'X' && echo "BUG" && exit 1
```

**Sanity-check iteration early.** Add a single `echo` inside the loop body before doing real work:

```bash
# Quick sanity check BEFORE running actual sed
find skills -type f -name '*.md' | while IFS= read -r f; do echo "would process: $f"; done | head -5
# If this shows fewer than expected lines, STOP.
```

**Prefer `find -exec` for mechanical conversions.** It is shell-agnostic, has no iteration bugs, and is shorter than the equivalent while-read loop:

```bash
find skills agents -type f \( -name '*.md' -o -name '*.mdx' \) \
  -exec sed -i '' -e 's/old/new/g' {} +
```

**Add a drift-gate to CI** that re-runs the content-integrity grep on every PR. The two distinct bugs in this PR cycle (this zsh bug + the reconciliation-sync reference-integrity gap) would both have been caught by a CI check that asserts:

1. Zero `Claude Code`, `TaskCreate`, `AskUserQuestion`, `compound-engineering:`, `.claude/`, `CLAUDE.md`, `${CLAUDE_PLUGIN_ROOT}` patterns in `skills/`, `agents/`, `.opencode/` (with documented exceptions)
2. Every `systematic:*` agent/skill reference in content files resolves to an existing file on disk

the content-integrity gate at `scripts/content-integrity.ts` (live since v2.5.0).

**General rule:** when writing batch shell scripts that will be run on different developer machines, **test with `set -x` at least once** to confirm the loop body runs the expected number of times. Silent correctness in shell is a trap.
