---
title: "fix: Place git worktrees at .worktrees/ and make the git-worktree skill idempotent"
type: fix
status: completed
date: 2026-10-25
---

# fix: Place git worktrees at .worktrees/ and make the git-worktree skill idempotent

## Problem

Agents place git worktrees in arbitrary locations (sibling directories, `/tmp`, a path inside another worktree) instead of `.worktrees/`. The skill's script also appends `.worktrees` to the root `.gitignore` on a check that is not idempotent, and it checks out and pulls `main` in the caller's checkout, reads stdin, and assumes `main` is the default branch. An earlier attempt (branch `fix/git-worktree-placement`) fixed this but grew the script from 500 to 1,780 lines. This plan rebuilds it from main's script with only what the ask needs.

The ask: put worktrees in `.worktrees/`, make the ignore update idempotent, refresh the skill with `writing-skills`, and add a bootstrap instruction for where worktrees go.

## Requirements

Script (`skills/git-worktree/scripts/worktree-manager.sh`). Exit codes are 0 ok, 1 error, 2 usage and 3 refused, with `error: <code>: <message>` on stderr.

1. **Placement.**
   - Worktrees go at `<main-root>/.worktrees/<branch>`, with slashes nested.
   - The main root is the parent of `git rev-parse --git-common-dir`, so a run from a linked worktree still lands there.
   - Bare, `core.bare`, separate git dir and submodule layouts exit 3 `unsupported-layout`.
2. **Main checkout untouched.**
   - No switch, pull, stash or edit of the main checkout's branch, index or tracked files.
   - Only `.worktrees/` is written.
3. **Ignore policy.**
   - Never touch the root `.gitignore`.
   - Write `.worktrees/.gitignore` (`*`) only when missing. Leave an existing one. Warn on a tracked one.
   - After `git worktree add`, `git status --porcelain -- .worktrees` must be empty, else exit 1. No rollback.
   - A second run changes nothing.
4. **Base.**
   - `--base <ref>` uses a local ref with no fetch.
   - Otherwise the default branch comes from `origin/HEAD`, then `ls-remote --symref`, else exit 3 `base-unresolved`. It never falls back to `main`.
   - One `git fetch origin <default>`. A failure exits 1 with the first stderr line and suggests `--base`.
   - Create with `git worktree add --no-track -b`. `branch-exists` and `target-exists` exit 3.
5. **Non-interactive.**
   - No stdin reads. `mise trust` and `direnv allow` run with `</dev/null` under main's existing trust safeguards.
   - `create` prints `branch=`, `base=` and, last, `path=` on stdout. Prose goes to stderr.
6. **list and switch.**
   - `list` parses captured `git worktree list --porcelain`, so `feat/x` shows.
   - `switch <name>` prints the path only.
7. **copy-env.**
   - Copies only git-ignored `.env*` regular files.
   - Skips tracked files, symlinks and existing destinations. No `.backup` files.
8. **cleanup.**
   - Report-only by default: one line per worktree with `name= path= branch= state= modified= untracked= ignored=`.
   - `--remove <name>...` removes only `clean` worktrees, with no `--force`.
   - Every other state is refused with `reason=` and exit 3.
   - It never deletes branches, runs `rm -rf`, or removes `.worktrees/`.
9. **Portability.**
   - Runs on macOS `/bin/bash` 3.2.
   - Strips only the repository-locating `GIT_*` variables. Sets `LC_ALL=C`.

Content:

- **Bootstrap rule.** One short rule in the shared bootstrap (OpenCode, Pi, Claude Code output style): create worktrees at `.worktrees/<branch>` with the `git-worktree` skill, and follow a named location or tool instead.
- **Skill.** `SKILL.md` is rewritten (about 400–600 words) with `writing-skills`. It covers the earlier pressure-run failures:
  - placement and parallel PRs
  - dirty cleanup and "nuke them all"
  - PR review base
  - `cd` persistence
  - existing target
  - `master` default
  - the `AGENTS.md` location
- **Pointers.** `ce-review`, `orchestrating-subagents` and `git-clean-gone-branches` point at the skill.
- **Clean-gone.**
  - No `--force`.
  - Exact porcelain match.
  - Skip main and the current worktree.
  - Keep the branch when worktree removal fails.

## Out of scope

- a fetch watchdog or timeouts
- signal handling or rollback
- `--existing` or `local_behind`
- `--protect` or `--include-dirty`
- `merged`, `unpushed` or `unreachable` fields
- deepest-first nested cleanup
- pruning the `.worktrees/` container
- trust output keys, a warning protocol or a `warnings=` count
- `--force` on create
- moving existing worktrees
- model pressure runs or a live harness session

## Files touched

- Script and skill: `skills/git-worktree/{SKILL.md,scripts/worktree-manager.sh}`.
- Pointers: `skills/{ce-review,orchestrating-subagents,git-clean-gone-branches}/SKILL.md`.
- Bootstrap: `skills/using-systematic/references/worktree-placement.md`, `src/lib/bootstrap.ts`, `src/index.ts`, `src/pi.ts`, `scripts/build-claude-code-plugin.ts`, `src/lib/AGENTS.md`.
- Docs: `ARCHITECTURE.md`, `HARNESSES.md` (WT-1, WT-2), `docs/src/content/docs/guides/architecture.mdx`, `docs/solutions/logic-errors/pi-chained-bootstrap-composition-2026-07-14.md`, `registry/registry.jsonc` (generated).
- Tests: `tests/unit/git-worktree-{fixtures.ts,manager.test.ts,cleanup.test.ts,skills-contract.test.ts}`, plus the bootstrap, Pi, plugin, Claude Code build and integration tests.

## Verification

- The new worktree tests run under `bash` and under `TEST_BASH=/bin/bash` (3.2), written test-first. The RED run against main's script and a mutation per area (ignore policy, base fallback, cleanup refusal) each fail a named test.
- `bun test tests/unit`, `bun run typecheck:all`, `bunx biome check` on changed TS, `bun scripts/content-integrity.ts`, `bun run registry:drift`, `bun scripts/generate-pi-subagents-personas.ts --check`, `bun run schema:drift`, `bun run build`, markdownlint on changed markdown, and `bun test tests/integration/claude-code.test.ts`.
- No live harness session or model pressure run. A subagent pressure check follows separately.
