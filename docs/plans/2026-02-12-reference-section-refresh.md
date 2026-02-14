# Reference Section Refresh — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade generated reference pages with human-readable titles, sidebar type badges, structured metadata headers (category for agents, source link), and consistent styling.

**Architecture:** Enhance the docs generator (`docs/scripts/transform-content.ts`) to produce enriched frontmatter (Title Case titles, sidebar badges) and prepend a structured HTML header block to each page body. Style the header via `docs/src/styles/custom.css`. Keep `.md` output — **not MDX** — because source content contains MDX-incompatible syntax (bare `{curly braces}` outside code fences in skills/commands, XML-like `<examples>` tags in agents). This is a refinement of the brainstorm decision, driven by research findings.

**Tech Stack:** Bun, TypeScript, Starlight 0.37, HTML/CSS

**Brainstorm:** `docs/brainstorms/2026-02-12-reference-section-refresh-brainstorm.md`

---

### Task 1: Title normalization

**Files:**
- Modify: `docs/scripts/transform-content.ts` (functions: `transformFrontmatter`, `toTitleCase` helper)

**Step 1: Add `toTitleCase` helper function**

Insert above the `transformFrontmatter` function:

```ts
const ACRONYMS = new Set([
  'api', 'cd', 'ci', 'cli', 'css', 'dhh', 'html',
  'json', 'mcp', 'pr', 'sdk', 'ui', 'ux', 'yaml',
])

function toTitleCase(name: string): string {
  return name
    .replace(/^workflows:/, 'Workflows: ')
    .split(/[-\s]+/)
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ')
    .trim()
}
```

**Step 2: Update `transformFrontmatter` to use `toTitleCase`**

In the `transformFrontmatter` function, find `if (data.name) transformed.title = data.name` and change to:
```ts
if (data.name) transformed.title = data.name
```
to:
```ts
if (data.name) transformed.title = toTitleCase(data.name)
```

**Step 3: Verify**

Run: `bun run docs:generate`

Spot-check:
```bash
head -3 docs/src/content/docs/reference/skills/agent-browser.md
# Expected: title: Agent Browser

head -3 docs/src/content/docs/reference/agents/dhh-rails-reviewer.md
# Expected: title: DHH Rails Reviewer

head -3 docs/src/content/docs/reference/commands/workflows-brainstorm.md
# Expected: title: Workflows: Brainstorm
```

**Step 4: Commit**

```bash
git add docs/scripts/transform-content.ts
git commit -m "docs: normalize reference page titles to Title Case"
```

---

### Task 2: Sidebar badges and definition type

**Files:**
- Modify: `docs/scripts/transform-content.ts` (functions: `transformFrontmatter`, `processDirectory`, plus call sites at bottom)

**Step 1: Add `definitionType` parameter to `processDirectory`**

Find `function processDirectory(` and change its signature from:
```ts
function processDirectory(
  sourceDir: string,
  outputSubdir: string,
  filePattern: RegExp = /\.md$/,
) {
```
to:
```ts
type DefinitionType = 'skill' | 'agent' | 'command'

function processDirectory(
  sourceDir: string,
  outputSubdir: string,
  definitionType: DefinitionType,
  filePattern: RegExp = /\.md$/,
) {
```

**Step 2: Update `transformFrontmatter` to accept and emit sidebar badge**

Change the `transformFrontmatter` function signature and body to:

```ts
function transformFrontmatter(
  data: Frontmatter,
  definitionType: DefinitionType,
): Record<string, unknown> {
  const transformed: Record<string, unknown> = {}
  if (data.name) transformed.title = toTitleCase(data.name)
  if (data.description && typeof data.description === 'string')
    transformed.description = data.description
      .replace(/<[^>]+>/g, '')
      .replace(/\\\\n/g, '\n')

  const badgeVariant: Record<DefinitionType, string> = {
    skill: 'tip',
    agent: 'note',
    command: 'caution',
  }
  transformed.sidebar = {
    badge: {
      text: definitionType.charAt(0).toUpperCase() + definitionType.slice(1),
      variant: badgeVariant[definitionType],
    },
  }

  return transformed
}
```

