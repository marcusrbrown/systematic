---
date: 2026-02-12
topic: reference-section-refresh
---

# Reference section refresh (skills, agents, commands)

## What we’re building

We’re improving the docs site’s **Reference** section so that generated pages for **skills**, **agents**, and **commands** feel like a coherent, scannable reference—rather than a raw copy of source Markdown.

Each reference page will render a **structured definition header** that surfaces essential metadata (from frontmatter) in a consistent layout, followed by the existing source body content. The goal is to make it immediately clear:

- What the definition is
- When to use it (at least via its description; deeper “when to use” stays in body)
- Where it comes from (source path)

We will also improve readability by generating **human-friendly headings** from names/slugs (e.g., `agent-browser` → `Agent Browser`) while keeping stable URLs.

## Why this approach

We want the reference pages to be **content-driven** (source Markdown remains canonical) but **presentation-consistent** (shared UI across all pages). The chosen approach is:

- **Generate MDX pages** that render a shared Astro/MDX component for the header
- Keep the remaining body content as-is (minimal transforms)

This gives us consistent UI without duplicating formatting logic across hundreds of generated pages.

## Key decisions

- **Target experience:** “Structured API ref” style pages: a consistent, compact header + clean body.
- **Implementation approach:** **MDX + shared components** (generator outputs an MDX wrapper that calls components living in `docs/src/components/...`).
- **Metadata policy (default): Minimal (scannability-first).**
  - Skills: `name`, `description`
  - Agents: `name`, `description`, `category` (where applicable)
  - Commands: `name`, `description`
  - Plus: `source` (path) where available
- **Title normalization:** Display titles should be derived from the canonical name/slug (e.g., kebab-case → Title Case).
- **Source linking:** Include a **GitHub “View source”** link in the header.
  - Repo: `marcusrbrown/systematic`
  - Branch: `main`
  - URLs derived from repo-relative paths for each definition file

## Success criteria

- Reference pages visually communicate “what/when/source” in under 5 seconds.
- Titles/headings are human-readable without manual editing.
- Styling/layout is consistent across skills/agents/commands.
- Minimal metadata avoids clutter and keeps pages readable.
- Generator output remains deterministic and friendly to sidebar autogeneration.

## Open questions

- **Title casing rules:** any special handling for acronyms (e.g., MCP, JSON), “v2”, etc.?
- **Source linking details:** do we also show the plain path alongside the GitHub link (copyable), or link-only?
- **Index pages:** should the reference landing pages become richer (e.g., CardGrid of categories/tags) or stay simple?

## Next steps

→ Move to `/workflows:plan` to decide the concrete generator output format (MDX shape), component API, and any minimal style system for the reference header.
