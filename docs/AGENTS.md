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
│   └── generate-config-reference.ts  # Config reference MDX generator
├── src/
│   ├── styles/custom.css     # Theme overrides
│   └── content/docs/
│       ├── index.mdx         # Landing page
│       ├── getting-started/  # 2 manual pages (installation, configuration)
│       ├── guides/           # 7 manual pages (philosophy, main-loop, agent-install, architecture, conversion-guide, ocx-registry, exemplary-checklist)
│       └── reference/        # Generated — DO NOT EDIT
│           ├── skills/       # 45 pages + index.mdx (generated from skills/)
│           ├── agents/       # 51 pages + index.mdx (generated from agents/)
│           └── systematic-config.mdx  # Config field reference (generated from schema)
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

Derives the config reference page by walking `SystematicConfigSchema`'s JSON Schema output. For each top-level field it renders a `## <field>` section with:
- Description (from `.meta({ description })` in the schema)
- Type/accepted shape (from `type`/`enum`/`anyOf`/`pattern`)
- Default value (from JSON Schema `default`)
- Examples (from `.meta({ examples })`)

Output: `src/content/docs/reference/systematic-config.mdx`

Adding a new top-level field to `SystematicConfigSchema` with `.meta({ description })` automatically produces a new MDX section on the next `docs:generate` run — no manual template update required.

NOTE: The top-level `commands/` directory has been removed (all commands converted to skills). The generation script may still have backward-compat command handling code but produces no command pages from current source.

### 3. Source Category Model Defaults — dual-output injection

`scripts/generate-config-reference.ts` ALSO injects the source category model defaults table into the **committed** `src/content/docs/getting-started/configuration.mdx` page. This is a deliberate dual-output contract:

| Output | Path | Tracked? | Purpose |
|---|---|---|---|
| Full config reference | `src/content/docs/reference/systematic-config.mdx` | **No** (gitignored) | Auto-generated from `SystematicConfigSchema`; full Zod-derived field reference; regenerated on every `docs:generate` |
| Source defaults table | `src/content/docs/getting-started/configuration.mdx` | **Yes** (committed) | Manual guide page; generator injects the `## Source Category Model Defaults` table between `<!-- SYSTEMATIC:SOURCE-DEFAULTS:BEGIN -->` and `<!-- SYSTEMATIC:SOURCE-DEFAULTS:END -->` HTML-comment delimiters |

The injection is **idempotent**: running `docs:generate` twice in a row produces no diff (the second run replaces the delimited block with the same content). CI's `docs:build` step runs the generator and fails if the committed `configuration.mdx` is out of sync with the source constant.

**Single source of truth**: the source data lives in `src/lib/source-model-defaults.ts` (`SOURCE_CATEGORY_MODEL_DEFAULTS` constant, `formatForDocs()` helper). The generator imports both, calls `formatForDocs()`, and replaces the delimited block. Editing `configuration.mdx` between the delimiters is futile — your changes will be overwritten on the next generate.

When changing the source defaults:
1. Edit `src/lib/source-model-defaults.ts:SOURCE_CATEGORY_MODEL_DEFAULTS`
2. Update the golden snapshot if needed: `bun test tests/unit/source-model-defaults.test.ts --update-snapshots`
3. Run `bun run docs:generate` to refresh the injected table
4. Commit `configuration.mdx` alongside the source change

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
