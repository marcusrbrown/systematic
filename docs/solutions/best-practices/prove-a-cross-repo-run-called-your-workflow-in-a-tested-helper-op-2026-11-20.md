---
title: Prove that a run in another repository called your reusable workflow in a tested helper op, not in skill prose
date: 2026-11-20
category: best-practices
module: ce-connect
problem_type: architecture_pattern
component: assistant
severity: high
applies_when:
  - "A skill must decide whether to trust a run, artifact or record that another repository produced"
  - "The evidence is a GitHub API answer that a model would otherwise read and judge"
  - "A trust gate sits in skill prose that only wording tests can pin"
  - "A workflow in one repository is called by workflows in repositories you do not own"
tags: [ce-connect, provenance, reusable-workflow, referenced-workflows, github-api, helper-op, skill-design, trust-boundary]
---

# Prove that a run in another repository called your reusable workflow in a tested helper op, not in skill prose

## Context

Systematic's `connect.yaml` is a reusable workflow, so a scheduled run in another repository can call it. A user brings that run's candidates to their machine with a named word, `fetch:<owner>/<repo>:<run>.<attempt>`. Before anything is downloaded, the skill has to decide whether the run really called Systematic's workflow at a commit Systematic published. A wrong yes lets any repository's artifact stand in for a `ce:connect` record.

A trust decision written as steps for a model fails where no test can see it. A test of skill prose can only assert that the prose says "never judge the list yourself" (`tests/unit/connect-skill-contract.test.ts:747-756`); it cannot show that a model matched the right entry, kept the hash's length and case, or read `behind` and `ahead` the right way round. So the decision is a pure function (`verifyProvenance`, `src/lib/connect-provenance.ts:87-107`) behind a helper op. The skill does the part a script cannot, running the user's own `gh`, and sends the text it got. Every rule is then a case in a table that runs offline, and a wrong rule fails a named test.

The rule applies when a skill decides whether to trust output from a repository, run or account the user does not control, the evidence is an API answer, and the decision has several rules (an owner, a path, a hash shape, an ancestry direction) that a model could get one of wrong without any step looking off.

## Guidance

### Know what the API says, and what it does not

- **The run's own `path` proves nothing.** In a called run it is the caller's wrapper (CN-7 observation 2 in [`HARNESSES.md`](../../../HARNESSES.md), and `skills/ce-connect/references/fetch-and-import.md:70`).
- **`referenced_workflows` on the attempt is the evidence.** The attempts endpoint ([GitHub REST: get a workflow run attempt](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt)) returns a list of entries. Each has a `path` of `owner/repo/.github/workflows/x.yaml@<suffix>` and a 40-hex `sha`. For both a local and a cross-owner call it was present on attempts 1 and 2 and identical on both after a failed-jobs rerun (CN-7 observation 2). The skill reads the exact attempt the word names, never the newest (`skills/ce-connect/references/fetch-and-import.md:77`).
- **Only the `sha` is stable across the two observed call types.** A `ref` key appeared only on the local call, and a tag-pinned cross-owner call was not run, so its `@` suffix may differ (CN-7, observation 2 and the not-observed list). The code never reads `ref` or the text after the `@` (`src/lib/connect-provenance.ts:73-77`, `workflowOf`; `src/lib/connect-provenance.ts:100-101`, the `sha` check).
- **There is no artifact-to-job binding.** GitHub offers nothing that says which job uploaded an artifact, so the proof is about the run, not the artifact (see the limits below).

### Match one entry, by name, exactly

`isSystematicConnect` (`src/lib/connect-provenance.ts:79-85`) takes the part of `path` before the `@`. The text before `/.github/workflows/connect.yaml` must equal `marcusrbrown/systematic` once lowercased, and the file path must match exactly. The owner and repository ignore case because GitHub names them without regard to case; the file path does not, so `.github/Workflows/connect.yaml` is another file (`tests/unit/connect-provenance.test.ts:174-189`).

