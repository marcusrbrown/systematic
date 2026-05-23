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
- Adding or refreshing a scoped section (e.g. only the "Quick Install" block)

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
| `find skills -name SKILL.md -exec head -6 {} \; -exec echo --- \;` | skill frontmatter (name, description) |
| `find agents -maxdepth 2 -name '*.md' -exec head -4 {} \; -exec echo --- \;` | agent frontmatter (name, description), category from path |
| Current target doc | existing structure, badges, nav links, voice |
| `git log --oneline -15` | recent change context |

Use `find ... -exec` or `while IFS= read -r` for shell loops over file lists. Unquoted `for f in $VAR` in zsh does not word-split a multiline variable and will iterate once on the joined string.

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
4. **Tables in README**: avoid them. The README is reference-light; tables of skills, agents, or commands belong on the docs site. If a table feels necessary, write prose instead and link to the docs page.
5. **Tables in `STRUCTURE.md`**: allowed for Key File Locations only. Headers `| File | Role |`. Reference `.md` files and source paths with backticks.
6. **Counts**: every count in prose or bullets must come from live CLI output — never hardcoded
7. **Code blocks**: language-tagged — `bash` for shell, `json` for config, `markdown` for skill examples, `mermaid` for diagrams
8. **Voice**: terse, declarative, fact-first. No marketing language. No "robust", "powerful", "leverages", "best-in-class"
9. **No session/process leakage**: never reference subagent names, plan paths, skill names, or session framing in public docs. Public docs describe the system, not how it was built.
10. **Paths**: backticks for every file, directory, command, env var

## Section Order

Read the target doc first and preserve its evolved section structure. The section lists below are the current shape; check the live file to confirm before generating. New top-level sections need explicit approval.

### `README.md`

The README is intentionally lean — most reference material lives on the docs site, not in this file.

1. Header block (centered div with `<picture>`, badges, nav links)
2. Problem statement (1–2 paragraphs, no heading — flows directly from the header)
3. `## Why Systematic?` — short pitch, prose not bullets
4. `## What You Get` — prose enumeration of skills/agents/commands at a high level (no tables; links to docs site for details)
5. `## Quick Install` — `opencode.json` snippet and one verification command
6. `## First Workflow` — canonical brainstorm → plan → work → review sequence
7. `## First-Run Checklist` — short numbered list
8. `## Learn More` — deep links to docs site, ARCHITECTURE.md, STRUCTURE.md
9. `## License`

Do NOT add: skill tables, agent category tables, CLI reference tables, Mermaid diagrams, "How It Works" hook walkthroughs, Development sections, "Converting from..." migration guides. These belong on the docs site. The README's job is to get a new reader from zero context to running a first workflow.

### `ARCHITECTURE.md`

Following matklad's "Bird's Eye" pattern. Audience: contributors who need to understand how the plugin works at a system level.

1. `# Architecture` — H1 title + 1–2 sentence orientation that points at `STRUCTURE.md` and `AGENTS.md`
2. `## Bird's Eye Overview` — two-paragraph summary of plugin shape and the three OpenCode hooks
3. `## Codemap` — pipeline diagram + symbol table mapping roles to file paths
4. `## Invariants` — numbered list of invariants CI enforces
5. `## Data Flow` — ASCII tree from plugin load through hooks
6. `## Cross-Cutting Concerns` — content-integrity gate, registry drift, config validation, memoization, config priority

### `STRUCTURE.md`

Audience: contributors who need to know where things live and where to put new code.

1. `# Structure` — H1 title + cross-references to `ARCHITECTURE.md` and `AGENTS.md`
2. `## Directory Layout` — ASCII tree of the top-level directories with inline comments
3. `## Directory Purposes` — H3 subsection per top-level directory (`src/`, `skills/`, `agents/`, `docs/`, `registry/`, `scripts/`, `tests/`, `.opencode/`)
4. `## Key File Locations` — categorized tables: Entry Points, Configuration, Core Logic, Build / CI Scripts, Tests
5. `## Naming Conventions` — bullets covering files, tests, skills, agents, functions, types, constants
6. `## Where to Add New Code` — prescriptive checklist (new skill, new agent, new config field, new core module, new test, new docs page, new build script, new project-only command)

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
- [ ] Any skill/agent/command counts in prose match live CLI output exactly
- [ ] Any agent or skill names cited resolve to a real file on disk
- [ ] Badge URLs are valid and use correct style
- [ ] Cross-references between `README.md`, `ARCHITECTURE.md`, and `STRUCTURE.md` resolve (no dangling links)

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
