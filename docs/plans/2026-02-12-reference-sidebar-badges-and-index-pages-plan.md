# Reference Sidebar Badges & Index Pages — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace redundant definition-type sidebar badges with meaningful metadata (category for agents, remove for skills/commands) and upgrade the three reference index pages from plain text to visually engaging LinkCard grids.

**Architecture:** Modify the docs generator (`docs/scripts/transform-content.ts`) to emit category-based sidebar badges for agents only, and rewrite the three hand-authored index pages (`index.mdx`) to use Starlight's `LinkCard` + `CardGrid` components populated with definition listings.

**Tech Stack:** Bun, TypeScript, Starlight 0.37 (LinkCard, CardGrid), MDX

**Prior work:** `docs/plans/2026-02-12-reference-section-refresh.md` — the plan that introduced the current badges and headers.

---

### Task 1: Replace sidebar badges — agents get category, others get none

**Files:**
- Modify: `docs/scripts/transform-content.ts` (function: `transformFrontmatter`)

**Step 1: Update `transformFrontmatter` to accept category and conditionally emit badge**

Change the `transformFrontmatter` function signature and body. The current code unconditionally emits a badge based on `definitionType`. Change to: only emit a sidebar badge for agents, using their category.

Current:
```ts
function transformFrontmatter(
  data: Frontmatter,
  definitionType: DefinitionType,
): Record<string, unknown> {
  // ...
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

Change to:
```ts
function transformFrontmatter(
  data: Frontmatter,
  definitionType: DefinitionType,
  category?: string,
): Record<string, unknown> {
  // ... (title and description unchanged)

  if (category != null) {
    const categoryVariant: Record<string, string> = {
      review: 'note',
      research: 'success',
      design: 'tip',
      workflow: 'caution',
    }
    transformed.sidebar = {
      badge: {
        text: category,
        variant: categoryVariant[category.toLowerCase()] ?? 'default',
      },
    }
  }

  return transformed
}
```

**Step 2: Reorder and pass `category` to `transformFrontmatter` in `processDirectory` loop**

In the current `processDirectory` loop, `const category = deriveCategory(file, definitionType)` is computed on line 198 — **after** the `transformFrontmatter(...)` call on lines 190–193. Move the `category` computation **above** the `transformFrontmatter` call so the variable is available as the third argument. The resulting order should be:

```ts
const name = deriveName(data, file, definitionType)
const category = deriveCategory(file, definitionType)
const frontmatter = transformFrontmatter(
  { ...data, name },
  definitionType,
  category,
)
const sourcePath = path
  .relative(PROJECT_ROOT, file)
  .split(path.sep)
  .join('/')
const header = generateDefinitionHeader({ category, sourcePath })
const mdx = generatePage(frontmatter, body, header)
```

This keeps a single `category` declaration, reused for both `transformFrontmatter` and `generateDefinitionHeader`.

**Step 3: Verify**

Run: `bun run docs:generate`

Spot-check:
```bash
head -10 docs/src/content/docs/reference/agents/architecture-strategist.md
# Expected: sidebar badge text "Review", variant "note"

head -10 docs/src/content/docs/reference/skills/agent-browser.md
# Expected: NO sidebar badge at all

head -10 docs/src/content/docs/reference/commands/workflows-brainstorm.md
# Expected: NO sidebar badge at all
```

**Step 4: Commit**

```bash
git add docs/scripts/transform-content.ts
git commit -m "docs: replace type badges with category badges for agents only"
```

---

### Task 2: Rewrite skills index page with LinkCard grid

**Files:**
- Modify: `docs/src/content/docs/reference/skills/index.mdx`

**Step 1: Rewrite with CardGrid + LinkCard**

Replace the entire file with a CardGrid of LinkCards listing all 11 skills. Use the skill's title as the card title and a short excerpt of the description. The `href` for each card uses Starlight's relative path format with trailing slash.

```mdx
---
title: Skills Reference
description: Bundled Systematic skills and when to use them.
sidebar:
  order: 1
---

import { CardGrid, LinkCard } from '@astrojs/starlight/components';

Skills provide specialized knowledge and step-by-step guidance for specific tasks. They are loaded on demand and inject detailed instructions into the conversation.

