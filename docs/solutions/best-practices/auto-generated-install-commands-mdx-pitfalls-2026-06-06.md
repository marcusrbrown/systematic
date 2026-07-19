---
title: Auto-generate per-skill install commands without breaking the docs generator or MDX
date: 2026-06-06
category: best-practices
module: docs/scripts/transform-content.ts
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - Injecting auto-generated content into a load-side-effect docs generator
  - Making a generator script that runs at module load unit-testable
  - Authoring MDX that mixes prose, tables, and copyable command snippets
  - Adding npx skills (skills.sh) install commands to a docs site
tags:
  - transform-content
  - import-meta-main
  - npx-skills
  - mdx
  - starlight
  - copy-button
  - generator-testability
  - deprecated-skills
---

# Auto-generate per-skill install commands without breaking the docs generator or MDX

## Context

Adding `npx skills` (skills.sh) install commands to the Systematic docs site meant auto-injecting a per-skill `npx skills add marcusrbrown/systematic --skill <name>` command into every generated skill reference page via `docs/scripts/transform-content.ts`. Wiring that up surfaced a cluster of small traps: the generator ran its whole build at module load (so it wasn't unit-testable), deprecated skills would get advertised, and the install-command markdown hit two distinct MDX rendering failures. None were hard, but each wastes time if you don't know it ahead.

## Guidance

### Make a load-side-effect generator testable

`transform-content.ts` exported nothing and ran the full generation at import. To unit-test the per-skill injection, export the pure helper and guard the entrypoint behind `import.meta.main`:

```ts
// before — runs the whole build on import; nothing testable
function generateDefinitionHeader(/* ... */) { /* ... */ }
processDirectory(skillsDir, 'skill')
processDirectory(agentsDir, 'agent')

// after — importable helper + guarded entrypoint
export function generateDefinitionHeader(options: {
  category?: string
  sourcePath: string
  name?: string
  definitionType?: DefinitionType
  deprecated?: boolean
}): string { /* ... */ }

if (import.meta.main) {
  processDirectory(skillsDir, 'skill')
  processDirectory(agentsDir, 'agent')
}
```

Now `bun test` can import `generateDefinitionHeader` and assert its output without triggering a generation run.

### Drive the `--skill` selector from frontmatter `name`, and skip deprecated skills

`npx skills --skill <X>` matches the skill's frontmatter `name` (and its directory name) case-insensitively with no normalization, so colon-form names like `ce:plan` are valid arguments and pass through verbatim. Use the already-resolved `data.name` — do not slugify or guess. Gate the injection so deprecated skills (which carry a `deprecated:` frontmatter block) don't get an install command for content slated for removal:

```ts
const deprecated = data.deprecated != null
// ...
if (definitionType === 'skill' && name != null && !deprecated) {
  // emit `npx skills add marcusrbrown/systematic --skill ${name}`
}
```

### Avoid two MDX rendering traps for command snippets

1. **`<name>` in a table cell parses as JSX and breaks the table.** MDX treats `<name>` as an unclosed tag. Use `[name]` (or another non-angle-bracket placeholder) instead.
2. **Copy buttons only attach to fenced code blocks, never inline code in table cells.** Starlight's expressive-code adds the copy button to ` ```bash ` fences only. If a command is meant to be copyable, render it as a fenced block (or a styled command block), not a markdown-table cell. A "click to copy" claim next to a table is false.

### Verify rendered docs against built HTML, not source or a dev server

`docs:dev` (Astro) is a foreground-blocking process that hangs a non-interactive subagent. For rendered verification, run `bun run docs:build` and inspect `docs/dist/<page>/index.html`: confirm the copy button exists (`<button ... data-code="npx skills ...">`), that `[name]` renders as literal text, and that no stray `<blockquote>` or broken table markup remains. Source text looking fine does not mean it rendered fine. (See the cross-referenced verification docs below.)

## Why This Matters

Each trap fails quietly in a way that source review misses:

- A generator that runs at import can't be unit-tested, so the per-skill logic ships unverified.
- A presence-only "skill exists" injection advertises skills you're about to delete.
- MDX silently misparses `<name>` and drops or mangles the table.
- Inline-code-in-table commands aren't copyable, so a "copy this" instruction lies.
- A red build or a wrong render slips through if you trust source text instead of built HTML.

## When to Apply

- Adding auto-generated content to a docs generator that runs at module load.
- Emitting copyable command snippets in MDX.
- Authoring MDX tables that contain placeholder tokens or code.
- Any docs-site change where the visual/rendered result is the actual deliverable.

## Examples

### Test coverage the refactor unlocks

```ts
test('colon-form name passes through verbatim', () => {
  const out = generateDefinitionHeader({
    sourcePath: 'skills/ce-plan/SKILL.md',
    name: 'ce:plan',
    definitionType: 'skill',
  })
  expect(out).toContain('--skill ce:plan')
})

test('deprecated skill emits no install command', () => {
  const out = generateDefinitionHeader({
    sourcePath: 'skills/orchestrating-swarms/SKILL.md',
    name: 'orchestrating-swarms',
    definitionType: 'skill',
    deprecated: true,
  })
  expect(out).not.toContain('npx skills')
})
```

### MDX: table-safe placeholder + fenced block for copyability

```mdx
<!-- broken: <name> parses as JSX, table breaks; table cell has no copy button -->
| Install one skill | `npx skills add marcusrbrown/systematic --skill <name>` |

<!-- works: [name] is literal text; fenced block gets a copy button -->
```bash
npx skills add marcusrbrown/systematic --skill [name]
```
```

## Related

- `docs/solutions/build-errors/mdx-heading-anchor-crashes-astro-build-2026-05-22.md` — the same MDX/JSX-grammar family: `{#anchor}` braces and `<name>` angle brackets both get parsed as JS/JSX and break the build or render.
- `docs/solutions/best-practices/pre-push-live-server-screenshot-qa-2026-05-22.md` — `docs:build` is necessary but not sufficient; verify the rendered output.
- `docs/solutions/best-practices/verify-css-liveness-against-rendered-html-2026-06-04.md` — inspect built `docs/dist` HTML rather than trusting source markup.
- `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md` — adjacent build-time codegen pattern (generator self-reads, fresh-input boundaries).
- `docs/solutions/test-failures/unit-suite-rewrites-repo-file-trap-2026-07-17.md` — the docs generator's test suite rewriting the committed configuration.mdx during verification; injectable write target + repo-file-untouched assertion.
- `docs/solutions/ui-bugs/mdx-gfm-tables-render-as-raw-pipe-text-2026-07-18.md` — another MDX-pipeline gap: authored `.mdx` GFM tables rendered as raw pipe text until `remark-gfm` was wired into the markdown config; same "verify built HTML, not source" discipline.
