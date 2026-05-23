---
title: "feat: Add release-notes-narrative project-scoped skill"
type: feat
status: active
date: 2026-05-23
origin: docs/brainstorms/2026-05-23-release-notes-narrative-skill-requirements.md
---

# feat: Add release-notes-narrative project-scoped skill

## Overview

Author a new project-scoped skill at `.agents/skills/release-notes-narrative/` that turns sparse semantic-release output into useful changelog narrative. The skill is loaded on demand to patch published GitHub release bodies via `gh release edit --notes-file`, defending against two known release-notes-generator failure modes already observed on this repo's releases.

The work is bounded: one skill body + two reference sub-files + a one-line cross-link from `.agents/skills/README.md` + a one-bullet cross-link from an existing solution doc + an acceptance pass against two historical bare-body releases (v2.20.5 and v2.20.6) + a compound doc capturing the procedure. No CI automation, no `.releaserc.yaml` changes, no semantic-release plugin additions.

## Problem Frame

`@semantic-release/release-notes-generator` with the `conventionalcommits` preset emits release bodies built from commit SUBJECT lines only — commit bodies and PR descriptions are never ingested. The generator does produce useful structure when given a multi-commit range with conventional types (it buckets commits under `### Features`, `### Bug Fixes`, `### Build System`, etc.) — the v2.20.5 and v2.20.6 releases on this repo demonstrate that working as designed. The failure mode the skill targets is narrower and qualitative: when each bucket contains one or two terse bullets like `* **ci:** add OpenCode group name to Renovate config (#425)`, readers cannot tell what actually changed or why it matters without clicking through to the PR. The skill replaces those mechanical bullets with AI-assisted narrative drawn from commit bodies and PR descriptions — the same content the generator throws away. The same generator also misparses any `path#fragment` substring in a commit body as a `Closes #N` footer and emits broken auto-links pointing at `github.com/<path>/issues/<fragment>` (memory `#3760`, observed on v2.21.0).

Both failure modes are post-publish: by the time the bad body is visible, semantic-release has already finished. The current mitigation is manual `gh release edit` with hand-written narrative — proven on v2.21.0 in this session, but slow, easy to forget, and the format drifts between releases. The skill formalizes the procedure so any agent loaded into this repo can reproduce it consistently. (see origin: `docs/brainstorms/2026-05-23-release-notes-narrative-skill-requirements.md`)

## Requirements Trace

- R1. Skill lives at `.agents/skills/release-notes-narrative/SKILL.md` as project-scoped (not bundled). (origin R1) — Units 1, 4
- R2. Frontmatter declares `name`, a `Use when...` description naming the two failure modes by symptom, and optional `argument-hint`. (origin R2) — Unit 1
- R3. Skill body is concise; reference material in `references/` sub-files. (origin R3) — Units 1, 2, 3
- R4. Procedure collates commit log between release tags as primary; enriches with PR body when single-squash + thin commit body. (origin R4) — Unit 1
- R5. Procedure uses the hardcoded `.releaserc.yaml` `presetConfig.types` bucket mapping. (origin R5) — Unit 1
- R6. Rendered body has `## What's new` + "Also in this release" + Compare link. (origin R6) — Unit 1
- R7. Autolink strip uses positive allowlist: GitHub `issues/<non-digit-segment>` URLs preceded by `closes`. (origin R7) — Units 1, 2
- R8. Apply via `gh release edit v<version> --notes-file <tmpfile>`. (origin R8) — Unit 1
- R9. Structurally idempotent: rerunning against the same `(previous_tag, current_tag, commit_range_contents)` produces the same buckets, the same Compare link, and the same set of referenced PRs and commits. Narrative prose wording may vary by run (LLM nondeterminism is expected); structure must not. (origin R9, refined) — Unit 1
- Acceptance: skill is run successfully against v2.20.5 and v2.20.6, producing before/after artifacts. (origin Success Criteria) — Unit 6

## Scope Boundaries