**Step 3: Update name computation and call site in `processDirectory`**

In the `processDirectory` for-loop, find `const name = data.name ?? path.basename(file, '.md')`. Replace with type-aware fallback (skills use `SKILL.md` so `path.basename` returns `"SKILL"` — use directory name instead):

```ts
const name =
  data.name ??
  (definitionType === 'skill'
    ? path.basename(path.dirname(file))
    : path.basename(file, '.md'))
```

Then find `const frontmatter = transformFrontmatter({ ...data, name })` and change to:
```ts
const frontmatter = transformFrontmatter({ ...data, name }, definitionType)
```

**Step 4: Update the three `processDirectory` calls**

Find the three `processDirectory(` calls at the bottom of the file (after `console.log('Generating reference documentation...')`) and change to:
```ts
const skillsCount = processDirectory(
  path.join(PROJECT_ROOT, 'skills'),
  'skills',
  'skill',
  /SKILL\.md$/,
)
const agentsCount = processDirectory(
  path.join(PROJECT_ROOT, 'agents'),
  'agents',
  'agent',
)
const commandsCount = processDirectory(
  path.join(PROJECT_ROOT, 'commands'),
  'commands',
  'command',
)
```

**Step 5: Verify**

Run: `bun run docs:generate`

```bash
head -10 docs/src/content/docs/reference/skills/agent-browser.md
# Expected frontmatter includes:
#   sidebar:
#     badge:
#       text: Skill
#       variant: tip

head -10 docs/src/content/docs/reference/agents/architecture-strategist.md
# Expected: badge text "Agent", variant "note"

head -10 docs/src/content/docs/reference/commands/workflows-brainstorm.md
# Expected: badge text "Command", variant "caution"
```

**Step 6: Commit**

```bash
git add docs/scripts/transform-content.ts
git commit -m "docs: add sidebar badges for definition types"
```

---

### Task 3: Definition header with source link and category

**Files:**
- Modify: `docs/scripts/transform-content.ts` (functions: `generatePage`, `processDirectory`, plus new `GITHUB_BASE` constant and `generateDefinitionHeader` function)

**Step 1: Add `GITHUB_BASE` constant and `generateDefinitionHeader` function**

Insert after the `OUTPUT_DIR` constant:
```ts
const GITHUB_BASE = 'https://github.com/marcusrbrown/systematic/blob/main'
```

Insert before the `processDirectory` function:
```ts
function generateDefinitionHeader(options: {
  category?: string
  sourcePath: string
}): string {
  const githubUrl = `${GITHUB_BASE}/${options.sourcePath}`
  const parts: string[] = []

  if (options.category != null) {
    parts.push(
      `<span class="definition-category">${options.category}</span>`,
    )
  }
  parts.push(
    `<a class="definition-source" href="${githubUrl}">View source</a>`,
  )

  return `<div class="definition-header not-content">\n${parts.map((p) => `  ${p}`).join('\n')}\n</div>\n`
}
```

**Step 2: Update `generatePage` to accept and prepend the header**

Change the `generatePage` function to:
```ts
function generatePage(
  frontmatter: Record<string, unknown>,
  body: string,
  header: string,
): string {
  const fm = yaml.dump(frontmatter, { lineWidth: -1 }).trim()
  const cleanedBody = body.replace(/\n{3,}/g, '\n\n').trim()
  return `---\n${fm}\n---\n\n${header}\n${cleanedBody}`
}
```

**Step 3: Compute source path and category in the processing loop**

Inside `processDirectory`, after the `name` computation, add:
```ts
const sourcePath = path.relative(PROJECT_ROOT, file).split(path.sep).join('/')
const category =
  definitionType === 'agent'
    ? path.basename(path.dirname(file)).charAt(0).toUpperCase() +
      path.basename(path.dirname(file)).slice(1)
    : undefined
const header = generateDefinitionHeader({ category, sourcePath })
```

Update the `generatePage` call (find `const mdx = generatePage(frontmatter, body)`) from:
```ts
const mdx = generatePage(frontmatter, body)
```
to:
```ts
const mdx = generatePage(frontmatter, body, header)
```

**Step 4: Verify**

Run: `bun run docs:generate`

