---
description: Create or update README.md with comprehensive project documentation covering plugin purpose, agents, commands, skills, and workflows
---

# Generate README Documentation

Update the project's README.md with comprehensive, accurate documentation.

## Arguments

<scope>$ARGUMENTS</scope>

**If scope is empty or "full":** Complete README rewrite
**If scope contains a section name:** Focus on updating that section only

## Pre-Injected Context

<package-info>
!`cat package.json`
</package-info>

<bundled-skills>
!`find skills -name "SKILL.md" -exec sh -c 'echo "=== {} ===" && head -20 "{}"' \;`
</bundled-skills>

<bundled-agents>
!`find agents -name "*.md" -exec sh -c 'echo "=== {} ===" && head -15 "{}"' \;`
</bundled-agents>

<bundled-commands>
!`find commands -name "*.md" -exec sh -c 'echo "=== {} ===" && head -10 "{}"' \;`
</bundled-commands>

<recent-changes>
!`git log --oneline -10`
</recent-changes>

## Execution Flow

### Phase 1: Analyze Pre-Injected Context

Review the shell-injected context above:

1. From `<package-info>`: Extract name, version, description, author, dependencies
2. From `<bundled-skills>`: Parse frontmatter to build skills table (name, description)
3. From `<bundled-agents>`: Parse frontmatter to build agents table (name, description, category)
4. From `<bundled-commands>`: Parse frontmatter to build commands table (name, description)
5. From `<recent-changes>`: Note version tag and recent features

Use the `read` tool if you need complete file content beyond the injected excerpts:
- Read `src/index.ts` to understand plugin hook registration
- Read current `README.md` to preserve custom content when doing partial updates

### Phase 2: Content Mapping

Map extracted data to README sections:

| README Section | Data Source |
|----------------|-------------|
| Overview | `<package-info>` description field |
| Quick Start | `<package-info>` name for install command |
| Skills | `<bundled-skills>` frontmatter parsing |
| Agents | `<bundled-agents>` frontmatter parsing |
| Commands | `<bundled-commands>` frontmatter parsing |
| Configuration | Use `read` on `src/lib/config.ts` if needed |
| How It Works | Use `read` on `src/index.ts` for hook details |
| Development | `<package-info>` scripts field |

### Phase 3: README Generation

#### Required Sections

1. **Header Block** (centered)
   - Logo (`assets/banner.svg`)
   - Title and tagline
   - Badges (build status, npm version, license)
   - Quick navigation links

2. **Overview**
   - What the plugin does (1-2 sentences)
   - Why it matters (pain point it solves)
   - Key features (bullet list, 4-6 items)

3. **Quick Start**
   - Prerequisites
   - Installation command
   - Configuration snippet
   - Verification step

4. **Skills Table**
   - Name | Description format
   - Brief explanation of how skills work

5. **Agents Tables**
   - Grouped by category (Review, Research, etc.)
   - Name | Purpose format

6. **Commands Tables**
   - Grouped by type (Workflows, Utilities)
   - Command | Description format

7. **Configuration**
   - Plugin config file location and format
   - Disable options
   - Project-specific content locations

8. **Tools**
   - Tools exposed to OpenCode
   - Brief usage notes

9. **How It Works**
   - Mermaid diagram showing plugin hooks
   - Explanation of each hook's role

10. **Development**
    - Prerequisites
    - Setup commands
    - Project structure tree
    - Test commands
    - Contributing reference

11. **References**
    - Links to related documentation
    - License

### Phase 4: Quality Verification

Before finalizing:

**Security Checklist:**
- [ ] No API keys, tokens, or credentials
- [ ] No internal URLs or IP addresses
- [ ] No sensitive file paths exposed
- [ ] All example data is generic

**Quality Checklist:**
- [ ] All skill/agent/command counts match actual files
- [ ] All frontmatter descriptions are current
- [ ] Installation commands are correct
- [ ] Badge URLs are valid
- [ ] Mermaid diagram renders correctly

### Phase 5: Write and Verify

1. Use the `write` tool to save README.md
2. Use `bash` to run `bun run lint` to check markdown formatting (if configured)
3. Report completion with asset counts

## Template Reference

Use this structure as the base template:

```markdown
<div align="center">

<img src="./assets/banner.svg" alt="Systematic" width="100%" />

# Systematic

> Structured engineering workflows for OpenCode

[![Build Status](badge-url)](action-url) [![npm](npm-url)](npm-package) [![License](license-badge)](LICENSE)

[Overview](#overview) · [Quick Start](#quick-start) · [Skills](#skills) · [Agents](#agents) · [Commands](#commands) · [Development](#development)

</div>

---

## Overview

{Brief description from package.json}

### Why Systematic?

{Pain point and value proposition}

### Key Features

- **Feature 1** — Description
- **Feature 2** — Description
...

## Quick Start

### Prerequisites

- OpenCode installed
- Node.js 18+ or Bun

### Installation

\`\`\`bash
npm install @fro.bot/systematic
\`\`\`

Add to config:

\`\`\`json
{
  "plugins": ["@fro.bot/systematic"]
}
\`\`\`

## Skills

| Skill | Description |
|-------|-------------|
| `skill-name` | {from frontmatter} |
...

## Agents

### Category Name

| Agent | Purpose |
|-------|---------|
| `agent-name` | {from frontmatter} |
...

## Commands

### Workflows

| Command | Description |
|---------|-------------|
| `/command-name` | {from frontmatter} |
...

## Configuration

{Config file locations and options}

## Tools

| Tool | Description |
|------|-------------|
| `tool-name` | {description} |

## How It Works

\`\`\`mermaid
flowchart TB
    A[Plugin Loaded] --> B[config hook]
    ...
\`\`\`

## Development

{Setup and build instructions}

## License

[MIT](LICENSE) © {author from package.json}
```

## Output

When complete, report:
- Sections updated
- Asset counts (skills, agents, commands)
- Any discrepancies found between README and actual content