- **Out: CI automation.** No `.github/workflows/` changes. No `@semantic-release/exec` plugin. No `.releaserc.yaml` modifications.
- **Out: Fixing semantic-release at the source.** The skill's defensive allowlist is the v1 mitigation.
- **Out: Dynamic bucket lookup.** Bucket mapping is hardcoded in the skill body.
- **Out: HUMAN:KEEP sentinel preservation.** Deferred to v2.
- **Out: First-release-ever handling.** Not a v1 problem.
- **Out: Per-tag override files.** Not in v1.
- **Out: Bundling / generalization.** The skill is project-specific to this repo.

### Deferred to Separate Tasks

- v2 CI automation via `@semantic-release/exec` post-hook: separate PR, after v1 proves the skill on retroactive patches.

## Context & Research

### Relevant Code and Patterns

- `.agents/skills/generating-project-docs/SKILL.md` (149 lines) — local template for project-scoped skill structure: frontmatter (`name`, `description`, `argument-hint`), opinionated body with "When to Use / Not Use / Arguments / Inventory / Style Rules / Section Order / Quality Checks" structure, single `SKILL.md` (no sub-files). The new skill follows the same shape but adds two `references/` sub-files because the autolink allowlist semantics and historical corpus both deserve depth.
- `.agents/skills/README.md` — defines the project-scoped skill boundary and convention. Must be updated to cross-reference the new skill.
- `.releaserc.yaml:46-70` — authoritative `presetConfig.types` bucket mapping (11 entries: feat → Features, fix → Bug Fixes, build → Build System, docs → Documentation, test → Tests, ci → Continuous Integration, style → Styles, refactor → Code Refactoring, perf → Performance Improvements, revert → Reverts, chore → Miscellaneous Chores).
- `src/lib/skills.ts:57-72` — runtime frontmatter allowlist (recognized fields: name, description, argument-hint, disable-model-invocation, allowed-tools, license, compatibility, metadata, deprecated, user-invocable, agent, model, context, subtask). The new skill uses only name, description, argument-hint.
- v2.21.0 release body (gold-standard reference) — current `gh release view v2.21.0 --json body` output is the structural template the skill must reproduce: `## What's new` → narrative sections by bucket → `### Verification` → `### Compare` → `### Also in this release`.

### Institutional Learnings

