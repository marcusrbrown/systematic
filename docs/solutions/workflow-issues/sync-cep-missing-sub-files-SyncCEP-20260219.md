---
title: Multi-file batch imports drop tree-structured content without an integrity check
date: 2026-02-19
last_refreshed: 2026-05-16
category: integration-issues
problem_type: integration_issue
component: tooling
severity: high
applies_when:
  - A batch import or sync workflow consumes a manifest of file paths and copies them into the local tree
  - The import code path may silently fail per-file without aggregate signal (return null, swallow exceptions, skip on first missing dependency)
  - Verification runs against the imported result rather than against the original manifest
  - Skills, plugins, or assets are organized as multi-file trees (SKILL.md + references/ + scripts/ + assets/) and a single file's absence breaks the unit
tags:
  - batch-import
  - multi-file
  - manifest
  - integrity-check
  - silent-failure
  - skill-import
  - sub-files
  - tree-structured-content
related_components:
  - tooling
---

## Problem

A batch import workflow consumes a manifest enumerating tree-structured content
(e.g., `skills/<name>/{SKILL.md, references/*.md, scripts/*.mjs, assets/*}`) and
copies each file into the local tree. When the import code path has a per-file
bug — a missing recursion step, an exception swallowed by `try { … } catch { return null }`,
a file-type check that skips non-`.md` extensions — files silently disappear. The
manifest reports "N files imported" because it enumerated N paths, but only M < N
actually landed on disk. The verification step runs against the imported result
(e.g., "do all imported skills have a SKILL.md?") and reports green because every
imported skill HAS a SKILL.md — the missing files are sub-files no one checked.

This is the same class of failure as the zsh for-loop word-splitting bug (different
mechanism, same shape): the work appears to run, no errors surface, and the
verification has the same blind spot as the actor it's verifying.

