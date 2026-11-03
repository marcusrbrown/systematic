---
title: "feat: Repo-root project config, local user overlay and search source excludes"
type: feat
status: active
date: 2026-11-03
origin: docs/brainstorms/2026-11-03-config-locations-and-source-excludes-requirements.md
---

# feat: Repo-root project config, local user overlay and search source excludes

## Overview

Three config features reach every surface that reads Systematic config: the OpenCode v1 and v2 plugins, Pi, the `systematic` CLI and the Claude Code bin `systematic-search`.

- **Source excludes.** An external search source gains a gitignore-style `exclude` list, matched by a new dependency-free module.
- **Repo-root project file.** `.systematic.jsonc` (or `.json`) at the repository root becomes a project config location that beats `.opencode/`. Every reader resolves it from the repository root, not from the start directory.
- **Local user overlay.** `systematic.local.jsonc` (or `.json`) beside the user file and beside the `OPENCODE_CONFIG_DIR` file adds two layers: user → user.local → profile → project → custom → custom.local.

Two defects get fixed on the way. `systematic search` drops the fallback's warnings and the caught exception today, so an invalid local file could not be named. And `config show` has no search section at all.

The plan extends `search-user-config.ts`, `config.ts`, `search-corpus.ts` and the external walks. It adds one module, `src/lib/search-exclude.ts`.

---

## Problem Frame

The origin document carries the full frame and is untracked (see Sources & References). In short:

- Some stores hold files that only add noise to external search: an activity log in a wiki, test-tool sandbox copies of the docs. Nothing can exclude them.
- Project config must live under `.opencode/`. A repository worked on only through Claude Code or Pi has no other reason to create that directory.
- A user who keeps `~/.config/opencode/systematic.jsonc` in dotfiles must commit machine-specific paths (absolute source roots, `projects`, the allow list) or keep the file out of dotfiles.
- Readers disagree on where the project file is. The CLI and the per-call search reader start at the repository root. The plugins and Pi start at the directory they were given, so a session in a subfolder misses the project config.

The loader treats trust as the unit of everything: each file is a source with a `user`, `project` or `custom` kind, and strip rules, merge rules and observation metadata key on that kind. Locals are the first case of two files sharing a kind, so the change touches every place that enumerates sources.

---

## Requirements Trace

The origin defines R1–R18 and AE1–AE11. Planning decisions refine four of them, and the refined wording takes precedence:

- R2/R4 (patterns). `**` is special only as a whole segment. Also invalid: a leading `./`, an embedded `**` (`a**b`), an empty segment (`a//b`), a `.` segment. The 64-pattern limit is by index.
- R18. No regex and no exponential backtracking. Cost is bounded by pattern length × path length, not linear in path length alone.
- R15. The CLI fallback must surface the diagnostics it discards today (KTD9).
- R16. Parity is defined for the same effective start directory (KTD2).

| ID | Requirement (short form) | Units |
|----|--------------------------|-------|
| R1 | Every external source entry accepts `exclude` | U2 |
| R2 | Patterns match the path relative to the root; no `/` means any depth; `/` anchors; trailing `/` ignored | U1, U3 |
| R3 | `*`, `**`, `?` only; a matched directory excludes its subtree | U1, U3 |
| R4 | Invalid pattern drops alone with a warning; source still loads; 64-pattern cap | U1, U2 |
| R5 | Excluded directory never entered; excluded file never examined or counted; listing budget still charged | U3 |
| R6 | Deciduous matches `nodes/<file>` and `edges/<file>` | U3 |
| R7 | `.systematic.jsonc`/`.json` at the repo root; `.opencode/` keeps working | U4, U5, U6 |
| R8 | Root file wins, `.opencode/` ignored with a warning naming both, never merged | U4, U5, U6 |
| R9 | Root file has exactly project trust | U5, U6 |
| R10 | Every reader resolves the project file from the repo root | U4, U5, U6 |
| R11 | `systematic.local.jsonc`/`.json` beside the user and custom files | U4, U5, U6 |
| R12 | Order user, user.local, custom, custom.local with custom-layer merge rules | U5, U6 |
| R13 | A local has its sibling's trust and may set every field the sibling may | U5, U6 |
| R14 | A local with no sibling is valid | U4, U5, U6 |
| R15 | Invalid local behaves like an invalid sibling per surface | U5, U6 |
| R16 | Same files, same order, identical search output on all surfaces | U6 (parity), U5 |
| R17 | Reference and search guide document locations, precedence, overlay, excludes | U8 |
| R18 | Matching has no regex and no exponential backtracking | U1 |

Scope added during planning, beyond the origin:

| ID | Scope | Units |
|----|-------|-------|
| S1 | `config show` lists the local and ignored-project paths, never local contents (D7) | U7 |
| S2 | `config show` gains a Search section for the current project (D8) | U7 |
| S3 | `loadSearchSettingsForCli` surfaces fallback warnings and the caught exception (D6) | U6 |

| AE | Pinned in |
|----|-----------|
| AE1, AE2 | U1 (matcher), U3 (walk) |
| AE3 | U2 |
| AE11 | U1 (bounded match), U2 (`!log.md` reported) |
| AE4 | U4 (selection), U5 (loader), U6 (bin-safe reader) |
| AE5 | U5, U6 |
| AE6, AE9 | U4 (root lookup), U5, U6 |
| AE7, AE10 | U5 (full loader), U6 (bin-safe reader) |
| AE8 | U5 (plugin, Pi throw), U6 (CLI, bin report) |

---

## Scope Boundaries

- A project-level `.local` file.
- Absolute roots in project files.
- Honoring `.gitignore` when walking source roots.
- Excludes for the four built-in kinds.
- Writing or gitignoring the local file automatically.
- Negation (`!`) and character classes in patterns.
- Adjacent cleanup. Nothing outside the files a unit names changes.

### Deferred to Separate Tasks

- Pi per-call config reload: Pi keeps its startup load (KTD2); a reload design is its own task.
- Merging `findGitWorktreeRoot` and `resolveSearchRoot`: the doc comment on `resolveSearchRoot` still says not to unify them, and this plan keeps that.

---

## Context & Research

### Relevant Code and Patterns

- `src/lib/search-user-config.ts` is bin-safe and must not import `config.ts` or `config-schema.ts`. It owns `selectConfigFile`, `resolveUserLevelConfigDirs`, `mergeSearchSettings` (already N-source), `validateEntry`, `loadUserLevelSearchSettings` and `loadProjectSearchSources`. The full loader and the bin both call it, which makes it the right home for shared selection.
- `src/lib/config.ts`: `getConfigPaths`, `loadConfigWithSources`, `loadConfigSource` (trust comes from the kind, not the path), `resolveOverlayEntryValue`, `buildConfigObservationMetadata`, `mergePiSubagentsOverlaySources`, and the profile lookups.
- `src/lib/search-corpus.ts`: `resolveSearchRoot` (nearest `.git`, realpath, falls back to the realpath of the start), `listDirectoryWithin` (charges the entry budget per listed name), `discoverFiles`, `discoverSourceFiles`.
- `src/lib/search-external.ts`: `MARKDOWN_WALK` is a shared constant, so a per-source matcher cannot ride on `WalkSpec`. `gatherCandidates` builds per-source inputs.
- `src/lib/search-external-deciduous.ts`: `scanFolder` and `classifyJsonEntry` list `nodes/` and `edges/` without recursion.
- `src/lib/search-external-sources.ts`: `resolveExternalSources`, `ActiveSource`. Both source mappings (user, project) must copy `exclude`.
- `src/lib/config-protected-fields.ts`: an import-free module shared across the loader/bin boundary. It is the precedent for `search-exclude.ts`.
- `src/cli.ts`: `loadSearchSettingsForCli`, `buildConfigShowJson`, `configShow`.
- `scripts/lib/generated-surfaces.ts`, `docs/scripts/generate-config-reference.ts` (`SEARCH_SOURCE_ENTRY_FIELDS`).

