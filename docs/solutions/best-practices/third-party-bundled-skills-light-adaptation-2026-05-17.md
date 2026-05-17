---
title: Import third-party bundled skills with light adaptation and CC-BY-4.0 originality discipline
date: 2026-05-17
category: best-practices
module: bundled-skills + ATTRIBUTIONS.md
problem_type: best_practice
component: documentation
severity: medium
applies_when:
  - Bundling third-party MIT-licensed skills or content into a published package
  - Producing a derivative reference document from CC-BY-4.0 source material
  - Dispatching a librarian-style subagent to draft licensed-content distillations
  - Designing an attribution surface for multi-source licensed bundling
  - Verifying license compliance before release
tags:
  - third-party-imports
  - cc-by-4-0
  - mit
  - derivative-work
  - attribution
  - licensing
  - librarian-dispatch
---

# Import third-party bundled skills with light adaptation and CC-BY-4.0 originality discipline

## Context

Bundling third-party content into a published package — bundled skills, reference documentation, executable utilities — is a recurring pattern, and it has three failure modes that compound if not handled deliberately:

1. **Adaptation drift.** Upstream content uses different namespacing conventions, force-load syntax, harness-specific paths, and naming conventions than the host project. Rewriting too much (destructive transformation) loses upstream rigor and breaks future refresh diffs. Rewriting too little leaves alien artifacts that confuse users.
2. **Licensing compliance.** MIT-derived content requires reproducing the upstream license text alongside the derivative. CC-BY-4.0-derived content additionally requires explicit attribution, "modified" labeling for transformations, and a derivative-work standard that distinguishes a transformative redistribution from a thinly disguised copy.
3. **Distillation discipline.** Producing a derivative reference from CC-BY-4.0 source material via an LLM is fast and produces plausible-looking output that may be a paraphrase rather than a transformation. Without explicit originality checks, the derivative is structurally a copy with rearranged sentences.

This guidance captures the discipline used when Systematic imported `test-driven-development` and `writing-skills` from `obra/superpowers@v5.1.0` (MIT) and distilled a derivative reference from Anthropic's published Skill authoring docs (CC-BY-4.0) in PR #394 (v2.17.0). The pattern generalizes to any project bundling third-party documentation, executable utilities, or skill-style assets.

## Guidance

### Light-adaptation pattern: empirical counting

Before any rewriting, **count every category of upstream artifact that needs rewriting**. Common categories:

