---
title: ReDoS in bootstrap marker regex exposed by plugin trust-boundary inversion
date: 2026-05-11
category: security-issues
module: src/index.ts
problem_type: security_issue
component: assistant
symptoms:
  - CodeQL alerts #42 and #43 flagged the bootstrap-marker regex as polynomial-time
  - 'Pattern flagged: /<SYSTEMATIC_WORKFLOWS>[\s\S]*?<\/SYSTEMATIC_WORKFLOWS>/'
  - Input shape that triggers backtracking — repeated opening markers with no closing tag
  - Regex was clean under per-process singleton; flagged immediately after switching to per-load registration
root_cause: scope_issue
resolution_type: code_fix
severity: high
related_components:
  - assistant
  - tooling
tags: [redos, codeql, regex, trust-boundary, plugin-registration, bootstrap-injection, security, architecture-inversion]
---

# ReDoS in bootstrap marker regex exposed by plugin trust-boundary inversion

## Problem

PR #352 inverted Systematic's plugin registration model from a per-process
singleton (`plugInOnce`) to independent per-load registration. The bootstrap
marker regex `/<SYSTEMATIC_WORKFLOWS>[\s\S]*?<\/SYSTEMATIC_WORKFLOWS>/` was
unchanged from prior versions, but CodeQL flagged it as polynomial-time
ReDoS-vulnerable on the new branch. The regex hadn't moved; the *trust
boundary around it* had. Under the singleton, the regex only saw content
the plugin itself authored. Under per-load registration, every plugin
source can contribute fragments to `output.system` before the marker
matcher runs — making the matched input attacker-influenceable.

## Symptoms

