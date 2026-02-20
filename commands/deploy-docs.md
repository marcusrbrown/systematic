---
name: deploy-docs
description: Validate and prepare Systematic documentation for GitHub Pages deployment
disable-model-invocation: true
---

# Deploy Documentation Command

Validate the Systematic Starlight/Astro documentation site and prepare it for GitHub Pages deployment.

## Step 1: Validate Documentation

Run these checks:

```bash
# Count bundled assets
echo "Agents: $(ls agents/*/*.md | wc -l)"
echo "Commands: $(ls commands/*.md commands/workflows/*.md | wc -l)"
echo "Skills: $(ls -d skills/*/ 2>/dev/null | wc -l)"

# Verify CLI listings (review output for expected entries)
bun src/cli.ts list agents
bun src/cli.ts list skills
bun src/cli.ts list commands

# Build docs (runs docs:generate + Astro build)
bun run docs:build

# Check Astro output
test -f docs/dist/index.html && echo "✓ docs/dist/index.html present"
```

## Step 2: Check for Uncommitted Changes

```bash
git status --porcelain docs/
```

If there are uncommitted changes, warn the user to commit first.

## Step 3: Deployment Instructions

Since GitHub Pages deployment requires a workflow file with special permissions, provide these instructions:

### First-time Setup

1. Create `.github/workflows/deploy-docs.yml` with the GitHub Pages workflow
2. Go to repository Settings > Pages
3. Set Source to "GitHub Actions"

### Deploying

After merging to `main`, the docs will auto-deploy. Or:

1. Go to Actions tab
2. Select "Deploy Documentation to GitHub Pages"
3. Click "Run workflow"

### Workflow File Content

```yaml
name: Deploy Documentation to GitHub Pages

on:
  push:
    branches: [main]
    paths:
      - 'docs/**'
      - 'docs/scripts/**'
      - 'agents/**'
      - 'skills/**'
      - 'commands/**'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.1.0'
      - run: bun install
      - run: bun run docs:build
      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: 'docs/dist'
      - uses: actions/deploy-pages@v4
```

## Step 4: Report Status

Provide a summary:

```
## Deployment Readiness

✓ Starlight/Astro build succeeded
✓ Bundled asset counts match expectations
✓ CLI listings verified

### Next Steps
- [ ] Commit any pending changes
- [ ] Push to main branch
- [ ] Verify GitHub Pages workflow exists
- [ ] Check deployment at https://fro.bot/systematic (or your configured base URL)
```
