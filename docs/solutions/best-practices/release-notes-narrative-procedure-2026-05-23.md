---
title: Release notes narrative procedure for semantic-release-published GitHub releases
date: 2026-05-23
category: best-practices
module: release-pipeline
problem_type: best_practice
component: documentation
severity: medium
applies_when:
  - A published GitHub release body contains only terse auto-generated commit-subject bullets
  - A release body contains a spurious "closes [URL-fragment]" autolink from semantic-release misparse
  - Retroactively improving narrative quality of historical releases
  - Any release where commit bodies or PR descriptions contain richer context than the published notes
tags:
  - release-notes
  - semantic-release
  - gh-release
  - narrative-changelog
  - autolink-defense
---

# Release notes narrative procedure for semantic-release-published GitHub releases

## Problem

`@semantic-release/release-notes-generator` with the `conventionalcommits` preset builds release bodies from commit subject lines only. Commit bodies and PR descriptions are never ingested. The result is mechanically correct but qualitatively thin: a bucket of one-line bullets that tells readers what changed but not why it matters. The v2.20.5 release body (captured at `.context/pr-evidence/release-notes-narrative/v2.20.5-before.md`) is the canonical before-state: two bullets, no prose, no context about why the Renovate grouping change matters or what the dependency update covers.

The same generator misparses any `path#fragment` substring in a commit body as a `Closes #N` footer. When a commit body contains a cross-reference like `reference/configuration#typed-validation`, semantic-release treats the fragment as a numeric issue reference and emits a broken autolink pointing at a nonexistent issue. This failure mode surfaced in the v2.21.0 release and required a manual patch session. The v2.20.5 and v2.20.6 retroactive patches (documented in `.context/pr-evidence/release-notes-narrative/`) established the before/after shape that the formalized procedure now reproduces reliably.

Both failure modes are recurring, not one-off. The commit-subject-only limitation is structural — it is how the generator works, not a configuration gap. The misparse is triggered by any commit body containing a `path#fragment` cross-reference, which is a common documentation pattern. Without a formalized post-publish patch procedure, every release is either thin or potentially broken, and the fix is ad-hoc each time.

## Solution

The post-publish patch applies via `gh release edit --notes-file` against an already-published release. The procedure walks the commit range with `git log`, parses each commit into `(type, scope, subject, prose body)` tuples, groups commits into the bucket map mirrored from `.releaserc.yaml`, and synthesizes narrative prose from the structured commit data. When a release contains exactly one commit and the prose body is fewer than 200 non-whitespace characters, the procedure enriches from the PR description via `gh pr view`. The rendered body replaces the auto-generated one unconditionally.

Spurious autolinks are stripped via an AST-based four-condition allowlist before the body is applied. The strip is surgical: only links that satisfy all four conditions (AST link node, text-matches-segment, non-numeric segment in a GitHub issues URL, immediate sibling after a `closes` text node) are removed. All other markdown links are preserved. The allowlist semantics are documented in `.agents/skills/release-notes-narrative/references/autolink-allowlist.md`.

The full procedure is formalized at [`.agents/skills/release-notes-narrative/SKILL.md`](../../.agents/skills/release-notes-narrative/SKILL.md). The v2.20.5 after-state (`.context/pr-evidence/release-notes-narrative/v2.20.5-after.md`) is the canonical demonstration: the two terse bullets become a Bug Fixes narrative paragraph explaining the Renovate grouping rationale, a Build System entry with the specific version bump, and a Compare link — all traceable to the commit log.

## Why This Works

### Commit log as authoritative source

Walking the commit log with `git log <PREV>..<TARGET>` handles both single-PR squashes and multi-PR flush releases uniformly. The commit log is the only artifact that is always present, always scoped to the exact release range, and always contains the conventional-commit type information needed for bucket assignment. PR bodies are richer but optional — they are consulted only when the commit body is thin (the 200-character threshold). This asymmetry is intentional: for rich commit bodies, the commit log is sufficient; for thin ones, the PR body provides the context the commit author chose not to repeat in the commit message.

### Positive allowlist over denylist regex

