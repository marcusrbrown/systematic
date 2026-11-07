---
title: A shared config file hid an invalid sibling and the search opt-out
date: 2026-11-05
category: logic-errors
module: config-system
problem_type: logic_error
component: configuration
symptoms:
  - "systematic search ran although the user config set search.enabled to false"
  - "A protected setting applied from an aliased local file was reported as blocked, with misleading ignored-field warnings"
  - "An invalid user config file vanished from the observation metadata when another file in its kind was shared with a higher-priority kind"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [config, observation-metadata, dedupe, symlink-alias, local-overlay, search-opt-out, fail-safe]
---

# A shared config file hid an invalid sibling and the search opt-out

## Problem

A dedupe keyed by file identity cannot see a failure, because a file that fails to load has no identity. Observation metadata has one row per kind (`user`, `custom`, `project`), and each kind folds a base file and its `.local` sibling. When one file was reachable from two kinds, the dedupe dropped a kind's row. In one arrangement that row was the only record of an invalid file, so `systematic search` ran although `search.enabled` was `false`.

The PR review caught this on #1295 before release. v3.31.0 shipped the corrected rule.

## Symptoms

All of these were found by the PR review, which reproduced them with alias fixtures:

- In the PR's first round, a project config symlinked to `custom.local` applied its protected agent model. The observation metadata still reported the model as blocked, and ignored-field warnings appeared. The fold had kept only the base file's identity.
- In the PR's second round, after the first fix, the opt-out was lost in this arrangement:
  - the user base file set `search.enabled: false` next to an invalid non-search field (a numeric agent model);
  - the user `.local` file and a separate custom base file both held `{}`;
  - the custom `.local` file was a symlink to the user `.local` file.

  The user kind's row disappeared, `loadSearchSettingsForCli` saw no invalid source, skipped its fallback and ran search. The same arrangement without the symlink kept the opt-out.

## What Didn't Work

- **One identity per kind.** The first fold kept only the base file's canonical path. A project file that was the kind's `.local` file was not recognised as the same file, so a field that had been applied was reported as blocked.
- **Every sibling's identity, but a dedupe per kind.** The first fix had two parts: `FoldedConfigSource.canonicalPaths` keeps the canonical path of every loaded file, and `resolveAliasedConfigFiles` checks all four user-level layers against the project file. That resolved the false "blocked" report. The dedupe still dropped a whole kind as soon as any one of its loaded files had already been reported by a higher-priority kind. A shared file therefore took the unshared sibling's row with it, including the row of a sibling that had failed to load.

## Solution

`dedupeSourceMetadata` now decides redundancy per kind, and only when nothing in the kind is left unreported (`src/lib/config.ts:2856-2875`):

```ts
const redundant =
  files.length > 0 &&
  files.every((file) => seen.has(file)) &&
  presence !== 'invalid'
if (redundant) continue
```

Each part of the condition covers a different case:

- `files.length > 0`: a kind with no loaded file has nothing to be redundant with. Without it, `every` is vacuously true for an empty list.
- `files.every((file) => seen.has(file))`: a kind with a loaded file of its own keeps its row. Only a kind whose loaded files were all reported already is redundant. `tests/unit/config.test.ts:7330-7346` (`a present file next to a shared one keeps its kind row`) pins this: the user base is shared with a custom base, the user `.local` file is not, and the user row stays.
- `presence !== 'invalid'`: this fixes the reproduction. The invalid user base never loads, so it has no path. The user kind's only loaded file is the shared `user.local`, so `every` alone would still drop the row. `invalid` presence is the only record of the failure, so it is never redundant.

## Why This Works

- A file that fails validation never becomes a source. `LayeredSources` holds `null` for a layer with no valid file (`src/lib/config.ts:1473-1480`), so such a file adds nothing to the kind's path list. The failure survives only as the kind's `presence: 'invalid'`, which `foldKindMetadata` carries (`src/lib/config.ts:2735-2744`).
- `loadSearchSettingsForCli` falls back to the user-level reader when the full load throws or reports an invalid source (`src/cli.ts:560-614`). That fallback keeps `search.enabled: false` when the full loader drops a whole invalid file, as its doc comment explains. Here the load did not throw, so the invalid row was the only signal, and losing it switched the fail-safe off.
- `foldSiblingSources` keeps every loaded file's canonical path (`src/lib/config.ts:2719-2732`), so aliasing is still recognised for any sibling and the first-round defect stays fixed.

## Prevention

- **Dedupe the members, not the aggregate.** When an aggregate folds several things, compare member identities. Do not remove the aggregate because one member matched.
- **A failure is not interchangeable with a success.** A dedupe must never remove a failure observation. It is often the only input to a fail-safe.
- **Test the consumer as well as the metadata.** `tests/unit/cli.test.ts:4398-4484` covers an invalid base beside a shared `.local` file, an invalid `.local` file beside a shared base, and an unlinked control. Each case asserts that `loadSearchSettingsForCli` returns `{ enabled: false }` with `unreadable: true`. `tests/unit/config.test.ts:7268-7346` asserts the metadata rows themselves.
- **Config test matrices need alias fixtures and same-name fixtures.** Include a symlinked local file shared across kinds, and entries that share a name across layers (see the related doc on diagnostics). The PR review reproduced both defects with these fixtures; reading the code did not surface them.
- **After fixing an aliasing bug, rerun the neighbouring matrix: partial alias × invalid sibling.** In #1295 the first alias fix introduced the second defect.

## Related Issues

- #1295 (introduced the fold and the dedupe) and #1299 (follow-up that bounds every config read)
- `docs/solutions/best-practices/attribute-diagnostics-to-the-declaration-that-emitted-them-2026-11-05.md`
- `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md`
- `docs/solutions/best-practices/merge-chain-position-as-a-structural-guarantee-2026-09-20.md`
- `docs/solutions/best-practices/removing-config-key-strict-schema-2026-10-19.md` (the precedent for deduping warnings by canonical path)
- `docs/solutions/logic-errors/unreadable-search-root-reported-empty-while-macos-test-passed-2026-11-03.md` (a failure shown as a quiet success)