### Institutional Learnings

- `docs/solutions/best-practices/entry-point-scope-decides-what-a-plugin-can-ship-2026-08-24.md`: keep the bin's import graph narrow, test the packaged bin under Node from a foreign directory. `search-exclude.ts` has no imports, so the graph stays narrow.
- `docs/solutions/best-practices/dependency-free-module-for-a-constant-shared-across-a-boundary-2026-09-20.md`: an import-free module for anything shared across a boundary, and a test that it is registered.
- `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md` and `docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md`: regenerate in order, then check drift; watch for ESM import caching in generator tests.
- The completed external-sources plan: shared validators and selection, five host lifecycles, a parity test, entry budget charged at consumption. It warns that platform `readdir` and `realpath` differences bite.
- The completed durable-search plan: do not merge nearest-`.git` walks casually when fallback semantics differ.
- No earlier glob matcher exists in the repo, so pattern semantics need explicit tests.

### External References

- OpenCode repo-root `opencode.json` and glob `watcher.ignore`; Claude Code `settings.local.json` (local over shared over user). Prior art for naming and layering only; no behavior is copied.

---

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "systematic repo (single package): src/, src/lib/, scripts/lib/, docs/scripts/, tests/unit, tests/helpers, tests/integration (not walked)",
  "freshness": {
    "vcs_reference": "7325f46739fea6546be31b996339e3b6f995fd20 (branch feat/config-locations-excludes, clean)"
  },
  "budget": {
    "max_search_passes": 8,
    "max_candidate_inspections": 24,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/search-user-config.ts#selectConfigFile",
      "description": "Picks <basename>.jsonc else <basename>.json in a dir; the single file-selection chokepoint config.ts and the bin-safe reader both call. Already parameterised by basename, so '.systematic' and 'systematic.local' need no new primitive.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/search-user-config.ts#resolveUserLevelConfigDirs",
      "description": "Resolves homeDir, userConfigDir and the trimmed OPENCODE_CONFIG_DIR (blank = unset) for config.ts and the reader alike; gives the two directories the local files sit beside.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/search-user-config.ts#loadUserLevelSearchSettings",
      "description": "Bin-safe reader: reads the user file then the custom file, validates each search block, merges with mergeSearchSettings, never throws. Also the CLI's fallback when a source is invalid, so adding local files here satisfies R15.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/search-user-config.ts#loadProjectSearchSources",
      "description": "Bin-safe project reader: selectConfigFile on <root>/.opencode, 1 MB bounded fd read, project-trust validation, returns sources/warnings/unreadable. Hard-codes the .opencode location and has nowhere to report an ignored second file.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/search-user-config.ts#mergeSearchSettings",
      "description": "Pure merge over an ordered source list: enabled last-defining, allow_project_sources union, sources by name with the later whole entry winning. Already N-source, so user/user-local/custom/custom-local needs only a longer input list.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/search-user-config.ts#validateEntry",
      "description": "Per-entry validator with ENTRY_KEYS and SearchSourceSchema (name, format, roots, projects); an unknown key drops the entry. Needs an 'exclude' key, per-pattern validation and warnings routed through warn().",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/config.ts#getConfigPaths",
      "description": "Builds userConfig, projectConfig, customConfig and unused dir fields from the raw projectDir; no repo-root resolution, no local files, no root project file.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/config.ts#loadConfigWithSources",
      "description": "Full loader with loadUserAndCustomSources, buildOverlaySources, profile lookup/selector, scalar and list merges, observation metadata, all assuming exactly three file sources keyed by trust. Local layers need a layer discriminator and edits at each enumeration.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/config.ts#resolveOverlayEntryValue",
      "description": "Overlay merge branches on source.trust: 'user' merges field-additively and 'custom' replaces whole. A user-local file given trust 'user' would merge additively, contradicting R12, so the branch must key on a layer field.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/config.ts#loadConfigSource",
      "description": "Loads and validates one file under a trust kind; project trust drives every strip and warning (protected fields, security overlays, search protected warnings) from the kind, not the path, so a root .systematic.jsonc gets identical trust once passed as projectConfig.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/config.ts#buildConfigObservationMetadata",
      "description": "Maps sources by ConfigSourceKind (user/project/custom) and feeds the CLI invalid-source check and capability snapshot allowlist; a second user-trust source would collide, so local presence needs folding into the sibling entry.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/search-corpus.ts#resolveSearchRoot",
      "description": "Nearest ancestor holding .git (directory or file), realpath'd, falling back to the realpath of the start dir; already used by the CLI and every per-call reader. Needs a variant that reports whether .git was found so the loader can keep the unresolved start dir otherwise.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/search-corpus.ts#discoverFiles",
      "description": "Recursive external/built-in walk: listWalkedDirectory charges the shared EntryBudget per listed name, then safeLstat and classifyEntry per name. Has no per-source exclude hook; a name-only check fits between the sort loop and safeLstat via a Discovery field like entryBudget.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/search-corpus.ts#WalkSpec",
      "description": "Static per-kind excludedFiles/excludedDirs: lower-case exact names, no glob, no depth or path anchoring. MARKDOWN_WALK is a shared constant and KIND_TABLE is 'as const satisfies', so it cannot carry a per-source matcher.",
      "disposition": "insufficient",
      "insufficiency_reason": "Exact lower-case name lists only; no glob, no anchoring, and the walk spec is shared across sources while excludes are per source."
    },
    {
      "path_or_symbol": "src/lib/search-external-deciduous.ts#scanFolder",
      "description": "Lists nodes/ and edges/ without recursion, charges the budget, then classifyJsonEntry does the name test, safeLstat, symlink and id checks. Accepts no exclude input; the test belongs after the .json suffix check and before safeLstat.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/search-external-sources.ts#resolveExternalSources",
      "description": "Per-call reader shared by every surface: resolveSearchRoot, user settings, project sources, identity, ActiveSource list. ActiveSource carries name/format/roots/origin only, so exclude must be added and copied in both source mappings.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/cli.ts#loadSearchSettingsForCli",
      "description": "CLI search settings: full loader at resolveSearchRoot(startDir) in report mode, falling back to loadUserLevelSearchSettings on an invalid non-project source. The fallback already reads whatever that reader reads, so local files follow; the pre-resolve becomes redundant.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/config-protected-fields.ts",
      "description": "Import-free shared module for a constant used across the config-loader/bin boundary; PROJECT_PROTECTED_SEARCH_FIELDS already covers search.enabled and allow_project_sources, and exclude needs no protection. Precedent for hosting the matcher module.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/search-bounded-read.ts#readBytesBounded",
      "description": "The bounded, non-blocking, regular-file fd read used by the project reader; a root .systematic.jsonc is read through the same path with no new I/O primitive.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "docs/scripts/generate-config-reference.ts#SEARCH_SOURCE_ENTRY_FIELDS",
      "description": "Hard-coded display list of sources[] entry fields (name, format, roots, projects) that drives the search sub-sections of the generated reference; exclude must be appended or it will not render.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "scripts/lib/generated-surfaces.ts#matchesGlob",
      "description": "Glob match built on Bun.Glob for generated-surface triggers; build-time script code outside src/ and unavailable to the Node-run bin.",
      "disposition": "insufficient",
      "insufficiency_reason": "Depends on the Bun runtime and lives in scripts/, so it cannot ship in the plugin or the Node 20.11 bin, and its semantics are not the gitignore subset."
    },
    {
      "path_or_symbol": "node:path#matchesGlob",
      "description": "Built-in glob matcher reported by the requirements doc as stable only from Node 22; not verified in this survey.",
      "disposition": "insufficient",
      "insufficiency_reason": "Engines floor is Node >=20.11 and the bin runs under Node, so it cannot be relied on; its pattern semantics also differ from the specified subset."
    },
    {
      "path_or_symbol": "src/lib/discovered-skills.ts#findGitWorktreeRoot",
      "description": "Private .git walk-up that returns null without a repo; deliberately different from resolveSearchRoot and documented as not to be unified.",
      "disposition": "insufficient",
      "insufficiency_reason": "Private, null-on-miss behavior contradicts the R10 start-directory fallback, and its doc says not to unify it with resolveSearchRoot."
    }
  ]
}
```

---

## Key Technical Decisions

Where a decision changes today's behavior, the Documentation section lists it.

| # | Decision | Rationale |
|---|----------|-----------|
| KTD1 | **Repo root.** The root is the nearest ancestor holding `.git` (directory or file). With none, the start directory is used unresolved, and the lookup variant reports whether `.git` was found. The lookup runs in `getConfigPaths`/`loadConfigWithSources` only when `includeProject` is true. | One change covers v1, v2, Pi, the CLI's non-search commands and the pi-subagents export. Not realpathing the no-repo fallback keeps no-repo behavior byte-identical; a macOS tmpdir realpath would break existing tests. The v2 home fallback stays `includeProject:false`. |
| KTD2 | **Pi keeps its split.** Config loads once at startup from `process.cwd()`; search resolves per call from `ctx.cwd`. R16 parity means the same effective start directory. | A per-call reload is a separate task. The split is documented rather than hidden. |
| KTD3 | **Layer order** user → user.local → profile → project → custom → custom.local. The advisory position of a project-sourced profile bundle is unchanged. `FileConfigSource` gains a `layer` discriminator, and overlay replace-vs-additive branches on `layer`, not trust. Locals fold into the sibling's observation metadata; a kind is invalid if either of its files is. | A local shares its sibling's kind and trust, so trust cannot tell them apart. Folding keeps the capability snapshot's closed kind allowlist intact. Files are validated separately before folding so messages name the right file. |
| KTD4 | **Selection by existence, not validity.** `.jsonc` beats `.json`; a root file beats `.opencode/`. An invalid winner never falls back. If the user and custom directories are the same directory or realpath aliases, each file is read from disk once and its diagnostics are emitted once. | Matches how `.jsonc` already wins. Falling back past a broken file would silently apply the wrong config. |
| KTD5 | **Patterns.** Rules per the Requirements Trace refinements, plus: trailing `/` stripped, case-sensitive, `*` matches dotfiles. Matching is a segment DP across pattern × path segments, with an iterative two-pointer match inside a segment. No regex. The pattern validator runs per element before any strict schema; a non-array `exclude` drops the source; bad elements drop one by one; warnings name `exclude[i]` and the reason, never the pattern text. | A strict schema array would reject the whole value before the per-pattern drop AE3 needs. Regex invites ReDoS, and the bin must run on Node 20.11. |
| KTD6 | **Excluded names still cost listing budget.** The check runs after the listing is charged and before `safeLstat`. Excluded entries are never descended into and never count toward file or byte caps. A Deciduous folder removed whole by excludes is intentionally absent and raises no warning. | The walk stays bounded. Excludes cannot be used to hide an oversized directory from the budget. |
| KTD7 | **Diagnostics.** Search never throws. Each invocation reports each failed file once, deduped by file plus issue. The plugins and Pi fail at startup and name the file. The bin validates only the `search` block and cannot detect other invalid fields; docs say so. | Failure is loud where a loader exists and non-fatal where search must still answer. |
| KTD8 | **`config show --json` is additive.** Existing keys stay; new keys carry the user-local, custom-local and ignored-project paths. Neither output dumps local file contents. The capability snapshot folds locals into the user/custom kinds. | Consumers pinned to the old key set keep working. |
| KTD9 | **Fix `loadSearchSettingsForCli`.** The user-level fallback's warnings and the caught exception reach the CLI's warning list. | Without it, AE8 cannot name an invalid local file on the CLI. |
| KTD10 | **No major version.** The two compatibility changes ship in a minor release with a Compatibility paragraph in the commit body and PR description, not a `BREAKING CHANGE:` footer. | Both changes affect narrow setups, and each has a one-step migration. |

---

## Open Questions

### Resolved During Planning

- A lone `**` pattern: valid, equals `*` for a name-only pattern. A source whose every file it excludes reports the existing empty/missing state.
- `**` matches zero or more segments, so `a/**` also matches `a` itself (dropping the directory) and `**/b` matches a root `b`.
- More than 64 patterns: elements from index 64 on are dropped, with one aggregate warning naming `exclude[64]` and the count. An invalid element still occupies an index.
- A non-string element is invalid with reason "not a string".
- Aliased user/custom directories: both layer positions keep applying, as today, so a user file named by `OPENCODE_CONFIG_DIR` still ranks over project. Each file is read once; diagnostics dedupe; one warning names the alias. Dropping the custom pair was rejected because it silently lowers that file's precedence.
- Selection when no project file exists: the `.opencode/systematic.json` path is reported, as today.
- The pattern-list validator is a list-level function in `search-exclude.ts` so `validateEntry`, the full loader and the bin share one result.
- `config show --json` key names: `locations.userLocal`, `locations.customLocal` (null when no custom directory), `locations.ignoredProject` (null unless a root file shadowed an existing `.opencode/` file). Local keys carry the selected path even when absent, like `user` does.
- `config show` keeps printing the sibling user and project file contents it prints today; only locals are never dumped. `config path` picks up the resolved project path and adds no rows.
- When the full load fails, `config show --json` still returns `{locations, error}` and now also `search`, because the bin-safe readers never throw and the failure is when the section helps most.
- Search-section statuses: `active`, `not allowed`, `shadowed`, `over source cap`, `dropped invalid`, `missing root`. `missing root` comes from an `lstat` of the root; external sources are not walked. Built-in kinds use the discovery state: `present`, `empty`, `missing`, `unreadable`.
- `loadSearchSettingsForCli` keeps its `resolveSearchRoot` pre-resolve. It becomes redundant and harmless; removing it is cleanup.

### Deferred to Implementation

- Exact function, option and key names beyond those fixed above.
- Whether the top-level config Zod schema reaches `search.sources` entries or only `validateEntry` does. KTD5's order (pattern validator first, schema second) holds on both paths either way.
- The present per-field behavior of `resolveOverlayEntryValue`, `lookupProfileBundle` and `resolveProfileSelector`. Characterize before changing (U5).
- Whether `resolveExternalSources` can expose per-source dispositions additively or needs a sibling function (U7).
- Whether the CLI fallback needs a sanitizer on exception text before printing.
- Whether `config.ts` importing `search-corpus.ts` creates a cycle.
- Wording of the new warnings.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

User-level layers and what each does to the one before it:

| Order | Layer | File (beside) | Trust | Merge over earlier layers |
|-------|-------|---------------|-------|---------------------------|
| 1 | user | `~/.config/opencode/systematic.*` | user | base |
| 2 | user.local | `systematic.local.*` beside it | user | custom rules: scalars by field, allow list union, sources by name replaced whole |
| 3 | profile | bundle named by the selector | per bundle origin | unchanged |
| 4 | project | repo-root `.systematic.*`, else `.opencode/systematic.*` | project | project strip rules, unchanged |
| 5 | custom | `OPENCODE_CONFIG_DIR/systematic.*` | custom | unchanged |
| 6 | custom.local | `systematic.local.*` beside it | custom | custom rules |

The bin-safe reader sees only the search block, in the order user, user.local, custom, custom.local, then the project sources separately.

Project file selection (existence only):

| Root `.systematic.jsonc` | Root `.systematic.json` | `.opencode/` file | Used | Warning |
|---|---|---|---|---|
| yes | any | any | root `.jsonc` | names ignored `.json`/`.opencode` files |
| no | yes | any | root `.json` | names ignored `.opencode` file |
| no | no | yes | `.opencode` file | none |
| no | no | no | nothing (`.opencode/systematic.json` reported) | none |

Pattern examples (relative paths use `/`):

| Pattern | Matches | Does not match |
|---|---|---|
| `log.md` | `log.md`, `a/log.md` | `log.md.bak` |
| `.stryker-tmp` | the directory at any depth, so its subtree | `stryker-tmp` |
| `drafts/*.md` | `drafts/a.md` | `notes/drafts/a.md`, `drafts/x/a.md` |
| `a/**/b` | `a/b`, `a/x/b`, `a/x/y/b` | `b`, `x/a/b` |
| `a/**/**/**/b` | same as `a/**/b` (runs collapse) | |
| `**/b` | `b`, `x/b` | |
| `!log.md`, `a**b`, `a//b`, `./a`, `[a]` | invalid, dropped with a warning | |

