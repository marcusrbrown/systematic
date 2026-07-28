---
title: Vendor an npm-packaged upstream skill as a generated, drift-guarded artifact
date: 2026-07-28
category: best-practices
module: scripts/generate-agent-browser-skill.ts
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - Vendoring an upstream skill or asset that ships inside its npm tarball
  - The upstream was previously hand-copied with no version pin or provenance
  - The project already uses a generate-and-drift CI gate for other artifacts
  - Renovate manages the project's npm dependencies
  - The vendored file needs only a deterministic transform on copy
related_components:
  - development_workflow
  - documentation
tags:
  - vendored-skill
  - npm-codegen
  - renovate
  - drift-gate
  - node-modules-source
  - attribution-sync
  - devdependency-pin
---

# Vendor an npm-packaged upstream skill as a generated, drift-guarded artifact

## Context

When an upstream project ships a skill, agent prompt, or other Markdown asset _inside its npm tarball_, you can vendor it so version bumps are fully automatic: Renovate tracks the dependency natively, a generator copies the asset out of `node_modules`, a CI drift gate rejects any commit where the checked-in file diverges from the pinned package, and a Renovate `postUpgradeTasks` block lands the regenerated content in the bump PR itself.

`agent-browser` in Systematic is the reference implementation. `vercel-labs/agent-browser` (Apache-2.0) ships `skills/agent-browser/SKILL.md` in its npm tarball, so the pinned dependency _is_ the source of truth — no network fetch, no `npx`, no fetch-at-tag.

This is the automatic counterpart to the manual model in [`third-party-bundled-skills-light-adaptation`](./third-party-bundled-skills-light-adaptation-2026-05-17.md): that pattern is for hand-adapted content (e.g. `obra/superpowers`) that needs human review on each refresh. This pattern is for content that needs only a deterministic, mechanical transform — so the whole refresh can be automated and gated.

## Guidance

### 1. Pin the upstream package as an exact devDependency

```json
{ "devDependencies": { "agent-browser": "0.33.0" } }
```

The exact pin (no `^`/`~`) makes Renovate's native npm manager track it — no `customManager` needed. Tracking a version string embedded in Markdown would require one; a real dependency does not.

### 2. Regeneration = copy from `node_modules` (the pinned dep is the source)

```ts
// The SINGLE source of truth for the pinned version is package.json
// devDependencies["agent-browser"] — NOT node_modules, NOT hardcoded.
const SOURCE_PATH = path.join(
  PROJECT_ROOT, 'node_modules', 'agent-browser', 'skills', 'agent-browser', 'SKILL.md',
)
```

The only transform is stripping `hidden: true` from the frontmatter (upstream hides the skill in its own discovery model; Systematic ships it as a visible catalog skill):

```ts
export function stripHiddenFromFrontmatter(content: string): string {
  const FRONTMATTER_REGEX = /^---\n([\s\S]*?\n)---\n/
  const match = content.match(FRONTMATTER_REGEX)
  if (match === null) return content
  const frontmatter = match[1] ?? ''
  const rest = content.slice(match[0].length)
  const cleaned = frontmatter.split('\n')
    .filter((line) => !/^hidden:\s+true\s*$/.test(line))
    .join('\n')
  return `---\n${cleaned}---\n${rest}`
}
```

### 3. The drift gate is not circular

The gate runs `generate --check`: it regenerates the expected output in memory and compares it to the committed file (CRLF and trailing whitespace normalized), sitting alongside the sibling drift checks:

```yaml
- name: agent-browser skill drift check
  run: bun run agent-browser:drift
- name: Registry drift check
  run: bun run registry:drift
- name: Schema drift check
  run: bun run schema:drift
```

Renovate and the gate check independent invariants: Renovate signals _"upstream released a new version"_; the drift gate guarantees _"what is committed matches what the pinned version produces."_ Neither substitutes for the other. This mirrors the [registry drift](../workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md) and [content-integrity](./content-integrity-mirror-runtime-drop-rules-2026-05-17.md) discipline already in the repo.

### 4. Sync attribution to close the silent-staleness case

The subtle, high-value part: a thin stub often stays byte-identical across bumps. Without a second signal, a version bump would pass the `SKILL.md` drift check while `ATTRIBUTIONS.md` still cited the old version. The generator syncs the attribution version references too, from `package.json` (not `node_modules`):

```ts
export function applyVersionToAttributions(content: string, version: string): string {
  // ...locate the `## vercel-labs/agent-browser — Apache-2.0` section...
  const updatedSection = section
    .replace(/`v\d+\.\d+\.\d+`/g, `\`v${version}\``)
    .replace(/`agent-browser@\d+\.\d+\.\d+`/g, `\`agent-browser@${version}\``)
  // ...splice updatedSection back into content and return...
}
```

So a version bump with a byte-identical stub _still fails_ the drift check until the attribution is regenerated. Verified: bumping the pin to a new version without reinstalling (identical stub) makes `agent-browser:drift` exit 1 on the stale attribution reference.

### 5. Regenerate in the Renovate PR

```json5
postUpgradeTasks: {
  // Regenerates the stub from the pinned package so a bump lands the new stub
  // in the same Renovate PR. If the runner's allowlist blocks the command,
  // the CI agent-browser:drift gate is the backstop.
  commands: ['bun install', 'bun run agent-browser:build', 'bun run fix'],
  executionMode: 'branch',
}
```

`bun install` must come first to populate `node_modules` at the new version. The two-layer design (postUpgradeTasks + CI gate) means neither layer is a single point of failure.

## Why This Matters

Every alternative has a failure mode this closes:

- **Version string in Markdown** — needs a Renovate `customManager`, and does not guarantee the generated file is regenerated; drift goes unnoticed until a human sees it.
- **CDN/URL fetch in CI** — a network dependency in the gate; no guarantee the fetched content matches the installed version.
- **Manual refresh** — relies on someone remembering; attribution references rot silently.

The npm-devDependency approach makes the bump a first-class dependency event, reproducible via the lockfile, automated by existing Renovate, and drift-guaranteed across both artifacts.

## When to Apply

**Apply when** the upstream asset ships in its npm tarball, needs only a deterministic transform (or none), and should refresh automatically on dependency bumps with a CI backstop.

**Do not apply when** upstream delivers only via CLI output, URL, or git clone (not in the tarball), or when the asset requires human review on every bump — use the manual [light-adaptation model](./third-party-bundled-skills-light-adaptation-2026-05-17.md) instead.

## Related

- [`third-party-bundled-skills-light-adaptation-2026-05-17.md`](./third-party-bundled-skills-light-adaptation-2026-05-17.md) — the manual, hand-adapted counterpart to this automatic pattern
- [`registry-drift-on-skill-description-change-2026-05-20.md`](../workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md) — the sibling generate-and-drift gate
- [`content-integrity-mirror-runtime-drop-rules-2026-05-17.md`](./content-integrity-mirror-runtime-drop-rules-2026-05-17.md) — a gate is only trustworthy when it models what it protects
- [`unguarded-generator-main-repairs-drift-when-imported-by-tests-2026-07-28.md`](../test-failures/unguarded-generator-main-repairs-drift-when-imported-by-tests-2026-07-28.md) — the entrypoint-guard bug found while unit-testing this generator
