---
title: Build and publish a harness plugin from CI instead of committing it
date: 2026-07-18
category: best-practices
module: claude-code-harness
problem_type: architecture_pattern
component: tooling
severity: high
tags:
  - claude-code
  - plugin-packaging
  - orphan-branch
  - build-from-ci
  - identifier-translation
  - release-gating
  - sha-versioning
applies_when:
  - Distributing a plugin/extension for a host that installs by copying the whole plugin directory
  - The host namespaces skills/agents differently than your canonical source
  - You want a single source of truth with no committed generated duplication
  - Publishing a build artifact that must stay in lockstep with an npm release
---

# Build and publish a harness plugin from CI instead of committing it

## Context

Systematic ships the same skills and agents to three harnesses. OpenCode and Pi load them through a runtime plugin, but Claude Code consumes a **plugin bundle**: a directory (`.claude-plugin/plugin.json` + `skills/` + `agents/` + `output-styles/` + `hooks/`) that the host copies to a cache on install. Two forces collide:

1. Claude Code namespaces plugin skills as `systematic:<skill-dir>` and subagents as `systematic:<agent-stem>` — different from Systematic's canonical `ce:<name>` and `systematic:<category>:<name>` reference forms.
2. The plugin files must exist at an install source (a git ref the marketplace points at), but committing 148 copied skill/agent files into `main` duplicates the source of truth and rots.

The first implementation committed the generated bundle plus a drift check. That was the wrong instinct — it put copies in `main`. The shipped pattern removes them entirely.

## Guidance

**Build to gitignored staging; never commit the bundle.** `scripts/build-claude-code-plugin.ts` generates the bundle into `claude-code/`, which is gitignored build-only staging (`.gitignore`; assert `git ls-files claude-code/` is 0 in CI/tests). There is no committed artifact, so there is no drift check — the build *is* the source of truth.

**Translate identifiers on generated output only; keep source canonical.** The build rewrites references in the *generated* bodies to the host's namespace, leaving source untouched (source stays phantom-validated by `checkReferenceIntegrity`). Rules, inventory-driven and boundary-aware:

- `ce:<x>` → `systematic:ce-<x>` when `skills/ce-<x>/` exists
- `systematic:<category>:<name>` → `systematic:<name>` when the flattened agent stem exists
- bare `systematic:<name>` kept only if it resolves to a bundled skill dir or agent stem

Candidate matching uses a boundary-aware regex (`\b(?:ce:[a-z0-9-]+|systematic:[a-z0-9-]+(?::[a-z0-9-]+)?)\b`), and each candidate is looked up in an inventory built from the real discovered components — unknown tokens are never fabricated. A generated-namespace integrity gate (`checkGeneratedNamespace`) fails the build if any untranslated `ce:` form, leftover qualified ref, or unresolvable bare id survives. This is the build-output analogue of the source reference-integrity gate.

**Don't emit facts the build can't state truthfully.** `package.json` version is a `0.0.0-semantic-release` placeholder, so the plugin manifest omits `version` entirely (Claude Code versions the plugin by the source commit SHA of the published branch), and the `SessionStart` hook emits declarative counts only — no version, no name list.

**Publish from CI to an orphan branch, gated on release.** On push to `main`, a `publish-claude-code-plugin` job builds the bundle and fast-forwards it to the orphan `claude-code-plugin` branch (bundle at the branch root) with the built-in `GITHUB_TOKEN` (`permissions: contents: write` job-scoped; no App token or PAT — and `GITHUB_TOKEN` pushes do not recursively retrigger workflows). Publication is gated so the plugin never diverges from npm:

```yaml
if: github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.release.outputs.new-release-published == 'true'
needs: [build, typecheck, lint, test, release]
```

The `release` job exposes `new-release-published` / `new-release-version` (from the `semantic-release-export-data` plugin) as job outputs. First run creates the branch (`git worktree add --orphan -b claude-code-plugin`); later runs replace the tree and fast-forward — never `--force`, and a guard refuses to publish an incomplete bundle.

**Point a marketplace catalog at the branch.** `.claude-plugin/marketplace.json` on `main` (tracked, not gitignored) declares the plugin with `source: { source: github, repo: marcusrbrown/systematic, ref: claude-code-plugin }`. Users install with `claude plugin marketplace add marcusrbrown/systematic` then `claude plugin install systematic@systematic`.

## Why This Matters

- **Single source of truth.** No committed duplication of 148 files; the bundle is derived, not stored.
- **npm ↔ plugin lockstep.** Gating publish on an actually-cut release means the plugin never ships a non-release commit or a release-failed state. (Verified live: a `ci:` commit cut no release, so the publish job correctly *skipped* and the plugin branch stayed unchanged.)
- **Least-privilege, non-recursive publishing.** `GITHUB_TOKEN` scoped to one job, and its push to the orphan branch doesn't retrigger CI or Renovate.
- **No fake versioning channel.** SHA-based versioning avoids injecting npm's semantic version into a second distribution channel with its own cadence.

## When to Apply

Any time you distribute a build artifact for a plugin/extension host that (a) installs by copying the whole plugin directory, and (b) namespaces identifiers differently than your source. Build it, translate the generated output, gate the generated namespace, and publish from CI to a dedicated ref — rather than committing copies.

## Examples

Translation (generated output only):

```
source body:   see `ce:brainstorm`, then dispatch `systematic:research:repo-research-analyst`
built body:    see `systematic:ce-brainstorm`, then dispatch `systematic:repo-research-analyst`
```

Release-gated publish (`.github/workflows/main.yaml`) and first-run orphan creation:

```yaml
- name: Publish bundle to claude-code-plugin branch
  run: |
    if git show-ref --verify --quiet refs/remotes/origin/claude-code-plugin; then
      git worktree add "$WORKTREE_DIR" claude-code-plugin
    else
      git worktree add --orphan -b claude-code-plugin "$WORKTREE_DIR"
    fi
    # replace tree, git add -A, commit only if changed, push (never --force)
```

## Related

- [neutral-v1 marker + migrated-set identifier gate](./neutral-v1-marker-migrated-set-identifier-gate-2026-07-17.md) — sibling gate concept. Boundary: that gate operates on source marked `neutral-v1`; this translation operates only on *generated* output. Do not extend either to rewrite canonical source IDs.
- [Qualified persona IDs are canonical validated references](./qualified-persona-ids-are-canonical-validated-references-2026-07-17.md) — the canonical complement: source keeps qualified IDs (phantom-validated); the CC build translates them only in generated output, preserving validation coverage on both sides.
- [reconciliation-sync reference integrity](../workflow-issues/reconciliation-sync-reference-integrity-20260417.md) — origin of the reference-integrity checks; the source-side skill-ref gate added in this arc is its descendant.
- [OpenCode plugin named exports break the loader](../integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md) — published-artifact shape gate; packaging precedent.
- [Typed config validation via build-time codegen](./typed-config-validation-build-time-codegen-2026-05-16.md) and [Registry drift on skill description change](../workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md) — generated-artifact precedents.
- [Verify installed artifacts, not just build gates](../workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md) — the verification lesson from the same arc.