Dependency order:

```mermaid
flowchart TB
  U1[U1 matcher] --> U2[U2 config]
  U2 --> U3[U3 walks]
  U4[U4 shared selection] --> U5[U5 full loader]
  U2 --> U6[U6 bin-safe readers and CLI]
  U4 --> U6
  U5 --> U6
  U3 --> U6
  U5 --> U7[U7 config show]
  U6 --> U7
  U7 --> U8[U8 docs]
```

---

## Implementation Units

The units land as separate commits on one feature branch. U1–U3 (excludes) and U4–U5 (locations) are independent until U6.

### Phase A: Source excludes

- [ ] **U1. Exclude matcher module**

**Goal:** A pure, import-free module that validates exclude patterns and matches relative paths with a bounded algorithm.

**Requirements:** R2, R3, R4, R18; AE1, AE2, AE11

**Dependencies:** None

**Files:**
- Create: `src/lib/search-exclude.ts`
- Test: `tests/unit/search-exclude.test.ts`
- Modify (registration): `ARCHITECTURE.md` (codemap entry), `src/lib/AGENTS.md` (module-table row)

**Approach:**
- Exports a per-pattern validator that returns the invalid reason or ok, a list-level validator taking `unknown` and returning kept patterns plus indexed issues, the 64-pattern limit constant, and a compile step returning a matcher over root-relative `/`-joined paths.
- The list validator owns every KTD5 rule: non-array drops the source, element-wise drop, index-based cap, reason text without pattern text.
- Compile splits on `/`, strips one trailing `/`, collapses runs of `**`, and records whether the pattern was name-only (no `/` after the strip).
- A name-only pattern tests the entry's own name. An anchored pattern runs the segment DP against the full relative path. The walk checks every entry it reaches, so a matched directory removes its subtree without the matcher knowing entry type.
- Inside a segment, `*` and `?` use an iterative two-pointer match with a single saved star position.
- Registration lands in this unit because the content-integrity gate enforces both surfaces.

