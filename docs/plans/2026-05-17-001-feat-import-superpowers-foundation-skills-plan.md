---
title: 'feat: Import test-driven-development and writing-skills from obra/superpowers'
type: feat
status: active
date: 2026-05-17
deepened: 2026-05-17
origin: docs/brainstorms/2026-05-17-import-superpowers-foundation-skills-requirements.md
---

# Import `test-driven-development` and `writing-skills` from obra/superpowers

## Overview

Bundle two foundational skills from `obra/superpowers@v5.1.0` (MIT-licensed) into Systematic's distribution: `test-driven-development` (TDD discipline) and `writing-skills` (skill-authoring foundation). Wire them into the existing `using-systematic`, `ce:plan`, `ce:work`, and `writing-systematic-skills` discovery paths. Ship a distilled Anthropic best-practices reference for offline use. Add `ATTRIBUTIONS.md` at repo root and `license: MIT` frontmatter on both adapted skills. Single PR, 4 commits, targets v2.17.0 `feat:` minor.

## Problem Frame

Two foundational skills are referenced throughout Systematic but not bundled:

1. **TDD discipline** — `ce:work` and `ce:plan` carry a `test-first` execution-posture signal in plan units' Execution notes. `using-systematic` labels TDD as the canonical `Rigid` skill type. Yet no bundled skill defines the discipline — implementing agents find a label and prose hints but no rigorous RED-GREEN-REFACTOR walkthrough.

2. **Skill-authoring foundation** — `writing-systematic-skills` is framed as "the Systematic delta on top of the general `writing-skills` foundation" and instructs the agent: "Load `~/.agents/skills/writing-skills/SKILL.md` first." That assumes every user has `obra/superpowers` separately installed at the user level. For npm/OCX installs without Superpowers, the foundation is missing and the cross-reference is broken.

(see origin: `docs/brainstorms/2026-05-17-import-superpowers-foundation-skills-requirements.md`)

## Requirements Trace

