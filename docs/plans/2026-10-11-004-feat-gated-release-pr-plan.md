---
title: "feat: Gate releases behind an approved release PR"
type: feat
status: active
date: 2026-10-11
origin: docs/brainstorms/2026-10-11-gated-release-pr-requirements.md
---

# feat: Gate releases behind an approved release PR

## Overview

Today a merge to main stops publishing directly. Each push to main instead rebuilds a single bot-owned release PR. That PR's only change is the pending `CHANGELOG.md` entry. It publishes only after it auto-merges with an approval on its exact head commit. The approval comes from Marcus at any time, or from a deterministic Wednesday/Sunday gate that approves as `fro-bot` and attests the approval.

The publish job re-verifies the approval, then publishes with npm trusted publishing (OIDC) from a credential-scoped environment. Fro Bot's narrative still lands on the GitHub release after publish. Its silent-failure gap is closed (#1089), and the docs site gains a changelog page and a narrative release-notes page.

## Problem Frame

Every releasing merge publishes immediately: 60 releases in 60 days, with a median of 3 commits. Release credentials (`NPM_TOKEN` and the App key) reach same-repo PR runs. The Renovate job shares the release App key, and a failed narrative rewrite is invisible (#1089). The workflow-level `cancel-in-progress` setting has cancelled publishes mid-flight. Scorecard can't read classic protection, and Code-Review sits at 1/10 (see origin: `docs/brainstorms/2026-10-11-gated-release-pr-requirements.md`).

## Requirements Trace

Requirements are numbered as in the origin doc.

- **Release PR lifecycle:** R1–R5.
- **Publishing:** R6–R12, plus R25 (narrative), R26 (changelog page), and R27 (release-notes page).
- **Approval and schedule:** R13–R16.
- **Credential isolation:** R17–R20.
- **Hardening:** R21–R24.
- **Acceptance examples:** AE1–AE14.
- **Success criteria:**
  - releases batch to about twice weekly;
  - every published version carries an exact-head approval;
  - no narrative failure is silent;
  - Scorecard Branch-Protection is real, Code-Review rises above 1, and Security-Policy reaches 10.

## Scope Boundaries

- Migrating to release-please or changesets.
- Environment reviewers.
- Manual editing of release notes.
- Narrative in the release PR.
- Backfilling `CHANGELOG.md` with past releases.
- Changing the release rules (which types and scopes publish).
- A long-lived release branch.
- Scorecard Vulnerabilities, Fuzzing, and CII.
- The CodeQL alerts in `skills/ce-review/scripts/validate-review.mjs`.

### Deferred to Separate Tasks

- **Dedicated settings App:** a Marcus-org-level change, because the existing App serves Renovate and settings across his repos. Recorded below as an accepted risk.
- **Workflow linting (`actionlint`/`zizmor`):** adding a CI gate is ask-first. Propose it separately.
- **Removing the now-unused `@semantic-release/exec` devDependency:** touches the lockfile, so ask first. Do it after PR 3.

## Context & Research

### Relevant Code and Patterns

- `.github/workflows/main.yaml`:
  - the `release` job (`needs` build/typecheck/lint/test/host-contract; App token; `NPM_TOKEN`; `bun run build`, then `npx semantic-release`);
  - `publish-claude-code-plugin`, gated on `semantic-release-export-data` outputs;
  - workflow-level `concurrency` with `cancel-in-progress: true`.
- `.releaserc.yaml`: `branches: [main]`, `releaseRules`, `presetConfig.types` (which includes `chore`), `@semantic-release/exec` `successCmd` → `scripts/dispatch-release-notes.sh`, `tagFormat: v${version}`.
- `scripts/dispatch-release-notes.sh`: prompt at `:46-75`, poll and watch, and the `BODY_LEN >= 200` post-check (`:157-161,189`). Every narrative failure exits 0 (`:171-206`).
- `.agents/skills/release-notes-narrative/SKILL.md`: writes to `.context/pr-evidence/…` and `/tmp`, which CI denies.
- `.github/workflows/docs.yaml`: deploys on `release: published`. One job builds and holds `FRO_BOT_APPLICATION_*` for the `gh-pages` force-push. `concurrency: docs-deploy`, cancel true.
- `docs/scripts/transform-content.ts` and `docs:generate` (`package.json:51`): generated pages are gitignored. `astro.config.mjs` builds its sidebar with `autogenerate`.
- `.github/settings.yml`, applied by the bfra-me `update-repo-settings` reusable workflow. It has `branches`, `environments`, and `rulesets` plugins. Support for tag rulesets and environment removal is unverified.
- `.github/workflows/renovate.yaml`: runs on every non-main push with `APPLICATION_ID/KEY`.
- **Test patterns to mirror:**
  - parsed-YAML workflow invariants: `tests/unit/host-contract-workflow.test.ts` and `tests/unit/fro-bot-workflow.test.ts`;
  - shell scripts under a PATH-first mock: `tests/integration/release-notes-ci.test.ts` with `tests/fixtures/mock-gh.sh`;
  - generated docs: `tests/unit/transform-content.test.ts`.
- **Versions:**
  - semantic-release 25.0.9;
  - `@semantic-release/npm` 13.1.5, transitive, with built-in OIDC;
  - commit-analyzer 13.0.1 and release-notes-generator 14.1.1;
  - Node 24 runner npm 11.6+, which meets npm's ≥11.5.1 trusted-publishing floor.

### Institutional Learnings

- **PR title sets the release type.** Under squash merge the PR title is the release-type input (`docs/solutions/workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md`). The release PR title must be non-releasing.
- **A green job is not a publish.** Verify publication with `npm view` and the existence of the tag and release (`docs/solutions/integration-issues/green-job-is-not-proof-of-publication-2026-08-18.md`).
- **Narrative architecture.** Keep its commit range and its fail-soft vs. security fail-hard boundaries (`docs/solutions/best-practices/release-notes-narrative-ci-automation-architecture-2026-05-23.md`).
- **Claude plugin publish.** It must be gated on a real release (`docs/solutions/best-practices/claude-code-plugin-build-and-publish-architecture-2026-07-18.md`).
- **Public text.** Commit subjects and PR titles in a release range feed the public release notes, so they must be public prose.

### External References

- **semantic-release v25** (configuration, plugins, and JS API):
  - dry run still runs `verifyConditions` and core `verifyAuth` (`git push --dry-run`);
  - `plugins` replaces the plugin list;
  - concatenated `generateNotes` output becomes `nextRelease.notes`;
  - publish refuses unless local HEAD equals the remote branch tip.
- **npm trusted publishers:**
  - binds repository, workflow filename, and optionally an environment;
  - provenance is automatic;
  - `@semantic-release/npm` ≥13.1.0 skips token checks when the OIDC exchange succeeds;
  - OIDC dist-tag operations need npm ≥11.21, but this repo doesn't use them.
- **GitHub:**
  - `dismiss_stale_reviews_on_push` fires only on diff-changing pushes;
  - a required check from a job skipped by `if` counts as success;
  - bypass actors apply per ruleset;
  - `GET /commits/{sha}/pulls`, plus `head.sha` and review `commit_id`;
  - `enablePullRequestAutoMerge` takes `expectedHeadOid`;
  - immutable releases lock the tag and assets, but not the body;
  - artifact attestations carry signer-workflow identity.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "build-new-within-scope",
  "scope": "systematic repo at 24935a8: .github/, .releaserc.yaml, scripts/, src/lib/, skills/, .agents/skills/, tests/, docs/solutions/",
  "freshness": {
    "vcs_reference": "24935a8904c80860ba4a124278754400ebe4564e"
  },
  "budget": {
    "max_search_passes": 4,
    "max_candidate_inspections": 16,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": ".github/workflows/main.yaml publish-claude-code-plugin if (new-release-published)",
      "description": "Gates a downstream publish on semantic-release-export-data after a release is already cut.",
      "disposition": "insufficient",
      "insufficiency_reason": "Runs after publish, records no approval, cannot hold a release."
    },
    {
      "path_or_symbol": ".github/workflows/main.yaml DRY_RUN and workflow_dispatch dry-run input",
      "description": "Boolean set by whoever dispatches; the only manual publish control.",
      "disposition": "insufficient",
      "insufficiency_reason": "No approval record and no binding to a reviewed head."
    },
    {
      "path_or_symbol": ".github/workflows/fro-bot.yaml PR_REVIEW_PROMPT",
      "description": "Advisory agent verdict; the autoheal prompt forbids approvals.",
      "disposition": "insufficient",
      "insufficiency_reason": "Agent judgment, not deterministic, and not a recorded approval bound to content."
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts receipt guard",
      "description": "In-process receipt ledger with a reviewDecision field inside the OpenCode host.",
      "disposition": "insufficient",
      "insufficiency_reason": "Lives in the agent host process; a CI publish job cannot consult it."
    },
    {
      "path_or_symbol": ".github/settings.yml with bfra-me update-repo-settings",
      "description": "Declarative settings applier with rulesets and environments plugins.",
      "disposition": "insufficient",
      "insufficiency_reason": "Applies declared settings; it does not gate publishing or record approvals. Used as the delivery vehicle for environments and rulesets."
    },
    {
      "path_or_symbol": "tests/unit/host-contract-workflow.test.ts and tests/integration/release-notes-ci.test.ts",
      "description": "Parsed-YAML workflow invariant tests and mock-gh shell script tests.",
      "disposition": "insufficient",
      "insufficiency_reason": "Test patterns only; they enforce nothing at publish. Their structure is mirrored by the new tests."
    }
  ],
  "excluded_scopes": [
    {
      "scope": "fro-bot/agent repository",
      "reason": "Outside this repository; cited as design input only."
    },
    {
      "scope": "docs/plans/",
      "reason": "Planning artifacts are not evidence of an existing mechanism."
    },
    {
      "scope": "npm registry trusted-publisher configuration",
      "reason": "External service configuration, not visible from the repository."
    },
    {
      "scope": "node_modules semantic-release internals",
      "reason": "Third-party code read for behavior only, not surveyed as candidates."
    }
  ]
}
```

## Key Technical Decisions

- **The published body is the committed `CHANGELOG.md` entry.** A small semantic-release plugin's `generateNotes` returns the top entry, replacing release-notes-generator in the gated publish. Its `verifyRelease` refuses when the entry's version differs from `nextRelease.version`. Regenerating at publish would differ from what was approved: the date changes, and the range includes the release commit's own `chore(release)` subject.
- **Preview calls the configured plugins directly, not semantic-release core.** Core dry-run needs push credentials (`verifyAuth`), so a core-based check could not be credential-free. Preview loads `.releaserc.yaml` and runs commit-analyzer and release-notes-generator over `git log <last tag>..HEAD`. The refresh, the PR check, and publish verification all use this one path. `.releaserc.yaml` stays the single rule source (R4), and the publish-time `verifyRelease` catches any divergence.
- **Strict currency.** The release PR is rebuilt from current main on every main advance (R7), keyed on the main SHA, so reruns are no-ops. Any merge to main voids a pending approval, and the gate re-approves on its next pass.
- **Publish invariants before semantic-release runs.** The merged commit X must satisfy all of these, or nothing publishes:
  - X is the main tip.
  - X maps to a merged `release/pending` PR whose `merge_commit_sha == X`.
  - The PR's final head is one commit over `parent(X)`.
  - That head's diff touches only `CHANGELOG.md`, as a prepend plus removal of untagged entries.
  - The head carries a valid approval submitted before the merge. A valid approval is either Marcus's, or a `fro-bot` approval with a gate attestation from `release-gate.yaml@refs/heads/main` that binds PR, head, review, and run.
  - While a hold is set, only Marcus's approval counts.

  If main moved, the run reports **superseded** (job summary and a comment on the merged PR) and exits 0. Any other failed invariant is **refused**, which turns the job red.
- **Hold is an admin-only repository variable (`RELEASE_HOLD`).** Only an admin can set or clear it. Fro Bot's PAT has write access, not admin. Labels are writable by triage, so they don't qualify.
- **Gate attribution is an artifact attestation, not an environment.** `FRO_BOT_PAT` is already a repo secret used by `fro-bot.yaml`, so an environment copy adds nothing. A copy of the gate dispatched from a branch would sign with a non-main source ref, and publish rejects that. A leaked PAT can still approve, which is the accepted risk from the origin doc.
- **Credentialed publish runs no project code.** A credential-free job builds `dist/` and uploads it with its digest. The publish job installs only lockfile tooling with `--ignore-scripts`, verifies the artifact digest, and runs semantic-release with `npm_config_ignore_scripts=true`, which stops `prepublishOnly` from rebuilding. `registry-url` is dropped from `setup-node`, and the job asserts npm ≥11.5.1.
- **Post-publish work moves to `release: published`.** Narrative (`release-notes.yaml`), the Claude plugin (`publish-claude-code-plugin.yaml`), and docs all trigger on that event. They work in both legacy and gated mode, and none of them can turn publish red (R11, R25).
- **Concurrency per job, never cancelling a publish:**
  - The workflow-level setting cancels only on `pull_request`.
  - Publish: one group, no cancel. It discovers its target by state, meaning the latest merged release PR with no tag.
  - Refresh: cancel group plus a `--force-with-lease` compare-and-swap.
  - Gate: idempotent per head.
- **Cutover lever.** A repository variable `RELEASE_MODE` (`legacy` | `gated`) selects the path. Both paths can't publish at once. `NPM_TOKEN` stays in the `release` environment as a fallback for the first gated release, then is deleted in PR 3.
- **Docs refresh after the narrative.** The narrative job dispatches `docs.yaml` with the tag once it has verified the rewrite. `release: edited` is not used, so an arbitrary body edit can't trigger a deploy. Docs builds run credential-free and treat release bodies as untrusted. A separate job holds the deploy key.

## Open Questions

### Resolved During Planning

- **Notes file vs. PR body:** `CHANGELOG.md` is the PR's only change (origin R9). The body mirrors it and is never read.
- **Changelog history:** starts at cutover, and its header links to GitHub Releases.
- **Release-notes page:** full history. A release without a narrative shows its body marked "narrative unavailable."
- **Docs refresh trigger:** an explicit dispatch from the narrative job.
- **PR phasing:** Phase 0 sandbox, then PR 1 (narrative and docs), PR 2 (gated pipeline, dark), cutover, and PR 3 (hardening).
- **Settings App split:** accepted risk, outside this change.

### Deferred to Implementation

All of these need Phase 0 sandbox evidence first:

- Can a GitHub App installation token enable auto-merge on its own PR? Is the resulting merge's push attributed so that `on: push` fires? Fallback: the publish job also runs on a bounded schedule and through `workflow_dispatch` reconcile, finding merged-but-untagged release PRs.
- Do `commitHeadline`/`commitBody` on `enablePullRequestAutoMerge` override the squash message? This keeps a `BREAKING CHANGE:` line in the mirrored body out of X. The publish version check is the backstop.
- Does OIDC publish work with no `NODE_AUTH_TOKEN` and no `registry-url`? Does `@semantic-release/npm` exchange OIDC in `verifyConditions`, before any tag is created? If it exchanges after the tag, an OIDC failure orphans a tag, so the reconcile path and the break-glass runbook must cover it.
- Does the bfra-me settings applier support `target: tag` rulesets and environments, and does it remove resources missing from config? If not, apply them with documented `gh api` calls.
- Can the `fro-bot` user dismiss its own review after a head change mid-gate? If not, the gate must re-check before approving with `commit_id`, and publish's exact-head check stays the backstop.
- How does the Fro Bot review flow (R23) withhold an approval when the PR head contains a `fro-bot`-authored commit? A deterministic pre-step in `fro-bot.yaml` versus an agent action input. Read the pinned `fro-bot/agent` inputs.
- What exact attestation subject and predicate format to use, and the matching `gh attestation verify` flags.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
    participant Main as main
    participant Rel as release.yaml
    participant PR as release/pending PR
    participant Gate as release-gate.yaml
    participant Pub as publish job (env: release)
    participant Post as release: published consumers

    Main->>Rel: push (any merge)
    Rel->>Rel: publish? only if tip is a merged, untagged release PR
    Rel->>PR: refresh (needs publish): rebuild from main, prepend CHANGELOG entry, mirror body, arm auto-merge
    Note over PR: new head voids prior approvals
    alt Marcus approves
        PR-->>Main: auto-merge (squash X)
    else Wed/Sun gate (no hold, checks green, current, shape ok)
        Gate->>PR: approve head H as fro-bot (commit_id=H)
        Gate->>Gate: re-read head/hold, attest {PR,H,review,run}
        PR-->>Main: auto-merge (squash X)
    end
    Main->>Rel: push X
    Rel->>Pub: verify invariants + approval/attestation
    Pub->>Pub: semantic-release (OIDC, committed entry as notes)
    Pub->>Post: release: published
    Post->>Post: Claude plugin branch; docs deploy; narrative job
    Post->>Post: narrative verified → dispatch docs.yaml(tag)
```