- CodeQL security scanning posted two inline comments (alerts #42 and #43) on `src/index.ts` lines 30–31 with rule `js/polynomial-redos`.
- Description: "may run slow on strings starting with `<SYSTEMATIC_WORKFLOWS>` and with many repetitions of `<SYSTEMATIC_WORKFLOWS>`".
- The same regex had passed CodeQL on every prior commit; the alert surfaced only after the per-load registration commit (`29fa5e5`).
- PR-level CI: `CodeQL` job FAILURE; all other 7 main-workflow jobs SUCCESS. Branch otherwise APPROVED + MERGEABLE.

## What Didn't Work

- **Bounded-length regex** (`/<SYSTEMATIC_WORKFLOWS>[\s\S]{0,100000}?<\/SYSTEMATIC_WORKFLOWS>/`). Caps backtracking depth with an arbitrary ceiling but leaves a polynomial regex in the hot path. The cap also feels like a magic number without operational justification.
- **Atomic groups or possessive quantifiers** (`(?>...)`, `*+`). Not supported by JavaScript regex. Would require a polyfill or workaround that adds more surface area than it removes.
- **Inline CodeQL suppression comment**. Papers over a real trust-boundary change without addressing the underlying class of risk. Rejected on principle.

## Solution

Replace the regex with a linear-time `indexOf`/`slice` helper. The marker has fixed literal delimiters — there was never a regex requirement, only a regex convenience.

**Before** (`src/index.ts`):
```ts
const BOOTSTRAP_MARKER_PATTERN =
  /<SYSTEMATIC_WORKFLOWS>[\s\S]*?<\/SYSTEMATIC_WORKFLOWS>/

export const applyBootstrapContent = (
  output: { system: string[] },
  content: string,
): void => {
  for (let i = 0; i < output.system.length; i++) {
    const entry = output.system[i]
    if (BOOTSTRAP_MARKER_PATTERN.test(entry)) {
      output.system[i] = entry.replace(BOOTSTRAP_MARKER_PATTERN, content)
      return
    }
  }
  // append path...
}
```

**After**:
```ts
const BOOTSTRAP_MARKER_OPEN = '<SYSTEMATIC_WORKFLOWS>'
const BOOTSTRAP_MARKER_CLOSE = '</SYSTEMATIC_WORKFLOWS>'

const findBootstrapMarkerBlock = (
  entry: string,
): { start: number; end: number } | null => {
  const start = entry.indexOf(BOOTSTRAP_MARKER_OPEN)
  if (start === -1) return null
  const closeStart = entry.indexOf(
    BOOTSTRAP_MARKER_CLOSE,
    start + BOOTSTRAP_MARKER_OPEN.length,
  )
  if (closeStart === -1) return null
  return { start, end: closeStart + BOOTSTRAP_MARKER_CLOSE.length }
}

export const applyBootstrapContent = (
  output: { system: string[] },
  content: string,
): void => {
  for (let i = 0; i < output.system.length; i++) {
    const entry = output.system[i]
    const block = findBootstrapMarkerBlock(entry)
    if (block !== null) {
      output.system[i] =
        entry.slice(0, block.start) + content + entry.slice(block.end)
      return
    }
  }
  // append path unchanged...
}
```

Regression test (`tests/unit/plugin.test.ts`):
```ts
test('completes in linear time on malicious input with many opening markers and no closing tag', () => {
  const malicious = `${MARKER_OPEN.repeat(10000)} trailing content with no close`
  const output = { system: [malicious] }
  const startedAt = Date.now()
  applyBootstrapContent(output, wrap('NEW CONTENT'))
  const elapsedMs = Date.now() - startedAt
  expect(output.system).toHaveLength(1)
  expect(output.system[0]).toContain('NEW CONTENT')
  expect(output.system[0]).toContain(MARKER_OPEN.repeat(10000))
  // Loose upper bound — linear scan finishes in well under 100ms on slow
  // CI runners. The prior regex would take seconds-to-minutes on this input.
  expect(elapsedMs).toBeLessThan(1000)
})
```

## Why This Works

`String.prototype.indexOf` is a linear-time substring search (`O(n + m)` in modern V8/JavaScriptCore via Boyer-Moore-Horspool or two-way). It cannot backtrack — it either finds the substring at some position or fails after scanning each character once. `slice` is `O(k)` where `k` is the slice length. The total cost of `findBootstrapMarkerBlock` is linear in the entry length.

The non-greedy `[\s\S]*?` regex had a different worst-case shape. When the closing tag is absent, the engine matches the opening tag at position 0, scans forward looking for the closing tag, fails, then tries the opening tag at position 21 (its own length), scans forward again, fails again — `O(n²)` on inputs starting with the opening tag.

Two additional secondary benefits from dropping the regex:
- `String.prototype.replace(regex, content)` treats `$&`, `$1`, `$$` as replacement directives. `slice + content + slice` inserts `content` literally. Safer for arbitrary bootstrap payloads.
- The semantics ("first opening tag, then first closing tag after that position") are more legible as `indexOf` calls than as regex. Future readers don't have to recall non-greedy quantifier behavior.

## Prevention

- **When you invert or expand a plugin's trust boundary, re-audit every regex pattern even if it was CodeQL-clean before.** A pattern's safety depends on what input reaches it, not just on its shape. Architectural changes that broaden the set of authors can reclassify a safe regex as unsafe overnight. The pattern itself never changed in this case — only the data flow around it.
- **Prefer `indexOf`/`slice` over regex for fixed literal delimiters.** If neither side has a regex feature (alternation, character classes, anchors), regex is convenience, not requirement. The simpler tool is provably immune to a class of bug the regex isn't.
- **Add regression tests for malformed-delimiter storms, not just happy-path replacement.** The new test in `plugin.test.ts` runs 10,000 repeated opening markers with no closing tag. A loose `< 1000ms` upper bound is enough to catch any polynomial regression without depending on benchmarking infrastructure.
- **Re-run CodeQL locally on architectural changes before opening a PR.** The CI catch happened post-push; the pattern was visible to local CodeQL on the branch before push if anyone had thought to run it. `gh workflow run codeql.yaml` or `codeql database analyze` against a local DB would surface it earlier.

## Related Issues

- [`docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md`](../integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md) — the singleton (PR #335) that PR #352 reverted. Parallel-concept; PR #352 added a 2026-05-10 follow-up section to that doc when the singleton was removed.
- [`docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md`](../best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md) — different trust-boundary concept (config overlays vs runtime regex), same principle: trust assumptions need to be made explicit and re-audited when the boundary moves.
- [`docs/solutions/integration-issues/opencode-config-schema-rejects-ad-hoc-agent-colors-2026-05-09.md`](../integration-issues/opencode-config-schema-rejects-ad-hoc-agent-colors-2026-05-09.md) — another post-shift regression where a previously-tolerated input became invalid under a stricter downstream contract. Parallel-concept.
- PR #352: https://github.com/marcusrbrown/systematic/pull/352
- CodeQL rule: [`js/polynomial-redos`](https://codeql.github.com/codeql-query-help/javascript/js-polynomial-redos/)
