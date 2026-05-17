# Attributions

Systematic ships bundled skills and agents adapted from third-party sources. This file records the provenance, license, and pin point for each derivative work in the published package.

## License Conventions

Bundled skills and agents may declare a `license:` field in their YAML frontmatter to communicate their licensing origin. When this field is **present**, it reflects the upstream source's license — these files are derivative works adapted from clearly identified projects. When this field is **absent**, the file is unspecified Systematic-originated content, not "proprietary" or "unlicensed." Treat absence as "no upstream attribution required," not as a missing legal notice.

The full repository license is in `LICENSE` at the repository root.

## obra/superpowers — MIT

**Source repository:** [`obra/superpowers`](https://github.com/obra/superpowers)
**Pinned commit:** `f2cbfbefebbfef77321e4c9abc9e949826bea9d7` (tag `v5.1.0`)
**License:** MIT
**Copyright:** Copyright (c) 2025 Jesse Vincent
**Cloned at:** `.slim/clonedeps/repos/obra__superpowers/` (development inspection only; not shipped)

### Files derived

The following bundled skills are adaptations of the upstream `obra/superpowers` source:

- `skills/test-driven-development/SKILL.md`
- `skills/test-driven-development/references/testing-anti-patterns.md`
- `skills/writing-skills/SKILL.md`
- `skills/writing-skills/references/persuasion-principles.md`
- `skills/writing-skills/references/graphviz-conventions.dot`
- `skills/writing-skills/references/testing-skills-with-subagents.md`
- `skills/writing-skills/references/examples/skill-testing-walkthrough.md` (renamed from upstream's `examples/CLAUDE_MD_TESTING.md`)
- `skills/writing-skills/scripts/render-graphs.js`

These files carry `license: MIT` in their frontmatter to make the licensing inheritance explicit at the file level.

### Adaptation notes

- Adaptation was light: rewrote upstream's `@filename` force-load syntax to repo-local `references/` paths; rewrote `superpowers:<skill-name>` namespace cross-references to bare names (matching Systematic's runtime convention where the `systematic:` prefix is applied at load time); swapped `~/.claude/skills` path mentions to the canonical OpenCode path `~/.agents/skills/`; renamed the `CLAUDE_MD_TESTING.md` worked example to `skill-testing-walkthrough.md` to fit Systematic's descriptive-filename convention.
- Per-file copyright comments are deliberately omitted. Frontmatter `license: MIT` plus this attribution file constitute the full attribution surface.
- These files are load-bearing for `ce:work`, `ce:plan`, and `writing-systematic-skills` cross-references. Future contributors editing them should preserve the discipline-enforcing prose (e.g., the Iron Law, the rationalization tables, the RED-GREEN-REFACTOR cycle).

### Future refresh discipline

Future upstream refreshes from `obra/superpowers` are explicit human-reviewed events, not automatic syncs. Bumping the pinned commit requires re-running the adaptation pass and re-validating the two-layer originality check for the Anthropic-distilled reference (see below). The pinned commit above is the stable source-of-truth for the currently-shipped versions.

## Anthropic — CC-BY-4.0

**Source page:** [Skill authoring best practices](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices)
**License:** CC-BY-4.0 (Creative Commons Attribution 4.0 International)
**Publisher:** Anthropic
**Retrieved:** 2026-05-17

### File derived

- `skills/writing-skills/references/anthropic-best-practices-distilled.md`

This file is a distillation of Anthropic's published Skills authoring guidance. CC-BY-4.0 permits derivative works with attribution; this file's first paragraph carries the attribution line and source URL.

### Distillation Outline

The distilled file is organized around 6 Systematic-relevant authoring tasks rather than mirroring upstream's section structure. This ordering and category list is the authoritative outline for any future re-distillation pass:

1. **Triggering Skills Through Precise Descriptions** — when to use this skill / when not / triggering language patterns. Source signal: upstream's "Writing effective descriptions" section.
2. **Organizing Content for Progressive Disclosure** — when to inline content vs split into `references/`, how to keep SKILL.md scannable, naming conventions. Source signal: upstream's "Progressive disclosure patterns" and "Avoid deeply nested references" sections.
3. **Writing Concise Prose** — what to cut, what to keep, how to balance detail vs. agent context budget. Source signal: upstream's "Concise is key" + "Core principles" sections.
4. **Matching Skill Rigidity to Task Variance** — when skills are prescriptive vs flexible, how to match skill rigidity to task variance. Source signal: upstream's "Set appropriate degrees of freedom" section.
5. **Testing Skills Through Evaluation** — how to test that a skill changes agent behavior, evaluation patterns, falsifiable success criteria. Source signal: upstream's evaluation-related content (scattered, not in one named section).
6. **Common Content Patterns and Naming** — naming conventions, file structure conventions, when to use code examples vs prose. Source signal: upstream's "Naming conventions" + "Skill structure" sections.

**Wholesale drops** (not included in the distillation): model-specific testing matrix; advanced executable-code patterns (PDF processing, BigQuery, DOCX); MCP-tool-specific references; package dependency guidance; runtime environment guidance; YAML technical reference notes; Anthropic compliance / checklist sections; marketing-card / cross-link footers.

**Acceptance bar applied at distillation time:**

- Size in 3500–6000 bytes.
- CC-BY-4.0 attribution + `docs.claude.com` link in first 3 lines.
- Zero 1:1 heading matches with upstream.
- Heading sequence does not map 1:1 to upstream order.
- No paragraph contains a >120-character contiguous substring shared with upstream.
- At least 2 Systematic-specific organizing categories introduced (4 confirmed: triggering, freedom, evaluation, patterns).
- At least 3 upstream topic areas dropped wholesale (8 confirmed; see drops above).

If Anthropic's source page is restructured or relocated after this attribution date, the retrieval date above plus the page title triangulate the canonical replacement.
