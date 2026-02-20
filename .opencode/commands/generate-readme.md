---
name: generate-readme
description: Create or update README.md with accurate project documentation
argument-hint: "[full|section-name]"
---

# Generate README Documentation

Update the project's README.md with comprehensive, accurate documentation.

## Arguments

<scope>$ARGUMENTS</scope>

**If scope is empty or "full":** Complete README rewrite
**If scope contains a section name:** Focus on updating that section only (e.g., "agents", "skills", "commands", "development")

## Pre-Injected Context

<package-info>
!`cat package.json`
</package-info>

<current-readme>
@README.md
</current-readme>

<asset-inventory>
!`bun src/cli.ts list skills 2>/dev/null`
!`bun src/cli.ts list agents 2>/dev/null`
!`bun src/cli.ts list commands 2>/dev/null`
</asset-inventory>

<agent-categories>
!`for dir in agents/*/; do echo "### $(basename "$dir")"; ls "$dir"*.md 2>/dev/null | while read f; do head -4 "$f" | grep -E "^(name|description):" ; echo "---"; done; echo; done`
</agent-categories>

<skill-frontmatter>
!`for f in skills/*/SKILL.md; do head -6 "$f"; echo "---"; done`
</skill-frontmatter>

<command-frontmatter>
!`for f in commands/*.md commands/workflows/*.md; do head -6 "$f" 2>/dev/null; echo "---"; done`
</command-frontmatter>

<recent-changes>
!`git log --oneline -15`
</recent-changes>

## Execution Flow

### Phase 1: Analyze Context

1. From `<current-readme>`: Understand the existing structure, style, and formatting conventions. **Preserve the evolved structure** — do not regress to a generic template.
2. From `<package-info>`: Extract name, version, description, repository URL, author
3. From `<asset-inventory>`: Get exact counts of skills, agents, and commands
4. From `<agent-categories>`: Build agent tables grouped by directory (design, research, review, workflow)
5. From `<skill-frontmatter>` and `<command-frontmatter>`: Extract names and descriptions for tables
6. From `<recent-changes>`: Note version tags and recent features

If scope specifies a single section, read the current README and only update that section.

### Phase 2: Content Mapping

Map extracted data to README sections. Every count and description must come from the injected context — never hardcode.

| README Section | Data Source |
|----------------|-------------|
| Header Block | `<current-readme>` — preserve `<picture>`, badge style, nav links |
| Quick Start CTA | README copy guidance — install-first imperative language + Next Steps links |
| Overview / Key Features | `<package-info>` description + asset counts from `<asset-inventory>` |
| Quick Start | `<package-info>` name for install command |
| Skills | `<skill-frontmatter>` — table with Name and Description |
| Agents | `<agent-categories>` — tables grouped by category directory |
| Commands | `<command-frontmatter>` — tables split by Workflows vs Utilities |
| CLI | Preserve existing CLI section from `<current-readme>` |
| Configuration | Read `src/lib/config.ts` if needed for config options |
| Tools | Preserve existing Tools section |
| How It Works | Preserve existing Mermaid diagram and hook explanations |
| Development | `<package-info>` scripts + project structure from filesystem |
| Converting from Claude Code | Preserve existing section |
| References + License | `<package-info>` author, repository |

### Phase 3: README Generation

#### Formatting Rules

These rules are **non-negotiable** — they match the existing README style:

1. **Header block**: Use `<picture>` with `<source>` tags for dark/light mode, not bare `<img>`
2. **Badges**: Use `style=flat-square` with `labelColor=1a1a2e` and the project's color scheme:
   - Build: `color=4FD1C5`
   - npm: `color=E91E8C`
   - Docs: `color=4FD1C5`
   - License: `color=F5A623`
3. **Navigation**: Bold links separated by ` · ` (middle dot)
4. **Agent tables**: One table per category directory (Design, Research, Review, Workflow), with `| Agent | Purpose |` headers
5. **Skill table**: Single table with `| Skill | Description |` headers. Skill names in backticks.
6. **Command tables**: Split into "Workflow Commands" and "Utility Commands". Workflow commands use `/workflows:` prefix. Utility commands use `/systematic:` prefix.
7. **Counts**: The "Key Features" bullet mentioning bundled content must use the exact counts from `<asset-inventory>`. Format: "X skills, Y agents, and Z commands"
8. **Project Structure tree**: Update file comments to match current counts (e.g., `# X bundled agents (4 categories)`)
9. **Quick Start CTA**: The primary action in Quick Start must emphasize installation. Use imperative language: "Install the plugin by adding it to your OpenCode configuration (`~/.config/opencode/opencode.json`)". The Verify Installation step should be followed by a "Next Steps" subsection linking to the Philosophy, Main Loop, and Agent Install guides at `https://fro.bot/systematic/guides/`.
10. **Code blocks**: Use `bash` for shell, `json` for config, `markdown` for skill examples, `mermaid` for diagrams

#### Section Order

Maintain this exact section order (matches current README):

1. Header Block (centered div)
2. Overview (with "Why Systematic?" and "Key Features")
3. Quick Start (Prerequisites, Installation, Verify)
4. Skills (table + "How Skills Work")
5. Agents (4 category tables + "Using Agents")
6. Commands (Workflow + Utility tables)
7. CLI (command table + examples)
8. Configuration (Plugin config, Project-specific content)
9. Tools (table)
10. How It Works (Mermaid diagram + explanations)
11. Development (Prerequisites, Setup, Project Structure, Testing, Contributing)
12. Converting from Claude Code
13. References
14. License

### Phase 4: Quality Verification

Before finalizing:

**Security Checklist:**
- [ ] No API keys, tokens, or credentials
- [ ] No internal URLs or IP addresses
- [ ] No sensitive file paths exposed
- [ ] All example data is generic

**Accuracy Checklist:**
- [ ] All skill/agent/command counts match `<asset-inventory>` output exactly
- [ ] All agent descriptions match their frontmatter
- [ ] All agents are listed under the correct category
- [ ] Badge URLs are valid and use correct style
- [ ] Mermaid diagram is preserved from current README
- [ ] No phantom agents or skills listed (only those in `<asset-inventory>`)

### Phase 5: Write and Verify

1. Use the `write` tool to save README.md
2. Report completion with:
   - Sections updated
   - Asset counts (skills: X, agents: Y, commands: Z)
   - Any discrepancies found between old README and actual content

## Output

When complete, report:
- Sections updated (or "all" for full rewrite)
- Asset counts derived from live inventory
- Changes from previous README (what was added, removed, or corrected)