- Force-load syntax (e.g., `@filename.md` markers that auto-load referenced files into context)
- Namespace cross-references (e.g., `upstream-namespace:skill-name`)
- Harness-specific paths (e.g., `~/.claude/skills/` when targeting OpenCode's `~/.agents/skills/`)
- Descriptive filename renames (e.g., `CLAUDE_MD_TESTING.md` → `skill-testing-walkthrough.md`)

Run the count BEFORE adaptation. Re-run AFTER adaptation. Each category should hit zero remaining matches plus zero over-conversion. The empirical step matters because estimates are wrong: in this case the brainstorm estimated 3 `@filename` force-loads but reality was 4 — the regex used `\.md` only and missed `@graphviz-conventions.dot`. Defensive grep pattern: `@[a-z][a-z-]+\.(md|dot|js|sh|py)` not just `@[a-z-]+\.md`.

When upstream content historically references something the host project bans (e.g., a worked example that documents testing `CLAUDE.md` documentation variants), don't strip — **preserve historical fidelity via drift-allowlist entries** with explicit reason fields. The original content is documenting what was tested, not prescribing what to test.

### Two-layer originality check for CC-BY-4.0 derivatives

Layer 1 is **mechanical** (orchestrator runs literal checks):

1. Size in target range (e.g., 3500-6000 bytes for a ~4.5KB target)
2. Attribution + license URL in first 3 lines (literal `CC-BY-4.0` + license URL + canonical source URL)
3. Heading 1:1 match count = 0 (extract `^## ` lines from distilled file AND upstream; intersection must be empty)
4. Heading order divergence (distilled sequence does NOT map 1:1 to upstream sequence)
5. Per-paragraph longest-line `grep -F` against upstream returns zero hits for any line >120 chars

Layer 2 is **reviewer assertions** (orchestrator judges true/false per item):

1. Distilled file introduces ≥2 organizing categories not present in upstream
2. Distilled file drops ≥3 upstream topic areas wholesale (not "summarizes briefly" — wholesale drops)
3. Distilled file presents by the host project's relevant authoring tasks, NOT in upstream document order
4. No section is merely a paragraph-level paraphrase of one upstream section

Layer 1 alone is gameable — an LLM can satisfy "headings differ" by trivial renaming. Layer 2 alone is too subjective — what counts as "merely a paraphrase"? Combined, they catch the failure modes that each misses individually.

### Librarian retry-budget branch routing

LLM-driven distillation needs a bounded retry policy. The trap: open-ended re-drafting loops on the assumption that the next pass will fix the failure mode. They usually don't — failures cluster around structural issues that prose tweaks can't fix.

The pattern: **max 2 librarian re-draft passes**. Draft #3 routes to one of these branches based on the failure mode, not generic re-draft:

| Failure mode | Branch | Action |
|---|---|---|
| Attribution missing or malformed | **fix directly** | Orchestrator edits the first 3 lines; no re-draft. |
| Size out of range, originality OK | **hand-edit** | Orchestrator compresses or expands prose. |
| Literal originality fails on isolated paragraphs | **hand-edit** | Orchestrator rephrases the offending paragraphs once. |
| Literal originality fails across multiple sections | **shrink scope** | Reduce the distillation to a fixed subset. |
| Structural originality fails (mirroring upstream) | **shrink + re-outline** | Restructure around fewer use-case headings; don't line-edit. |
| Legal or license uncertainty | **escalate** | Build an escalation artifact + surface to a human. |

Escalation artifact format (what the human receives):

- Best current draft (full content)
- Exact failed criterion (which mechanical check OR reviewer assertion failed)
- Concise failure evidence (specific line/heading match, byte count, etc.)
- Re-draft attempt count
- Recommended next move with named scope: (a) accept exception, (b) shrink to a named subset (specify which sections to keep), (c) drop derivative entirely, or (d) approve additional manual-rewrite time

The escalation artifact prevents the "what do I do with this?" friction that turns escalation into another draft round.

### ATTRIBUTIONS.md anatomy

A single canonical attribution surface beats per-file comment headers for three reasons: (1) attribution is reviewable in one place; (2) license-absence semantics are explicit (see below); (3) per-file comments are noise on content files that get edited frequently.

Required structure per third-party source:

- **Identification**: source URL or repo URL, pinned commit SHA, license name + URL, copyright line
- **License text**: full upstream license text reproduced verbatim (MIT requires this; CC-BY-4.0 doesn't but inclusion is defensive)
- **File inventory**: list of derived files in your project's tree
- **Adaptation notes**: brief summary of the adaptation deltas applied (what was rewritten, what was renamed, what was preserved)
- **License absence clarification**: explicit statement that absence of `license:` frontmatter on other bundled content means "unspecified host-project-originated," NOT "proprietary" or "unlicensed"
- **Future refresh discipline**: explicit statement that future refreshes from upstream are human-reviewed events, not automatic syncs

For CC-BY-4.0 derivative documentation, add a **Distillation Outline** section: the source-material → host-use-case-category mapping. This makes future re-distillation passes (after the upstream source updates) have a stable scaffold instead of starting from scratch.

`license: MIT` frontmatter on the entry-point file (e.g., `SKILL.md`) is appropriate when the project's runtime loader recognizes the field. Sub-files (reference markdown, scripts, graphviz definitions) typically don't carry frontmatter and inherit license via ATTRIBUTIONS.md.

## Why This Matters

The legal compliance story is the floor: MIT requires reproducing the license text, CC-BY-4.0 requires attribution + modification disclosure. The host project ships content; the host project must satisfy these obligations correctly. Skipping the rigor lets a bundled MIT-derived file ship without the upstream notice — defensible only if "we'll add it later" is more credible than "we didn't notice."

The compounding story is the ceiling: a discipline that treats third-party content as a first-class durable surface scales. The first import requires writing the ATTRIBUTIONS.md scaffolding; the third import drops into the same shape, the same retry-budget routing, the same originality check. The eighth import is mechanical.

The two-layer originality check specifically defends against a real failure mode: LLM-generated distillations are surface-fluent but structurally adjacent to source material. Layer 1's heading-comparison + longest-line `grep -F` catch the obvious copies. Layer 2's reviewer assertions catch the subtle ones (the document that satisfies all mechanical checks but presents content in upstream's exact section order, with paragraphs that paraphrase upstream 1:1). Both are cheap to apply.

The librarian retry-budget routing prevents the most expensive failure mode: open-ended LLM re-draft loops where each pass fixes the previous failure but introduces a new one. Bounded retries with branch routing force the orchestrator to decide between "this is a small fix" and "this is a scope problem" — and structural problems don't survive scope-shrinking, so they surface immediately.

## When to Apply

- Bundling any third-party content (MIT, CC-BY, Apache, BSD) into a published package
- Producing derivative documentation from licensed source material
- Dispatching a librarian subagent or LLM workflow to draft content with quality gates
- Designing the attribution surface for the first third-party import in a project — get the shape right before the second import
- Reviewing an existing third-party import for compliance gaps

The two-layer originality check applies specifically to CC-BY-4.0 derivative work — MIT and Apache derivatives have license-text reproduction requirements but no originality bar. The light-adaptation pattern and ATTRIBUTIONS.md anatomy apply to all third-party imports regardless of license.

## Examples

**Light-adaptation deltas** (actual from PR #394):

| Upstream | Adapted | Count |
|---|---|---|
| `@testing-anti-patterns.md` (force-load) | `references/testing-anti-patterns.md` (repo-local path) | 1 |
| `@graphviz-conventions.dot` (force-load, non-md) | `references/graphviz-conventions.dot` | 1 (missed by initial regex) |
| `superpowers:test-driven-development` (namespace) | `test-driven-development` (bare; namespace added at load time) | 5 |
| `~/.claude/skills` (Claude Code harness path) | `~/.agents/skills/` (canonical OpenCode path) | 13+ |
| `examples/CLAUDE_MD_TESTING.md` (descriptive rename) | `references/examples/skill-testing-walkthrough.md` | 1 |

**Originality check applied** to the distilled `anthropic-best-practices-distilled.md`:

Layer 1 (mechanical):

```bash
# Size check
wc -c skills/writing-skills/references/anthropic-best-practices-distilled.md
# 5991 bytes — within 3500-6000 range ✓

# Attribution check
head -3 skills/writing-skills/references/anthropic-best-practices-distilled.md | grep -c 'CC-BY-4.0'
# 1 ✓
head -3 skills/writing-skills/references/anthropic-best-practices-distilled.md | grep -c 'docs.claude.com'
# 1 ✓

# Heading 1:1 match check
comm -12 \
  <(grep '^## ' skills/writing-skills/references/anthropic-best-practices-distilled.md | sort -u) \
  <(grep '^## ' .slim/clonedeps/repos/obra__superpowers/skills/writing-skills/anthropic-best-practices.md | sort -u) | wc -l
# 0 ✓
```

Layer 2 (reviewer assertions):

| Assertion | Verdict |
|---|---|
| Introduces ≥2 organizing categories not in upstream | ✓ — "Triggering Skills Through Precise Descriptions", "Matching Skill Rigidity to Task Variance" |
| Drops ≥3 upstream topic areas wholesale | ✓ — model-specific testing, executable-code patterns (PDF/BigQuery/DOCX), MCP refs |
| Presents by host project's authoring tasks, NOT upstream order | ✓ — completely different sequence |
| No section merely paraphrases one upstream section | ✓ — confirmed via zero verbatim long-line hits |

**Retry budget application** (actual from PR #394):

Draft #1 came back at 6,490 bytes (490 over the 6,000-byte ceiling), all other checks passing. Per routing: "Size out of range, originality OK → hand-edit." Orchestrator removed a bonus "Anti-Patterns" section beyond the 6-category outline, dropping to 5,944 bytes. **Draft #1 + 1 hand-edit accepted. Retry budget consumed: 0 librarian re-drafts.**

**ATTRIBUTIONS.md structure** (excerpt):

```markdown
## obra/superpowers — MIT

**Source repository:** [obra/superpowers](https://github.com/obra/superpowers)
**Pinned commit:** `f2cbfbefebbfef77321e4c9abc9e949826bea9d7` (tag `v5.1.0`)
**License:** MIT
**Copyright:** Copyright (c) 2025 Jesse Vincent

### Files derived
- skills/test-driven-development/SKILL.md
- skills/test-driven-development/references/testing-anti-patterns.md
- ...

### Upstream MIT license text
[full upstream license text reproduced verbatim]

## Anthropic — CC-BY-4.0
**Source page:** [Skill authoring best practices](https://docs.claude.com/...)
**License:** [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)
**Retrieved:** 2026-05-17

### Distillation Outline
[6 host-use-case categories + wholesale-drop list — durable scaffold for future refreshes]
```

## Related

- [`docs/solutions/best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md`](destructive-to-nondestructive-converter-Systematic-20260209.md) — adjacent "light adaptation, preserve unknowns" precedent from the CEP→Systematic conversion era. This doc extends it with explicit licensing + originality discipline.
- [`docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md`](../workflow-issues/reconciliation-sync-reference-integrity-20260417.md) — verify the reference graph after any sync. Same defensive pattern applied here: don't trust the import; verify every cross-reference resolves on disk.
- [`docs/solutions/workflow-issues/sync-cep-missing-sub-files-SyncCEP-20260219.md`](../workflow-issues/sync-cep-missing-sub-files-SyncCEP-20260219.md) — earlier integrity-check precedent for multi-file imports (some content archived).
- [`docs/solutions/integration-issues/converter-code-block-tool-name-capitalization-20260210.md`](../integration-issues/converter-code-block-tool-name-capitalization-20260210.md) — manual audit backstop after mechanical conversion.
- [`ATTRIBUTIONS.md`](../../../ATTRIBUTIONS.md) — the canonical attribution surface in this repo, structured per this guidance.
- PR [#394](https://github.com/marcusrbrown/systematic/pull/394) — the merge that landed both bundled skills + the distilled CC-BY-4.0 reference + ATTRIBUTIONS.md.