The autolink-strip allowlist requires all four conditions to hold simultaneously before a link is removed. This is safer than a regex denylist for two reasons. First, a regex sweep over the raw body string cannot reliably determine AST sibling relationships — the v2.21.0 failure mode was itself a regex-based misparse, and a regex-based fix would be vulnerable to the same class of false positives on multiline or nested markdown. Second, the four conditions are independently necessary: condition (c) preserves legitimate numeric issue links (`/issues/42`), condition (d) preserves cross-references that happen to appear near the word "closes" but are not the immediate AST successor, and conditions (a) and (b) together prevent the strip from firing on link text that merely contains a path-shaped string. The five negative examples in the allowlist document each demonstrate a condition boundary that a regex denylist would not respect.

### Structural idempotence over byte-identical

Re-running the procedure against the same `(PREV, TARGET)` pair produces the same bucket headings in the same order, the same Compare link, and the same set of referenced PRs and commit SHAs. Narrative prose wording may vary between runs because LLM synthesis is nondeterministic by nature. Structural idempotence is verifiable by stripping prose paragraphs and diffing the normalized forms (headings, bullet lists, Compare link). This definition is appropriate because the structure — which changes are present, how they are categorized, what the release range is — is deterministic from the commit log, while the prose is editorial. Requiring byte-identical output would either force deterministic LLM output (impractical) or require caching the rendered body (defeating the purpose of re-running).

## Before / After

The v2.20.5 release is the canonical demonstration. The auto-generated body (captured before the patch) contained two terse bullets:

```markdown
### Bug Fixes

* **ci:** add OpenCode group name to Renovate config (#425) (3810786)

### Build System

* **dev:** update all non-major dependencies to v1.15.5 (#424) (a1c7d69)
```

After applying the procedure, the same release reads:

```markdown
## What's new

### Bug Fixes

Renovate now correctly groups `@opencode-ai/*` package updates under a unified "OpenCode"
heading. Previously these dependency PRs were lumped into the generic "non-major
dependencies" group, which made it harder to spot upstream OpenCode releases in the queue.
The fix adds `groupName: 'OpenCode'` to the relevant Renovate package rule (#425).

### Build System

Updated `@opencode-ai/plugin` and `@opencode-ai/sdk` from `1.15.4` to `1.15.5` (#424).

### Compare

[v2.20.4...v2.20.5](https://github.com/marcusrbrown/systematic/compare/v2.20.4...v2.20.5)
```

Every sentence in the after-state traces to the commit log. The PR body for #425 supplied the "harder to spot upstream OpenCode releases" rationale, which the commit subject alone did not carry. The v2.20.6 retroactive patch followed the same shape.

## Prevention

- Run the skill on every release immediately after `semantic-release` publishes. The procedure is currently manual; CI automation is planned for a future release. Until then, the skill invocation is the last step of the release workflow.
- Watch for `closes [...] (...issues/<non-numeric>...)` patterns in commit bodies during PR review. These are the inputs that trigger the misparse. Rewriting the cross-reference as plain text or a non-`closes`-prefixed link before merge prevents the autolink from appearing in the release body at all.
- If the bucket map in `.releaserc.yaml` (lines 46–70) changes, update the bucket map table in `.agents/skills/release-notes-narrative/SKILL.md` in the same PR. The skill's bucket map is a mirror of the preset config; drift between the two causes commits to land in the wrong section or be silently dropped into `Miscellaneous Chores`.

## Related

- [`docs/solutions/developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md`](../developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md) — original lesson that this skill formalizes: the generator never ingests commit bodies or PR descriptions, and the fix is post-publish enrichment rather than generator configuration
- [`docs/solutions/developer-experience/gh-api-heredoc-backtick-escape-2026-05-17.md`](../developer-experience/gh-api-heredoc-backtick-escape-2026-05-17.md) — adjacent safety pattern for `gh` body-writing: backtick escaping in heredoc contexts when passing markdown to `gh release edit`
- [`.agents/skills/release-notes-narrative/SKILL.md`](../../.agents/skills/release-notes-narrative/SKILL.md) — the formalized procedure: full step-by-step with bucket map, thin-body threshold calibration, preflight checks, and rollback instructions
