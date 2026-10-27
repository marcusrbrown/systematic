# docs — Starlight Documentation Site

Separate workspace (`@fro.bot/systematic-docs`, private). Starlight/Astro site deployed to GitHub Pages.

## Commands

```bash
bun run docs:generate   # Sync reference content from bundled assets (run first)
bun run docs:dev        # Local dev server
bun run docs:build      # Full build (runs generate + astro build)
bun run docs:preview    # Preview production build
```

`docs:generate` must run before `docs:build` — reference content is generated, not committed.

## Stack

- **Framework:** Starlight (`@astrojs/starlight`) on Astro 6
- **Deploy:** GitHub Actions → GitHub Pages (`docs.yaml` workflow)
- **Site:** `https://fro.bot/systematic` (trailing slashes enabled)

## Structure

```
docs/
├── astro.config.mjs          # Site config (sidebar, social, base path)
├── scripts/
│   ├── transform-content.ts       # Skills/agents content generator
│   └── generate-config-reference.ts  # Config reference MDX generator (+ --check)
├── src/
│   ├── styles/custom.css     # Theme overrides
│   └── content/docs/
│       ├── index.mdx         # Landing page
│       ├── getting-started/  # Manual onboarding pages
│       ├── guides/           # Manual conceptual/how-to guides
│       └── reference/
│           ├── skills/       # Generated — gitignored (from skills/)
│           ├── agents/       # Generated — gitignored (from agents/)
│           └── configuration.mdx  # Human-owned; one sentinel-injected generated region
└── package.json
```

## Content Generation

`docs:generate` runs two generators in sequence:

### 1. `scripts/transform-content.ts` — skills/agents pages

Reads bundled assets from project root:

| Source | Pattern | Output |
|--------|---------|--------|
| `skills/*/SKILL.md` | `SKILL.md` files | `reference/skills/<slug>.md` + `index.mdx` |
| `agents/**/*.md` | All `.md` files | `reference/agents/<slug>.md` + `index.mdx` |

Pipeline: `read file → parseFrontmatter (shared from src/lib/frontmatter.ts) → transformFrontmatter (name→title, agent category→badge) → generatePage → write`

Each run cleans output dirs before regenerating. Index pages (`index.mdx`) are dynamically generated from the same enumerated entries using Starlight `CardGrid`/`LinkCard` components. Agents are grouped by category (design/docs/document-review/research/review/workflow). Slug collisions abort with error.

### 2. `scripts/generate-config-reference.ts` — config field reference

Derives field reference content by walking `SystematicConfigSchema`'s JSON Schema output. For each top-level field it renders a `## <field>` section with:
- Description (from `.meta({ description })` in the schema)
- Type/accepted shape (from `type`/`enum`/`anyOf`/`pattern`)
- Default value (from JSON Schema `default`)
- Examples (from `.meta({ examples })`)

**No standalone page is produced.** Instead, the generator injects content into the committed human-owned page `src/content/docs/reference/configuration.mdx` between the FIELD-REFERENCE sentinel markers:

| Sentinel pair | What is injected |
|---|---|
| `{/* SYSTEMATIC:FIELD-REFERENCE:START */}` … `{/* SYSTEMATIC:FIELD-REFERENCE:END */}` | Full Zod-derived field reference (overlay fields + top-level sections) |

`reference/configuration.mdx` is committed, human-owned content. Only the region between the sentinel markers is overwritten on each `docs:generate` run. All prose outside the markers is preserved byte-for-byte.

Adding a new top-level field to `SystematicConfigSchema` with `.meta({ description })` automatically produces a new MDX section on the next `docs:generate` run — no manual template update required.

The injection is **idempotent**: running `docs:generate` twice in a row produces no diff.

The generator also has a write-free check mode: `bun docs/scripts/generate-config-reference.ts --check` (`bun run config-reference:drift`). It builds the injected text in memory and compares it with the committed file, so a hand edit between the markers fails as drift while a prose edit outside them passes. Missing or reversed markers, an unresolved version and missing examples each fail with their own message, and nothing is ever written. `bun run config-reference:generate` is the matching write command. Both are entries in the generated-surface list, so `bun run surfaces:drift` runs the check and `bun run surfaces:regen` rewrites the region. Like the schema generator, it reads the version from git tags, so a clone without tags fails.

The retired category routing table is preserved for migration purposes in
`docs/src/content/docs/guides/model-defaults-migration.mdx`. It is historical
guidance, not runtime policy or generated reference content.

## Where to Look

| Task | Location |
|------|----------|
| Site config (sidebar, base path) | `astro.config.mjs` |
| Skills/agents content generator | `scripts/transform-content.ts` |
| Config reference MDX generator | `scripts/generate-config-reference.ts` |
| Manual guides | `src/content/docs/guides/*.mdx` |
| Landing page | `src/content/docs/index.mdx` |
| Theme customization | `src/styles/custom.css` |
| Generated reference pages | `src/content/docs/reference/` (gitignored) |

## Notes

- Reference pages under `reference/` are gitignored — always regenerated from source (including `index.mdx`)
- Agents get sidebar badges by category: Design, Docs, Document-review, Research, Review, Workflow
- Script reuses `src/lib/frontmatter.ts` for frontmatter parsing
- Frontmatter `name` → Starlight `title`, `description` gets HTML tags stripped
- Sidebar: Getting Started, Guides, Reference (Skills/Agents) — all autogenerated from dirs
