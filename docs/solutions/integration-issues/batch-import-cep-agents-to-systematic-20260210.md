---
title: "Batch Importing CEP Agents to Systematic with Full Manifest Tracking"
date: 2026-02-10
severity: medium
category: integration-issues
component: agents
tags:
  - cep-migration
  - agent-import
  - convert-cc-defs
  - sync-manifest
  - batch-workflow
environment: "Bun 1.x / TypeScript 5.7+ / OpenCode"
symptoms:
  - "Workflow commands reference ~17 agents that don't exist in Systematic"
  - "Commands fail or produce incomplete output when invoking phantom agents"
  - "README and docs show 11 agents when 24+ exist upstream"
root_cause: "Original CEP→Systematic migration only imported a subset of agents. Commands were copied verbatim, creating references to non-existent agents."
resolution_type: process
confidence: verified
---

# Batch Importing CEP Agents to Systematic with Full Manifest Tracking

## Problem

After the initial CEP→Systematic port, workflow commands (`review.md`, `lfg.md`, `deepen-plan.md`) referenced ~17 agents that hadn't been imported. Three referenced agents (`code-philosopher`, `devops-harmony-analyst`, `dependency-detective`) didn't even exist in upstream CEP — they were phantom references. The `sync-manifest.json` only tracked 5 command definitions, with no agent provenance at all.

### Symptoms

- `/workflows:review` dispatched to agents like `kieran-typescript-reviewer` that didn't exist
- `lfg.md` referenced CC-specific commands (`ralph-loop`, `resolve_todo_parallel`) that have no OpenCode equivalent
- `deepen-plan.md` used `.claude/` paths and CC plugin MCP tool names
- Agent count in README (11) was stale — upstream had 29 agents

## Investigation

### Step 1: Inventory upstream CEP agents

Fetched the full agent directory from `github.com/EveryInc/compound-engineering-plugin/tree/main/plugins/compound-engineering/agents`. Found 29 agents in 4 categories (design/3, research/5, review/16, workflow/5).

### Step 2: Evaluate relevance

Assessed each of the 29 upstream agents against Systematic's context:

- **Import (24):** All agents that provide general engineering value
- **Skip (5):** Org-specific agents (`every-style-editor`, `ankane-readme-writer`, `kieran-python-reviewer`, `julik-frontend-races-reviewer`, `schema-drift-detector`) — these reference Every Inc internal conventions or niche frameworks

### Step 3: Identify phantom agents

Cross-referenced all agent names in `commands/workflows/review.md` against upstream. Found 3 phantoms: `code-philosopher`, `devops-harmony-analyst`, `dependency-detective`. These appear in no CEP commit history — likely hallucinated during original command authoring.

### Step 4: Audit commands for CC-specific artifacts

Searched all commands for patterns needing rewrite:
- `.claude/` paths → `.opencode/` and `~/.config/opencode/`
- `compound-engineering:` prefix → `systematic:`
- CC-specific tools (`AskUserQuestion`, `mcp__plugin_compound-engineering_context7__`)
- CC-specific commands (`ralph-loop`, `resolve_todo_parallel`, `test-browser`, `feature-video`)

## Root Cause

The original migration was a partial port. Commands were copied with minimal adaptation, creating forward references to agents that hadn't been imported and CC-specific artifacts that don't exist in OpenCode. No manifest tracking meant there was no way to detect drift or stale references.

## Solution

### Batch import workflow (for each agent)

```bash
# 1. Fetch upstream content
# URL: https://raw.githubusercontent.com/EveryInc/compound-engineering-plugin/main/plugins/compound-engineering/agents/{category}/{name}.md

# 2. Mechanical conversion via convert-cc-defs skill
# - Parse frontmatter, extract name/description/color
# - Convert body through convertContent() pipeline
# - Write to agents/{category}/{name}.md

# 3. Intelligent rewrite (manual review per agent)
# - Check for CC-specific paths, tool names, branding
# - Apply rewrites (see table below)

# 4. Manifest entry
# - Add to sync-manifest.json with upstream_commit, content_hash, manual_overrides
```

### Key rewrites applied