**Execution note:** Test-first. The matcher has no precedent in the repo, so the failing table of cases defines the semantics.

**Patterns to follow:**
- `src/lib/config-protected-fields.ts` (import-free shared module and its registration test).
- Module-graph tests in `tests/unit/claude-code-search.test.ts`.

**Test scenarios:**
- Happy path (AE1): `log.md` matches `log.md` and `a/log.md` but not `log.md.bak`; `.stryker-tmp` matches the directory at depth 0 and depth 3.
- Happy path (AE2): `drafts/*.md` matches `drafts/a.md`; not `notes/drafts/a.md`; not `drafts/x/a.md`.
- Happy path: `a/**/b` matches `a/b`, `a/x/b`, `a/x/y/b`; not `b`, `x/a/b`. `**/b` matches `b` and `x/b`. `a/**` matches `a/x/y`. `?` matches one character and never `/`. A trailing `/` gives the same result as none.
- Edge: `*` matches `.hidden`. `README.md` does not match `readme.md`. Pattern length 256 is valid, 257 invalid. Exactly 64 patterns kept; the 65th element reports `exclude[64]`.
- Edge: a lone `**` is valid and excludes every name.
- Error path (AE11): each of `''`, `/a`, `!a`, `./a`, `a//b`, `a/./b`, `../a`, `a/../b`, `[a]`, `a\b`, `a**b`, `***` is invalid with a distinct reason; none of the reasons contain the pattern text.
- Error path: a non-array value drops the source; a number element is dropped as "not a string" while its valid neighbors survive.
- Integration (R18): `a/**/**/**/b` compiles to the same matcher as `a/**/b`. Adversarial inputs (`*a*a*a*a*b` against a 255-character `a` run; a many-segment path against stacked `**`) return the correct answer. A source scan of the module finds no `RegExp`, no regex literal and no import.

**Verification:**
- `tests/unit/search-exclude.test.ts` passes and covers the table above.
- `bun scripts/content-integrity.ts` passes, which confirms the ARCHITECTURE.md and `src/lib/AGENTS.md` registration.

---

- [ ] **U2. `exclude` in config validation and the active-source model**

**Goal:** `exclude` is a recognized, validated field on external source entries, carried to every walk input, and visible in the generated schema and reference.

**Requirements:** R1, R4; AE3, AE11