```bash
head -20 docs/src/content/docs/reference/agents/architecture-strategist.md
# Expected: <div class="definition-header not-content"> with category "Review" and GitHub link

head -20 docs/src/content/docs/reference/skills/agent-browser.md
# Expected: <div class="definition-header not-content"> with source link, NO category

head -20 docs/src/content/docs/reference/commands/workflows-brainstorm.md
# Expected: source link pointing to commands/workflows/brainstorm.md
```

**Step 5: Commit**

```bash
git add docs/scripts/transform-content.ts
git commit -m "docs: add definition header with source link and category"
```

---

### Task 4: CSS for definition header

**Files:**
- Modify: `docs/src/styles/custom.css`

**Step 1: Append definition header styles**

Add after the `[data-theme="light"]` block at the end of the file:

```css
/* Definition header for reference pages */
.definition-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--sl-color-gray-5);
  font-size: var(--sl-text-sm);
}

.definition-category {
  font-size: var(--sl-text-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: var(--sl-color-gray-5);
  color: var(--sl-color-white);
  padding: 0.125rem 0.5rem;
  border-radius: 0.25rem;
}

.definition-source {
  margin-left: auto;
  color: var(--sl-color-gray-3);
  text-decoration: none;
  font-size: var(--sl-text-xs);
}

.definition-source:hover {
  color: var(--sl-color-accent);
}
```

**Step 2: Verify**

Run: `bun run docs:generate && bun run docs:build`

Expected: both succeed, zero errors.

**Step 3: Commit**

```bash
git add docs/src/styles/custom.css
git commit -m "docs: add CSS for definition headers"
```

---

### Task 5: Full verification

**Step 1: Run the full pipeline**

```bash
bun run docs:generate && bun run docs:build
```

Expected: both succeed.

**Step 2: Spot-check one of each type**

```bash
head -25 docs/src/content/docs/reference/skills/brainstorming.md
head -25 docs/src/content/docs/reference/agents/security-sentinel.md
head -25 docs/src/content/docs/reference/commands/workflows-brainstorm.md
```

Verify each has:
- [x] Title Case title in frontmatter
- [x] Sidebar badge (text + variant)
- [x] `<div class="definition-header not-content">` block
- [x] GitHub "View source" link
- [x] Agent pages have category span
- [x] Body content is intact (not truncated or mangled)

**Step 3: Visual verification**

Run: `bun run docs:dev`

Open in browser and check one of each type:
- A skill page (e.g., `/systematic/reference/skills/agent-browser/`)
- An agent page (e.g., `/systematic/reference/agents/architecture-strategist/`)
- A command page (e.g., `/systematic/reference/commands/workflows-brainstorm/`)

Verify visually:
- [x] Title Case heading renders in the page and sidebar
- [x] Sidebar badge appears next to the page title in navigation
- [x] Definition header bar renders below the title with correct styling
- [x] "View source" link is present and clickable (opens correct GitHub URL)
- [x] Agent pages show category pill (e.g., "REVIEW")
- [x] Skill/command pages do NOT show a category pill
- [x] Body content below the header is intact and readable

**Step 4: Run project-level checks**

```bash
bun run typecheck
bun run lint
```

Expected: no new errors.

**Step 5: Commit (if any fixups needed)**

```bash
git add -A && git commit -m "docs: reference section refresh — final fixups"
```

---

### Expected outcome

A generated reference page (e.g., `agent-browser`) should look like:

```markdown
---
title: Agent Browser
description: Browser automation using Vercel's agent-browser CLI...
sidebar:
  badge:
    text: Skill
    variant: tip
---

<div class="definition-header not-content">
  <a class="definition-source" href="https://github.com/marcusrbrown/systematic/blob/main/skills/agent-browser/SKILL.md">View source</a>
</div>

# agent-browser: CLI Browser Automation
...
```

An agent page (e.g., `architecture-strategist`) adds the category:

```markdown
<div class="definition-header not-content">
  <span class="definition-category">Review</span>
  <a class="definition-source" href="https://github.com/marcusrbrown/systematic/blob/main/agents/review/architecture-strategist.md">View source</a>
</div>
```
