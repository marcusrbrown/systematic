---
title: Edit a user-owned Markdown section with a fail-closed shape guard, not more parser coverage
date: 2026-10-24
category: best-practices
module: pull-request-workflow
problem_type: design_pattern
component: tooling
severity: high
applies_when:
  - A tool replaces or copies one section of a Markdown document that a person also edits
  - A scanner for fences, comments and HTML blocks keeps missing cases
  - Choosing between wider parser coverage and refusing input the tool did not write
  - Carrying a managed section from an old document into a regenerated one
tags: [user-owned-markdown, pr-description, fail-closed, shape-guard, markdown-scanner, demo-section, parser-coverage]
---

# Edit a user-owned Markdown section with a fail-closed shape guard, not more parser coverage

## Context

The `pr-attachments` helper owns one section of a PR description, `## Demo`. It replaces or copies that
section and must leave every other byte alone. Finding the section's boundaries needs a Markdown scanner,
and it misread several structures. Each one turned a literal `## Demo` into the managed heading, and the
splice then removed text that followed it:

- A fence opened inside a list item, or a `<pre>` block, holding a literal `## Demo`.
- Two separate four-space indented examples of a backtick fence on either side of a real `## Tests`
  heading. Read as one container fence, they opened and closed cleanly, so a guard against unterminated
  blocks never fired.
- A comment holding `--!>` before its `-->`. Browsers end a comment at `--!>`. The reference
  implementation, cmark-gfm at `0.29.0.gfm.13`, ends a comment block only at a literal `-->`
  ([`_scan_html_block_end_2`](https://github.com/github/cmark-gfm/blob/0.29.0.gfm.13/src/scanners.re),
  line 215). GitHub's production renderer is not pinned publicly, so treat that as the reference
  behaviour.

## Guidance

**Gate every replace and copy on the shape of the section, not on parser accuracy.** Before the helper
replaces an existing section or returns it for carrying, `holdsOnlyWrittenLines` checks that every
non-blank line under the heading matches `DEMO_EMBED_LINE`
(`skills/pr-attachments/scripts/pr-attachments.mjs:1120-1132`). `DEMO_EMBED_LINE` accepts an image embed
in raw or blob form under `docs/evidence/` (`skills/pr-attachments/scripts/pr-attachments.mjs:1336-1338`).
That is looser than what `demoText` writes (`skills/pr-attachments/scripts/pr-attachments.mjs:1760-1768`):
any owner and repo, and any alt text in the file-stem character set. The check is by shape, not origin.
Any other line, such as a heading, fence, table, HTML or prose, means the boundary is wrong or the content
is not managed. Splice and extract then exit 1 with `result: needs-input` and an
`unexpected-section-content` ask, and write nothing. Splice checks `holdsOnlyWrittenLines` before it
replaces anything (`skills/pr-attachments/scripts/pr-attachments.mjs:1208-1209`), and extract checks
`holdsOnlyWrittenLines` before it returns the section
(`skills/pr-attachments/scripts/pr-attachments.mjs:1305-1306`).

**Keep the scanner conservative too.** The guard cannot catch a section that looks managed but is hidden,
such as an embed-only Demo inside a comment, so the scanner still errs toward hiding:

- The managed heading counts only at column 0 (`DEMO_HEADING`,
  `skills/pr-attachments/scripts/pr-attachments.mjs:814`).
- A fence counts wherever it opens, also inside a list item or quote, and four-space indented code with no
  container marker is never a fence.
- `scanMarkdown` skips every line inside a fence, a comment or a `<pre>`, `<script>`, `<style>` or
  `<textarea>` block (`skills/pr-attachments/scripts/pr-attachments.mjs:952-965`), and block quotes and
  indented code hide headings too. A block left open inside the section returns `unterminated-region`.
- `COMMENT_END` matches both `-->` and `--!>`, but only `-->` ends the block
  (`skills/pr-attachments/scripts/pr-attachments.mjs:836`). `readCommentLine` marks a `--!>` before it as
  ambiguous (`skills/pr-attachments/scripts/pr-attachments.mjs:852-861`). A body whose scan sets
  `ambiguousComment` is refused as a whole (`skills/pr-attachments/scripts/pr-attachments.mjs:1195-1196`).

**Never hand-write the section when the tool refuses.** When the `pr-attachments` carry ends with
`status=failed`, the caller leaves the description as it is and offers to retry, to apply the new body
without a Demo section after an explicit yes, or to keep the current description
(`skills/git-commit-push-pr/SKILL.md:317-318`).

## Why This Matters

Patching the scanner one structure at a time converges slowly, and each miss removes a user's text. The
shape guard changes the failure mode, not the coverage: whatever the scanner gets wrong, a section holding
any line that is not an image embed of the managed shape is never replaced. The cost is deliberate: a
hand-edited Demo section is refused, and the user moves the extra content out of it.

## When to Apply

- A tool owns a bounded region of a document that people also edit.
- The surrounding format is hard to parse exactly (Markdown, HTML, YAML in prose).
- The write is destructive or hard to notice afterwards.
- The same feature keeps needing new parser cases.

## Examples

Refused shapes are pinned by the `FOREIGN` table in `tests/unit/pr-attachments-splice.test.ts:1948`,
and the ambiguous comment by the `ARCHIVED` fixture in `tests/unit/pr-attachments-splice.test.ts:2194`.

Splice refuses this section, because its third line is not an embed, and writes nothing:

```markdown
## Demo

![login](https://raw.githubusercontent.com/<o>/<r>/<sha>/docs/evidence/login/login.png)

Some notes the user added.

## Tests
```

## Related

- [Publish PR evidence images through commit-pinned URLs](commit-pinned-urls-publish-pr-evidence-images-2026-10-24.md)
- [A source-scanning guard needs its blind spots measured, not reviewed](measure-a-source-scanner-blind-spots-2026-09-07.md)
- [A fail-closed component reports its own state](../workflow-issues/fail-closed-components-report-their-own-state-2026-08-23.md)
- [ReDoS after a plugin trust-boundary inversion](../security-issues/redos-after-plugin-trust-boundary-inversion-2026-05-11.md)