- `docs/solutions/developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md` — already documents the problem and recommends `gh release edit --notes-file` as the fix. **Critical:** the new skill is the formalization of this doc's recommendation, not novel work. Unit 5 adds a cross-reference from this solution doc to the new skill.
- `docs/solutions/developer-experience/gh-api-heredoc-backtick-escape-2026-05-17.md` — prefer temp files + `--notes-file` over inline heredoc with `gh api -F body=`. Procedure uses this pattern.
- `docs/solutions/best-practices/third-party-bundled-skills-light-adaptation-2026-05-17.md` — light-adaptation pattern, useful structural analogue for authoring a focused new skill.
- `docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md` — frontmatter changes to bundled skills require registry regeneration. **Does NOT apply here:** `scripts/generate-registry.ts:302` confirms the registry only scans `skills/` and `agents/`, not `.agents/skills/`. No registry regen step needed.
- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md` — runtime-parser vs CI-gate alignment. Not directly applicable: project-scoped skills aren't covered by the content-integrity gate.

### External References

Skipped per Phase 1.2 — local patterns are strong and the task is highly local.

## Key Technical Decisions

- **Pure procedure, no executable helper script.** Resolves origin Q1. Strong local pattern: `generating-project-docs` (149 lines) is pure procedure with inline bash. Render logic is well within agent capability; a separate script would force a second editing surface and reduce flexibility.
- **Minimal structured extraction, then agent synthesis.** Resolves origin Q2. The procedure parses each commit into `(type, scope, subject, body)` tuples and splits the body on `BREAKING CHANGE` and standard footers (`Closes`, `Co-authored-by`, `Signed-off-by`). It hands the structured bundle to the agent, which writes prose. Template-filling produces the bare-body output that semantic-release already failed at; agent synthesis is what makes the narrative useful.
- **PR-body enrichment threshold: < 200 chars of commit body after stripping conventional-commit footers and trailers.** Resolves origin Q3. The threshold is empirical: v2.21.0's squash commit body is ~120 chars of trailing-newline-padded prose after footers strip, well under the threshold, and PR-body enrichment is the right answer for that release. Planning validated against the last 5 squash releases; threshold separates real narrative bodies from "just a subject line" cases.
- **Single `SKILL.md` + two `references/` sub-files.** SKILL.md carries the canonical procedure. `references/autolink-allowlist.md` documents the strip rules with positive and negative examples (false-positive guard from origin AE4). `references/historical-corpus.md` lists v2.20.5 / v2.20.6 / v2.21.0 as test anchors with expected output shape.
- **No registry regeneration step.** Verified: `scripts/generate-registry.ts:302` scans `skills/` and `agents/` only. Project-scoped skills under `.agents/skills/` are out of scope for the registry.
- **Acceptance proof shipped in the implementing PR.** Unit 6 runs the procedure against v2.20.5 and v2.20.6, producing before/after artifacts attached as PR evidence. This is the deliverable that proves R12 (origin) — concretely demonstrating the skill works on real historical releases.

## Open Questions

### Resolved During Planning

- Q1 (origin R3): Helper script vs pure procedure? → Pure procedure (see Key Technical Decisions).
- Q2 (origin R6): Commit-body parsing depth? → Minimal structured extraction + agent synthesis (see Key Technical Decisions).
- Q3 (origin R4): Thin-commit-body threshold? → < 200 chars after footer strip, with the threshold to be re-validated during Unit 1 implementation against the distribution of commit-body lengths across the last 10 squash releases (see Key Technical Decisions and Risks).

### Deferred to Implementation

- Exact prose tone of the SKILL.md body — implementation iterates on wording; planning fixes structure and contract only.
- Whether `references/historical-corpus.md` shows full before/after release bodies or just shape hints — depends on length; if both v2.20.5 and v2.20.6 fit under 300 lines combined, include full bodies; otherwise abbreviate.

## Implementation Units

- [ ] **Unit 1: Author core SKILL.md**

**Goal:** Write the canonical procedure skill body. Defines frontmatter, when-to-use triggers, exact procedure (walk commits → parse → render → apply), and the gold-standard reference output shape.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R9

**Dependencies:** None

**Files:**
- Create: `.agents/skills/release-notes-narrative/SKILL.md`

**Approach:**
- Frontmatter: `name: release-notes-narrative`, `description: Use when a semantic-release-published GitHub release has a bare auto-generated body or a spurious "closes [URL-fragment]" autolink that needs to be rewritten with proper narrative`, optional `argument-hint: <tag-or-range>`.
- Body structure mirrors `.agents/skills/generating-project-docs/SKILL.md`: short overview → When to Use / When NOT to Use → Procedure (numbered steps) → Render Contract (output shape) → Quality Checks.
- Procedure steps:
  1. Identify target release tag (from `$ARGUMENTS` or latest semver tag).
  2. Resolve previous release tag via `git describe --tags --abbrev=0 v<target>^` (returns the most recent ancestor tag of the target's parent commit). This correctly returns the chronological predecessor regardless of when other tags were created. Fail loudly if the command produces no tag (means the target has no semver ancestor and the procedure cannot run).
  3. Read current release body via `gh release view <tag> --json body --jq .body` and capture it to `.context/pr-evidence/release-notes-narrative/v<target>-before.md` as the pre-edit snapshot used for rollback if the post-edit verification step (procedure step 13) fails. In v1 the skill always overwrites unconditionally — no detection of human-added regions, no short-circuit on `HUMAN:KEEP` sentinels (deferred to v2). Document this in the skill body so an operator running the procedure on a release with manual edits knows the prior body is replaced.
  4. Walk commits: `git log <prev>..<target> --pretty=format:'%H%x1f%s%x1f%b%x1e'` → parse into (sha, subject, body) tuples.
  5. For each commit, extract type/scope/subject via the conventional-commits regex (`^(?<type>\w+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s+(?<subject>.+)$`) applied to subject; split body on first occurrence of `BREAKING CHANGE:` or standard footers (`Closes`, `Fixes`, `Refs`, `Co-authored-by`, `Signed-off-by`) to isolate prose.
  6. Detect single-squash + thin body: if range contains exactly one commit AND the parsed body (post-footer strip) is < 200 chars of non-whitespace prose, fetch the PR via `gh pr view <pr-number-from-squash-subject> --json body --jq .body` and use as enrichment.
  7. Group commits by type into the 11 hardcoded buckets.
  8. Synthesize narrative: agent writes `### <Bucket Heading>` followed by paragraph(s) drawing from commit bodies + PR enrichment. Trivial buckets (Miscellaneous Chores, Dependencies) get a short `### Also in this release` tail section.
  9. Add Compare link: `[v<prev>...v<target>](https://github.com/marcusrbrown/systematic/compare/v<prev>...v<target>)`.
  10. Apply autolink strip (see Unit 2 / `references/autolink-allowlist.md`).
  11. Preflight check the rendered body in the temp file: assert balanced markdown fences, no broken HTML tags, no empty section headings, presence of the Compare link, presence of at least one bucket heading. If any check fails, do NOT call `gh release edit` — surface the failures and stop.
  12. Apply via `gh release edit v<target> --notes-file <tmpfile>`.
  13. Verify: `gh release view v<target> --json body --jq '.body|length'` returns a value larger than the pre-edit length, the body contains the expected bucket headings, and the Compare link resolves. On any verification failure, restore the pre-edit snapshot from procedure step 3 via `gh release edit v<target> --notes-file <pre-edit-snapshot>`.
- Hardcoded bucket map (R5): the 11 entries from `.releaserc.yaml:46-70`.
- Idempotence framing (R9, refined): explicitly call out that re-running against the same `(prev, current)` pair regenerates the same STRUCTURE (buckets, Compare link, referenced PRs) but may vary in narrative wording due to LLM nondeterminism. Document a normalizer that the operator can run when comparing two outputs: strip prose paragraphs, retain bucket headings + bullet lists + Compare link, then `diff` the normalized forms — those should be byte-identical.

**Patterns to follow:**
- `.agents/skills/generating-project-docs/SKILL.md` — frontmatter shape, section order, inline-bash-commands-with-prose style.
- `.releaserc.yaml:46-70` — exact bucket headings.

**Test scenarios:**
- Happy path: Skill correctly identifies v2.20.5 as the previous tag for v2.20.6 (`git tag --sort=-creatordate | grep '^v[0-9]'` skipping v2.20.6 returns v2.20.5 first).
- Happy path: Bucket map matches `.releaserc.yaml` exactly (11 entries with correct title-case headings).
- Edge case: Procedure handles a release with zero commits in range (degenerate case — emits only the Compare link section). Document expected behavior in skill body.
- Edge case: Procedure handles `git log` output with `\x1f` or `\x1e` characters in commit messages (escape characters are deliberate field/record separators; bodies containing literal `\x1e` would corrupt parsing — skill body notes this is acceptable for v1 because no real commit in this repo contains the byte).
- Integration: Rerunning the procedure against the same `(prev, current)` pair produces a body that, after running the documented normalizer (strip prose paragraphs, keep buckets + Compare + bullet structure), matches the first run byte-for-byte. Prose wording differences between runs are expected and acceptable.

**Verification:**
- Skill body conforms to `.agents/skills/generating-project-docs/SKILL.md` structural conventions.
- All 11 bucket headings appear verbatim in the body, matching `.releaserc.yaml:46-70`.
- Frontmatter validates against the `src/lib/skills.ts:57-72` recognized field list (only uses `name`, `description`, `argument-hint`).
- Procedure step references match Unit 2's autolink-allowlist sub-file path.

- [ ] **Unit 2: Author references/autolink-allowlist.md**

**Goal:** Document the autolink-strip rules with positive (strip) and negative (preserve) worked examples. The strip is the v1 defense against semantic-release's URL-fragment misparse (memory `#3760`).

**Requirements:** R7

**Dependencies:** Unit 1 (the sub-file is referenced from SKILL.md procedure step 10)

**Files:**
- Create: `.agents/skills/release-notes-narrative/references/autolink-allowlist.md`

**Approach:**
- Top section: state the v2.21.0 observed failure mode verbatim — `closes [fro.bot/...](https://github.com/fro.bot/systematic/reference/configuration/issues/typed-validation)`.
- Allowlist rule (origin R7): a link is stripped only when ALL four conditions hold:
  - (a) link is parsed from the rendered body's markdown AST as a discrete `[text](url)` node — not matched via raw-string regex over the body (regex sweeps fail on multiline content and nested markdown);
  - (b) link text equals the URL's last path segment OR is a single-line substring of that segment (this catches both `[typed-validation](.../issues/typed-validation)` and `[fro.bot/.../typed-validation](.../issues/typed-validation)`);
  - (c) target URL, after stripping any query string or fragment, matches the shape `https://github.com/<path-with-zero-or-more-slashes>/issues/<segment>` where `<segment>` contains at least one non-digit character;
  - (d) link is the immediate next AST sibling after a text node ending with the literal token `closes` (case-insensitive, optionally preceded by `,` or `;`, with whitespace between). "Immediate next sibling" is per markdown AST node order, not raw-string proximity — prose-level mentions of `closes` elsewhere in the paragraph do not match.
- Positive examples (MUST strip): the v2.21.0 shape `closes [fro.bot/.../typed-validation](.../issues/typed-validation)`; any other `closes [foo](https://github.com/.../issues/non-numeric)` regardless of path depth.
- Negative examples (MUST preserve):
  - `Closes [#42](https://github.com/anomalyco/opencode/issues/42)` — purely-numeric segment, condition (c) fails.
  - A plain markdown link to an issue without the `closes` prefix — condition (d) fails.
  - A paragraph: `"... which closes the loop. See [the docs](https://github.com/foo/bar/issues/explanation)."` — the `closes` token is not the immediate predecessor of the link in the AST; condition (d) fails.
  - A URL with query params: `https://github.com/foo/bar/issues/42?ref=main` — strip the query before evaluating condition (c); the bare segment is `42`, still purely numeric, preserved.
  - A link whose text contains the word `closes`: `[closes the loop](https://github.com/foo/bar/issues/explanation)` — the link text is unrelated to the URL segment; condition (b) fails.
- Implementation note for the agent applying the skill: parse the rendered body once with a markdown AST library (e.g., remark or commonmark), walk the link nodes, check each against the four conditions in order, and drop matches. Do not use a single regex sweep over the raw body — the historical failure mode is exactly that kind of overgeneralization.

**Patterns to follow:**
- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md` — reference-file style for documenting positive/negative example tables.

**Test scenarios:**
- Happy path: The v2.21.0 fragment `closes [fro.bot/...](https://github.com/fro.bot/.../issues/typed-validation)` is identified as a strip target.
- Edge case: A `closes [#42](https://github.com/anomalyco/opencode/issues/42)` link in a cross-repo commit body is preserved verbatim.
- Edge case: A paragraph containing `"... which closes the loop. See [the docs](https://github.com/...)..."` does NOT strip the link (the `closes` token must directly precede the link, not appear in surrounding prose).
- Edge case: A `closes` keyword followed by a non-link (e.g., `closes #42` plain text) is left alone — only markdown links are stripped.

**Verification:**
- Sub-file path matches the reference in Unit 1's procedure step 10.
- All four conditions (a, b, c, d) appear verbatim; no looser wording that would broaden the strip.
- At least 2 positive and 5 negative worked examples present (negatives drive the false-positive defense).

- [ ] **Unit 3: Author references/historical-corpus.md**

**Goal:** Document the three historical anchor releases (v2.20.5, v2.20.6, v2.21.0) that the skill validates against. v2.20.5 and v2.20.6 are the bare-body releases the skill must successfully rewrite; v2.21.0 is the gold-standard manually-patched reference.

**Requirements:** Supports R6 (rendered body shape) and Success Criteria (acceptance against historical releases)

**Dependencies:** Unit 1 (referenced from SKILL.md "When to Use" section)

**Files:**
- Create: `.agents/skills/release-notes-narrative/references/historical-corpus.md`

**Approach:**
- For each anchor release, include:
  - Tag and short summary of what shipped
  - Previous release tag (for the compare anchor)
  - Original auto-generated body (verbatim) — captured via `gh release view <tag> --json body --jq .body` at planning time
  - For v2.21.0: also include the manually-patched body as the "what good looks like" reference
  - One-line note about which commit shape the release exemplifies (single squash, multi-PR flush, etc.)
- The corpus is a test-anchor document, not running tests — it lets the agent applying the skill compare its output against known-good shapes.

**Patterns to follow:**
- `.agents/skills/generating-project-docs/SKILL.md`'s "Common Mistakes" section — table-style reference content that the agent reads on demand.

**Test scenarios:**
- Test expectation: none — pure reference content. Verification is shape-conformance (sections present, anchor tags resolve via `git rev-parse`).

**Verification:**
- All three referenced tags (v2.20.5, v2.20.6, v2.21.0) resolve via `git rev-parse`.
- v2.21.0's documented "good shape" matches the actual current release body (per Phase 1.1 repo-research findings: `## What's new` → bucket sections → `### Verification` → `### Compare` → `### Also in this release`).
- The corpus includes the FULL pre-edit body for v2.20.5, v2.20.6, and v2.21.0 (each ~10-30 lines based on actual sizes; combined corpus stays well under 300 lines).

- [ ] **Unit 4: Cross-reference from .agents/skills/README.md**

**Goal:** Add the new skill to the project-scoped skills index so OpenCode and contributors can discover it.

**Requirements:** R1 (skill is discoverable)

**Dependencies:** Unit 1

**Files:**
- Modify: `.agents/skills/README.md`

**Approach:**
- The existing README has a "Skills" section that currently lists only `generating-project-docs`. Add a second entry for `release-notes-narrative` with a one-line description matching the SKILL.md frontmatter description.
- Keep alphabetical order in the listing.

**Patterns to follow:**
- The existing `generating-project-docs` entry in `.agents/skills/README.md` — format, length, link target.

**Test scenarios:**
- Test expectation: none — pure documentation index update. Verification is link integrity.

**Verification:**
- Link target `.agents/skills/release-notes-narrative/SKILL.md` resolves on disk.
- Description matches SKILL.md frontmatter description (or paraphrases it consistently).

- [ ] **Unit 5: Cross-link from existing solution doc**

**Goal:** Update `docs/solutions/developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md` to cross-reference the new skill as the formalized procedure.

**Requirements:** Supports R1 (discoverability via documented historical context)

**Dependencies:** Unit 1

**Files:**
- Modify: `docs/solutions/developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md`

**Approach:**
- Add a "See Also" entry pointing at `.agents/skills/release-notes-narrative/SKILL.md` with a one-line note: "Formalized procedure for the post-publish patch recommended above."
- Do not rewrite the existing doc — the historical record stands.

**Patterns to follow:**
- Existing cross-link patterns in `docs/solutions/` (most docs have a `## Related` or `## See Also` section at the bottom).

**Test scenarios:**
- Test expectation: none — pure cross-reference update.

**Verification:**
- Link to the new SKILL.md resolves on disk.

- [ ] **Unit 6: Acceptance pass against v2.20.5 and v2.20.6**

**Goal:** Run the skill's procedure against the two historical bare-body releases, producing before/after artifacts attached to the implementing PR as evidence the skill works on real targets.

**Requirements:** Origin Success Criteria #2 ("the skill is run successfully against the two historical bare-body releases during the implementing PR's verification step, producing two before/after artifacts attached as evidence")

**Dependencies:** Unit 1, Unit 2 (skill body + autolink allowlist must exist before the procedure can be followed)

**Files:**
- No files committed in this unit. The output is GitHub release body edits (v2.20.5 and v2.20.6) plus screenshots / `gh release view` output captured as PR evidence under `.context/pr-evidence/release-notes-narrative/` (gitignored).

**Approach:**
- Load the newly-authored skill.
- For v2.20.5: identify v2.20.4 as the previous tag (via `git describe --tags --abbrev=0 v2.20.5^`), walk the commit log, render, run preflight checks (procedure step 11), apply via `gh release edit v2.20.5 --notes-file <tmpfile>`, verify (procedure step 13).
- For v2.20.6: same shape with v2.20.5 as previous tag.
- Capture `gh release view <tag> --json body --jq .body` before and after each patch. Save to `.context/pr-evidence/release-notes-narrative/v2.20.5-before.md`, `v2.20.5-after.md`, etc.
- The acceptance bar is NOT "v2.20.5 was bare and is now narrative" — v2.20.5 already has bucketed sections from semantic-release. The bar is: the post-patch v2.20.5 body replaces the mechanical bullet (`* **ci:** add OpenCode group name to Renovate config (#425)`) with narrative prose drawn from the PR body or commit body that explains what the change does and why it matters. The before/after diff demonstrates the qualitative improvement.
- Verify structural idempotence by running the procedure a second time against v2.20.5, running the documented normalizer on both outputs, and asserting the normalized forms are byte-identical.

**Execution note:** This unit changes live GitHub release bodies on a public repo. The patches should be applied during PR verification, not during early implementation drafting — if the skill produces a broken body during iteration, the live releases get a temporarily broken changelog. Sequence: complete Units 1–2 fully, manually review the SKILL.md body, then run Unit 6 once in earnest.

**Patterns to follow:**
- The session that produced v2.21.0's manual patch — same `gh release edit --notes-file` shape.

**Test scenarios:**
- Happy path: After patching, the v2.20.5 body's `### Bug Fixes` section contains narrative prose explaining what the Renovate config change does and why it matters, replacing the original one-line `* **ci:** ...` bullet.
- Happy path: After patching, the v2.20.5 body contains a Compare link to `v2.20.4...v2.20.5` and at least the bucket headings that the original auto-generated body had (`### Bug Fixes`, `### Build System`).
- Edge case (structural idempotence): Running the procedure a second time against v2.20.5 produces a body whose normalized form (after stripping prose paragraphs) is byte-identical to the first run's normalized form.
- Edge case (preflight catches broken markdown): If the rendered body fails the preflight check (e.g., unbalanced fences), Unit 1's procedure step 11 stops the run before any `gh release edit` is called; the live release is unchanged.
- Edge case (rollback): If post-edit verification fails (procedure step 13), the pre-edit snapshot is restored automatically; the live release returns to the pre-run state.
- Edge case (autolink defense): If any v2.20.4..v2.20.5 commit body contains a URL-fragment string (audit during the run), the AST-based strip correctly elides the resulting autolink without affecting other links.

**Verification:**
- Both v2.20.5 and v2.20.6 release bodies on GitHub show narrative content matching the rendered shape (sections, Compare link present).
- Before/after artifacts saved to `.context/pr-evidence/release-notes-narrative/`.
- The PR description embeds at least one before/after pair as evidence.

- [ ] **Unit 7: Compound doc capturing the procedure**

**Goal:** Write a `docs/solutions/best-practices/` compound doc capturing the procedure and the URL-anchor false-positive guard as institutional learning. Per the "keep compound docs in the same branch as the implementation they document" rule.

**Requirements:** Knowledge capture for future agents touching release notes; supports cross-session recall of the autolink-strip allowlist semantics.

**Dependencies:** Unit 6 (compound doc references the working procedure with real before/after evidence)

**Files:**
- Create: `docs/solutions/best-practices/release-notes-narrative-procedure-2026-05-23.md`

**Approach:**
- Frontmatter: `module: release-pipeline`, `category: best-practices`, `date: 2026-05-23`, `problem_type: best_practice`, `component: documentation`, `severity: medium`, tags including `release-notes`, `semantic-release`, `gh-release`, `narrative-changelog`.
- Sections: Context (linking the two semantic-release defects to the v1.0.0 procedure), Procedure summary (linking to the SKILL.md), Why this works (positive allowlist over denylist regex, commit-log as authoritative source), Prevention (the skill itself is the prevention mechanism), Related (cross-links to `semantic-release-body-ingestion-myth-2026-05-17.md`, `gh-api-heredoc-backtick-escape-2026-05-17.md`).

**Patterns to follow:**
- `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md` and other recent best-practice docs in `docs/solutions/best-practices/`.

**Test scenarios:**
- Test expectation: none — pure documentation.

**Verification:**
- Frontmatter validates against `skills/ce-compound/references/schema.yaml` (the canonical compound-docs schema, surfaced by the ce-compound skill).
- All cross-referenced docs and the new SKILL.md path resolve on disk.

## System-Wide Impact

- **Interaction graph:** New skill is invoked by agents on demand. No other code or skill changes its behavior because of this work. The existing solution doc (`semantic-release-body-ingestion-myth-2026-05-17.md`) gains a cross-reference but the doc's recommendation stays valid as a standalone reading.
- **Error propagation:** The skill performs live `gh release edit` calls. Failures (auth, network, tag-not-found) propagate as the running agent's normal error-handling. No silent failure modes introduced.
- **State lifecycle risks:** Each `gh release edit` is a full body replacement. The skill must not be partially-applied — if it crashes between render and apply, the previous release body is unchanged. If it crashes after apply, the new body is in place and the run can be retried (idempotent by spec).
- **API surface parity:** None. The skill does not introduce new APIs, tools, or interfaces.
- **Integration coverage:** Unit 6 is the integration test — running the skill against two real historical releases is the canonical proof.
- **Unchanged invariants:** `.releaserc.yaml`, the Release CI job, all bundled skills under `skills/`, all bundled agents, and the OCX registry stay untouched. v1 is additive within `.agents/skills/` and `docs/solutions/` only.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The agent following the procedure produces a low-quality narrative that's worse than the auto-generated baseline. | Unit 6's before/after artifacts surface this immediately; if quality is unacceptable, the SKILL.md procedure is revised in the same PR before merge. The acceptance is not "skill exists" but "skill produces qualitatively-better output on the two historical anchors." Unit 1's preflight check (procedure step 11) also rejects rendered bodies that fail mechanical sanity. |
| Autolink-allowlist false positive strips a legitimate `closes [#42](...)` link. | Unit 2's positive/negative example table forbids stripping purely-numeric segments and AST-based parsing forbids regex-sweep false positives. Unit 6 also acts as the smoke test: if v2.20.5 or v2.20.6 contained a real closing link that the strip ate, the before/after diff would show it. |
| `gh release edit` on a public repo introduces a transient broken state if the procedure misbehaves. | Three layers of defense: (1) Unit 6 Execution note delays the run until after manual SKILL.md review; (2) Unit 1's preflight check (procedure step 11) rejects malformed markdown before any release edit; (3) Unit 1's verification step (procedure step 13) restores the pre-edit snapshot if post-edit checks fail. |
| The bucket map drifts from `.releaserc.yaml` after merge (someone changes the preset, skill body becomes stale). | The skill body documents that the map is mirrored from `.releaserc.yaml:46-70` and must be updated by hand in the same PR if the preset changes. The skill-vs-config drift surface is small (11 entries) and easy to spot-check. |
| The thin-commit-body threshold of 200 chars is empirically wrong and triggers PR-body enrichment unhelpfully (or misses cases that need it). | During Unit 1 implementation, before locking the threshold, compute the distribution of commit-body lengths (post footer-strip) across the last 10 squash releases. Adjust the threshold to separate the bottom-half from the top-half of that distribution. Document the chosen value AND the distribution in the SKILL.md body so future tuning is grounded. |
| Wide adoption of the skill shifts the failure mode from "semantic-release bare bodies" to "agent-authored patch quality." | The skill explicitly notes in its "When NOT to Use" section that it is not a substitute for human editorial judgment on high-visibility releases (major versions, security advisories, etc.). For those, the procedure is to use the skill as a starting draft and edit by hand before publishing. |

## Documentation / Operational Notes

- The implementing PR's description includes before/after screenshots from Unit 6 as evidence.
- No operational rollout — the skill is loaded on demand by agents, no flags, no deploy.
- Future v2 work (CI automation via `@semantic-release/exec`) is captured as a deferred task in the brainstorm; this plan does not commit a timeline.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-23-release-notes-narrative-skill-requirements.md](../brainstorms/2026-05-23-release-notes-narrative-skill-requirements.md)
- **Existing solution doc:** [docs/solutions/developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md](../solutions/developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md)
- **Related solution doc:** [docs/solutions/developer-experience/gh-api-heredoc-backtick-escape-2026-05-17.md](../solutions/developer-experience/gh-api-heredoc-backtick-escape-2026-05-17.md)
- **Local skill template:** `.agents/skills/generating-project-docs/SKILL.md`
- **Runtime frontmatter allowlist:** `src/lib/skills.ts:57-72`
- **Bucket map source of truth:** `.releaserc.yaml:46-70`
- **Gold-standard release body:** v2.21.0 (currently published, manually patched in this session)
- **Acceptance anchors:** v2.20.5, v2.20.6 (bare-body releases targeted by Unit 6)
