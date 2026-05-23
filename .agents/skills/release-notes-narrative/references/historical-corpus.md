# Historical Release Corpus

## Overview

This file lists the three historical releases the release-notes-narrative skill is calibrated against. Two terse-bucket anchors (v2.20.5, v2.20.6) demonstrate the failure mode: auto-generated output that groups commits into correct buckets but provides no narrative context beyond the commit subject line. One gold-standard anchor (v2.21.0) demonstrates the target output shape: prose drawn from commit bodies and PR descriptions, a clear "What's new" lead, and a Compare link at the end.

## v2.20.5 — Renovate group fix and dependency bump

**Previous tag:** v2.20.4  
**Commit shape:** Bucketed-but-terse, 2 commits across 2 buckets. Commit bodies carry meaningful prose but the auto-generated release body surfaces only subject lines.

```markdown
## [2.20.5](https://github.com/marcusrbrown/systematic/compare/v2.20.4...v2.20.5) (2026-05-21)

### Bug Fixes

* **ci:** add OpenCode group name to Renovate config ([#425](https://github.com/marcusrbrown/systematic/issues/425)) ([3810786](https://github.com/marcusrbrown/systematic/commit/3810786d80043c510891badf4827c42853d727eb))

### Build System

* **dev:** update all non-major dependencies to v1.15.5 ([#424](https://github.com/marcusrbrown/systematic/issues/424)) ([a1c7d69](https://github.com/marcusrbrown/systematic/commit/a1c7d69a2e705e37dc320fd73a04acf9abb1ba85))
```

## v2.20.6 — Stale cross-reference cleanup and solutions doc

**Previous tag:** v2.20.5  
**Commit shape:** Bucketed-but-terse, 2 commits across 2 buckets. Same failure mode as v2.20.5 — correct structure, no narrative enrichment.

```markdown
## [2.20.6](https://github.com/marcusrbrown/systematic/compare/v2.20.5...v2.20.6) (2026-05-21)

### Bug Fixes

* **skills:** clean stale cross-references in bundled skills ([#426](https://github.com/marcusrbrown/systematic/issues/426)) ([dae829a](https://github.com/marcusrbrown/systematic/commit/dae829a481538bddb56beaf777b2cf70edcb3b0a))

### Documentation

* **solutions:** compound docs refresh arc learnings ([#423](https://github.com/marcusrbrown/systematic/issues/423)) ([79b9409](https://github.com/marcusrbrown/systematic/commit/79b9409ece84d9fe5a463993fcf7b3a3878db4d6))
```

## v2.21.0 — gold-standard reference output

**Previous tag:** v2.20.6  
**Commit shape:** Single squash with manually-patched narrative — the target shape for skill output.

```markdown
## What's new

Launch-surface cleanup — the first ~30 seconds a developer spends with this project. README, home page, Quick Start, config docs, and contributor docs now tell a coherent story instead of repeating each other.

### Top-level docs split

`AGENTS.md` was carrying three audiences in 188 lines. Split into:

- **`ARCHITECTURE.md`** — bird's eye overview, codemap, invariants, data flow, cross-cutting concerns
- **`STRUCTURE.md`** — directory layout, per-directory purposes, naming conventions, where to add new code
- **`AGENTS.md`** — slimmed to 68 lines of contributor conventions plus a routing table that points at the other two

### README rewritten

400 lines of tables + Mermaid diagram + CLI reference → 75 lines of problem-first prose. The detail moved to the docs site where it belongs.

### Home page and Quick Start

- Home page rewritten as a real product landing page — concrete capability cards, the actual workflow as `Steps`, Quick Start snippet, and a "What Systematic Is Not" honesty section.
- New `getting-started/quick-start.mdx` — 5-minute walkthrough from `opencode.json` install to a first completed workflow (brainstorm → plan → work → review). Uses a canonical example task across every surface so the story stays consistent.

### Config docs merged

Two overlapping pages (`getting-started/configuration` + `reference/systematic-config`) → one human-owned `reference/configuration` page with auto-generated regions injected between sentinel markers. Legacy URLs redirect to the new location.

### New project-scoped skill

`.agents/skills/generating-project-docs/SKILL.md` replaces the old `.opencode/commands/generate-readme.md` slash command. Picked up automatically by OpenCode via agentskills.io discovery. Broader scope: README + ARCHITECTURE + STRUCTURE, plus scoped section updates.

### SEO pass

Every page under `docs/src/content/docs/` now has a real frontmatter `description` (120–160 chars, action-oriented).

### Bug catches

- **MDX `{#anchor}` heading syntax crashes the Astro/MDX 3 build** — drop the explicit anchor; Starlight auto-slugs to the same fragment.
- **Astro `redirects` destinations don't get `base`-prefixed** — production-404 class. Source keys resolve against `base`, but destinations write verbatim. Include `base` manually in every destination.

Three solution docs added under `docs/solutions/` capturing the learnings.

### Verification

- `bun test` — 950 pass, 0 fail (+11 new tests)
- `bun run docs:build` — green
- `bun run docs:dev` + live-server navigation — visual rendering and redirect behavior confirmed
- `ce:review` (7 reviewers) — 5 non-blocking findings, all resolved before merge

### Compare

[2.20.6...2.21.0](https://github.com/marcusrbrown/systematic/compare/v2.20.6...v2.21.0)

---

### Also in this release

- **deps:** update github/codeql-action action to v4.36.0 (#427)
```

## Using This Corpus

When the skill runs against a target release, it compares the rendered output's structure against these anchors. The v2.20.5 and v2.20.6 bodies show what the auto-generator produces without enrichment: correct bucket headings, bare subject lines, no context. The v2.21.0 body shows what good looks like: a "What's new" lead that frames the release in one sentence, named sections that group related changes with prose explaining the *why*, a Verification block, and a Compare link. Skill output should match the v2.21.0 shape — narrative drawn from commit bodies and PR descriptions, not mechanical bullets.
