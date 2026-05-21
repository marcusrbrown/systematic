---
title: Importing Third-Party Design Laws into Bundled Skills
date: 2026-05-21
module: skills
problem_type: best_practice
component: documentation
severity: medium
category: best-practices
applies_when:
  - importing design rules or coding standards from third-party skill frameworks
  - bundled skill content derived from Apache 2.0 or CC-BY-4.0 sources
  - strengthening an existing skill with external content
tags:
  - design-laws
  - skill-import
  - impeccable
  - attribution
  - frontend-design
  - apache-2.0
---

# Importing Third-Party Design Laws into Bundled Skills

## Context

When a third-party skill framework (Impeccable, Apache 2.0) publishes design laws that strengthen an existing bundled skill (`frontend-design`), the import requires a specific merge pattern that preserves both the existing workflow structure and the imported content's attribution chain.

## Guidance

### Merge Pattern

Import design laws as a named section within the existing skill, not as a separate reference sub-file. A named `## Design Laws` section makes the content discoverable and authoritative — agents see it inline rather than needing to load a reference.

**Do:**
- Insert the new section at a natural workflow boundary (after context detection, before implementation guidance)
- Remove duplicate bullets from existing sections that the imported laws supersede
- Keep the existing skill's workflow phases intact — the laws fill content gaps, not structural ones

**Don't:**
- Replace the existing skill wholesale — workflow structure is project-specific
- Import protocol dependencies (e.g., PRODUCT.md/DESIGN.md context-file contracts, sub-command systems)
- Import placeholder compilation syntax (`{{model}}`, `{{command_prefix}}`) — resolve to concrete values or make harness-agnostic

### Attribution Chain

Add an entry to root `ATTRIBUTIONS.md` with:
- Source repository and commit SHA
- License type and full license text inline
- What was imported (specific section, not "the whole skill")

Add `license: Apache-2.0` (or appropriate license) to the skill's YAML frontmatter.

### Content Normalization

Imported design laws may contain register-specific framing (e.g., "Brand register" vs "Product register" in Impeccable). When the register system is not being imported, soften these qualifiers to be context-agnostic while preserving the underlying rule.

### Verification

Run a GREEN application test after import: dispatch `@designer` with a realistic design scenario and verify the agent correctly retrieves and applies the imported laws (color strategy axis, scene-sentence forcing function, absolute bans, category-reflex check).

## Why This Matters

Design laws imported without a named section get buried in skill prose and agents skip them. Laws imported without attribution create license compliance risk. Laws imported with protocol dependencies (PRODUCT.md contracts) add project setup friction that defeats adoption.

## When to Apply

- Importing design rules, coding standards, or review checklists from third-party skill frameworks
- Any bundled skill content derived from Apache 2.0 or CC-BY-4.0 sources
- Strengthening an existing skill with external content rather than replacing it

## Examples

PR #418 imported Impeccable's "Shared Design Laws" (OKLCH color, theme forcing function, absolute bans, category-reflex, motion rules) into `skills/frontend-design/SKILL.md`. The existing Layer 0–4 workflow structure was preserved; a new `## Design Laws` section was inserted after Layer 1. Layer 2's generic color/dark-light bullet was replaced with a reference to the scene-sentence law. Attribution added to `ATTRIBUTIONS.md` with full Apache 2.0 text and commit SHA.
