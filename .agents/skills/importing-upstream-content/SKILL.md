---
name: importing-upstream-content
description: Use when bringing skills, agents or reference files from an upstream project (compound-engineering, obra/superpowers, Impeccable, agent-browser, or any third-party source) into Systematic's bundle. Covers a new import, a refresh to a newer upstream release, and merging one upstream improvement into a skill Systematic has diverged from.
---

# Importing Upstream Content

## Overview

Imported content ships to every Systematic user. It must pass the same gates as content written here. It must also carry its licence and record the upstream commit it came from. The detailed rules live in the solution docs listed at the end. This skill collects them into one checklist, with emphasis on the steps importers usually miss.

## Choose the mode

| Situation | Mode | Rule |
|---|---|---|
| A skill or agent new to Systematic | Import with light adaptation | Keep the upstream voice. Adapt only what the gates and harnesses require. |
| A newer upstream release of content already imported | Refresh | Diff the old pinned commit against the new one, and apply that diff onto Systematic's copy. Re-apply Systematic's additions. Never copy the upstream files over the top. |
| One upstream improvement to a skill Systematic has changed | Merge | Port the capability and keep Systematic's structure. Keep one authority per section. |
| A file that ships inside an npm package and needs only a mechanical transform | Generated surface | Pin the package exactly as a devDependency, write a generator, and register it in `scripts/lib/generated-surfaces.ts`. The pin is the npm version, not a commit SHA. Renovate brings refreshes, and `surfaces:regen` applies them. The generator writes the version into `ATTRIBUTIONS.md`. Don't edit any of these by hand; the SHA and human-review steps below don't apply. |

## Get the upstream source

- **Pin a full 40-character commit SHA.** Resolve a tag or short SHA first. Every later step cites the full SHA.
- **Recreate the clone if it's missing.** `.slim/clonedeps.json` lists each clone's repo URL, ref and path. `.slim/clonedeps/repos/` is gitignored and often absent. Clone the repo at that ref into that path, or fetch the files at the pinned SHA with `gh api`. Never import from memory or from a summary.
- **For a refresh, check the base first.** Confirm that the old pinned SHA in `ATTRIBUTIONS.md` is the commit you are diffing from. If it isn't, stop.
- **Search history with `git log --all --grep` or tags.** At HEAD, a path-limited `git log` shows only the branch-root commit for content older than 2026-07-31.

## Attribution

- **One `ATTRIBUTIONS.md` section per upstream source.** Include:
  - the repo and pinned SHA;
  - the licence and copyright line;
  - the full licence text, copied verbatim from upstream `LICENSE` at the pin;
  - a file inventory and adaptation notes;
  - a note that refresh is human-reviewed.
- **Put `license: <SPDX>` on each entry-point `SKILL.md` only.** Don't add per-file header comments.
- **Record the SHA you synced to** in the attribution entry and in the commit body (`Source: owner/repo@<sha>`), so the next refresh can diff from it.
- **If the source has no section yet, raise it with the maintainer before shipping.** Attribution is a legal surface.
- **CC-BY derivatives** need the originality checks in the light-adaptation doc. **Apache-2.0** sources keep their NOTICE text.

## Adapt

Count each category in the upstream files before you adapt, and again after. Use the regex in the light-adaptation doc.

