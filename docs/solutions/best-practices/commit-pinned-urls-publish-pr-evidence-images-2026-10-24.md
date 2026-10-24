---
title: Publish PR evidence images through commit-pinned URLs and verify the bytes before linking
date: 2026-10-24
category: best-practices
module: pull-request-workflow
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - Publishing local screenshots or other images as evidence in a pull request description
  - An image link must keep working after its branch is squash-merged and deleted
  - Embedding images from a private repository in a PR body
  - Committing image bytes where gitattributes may set text, eol or filter
  - Checking that an embedded image URL serves the intended image
tags: [pr-attachments, evidence-images, raw-githubusercontent, commit-pinned-urls, private-repos, gitattributes, blob-sha]
---

# Publish PR evidence images through commit-pinned URLs and verify the bytes before linking

## Context

The `pr-attachments` skill commits screenshots under `docs/evidence/<topic>/` on the PR branch and embeds
them in a `## Demo` section of the description. The links must keep rendering after the PR is
squash-merged and the branch is deleted, and they must show exactly the bytes the user approved.

What is known about how GitHub serves these files
([plan](../../plans/2026-10-22-002-feat-pr-attachments-skill-plan.md)):

- Earlier attempts showed that a branch-ref link broke after its branch was deleted (panthea#104), and
  that a commit-pinned `raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>` link kept serving after
  squash merge, branch deletion and cleanup (fro-bot/dashboard#599). GitHub does not document that the PR
  head ref keeps the commit reachable; this is inferred.
- Raw content served a PNG as `image/png` up to exactly 10,485,760 bytes, and one byte more as
  `application/octet-stream`. Only PNG was measured.
- In a private repository the raw form did not render in the PR description, even for signed-in
  members. The blob form `github.com/<owner>/<repo>/blob/<sha>/<path>?raw=true` did render. Whether a blob
  link survives branch deletion follows from the commit pin and was not probed.
- A raw URL returned 404 for 46 to 62 seconds after the push, in one measured run.

## Guidance

**Pin by commit SHA, chosen with merge-aware history.** `newestCommitForPaths` in
`skills/pr-attachments/scripts/pr-attachments.mjs:1623-1629` runs `git log --topo-order -m --no-renames
--diff-filter=AM`, so a merge that resolved the file counts as the commit that changed it. A plain
`git log -n 1` can return a parent whose blob is an older image.

**Require the pinned blob to equal the classified blob.** `selectReport` compares the blob at the pin with
`expectedBlob` and refuses a mismatch (`skills/pr-attachments/scripts/pr-attachments.mjs:1802`). The public
check alone cannot catch a wrong image, because `IMAGE_TYPE` accepts any `image/*` type
(`skills/pr-attachments/scripts/pr-attachments.mjs:1999`).

**Check the bytes git actually stored.** A `.gitattributes` `text`, `eol` or `filter` setting can rewrite
image bytes at `git add`. The skill refuses those attributes on the destination (`destination-blocked`),
then compares the staged and committed blobs with the classified one (`blob-mismatch`) before pushing
(`skills/pr-attachments/SKILL.md:227-302`). `text=auto` is accepted: git's binary check (a NUL byte in the
first 8000 bytes) always holds for PNG, whose header length field contains one, and the blob comparisons
cover any other image git normalizes. The source is re-hashed with `git hash-object --no-filters` just
before the copy.

**Reject files over 10 MiB before publishing.** `DEFAULT_MAX_BYTES` is `10 * 1024 * 1024`
(`skills/pr-attachments/scripts/pr-attachments.mjs:230`). The limit applies to every image type.

**Use the blob form in private repositories and verify through the API.** An anonymous HTTP fetch cannot
see a private repository, so the skill asks the contents API for the blob SHA at the pin and compares it
with the classified blob. The loop makes four attempts five seconds apart and reports `API_FAILED`
separately from a mismatch (`skills/pr-attachments/SKILL.md:440-444`). `demoText` builds both URL forms
(`skills/pr-attachments/scripts/pr-attachments.mjs:1760-1768`).

**Retry the public check within a budget that survives stateless calls.** `DEFAULT_MAX_WAIT_MS` sets the
default wait per call to 90 seconds, and `TOTAL_BUDGET_MS` caps the whole run at 300 seconds
(`skills/pr-attachments/scripts/pr-attachments.mjs:1994-1995`); a caller can raise one call's wait with
`max_wait_s`. The helper keeps no state, so a `Retry-After` that outlasts the call comes back as a
`resume_at` deadline. `serveCooldown` sleeps until that deadline before the first request, up to the
call's limit. If the deadline is still ahead at the limit, it sends nothing and returns the same
`resume_at`; it also sends nothing when the wait would pass the 300-second total
(`skills/pr-attachments/scripts/pr-attachments.mjs:2286-2318`).

**Push plainly and ask the remote after a failure.** Never force, and refuse a push target that is the
default branch. When the push exits non-zero, `ls-remote` decides whether it landed; if it did not, the
status line reports `evidence=local` (`skills/pr-attachments/SKILL.md:331-345`).

## Why This Matters

Content-type checks pass for the wrong image. A merge-resolved pin, a normalized blob or a source edited
after approval all serve a valid `image/png`, so only blob-SHA equality proves the description shows what
the user approved. A single immediate fetch after a push fails on propagation lag, and a retry loop that
forgets `Retry-After` between calls hammers a rate-limited endpoint.

## When to Apply

- A skill or script publishes images into a repository and links them from a PR or issue.
- Links must outlive the branch that carried the files.
- The repository may be private, or may carry gitattributes the tool does not control.
- A verification loop runs across separate, stateless helper calls.

## Examples

Pin selection with the blob check, from `skills/pr-attachments/SKILL.md`:

```bash
node "$SKILL_DIR/scripts/pr-attachments.mjs" pins <<'JSON'
{"select": [{"path": "<destination 1>", "blob_sha": "<blob_sha 1>"}], "head_repo": "<owner/repo of the head repository>", "form": "<raw or blob>", "out_file": "<demo file>"}
JSON
```

## Related

- [Edit a user-owned Markdown section with a fail-closed shape guard](fail-closed-shape-guard-for-user-owned-markdown-edits-2026-10-24.md)
- [The PR title selects the release type under squash merge](../workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md)
- Tracking issue: #1073