<CardGrid>
  <LinkCard title="Agent Browser" description="Browser automation using Vercel's agent-browser CLI." href="/systematic/reference/skills/agent-browser/" />
  <LinkCard title="Agent Native Architecture" description="Build applications where agents are first-class citizens." href="/systematic/reference/skills/agent-native-architecture/" />
  <LinkCard title="Brainstorming" description="Explore user intent, approaches, and design decisions before planning." href="/systematic/reference/skills/brainstorming/" />
  <LinkCard title="Compound Docs" description="Compound documentation patterns and conventions." href="/systematic/reference/skills/compound-docs/" />
  <LinkCard title="Create Agent Skills" description="Expert guidance for creating OpenCode skills and slash commands." href="/systematic/reference/skills/create-agent-skills/" />
  <LinkCard title="Document Review" description="Refine brainstorm or plan documents before proceeding." href="/systematic/reference/skills/document-review/" />
  <LinkCard title="File Todos" description="Track and manage file-level todo items." href="/systematic/reference/skills/file-todos/" />
  <LinkCard title="Frontend Design" description="Create distinctive, production-grade frontend interfaces." href="/systematic/reference/skills/frontend-design/" />
  <LinkCard title="Git Worktree" description="Manage Git worktrees for isolated parallel development." href="/systematic/reference/skills/git-worktree/" />
  <LinkCard title="Orchestrating Swarms" description="Coordinate parallel agent execution patterns." href="/systematic/reference/skills/orchestrating-swarms/" />
  <LinkCard title="Using Systematic" description="How to find and use skills before any response or action." href="/systematic/reference/skills/using-systematic/" />
</CardGrid>
```

**Step 2: Verify**

Run: `bun run docs:build` — must succeed with no errors.

Visual check: `bun run docs:dev` and navigate to `/systematic/reference/skills/`. Expected: 2-column card grid with skill names, descriptions, and arrow links.

**Step 3: Commit**

```bash
git add docs/src/content/docs/reference/skills/index.mdx
git commit -m "docs: upgrade skills index to LinkCard grid"
```

---

### Task 3: Rewrite agents index page with categorized LinkCard grids

**Files:**
- Modify: `docs/src/content/docs/reference/agents/index.mdx`

**Step 1: Rewrite with category sections and CardGrid + LinkCard**

Group agents by category (Review, Research, Design, Workflow) with headings. Each category gets its own CardGrid.

```mdx
---
title: Agents Reference
description: Bundled Systematic agents and their review focus areas.
sidebar:
  order: 1
---

import { CardGrid, LinkCard } from '@astrojs/starlight/components';

Agents are specialized for specific review, research, or workflow tasks. They can be invoked by @mention or via commands.

## Review

<CardGrid>
  <LinkCard title="Agent Native Reviewer" description="Review code for agent-native architecture patterns." href="/systematic/reference/agents/agent-native-reviewer/" />
  <LinkCard title="Architecture Strategist" description="Analyze code changes for pattern compliance and design integrity." href="/systematic/reference/agents/architecture-strategist/" />
  <LinkCard title="Code Simplicity Reviewer" description="Review code for unnecessary complexity." href="/systematic/reference/agents/code-simplicity-reviewer/" />
  <LinkCard title="Data Integrity Guardian" description="Validate data consistency and integrity constraints." href="/systematic/reference/agents/data-integrity-guardian/" />
  <LinkCard title="Data Migration Expert" description="Review and guide data migration strategies." href="/systematic/reference/agents/data-migration-expert/" />
  <LinkCard title="Deployment Verification Agent" description="Verify deployment readiness and configuration." href="/systematic/reference/agents/deployment-verification-agent/" />
  <LinkCard title="DHH Rails Reviewer" description="Brutally honest Rails code review from DHH's perspective." href="/systematic/reference/agents/dhh-rails-reviewer/" />
  <LinkCard title="Kieran Rails Reviewer" description="Rails-focused code review for conventions and quality." href="/systematic/reference/agents/kieran-rails-reviewer/" />
  <LinkCard title="Kieran TypeScript Reviewer" description="TypeScript code review for type safety and patterns." href="/systematic/reference/agents/kieran-typescript-reviewer/" />
  <LinkCard title="Pattern Recognition Specialist" description="Identify recurring patterns and anti-patterns in code." href="/systematic/reference/agents/pattern-recognition-specialist/" />
  <LinkCard title="Performance Oracle" description="Analyze and optimize performance-critical code paths." href="/systematic/reference/agents/performance-oracle/" />
  <LinkCard title="Security Sentinel" description="Security audits for vulnerabilities and OWASP compliance." href="/systematic/reference/agents/security-sentinel/" />