- **Skill frontmatter.** Keep only fields the loader recognizes. Drop `hidden` and any vendor-specific keys. Match the existing `name` convention: `ce:<name>` for ce skills.
- **Agent frontmatter.** Omit `model`, and never write `inherit`. Set `mode: subagent`, a numeric `temperature` and a `color`. The filename stem must be unique across categories.
- **`tools:`.** A string such as `Read, Grep` grants everything on OpenCode, but on Pi it is a least-privilege allowlist. Set it to what the agent actually needs on Pi.
- **Banned strings.** Rewrite `AskUserQuestion`, `TaskCreate`, `Claude Code`, `CLAUDE.md`, `.claude/`, `${CLAUDE_PLUGIN_ROOT}` and upstream namespaces in harness-neutral terms. Use an exemption in `scripts/.drift-allowlist.json`, with a reason, only for historical text quoted verbatim.
- **Force-loads.** `@file` becomes a plain `references/<file>` path.
- **Script calls.** Every fenced block that runs a bundled script starts with `SKILL_DIR="<skill directory stated when this skill loads>";`. Never write a bare `bash scripts/x.sh`, `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_SKILL_DIR}`. `tests/unit/skill-script-invocation.test.ts` enforces this.
- **References.** Agents are `systematic:<category>:<name>`. Import every skill or agent the content depends on, or remove the reference. Never leave a reference dangling, and never turn a qualified ID into a bare name.
- **Upstream-only coupling.** This covers upstream settings files, `CONCEPTS.md`, skills Systematic doesn't ship, and variables nothing defines. Map each to a Systematic mechanism or leave it out. An input the user supplies becomes `$ARGUMENTS`, with an `argument-hint`. Systematic's config is a strict schema, so a skill can't read an ad hoc settings file.
- **New agents.** A dispatched agent can't read its parent skill's files, so put anything it needs, such as a rubric, in the dispatch prompt. Decide explicitly whether to export each one as a Pi persona (`CURATED_PERSONAS` in `src/lib/pi-subagents-personas.ts`).
- **Counts.** Update the bundled skill and agent counts in `README.md`, and any agent list README.

## Check by hand what the gates miss

`content-integrity` doesn't catch:

- an `@name.md` with no directory prefix;
- a `.dot` file;
- a path cited from inside a nested reference;
- banned strings in non-Markdown files under `skills/`;
- bare skill names in prose;
- `ce-<agent>` spellings.

Grep the imported tree for the upstream namespace and for these patterns. Run the grep against the upstream copy first, so you know it can match.

## Verify

```bash
bun scripts/content-integrity.ts
bun run surfaces:affected --run
bun run surfaces:drift
bun run claude-code:build
```

`claude-code:build` translates `ce:` and qualified references for the Claude Code bundle, and it fails on anything left unresolved. `content-integrity` doesn't run that translation.

Run the unit tests for the files you touched. A content import doesn't need integration tests. Then check `git diff --stat`: the only files beyond your own edits should be the regenerated surfaces.

## Title the PR so it releases

The squash title sets the release.

- Use `feat:` for a new skill or agent.
- Use `fix:` or `docs(skills):` for a refresh or merge.
- `chore`, `refactor` and `docs(contributing)` publish nothing, so the imported content would never ship.

Write the title as public prose.

## Common mistakes

| Mistake | Fix |
|---|---|
| Copying a newer upstream file over Systematic's copy | Diff from the pinned SHA and apply the diff. Re-apply Systematic's sections. |
| Skipping `claude-code:build` | Run it. It is the only check that the Claude Code translation resolves. |
| `chore(skills): refresh …` | Use a releasing type, or the refresh never reaches users. |
| Trusting an importer's "N files imported" | Check the shipped tree: every cited file exists. |

## Source docs

- `docs/solutions/best-practices/third-party-bundled-skills-light-adaptation-2026-05-17.md`
- `docs/solutions/best-practices/third-party-skill-design-law-import-2026-05-21.md`
- `docs/solutions/best-practices/vendor-npm-packaged-skill-as-generated-artifact-2026-07-28.md`
- `docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md`
- `docs/solutions/integration-issues/reconciliation-sync-reference-integrity-20260417.md`
- `docs/solutions/integration-issues/sync-cep-missing-sub-files-SyncCEP-20260219.md`
- `docs/solutions/best-practices/qualified-persona-ids-are-canonical-validated-references-2026-07-17.md`
- `docs/solutions/best-practices/anchor-bundled-script-paths-in-skill-prose-2026-08-24.md`
- `docs/solutions/integration-issues/cross-harness-tools-frontmatter-divergence-2026-08-16.md`