| State on push to main | Publish job | Refresh job |
|---|---|---|
| Tip is an untagged release merge X with a valid approval | publish | skip until a tag exists, then preview for the new range |
| Tip is an untagged release merge X, approval invalid | refused (red) | rebuild a new release PR |
| An untagged release merge exists but is not the tip | superseded (comment, green) | rebuild |
| Ordinary merge | skip | rebuild, or close the PR if nothing is releasable |
| `RELEASE_MODE != gated` | skip (legacy job publishes) | preview to the job summary only |

## Phased Delivery

- **Phase 0, sandbox (Marcus, with agent help).** Use a throwaway GitHub repo to settle the deferred questions above. Create the release App, the `release` environment (deployment branch `main`), and the npm trusted publisher bound to `release.yaml` plus `release`. The workflow filename is final from here on.
- **PR 1:** narrative hardening, the narrative job, and the docs release-notes page. These work on today's pipeline.
- **PR 2:** the gated pipeline, landed dark (`RELEASE_MODE=legacy`).
- **Cutover:** flip `RELEASE_MODE=gated`. The first gated release keeps `NPM_TOKEN` as a fallback.
- **PR 3, after one verified gated release:** rulesets and tag rulesets, immutable releases, `SECURITY.md`, SHA pinning, the R23 enforcement, and removal of the legacy path and `NPM_TOKEN`.

