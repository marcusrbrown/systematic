---
title: OKLCH Color Migration for Starlight Docs Sites
date: 2026-05-21
module: docs/src/styles/custom.css + docs/astro.config.mjs
problem_type: best_practice
component: documentation
severity: low
category: best-practices
applies_when:
  - migrating a Starlight or Astro docs site to OKLCH colors
  - adding Mermaid diagrams to a site using OKLCH custom properties
  - docs site ships design-law content and should dogfood it
tags:
  - oklch
  - css
  - starlight
  - mermaid
  - design-laws
  - docs-site
---

# OKLCH Color Migration for Starlight Docs Sites

## Context

After importing Impeccable's design laws (which mandate OKLCH color and tinted neutrals), the docs site's `custom.css` still used hex colors including pure `#000` and `#fff` — violating the laws the project now ships. Aligning the docs site with the bundled design laws is both dogfooding and credibility.

## Guidance

### CSS Custom Properties

Convert all Starlight CSS custom properties (`--sl-color-*`) from hex to `oklch()`. Use tinted neutrals throughout — pick a single hue angle and vary lightness/chroma:

```css
/* Tinted neutrals on hue 195 (teal) */
--sl-color-white: oklch(0.98 0.005 195);
--sl-color-black: oklch(0.15 0.015 195);
--sl-color-gray-1: oklch(0.93 0.01 195);
--sl-color-gray-6: oklch(0.35 0.02 195);
```

### Mermaid Diagrams

Mermaid does NOT support `oklch()` in `style` directives. Use hex approximations of the OKLCH palette values. Document the mapping in the Astro config:

```javascript
// Hex approximations of oklch palette for Mermaid compatibility
mermaid: {
  theme: { primaryColor: '#1e2530' }  // oklch(0.15 0.015 195)
}
```

### Starlight Heading Fonts

Starlight's `--sl-font-heading` variable applies to `.sl-markdown-content` headings on content pages. The splash/hero page uses a different component that inherits `--sl-font` (system font). This creates intentional contrast: serif content headings, sans-serif hero — which is fine.

### Deployment Pipeline

The docs site deploys only on `release: published` events or manual `workflow_dispatch`. Non-releasing commits (`docs:` without a release-triggering scope) do NOT trigger deployment. After docs-only changes, either dispatch the workflow manually or wait for the next releasing commit to flush them.

## Why This Matters

A docs site that violates its own bundled design laws undermines credibility. Mermaid's lack of OKLCH support is a silent gotcha — diagrams render with fallback colors that break the palette unless hex approximations are provided explicitly.

## When to Apply

- Migrating any Starlight/Astro docs site to OKLCH
- Adding Mermaid diagrams to a site using OKLCH custom properties
- Any docs site that ships design-law content and should dogfood it

## Examples

PR #419 converted all 22 color values in `docs/src/styles/custom.css` from hex to `oklch()`, updated Mermaid theme variables in `docs/astro.config.mjs` to hex approximations, and aligned the `design-iterator` agent's `<frontend_aesthetics>` block with the new design laws. The heading serif font was verified working on content pages via `agent-browser` CSS inspection.