| Agent | Rewrite | Rationale |
|-------|---------|-----------|
| `repo-research-analyst` | `**/CLAUDE.md` → `**/AGENTS.md` | OpenCode convention |
| `learnings-researcher` | Fixed relative skill path | Skill location differs |
| `git-history-analyzer` | `compound-engineering` → `systematic` | Branding |
| `best-practices-researcher` | `.claude/skills/` → `.opencode/skills/` | Path convention |
| `code-simplicity-reviewer` | Removed CC pipeline artifact exclusion | Not applicable |
| `pattern-recognition-specialist` | `grep` → `Grep` | Tool naming convention |

### Command fixes (same commit)

| Command | Fix |
|---------|-----|
| `lfg.md` | Removed 4 CC-specific commands, fixed `compound-engineering:` → `systematic:` |
| `deepen-plan.md` | Replaced ALL `.claude/` paths, CC plugin MCP refs, `AskUserQuestion` |
| `agent-native-audit.md` | Fixed `/compound-engineering:` → `/systematic:` |
| `review.md` | Removed 3 phantom agents, added 2 real agents |

### Manifest structure per agent

```json
{
  "agents/review/kieran-typescript-reviewer": {
    "type": "agent",
    "upstream_path": "plugins/compound-engineering/agents/review/kieran-typescript-reviewer.md",
    "upstream_commit": "f744b797efca368c986e4c8595e09a4f75e57a11",
    "content_hash": "<sha256>",
    "last_synced": "2026-02-10T...",
    "manual_overrides": "none"
  }
}
```

## Prevention

### Process

1. **Always run the convert-cc-defs workflow** when importing from CEP — never manually copy agents/commands
2. **Cross-reference commands against agent inventory** after import — use `bun src/cli.ts list agents` to verify all referenced agents exist
3. **Track provenance in manifest** — every imported definition gets a manifest entry with upstream commit hash and content hash for drift detection

### Automated checks

- `findStaleEntries()` in `src/lib/manifest.ts` detects definitions tracked in manifest but missing from filesystem
- Content hashes enable idempotent re-sync — running the import again skips unchanged agents
- `bun src/cli.ts list agents` provides authoritative agent inventory

### Pattern: Phantom agent detection

Before referencing agents in commands, verify they exist:

```bash
# List all agent names
bun src/cli.ts list agents | grep -o 'systematic:[^ ]*'

# Cross-reference against command references
grep -h '@\|agent\|dispatch' commands/**/*.md | grep -oE '[a-z]+-[a-z-]+' | sort -u
```

## Verification

- Build: pass
- Typecheck: pass (strict mode)
- Lint: 42 files, 0 issues (Biome)
- Tests: 328/328 pass
- Agent count: 24 (3 design + 5 research + 12 review + 4 workflow)
- Manifest entries: 29 (24 agents + 5 commands)
- Stale references: 0 (all phantom agents removed from commands)

## Related

- [Structured Manual Override Tracking](../best-practices/structured-manual-override-tracking-Systematic-20260210.md) — companion doc on manifest override format
- [convert-cc-defs skill](/.opencode/skills/convert-cc-defs/SKILL.md) — the workflow skill used for batch import
- [sync-manifest.json](/sync-manifest.json) — provenance tracking file
- CEP upstream: `github.com/EveryInc/compound-engineering-plugin` (commit `f744b797`)

## Key Learnings

1. **Batch imports need shared metadata** — fetching upstream commit hash once and reusing across all agents prevents manifest inconsistency
2. **Phantom references are real** — always verify referenced agents exist upstream before importing; commands can reference hallucinated agents
3. **Mechanical conversion is necessary but insufficient** — the converter handles ~80% of rewrites (paths, tool names), but domain-specific references (skill paths, exclusion rules, branding) require manual review
4. **Manifest `manual_overrides` has two formats** — plain string (`"none"`) for clean imports, structured object with `reason`/`details` for modified ones
5. **`color` frontmatter passes through** — CEP agents use a `color` field for UI theming; the converter preserves it without transformation
6. **5 agents are org-specific** — `every-style-editor`, `ankane-readme-writer`, `kieran-python-reviewer`, `julik-frontend-races-reviewer`, `schema-drift-detector` are specific to Every Inc and should not be imported to general-purpose Systematic
