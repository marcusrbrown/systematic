---
title: "feat: Upgrade frontend-design skill with Impeccable design laws"
type: feat
status: completed
shipped: "PR #418"
date: 2026-05-20
origin: docs/brainstorms/2026-05-20-frontend-design-upgrade-requirements.md
---

# feat: Upgrade frontend-design skill with Impeccable design laws

## Overview

Merge Impeccable's Shared Design Laws (pbakaus/impeccable, Apache 2.0) into Systematic's bundled `skills/frontend-design/SKILL.md`. The upgrade adds concrete, opinionated aesthetic rules — OKLCH color theory, a color strategy axis, a theme-forcing function, absolute bans on AI-slop patterns, and a two-tier category-reflex check — while leaving Systematic's workflow structure (Layer 0–4 + visual verification) intact.

## Problem Frame

Systematic's frontend-design skill guides workflow well but its design-law content is generic. Impeccable has distilled a tight set of concrete laws that prevent the AI-slop defaults that make AI-generated UI identifiable on sight. Merging these laws gives the skill the specificity it currently lacks.

## Requirements Trace

- R1. Add `## Design Laws` section after Layer 1, before Layer 2; verbatim merge with minimal normalization (remove `{{placeholder}}` syntax, soften register-specific qualifiers to be register-agnostic)
- R2. Section must cover Color (OKLCH, chroma-at-extremes, `#000`/`#fff` prohibition, tinted neutrals, four-step strategy axis), Theme (scene-sentence forcing function), Typography (65–75ch, ≥1.25 scale contrast), Layout (spacing rhythm, cards-as-lazy, nested cards always wrong, container overuse), Motion (exponential ease-out only, no bounce/elastic, no layout-property animation), Copy (no em dashes, no `--`), Absolute Bans (side-stripe borders, gradient text, glassmorphism-as-default, hero-metric template, identical card grids, modal-as-first-thought), AI Slop Test (first-order + second-order category-reflex checks)
- R3. Layer 0–4 workflow structure remains intact; Layer 2 duplicate bullets consolidated
- R4. `license: Apache-2.0` added to frontmatter
- R5. `ATTRIBUTIONS.md` entry added for Impeccable (Apache 2.0) noting Anthropic CC-BY-4.0 upstream

## Scope Boundaries

- No PRODUCT.md / DESIGN.md context-file protocol
- No Impeccable sub-commands (craft, shape, audit, teach, document, live)
- No `{{placeholder}}` compilation system
- No import of Impeccable reference sub-files (brand.md, product.md, etc.)
- Only `skills/frontend-design/SKILL.md` and `ATTRIBUTIONS.md` are modified

## Context & Research

### Relevant Code and Patterns

- `skills/frontend-design/SKILL.md` (258 lines, no sub-files) — Layer 2 has Typography, Color & Theme, Composition, Motion, Accessibility, Imagery. The Composition section's card bullet (`Default to cardless layouts / Cards are allowed when...`) partially duplicates Impeccable's card law — consolidate on Impeccable's formulation
- `ATTRIBUTIONS.md` — use same attribution block format as the obra/superpowers entry (repo header, Source repository, Pinned commit, License, Copyright, Cloned at, Files derived, Adaptation notes)
- `skills/test-driven-development/SKILL.md` — `license: MIT` frontmatter example; use `license: Apache-2.0` for this import
- `scripts/content-integrity.ts` — banned patterns are CC/CEP-specific strings only; Impeccable's design law prose (OKLCH, chroma, glassmorphism, gradient text, side-stripe) does not trigger the gate

### Institutional Learnings

- PR #394 (obra/superpowers import): verbatim merge with minimal normalization is the established pattern; attribution via ATTRIBUTIONS.md + frontmatter `license:` field; no per-file attribution comments
- Impeccable's `## Shared design laws` section contains zero `{{placeholder}}` syntax — clean import, no substitution needed

### External References

- Impeccable source: https://github.com/pbakaus/impeccable/blob/main/skill/SKILL.md (`## Shared design laws` section)
- Apache 2.0 license: https://www.apache.org/licenses/LICENSE-2.0

## Key Technical Decisions

- **Verbatim merge, minimal normalization:** Rules imported as-is; only mechanical edits allowed — remove `{{placeholder}}` syntax, replace "both registers" with register-agnostic phrasing. No editorial rewriting.
- **New section placement:** `## Design Laws` goes after `## Layer 1: Pre-Build Planning` and before `## Layer 2: Design Guidance Core`. This ensures agents receive the laws before the Layer 2 workflow guidance.
- **Layer 2 card consolidation:** The existing Layer 2 Composition card bullet is the only direct overlap with the imported laws. Replace it with a forward reference to the Design Laws section rather than leaving duplicate guidance.
- **Attribution in ATTRIBUTIONS.md only:** No attribution prose in the skill body — content-integrity gate scans skill bodies for banned strings and any CC/CEP attribution comment would be a maintenance hazard.