## Implementation Units

### PR 1: Narrative and docs

- [ ] **Unit 1: Narrative hardening (#1089)**

**Goal:** A narrative run that doesn't rewrite the release is reported as `narrative-not-applied`, never as success. The agent gets a writable scratch directory.

**Requirements:** R25, AE12

**Dependencies:** None

**Files:**
- Modify: `scripts/dispatch-release-notes.sh`, `.agents/skills/release-notes-narrative/SKILL.md`, `tests/fixtures/mock-gh.sh`
- Test: `tests/integration/release-notes-ci.test.ts`

**Approach:**
- The prompt and the skill both name `$RUNNER_TEMP/release-notes` as the only scratch directory.
- Replace the `BODY_LEN >= 200` check with a before/after body comparison plus the `## What's new` marker.
- `narrative-not-applied` becomes its own outcome with a non-zero exit. The script will now run in its own job (Unit 2), so a red result there never marks publish as failed.
- Keep the existing security-class outcomes.

**Execution note:** Test-first. Extend the mock-gh scenarios before changing the script.

**Patterns to follow:** existing scenario env vars in `tests/integration/release-notes-ci.test.ts`.

**Test scenarios:**
- Happy path: the body changes and starts with `## What's new` → success.
- Error path: the body is unchanged and longer than 200 characters (the v3.21.7 case) → `narrative-not-applied` with a non-zero exit.
- Error path: the body changed but lacks the marker → `narrative-not-applied`.
- Edge: the release already narrated (idempotency check) → success with no dispatch.
- Integration: the prompt text contains the scratch-directory instruction, and the skill's paths match it.

**Verification:** Every scenario passes. A reproduction of the v3.21.7 failure no longer exits 0.

- [ ] **Unit 2: Narrative as its own job**

**Goal:** The narrative runs on `release: published` in its own workflow, outside the publish job, and dispatches the docs refresh once it has verified the rewrite.

**Requirements:** R11, R25, R27, AE12, AE14

**Dependencies:** Unit 1

**Files:**
- Create: `.github/workflows/release-notes.yaml`
- Modify: `.releaserc.yaml` (drop the `@semantic-release/exec` `successCmd` entry)
- Test: `tests/unit/release-notes-workflow.test.ts`

**Approach:**
- Triggers: `release: published` (skip prereleases) and `workflow_dispatch` with a `tag` input, for re-narration.
- Permissions: `contents: read` and `actions: write`. Uses `GITHUB_TOKEN`, which can dispatch `workflow_dispatch` runs.
- Concurrency: group per tag, no cancel.
- On verified success, dispatch `docs.yaml` with the tag.

**Patterns to follow:** `tests/unit/host-contract-workflow.test.ts` (`readWorkflow`, `findStep`).

**Test scenarios:**
- The workflow triggers on `release: published` and dispatch only, and holds no release secrets.
- The docs dispatch step runs only after a successful narrative step.
- `.releaserc.yaml` has no `successCmd`.

**Verification:** The workflow tests pass. A dispatch against an existing tag in a manual run narrates and redeploys docs. That run is observed after merge.

- [ ] **Unit 3: Docs release-notes page**

**Goal:** A generated release-notes page shows every release, newest first, using the narrative body. A release without the marker shows its body labelled "narrative unavailable."

**Requirements:** R27, AE14

**Dependencies:** None

**Files:**
- Create: `docs/scripts/generate-release-notes.ts`
- Modify: `package.json` (`docs:generate` chain), `.gitignore` (generated page), `docs/astro.config.mjs` (sidebar entry, if `autogenerate` doesn't cover it)
- Test: `tests/unit/generate-release-notes.test.ts`

**Approach:**
- Fetch releases through the GitHub API with `GH_TOKEN` when present.
- Without a token or network, generate a stub page that links to GitHub Releases, so local `docs:build` still works.
- Treat bodies as untrusted: strip raw HTML, allowlist `https:` links, escape MDX-significant braces, and cap the per-release length.
- Record each release's `updated_at`.

**Patterns to follow:** `docs/scripts/transform-content.ts` and its sanitization history (`tests/unit/transform-content.test.ts`).

**Test scenarios:**
- Happy path: narrated releases render in order, with their version headings.
- Edge: a release without `## What's new` gets the "narrative unavailable" label.
- Edge: no token → a stub page, and the build still succeeds.
- Error path: hostile bodies (`<script>`, `{}`, backticks, `javascript:` links) are neutralized.
- Integration: the generated page passes `markdownlint` with the repo config.

**Verification:** `bun run docs:build` succeeds locally with and without `GH_TOKEN`, and the tests pass.

- [ ] **Unit 4: Split the docs build and deploy, and add a tag dispatch**

**Goal:** Docs build without credentials, the deploy key never runs next to fetched release bodies, and a tag dispatch builds that tag.

**Requirements:** R10, R20, R27

**Dependencies:** Unit 3

**Files:**
- Modify: `.github/workflows/docs.yaml`
- Test: `tests/unit/docs-workflow.test.ts`

**Approach:**
- A `build` job (`contents: read`; `GITHUB_TOKEN` for reading releases) uploads the site artifact.
- A `deploy` job downloads it and holds `FRO_BOT_APPLICATION_*`.
- A `workflow_dispatch` with a tag input checks out that tag.
- Keep `docs-deploy` with cancel-in-progress, so the newer run wins.

**Test scenarios:**
- Only the deploy job references `FRO_BOT_APPLICATION_*`.
- The build job's permissions are read-only.
- A dispatch with a tag checks out that ref.
- Prereleases are still skipped.

**Verification:** The workflow tests pass. After merge, a manual dispatch for the latest tag deploys the page.

### PR 2: Gated pipeline, landed dark

- [ ] **Unit 5: Preview and changelog writer**

**Goal:** One deterministic preview of the pending version and entry, and a writer that maintains `CHANGELOG.md`.

**Requirements:** R2, R3, R4, R9, R26, AE1, AE4

**Dependencies:** None

**Files:**
- Create: `scripts/release/preview.ts`, `scripts/release/changelog.ts`, `scripts/release/changelog-header.md`
- Test: `tests/unit/release-preview.test.ts`, `tests/unit/release-changelog.test.ts`

**Approach:**
- `preview` loads `.releaserc.yaml` and runs the configured commit-analyzer and release-notes-generator over commits since the last `v*` tag. It returns `{version, entry}` or "nothing releasable."
- `changelog` creates the file from the header template and sentinel when it is absent. If the file exists but the sentinel is missing, it fails loudly. It removes entries whose `v<version>` tag doesn't exist (phantoms), then prepends the new entry after the sentinel.
- Output is markdownlint-clean.

**Execution note:** Test-first with temporary git repos as fixtures.

**Test scenarios:**
- Happy path: two `fix` commits since the last tag → next patch, with both in the entry (AE1).
- Happy path: one `feat` among several `chore` commits → minor.
- Edge: only `chore`/`test` commits → nothing releasable (AE4).
- Edge: a `docs(readme)` commit → patch, per `releaseRules`.
- Edge: no `CHANGELOG.md` → created with the header and a link to GitHub Releases.
- Error path: the file exists without a sentinel → hard error.
- Edge: a phantom entry for an untagged version → stripped before the prepend.
- Integration: the preview version equals what semantic-release core computes for the same fixture. Run core in dry-run against a local bare remote.

**Verification:** The tests pass, including the parity test against core.

- [ ] **Unit 6: Publish verification and the changelog notes plugin**

**Goal:** A deterministic verifier for the publish invariants, plus a semantic-release plugin that publishes the committed entry and refuses on a version mismatch.

**Requirements:** R6, R7, R8, R9, R15, AE5, AE6, AE9

**Dependencies:** Unit 5

**Files:**
- Create: `scripts/release/verify-merge.ts`, `scripts/release/changelog-notes-plugin.ts`
- Test: `tests/unit/release-verify-merge.test.ts`, `tests/unit/release-changelog-notes-plugin.test.ts`

**Approach:**
- The verifier takes X and GitHub API reads (injected for tests).
- It returns `publish`, `superseded`, or `refused`, with a reason.
- It enforces every invariant listed in Key Technical Decisions, including the hold rule.
- The plugin's `generateNotes` returns the top entry. Its `verifyRelease` refuses when the entry version is not `nextRelease.version`.

**Execution note:** Test-first. One verifier rule per slice.

**Test scenarios:**
- Happy path: Marcus approval on the final head, submitted before the merge → `publish`.
- Happy path: a `fro-bot` approval with a valid gate attestation for the same PR, head, and review → `publish`.
- Error path: the approval's `commit_id` is an earlier head → `refused` (AE5).
- Error path: the approval was submitted after `merged_at` → `refused`.
- Error path: a dismissed approval → `refused`.
- Error path: a `fro-bot` approval without an attestation, or with a branch source ref → `refused`.
- Error path: hold set and only a `fro-bot` approval → `refused`. Hold set with Marcus's approval → `publish`.
- Error path: the head diff touches a file other than `CHANGELOG.md`, removes a tagged entry, or the head's parent ≠ X's parent → `refused`.
- Edge: X is not the main tip → `superseded`.
- Edge: no merged release PR for X (an ordinary merge or a dispatch) → no publish (AE6).
- Plugin: the entry version differs from `nextRelease.version` (for example, a `BREAKING CHANGE:` in the squash body) → `verifyRelease` throws.
- Plugin: `generateNotes` returns exactly the committed entry bytes, without the sentinel or header (AE9).

**Verification:** All tests pass.

- [ ] **Unit 7: `release.yaml` (publish and refresh)**

**Goal:** The gated workflow. Publish runs only on a verified release merge. The refresh maintains the release PR. In legacy mode it only previews.

**Requirements:** R1–R3, R5–R8, R11–R13, R16–R18, R20, AE2, AE7, AE8

**Dependencies:** Units 5 and 6. Phase 0 (App, environment, npm binding).

**Files:**
- Create: `.github/workflows/release.yaml`
- Test: `tests/unit/release-workflow.test.ts`

**Approach:**
- Triggers: push to `main` and `workflow_dispatch` (reconcile).
- **`build` job (no credentials):** install, build, and upload `dist/` with its digest.
- **`publish` job:**
  - Runs only when `vars.RELEASE_MODE == 'gated'`, with environment `release` and `id-token: write`.
  - Concurrency group with no cancel.
  - Installs lockfile tooling with `--ignore-scripts`, verifies the artifact, and runs the verifier.
  - Runs semantic-release with gated plugin overrides (the changelog notes plugin in place of release-notes-generator, no exec) and `npm_config_ignore_scripts=true`.
  - Afterwards asserts that the tag, the release, and `npm view <version>` all exist.
- **`refresh` job:**
  - `needs: publish` with `always()`, environment `release`, and a cancel group.
  - In gated mode it rebuilds `release/pending` from the main tip using the release App token, then writes the entry.
  - It pushes with `--force-with-lease` on the observed head, then updates the PR body to mirror the entry.
  - It opens the PR with a non-releasing title (`chore(release): v<version>`) and arms auto-merge with `expectedHeadOid`. It closes the PR when nothing is releasable and the tip is unchanged.
  - In legacy mode it writes the preview to the job summary only.

**Patterns to follow:** the current `release` job's App-token and git-identity steps.

**Test scenarios:**
- Publish is skipped unless `RELEASE_MODE == gated`.
- Only `publish` and `refresh` reference the `release` environment or the App secrets.
- No job references `NPM_TOKEN` outside the `release` environment.
- `publish` has no `bun run build` step, and sets `ignore-scripts`.
- `setup-node` has no `registry-url`.
- `refresh` depends on `publish`.
- No job has `cancel-in-progress: true` except `refresh`.
- The release PR title type is non-releasing under `.releaserc.yaml` rules.

**Verification:** The workflow tests pass. A dark-mode run on main writes a preview summary that matches Unit 5 output.

- [ ] **Unit 8: `main.yaml`, the credential-free `Release` check, and moving the Claude plugin**

**Goal:** The required `Release` context becomes a credential-free check. The legacy publish runs only in legacy mode and can't be cancelled. The Claude plugin publish moves to `release: published`.

**Requirements:** R10, R11, R19, AE8

**Dependencies:** Unit 5

**Files:**
- Modify: `.github/workflows/main.yaml`, `.github/workflows/renovate.yaml` (exclude `release/**` from `push`)
- Create: `.github/workflows/publish-claude-code-plugin.yaml`
- Test: `tests/unit/host-contract-workflow.test.ts`, `tests/unit/main-release-workflow.test.ts`

**Approach:**
- **`Release` job.** Keeps its name. It runs the preview on PRs and pushes, with `contents: read` and no secrets. On a `release/pending` PR it also checks the entry against the preview.
- **Legacy publish.** Becomes `legacy-release`: push-only, `if: vars.RELEASE_MODE != 'gated'`, carrying today's steps. The `workflow_dispatch` dry-run input is removed.
- **Concurrency.** Workflow-level `cancel-in-progress` applies only on `pull_request`.
- **Claude plugin.** Its job moves to its own workflow on `release: published`, checking out the tag. The existing bundle guard is unchanged.

**Test scenarios:**
- On `pull_request`, no job references a release secret or `id-token: write`.
- `legacy-release` is skipped in gated mode.
- The `Release` context exists for every PR event.
- `cancel-in-progress` evaluates false on push.
- The Claude plugin workflow triggers only on non-prerelease `release: published`.
- `renovate.yaml` ignores `release/**`.

**Verification:** The workflow tests pass, and the next legacy release still publishes the plugin through the new workflow. Confirm with `npm view` and the plugin branch's commit.

- [ ] **Unit 9: Release approval gate**

**Goal:** A deterministic Wednesday/Sunday (or Marcus-dispatched) gate that approves the current head as `fro-bot` and attests that approval.

**Requirements:** R14, R15, AE2, AE3, AE10

**Dependencies:** Units 5 and 6

**Files:**
- Create: `.github/workflows/release-gate.yaml`, `scripts/release/gate.ts`
- Test: `tests/unit/release-gate.test.ts`, `tests/unit/release-gate-workflow.test.ts`

**Approach:**
- Triggers: cron for Wednesday and Sunday, plus `workflow_dispatch`, which proceeds only when `actor` and `triggering_actor` are both Marcus.
- `gate.ts` approves the head only when all of these hold:
  - `RELEASE_HOLD` is unset;
  - required checks are green on the head;
  - the PR is 0 behind and 1 ahead of main;
  - its diff is the expected `CHANGELOG.md` shape;
  - the head commit's author is the release App.
- It approves with `commit_id`, then re-reads the head and the hold, and dismisses (or reports) if either changed.
- After the re-check it creates an attestation binding the PR, head, review id, and run.
- Permissions: `id-token: write`, `attestations: write`, `contents: read`. `FRO_BOT_PAT` is used only for the review call.

**Test scenarios:**
- Happy path: all conditions hold → approve, then attest.
- Edge: hold set → no approval, with the reported reason (AE3).
- Edge: checks pending or failing → no approval.
- Edge: behind main, or a diff outside `CHANGELOG.md` → no approval.
- Error path: the head changes between the read and the approval → dismissed or reported, and no attestation.
- Error path: dispatched by anyone else → refused (AE10).
- The workflow file has no `pull_request` trigger and does not use agent actions.

**Verification:** The gate tests pass. In Phase 0, a sandbox run produces an approval and an attestation that `verify-merge` accepts.

- [ ] **Unit 10: Settings for the dark launch**

**Goal:** The environment and release-branch protection needed before cutover. Main protection is unchanged.

**Requirements:** R16, R17

**Dependencies:** Phase 0 settings-applier findings

**Files:**
- Modify: `.github/settings.yml` (or a documented `gh api` runbook if the applier lacks support)

**Approach:**
- Environment `release` with deployment branches limited to `main`.
- A `release/**` branch ruleset that restricts creation, update, and deletion, with the release App as its only bypass.
- `allow_auto_merge` stays true.

**Test expectation:** none, because this is repository configuration. It is verified live.

**Verification:** `gh api` shows the environment, its branch policy, and the ruleset. A push to `release/pending` with any other identity is rejected.

### Cutover (manual, Marcus)

Set `RELEASE_MODE=gated`. The first gated release keeps `NPM_TOKEN` in the `release` environment. Verify that:
- the release PR opens;
- the gate or Marcus approves it;
- it publishes, confirmed with `npm view` and the provenance attestation;
- the plugin branch and docs update;
- the narrative lands.

Roll back by setting `RELEASE_MODE=legacy`.

### PR 3: Hardening after cutover

- [ ] **Unit 11: Fro Bot approval rule (R23)**

**Goal:** Fro Bot approves only PRs that Marcus authored, and never a head that contains a commit it authored.

**Requirements:** R23, AE11

**Dependencies:** Cutover verified

**Files:**
- Modify: `.github/workflows/fro-bot.yaml`
- Test: `tests/unit/fro-bot-workflow.test.ts`

**Approach:** A deterministic pre-step computes whether the PR author is Marcus and whether the head contains any `fro-bot` commit. When either check fails, the review runs in comment-only mode (mechanism decided under Deferred to Implementation).

**Test scenarios:**
- A Marcus PR with no `fro-bot` commits → approval allowed.
- A Marcus PR after an autoheal push → comment only.
- A non-Marcus author → comment only.

**Verification:** The workflow tests pass. An observed autoheal PR is not approved by Fro Bot.

- [ ] **Unit 12: Rulesets, tags, immutable releases, and policy**

**Goal:** Scorecard-readable protection and the hardening end state.

**Requirements:** R21, R22, R24

**Dependencies:** Unit 11. Main must have no open PRs that rely on classic-only behavior.

**Files:**
- Modify: `.github/settings.yml`
- Create: `SECURITY.md`

**Approach:**
- Main ruleset with no bypass:
  - block force pushes and deletion;
  - require linear history;
  - require the existing checks, pinned to the GitHub Actions integration;
  - require one approval and dismiss stale approvals.
- Activate it, then remove classic protection.
- Tag rulesets:
  - `v*` creation, with the release App as bypass;
  - `v*` update and delete, with no bypass.
- Turn on immutable releases and `sha_pinning_required`.
- Document the admin break-glass path: edit the ruleset in the UI.

**Test expectation:** none, because this is configuration. It is verified live, and through Scorecard.

**Verification:**
- `gh api` shows the rulesets and the settings.
- A direct push to main is rejected.
- The next Scorecard run shows a Branch-Protection score instead of -1 and Security-Policy at 10.

- [ ] **Unit 13: Remove the legacy path and `NPM_TOKEN`**

**Goal:** One publish path and no long-lived npm token.

**Requirements:** R12, R1

**Dependencies:** One verified OIDC gated release

**Files:**
- Modify: `.github/workflows/main.yaml` (delete `legacy-release` and the `RELEASE_MODE` branches), `.github/workflows/release.yaml` (drop the mode check), `.releaserc.yaml` (move the gated plugin list in, so the config matches what publishes)
- Test: `tests/unit/main-release-workflow.test.ts`, `tests/unit/release-workflow.test.ts`

**Approach:** Delete the `NPM_TOKEN` secret from the environment and the repo after the merge. The runbook moves into the contributor docs.

**Test scenarios:**
- No workflow references `NPM_TOKEN`.
- No job publishes outside `release.yaml`.
- `.releaserc.yaml` matches the gated plugin list.

**Verification:** The tests pass, the next release publishes through OIDC alone, and `gh secret list` shows no `NPM_TOKEN`.

## System-Wide Impact

- **Interaction graph:**
  - Push to main → `main.yaml` (CI plus the `Release` check), `release.yaml` (publish, then refresh), and Renovate's `workflow_run`.
  - `release: published` → narrative, Claude plugin, and docs.
  - Narrative → docs dispatch.
  - Schedule → gate.
- **Error propagation:**
  - Refused publishes go red.
  - Superseded publishes comment and stay green.
  - Narrative failures go red in their own workflow.
  - Docs refresh failures go red in `docs.yaml`, and can be retried by dispatching the tag.
- **State lifecycle risks:**
  - Phantom `CHANGELOG.md` entries after a failed publish, which the refresh strips.
  - An orphaned tag after an OIDC failure, handled by reconcile and the runbook.
  - A stale release PR after cancelled refreshes, prevented by the compare-and-swap.
- **API surface parity:** `.releaserc.yaml` stays the only rule source for preview, check, and publish.
- **Integration coverage:**
  - The preview-vs-core parity test (Unit 5).
  - Phase 0 sandbox runs for auto-merge, attestation, and OIDC.
  - The first gated release is the end-to-end proof.
- **Unchanged invariants:**
  - The release rules and `tagFormat`.
  - The Claude plugin bundle guard and the orphan branch.
  - The docs and registry build contents.
  - The PR title still selects the release type for feature PRs.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| App-enabled auto-merge doesn't trigger `on: push` | Phase 0 test. A reconcile dispatch and a bounded schedule discover merged, untagged release PRs. |
| OIDC fails at first publish | `NPM_TOKEN` fallback in the `release` environment for the first gated release. Rollback with `RELEASE_MODE=legacy`. |
| OIDC failure after the tag is created | Phase 0 verifies when OIDC is exchanged. Reconcile and a break-glass runbook cover an orphaned tag before the tag rulesets land. |
| Rulesets brick main mid-cutover | Main ruleset only in PR 3, after a verified release. Activate it before removing classic protection. Document the admin UI escape hatch. |
| Approval churn when main moves often | Accepted. Marcus approves when ready, and the gate re-approves on each pass. |
| Leaked `FRO_BOT_PAT` approves a release | Accepted risk (origin). Approvals and publishes are visible, and the hold restricts publishing to Marcus's approval. |
| The shared Renovate/settings App key has `administration` | Accepted risk, outside this change. A dedicated settings App is planned at Marcus's org level. |
| Hostile commit subjects or release bodies break the docs build | Sanitization and hostile-input tests (Units 3 and 5). The build job has no credentials. |
| Preview diverges from core | Parity test (Unit 5). Publish-time `verifyRelease` version check (Unit 6). |

## Documentation / Operational Notes

- **Runbook** (contributor docs plus a `docs/solutions/` entry after cutover). It covers:
  - hold and unhold (`RELEASE_HOLD`);
  - on-demand gate dispatch;
  - reconcile dispatch;
  - rollback (`RELEASE_MODE`);
  - re-narration dispatch;
  - break-glass for an orphaned tag;
  - the ruleset escape hatch.
- Update `docs/solutions/best-practices/release-notes-narrative-ci-automation-architecture-2026-05-23.md` for the new job and the post-check.
- Phase 0 results are recorded in this plan's Deferred to Implementation answers before PR 2 is finalized.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-10-11-gated-release-pr-requirements.md](../brainstorms/2026-10-11-gated-release-pr-requirements.md). The path is gitignored, so it is local only and not in the repository.
- Related issues: #1089 (narrative silent failure).
- Reference implementation (design input): fro-bot/agent at `60d5a075142bbaa2d533de96a6daa7f3887d1038`.
- External docs:
  - https://docs.npmjs.com/trusted-publishers/
  - https://github.com/semantic-release/semantic-release/blob/v25.0.0/docs/usage/plugins.md
  - https://docs.github.com/en/rest/repos/rules
  - https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations
