---
title: semantic-release release-notes-generator ignores commit bodies; patch with gh release edit
module: .releaserc.yaml + release-pipeline
date: 2026-05-17
problem_type: developer_experience
component: tooling
severity: medium
tags:
  - semantic-release
  - release-notes
  - changelog
  - gh-cli
  - conventional-commits
applies_when:
  - A release needs an audience-facing narrative (deprecation cycle, migration steps, breaking changes) beyond the auto-generated commit-subject bullets
  - Authoring a squash-commit message body intending for it to appear in the GitHub release notes
  - Validating release-notes content after a semantic-release publish
---

# semantic-release release-notes-generator ignores commit bodies; patch with gh release edit

## Context

Systematic's release pipeline uses `@semantic-release/release-notes-generator` with the `conventionalcommits` preset. The plugin reads the conventional-commits in the release range, groups commit SUBJECT lines under section headers configured in `presetConfig.types[]` (`Features`, `Bug Fixes`, `Build System`, etc.), and writes the result to the GitHub release body via `@semantic-release/github`.

The common mistaken assumption — held by this author across multiple session arcs before being empirically falsified — is that the BODY of each conventional-commit also flows into the release notes. It does not. Only the subject line plus PR/commit links is included.

This matters when a release ships an audience-facing narrative — a deprecation announcement, a migration guide, a breaking-change explanation. Authoring that narrative inside the squash-commit body looks right (the body IS in git history, and it survives the squash), but the GitHub release notes show only:

```
### Features

* **skills:** deprecation surface + mark orchestrating-swarms and claude-permissions-optimizer (#401) (402ef5c)
```

The detailed `## Deprecations` section in the commit body never reaches users browsing the v2.19.0 release page or the npm release notes.

## Guidance

**`@semantic-release/release-notes-generator` (conventionalcommits preset) does NOT ingest commit body text into release notes. It emits only the commit subject lines grouped by section.** When a release needs an audience-facing narrative, plan to post-process the release body via `gh release edit --notes-file <file>` immediately after the release publishes.

The release-pipeline polling should NOT exit until the release notes are reviewed and patched if narrative is needed. Surface this as an explicit step in the release flow, not a hope.

Mechanics that make this clean:

1. **Author the narrative once**, in a temp file. The same content can be used for the PR body (reviewer context), the squash-commit body (git history), and the patched release notes (audience-facing).
2. **Let semantic-release auto-generate the initial release notes** — that gives you the correctly-linked commit bullets grouped by section.
3. **Patch with `gh release edit <tag> --notes-file <file>`** — prepend the narrative above the auto-generated bullets and preserve the bullets verbatim below.

Alternatives considered and rejected:

- `@semantic-release/release-notes-generator`'s `writerOpts.transform` to inject body content. This is a `.releaserc.yaml` config change with broader semver implications across all future releases. Too heavy for the narrative-once-in-a-while case.
- A CHANGELOG.md committed alongside the release. Not maintained in this repo and reintroducing it means adding `@semantic-release/changelog` to the plugin chain. More churn than the manual patch.

## Why This Matters

A release without its narrative is a release that doesn't communicate. Users browsing v2.19.0 on GitHub see only "deprecation surface + mark orchestrating-swarms and claude-permissions-optimizer" with no indication that:

- The skills remain functional for v2.19.x
- The migration path is v2.18.x downgrade if v3.0.0 breaks something
- The v3.0.0 deletion has no committed timeline
- What replacement is planned for each

The detailed PR body is reviewer-facing, not audience-facing. The squash-commit body is git-history-facing, not audience-facing. The GitHub release page IS the audience-facing surface. Without a post-publish patch, the audience sees nothing.

The cost of the patch is small: a `gh release edit` call after the release-pipeline run completes. The cost of skipping it is users hitting v3.0.0 surprised, opening issues, and the maintainer linking them to a commit body they didn't know existed.

## When to Apply

- Whenever a release ships a deprecation cycle, a migration step, a breaking change, or any other audience-facing narrative
- When validating any release that has more substance than a routine bugfix or dependency bump
- During release-pipeline monitoring: after the workflow reports success, check `gh release view <tag> --json body --jq '.body'` and verify the narrative is present

## Examples

### Wrong: assume the commit body makes it into the release notes

```bash
# Squash-commit body carries the Deprecations narrative.
gh pr merge 401 --squash --body-file deprecations-narrative.md

# Wait for release-pipeline. Assume the narrative is in v2.19.0 release notes.
# It is not. The release body has only the bullet summary.
```

### Right: patch release notes after publish

```bash
# 1. Author the narrative once.
RELEASE_FILE=$(mktemp -t v2.19.0-release-XXXXXX.md)
cat > "$RELEASE_FILE" <<'EOF'
## [2.19.0](.../compare/v2.18.0...v2.19.0) (2026-05-18)

### Deprecations

Two bundled skills are now marked deprecated with removal: v3.0.0 ...

[full narrative here, including migration guidance]

### Features

* **skills:** deprecation surface + mark orchestrating-swarms and claude-permissions-optimizer (#401) (402ef5c)
EOF

# 2. Squash-merge normally (commit body still lands in git history).
gh pr merge 401 --squash --body-file "$RELEASE_FILE"

# 3. Wait for release-pipeline to publish v2.19.0.
# (poll the workflow until status=completed conclusion=success)

# 4. Patch release notes with the narrative-first version.
gh release edit v2.19.0 --notes-file "$RELEASE_FILE"

# 5. Verify.
gh release view v2.19.0 --json body --jq '.body | length'
# Should be substantially longer than the auto-generated bullet-only version.

rm -f "$RELEASE_FILE"
```

### Release-monitoring checklist

Add this step to release-pipeline monitoring for any narrative-bearing release:

```bash
# After workflow success, check the body length.
# Threshold rationale: a typical bullet-only release body for this repo
# (3-5 conventional-commit subjects + section headers + the compare-link
# header) lands in the ~600-1000 char range. A narrative-bearing release
# (Deprecations section + migration guidance + feature explanation) should
# clear 1500+. Calibrate to your own release history if this is reused.
RELEASE_BODY_LEN=$(gh release view v2.19.0 --json body --jq '.body | length')
if [ "$RELEASE_BODY_LEN" -lt 1500 ]; then
  echo "WARN: release body is short ($RELEASE_BODY_LEN chars). Did the narrative land?"
  echo "Run: gh release edit v2.19.0 --notes-file <narrative.md>"
fi
```

## Related

- `docs/solutions/developer-experience/gh-api-heredoc-backtick-escape-2026-05-17.md` — sibling lesson from the same release; both involve `gh` CLI body content
- `.releaserc.yaml` — the source of truth for the plugin chain and section mapping
- PR #401 / v2.19.0 — where this lesson was empirically verified
- `.agents/skills/release-notes-narrative/SKILL.md` — formalized procedure for the post-publish patch recommended above