## Open Questions

### Resolved During Planning

- **Will Impeccable prose trip the content-integrity gate?** No — banned patterns are CC/CEP-specific strings only. OKLCH, chroma, glassmorphism, gradient text, side-stripe are all clean.
- **Does Impeccable's design laws section use `{{placeholder}}` syntax?** No — the `## Shared design laws` section is pure prose with no placeholder variables. Normalization is trivial.
- **Pinned commit for attribution?** Fetch HEAD commit SHA from pbakaus/impeccable at import time and record it in ATTRIBUTIONS.md.

### Deferred to Implementation

- Exact SHA of pbakaus/impeccable HEAD at import time (fetch during Unit 1)

## Implementation Units

- [ ] **Unit 1: Merge design laws into SKILL.md**

**Goal:** Add `## Design Laws` section containing Impeccable's Shared Design Laws; consolidate overlapping Layer 2 Composition card bullet; add `license: Apache-2.0` to frontmatter.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `skills/frontend-design/SKILL.md`

**Approach:**
- Fetch `## Shared design laws` content from pbakaus/impeccable `skill/SKILL.md` at HEAD
- Record HEAD SHA for attribution (needed in Unit 2)
- Insert new `## Design Laws` section immediately after the `## Layer 1: Pre-Build Planning` closing line and before `## Layer 2: Design Guidance Core`
- Normalize: no `{{placeholder}}` instances exist in this section; remove any "both registers" qualifiers by replacing with neutral phrasing (e.g., "every design")
- In Layer 2 `### Composition`: replace the card bullet (`Default to cardless layouts...`) with a forward reference: `- Card and layout rules: see Design Laws above.`
- Add `license: Apache-2.0` to frontmatter alongside existing `name` and `description` fields

**Test expectation:** None — this is a markdown content change with no runtime behavior. Verification is manual content review + gate checks.

**Verification:**
- `## Design Laws` section present and positioned correctly in file
- All 8 required topics from R2 present in the section
- No `{{placeholder}}` syntax remains
- Layer 2 Composition card bullet replaced with forward reference
- `license: Apache-2.0` in frontmatter
- `bun scripts/content-integrity.ts` passes with 0 violations
- `bun run build` passes

- [ ] **Unit 2: Update ATTRIBUTIONS.md**

**Goal:** Add attribution entry for Impeccable following the established obra/superpowers block format.

**Requirements:** R5

**Dependencies:** Unit 1 (need HEAD SHA fetched there)

**Files:**
- Modify: `ATTRIBUTIONS.md`

**Approach:**
- Add a new attribution block following the same block structure used for obra/superpowers (omit `Cloned at` — no local clone for Impeccable):
  - Header: `## pbakaus/impeccable — Apache 2.0`
  - Source repository link
  - Pinned commit SHA (from Unit 1)
  - License: Apache 2.0
  - Copyright: Paul Bakaus
  - Note that Impeccable itself incorporates Anthropic's frontend-design skill content (CC-BY-4.0); the Apache 2.0 license from Impeccable governs this derived work per its own attribution chain
  - Files derived: `skills/frontend-design/SKILL.md` (Design Laws section)
  - Adaptation notes: verbatim merge; register-specific qualifiers removed; no placeholder substitution

**Test expectation:** None — documentation change only.

**Verification:**
- ATTRIBUTIONS.md has a new `## pbakaus/impeccable` block in correct format
- Pinned SHA is present and accurate
- Attribution chain (Impeccable → Anthropic upstream) is noted

## System-Wide Impact

- **Unchanged invariants:** Systematic's Layer 0 context detection, Layer 1 pre-build planning, Layers 2–4 implementation guidance, visual verification, and creative energy sections are unmodified. The skill's description and trigger conditions are unchanged.
- **Content-integrity gate:** No new banned patterns introduced. Gate passes at current allowlist configuration.
- **Registry:** No registry changes needed — no new sub-files added, existing component entry for `frontend-design` remains valid.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-05-20-frontend-design-upgrade-requirements.md`
- Impeccable skill source: https://github.com/pbakaus/impeccable/blob/main/skill/SKILL.md
- Precedent import: obra/superpowers (PR #394)
- ATTRIBUTIONS.md: `ATTRIBUTIONS.md`