**Dependencies:** U1

**Files:**
- Modify: `src/lib/search-user-config.ts` (`ENTRY_KEYS`, `SearchSourceSchema`, `validateEntry`)
- Modify: `src/lib/search-external-sources.ts` (`ActiveSource`, user mapping, project mapping)
- Modify: `src/lib/config-schema.ts` (`.meta` description for `exclude`)
- Modify: `docs/scripts/generate-config-reference.ts` (`SEARCH_SOURCE_ENTRY_FIELDS`)
- Modify: `scripts/lib/generated-surfaces.ts` (add `src/lib/search-exclude.ts` to the `schema` and `config-reference` triggers)
- Regenerate: `docs/public/schemas/v*/systematic-config.schema.json`, `docs/src/content/docs/reference/configuration.mdx`
- Test: `tests/unit/search-user-config.test.ts`, `tests/unit/config.test.ts`, `tests/unit/config-schema.test.ts`, `tests/unit/search-external-sources.test.ts`, `tests/unit/generate-config-reference.test.ts`, `tests/unit/generated-surfaces.test.ts`

**Approach:**
- `validateEntry` runs the list validator on `exclude` first, replaces the value with the kept patterns, then lets `SearchSourceSchema` check the cleaned entry. The schema keeps `z.array(z.string().max(256)).max(64)` so the emitted JSON schema documents the limits for editors. The runtime path never reaches that constraint with bad data.
- Each issue goes through `warn()` as `exclude[i]` plus the reason. No trust difference: `exclude` is not a protected field, so project and user entries are treated alike.
- Both `ActiveSource` mappings copy the validated list, defaulting to empty.
- Wiring the trigger is a registration obligation no gate catches by name: the wiring test compares literals with real imports, so add the trigger and let it confirm.

**Execution note:** Test-first on `validateEntry` behavior; regenerate after the code is green.

**Patterns to follow:**
- Existing `validateEntry` warnings that name a field and source name but never a value.
- `PROJECT_PROTECTED_SEARCH_FIELDS` handling for what a project entry may carry.

**Test scenarios:**
- Happy path: a source with `["log.md", ".stryker-tmp"]` loads with both patterns on `ActiveSource`, for a user entry and a project entry.
- Error path (AE3): `["drafts/*.md", "[bad]"]` loads, keeps the first, warns once with `exclude[1]` and a reason, and the warning text does not contain `[bad]`.
- Error path (AE11): `["!log.md", "a/**/**/**/b"]` warns for `exclude[0]` and keeps the second.
- Error path: `exclude: "log.md"` drops the source with a warning; `exclude: []` is a no-op with no warning.
- Edge: 70 patterns keep the first 64 with one warning.
- Integration: the full loader and `loadUserLevelSearchSettings` produce identical sources and warnings for the same fixture (bin-safe parity).
- Integration: the regenerated schema lists `exclude` with the 64 and 256 limits; the reference table lists the field; the trigger lists include `search-exclude.ts`.

**Verification:**
- `bun run surfaces:affected --run` regenerates the schema and config-reference surfaces; `bun run surfaces:drift` is clean.
- The unit tests above pass.

---

- [ ] **U3. Exclude in the Markdown and Deciduous walks**

**Goal:** Excluded files and directories are never examined, never entered and never counted toward file or byte caps, while every listed name still costs listing budget.

**Requirements:** R2, R3, R5, R6; AE1, AE2

**Dependencies:** U1, U2

**Files:**
- Modify: `src/lib/search-corpus.ts` (`Discovery`, `DiscoverSourceFilesOptions`, `discoverFiles`)
- Modify: `src/lib/search-external.ts` (`gatherCandidates`, `loadDeciduousSource`)
- Modify: `src/lib/search-external-deciduous.ts` (`DeciduousLoadInput`, `scanRoots`, `scanFolder`, `classifyJsonEntry`)
- Test: `tests/unit/search-corpus.test.ts`, `tests/unit/search-external.test.ts`, `tests/unit/search-external-deciduous.test.ts`, `tests/unit/search-builtin-goldens.test.ts` (unchanged, must still pass)

**Approach:**
- Build the matcher once per source in `gatherCandidates`, not on `WalkSpec`. Pass it to discovery as an optional `isExcluded` on the options, copied onto `Discovery`.
- In `discoverFiles`, test `${prefix}${name}` after the truncated check and before `safeLstat`. The budget is already charged by the listing call, so excluded names still count.
- Deciduous: thread the matcher through `scanRoots` → `scanFolder` → `classifyJsonEntry`. Check the folder name at the top of `scanFolder`, before the folder stat. Check `${folder}/${name}` after the `.json` suffix test and before `safeLstat`. An excluded entry does not count toward `skips`, and a folder excluded whole produces no warning.
- Patterns are relative to each root of a multi-root source.
- Built-in kinds pass no matcher, so their output is unchanged by construction.

**Execution note:** Test-first with a `safeLstat`/`readdir` spy so the "never examined" claim is observed, not inferred.

**Patterns to follow:**
- The existing budget-at-consumption tests in `tests/unit/search-corpus.test.ts` and the lstat counting in the external-sources tests.

**Test scenarios:**
- Happy path (AE1): a tree with `log.md`, `sub/log.md`, `.stryker-tmp/x.md`, `keep.md` and `exclude: ["log.md", ".stryker-tmp"]` loads only `keep.md`.
- Happy path (AE2): `drafts/a.md` excluded and `notes/drafts/a.md` indexed under `["drafts/*.md"]`.
- Happy path: with two roots in one source, an anchored pattern applies relative to each root.
- Edge (R5): a spy shows `safeLstat` is never called for an excluded file, and an excluded directory is never listed.
- Edge (R5): with a listing budget of N, a directory of N names where some are excluded still hits the truncation warning; excludes do not buy more budget.
- Edge: excluded oversized files do not trip the per-file, source or shared byte caps, and do not count toward the file cap.
- Happy path (R6): Deciduous `["nodes/legacy-*.json"]` skips matching nodes; `["edges"]` removes the `edges/` folder with no warning and no `skips` increment; `["*.json"]` excludes every entry in both folders.
- Edge: an excluded Deciduous entry that would otherwise fail a symlink or id check reports nothing.
- Regression: built-in golden outputs are byte-identical.

**Verification:**
- Spy-based tests pass; the golden suite passes unmodified.

---

### Phase B: Config locations

- [ ] **U4. Shared file selection and repo-root lookup**

**Goal:** One bin-safe place decides which user-level files and which project file a reader looks at, and one lookup says where the repository root is.

**Requirements:** R7, R8, R10, R11, R14; AE4, AE6, AE9

**Dependencies:** None

**Files:**
- Modify: `src/lib/search-user-config.ts` (user-level selection with layers, project selection with the ignored path)
- Modify: `src/lib/search-corpus.ts` (root lookup variant reporting whether `.git` was found; update the comment above `resolveSearchRoot`)
- Test: `tests/unit/search-user-config.test.ts`, `tests/unit/search-corpus.test.ts`
- Modify: `tests/helpers/search-external-env.ts` (`writeProjectSearch` root-file variant; a local-file writer)