- **R1.** Bundle `test-driven-development` skill (SKILL.md + `references/testing-anti-patterns.md`) with `license: MIT` frontmatter; registered as `systematic:test-driven-development`; discoverable via `systematic_skill` tool; OCX-registered. → **Unit 1**
- **R2.** Bundle `writing-skills` skill (SKILL.md + 5 reference/script files + 1 distilled reference) with `license: MIT` frontmatter; same registration/discovery/OCX criteria. → **Unit 2**
- **R3.** Distilled Anthropic Skills guidance: `references/anthropic-best-practices-distilled.md` at ~4.5 KB, CC-BY-4.0 attribution, content reorganized by Systematic-relevant use cases (not mirroring upstream section order), no verbatim long blocks. → **Unit 2**
- **R4.** Cross-skill integration in 4 targeted places: `using-systematic`, `ce:plan`, `ce:work`, `writing-systematic-skills` — each gets one targeted edit invoking the new skills. No structural additions to `using-systematic` in this PR (SUBAGENT-STOP + Instruction Priority deferred per smart note #99). → **Unit 4**
- **R5.** Attribution surface: `ATTRIBUTIONS.md` at repo root (Superpowers MIT notice, pinned commit SHA, derivative inventory, librarian distillation outline, Anthropic CC-BY-4.0 attribution, "absence of `license:` ≠ proprietary" clarification) + `license: MIT` frontmatter on both adapted skills + `package.json` `files` array update. No per-file attribution comments. → **Unit 3** (frontmatter is set in Units 1+2)
- **R6.** Full pre-PR gate passes: typecheck, lint, schema:drift, registry:drift, build, Node ESM smoke, unit tests, integration tests, docs:build, content-integrity, plan-taxonomy audit. → **Quality Gate** (runs once before PR open, after all 4 units land; verified by orchestrator per `ce:work` shipping workflow, not assigned to any single unit).

## Scope Boundaries

- No bulk cross-reference sweep across other Systematic skills (e.g., `dhh-rails-style`, `compound-docs`, `agent-native-architecture`) — only the 4 targeted edits in R4.
- No regression-protection test infrastructure for imported content (checksums, content-shape assertions) — deferred to smart note #100.
- No new tests added in this PR — existing skill-loading and registry-build tests cover R1, R2.
- Distillation drafted by `@librarian`; orchestrator does NOT hand-author 4.5 KB of original prose.
- Heavy paraphrasing of upstream prose is NOT contemplated — light adaptation only (path rewrites, namespace updates, `~/.claude/skills/` → `~/.agents/skills/` swap).

### Deferred to Separate Tasks

- **Adopting `<SUBAGENT-STOP>` and `## Instruction Priority` blocks** from upstream `using-superpowers` into `using-systematic`: separate PR. Three reviewers flagged this as a global-bootstrap-semantics change requiring dedicated review + regression test. Tracked as smart note #99.
- **Harness-portability work** (tool-name overlays for Claude Code / Copilot / Codex / Gemini): separate future feature. Tracked as smart note #98.
- **Regression protection for imported content**: separate future task. Tracked as smart note #100.

## Context & Research

### Relevant Code and Patterns

- **Skill loader contract** — `src/lib/skills.ts:48-62` defines `SKILL_FRONTMATTER_FIELDS`, including the runtime-recognized `license` field. Both adapted skills will set `license: MIT`.
- **Content-integrity sub-file gate** — `scripts/content-integrity.ts:559-579` (`checkSubfileReferences`) scans `skills/*/SKILL.md` entry files and validates `references/`, `scripts/`, `assets/`, `templates/` paths cited in those files. Nested cross-references inside reference files are NOT scanned — these must be manually verified.
- **Registry auto-discovery** — `scripts/generate-registry.ts` discovers skills via `findSkillsInDir` and derives component names from filesystem paths. New skills auto-register; no manual `registry/registry.jsonc` edit required.
- **Skill body wrapping** — `src/lib/bootstrap.ts:126-167` (`getBootstrapContent`) injects the whole `using-systematic` SKILL.md body into the system prompt for every session.
- **License frontmatter precedent** — `skills/writing-systematic-skills/SKILL.md:42-56` documents `license` as a runtime-recognized optional field.
- **Bundled-vs-user-installed precedence** — `src/lib/config-handler.ts:67-70` skips emitted bundled entries when a same-name key already exists in user config; user-installed agent skills under `~/.agents/skills/` live in a separate load path. Brainstorm risks table covers the practical implications.

### Institutional Learnings

- **CEP-era import experience** — Systematic previously imported skills from CEP and refined the convention rules in `writing-systematic-skills`. Apply same discipline: bare-name `frontmatter.name`, sub-files under `references/` and `scripts/`, no claude-specific tool names in adapted bodies. (memory `#1635` precedence rule applies to skill/agent definitions.)
- **TDD discipline rule** — memory `#2767` says implementing agents use TDD; this is the canonical Systematic stance. The new bundled `test-driven-development` skill formalizes the rule's mechanics.
- **Content imports skip TDD** — per `ce:work` SKILL.md prose ("skip test-first discipline for trivial renames, pure configuration, and pure styling work"), bundling markdown content does not require failing tests first.

### External References

- **`obra/superpowers@v5.1.0`** at `f2cbfbefebbfef77321e4c9abc9e949826bea9d7` — MIT-licensed source. Cloned at `.slim/clonedeps/repos/obra__superpowers/` (memory `#3097`).
- **Anthropic's "Skill authoring best practices"** at `https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices` — CC-BY-4.0 (memory `#3098`). Derivative works permitted with attribution.
- **Librarian distillation research** — section inventory (11 sections from 45.8 KB source), drift assessment (verbatim with live doc), distillation outline (6 sections to keep, 7 to drop, ~4.5 KB target). Produced earlier this session.

## Key Technical Decisions

- **Light adaptation, not heavy paraphrasing**: preserve Jesse's voice and Anthropic's structural shape. The value of these skills is their pressure-tested rigor; rewriting destroys it. (see origin L1)
- **License frontmatter + ATTRIBUTIONS.md, no per-file comments**: per Marcus's directive 2026-05-17, the attribution surface is minimal — `license: MIT` frontmatter on both adapted SKILL.md files + a single repo-root attribution file. HTML comments would be redundant and risk sanitization stripping. (see origin L5)
- **Distilled Anthropic doc, not vendored verbatim**: ship a ~4.5 KB distillation drafted by `@librarian` rather than redistributing the 45.8 KB upstream copy of Anthropic's docs. Smaller package, defensible under CC-BY-4.0, no maintenance liability for verbatim drift. (see origin L3)
- **Cross-skill integration is minimal**: 4 targeted prose edits, no structural additions. Adopting `<SUBAGENT-STOP>` + `## Instruction Priority` from upstream is deferred — three reviewers flagged it as a global-bootstrap-semantics change that needs its own PR. (see origin L4)
- **4 atomic commits, not 6**: distillation ships with the writing-skills import (it's a sub-file of that skill); ATTRIBUTIONS.md gets its own commit for review isolation. (see origin L6)
- **Renamed example file**: upstream `examples/CLAUDE_MD_TESTING.md` → bundled `references/examples/skill-testing-walkthrough.md`. Filename is harness-neutral; cited from SKILL.md so the sub-file gate validates it.

## Open Questions

### Resolved During Planning

- **Adaptation level** → Light (origin L1).
- **Sub-file scope for `writing-skills`** → 4 of 5 upstream files + distilled Anthropic ref (origin L2).
- **Anthropic doc handling** → Distill to ~4.5 KB with CC-BY-4.0 attribution (origin L3).
- **Cross-skill integration scope** → 4 targeted edits; SUBAGENT-STOP deferred (origin L4).
- **Attribution mechanism** → frontmatter + ATTRIBUTIONS.md only (origin L5, Marcus directive).
- **PR structure** → 4 atomic commits (origin L6).
- **Regression protection** → Deferred to follow-up (origin Acceptance Example 3, smart note #100).

### Deferred to Implementation

- **Exact prose wording for the 4 cross-skill edits (R4)**: the 1-sentence addition to `using-systematic`'s Rigid paragraph, the test-first guidance update in `ce:plan`, the test-first dispatch update in `ce:work`, and the foundation-pointer rewrite in `writing-systematic-skills`. The intent is locked; the exact wording is best decided when editing alongside the imported skills. Implementer should keep edits ≤2 sentences per file and preserve surrounding structure.
- **Final distilled-file prose** (R3): drafted by `@librarian` during implementation; orchestrator reviews against acceptance bar (size 3.5-6 KB, no verbatim long blocks via `grep -F`, attribution line at top, section outline matches librarian's plan).
- **Nested cross-reference rewrite in `references/testing-skills-with-subagents.md`**: change `examples/CLAUDE_MD_TESTING.md` → `references/examples/skill-testing-walkthrough.md`. Implementer verifies manually during commit-2 review (the sub-file gate doesn't scan nested references).

## Implementation Units

- [ ] **Unit 1: Import `test-driven-development` skill**

**Goal:** Land the bundled `test-driven-development` skill with light adaptation and `license: MIT` frontmatter.

**Requirements:** R1

**Dependencies:** None.

**Files:**
- Create: `skills/test-driven-development/SKILL.md`
- Create: `skills/test-driven-development/references/testing-anti-patterns.md`

**Approach:**
- Copy `SKILL.md` and `testing-anti-patterns.md` from `.slim/clonedeps/repos/obra__superpowers/skills/test-driven-development/`.
- Add `license: MIT` to the SKILL.md frontmatter (between existing `name:` and `description:` lines, or after `description:` — `SKILL_FRONTMATTER_FIELDS` accepts either).
- Rewrite the single `@testing-anti-patterns.md` force-load reference at SKILL.md line 359 to `references/testing-anti-patterns.md`.
- Leave Jesse's prose, tables, examples, and the graphviz cycle verbatim. No tone changes.
- `testing-anti-patterns.md` requires no adaptation — no cross-references, no claude-specific paths.

**Patterns to follow:**
- `skills/writing-systematic-skills/SKILL.md` — established Systematic frontmatter conventions for description style and sub-file reference paths.
- Existing bundled skills with `references/` sub-directories — e.g., `skills/ce-plan/references/`, `skills/ce-work/references/`.

**Test scenarios:**
- Test expectation: none — content import, no behavioral change. Existing skill-loader, registry-build, and content-integrity tests provide coverage automatically (skill discovery via `findSkillsInDir`; sub-file gate via `checkSubfileReferences`).

**Verification:**
- `bun src/cli.ts list skills | grep test-driven-development` returns 1 hit.
- `bun scripts/content-integrity.ts` exits 0 with the new `references/testing-anti-patterns.md` resolved.
- `bun scripts/generate-registry.ts --check` exits 0 (registry auto-includes new component).
- Smoke check (manual, post-build): orchestrator launches OpenCode with the rebuilt plugin, dispatches the `systematic_skill` tool with `{ name: "test-driven-development" }`, and confirms the full SKILL.md content is wrapped in the standard XML envelope. If the integration suite covers this path, prefer the test; otherwise document the manual verification.

- [ ] **Unit 2: Import `writing-skills` skill (including distilled Anthropic ref)**

**Goal:** Land the bundled `writing-skills` skill with 5 upstream sub-files + 1 distilled Anthropic reference, all with light adaptation and `license: MIT` frontmatter.

**Requirements:** R2, R3

**Dependencies:** Unit 1 (the cross-reference to `test-driven-development` only resolves if that skill exists; otherwise Unit 2's mentions of `test-driven-development` are valid-but-not-yet-bundled).

**Files:**
- Create: `skills/writing-skills/SKILL.md`
- Create: `skills/writing-skills/references/testing-skills-with-subagents.md`
- Create: `skills/writing-skills/references/persuasion-principles.md`
- Create: `skills/writing-skills/references/graphviz-conventions.dot`
- Create: `skills/writing-skills/references/examples/skill-testing-walkthrough.md` (renamed from upstream `examples/CLAUDE_MD_TESTING.md`)
- Create: `skills/writing-skills/references/anthropic-best-practices-distilled.md` (drafted by `@librarian`)
- Create: `skills/writing-skills/scripts/render-graphs.js`

**Approach:**
- Copy SKILL.md + 5 upstream sub-files from `.slim/clonedeps/repos/obra__superpowers/skills/writing-skills/`. Skip `anthropic-best-practices.md` (replaced by distilled version).
- Adaptation pass on `skills/writing-skills/SKILL.md`:
  - Add `license: MIT` to frontmatter.
  - Rewrite `@graphviz-conventions.dot` (line 316) → `references/graphviz-conventions.dot`.
  - Rewrite `@testing-skills-with-subagents.md` (line 556) → `references/testing-skills-with-subagents.md`.
  - Rewrite `@anthropic-best-practices.md` reference → `references/anthropic-best-practices-distilled.md`. Add an inline link to the live Anthropic doc for users who want the full source.
  - Rewrite 3 `superpowers:test-driven-development` cross-references (lines 18, 283, 393) → `test-driven-development`.
  - Swap `~/.claude/skills` mention (line 12) → `~/.agents/skills/`.
- Adaptation pass on `references/testing-skills-with-subagents.md`:
  - Rewrite the 1 `superpowers:test-driven-development` cross-reference (line 13) → `test-driven-development`.
  - Rewrite `examples/CLAUDE_MD_TESTING.md` reference → `references/examples/skill-testing-walkthrough.md` (matches renamed file).
- Adaptation pass on `references/examples/skill-testing-walkthrough.md`: copy upstream `examples/CLAUDE_MD_TESTING.md` content; rename does not require body changes unless internal references to "CLAUDE.md" need harness-neutral framing — read the file in commit-2 work to confirm.
- `references/persuasion-principles.md`, `references/graphviz-conventions.dot`, `scripts/render-graphs.js`: copy verbatim. No adaptation needed.
- **Honest precedent note**: Systematic has NO prior bundled distilled third-party doc (repo research confirmed no existing `skills/*/references/*` file that's an explicit CC-BY/MIT derivative of an external page). Unit 2 invents a new sub-pattern. The acceptance bar below is intentionally conservative.

- **Librarian dispatch with embedded originality discipline**: dispatch `@librarian` to draft `references/anthropic-best-practices-distilled.md`. The prompt MUST instruct the librarian to:
  - Start from the locked Systematic-use-case outline (persisted in `ATTRIBUTIONS.md` per Unit 3 — see "Outline durability" below).
  - Treat upstream `anthropic-best-practices.md` as **source material**, NOT as a section scaffold. Do not preserve upstream headings unless they are generic terms (e.g., "Examples" is fine; "Test with all models" is not).
  - Self-check before returning: list which upstream sections were dropped, which Systematic categories were introduced, and why the section order differs.
  - Embed the attribution line and live source link in the first 3 lines.
  - Stay within 3500-6000 bytes target.
  - Output its own section-heading list so the orchestrator can verify originality mechanically.

- **Outline durability**: Unit 3's `ATTRIBUTIONS.md` persists the distillation outline as `## Distillation Outline`. If Unit 2 runs before Unit 3 commits, the librarian inlines the outline at the top of the distilled file's prose, and the orchestrator confirms it matches what eventually lands in `ATTRIBUTIONS.md` during Unit 3 review.

- **Distillation acceptance (two-layer)**:

  **Layer 1: mechanical checks** (orchestrator runs these literally):
  - Size: `wc -c skills/writing-skills/references/anthropic-best-practices-distilled.md` returns 3500-6000 bytes.
  - Attribution: `head -3 skills/writing-skills/references/anthropic-best-practices-distilled.md` contains literal `CC-BY-4.0` and a `docs.claude.com` URL.
  - Heading comparison: extract `^## ` lines from distilled file AND from `.slim/clonedeps/repos/obra__superpowers/skills/writing-skills/anthropic-best-practices.md`. Confirm distilled headings do NOT match upstream headings 1:1 (zero exact matches; near-matches like "Skill structure essentials" vs upstream "Skill structure" require Layer 2 review).
  - Heading order divergence: distilled heading sequence does NOT map 1:1 to upstream sequence in the same order.
  - Literal substring: for each paragraph in distilled file, the longest single line (>120 chars) is `grep -F` against upstream — zero hits. Edge case: paragraphs shorter than 120 chars are exempt from this specific check.

  **Layer 2: reviewer assertion checklist** (orchestrator confirms each, true/false):
  - "Distilled file introduces at least 2 Systematic-specific organizing categories not present in upstream" (e.g., 'writing skill descriptions', 'structuring sub-files', 'evaluation patterns').
  - "Distilled file drops at least 3 upstream topic areas wholesale rather than summarizing them" (matches the L3 'drops' list: model-specific testing, advanced executable-code, MCP refs, package deps, runtime env, YAML technical notes, Anthropic checklist, marketing cards — pick 3+).
  - "Distilled file presents guidance by Systematic authoring tasks, NOT in upstream document order."
  - "No section in the distilled file is merely a paragraph-level paraphrase of one upstream section."

- **Retry budget with branch routing** (max 2 librarian re-draft passes; draft #3 must trigger one of the routes below):

  | Failure mode | Branch | Action |
  |---|---|---|
  | Attribution missing or malformed | **fix directly** | Orchestrator edits the first 3 lines; no re-draft needed. |
  | Size out of range (3500-6000 bytes), originality OK | **hand-edit** | Orchestrator compresses or expands prose. |
  | Literal originality fails on isolated paragraphs | **hand-edit** | Orchestrator rephrases the offending paragraphs once. |
  | Literal originality fails across multiple sections | **shrink scope** | Orchestrator shrinks the distilled file to a fixed subset (e.g., keep descriptions + sub-files + evaluation; drop the rest). |
  | Structural originality fails (mirroring upstream) | **shrink + re-outline** | Orchestrator restructures around fewer Systematic-use-case headings; do NOT line-edit (mirroring is an outline problem, not a prose problem). |
  | Legal/license uncertainty OR multiple failure modes interacting | **escalate** | Build the escalation artifact (see below) and surface to Marcus. |

- **Escalation artifact format** (when escalation branch fires): submit a single comment/section containing:
  - Best current draft (full file content).
  - Exact failed criterion (which mechanical check OR reviewer assertion failed).
  - Concise failure evidence (specific line/heading match, byte count, etc.).
  - Attempted re-draft count.
  - Recommended next move: (a) accept exception, (b) shrink to a named subset (specify which sections to keep), (c) drop distilled reference entirely from this PR, or (d) approve additional manual-rewrite time.

**Patterns to follow:**
- Same as Unit 1.
- Existing skills with multiple sub-files: `skills/ce-plan/references/`, `skills/document-review/references/`.
- For the distillation acceptance pass, the librarian's research notes from earlier this session are the authoritative outline.

**Test scenarios:**
- Test expectation: none — content import + librarian-authored derivative reference. Sub-file gate validates `SKILL.md`-cited paths. Nested cross-reference (inside `testing-skills-with-subagents.md`) is manually verified during commit review.

**Verification:**
- `bun src/cli.ts list skills | grep writing-skills` returns 1 hit.
- `bun scripts/content-integrity.ts` exits 0 — all 5 reference files + 1 script + 1 distilled file referenced from SKILL.md resolve on disk.
- `bun scripts/generate-registry.ts --check` exits 0.
- Smoke check: orchestrator dispatches `systematic_skill { name: "writing-skills" }` from a rebuilt-plugin OpenCode session and confirms the adapted SKILL.md returns with rewritten paths.
- No upstream namespace remains in adapted files: `grep -rn -E 'superpowers:|@[a-z][a-z-]+\.(md|dot|js)' skills/writing-skills/` returns empty.
- No claude-skills path remains: `grep -rn '~/.claude/skills' skills/writing-skills/` returns empty.
- No old example path remains (catches both the renamed file body and the nested cross-reference): `grep -rn 'examples/CLAUDE_MD_TESTING.md' skills/writing-skills/` returns empty.
- Renamed example reference resolves correctly across all referencing files: `grep -rn 'skill-testing-walkthrough.md' skills/writing-skills/` shows only the canonical `references/examples/skill-testing-walkthrough.md` path — no stray `examples/skill-testing-walkthrough.md` (missing `references/` prefix) or `reference/examples/...` (wrong subdirectory).
- Distillation acceptance per Approach section: size in 3500-6000 bytes; CC-BY-4.0 attribution + `docs.claude.com` link in first 3 lines; structural divergence from upstream section ordering; no >120-char verbatim long blocks.

- [ ] **Unit 3: Add `ATTRIBUTIONS.md` and update `package.json` files array**

**Goal:** Land the repo-root attribution file and ensure it ships in the npm tarball.

**Requirements:** R5

**Dependencies:** Units 1 + 2 (the file inventory in ATTRIBUTIONS.md references the bundled files).

**Files:**
- Create: `ATTRIBUTIONS.md`
- Modify: `package.json`

**Approach:**
- Write `ATTRIBUTIONS.md` with these sections:
  - **Header**: brief one-paragraph explanation that some bundled content derives from third-party MIT and CC-BY-4.0 sources.
  - **`obra/superpowers` MIT notice**: full copyright line (`Copyright (c) 2025 Jesse Vincent`), permission grant text, link to https://github.com/obra/superpowers, pinned commit SHA `f2cbfbefebbfef77321e4c9abc9e949826bea9d7` (tag `v5.1.0`).
  - **Derivative files inventory**:
    - `skills/test-driven-development/SKILL.md` ← upstream `skills/test-driven-development/SKILL.md`
    - `skills/test-driven-development/references/testing-anti-patterns.md` ← upstream `skills/test-driven-development/testing-anti-patterns.md`
    - `skills/writing-skills/SKILL.md` ← upstream `skills/writing-skills/SKILL.md`
    - `skills/writing-skills/references/testing-skills-with-subagents.md` ← upstream `skills/writing-skills/testing-skills-with-subagents.md`
    - `skills/writing-skills/references/persuasion-principles.md` ← upstream `skills/writing-skills/persuasion-principles.md`
    - `skills/writing-skills/references/graphviz-conventions.dot` ← upstream `skills/writing-skills/graphviz-conventions.dot`
    - `skills/writing-skills/references/examples/skill-testing-walkthrough.md` ← upstream `skills/writing-skills/examples/CLAUDE_MD_TESTING.md` (renamed)
    - `skills/writing-skills/scripts/render-graphs.js` ← upstream `skills/writing-skills/render-graphs.js`
  - **Anthropic CC-BY-4.0 attribution**: `skills/writing-skills/references/anthropic-best-practices-distilled.md` distilled from `https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices` (CC-BY-4.0). Include retrieval date.
  - **Distillation Outline** (section heading: `## Distillation Outline`): persist the librarian's distillation outline from this session's research so it is durable across sessions. Outline includes: 6 sections kept (core principles, structure essentials, workflows/validation, content guidelines, common patterns, evaluation-driven development) reorganized by Systematic-relevant use cases; 7 sections dropped (model-specific testing, advanced executable-code, MCP refs, package deps, runtime env, YAML technical notes, Anthropic checklist, marketing cards); target ~4.5 KB. This persistence addresses the volatility of the in-session research and gives future implementers (including re-draft passes) a stable reference.
  - **`license:` frontmatter note**: explicit clarification that "absence of `license:` frontmatter on other bundled skills means 'unspecified Systematic-originated,' NOT 'proprietary' or 'unlicensed.'"
- Modify `package.json`: add `ATTRIBUTIONS.md` to the `files` array (which currently lists `dist`, `skills`, `agents` per memory + brainstorm research).

**Patterns to follow:**
- Standard MIT NOTICE conventions — preserve full copyright line and permission grant text verbatim.
- Existing `package.json` `files` array — add the new entry preserving JSON formatting (Biome will normalize).

**Test scenarios:**
- Test expectation: none — pure documentation + manifest update.

**Verification:**
- `grep -c 'Jesse Vincent' ATTRIBUTIONS.md` ≥ 1.
- `grep -c 'f2cbfbe' ATTRIBUTIONS.md` ≥ 1 (commit SHA pinned).
- `grep -c 'CC-BY-4.0' ATTRIBUTIONS.md` ≥ 1 (Anthropic attribution).
- `grep -c 'unspecified Systematic-originated' ATTRIBUTIONS.md` ≥ 1 (license-absence clarification).
- `grep -c 'Distillation Outline' ATTRIBUTIONS.md` ≥ 1 (librarian outline durably persisted).
- `bun -e "const pkg = require('./package.json'); console.log(pkg.files.includes('ATTRIBUTIONS.md'))"` prints `true`.
- `bun pm pack --dry-run 2>&1 | grep ATTRIBUTIONS.md` returns ≥ 1 hit confirming the file is in the tarball file list. If Bun's pack output differs from npm's, fall back to `npm pack --dry-run --json 2>/dev/null | jq -r '.[0].files[].path' | grep ATTRIBUTIONS.md` (requires `jq` and Node — acceptable as a one-off pre-PR check).

- [ ] **Unit 4: Wire imported skills into existing discovery paths**

**Goal:** Update 4 existing Systematic skills with targeted prose edits invoking the newly bundled skills.

**Requirements:** R4

**Dependencies:** Units 1 + 2 (the referenced skills must exist before being cross-referenced).

**Files:**
- Modify: `skills/using-systematic/SKILL.md`
- Modify: `skills/ce-plan/SKILL.md`
- Modify: `skills/ce-work/SKILL.md`
- Modify: `skills/writing-systematic-skills/SKILL.md`

**Approach:** four targeted prose edits, one per file. Each edit has a single anchor line; do NOT scatter additions across multiple locations.

- **`skills/using-systematic/SKILL.md` — single edit at line 85**: the `Rigid (TDD, debugging): Follow exactly. Don't adapt away discipline.` paragraph. Add one sentence (≤2 lines) immediately after that paragraph naming `test-driven-development` as the canonical bundled Rigid skill. **No structural additions** — no `<SUBAGENT-STOP>` block, no `## Instruction Priority` section (deferred per L4).

- **`skills/ce-plan/SKILL.md` — single edit at line 395**: the unit-template Execution note line (`- Execution note: Implement new domain behavior test-first.`). Update to invoke `test-driven-development` by name, e.g., `- Execution note: Implement new domain behavior test-first; invoke \`test-driven-development\`.`. **Before editing**, confirm the target line is normative prose, not a parse-sensitive structured example consumed by downstream automation. If it IS parse-sensitive (e.g., the unit template that `ce:work` parses), move the edit to a free-prose location like line 198-199 (test-first definition list) instead. **Do NOT edit lines 380, 397, 548, 636, 652, 671** — those are alternative test-first prose occurrences and the brainstorm locked 1 edit per file.

- **`skills/ce-work/SKILL.md` — single edit at line 203**: the test-first dispatch prose. Update to explicitly name `test-driven-development` as the skill to invoke when a unit's Execution note signals test-first, e.g., one sentence appended to the existing dispatch. **Before editing**, confirm line 203 is normative prose, not a structured example. If it IS parse-sensitive, choose line 52 instead. **Do NOT edit lines 56, 120, 206, 208, 209** — those are alternative test-first prose occurrences.

- **`skills/writing-systematic-skills/SKILL.md` — single edit at line 20**: replace `Do not use this as a replacement for \`~/.agents/skills/writing-skills/SKILL.md\`. Load that foundation first when authoring or substantially editing skill content.` with `Load \`writing-skills\` first (bundled). This skill covers the Systematic delta.`. Remove the install-Superpowers-separately assumption entirely.

**Parse-sensitivity pre-check** (applies to ce:plan and ce:work edits only): before committing Unit 4, confirm that the diff for ce:plan / ce:work touches normative prose and does NOT alter the wording, indentation, or fenced-block content of any structured Execution-note example that downstream automation (test-first dispatch, ce:work unit classification) pattern-matches. The plan's verification step `grep -c 'Execution note: Implement new domain behavior test-first' skills/ce-plan/SKILL.md` should return at least one hit BOTH before and after the edit (proves the canonical structured example is preserved).

**Patterns to follow:**
- Existing `using-systematic` cross-skill mentions (the Rigid/Flexible distinction paragraph).
- `ce:plan` and `ce:work` already use prose like "invoke `<skill-name>`" for skill dispatch — follow that style.
- `writing-systematic-skills` already uses inline backticked skill names — preserve that convention.

**Test scenarios:**
- Test expectation: none — prose edits only. No behavioral change.

**Verification:**
- `grep -n 'test-driven-development' skills/using-systematic/SKILL.md` returns ≥1 hit.
- `grep -n 'test-driven-development' skills/ce-plan/SKILL.md` returns ≥1 hit.
- `grep -n 'test-driven-development' skills/ce-work/SKILL.md` returns ≥1 hit.
- `grep -n '~/.agents/skills/writing-skills' skills/writing-systematic-skills/SKILL.md` returns 0 hits (the broken cross-product reference is gone).
- `grep -n 'writing-skills' skills/writing-systematic-skills/SKILL.md` returns ≥1 hit (the bundled reference replaces it).
- `grep -n 'SUBAGENT-STOP\|Instruction Priority' skills/using-systematic/SKILL.md` returns 0 hits (deferred).
- **Parse-sensitivity verification**: `grep -c 'Execution note: Implement new domain behavior test-first' skills/ce-plan/SKILL.md` returns the SAME count before and after the edit (proves the canonical Execution-note example used by downstream `ce:work` parsing was preserved). Run before the edit, save the count, re-run after.
- `bun scripts/content-integrity.ts` exits 0 (no broken cross-references introduced).
- `bun run docs:build` succeeds (the edited skills' content renders cleanly via docs:generate).

## System-Wide Impact

- **Interaction graph:** new skills register through the standard `findSkillsInDir` discovery path; no new code paths or hooks. Cross-skill prose edits invoke `test-driven-development` and `writing-skills` by name through the existing `systematic_skill` tool.
- **Error propagation:** none — content-only changes; if a bundled skill is disabled via `disabled_skills`, the cross-references in `using-systematic` / `ce:plan` / `ce:work` / `writing-systematic-skills` degrade gracefully to existing prose hints.
- **State lifecycle risks:** none — no persistent state, no caches.
- **API surface parity:** none — no exported API changes. `package.json` `files` array change is an internal packaging detail (adds `ATTRIBUTIONS.md` to the tarball).
- **Integration coverage:** existing skill-loading and registry-build integration tests cover the new skills automatically. Sub-file integrity gate (`scripts/content-integrity.ts`) validates the 6 new path references cited from SKILL.md files.
- **Unchanged invariants:**
  - `using-systematic` bootstrap injection semantics: no `<SUBAGENT-STOP>` block, no `## Instruction Priority` section — primary-agent bootstrap behavior is identical.
  - Bundled-agent frontmatter contract (no `model:` field): preserved on all bundled agents; the new `license:` field is on bundled skills, not agents.
  - `SECURITY_OVERLAY_FIELDS` trust boundary: untouched.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Distilled file size drifts outside the 3.5-6 KB acceptance bar. | Orchestrator measures with `wc -c`. Retry budget: max 2 librarian re-draft passes; size-only failure routes to `hand-edit` branch. |
| Distilled file has verbatim long blocks (>120 char match) from source. | Per-paragraph `grep -F` of longest line against upstream. Isolated paragraph failures route to `hand-edit`; multi-section failures route to `shrink scope` (see Unit 2 retry-budget branch routing). |
| Distilled file mirrors upstream section structure too closely (CC-BY-4.0 structural-copying challenge). | Two-layer originality check per Unit 2 Approach: (1) mechanical heading comparison + heading-order divergence verifies no 1:1 mirroring; (2) reviewer assertion checklist confirms 2+ Systematic-specific categories introduced, 3+ upstream topics dropped wholesale, presentation order tracks Systematic authoring tasks. Structural failure routes to `shrink + re-outline`, not line-editing. |
| Librarian produces a polished paraphrase that orchestrator must reject (late-validation cost). | Librarian prompt embeds originality discipline upstream: librarian must start from outline (not upstream scaffold), self-check which upstream sections were dropped and which Systematic categories were introduced, output its own heading list. Orchestrator becomes verifier, not cleanup crew. |
| Escalation to Marcus arrives without enough context for a decision. | Unit 2 Approach defines the escalation artifact format: best current draft, exact failed criterion, failure evidence, retry count, recommended next move with named scope (accept exception / shrink to named subset / drop distilled file / approve more rewrite time). |
| Nested cross-reference in `references/testing-skills-with-subagents.md` to renamed `skill-testing-walkthrough.md` is not updated. | Verification step `grep -rn 'examples/CLAUDE_MD_TESTING.md' skills/writing-skills/` returns empty (catches stale references in any file, not just SKILL.md). The sub-file gate does NOT scan nested references — explicit grep covers the gap. |
| Renamed example file body still references its old upstream path. | Same `grep -rn 'examples/CLAUDE_MD_TESTING.md' skills/writing-skills/` verification step catches in-body literals, not just cross-references. |
| Malformed renamed-reference path (wrong subdirectory, missing `references/` prefix) passes content-integrity. | Verification step `grep -rn 'skill-testing-walkthrough.md' skills/writing-skills/` shows ONLY the canonical `references/examples/skill-testing-walkthrough.md` path. |
| `license: MIT` on these two skills creates downstream confusion (other skills lack the field). | `ATTRIBUTIONS.md` includes explicit "absence ≠ proprietary" clarification. Schema-side: `license` is a runtime-recognized optional field per `SKILL_FRONTMATTER_FIELDS`. |
| Upstream `obra/superpowers` retracts content or relicenses between v5.1.0 and our next refresh. | Pinned commit SHA in `ATTRIBUTIONS.md`. Our bundled copy stands on the v5.1.0 MIT grant regardless of upstream's later actions. Any future refresh is an explicit human-reviewed event. |
| Anthropic restructures their Skills docs after we publish. | Distilled file targets durable core principles, not platform mechanics. Retrieval date in `ATTRIBUTIONS.md` lets future maintainers know when the source was last checked. |
| Live Anthropic URL is a brittle dependency. | `ATTRIBUTIONS.md` carries source URL + page title + retrieval date; if the URL changes, the page title + date triangulate the canonical replacement. |
| Bundled-vs-user-installed precedence is loader-path-dependent. | A user with both `obra/superpowers` user-installed AND Systematic via npm sees duplicate skill definitions. `ATTRIBUTIONS.md` notes the bundled copies derive from `obra/superpowers@v5.1.0`; users can disable bundled copies via `disabled_skills: ["test-driven-development", "writing-skills"]` if they prefer the upstream user-level version. |
| Bundle weight grows by ~50 KB after distillation. | Negligible for an npm package. Full undistilled file would push it to ~95 KB; distillation keeps growth modest. |
| Unit 4 prose edit lands on a parse-sensitive `ce:plan` / `ce:work` Execution-note example, breaking downstream automation. | Unit 4 Approach mandates a parse-sensitivity pre-check before editing; if the target line IS parse-sensitive, the edit moves to a free-prose alternative. Verification step `grep -c 'Execution note: Implement new domain behavior test-first' skills/ce-plan/SKILL.md` returns ≥1 BOTH before and after the edit (proves canonical structured example preserved). |
| Contributor edits regress the discipline-enforcing prose. | Mechanical protection deferred (smart note #100). For this PR: `ATTRIBUTIONS.md` notes the imported files are load-bearing; `ce:review` catches softening edits at PR time. |
| `ce:plan` and `ce:work` cross-references create implicit dependency on the new TDD skill. | Both edits are prose-only; if the TDD skill is disabled via `disabled_skills`, the prose degrades gracefully. No runtime hard-dependency. |
| `ATTRIBUTIONS.md` listed in `package.json` `files` but absent from packed tarball (`.npmignore` or build-step interaction). | Verification step `bun pm pack --dry-run \| grep ATTRIBUTIONS.md` returns ≥1 hit, confirming the actual published tarball contents — not just the manifest. |

## Documentation / Operational Notes

- `ATTRIBUTIONS.md` ships in the npm tarball (via `package.json` `files` array update); users see attribution after installing the package.
- The renamed `references/examples/skill-testing-walkthrough.md` makes the file harness-neutral — the upstream `CLAUDE_MD_TESTING.md` filename baked in a Claude-specific assumption. The internal content references "CLAUDE.md" in places; whether to also rename in-body references is a commit-2 judgment call (acceptable to leave if it's a worked-example file talking about a specific Claude-Code test campaign).
- v2.17.0 release notes should call out: (a) new bundled skills available via `systematic_skill { name: ... }`, (b) attribution to `obra/superpowers` and Anthropic, (c) the `writing-systematic-skills` foundation now bundles instead of requiring separate install.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-17-import-superpowers-foundation-skills-requirements.md](../brainstorms/2026-05-17-import-superpowers-foundation-skills-requirements.md)
- **Upstream pin:** `obra/superpowers@v5.1.0` at commit `f2cbfbefebbfef77321e4c9abc9e949826bea9d7`. Source at `.slim/clonedeps/repos/obra__superpowers/skills/`.
- **Anthropic distillation source:** `https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices` (CC-BY-4.0).
- **Related code:** `src/lib/skills.ts:48` (`SKILL_FRONTMATTER_FIELDS`), `scripts/content-integrity.ts:559` (`checkSubfileReferences`), `scripts/generate-registry.ts` (registry auto-discovery), `src/lib/bootstrap.ts:126` (`getBootstrapContent`).
- **Memories:** `#3097` (clonedep pin), `#3098` (Anthropic CC-BY-4.0 licensing), `#2767` (TDD discipline rule), `#1635` (bundled-vs-user precedence).
- **Smart notes:** `#98` (deferred harness-portability), `#99` (deferred SUBAGENT-STOP + Instruction Priority), `#100` (deferred regression protection).