</CardGrid>

## Research

<CardGrid>
  <LinkCard title="Best Practices Researcher" description="Research external best practices and documentation." href="/systematic/reference/agents/best-practices-researcher/" />
  <LinkCard title="Framework Docs Researcher" description="Find framework-specific documentation and examples." href="/systematic/reference/agents/framework-docs-researcher/" />
  <LinkCard title="Git History Analyzer" description="Analyze git history for context and patterns." href="/systematic/reference/agents/git-history-analyzer/" />
  <LinkCard title="Learnings Researcher" description="Search documented solutions and institutional knowledge." href="/systematic/reference/agents/learnings-researcher/" />
  <LinkCard title="Repo Research Analyst" description="Analyze repository structure, patterns, and conventions." href="/systematic/reference/agents/repo-research-analyst/" />
</CardGrid>

## Design

<CardGrid>
  <LinkCard title="Design Implementation Reviewer" description="Compare implementation against design specifications." href="/systematic/reference/agents/design-implementation-reviewer/" />
  <LinkCard title="Design Iterator" description="Iteratively refine UI through screenshot-analyze-improve cycles." href="/systematic/reference/agents/design-iterator/" />
  <LinkCard title="Figma Design Sync" description="Sync and compare Figma designs with implementation." href="/systematic/reference/agents/figma-design-sync/" />
</CardGrid>

## Workflow

<CardGrid>
  <LinkCard title="Bug Reproduction Validator" description="Validate bug reproduction steps and environment." href="/systematic/reference/agents/bug-reproduction-validator/" />
  <LinkCard title="Lint" description="Run linting and code quality checks." href="/systematic/reference/agents/lint/" />
  <LinkCard title="PR Comment Resolver" description="Address and resolve pull request review comments." href="/systematic/reference/agents/pr-comment-resolver/" />
  <LinkCard title="Spec Flow Analyzer" description="Validate feature specifications and identify gaps." href="/systematic/reference/agents/spec-flow-analyzer/" />
</CardGrid>
```

**Step 2: Verify**

Run: `bun run docs:build` — must succeed.

Visual check: `bun run docs:dev` and navigate to `/systematic/reference/agents/`. Expected: category headings with card grids under each.

**Step 3: Commit**

```bash
git add docs/src/content/docs/reference/agents/index.mdx
git commit -m "docs: upgrade agents index to categorized LinkCard grid"
```

---

### Task 4: Rewrite commands index page with LinkCard grid

**Files:**
- Modify: `docs/src/content/docs/reference/commands/index.mdx`

**Step 1: Rewrite with CardGrid + LinkCard**

Group commands into "Workflow" commands (the `workflows:*` prefixed ones) and "Utility" commands.

```mdx
---
title: Commands Reference
description: Bundled Systematic commands and the workflows they trigger.
sidebar:
  order: 1
---

import { CardGrid, LinkCard } from '@astrojs/starlight/components';

Slash commands ship with Systematic and trigger structured engineering workflows. Use these references to learn each command's purpose and expected usage.

## Workflows

<CardGrid>
  <LinkCard title="Workflows: Brainstorm" description="Explore requirements through collaborative dialogue." href="/systematic/reference/commands/workflows-brainstorm/" />
  <LinkCard title="Workflows: Compound" description="Full compound engineering workflow." href="/systematic/reference/commands/workflows-compound/" />
  <LinkCard title="Workflows: Plan" description="Create implementation plans from feature descriptions." href="/systematic/reference/commands/workflows-plan/" />
  <LinkCard title="Workflows: Review" description="Review code changes for quality and correctness." href="/systematic/reference/commands/workflows-review/" />
  <LinkCard title="Workflows: Work" description="Execute a work plan with tracking and verification." href="/systematic/reference/commands/workflows-work/" />
</CardGrid>

## Utilities

<CardGrid>
  <LinkCard title="Agent Native Audit" description="Audit codebase for agent-native architecture patterns." href="/systematic/reference/commands/agent-native-audit/" />
  <LinkCard title="Create Agent Skill" description="Create or edit skills with expert guidance." href="/systematic/reference/commands/create-agent-skill/" />
  <LinkCard title="Deepen Plan" description="Enhance plan sections with parallel research agents." href="/systematic/reference/commands/deepen-plan/" />
  <LinkCard title="LFG" description="Full autonomous engineering workflow." href="/systematic/reference/commands/lfg/" />
