---
title: Prove CSS is dead against rendered HTML, not source markup, before deleting it
date: 2026-06-04
category: best-practices
module: docs-site
problem_type: best_practice
component: documentation
severity: low
applies_when:
  - Auditing or pruning CSS in a static-site project
  - Deciding whether a CSS rule is dead before deleting it
  - Refactoring Starlight or component-framework styling where source markup and rendered HTML differ
symptoms:
  - Selectors look used in source but match no rendered elements
  - A stylesheet alone is insufficient to prove a rule is live
resolution_type: documentation_update
related_components:
  - tooling
  - documentation
tags:
  - css
  - dead-code
  - dom-verification
  - astro
  - starlight
---

# Prove CSS is dead against rendered HTML, not source markup, before deleting it

## Context

During a docs-site CSS cleanup, a hand-authored rule in `docs/src/styles/custom.css` needed a dead-vs-live verdict before deletion. The trap: component frameworks emit class names that differ from what the source markup suggests, so reasoning from source (or from the stylesheet itself) is unreliable.

## Guidance

Inspect the **rendered HTML**, not the source MDX/markup, to decide whether a selector is live.

Concretely, Starlight's `<Card>`, `<CardGrid>`, and `<LinkCard>` emit `sl-link-card`, `card-grid`, and `card-icon` — never bare `.card` or `.link-card`. So a project rule like `.card, .link-card` matched **zero** rendered elements:

```bash
grep -c 'class="card"' docs/dist/**/*.html   # -> 0
# browser DOM eval -> cardCount: 0
```

That rule was genuinely dead and safe to delete.

The counter-example in the same file: `.definition-category` / `.definition-source` **are** live — emitted by `<span class="definition-category">` in `docs/src/content/docs/reference/agents/*.md` across 51 reference pages. Deleting them would have been a silent visual regression.

## Why This Matters

Deleting dead CSS is only safe when proven against rendered output. Source-level assumptions are how you delete a live style and then chase a phantom regression. In this session, flip-flopping (delete → panic-revert on a hallucinated "corruption" → re-delete) wasted effort; grounding on exact rendered-HTML grep evidence **first** settled it in one move.

## When to Apply

- Auditing old docs/site CSS for dead rules.
- Deciding whether a selector is safe to remove.
- Refactoring Starlight (or any component-framework) styling, where emitted class names rarely match the authoring component name.

## Examples

Safe to delete (0 rendered matches):

```css
.card, .link-card { /* ... */ }
```

Keep (live across 51 pages):

```css
.definition-category { /* ... */ }
.definition-source { /* ... */ }
```

Verification pattern — build, then grep the rendered output (or use a browser DOM eval and confirm the selector matches zero nodes):

```bash
bun run docs:build
grep -rc 'class="card"' docs/dist | grep -v ':0' || echo "dead: no rendered matches"
```

## Related

- [Pre-push live-server screenshot QA](pre-push-live-server-screenshot-qa-2026-05-22.md) — verify rendered output, not just build status
- [Docs-site OKLCH migration](docs-site-oklch-migration-2026-05-21.md) — sibling docs-site CSS work
- [Astro <Steps> HMR regression](../runtime-errors/starlight-steps-astro-hmr-regression-2026-06-04.md) — same session; rendered-DOM verification over HTTP status