**Approach:**
- User-level selection takes the resolved directories and returns ordered layer/path pairs: user, user.local, custom, custom.local. Local selection reuses `selectConfigFile` with the basename `systematic.local`. A blank `OPENCODE_CONFIG_DIR` yields no custom pair, as `resolveUserLevelConfigDirs` already treats it. Aliased user/custom directories are flagged here (same path or same realpath) so callers read once.
- Project selection takes the root and returns the winning path plus the ignored path, per the selection table in High-Level Technical Design. It uses existence only and never looks at validity.
- The root lookup variant shares `resolveSearchRoot`'s walk but returns the found root when `.git` exists and signals not-found otherwise, leaving the caller to keep the start directory unresolved. `resolveSearchRoot` itself keeps its realpath behavior. A permission error on an ancestor stops the walk as "not found", never throws.
- Update the comment on `resolveSearchRoot` so it names the variant and keeps the "do not unify with `findGitWorktreeRoot`" guidance.

**Execution note:** Test-first.

**Patterns to follow:**
- `selectConfigFile`, `resolveUserLevelConfigDirs`, and the existing fixture style in `tests/helpers/search-external-env.ts`.

**Test scenarios:**
- Happy path: `.systematic.jsonc` beats `.systematic.json` beats `.opencode/systematic.jsonc`; the ignored path is reported for each combination in the selection table.
- Edge: no file anywhere returns the `.opencode/systematic.json` path and no ignored path, as today.
- Edge: a directory named `.systematic.jsonc` is selected (existence, not validity).
- Happy path: user-level selection returns four pairs in order; with `OPENCODE_CONFIG_DIR` unset or blank it returns two; a local present without a sibling is still selected (R14); `systematic.local.jsonc` beats `systematic.local.json`.
- Edge: `OPENCODE_CONFIG_DIR` equal to the user directory — by string, with a trailing slash, and through a symlink — is flagged as aliased.
- Happy path (AE6): start `packages/app` under a directory holding `.git` returns that directory.
- Happy path (AE9): a nested repository returns its own root from `vendor/lib/src`, and the parent root from the parent's `docs/`.
- Edge: `.git` as a file counts (linked worktree). No `.git` anywhere returns not-found and the caller's start directory string is unchanged; a symlinked tmpdir start is not realpathed.
- Error path: an unreadable ancestor returns not-found without throwing.
- Regression: `resolveSearchRoot` outputs are unchanged.

**Verification:**
- New selection and lookup tests pass; existing `resolveSearchRoot` tests pass unmodified.

---

- [ ] **U5. Full-loader layers, root project file and repo-root resolution**

**Goal:** `loadConfigWithSources` loads the two local layers and the root project file in the right order with the right trust, resolves the project from the repository root, and reports invalid files per surface.

**Requirements:** R7–R16; AE4–AE10

**Dependencies:** U4

**Files:**
- Modify: `src/lib/config.ts` (`getConfigPaths` and `ConfigPathOptions`, `FileConfigSource`, `loadUserAndCustomSources`, `buildOverlaySources`, the sources list, `mergedDisabled*`, `bootstrap`, `skills_as_commands`, `allow_project_profiles`, the `mergeSearchSettings` call, `resolveProfileSelector`, `lookupProfileBundle`, `trustedDefaultProfileName`, `assertAllProfileBundlesAreValid`, `mergePiSubagentsOverlaySources`, `warnRemovedKeys`, `resolveOverlayEntryValue`, `resolveOverlayEntryOrigin`, `buildConfigObservationMetadata`)
- Modify: `src/lib/capability-snapshot.ts` only if the closed kind allowlist needs a test-visible adjustment (expected: none)
- Test: `tests/unit/config.test.ts`, `tests/unit/capability-snapshot.test.ts`, `tests/unit/pi.test.ts`, `tests/unit/opencode-v2.test.ts`, `tests/unit/opencode-v2-search.test.ts`, `tests/unit/config-handler.test.ts`

**Approach:**
- `getConfigPaths` gains `includeProject` (default true) through its options. When true it resolves the root with the U4 variant and derives the project path, the `projectDir` field and the ignored path from it. When the lookup finds no `.git`, it keeps the start directory unresolved. The loader passes its own `includeProject`, so the v2 home fallback does no lookup. CLI display callers get the same resolution.
- `getConfigPaths` also returns the local paths and the ignored project path.
- `FileConfigSource` gains `layer`: user, user-local, project, custom, custom-local. Kind and trust stay as they are. Replace-vs-additive merge branches on `layer`: user-local and custom-local follow the custom-layer rule over what is below them.
- Every enumeration site in the Files list changes to take the layered list. The default chain is user, user-local, profile, project, custom, custom-local; the project-sourced profile bundle keeps its current advisory position at the front.
- Each file is loaded and validated alone, so errors name the right file. Observation metadata folds local into the sibling after validation: present if either exists, invalid if either is invalid.
- The R8 warning goes to `warningSink`. An invalid root file never falls back to `.json` or `.opencode/`.
- Aliased user/custom directories: parse each file once, keep both layer positions, dedupe diagnostics by file plus issue, and emit one alias warning.
- `invalidSource: 'throw'` (plugins, Pi) throws with the invalid file's own path; `'report'` (CLI) records it in metadata.

**Execution note:** Characterization-first. Pin today's behavior of `resolveOverlayEntryValue`, the profile lookups and the three-source metadata before changing them, so only the intended differences show in the diff.

**Patterns to follow:**
- The existing project/custom alias handling around `resolveAliasedCustomConfigPath` for buffered warnings.
- Existing `loadConfigSource` kind-driven strip and warning behavior (reused untouched).

**Test scenarios:**
- Happy path: a scalar overlay field set at all six layers resolves to the custom.local value; removing the highest layer falls to the next.
- Happy path (AE7): user defines `wiki` for two projects; user.local adds an allow entry and redefines `wiki` with another root. The allow list is the union; `wiki` uses the local root with no field merging from the user entry.
- Happy path (AE10): user.local and custom both define `wiki`; custom wins.
- Happy path (R13, R14): a local alone sets `search.enabled` and `allow_project_sources`; both apply.
- Happy path (AE4): root and `.opencode/` files both present; only the root file's settings apply, a field only in `.opencode/` is absent, and a warning names both paths.
- Happy path (AE5): a root `.systematic.jsonc` setting `search.enabled: false` and `allow_project_sources` is stripped with the same warning text a `.opencode/` file produces today.
- Happy path (AE6, AE9): a session in `packages/app/` applies the root file; a nested repository applies only its own file.
- Edge: no `.git` anywhere reads `<start>/.opencode/systematic.json` exactly as today, with the start path unresolved (existing `config.test.ts` tests pass unmodified).
- Edge: `includeProject: false` performs no lookup and reads no project file.
- Edge (compat, pinned): `packages/app/.opencode/systematic.json` below a repository root with its own `.git` elsewhere is no longer read.
- Error path (AE8): a syntax error in user-local makes the loader throw naming the local file, not its sibling; with `report` the `user` metadata entry is invalid and the sibling's valid fields still load. Same for custom-local and for an invalid non-search field.
- Error path: an invalid root `.systematic.jsonc` does not fall back to the valid `.opencode/` file or to `.systematic.json`; the error names the root file.
- Edge: metadata for the `user` kind is present when only user-local exists, and the capability snapshot sees no new kind (the unknown-key hard failure is not triggered).
- Edge: a profile bundle defined in user-local is found; local wins over its sibling; a project-sourced bundle keeps its current position.
- Edge: with `OPENCODE_CONFIG_DIR` aliasing the user directory, each diagnostic appears once, one alias warning appears, and both layers still apply.
- Integration: the pi-subagents export includes local layers; `warnRemovedKeys` names the local file for a removed key.
- Integration (D2): Pi at init with `process.cwd()` in a subfolder applies the root file and throws on an invalid local naming it; v2 with a subfolder `ctx.location.directory` applies it; v2 home fallback applies no project.

