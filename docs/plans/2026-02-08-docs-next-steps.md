# Docs Next Steps Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Tighten docs generation, harden docs deployment, add docs CI checks, and polish reference navigation.

**Architecture:** Keep changes scoped to the docs generator script, GitHub Actions workflows, and Starlight content. Prefer small, targeted edits with explicit guards for deploy safety and deterministic docs ordering.

**Tech Stack:** Bun, TypeScript, Astro Starlight, GitHub Actions

---

### Task 1: Tighten docs generator logging and slug handling

**Files:**
- Modify: `docs/scripts/transform-content.ts`

**Step 1: Write the failing test**

No existing unit-test harness for the docs script. Instead, use a smoke-run to validate behavior.

**Step 2: Run test to verify it fails (current behavior)**

Run: `bun run docs:generate`
Expected: Success, but note that frontmatter errors log an error message without the file path.

**Step 3: Write minimal implementation**

Update error logging to include the actual file path and treat slug collisions as hard errors to prevent silent overwrites.

Implementation sketch:
```ts
} catch (error) {
  console.warn(`⚠️  Failed to parse frontmatter in: ${file}`, error)
  return { data: {}, body: match[2] }
}

if (existingFile != null) {
  console.error(
    `✗ Slug collision: "${slug}" from ${file} overwrites ${existingFile}`,
  )
  process.exitCode = 1
  continue
}
```

**Step 4: Run test to verify it passes**

Run: `bun run docs:generate`
Expected: Success with improved logging; any slug collision now fails the run.

**Step 5: Commit**

```bash
git add docs/scripts/transform-content.ts
git commit -m "docs: harden reference content generation"
```

### Task 2: Harden docs deployment safety

**Files:**
- Modify: `.github/workflows/docs.yaml`

**Step 1: Write the failing test**

No automated CI test for workflow behavior. Use a manual logic review and a dry run mental check.

**Step 2: Run test to verify it fails (current behavior)**

Observation: deploy steps run unconditionally on main, even in forks without secrets.

**Step 3: Write minimal implementation**

Add repository guards to the GitHub App token and deploy steps so forks can build without trying to deploy.

Implementation sketch:
```yaml
      - name: Create GitHub App token
        if: github.repository == 'marcusrbrown/systematic'

      - name: Deploy to fro-bot/systematic
        if: github.repository == 'marcusrbrown/systematic'
```

Optional safety: preserve `CNAME` if present in the deploy repo by copying it before deletion and restoring afterward.

**Step 4: Run test to verify it passes**

Manual check: workflow should still build docs, and only deploy on the canonical repository.

**Step 5: Commit**

```bash
git add .github/workflows/docs.yaml
git commit -m "ci(docs): guard deploy steps for forks"
```

### Task 3: Add docs build health checks in main CI

**Files:**
- Modify: `.github/workflows/main.yaml`

**Step 1: Write the failing test**

No test file required; add a CI job that runs the docs build.

**Step 2: Run test to verify it fails (current behavior)**

Observation: main CI does not build docs at all.

**Step 3: Write minimal implementation**

Add a `docs` job that runs `bun run docs:build` with standard setup.

Implementation sketch:
```yaml
  docs:
    name: Docs Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@...
      - name: Setup Bun
        uses: oven-sh/setup-bun@...
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Build docs
        run: bun run docs:build
```

**Step 4: Run test to verify it passes**

Local: `bun run docs:build`
Expected: successful docs build.

**Step 5: Commit**

```bash
git add .github/workflows/main.yaml
git commit -m "ci: add docs build check"
```

### Task 4: Polish docs navigation and reference overview pages

**Files:**
- Modify: `docs/src/content/docs/guides/architecture.mdx`
- Modify: `docs/src/content/docs/guides/conversion-guide.mdx`
- Modify: `docs/src/content/docs/guides/creating-skills.mdx`
- Create: `docs/src/content/docs/reference/skills/index.mdx`
- Create: `docs/src/content/docs/reference/agents/index.mdx`
- Create: `docs/src/content/docs/reference/commands/index.mdx`

**Step 1: Write the failing test**

No automated tests for sidebar order. Use a docs build to validate frontmatter and navigation.

**Step 2: Run test to verify it fails (current behavior)**

Observation: reference sections have no overview landing pages; guides have no explicit ordering.

**Step 3: Write minimal implementation**

- Add `sidebar.order` to the guides to make ordering deterministic.
- Add index pages for reference sections with a short description and links.

Example frontmatter:
```md
---
title: Skills Reference
description: Bundled Systematic skills and when to use them.
sidebar:
  order: 1
---
```

**Step 4: Run test to verify it passes**

Run: `bun run docs:build`
Expected: build succeeds and navigation includes the new index pages.

**Step 5: Commit**

```bash
git add docs/src/content/docs/guides/*.mdx docs/src/content/docs/reference/*/index.mdx
git commit -m "docs: add reference landing pages and order guides"
```

---

### Final Verification

Run these after all tasks:

- `bun run docs:generate`
- `bun run docs:build`

Expected: both succeed without warnings or errors.