**Original instance (now historical):** The `/sync-cep` batch-import workflow
(deleted in PR #243, April 2026) fetched `SKILL.md` for each skill but silently
dropped `references/`, `scripts/`, and `assets/` sub-files. The precheck
enumerated sub-file paths from the manifest, but the import code path only
processed the first file per skill. The verification grep confirmed that every
imported skill had a `SKILL.md` — which was true — and reported success.

The lesson generalizes to any workflow that imports tree-structured content from
a source location.

## Symptoms

- A workflow reports "imported N items" but the resulting tree contains only the
  top-level file per item, not sub-files
- `references/`, `scripts/`, `assets/` directories are empty or missing for items
  that should have them
- Skills, plugins, or agents that depend on sub-files fail at runtime
  ("Cannot find file …") well after the import completes
- Verification grep against the imported tree returns green because it asserts
  presence of top-level files, not sub-files
- The git diff for the import shows N files added (matching the top-level
  enumeration), giving false confidence

## What Didn't Work

**Assumption: "the manifest is the contract."** True at the per-item level — the
manifest names each item. False at the per-file level — the manifest may enumerate
sub-files but the import code path doesn't iterate them. The manifest is an INPUT
to the import; whether each path actually landed on disk is a separate question.

**Assumption: "tests pass, build green = import worked."** Markdown content has
no compile-time signal. The build doesn't notice missing `references/` files until
a downstream consumer tries to read one. A unit test for the import's success-path
doesn't help when the bug is in the iteration logic itself.

**Assumption: "the verification grep would catch missing files."** The verification
grep looked for top-level files (`SKILL.md`) because that's what the import was
supposed to produce. It didn't compare the imported tree against the original
manifest's full file list. Same shape as the zsh for-loop verification bug: when
verification and import share blind spots, both pass together silently.

## Solution

The surviving enforcement mechanism (post-divorce from the deleted `/sync-cep`
workflow) is `scripts/content-integrity.ts`. It scans every `skills/<name>/SKILL.md`
for path references in `references/`, `scripts/`, `templates/`, and `assets/`,
then asserts each path resolves on disk. CI runs it on every PR. The check
operates on the SHIPPED tree, not on the imported tree.

The pattern that catches this class of bug is **declarative path enumeration with
on-disk verification**:

```ts
// scripts/content-integrity.ts (paraphrased)

/**
 * Subdirectories whose paths, when mentioned inside a SKILL.md, denote
 * sub-files of that skill.
 */
export const SUBFILE_DIRECTORY_NAMES = [
  'references',
  'scripts',
  'templates',
  'assets',
] as const

/**
 * Match relative paths under a skill's sub-directory:
 *   `references/foo.md`, `scripts/foo.sh`, `templates/foo.md`, etc.
 */
const SUBFILE_PATH_REGEX = new RegExp(
  `(?:^|[\\s\\(\`])(\\.\\/)?` +
    `((?:${SUBFILE_DIRECTORY_NAMES.join('|')})\\/[\\w./-]+\\.(?:md|json|ya?ml|sh|ts|js|mjs|txt|py))`,
  'g',
)

/**
 * Verify every sub-file path mentioned in a `skills/<name>/SKILL.md` resolves
 * to an actual file in that skill directory.
 */
export function checkSubfileReferences(
  rootDir: string,
  markdownFiles: readonly string[],
): BrokenSubfileRef[] {
  const broken: BrokenSubfileRef[] = []

  for (const relPath of markdownFiles) {
    if (!isSkillEntryFile(relPath)) continue
    const absPath = path.join(rootDir, relPath)
    const content = readFileSafe(absPath)
    if (content === null) continue

    const skillDir = path.dirname(absPath)
    const lines = content.split('\n')
    for (const line of lines) {
      for (const match of line.matchAll(SUBFILE_PATH_REGEX)) {
        const reference = (match[2] ?? '').trim()
        if (reference.length === 0) continue
        const resolvedAbs = path.join(skillDir, reference)
        if (!fs.existsSync(resolvedAbs)) {
          broken.push({ skillFile: relPath, missingPath: resolvedAbs })
        }
      }
    }
  }

  return broken
}
```

The check is structural, not workflow-specific. It doesn't care whether the file
got there via batch import, manual copy, or a CLI conversion — it only asserts
that every cited path resolves. This makes it robust to whatever import mechanism
is in use today (or tomorrow).

## Why This Works

The check operates on the SHIPPED CONTENT (`skills/<name>/SKILL.md` declares
sub-files; sub-files must exist) rather than on the IMPORT PROCESS. This decouples
the enforcement from any particular workflow:

- The deleted `/sync-cep` batch-import workflow would have been caught by this check
- An ad-hoc `git cp` that forgot a sub-file would be caught
- A future generator that produces SKILL.md but skips reference files would be caught
- A skill that references a sub-file that was renamed or deleted would be caught

The shipped tree is the ground truth; the workflow that produced it is incidental.

## Prevention

- **Don't trust a workflow's reported "files imported" count.** That number reflects
  what the workflow ATTEMPTED to import, not what landed.
- **Verify against the original manifest, not against the imported tree.** If you
  have a manifest of expected paths, diff the imported tree against it explicitly.
  Don't grep for top-level files and call it done.
- **Encode integrity invariants in CI, not in the importer's success path.** A
  separate check that runs against the shipped state catches importer bugs the
  importer itself can't see.
- **Pair top-level checks with structural checks.** "Every skill has a SKILL.md"
  is necessary but not sufficient. "Every path referenced by any SKILL.md resolves
  on disk" is what catches sub-file drops.
- **For tree-structured imports, enumerate sub-files explicitly.** A manifest that
  says "import skill X" is insufficient; one that lists "skill X has files [a, b, c]"
  gives the verifier something to check against.
- **When importing via `try/catch return null`, log the catch.** Silent error
  swallowing makes import bugs invisible. At minimum, log "skipped \<path\>: \<reason\>"
  so the import's "imported N files" count is decomposable.

## Related

- `docs/solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-20260417.md` —
  same failure class (silent batch operation + matching-blind-spot verification),
  different mechanism (shell semantics vs import iteration)
- `docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md` —
  adjacent integrity check (cross-skill references, not within-skill sub-files);
  both ride on `scripts/content-integrity.ts`
- `scripts/content-integrity.ts` (`checkSubfileReferences`) — the surviving
  enforcement that catches this class of bug
- `src/lib/converter.ts` — still available for ad-hoc CC-format conversion via
  CLI, with the same per-file integrity caveat
- PR #243 — deleted the `/sync-cep` workflow this original bug was reported against
- PR #301 (v2.5.0) — introduced the content-integrity gate that catches the
  modern equivalent
