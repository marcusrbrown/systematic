---
name: generating-project-docs
description: Use when creating, refreshing, or updating project-level documentation — README.md, ARCHITECTURE.md, STRUCTURE.md, or scoped section updates
argument-hint: "[readme|architecture|structure|all|section-name]"
---

# Generating Project Documentation

## Overview

This plugin's documentation describes a live system whose surface (skills, agents, config schema, CLI) keeps changing. Generated docs go stale fast.

**Core principle:** Derive every fact from the live repository. Preserve the existing document's evolved structure. Never regress to a generic template.

If you cannot point at a file or command that justifies a sentence, do not write it.

## When to Use

- Refreshing `README.md` after new skills, agents, or features land
- Fixing documentation drift (counts, structure, CLI output, runtime claims)
- Updating `ARCHITECTURE.md` or `STRUCTURE.md` when the codebase layout changes
- Adding or refreshing a scoped section (e.g. only the "Skills" table)

## When NOT to Use

- Writing planning docs (`docs/plans/`, `docs/brainstorms/`) — those follow their own templates
- Authoring skill or agent files — those have their own format rules

## Arguments

```
$ARGUMENTS
```

- **Empty or `readme`** — Update `README.md` (default)
- **`architecture`** — Update `ARCHITECTURE.md`
- **`structure`** — Update `STRUCTURE.md`
- **`all`** — Update all three docs
- **`<section-name>`** — Update only that named section within the target doc (e.g. `skills`, `agents`, `cli`)

For scoped updates: read the current document, locate the section by heading, replace only that section's content. Preserve surrounding structure exactly.

## Pre-Generation Inventory

Before writing anything, gather these from the live repo:

| Source | What to extract |
|--------|----------------|
| `package.json` | name, version, description, scripts, repository URL |
| `bun src/cli.ts list skills 2>/dev/null` | exact skill count and names |
| `bun src/cli.ts list agents 2>/dev/null` | exact agent count, names, categories |
| `bun src/cli.ts list commands 2>/dev/null` | command inventory |
| `for f in skills/*/SKILL.md; do head -6 "$f"; echo "---"; done` | skill frontmatter (name, description) |
| `for dir in agents/*/; do echo "### $(basename "$dir")"; ls "$dir"*.md 2>/dev/null | while read f; do head -4 "$f" | grep -E "^(name\|description):"; echo "---"; done; echo; done` | agent frontmatter grouped by category |
| `README.md` (current) | existing structure, badges, nav links, voice |
| `git log --oneline -15` | recent change context |

Counts MUST come from live CLI output or `ls`/`find`. Never carry over from the previous draft.

## Style Rules (Non-Negotiable)

These rules match this repo's evolved style. Match them exactly.

1. **Header block**: `<picture>` with `<source>` tags for dark/light mode, not bare `<img>`
2. **Badges**: `style=flat-square`, `labelColor=1a1a2e`, project color scheme:
   - Build: `color=4FD1C5`
   - npm: `color=E91E8C`
   - Docs: `color=4FD1C5`
   - License: `color=F5A623`
3. **Navigation**: bold links separated by ` · ` (middle dot)
4. **Agent tables**: one table per category directory (`design`, `docs`, `document-review`, `research`, `review`, `workflow`), headers `| Agent | Purpose |`
5. **Skill table**: single table, headers `| Skill | Description |`, skill names in backticks
6. **Counts**: every count in prose or bullets must come from live CLI output — never hardcoded
7. **Code blocks**: language-tagged — `bash` for shell, `json` for config, `markdown` for skill examples, `mermaid` for diagrams
8. **Voice**: terse, declarative, fact-first. No marketing language. No "robust", "powerful", "leverages", "best-in-class"
9. **No session/process leakage**: never reference subagent names, plan paths, skill names, or session framing in public docs. Public docs describe the system, not how it was built.
10. **Paths**: backticks for every file, directory, command, env var

## Section Order

For `README.md`, preserve this exact order:

1. Header Block (centered div with `<picture>`, badges, nav)
2. Overview (with "Why Systematic?" and "Key Features")
3. Quick Start (Prerequisites, Installation, Verify, Next Steps)
4. Skills (table + "How Skills Work")
5. Agents (category tables + "Using Agents")
6. Commands (Workflow + Utility tables)
7. CLI (command table + examples)
8. Configuration (Plugin config, Project-specific content)
9. Tools (table)
10. How It Works (Mermaid diagram + hook explanations)
11. Development (Prerequisites, Setup, Project Structure, Testing, Contributing)
12. Converting from Claude Code
13. References
14. License

## Generation Flow

1. **Inventory** — run every command in "Pre-Generation Inventory". Count things; don't estimate.
2. **Diff against current doc** — for each section, identify what changed (new assets, removed assets, count drift, renamed items).
3. **Write minimal diff** — update only what changed. Keep voice, structure, and untouched sections exactly as they are.
4. **Verify** — run the quality checks below. Re-read the doc end-to-end before saving.

## Quality Checks

**Security (always):**
- [ ] No API keys, tokens, credentials, or secrets
- [ ] No internal URLs, IPs, or local paths (e.g. `/Users/...`)
- [ ] All example data is generic and redacted

**Accuracy (always):**
- [ ] All skill/agent/command counts match live CLI output exactly
- [ ] All agent descriptions match their frontmatter
- [ ] All agents listed under the correct category
- [ ] No phantom skills or agents (only those in live inventory)
- [ ] Badge URLs are valid and use correct style
- [ ] Mermaid diagram preserved from current README

**Style (always):**
- [ ] Headings monotonically increase (H1 → H2 → H3, no skipping)
- [ ] All code blocks have language tags
- [ ] All file references use backticks

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Carrying over counts from previous draft | Re-derive every count from live CLI output |
| Adding "Robust", "Powerful", "Enterprise-grade" language | Delete it. State the fact instead. |
| Using bare `<img>` instead of `<picture>` with `<source>` tags | Match the existing header block exactly |
| Wrong badge color or style | Check style rules above: `flat-square` + `labelColor=1a1a2e` |
| Replacing the evolved structure with a generic template | Read the current doc first; preserve sections you aren't updating |
| Inventing new top-level sections | Get explicit approval before adding a new H2 |
| Leaking session/plan/skill/subagent names into docs | Public docs describe the system, not how it was built |
| Hardcoding counts | Always derive from `bun src/cli.ts list` output |

## Quick Reference

```bash
# Inventory (run before writing)
bun src/cli.ts list skills 2>/dev/null     # skill count + names
bun src/cli.ts list agents 2>/dev/null     # agent count + categories
bun src/cli.ts list commands 2>/dev/null   # command inventory
git log --oneline -15                      # recent change context

# Verification (run after writing)
git diff README.md                         # review own diff
```