- **Match by path, never by index, and never by suffix.** The attempt's list can hold more than one entry (CN-7 observation 2), and a stray entry must not change the answer (`tests/unit/connect-provenance.test.ts:97-112`). Equality on the owner and repository refuses a fork, a prefixed or suffixed lookalike, `connect.yml` and a nested path as `not-a-connect-run` (`tests/unit/connect-provenance.test.ts:129-172`); an `endsWith` would pass the lookalikes.
- **Anything missing, malformed or ambiguous is unprovable.** An absent value, a non-list, an empty list, an entry with no string `path`, non-JSON text, a `sha` that is not 40 lowercase hex and more than one matching entry, even with the same `sha`, all give `provenance-unprovable` (`src/lib/connect-provenance.ts:49-71`, `src/lib/connect-provenance.ts:98`; `tests/unit/connect-provenance.test.ts:35-76`, `tests/unit/connect-provenance.test.ts:205-219`, `tests/unit/connect-provenance.test.ts:222-246`). That reason means the proof is missing, not that the run is hostile, and the skill prints a different remedy than for `not-a-connect-run` (`skills/ce-connect/references/fetch-and-import.md:240-241`).
- **The allowed workflow is hard-coded.** The owner, the repository and the file are constants (`src/lib/connect-provenance.ts:35-37`, `OWNER_REPO`, `WORKFLOW_FILE`). Nothing from the record, the word or a downloaded file chooses them (`skills/ce-connect/references/fetch-and-import.md:9`).

### Prove ancestry with the compare API, in one direction

`compare/main...<sha>` reports the status of `<sha>` relative to `main`: `ahead` for a commit on an unmerged branch, `behind` for one in `main`'s history, `identical` for its tip, and HTTP 404 for an unknown or malformed SHA (CN-7 observation 3; [GitHub REST: compare two commits](https://docs.github.com/en/rest/commits/commits#compare-two-commits)). The helper accepts `behind` and `identical` and refuses every other value, `ahead`, `diverged` and an empty status included (`src/lib/connect-provenance.ts:103-106`; `tests/unit/connect-provenance.test.ts:271-295`). The status describes the head relative to the base, so the skill passes `main` first and the `sha` second and says never to swap them (`skills/ce-connect/references/fetch-and-import.md:117-120`). A swapped range inverts every answer, and the rule above would then accept exactly the commits it must refuse.

A 404 for no access was not observed, only one for an unknown SHA; the skill stops on any failure of the call as `provenance-unprovable` and does not call the helper again (`skills/ce-connect/references/fetch-and-import.md:122`). CN-7 observed an unauthenticated request to the public repository; a job-scoped token was not tried. `diverged` was not produced in the probes, so its refusal rests on the code and its tests.

### Bind every `gh` call to the host the allow-list checked

The allowed origins are github.com origins. A set `GH_HOST` or a GHE remote must not redirect the checks, so each call names the host: `gh api --hostname github.com` and `gh run download --repo github.com/<owner>/<repo>` (`skills/ce-connect/references/fetch-and-import.md:5`, the `--hostname` rule; `skills/ce-connect/references/fetch-and-import.md:188` and `skills/ce-connect/references/fetch-and-import.md:194`, the `gh run download` calls). Look the artifact up by its exact name, `?name=connect-run-<run>-<attempt>`, or paginate when the attempt is not known; a run can hold more than one page of artifacts (`skills/ce-connect/references/fetch-and-import.md:143-160`).

### Put the decision in a helper op the skill pipes `gh` output into

The skill sends the text `gh` printed, unchanged, on stdin; it never reads the list, picks an entry or checks a hash (`skills/ce-connect/references/fetch-and-import.md:75`). The op is `verify-provenance`, called twice: with the attempt's list alone it answers which commit to compare (`selected`), and with the same text and the compare status after `--status` it answers whether that status is one it accepts for the selected entry (`accepted`) (`skills/ce-connect/references/fetch-and-import.md:94-131`). It reads no network, file, lock or configuration, and stdin is the request itself, so text that is not JSON is judged as `provenance-unprovable` and not refused as a malformed request (`src/ce-connect-helper.ts:3838-3840`, `src/ce-connect-helper.ts:3774-3784`).