</CardGrid>
```

**Step 2: Verify**

Run: `bun run docs:build` — must succeed.

Visual check: `bun run docs:dev` and navigate to `/systematic/reference/commands/`. Expected: Workflow and Utility sections with card grids.

**Step 3: Commit**

```bash
git add docs/src/content/docs/reference/commands/index.mdx
git commit -m "docs: upgrade commands index to categorized LinkCard grid"
```

---

### Task 5: Full verification

**Step 1: Run the full pipeline**

```bash
bun run docs:generate && bun run docs:build
```

Expected: both succeed, zero errors.

**Step 2: Deterministic checks**

```bash
  # Verify NO sidebar key in skills/commands frontmatter
  grep -l "^sidebar:" docs/src/content/docs/reference/skills/*.md docs/src/content/docs/reference/commands/*.md || true
  # Expected: NO output (zero matches). If any files listed, sidebar was not removed.
  # Check output, not exit code — empty output means success.

  # Verify ALL agent pages HAVE sidebar badges
  grep -L "^sidebar:" docs/src/content/docs/reference/agents/*.md || true
  # Expected: NO output (every agent file contains sidebar:)
  # Check output, not exit code — empty output means all files have sidebar:

  # Count agents per category badge
  grep -h "^    text:" docs/src/content/docs/reference/agents/*.md | sort | uniq -c
  # Expected: 12 Review, 5 Research, 3 Design, 4 Workflow (24 total)
  # The "^    text:" pattern (4-space indent) anchors to the YAML sidebar badge, avoiding false matches in body content
```

**Step 3: Spot-check sidebar badges**

```bash
head -10 docs/src/content/docs/reference/agents/architecture-strategist.md
# Expected: sidebar badge text "Review", variant "note"

head -10 docs/src/content/docs/reference/agents/design-iterator.md
# Expected: sidebar badge text "Design", variant "tip"

head -10 docs/src/content/docs/reference/skills/agent-browser.md
# Expected: NO sidebar key in frontmatter

head -10 docs/src/content/docs/reference/commands/workflows-brainstorm.md
# Expected: NO sidebar key in frontmatter
```

**Step 4: Visual verification**

Run: `bun run docs:dev`

Open in browser and check:
- [ ] `/systematic/reference/skills/` — Card grid with all 11 skills
- [ ] `/systematic/reference/agents/` — Category headings (Review, Research, Design, Workflow) with card grids
- [ ] `/systematic/reference/commands/` — Workflow and Utility sections with card grids
- [ ] Agent sidebar entries show category badges (Review, Research, Design, Workflow)
- [ ] Skill sidebar entries have NO badges
- [ ] Command sidebar entries have NO badges
- [ ] LinkCards link to correct pages and show descriptions
- [ ] Card grids are responsive (2 columns on desktop, 1 on mobile)

**Step 5: Run project-level checks**

```bash
bun run typecheck
bun run lint
```

Expected: no new errors.

**Step 6: Commit (if any fixups needed)**

```bash
git add -A && git commit -m "docs: reference sidebar badges and index pages — final fixups"
```

---

### Expected outcome

**Sidebar badges — before vs after:**

| Definition type | Before | After |
|-----------------|--------|-------|
| Skills | "Skill" badge (purple) | No badge |
| Agents | "Agent" badge (blue) | Category badge: "Review" / "Research" / "Design" / "Workflow" |
| Commands | "Command" badge (orange) | No badge |

**Index pages — before vs after:**

| Page | Before | After |
|------|--------|-------|
| Skills index | 2-line paragraph | CardGrid with 11 LinkCards |
| Agents index | 2-line paragraph | 4 category sections, each with CardGrid of LinkCards |
| Commands index | 2-line paragraph | 2 sections (Workflows + Utilities) with CardGrid of LinkCards |

---

### Execution Status

- [x] **Task 1**: Sidebar badges — agents get category, others get none
- [x] **Tasks 2–4 (superseded)**: Index pages are now **dynamically generated** by `transform-content.ts` from the same enumerated definition entries, rather than hand-authored as originally planned. The generator collects `DefinitionEntry` metadata during `processDirectory`, then calls `generateIndexPage()` to emit `index.mdx` with `CardGrid`/`LinkCard` components.
- [x] **Task 5**: Full verification — typecheck, lint, build, deterministic grep checks, and visual verification with `agent-browser` all pass.