**Verification:**
- Characterization tests pass before and after except where the plan changes behavior.
- All `config.test.ts` start-directory tests pass without edits to their expectations.

---

- [ ] **U6. Bin-safe readers, CLI diagnostics and cross-surface parity**

**Goal:** The per-call reader, the CLI and the Claude Code bin read the same files in the same order as the full loader, and the CLI names every invalid file.

**Requirements:** R7–R16; S3; AE4–AE10

**Dependencies:** U2, U3, U4, U5

**Files:**
- Modify: `src/lib/search-user-config.ts` (`loadUserLevelSearchSettings` reads the four layers; `loadProjectSearchSources` uses project selection and returns the R8 warning; `formatProjectFileWarning` wording)
- Modify: `src/lib/search-external-sources.ts` (per-invocation diagnostic dedupe)
- Modify: `src/cli.ts` (`loadSearchSettingsForCli` surfaces fallback warnings and the caught exception; dedupe on print)
- Test: `tests/unit/search-user-config.test.ts`, `tests/unit/search-external-sources.test.ts`, `tests/unit/search-cli.test.ts`, `tests/unit/cli.test.ts`, `tests/unit/search-adapters-parity.test.ts`, `tests/unit/claude-code-search.test.ts`

**Approach:**
- `loadUserLevelSearchSettings` iterates the U4 pairs. A failed local gives one warning naming that file and marks the result unreadable; the valid remainder still merges.
- `loadProjectSearchSources` takes the winning path from project selection, keeps the 1 MB bounded read and project-trust validation (sources only; `enabled` and `allow_project_sources` are never read), and returns the R8 warning in `warnings`. An oversized or unreadable winner makes the project unreadable with no fallback.
- `loadSearchSettingsForCli` merges the fallback's warnings into its list, adds the caught exception's message in the `catch` path, and dedupes the final list by message so the CLI no longer prints the same file twice.
- The reader and the CLI dedupe by file plus issue per invocation.
- The bin keeps its narrow import graph: it gains `search-exclude.ts` (import-free) and nothing else.

**Execution note:** Add the parity fixture first, red, then bring each surface in line.

**Patterns to follow:**
- The five-surface fixture structure in `tests/unit/search-adapters-parity.test.ts`; the foreign-directory and module-graph tests in `tests/unit/claude-code-search.test.ts`.

**Test scenarios:**
- Happy path (AE7, AE10): the bin-safe reader returns the same merged settings as the full loader for the AE7 and AE10 fixtures.
- Happy path (AE4, AE5): the project reader selects the root file, returns the R8 warning naming both paths, never merges, and does not read `enabled` or `allow_project_sources`.
- Error path: a syntax error in user-local yields one warning naming it and `unreadable`, while user and custom still merge. A local with no sibling is read alone.
- Error path (AE8, CLI): a syntax error in user-local prints the file name on stderr, results carry the `config unreadable` note, and search runs with the valid files. A valid `search.enabled: false` in a local file is still honored by the fallback.
- Error path (AE8, CLI): an invalid non-search field in custom-local makes the full loader report it; the fallback reads that file's valid search block, and the warning names the file.
- Error path (S3): the exception path prints the caught message; a regression test fails if fallback warnings are dropped again.
- Edge: the same file and issue reported by the loader and the fallback appears once; two calls in one process each report their own.
- Edge: an oversized root `.systematic.jsonc` makes the project unreadable and does not fall back to `.opencode/`.
- Integration (R16): one fixture — root `.systematic.jsonc` with `exclude`, user + user.local + custom + custom.local, session started in a subfolder — produces identical output on v1, v2, Pi, CLI and bin, including the exclude effect and the warning set. Pi uses the same directory for startup and for `ctx.cwd`.
- Integration (AE8, other surfaces): v1, v2 and Pi throw at startup naming the local file; the bin warns and continues.
- Integration (bin): the built bin run under Node from a foreign directory with a `.git` ancestor and a root file resolves the project file; the module-graph test shows `search-exclude.ts` reachable and `config.ts` not; no API beyond Node 20.11 is used.
- Edge (documented limit): an invalid non-search field in a local file is invisible to the bin, and a test pins that.

**Verification:**
- The parity and bin tests pass; `tests/unit/search-cli.test.ts` no longer shows duplicated warnings.

---

### Phase C: Surfacing and documentation

- [ ] **U7. `config show` locations and Search section**

**Goal:** `config show` lists every config file it can read and answers "what will search do for this project, and why" in both human and `--json` forms, without running a search.

**Requirements:** S1, S2

**Dependencies:** U5, U6

**Files:**
- Modify: `src/cli.ts` (`buildConfigShowJson`, `configShow`, the JSON output types)
- Modify: `src/lib/search-external-sources.ts` (additive per-source dispositions, or a sibling inspector; decided during implementation)
- Modify: `src/lib/search-user-config.ts` (merge keeps the origin layer label of each source and of the ones it replaced)
- Test: `tests/unit/cli.test.ts`, `tests/unit/search-external-sources.test.ts`

**Approach:**
- Locations: keep `user`, `project`, `custom`; add `userLocal`, `customLocal`, `ignoredProject`. The human output lists the same paths. Local contents are never printed.
- Search section for the current project (start `process.cwd()`, root via `resolveSearchRoot`): `enabled`; the allow list and whether this project is on it; each external source with origin (user, user.local, custom, custom.local, project), name, format, roots, exclude, status and warnings; each built-in kind with its directory and state.
- It reuses the resolver and discovery. Source status comes from the resolver's decisions plus an `lstat` of each root. External sources are not walked. Built-in state comes from discovery without reading files.
- JSON adds `search` beside `routing`, and also on the `{error}` shape because these readers never throw.
- Existing exit codes are unchanged.

**Execution note:** Test-first on the JSON shape; the human rendering follows it.

**Patterns to follow:**
- `buildConfigShowJson`'s file-paths-only convention and its comment on why contents are not dumped.