**The helper judges only the evidence it is given.** It does not check that the two answers belong together: the `status` is judged on its own against `behind` and `identical`, and nothing ties it to the `sha` the first call selected or to the compare direction (`src/lib/connect-provenance.ts:87-107`, `verifyProvenance`; `src/ce-connect-helper.ts:3486-3499`, `verifyProvenanceOp`). The skill carries that part. It must compare the `sha` the helper selected, with `main` as the base, and send back that same request's status with the same text (`skills/ce-connect/references/fetch-and-import.md:117-131`). Wording tests pin those steps, not a model's obedience (`tests/unit/connect-skill-contract.test.ts:769-781`), so a status from the wrong commit or the wrong direction would still be accepted if it says `behind`.

**Two answer shapes, on purpose.** The pure function returns `{status: 'selected' | 'accepted', sha}` or `{status: 'refused', reason}` (`src/lib/connect-provenance.ts:19-25`, `ProvenanceVerdict`). The op wraps that in the helper's envelope: `{ok: true, op, outcome: 'complete', stage, sha}` on success and `{ok: false, op, outcome: 'failed', reason}` on refusal, where `stage` carries the function's `status` (`src/ce-connect-helper.ts:227-236`, `failure` and `success`; `src/ce-connect-helper.ts:3492-3499`). The skill reads `ok`, `stage` and `reason` (`skills/ce-connect/references/fetch-and-import.md:109-111`). Reading `status` from the op's answer finds nothing. Both shapes are pinned (`tests/unit/connect-provenance.test.ts:19-23`; `tests/unit/ce-connect-helper-ops.test.ts:3151-3201`).

### State the limits where the reader decides

The check is real and it is narrow. The guide lists three limits (`docs/src/content/docs/guides/cross-project-connections.mdx:617-620`):

- **Provenance is run-level only.** It shows that the run called Systematic's `connect.yaml` at a commit in `main`'s history. GitHub gives no artifact-to-job binding, so another job in the same run could upload an artifact with the expected name. The import's own checks of spans and excerpts against local files are what stand between such a record and the ledger.
- **Allow-listing an origin trusts its workflows.** A named fetch needs the repository to be the origin of an allowed checkout, and the record comes from a run in that repository.
- **Old callee commits stay trusted.** Any commit in `main`'s history passes, and there is no version floor. After a security fix, callers re-pin; nothing refuses a run that called an older commit.

## Why This Matters

Prose rules at a trust gate are model-level; a helper op makes the rules about the evidence it is given deterministic and keeps the two failure modes apart, so the user gets the right remedy for each. How the evidence was gathered stays with the skill.

## When to Apply

A skill gates trust on another repository's API evidence and the gate has more than one rule. Call the op in two stages with the same text rather than letting the skill carry state between calls.

## Examples

The verdict is `{status, sha}` or `{status, reason}` and nothing else: no path, branch name or extra field of the input comes back (`tests/unit/connect-provenance.test.ts:329-345`).

## Related

- [A skill that wraps an untrusted-text researcher needs baseline pressure tests, a helper for exactness, and a stated limits list](skill-around-an-untrusted-researcher-needs-baseline-pressure-tests-2026-11-09.md): the general rule that exactness belongs in a helper, and the limits list this doc adds to.
- [Called-workflow GitHub context is the caller's: use `job.workflow_*` and inputs](called-workflow-github-context-is-the-callers-use-job-workflow-and-inputs-2026-11-20.md): why the callee's identity and the caller's wrapper path differ in the first place.
- [Spike cross-owner workflow behaviour with push-triggered stub probes](spike-cross-owner-workflow-behaviour-with-push-triggered-stub-probes-2026-11-20.md): how the `referenced_workflows` and compare behaviour was observed.
- [Pinned helper and installed client skew in a reusable workflow rollout](../integration-issues/pinned-helper-and-installed-client-skew-in-a-reusable-workflow-rollout-2026-11-20.md): the helper version a foreign caller must carry for this op to exist.
- [Evidence boundary for reading other repositories](evidence-boundary-for-reading-other-repositories-2026-11-09.md): the read boundary a fetched record still passes through.