**Test scenarios:**
- Happy path: the `locations` key set in the existing pin test becomes the new set (`custom`, `customLocal`, `ignoredProject`, `project`, `user`, `userLocal`); existing key values are unchanged.
- Happy path: a root file shadowing an `.opencode/` file fills `ignoredProject`; otherwise it is null. With no custom directory, `custom` and `customLocal` are null.
- Edge: a sentinel string in a local file never appears in either output.
- Happy path: the Search section reports `enabled`, the allow list and `projectAllowed` for a fixture, with the right origin on a user.local source.
- Happy path: one fixture produces each status: `active`; `not allowed` (project proposal without an allow entry); `shadowed` (a user source replaced by a custom one); `over source cap` (nine sources); `dropped invalid` (bad entry); `missing root`.
- Happy path: `exclude` patterns appear on the source, and warnings appear without pattern text.
- Happy path: all four built-in kinds list their directory with `present`, `empty`, `missing` or `unreadable`.
- Error path: with an invalid local file, JSON is the error shape plus `search` and the process still exits 1; human output prints the same section.
- Integration: a spy shows no search runs and no document file is read.

**Verification:**
- The updated `config show` tests pass and human and JSON output agree on the same fixture.

---

- [ ] **U8. Documentation and descriptive strings**

**Goal:** The reference, the search guide and the architecture docs describe the new locations, precedence, overlay and exclude syntax, and state the accepted compatibility changes.

**Requirements:** R17

**Dependencies:** U1–U7

**Files:**
- Modify: `docs/src/content/docs/reference/configuration.mdx` (hand-written sections: Config File Locations, project-versus-user notes, the search subsection; a "Migrating" note with the two compatibility changes and a worked example)
- Modify: `docs/src/content/docs/guides/search.mdx` (sources section: `exclude` syntax and examples, project file location and root rule, local overlay, the Pi split, the bin's validation limit, the `OPENCODE_CONFIG_DIR` warning)
- Modify: `ARCHITECTURE.md` (config priority, invariants, codemap sentence for the new layers)
- Modify: `HARNESSES.md` (the Search row, SR-3, SR-6)
- Modify: `src/lib/AGENTS.md` (rows for the changed modules)
- Modify: `src/lib/config-schema.ts`, `src/lib/config.ts` (descriptive strings that say project config lives only under `.opencode/`)
- Regenerate: schema and config-reference surfaces

**Approach:**
- State the layer order table, the selection rule (existence, never validity), the no-merge rule, and which fields a local may set.
- State the two compatibility changes with the example: move `packages/app/.opencode/systematic.json` to the repository root; and a git-managed home directory becomes the root for any non-repo directory under it.
- Document the Pi split and the bin's limit (search block only) next to the surfaces they affect.
- Docs refer to sections and symbols, not line numbers.

**Execution note:** Test expectation: none -- prose and string edits. The gates below check them.

**Patterns to follow:**
- The external-sources documentation passes in the same files; the registry-drift solution doc for regeneration order.

**Test scenarios:**
- Integration: `generate-config-reference.test.ts` and the schema tests pass after the string edits, so the generated surfaces are in step.

**Verification:**
- `bun run surfaces:affected --run` then `bun run surfaces:drift` are clean.
- `bun scripts/content-integrity.ts` and `bun run docs:build` pass.
- Every statement in the two docs pages about locations, precedence and exclude syntax matches the KTDs.

---

## System-Wide Impact

- **Interaction graph:** `loadConfigWithSources` serves v1, v2, Pi, the CLI and the pi-subagents export. The per-call reader serves every search call. The bin uses only the bin-safe readers.
- **Error propagation:** plugins and Pi throw naming the file at startup (v2 per snapshot). The CLI and the bin report and continue. Per-call readers never throw.
- **State lifecycle risks:** Pi reads config once, so a root file added mid-session is missed until restart. Search sources resolved per call pick it up.
- **API surface parity:** `ConfigPathOptions` gains an option; the `config show --json` output gains three keys; `ActiveSource` gains `exclude`. All additive.
- **Integration coverage:** the five-surface parity fixture and the built-bin foreign-directory test cover what unit mocks cannot. No new real-host integration test is added.
- **Unchanged invariants:** project trust and its strip rules; project files never carry absolute roots; `search.enabled` and `allow_project_sources` stay user-only; built-in kinds and their goldens; v2's home fallback applies no project config.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A missed enumeration site drops a local layer silently (the widest change) | Characterization tests first; one scenario per consumer of the layered list (U5); the parity fixture. |
| Monorepo subfolder `.opencode/` configs without their own `.git` stop loading | Accepted. Pinned by a test and documented with a migration example. |
| A git-managed home directory becomes the root for non-repo directories beneath it | Accepted; it matches search's existing behavior. Documented. |
| The alias interpretation (read once, both positions kept) differs from a reader's expectation | Recorded in Resolved During Planning; the alternative is dropping the custom pair, which lowers precedence. |
| Folding locals into one metadata entry hides which file broke | Validate files separately and fold after; error messages come from the per-file result. |
| Pattern semantics drift between the full loader and the bin | One list validator in the import-free module; parity test for the validators (U2). |
| `config.ts` importing `search-corpus.ts` creates a cycle or widens the plugin's graph | Check at the start of U5; fall back to moving only the lookup if needed. |
| Generated surfaces drift from the new trigger or field list | Trigger and `SEARCH_SOURCE_ENTRY_FIELDS` change land in U2 with regeneration; U8 regenerates again after string edits. |
| `config show` source statuses need data the resolver does not expose | The additive disposition output is scoped in U7; if it grows, split it from the rendering. |

---

## Documentation / Operational Notes

- Release notes (the commit body and PR description) carry a Compatibility paragraph with both changes and the migration example from U8. No `BREAKING CHANGE:` footer (KTD10).
- New modules require the `ARCHITECTURE.md` codemap entry and the `src/lib/AGENTS.md` row, done in U1.
- Run `bun run surfaces:affected --run`, then `bun run surfaces:drift`, before the PR. A clone without tags needs `git fetch --tags` first.
- Full gates before the PR: `bun run typecheck:all`, `bun run lint`, `bun test`, `bun run docs:build`.

---

## Alternative Approaches Considered

- A glob library or `path.matchesGlob`: adds a dependency or needs Node 22; the bin runs on 20.11 and the semantics differ from the specified subset.
- Compiling patterns to regex: ReDoS risk and no bounded cost; R18 forbids it.
- Merging the root file with `.opencode/`: a reader would have to explain a merged result; one file wins, as `.jsonc` already beats `.json`.
- A new `local` trust class: a local has its sibling's trust, so a new class adds a policy with no use.
- Resolving the root separately in each surface: five lookups to keep in sync; one lookup in the loader covers them.

---

## Sources & References

- **Origin document:** `docs/brainstorms/2026-11-03-config-locations-and-source-excludes-requirements.md`. The path is gitignored (`docs/brainstorms/` is not tracked), so a clone will not have it; this plan carries the requirements it needs in the Requirements Trace.
- Related past work: `docs/plans/2026-11-02-001-feat-external-sources-plan.md`, completed. It introduced the sources, the trust model and the five-surface parity test; this plan adds excludes and a second location without changing them.
- Related past work: `docs/plans/2026-10-29-001-feat-durable-output-search-plan.md`, completed. Source of the nearest-`.git` fallback caution.
- Related code: `src/lib/search-user-config.ts`, `src/lib/config.ts`, `src/lib/search-corpus.ts`, `src/lib/search-external.ts`, `src/lib/search-external-deciduous.ts`, `src/lib/search-external-sources.ts`, `src/cli.ts`.
