---
title: "feat: ce:connect project groups, scheduled runs and CI candidate fetch"
type: feat
status: active
date: 2026-11-12
origin: docs/brainstorms/2026-11-12-ce-connect-groups-and-scheduled-runs-requirements.md
---

# feat: ce:connect project groups, scheduled runs and CI candidate fetch

## Overview

`ce:connect` reads the whole `connect.allow_projects` list on every run, and only an operator starts a run. This plan adds three things in two deliveries.

Delivery A (units U1-U7) is product code, shipped in one Systematic release:

- Named groups in user config, and one-off picks. `group:<name>` and `projects:<a>,<b>` narrow a run to part of the allow list and never widen it.
- Coverage and sweep progress kept per selection, so a narrow run never counts as coverage of the whole list. The ledger moves to version 2.
- A portable project identity (`owner/repo` plus HEAD commit) in each run record, an `import` op, and `fetch:<run>` in the skill. A lesson found by a CI run can then be promoted locally after the runner is gone.
- Two CI helper ops, `apply-ticks` and `render-report`, shipped with the product so the helper version and the workflow version match.

Delivery B (units U8-U10) is the workflow. `.github/workflows/connect.yaml` runs one headless slice daily over public repositories named in a repository variable. It keeps its ledger in an Actions cache and posts one rotating report issue per UTC date. The operator settles candidates with Promoted and Rejected boxes. Delivery B pins `systematic-version` to the release that ships Delivery A, and a manual dispatch proves it.

U0 is a spike that runs during Delivery A. It proves on a real runner that the `fro-bot/agent` action can run `ce:connect` under the planned layout. A failed spike is a stop-and-ask point, because the fallback is a change in another repository.

The plan depth is Deep: it crosses config, a bundled helper, a ledger format, a skill, a workflow with credentials, and a public write.

---

## Problem Frame

The origin document carries the full frame. It is untracked (see Sources & References). In short:

- Comparing Systematic with a few sibling tools means rewriting the allow list for one run and restoring it afterwards. By hand, that either pulls unrelated projects into the comparison or loses the usual set.
- A full sweep of a group takes about five runs a few days apart, and nothing prompts the next one. Headless mode was built so a scheduler could drive it, and no scheduler exists. A slice costs about 15 minutes of model time.
- A scheduled run happens on a runner whose paths vanish, so a CI-found lesson cannot be promoted from its own record. The record has to be re-verified against the operator's own checkouts.

The design has to hold these at once:

- The allow list stays the only trust boundary. A selection only narrows it.
- Coverage from a narrow run must not suppress a rule for the full list.
- A scheduled agent step holds only a read-only token, and the one unattended write (the report issue) happens in a job that runs no repository code.
- Report text is inert, and decisions come only from checkboxes the post job generated.
- The model-provider credential is readable by the agent step on the runner. That residual is documented, not removed.

---

## Requirements Trace

The origin defines R1-R21 and AE1-AE12. This plan covers all of them. Short forms below are paraphrases.

| ID | Requirement (short form) | Units |
|----|--------------------------|-------|
| R1 | User-only `connect.groups`: name to member list, allow-list entry form; project config cannot set it | U1 |
| R2 | `group:<name>` and `projects:<a>,<b>` select; no token reads the whole list | U2 |
| R3 | Refuse before `begin` with a fixed reason: unknown group, unknown project, member not on the allow list, token conflict | U2 |
| R4 | A selected project counts only when it resolves to an allow-list entry; a selection never adds a project | U2 |
| R5 | Tokens parsed the same way in both modes; identical repeats count once; distinct values or both kinds conflict | U2 |
| R6 | Rotation, coverage and sweep progress kept per selection; a narrow run never covers the full list | U3 |
| R7 | Digest and run record name the selection | U2, U3 |
| R8 | Daily cron and manual dispatch; one run at a time | U8 |
| R9 | Projects from `FRO_BOT_CONNECT_PROJECTS`; default-branch checkouts; runner-local allow list; headless run with no selection | U0, U8 |
| R10 | Researcher model and variant from variables, written as a runner-local overlay; model required | U0, U8 |
| R11 | Every listed repository is public | U8, U9 |
| R12 | Configuration failures fail red before anything is read, post nothing, keep the previous report open | U8, U9 |
| R13 | The agent job holds a read-only repository token; writes happen in a separate job that runs even when the run job fails | U8 |
| R14 | CI ledger and coverage persist in an Actions cache; a missing cache starts fresh and the report says so | U6, U8 |
| R15 | Two boxes per candidate; ticks from the newest open report recorded before the run, idempotently, separate from any local ledger | U6, U8, U9 |
| R16 | Every open CI candidate is listed until settled; new ones are marked | U6, U8 |
| R17 | One report per date; title cannot match the Fro Bot rule; same-date rerun rewrites in place; the previous report closes only after the write | U8, U9 |
| R18 | Every outcome from `begin` onward is posted as itself; failed or no-final-line runs turn the job red | U8, U9 |
| R19 | Inert report: decisions only from generated checkbox lines with ids; model text fenced; mentions and references neutralised; artifact read, never interpolated; supplied secret values refused | U6, U8, U9 |
| R20 | `fetch:<run>` downloads the record, maps projects by `owner/repo`, re-verifies fingerprints, prints the usual local lines, refuses changed candidates by name | U4, U5 |
| R21 | The connections guide covers groups, picks, the workflow setup, the cache, the report, `fetch`, the public-only rule and the remaining credential exposure | U7, U10 |

Acceptance examples have one owning unit, where the test that proves them lives.

| ID | Acceptance example (short form) | Owning unit |
|----|---------------------------------|-------------|
| AE1 | A five-project group runs over exactly those projects and the digest names the group | U2 |
| AE2 | A group member off the allow list stops the run before `begin`, names the member and takes no lock | U2 |
| AE3 | `group:` plus `projects:` or two different groups stop; two identical `group:` words read that group | U2 |
| AE4 | No token reads the whole allow list | U2 |
| AE5 | A group run covers a rule; a no-token run still offers it | U3 |
| AE6 | A private repository in the variable fails the job before checkout and posts nothing | U9 |
| AE7 | After a cache eviction the sweep starts fresh and the report says the ledger was reset | U9 |
| AE8 | A rejected tick is recorded before dispatch; the unticked candidate is listed again | U9 |
| AE9 | A run with no final line fails the job and the report says so | U9 |
| AE10 | A quoted `- [x]` inside an excerpt records no decision | U9 |
| AE11 | `fetch` refuses a candidate whose target file changed, names the file, and prints tokens for the others | U5 |
| AE12 | A dispatch after the scheduled run records that day's ticks, then rewrites that day's report; no second issue | U9 |

U6 owns the unit tests for the pieces that U9 composes: `apply-ticks` (AE8 recording, AE10 conflict handling) and `render-report` (AE7 notice, AE8 listing, AE10 fencing). U9 owns the end-to-end scenario for each.

---

## Scope Boundaries

- A selection never adds a project. The allow list stays user-only and is the only trust boundary.
- No groups or selection in project config. Project config still strips the whole `connect` block.
- No private repositories in the scheduled run, and no visibility rule beyond "all public".
- No sync between the CI ledger and a local ledger. `fetch` inserts accepted candidates into the local ledger as a local run, and nothing flows back.
- No issues or PRs filed in target repositories. A human promotes every candidate.
- No path-scoped reads for the researcher on the runner. The limit is documented, not fixed.
- No scheduled runs on Pi or Claude Code.
- `ce:compound` and `ce:compound-refresh` do not change.
- No change to the researcher agent or to the candidate contract that `ce:compound` consumes.

### Deferred to Separate Tasks

- Duplicate or refresh, stale-against-code and experiment-proposal candidate kinds: picked up after this ships.
- Reflection measurement at decision points: a separate plan.
- Session-history ingestion: no SQLite access or transcript adapters here.
- A reusable workflow other repositories can call: only the Systematic workflow is in scope.
- Changing `fro-bot/agent` so it passes an `external_directory` allow or a token-less mode: the fallback if U0 fails, and a change in another repository.
- A numeric tuning pass on slice size for the daily cadence: the bounds stay as frozen.

---

## Context & Research

### Relevant Code and Patterns

- `src/lib/connect-config.ts`: `validateConnectBlock` (plain-guard validator that rejects unknown keys), `loadConnectAllowList` (four user-level layers, fail closed per layer), `resolveAllowEntry` (reason-bearing resolution to a main root), `MAX_ALLOW_PROJECTS`, `HOST_SUPPORT_TABLE`. `groups` extends this block.
- `src/lib/config-schema.ts` (`ConnectSettingsSchema`, wrapped in `trustProtected`), `src/lib/config.ts` (`mergeConnect`, which merges `allow_projects` only), `docs/scripts/generate-config-reference.ts` (`CONNECT_SUB_FIELDS`, a hardcoded list). Project config strips the whole `connect` block already, so `groups` needs no new strip code.
- `scripts/lib/generated-surfaces.ts`: the `schema` and `config-reference` surfaces list `config-schema.ts` as a trigger but not `connect-config.ts`, which `config-schema.ts` imports. That gap lets a `connect-config.ts` edit pass drift without regenerating. U1 closes it.
- `src/ce-connect-helper.ts`: `OPS`, `REQUEST_OPS`, `CE_CONNECT_USAGE`, `begin`, `scanAll` (its `pruneUnattributed` flag), `publish`, `decide`. `begin` ignores unknown request keys today.
- `src/lib/connect-helper-core.ts`: `projectKey` (12-hex), `projectName` (sanitized basename, so two checkouts with one basename collide silently), `planOffer`, `sweepProgress`, `renderSweepLine`, `renderDigest`, `checkCandidate`, `toCandidateRecord`, `DigestModel` (no selection field).
- `src/lib/connect-state.ts`: ledger read and write (`version` is the literal 1; any other value reads as unreadable and is never replaced), `MAX_COVERAGE` (20,000, shared), coverage records unique by `ruleId`, `publishRun`, `decideLedgerEntry`, `candidateIdentity`, `prepareStateRoot` (refuses a root inside a checkout or an allowed project).
- `src/lib/search-project-identity.ts`: `resolveProjectIdentity` and bounded identity-file reads. It parses `.git/config` for `core.worktree` only. The remote read in U4 is new code beside it, with the same bounds.
- `skills/ce-connect/SKILL.md` and `skills/ce-connect/references/headless-and-outcomes.md`: the `mode:` token procedure (list every `mode:` word first, then decide), stop reasons, final lines. `tests/unit/connect-skill-contract.test.ts` pins the procedure.
- `skills/ce-compound/SKILL.md`: the `candidate:<run-record> candidate-id:<id>` consumer. It verifies target, paths, fingerprints and excerpts itself and never recomputes an id.
- `.github/workflows/fro-bot.yaml`: the report title rule (`^Daily Fro Bot Report — YYYY-MM-DD \(UTC\)$`), rotation after write, and the `approval-backstop` job (`permissions: {}`, no checkout, `needs`, `always()`). Rotation there is prompt text, not code; U8 needs a script.
- `.github/workflows/release-gate.yaml`: cron plus dispatch, top-level `permissions: {}`, its own concurrency group, credentialed jobs that run no repository code.
- `tests/unit/fro-bot-workflow.test.ts`: the guard-test shape. `js-yaml` with `JSON_SCHEMA`, a `stepNamed` lookup, and a stub `gh` sandbox that runs the real step scripts.
- `scripts/generate-ce-connect-helper.ts`: regenerates `skills/ce-connect/scripts/connect.mjs`; `tests/unit/ce-connect-helper-packaging.test.ts` runs it under the three shipped layouts.
- `tests/manual/connect-eval/PRE-REGISTRATION.md` and `tests/unit/connect-eval-fixture.test.ts`: the test pins the registered frozen digest only. The prose around later digests still asks for more.
- `.github/renovate.json5`: a custom manager reads the version annotation above each `HOST_SUPPORT_TABLE` row in `src/lib/connect-config.ts`. The action bump flows through Renovate's normal action-pin handling.

### Institutional Learnings

- `docs/solutions/security-issues/trusted-step-after-the-agent-needs-its-own-job-2026-11-09.md` (active): on schedule and dispatch runs the model can read the token the action provides. Credentialed steps go in their own job with a validated handoff.
- `docs/solutions/best-practices/evidence-boundary-for-reading-other-repositories-2026-11-09.md` (active): the allow list is user-only and a bad config fails closed.
- `docs/solutions/integration-issues/opencode-v1-headless-external-directory-auto-reject-2026-11-09.md` (active): headless permission behavior for checkouts outside the working directory.
- `docs/solutions/best-practices/promote-a-cross-project-lesson-in-the-targets-own-words-2026-11-09.md` (active): the consumer contract. Contradictions route to `ce:compound-refresh`; `investigate` candidates get no tokens; the consumer rechecks everything before it writes.
- `docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md` (active): any edit to a bundled source, even a comment, changes the helper's source digest. Regenerate after the final edit, then run drift.
- `docs/solutions/best-practices/pre-registered-evaluation-of-a-model-driven-tool-2026-11-09.md` (active): its steps 3 and 4 ask for a "last digest line must match the tree" test and a new digest line per change. The test pins the registered digest only.
- `docs/solutions/workflow-issues/release-workflow-test-pins-action-sha-2026-10-14.md` (active): test the pinning wiring and annotations, not literal versions.
- `docs/solutions/best-practices/skill-around-an-untrusted-researcher-needs-baseline-pressure-tests-2026-11-09.md` (active): the helper owns outcomes and validation; headless asks nothing; a missing helper means failed; keyword and entropy secret screens give false assurance.
- `docs/solutions/workflow-issues/release-notes-narrative-ci-automation-architecture-2026-05-23.md` (active): prompt text is not authorization.
- `docs/solutions/workflow-issues/host-contract-evidence-is-ci-owned-2026-09-04.md` (active): host evidence runs in CI against the exact pin and fails closed.

### External References

Facts about `fro-bot/agent` at commit `f15b238b6` of its default branch, from the research lane. U0 re-checks the ones marked live.

- Required inputs are `github-token` (presence only, no scope check) and `auth-json`. `systematic-version` defaults to 3.32.3 and must be an exact x.y.z. `response-mode: none` suppresses delivery.
- Schedule and dispatch runs get the `provision` credential mode: `GH_TOKEN` is exported to later steps and `gh auth login` writes the token to a file the model can read. A read-only token probably works (live check); presetting `git user.name` and `user.email` avoids an identity lookup.
- The action's v2 config sets `external_directory: deny`, allows only paths it controls, and strips any `permission`, `permissions` or `tools` an operator sets. An `external_directory` allow for the state directory cannot be passed through, so every connect path must sit inside the working directory (live check).
- The action runs stock OpenCode v2 2.2.6 pinned per platform digest, which matches a `HOST_SUPPORT_TABLE` row. The child process keeps `HOME` and `XDG_*`. Connect state lives at `$XDG_STATE_HOME/systematic/connect`.
- No action output carries the final assistant text. A failed run calls `setFailed`; a deadline exits 130. A green step does not mean `Connect complete`.
- Actions: use `actions/cache/restore` and `actions/cache/save`; keys are immutable, so use a unique key and restore by prefix; schedule runs use the default branch's cache scope; eviction after 7 days of no use is a default and storage pressure can evict sooner. `gh run download --repo O/R --name N` needs `actions:read`; a same-run `download-artifact` does not. `concurrency` accepts `queue: max` with `cancel-in-progress: false`.

### Related Past Work

- Recorded as completed in `docs/plans/2026-11-06-001-feat-cross-project-connections-plan.md`: the shipped `ce:connect` design. It deferred scheduling and forbade unattended writes to repositories. This plan adds scheduling and one narrow unattended write: a report issue in Systematic, covering public projects only, with every promotion still human.
- Recorded as completed in `docs/plans/2026-10-11-004-feat-gated-release-pr-plan.md`: the job split with a data-only artifact handoff and a digest check, which the render and post jobs follow.
- Recorded as completed in `docs/plans/2026-09-04-001-refactor-ci-owned-host-contract-suite-plan.md`: host evidence is CI-owned. A cache has only served reusable downloads here, and an artifact only failure logs, so neither precedent covers a durable ledger. Eviction is treated as a reset.

---

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "Worktree .worktrees/feat/connect-groups-scheduled-runs: src/, scripts/, skills/ce-connect, skills/ce-compound, tests/unit, .github/workflows (lexical and symbol search)",
  "freshness": {
    "vcs_reference": "d0fa6930dceb63142334434e21838be3cc4f3b6e"
  },
  "budget": {
    "max_search_passes": 8,
    "max_candidate_inspections": 16,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/connect-config.ts: validateConnectBlock, loadConnectAllowList, resolveAllowEntry",
      "description": "User-only connect block: plain-guard validator, four-layer fail-closed loader, reason-bearing entry resolution to a main root.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/config-schema.ts: ConnectSettingsSchema; src/lib/config.ts: mergeConnect; docs/scripts/generate-config-reference.ts: CONNECT_SUB_FIELDS",
      "description": "Zod mirror of the connect block, the cross-layer merge (allow_projects only) and the hardcoded reference field list.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "scripts/lib/generated-surfaces.ts",
      "description": "The single list of generated surfaces with trigger lists; the schema and config-reference surfaces omit connect-config.ts.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/ce-connect-helper.ts: begin, scanAll, publish, decide, OPS, REQUEST_OPS, CE_CONNECT_USAGE",
      "description": "Helper entry: op dispatch, begin sequence, scan scope with pruneUnattributed, ledger decisions.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/connect-helper-core.ts: projectKey, projectName, planOffer, sweepProgress, renderSweepLine, renderDigest, checkCandidate",
      "description": "Rule index, rotation offer, sweep reporting, digest rendering and candidate validation; no selection concept.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/connect-state.ts: readLedger, publishRun, decideLedgerEntry, candidateIdentity, prepareStateRoot",
      "description": "Owner-only run state, lock, version-1 ledger with global coverage keyed by ruleId, atomic publish.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/search-project-identity.ts: resolveProjectIdentity",
      "description": "Main-root identity of a checkout with bounded identity-file reads; reads .git/config for core.worktree only and has no remote lookup.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "skills/ce-connect/SKILL.md: mode token procedure; skills/ce-compound/SKILL.md: candidate input",
      "description": "Argument-or-instruction token collection for mode, and the candidate consumer that re-verifies every field.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "scripts/generate-ce-connect-helper.ts + skills/ce-connect/scripts/connect.mjs",
      "description": "Bundle regeneration, provenance digest, drift check and three-layout packaging test.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": ".github/workflows/release-gate.yaml",
      "description": "Cron plus dispatch workflow with top-level empty permissions, its own concurrency group and credentialed jobs that run no repository code.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": ".github/workflows/fro-bot.yaml: REPORT TITLE RULE, approval-backstop",
      "description": "Daily report title rule and rotation written as agent prompt text, plus a no-checkout always() job.",
      "disposition": "insufficient",
      "insufficiency_reason": "Rotation is prompt text for an agent, not deterministic code; it has no digest check, secret refusal or idempotent edit path to reuse."
    },
    {
      "path_or_symbol": "tests/unit/fro-bot-workflow.test.ts",
      "description": "Workflow guard test: js-yaml JSON_SCHEMA parse, stepNamed lookup, stub gh sandbox running real step scripts.",
      "disposition": "extend"
    }
  ],
  "excluded_scopes": [
    {
      "scope": "docs/plans and docs/solutions (history)",
      "reason": "Explains why designs exist; not authority for what code currently exists."
    },
    {
      "scope": "fro-bot/agent action source",
      "reason": "External repository, not in the worktree; its inputs and constraints come from the research lane at a pinned commit and U0 re-checks them live."
    }
  ]
}
```

---

## Key Technical Decisions

- KTD1. **Two deliveries.** Delivery A (U1-U7) is product code in one release. Delivery B (U8-U10) is the workflow, pinned to the release that ships Delivery A, and a manual dispatch proves the pin. The CI helper ops (`apply-ticks`, `render-report`) live in Delivery A so the helper the workflow runs and the code that wrote the state are one version. U0 runs during Delivery A's timeframe, so a failed spike surfaces before Delivery B is built.
- KTD2. **The skill collects selection words; the helper resolves them.**
  - The skill lists every word that starts with `group:` or `projects:`, using the same argument-or-instruction rule it uses for `mode:`, and passes them to `begin` unchanged as a list.
  - The helper does the rest before `prepareStateRoot` and the lock: removes identical repeats, detects conflicts (two distinct `group:` words, two distinct `projects:` words, or both kinds), rejects unknown names, and checks membership against resolved main roots.
  - A refusal is a `failed` outcome with a fixed reason, takes no lock and writes nothing.
  - Identical means identical word text. `projects:a,b` and `projects:b,a` are distinct words and conflict.
- KTD3. **`projects:` entries.** An entry is a project name or a 12-hex project key. A 12-hex entry is tried as a key first and falls back to a name. A name shared by two allowed projects is refused as ambiguous, and the refusal names their keys, so the operator can retry with a key.
- KTD4. **`connect.groups`.**
  - A user-only record of group name to member list. Names match `^[a-z0-9][a-z0-9-]{0,63}$`. At most 32 groups, each with at most `MAX_ALLOW_PROJECTS` members. Members use the allow-list entry form (absolute or `~`-prefixed path).
  - It uses the plain-guard validator, the zod mirror and the parity test. A bad `groups` value makes that layer's whole `connect` block unreadable, so that layer's `allow_projects` also contributes nothing. This is the fail-closed behavior `allow_projects` has today.
  - Across layers, a later layer replaces a same-named group whole, like same-named search sources. Layer order is user, user.local, custom, custom.local.
  - Membership in the allow list is not checked at load time. The validator checks shape only; U2 checks membership at selection time on resolved main roots.
- KTD5. **Coverage is kept per selection.**
  - A run with no selection keeps today's records unchanged, as the `all` namespace (records with no selection field).
  - A group or pick run keys its coverage by a canonical selection id: a hash of the sorted resolved project keys. A change in a group's membership starts a fresh sweep. The group's name is not part of the key, so two groups with the same members share one sweep.
  - Uniqueness becomes (selection, ruleId). `planOffer`, `sweepProgress` and `applyCoverage` read only the run's namespace.
  - `pruneUnattributed` is forced off for every run that has a selection, even when its members equal the full list. Only a no-selection run may prune. Otherwise a group run would drop coverage that belongs to unselected projects.
  - The ledger `version` goes to 2. A version-1 ledger is migrated atomically on the first write by any helper that carries this change: its coverage becomes the `all` namespace and its entries are unchanged. A ledger with any version other than 1 or 2 reads as `ledger-unreadable` and is never replaced. The shipped helper already refuses a version it does not know, so an older helper reading a version-2 ledger reports `ledger-unreadable` and overwrites nothing.
  - `MAX_COVERAGE` stays one shared cap across namespaces; the oldest records of any namespace go first on overflow.
- KTD6. **The digest header and `run.json` name the selection:** kind (`all`, `group` or `projects`), the group name or the picked project names, and the selection id. The sweep line in the header counts the selection's own rules.
- KTD7. **Portable identity.**
  - The helper reads each checkout's `remote.origin.url` from `.git/config` with a bounded file read and no network, following `src/lib/search-project-identity.ts`.
  - It normalizes only GitHub forms: https, ssh `git@github.com:`, and `ssh://`, with or without `.git`, lowercased, to `owner/repo`.
  - `run.json` records `repo` and the HEAD commit, read from `.git/HEAD` and the refs or `packed-refs`. A missing or non-GitHub remote records no `repo`, and that project cannot be fetched.
  - Both fields are additive to `run.json`, which stays at `schemaVersion` 1 because consumers read named fields. U4 pins that with the promotion-contract test.
- KTD8. **`fetch:<run>` and the `import` op.**
  - The skill runs `gh run download <run> --repo <owner/repo> --name connect-run-<run>` into a fresh temp directory. The helper stays network-free.
  - The `import` op reads the downloaded record as untrusted input. It validates the schema and size, and checks paths by the same rules `ce:compound` applies.
  - It maps each recorded `repo` to exactly one allowed local checkout. A missing or ambiguous mapping refuses the candidates that depend on it.
  - It recomputes local ids (rule id, role and candidate id from local roots) and re-verifies every fingerprint and excerpt against local files. A recorded id is never trusted.
  - It inserts the accepted candidates into the local ledger through a publish-style locked path, as a local run with `kind: import` and provenance `{repo, runId, commit}`.
  - It prints the usual local promotion and refresh lines, refuses and names each candidate whose evidence changed, and is idempotent on a rerun.
  - A different local commit is accepted when every check passes, and the output shows both commits.
  - The accepted artifact name and schema are fixed. A missing, expired or unauthenticated download each gets its own clear reason.
- KTD9. **`apply-ticks`.**
  - Input is a tick list `{id, status}` that the workflow parsed from the newest report, plus the manifest saved with that report.
  - A tick is accepted only when its id is in the manifest and the candidate is still open in the ledger.
  - Both boxes ticked for one id is a conflict, reported and skipped. An unknown id (for example after a cache eviction) is reported and never fatal. A tick already recorded with the same status and reason is skipped, so the op is idempotent.
  - Accepted ticks call `decide` with the fixed reason `settled in report #<n>`.
- KTD10. **`render-report` and the payload store.**
  - `render-report` builds the report body from the ledger's open CI candidates and a candidate payload store.
  - The run job writes a bounded payload per open candidate: title, summary, kind, target repo, sources and next step. The store is kept independently of `runs/` pruning and a candidate's payload is deleted when the candidate is settled. The ledger holds no text, so the store is what lets a later report list a candidate again.
  - The body is inert. Model text is fenced; `@` mentions and `#n`, `GH-n` and `owner/repo#n` references are neutralised.
  - Each candidate gets a generated decision block of two checkbox lines (Promoted and Rejected), each carrying the candidate id in a marker, inside one delimited section. The exact line format is the implementer's choice. Only the delimited section is parsed for ticks.
  - The op writes the manifest of ids it rendered.
  - The body cap is 60,000 characters. Above it, the newest candidates are shown with their boxes, followed by a count of the hidden open candidates, which stay open. A block is never cut in the middle.
  - The body also carries the outcome, degrade reasons, the sweep line, the selection, a "ledger reset" notice when no cache was restored, and the `fetch` command for the run. "New" means first shown on that UTC date.
- KTD11. **`.github/workflows/connect.yaml`** runs on `schedule` (daily) and on `workflow_dispatch` restricted to the default branch. Concurrency group `ce-connect-scheduled` with `queue: max` and `cancel-in-progress: false`. Top-level `permissions: {}`. Four jobs, each with its own permissions:
  - **prepare** (contents read, issues read).
    - Validates the variables (project list shape, model set) and checks that each repo is public. An API error counts as not public. Any configuration failure fails red here with nothing posted.
    - Restores the cache by prefix, then finds the newest open connect report by exact title rule and author. Zero reports is a normal first run. Several open reports with different dates are the expected leftover of a post that failed before rotation: the newest by title date is read and the rest are closed by the next post. More than one open report for the newest date, or a lookup error, fails.
    - Parses ticks only from the delimited section, runs `apply-ticks` with the pinned package's `connect.mjs`, and uploads the state artifact.
  - **run** (contents read).
    - Downloads the state and lays out `$RUNNER_TEMP/connect/` with `checkouts/<owner>__<repo>`, `state/` (`XDG_STATE_HOME`) and the config directory side by side. It sets the action's working directory to that non-git parent.
    - Writes a runner-local `systematic.jsonc` with the allow list and the researcher model overlay, then verifies the effective config (allow list and overlay) before dispatch.
    - Runs `fro-bot/agent` with `response-mode: none`, a read-only `github-token`, `auth-json`, the pinned `systematic-version`, and the prompt "Load the ce:connect skill and run it with mode:headless".
    - After the action, a fixed step outside the agent finds the outcome from `state/` (the newest run directory and its `run.json`). It records a phase and outcome envelope (`preflight-ok`, `begun`, the final line or none) and uploads the state and run record as `connect-run-<runId>`.
  - **render** (no permissions; `if: always()` after run, when prepare succeeded).
    - Downloads the state and validates it as untrusted input. Runs `render-report` with the pinned package's helper, then rechecks visibility.
    - Saves the cache under a unique key `connect-v1-<run_id>-<attempt>`. Uploads the body, the manifest and the envelope as a data-only artifact with a digest.
  - **post** (issues write only; no checkout, no repository code; `if: always()` when render produced a body).
    - Downloads the body and verifies its digest and size.
    - Refuses to post when the body contains the exact value of any secret supplied to the job: the provider credential and the post job's own token, passed through env and compared with a fixed-string match. This is an exact-value match, not a keyword screen. The run job uses its own job-scoped read-only `github.token`, which expires when that job ends, so it is not matched.
    - Creates or edits the report for the UTC date. Title `ce:connect report — YYYY-MM-DD (UTC)`, which must not match Fro Bot's title rule. Closes older connect reports only after the write is confirmed. Every step is idempotent on a rerun.
- KTD12. **Failure matrix.** Each row has one outcome, one job result and one report effect.

  | Failure | Job result | Report |
  |---------|-----------|--------|
  | Configuration failure in prepare (unset model, malformed list, non-public repo, lookup error) | Red | Nothing posted; the previous report stays open |
  | The action fails before `begin` (envelope `preflight-ok` or earlier) | Red | Treated as preflight; nothing posted |
  | From `begin` onward: complete, degraded, busy | Green | Posted as itself |
  | From `begin` onward: failed, or no final line | Red | Posted as itself, naming the failure or "ended with no final line" |
  | Cache save failure | Red | Reported in the body |
  | Post failure before the write | Red | Nothing rotated |
  | Post failure after the write and before rotation | Red | The next run rotates |

- KTD13. **Spike U0 is a stop-and-ask gate.**
  - A temporary workflow on a spike branch, with a push trigger and real secrets, runs the action with the layout from KTD11 against the released 3.32.3, with a bare run over two public repositories.
  - It must show all four: the working-directory layout passes `external_directory`; the read-only token is enough (with preset `git user.name` and `user.email`); the effective-config check works; the outcome can be found from `state/`.
  - Pushing the spike branch needs owner approval at that moment. If any check fails, stop and report. The fallback is a change to `fro-bot/agent`, which this repository cannot make.
- KTD14. **Ledger and cache.** The cache holds `ledger.json`, the payload store, the last report manifest and `runs/`, and never `lock/`. When nothing is restored, the run starts fresh and the report says so: suppression and continuity are lost, and the next prepare reports the ticks it cannot resolve.

---

## Open Questions

### Resolved During Planning

- How is a project named in `projects:` when two allowed projects share a directory name? A name or a 12-hex key; an ambiguous name is refused with the keys (KTD3).
- Does a group or pick of the full list use the `all` coverage? No. Only a run with no selection does (KTD5).
- Do same-named groups union or refuse across layers? A later layer replaces the group whole (KTD4).
- How does `fetch` find and download a record? The skill runs `gh run download` with the operator's own `gh` authentication; the helper never touches the network (KTD8).
- How does the CI helper get its ticks? The workflow parses the delimited section of the newest report and hands a tick list plus the saved manifest to `apply-ticks` (KTD9).
- How does the run job report the outcome, given the action exposes no final text? A fixed step reads the newest run directory under `state/` and the run record (KTD11).
- How does the workflow keep the action's host version and the host-support table in step? It does not duplicate the pin. The action bump is a normal Renovate action-pin PR, `begin` in headless mode refuses a host and version not in the table (posted and red), and the dispatch proof records the pair (KTD11, U10).
- How do runner checkouts satisfy the main-root identity rule? They are plain clones under `checkouts/`, each its own main root, and the state and config directories sit beside them, outside every checkout (KTD11).

### Deferred to Implementation

- The exact checkbox line format and the marker syntax (KTD10). The guard test pins whatever U6 chooses.
- The mechanism of the effective-config check (KTD11): U0 picks the narrowest observable check. Candidates are a byte comparison of the runner-local file after the action's setup and the project list in `run.json`.
- How the connect config directory reaches the action's child process: through `OPENCODE_CONFIG_DIR` or a relocated `HOME`. U0 decides; the helper's custom layer and the plugin's default-directory write behave differently under each.
- Whether a literal `/ce:connect` prompt expands inside the action. The plan avoids the question by prompting for the skill by name.
- Payload-store size bounds and the per-field limits for a candidate payload (KTD10). U6 sets them against the 60,000-character body cap.
- The smallest read of `.git/HEAD`, refs and `packed-refs` that is correct for a detached HEAD and for a packed ref (KTD7). U4 characterizes it against real clones.
- The fixed text of each `import` refusal reason (KTD8). U5 sets them and the skill prints them.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

Selection resolution runs before the lock, so a refusal has no side effects. The coverage namespace is chosen once and used for the whole run.

| Input words | Result |
|-------------|--------|
| none | Whole allow list; namespace `all`; today's records |
| `group:a` (or repeated identically) | Members of `a`; namespace = hash of sorted member keys |
| `projects:x,y` | The two named projects; namespace = hash of sorted keys |
| `group:a group:b`, `projects:x projects:y`, or `group:a projects:x` | Refused: conflicting selection |
| `group:zzz` | Refused: unknown group |
| `group:a` with a member off the allow list | Refused: names the member; no lock |
| `projects:x` where two allowed projects are named `x` | Refused: ambiguous, names both keys |

The scheduled flow has four jobs, and only `run` touches the agent:

```mermaid
sequenceDiagram
    participant Cron as schedule / dispatch
    participant Prep as prepare (read)
    participant Run as run (read)
    participant Rend as render (no perms)
    participant Post as post (issues write)
    Cron->>Prep: start
    Prep->>Prep: validate vars, public check, restore cache
    Prep->>Prep: find newest open report, parse ticks, apply-ticks
    Prep->>Run: state artifact
    Run->>Run: lay out checkouts/ state/ config/, verify config
    Run->>Run: fro-bot/agent, mode:headless
    Run->>Rend: state + run record + envelope
    Rend->>Rend: validate, render-report, save cache
    Rend->>Post: body + manifest + digest
    Post->>Post: verify digest, refuse secrets
    Post->>Post: create or edit today's report, then close older
```

Tick flow across days, in outline:

```text
day N   report rendered: each open candidate has [ ] Promoted and [ ] Rejected, ids in markers, manifest saved in the cache
operator ticks one box in report N (or promotes locally via fetch, then ticks Promoted)
day N+1 prepare: newest open report -> ticks from the delimited section only
        apply-ticks: accept id in manifest and open in ledger; skip conflicts and repeats; report unknown ids
        render: open candidates again (settled ones gone), new ones marked, report N+1 written, N closed after
```

---

## Implementation Units

```mermaid
flowchart TB
    subgraph A[Delivery A: product, one release]
      U1[U1 Groups config] --> U2[U2 Selection resolution]
      U2 --> U3[U3 Per-selection coverage, ledger v2]
      U3 --> U4[U4 Portable identity]
      U4 --> U5[U5 import op and fetch]
      U3 --> U6[U6 CI ops and payload store]
      U5 --> U7[U7 Delivery A docs]
      U6 --> U7
    end
    subgraph B[Delivery B: workflow, pinned to the Delivery A release]
      U8[U8 connect.yaml] --> U9[U9 Guard tests]
      U9 --> U10[U10 Delivery B docs and live proof]
    end
    U0[U0 Spike, early, stop-and-ask] --> U8
    U7 -->|release| U8
```

Each unit lands as an atomic commit. A unit that adds a `src/lib` module also owes an `ARCHITECTURE.md` codemap entry, a `src/lib/AGENTS.md` module-table row, and the module's path in the `connect-helper` surface triggers in `scripts/lib/generated-surfaces.ts`. Both doc surfaces are gate-enforced (`bun scripts/content-integrity.ts`). Every unit that edits a file the helper bundle imports (`src/ce-connect-helper.ts`, `src/lib/connect-*.ts`, `src/lib/search-bounded-read.ts`, `src/lib/search-project-identity.ts`, `src/lib/frontmatter.ts`) regenerates `skills/ce-connect/scripts/connect.mjs` after its last source edit and then runs the drift check.

Units that change exports update the existing module row in `src/lib/AGENTS.md` and the matching codemap entry in `ARCHITECTURE.md`. The trust-boundary and lifecycle prose belongs to U7.

### Phase 0: Gate

- [ ] U0. Spike: the action runs `ce:connect` under the planned layout

**Goal:** Prove on a real runner, before Delivery B is built, that `fro-bot/agent` can run a bare headless `ce:connect` over checkouts under a working directory it controls.

**Requirements:** R9, R10, R13, R18 (the assumptions behind them)

**Dependencies:** None. Runs during Delivery A. Pushing the spike branch needs owner approval at that moment.

**Files:**
- Create (spike branch only, never merged): `.github/workflows/connect-spike.yaml` with a push trigger and the real `OPENCODE_AUTH_JSON` secret
- Test: none. The evidence is the spike run's logs, recorded in the PR description for U8 and in `HARNESSES.md` by U10

**Approach:**
- Lay out `$RUNNER_TEMP/connect/` with `checkouts/<owner>__<repo>` for two public repositories, `state/` as `XDG_STATE_HOME`, and the config directory beside them. Set the action's working directory to the non-git parent. Use the released 3.32.3 and a bare run.
- Write a runner-local `systematic.jsonc` with the allow list and a researcher model overlay. Preset `git user.name` and `user.email`. Give the action `github.token` with `contents: read` only.
- Record four findings: (a) the checkouts are readable under `external_directory: deny`; (b) the action accepts the read-only token; (c) a pre-dispatch check can show the allow list and overlay are the ones in effect; (d) a post-action step finds the newest run directory and `run.json` under `state/`.
- Also record: how the config directory reaches the child process (see Open Questions), whether the action overwrote the runner-local file, and the host version the action reports, against `HOST_SUPPORT_TABLE`.

**Execution note:** Throwaway proof. Stop and report to the owner if any of (a)-(d) fails. Do not start U8 on a failed spike.

**Test scenarios:**
- Test expectation: none -- a one-off live proof with no shipped code. The four findings are the pass condition.

**Verification:**
- A run on the spike branch ends with a `Connect` final line, its `run.json` lists both projects, and (a)-(d) are each recorded as pass or fail with the evidence.
- The spike branch and workflow are deleted after the findings are copied out.

---

### Phase 1: Delivery A, product

- [ ] U1. Groups in user config

**Goal:** Add `connect.groups` as a user-only record, with the same trust and fail-closed rules as `allow_projects`, and close the trigger gap that hid `connect-config.ts` edits from two generated surfaces.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/lib/connect-config.ts` (`ConnectSettings`, `validateConnectBlock`, `loadConnectAllowList` merge, group constants)
- Modify: `src/lib/config-schema.ts` (`ConnectSettingsSchema`)
- Modify: `src/lib/config.ts` (`mergeConnect`)
- Modify: `docs/scripts/generate-config-reference.ts` (`CONNECT_SUB_FIELDS`)
- Modify: `scripts/lib/generated-surfaces.ts` (add `src/lib/connect-config.ts` to the `schema` and `config-reference` triggers)
- Modify: `src/lib/AGENTS.md`, `ARCHITECTURE.md` (the `connect-config.ts` row and codemap entry: new exports)
- Regenerate: `docs/public/schemas/v*/systematic-config.schema.json`, `docs/src/content/docs/reference/configuration.mdx`, `skills/ce-connect/scripts/connect.mjs` (run `bun run surfaces:affected --run`, then `bun run surfaces:drift`; the schema and reference read the version from git tags, so fetch tags first)
- Test: `tests/unit/connect-config.test.ts`, `tests/unit/config-schema.test.ts`, `tests/unit/config.test.ts`, `tests/unit/generate-config-reference.test.ts`, `tests/unit/generated-surfaces.test.ts`

**Approach:**
- The block gains a `groups` record (KTD4). The validator checks shape only: name pattern, group count, member count, member string bounds, and at least one member per group. It never checks allow-list membership.
- A bad `groups` value makes the whole layer's `connect` block unreadable. The loader keeps its per-layer fail-closed rule and its union for `allow_projects`; `groups` merges by name with a later layer replacing a same-named group whole.
- The zod mirror and the plain guard accept and reject the same inputs. The parity test enumerates the shared corpus and gains the group cases.
- `mergeConnect` merges `groups` the same way, so the plugin's merged config and the helper's loader agree.
- Add `src/lib/connect-config.ts` to the two surface trigger lists. Without it, an edit to the file passes drift without regenerating the schema or the reference.

**Execution note:** Test-first for the validator, the loader merge and the parity corpus.

**Patterns to follow:**
- `allow_projects` handling in `validateConnectBlock` and `loadConnectAllowList`; the existing parity test in `tests/unit/connect-config.test.ts`.
- The five-edit recipe for a protected top-level field (cross-project connections plan, KTD10): schema, protected paths, project strip, types and merge, reference generator.

**Test scenarios:**
- Happy path: one layer with `groups: {harness-tools: [~/a, ~/b]}` loads both members under the name.
- Happy path: two layers both define `x`; the later layer's list replaces the earlier one whole. A group defined only in the earlier layer survives.
- Edge case: exactly 32 groups load; 33 make the block unreadable. A group with exactly `MAX_ALLOW_PROJECTS` members loads; one more makes the block unreadable.
- Edge case: names `A_b`, a leading hyphen, an empty string and a 65-character name are each rejected; `a`, `a-b` and a 64-character name are accepted.
- Edge case: a group with an empty member list is rejected.
- Error path: `groups` is an array, or a member is not a string. That layer's whole block is unreadable, so its `allow_projects` contributes nothing, and the other layers are unaffected.
- Error path: project config carrying `connect.groups` is stripped with the existing warning and contributes nothing.
- Integration: the plain guard and the zod mirror agree on every case in the parity corpus, including the new group cases.
- Integration: after `groups` lands, `bun run surfaces:affected` for an edit to `src/lib/connect-config.ts` lists `schema`, `config-reference` and `connect-helper`. The regenerated schema shows `groups` with the name pattern and caps, and the reference lists it.

**Verification:**
- A user config with groups loads through the helper's loader and the plugin's merged config with the same result.
- `bun run surfaces:drift` reports no drift on any surface after the regeneration.

- [ ] U2. Selection resolution in `begin`, token collection and naming

**Goal:** Let a run narrow to a group or a set of picks, refuse bad selections before the lock, and name the selection in the digest and run record.

**Requirements:** R2, R3, R4, R5, R7

**Dependencies:** U1

**Files:**
- Modify: `src/ce-connect-helper.ts` (`begin` accepts a `selection` word list and resolves it between environment description and `prepareStateRoot`; the answer carries the resolved selection; `CE_CONNECT_USAGE`)
- Modify: `src/lib/connect-helper-core.ts` (selection resolver, ambiguity detection, `DigestModel` selection field, digest header)
- Modify: `src/lib/connect-config.ts` (expose the merged groups to the resolver; allow-entry resolution reused as is)
- Modify: `skills/ce-connect/SKILL.md` (frontmatter `argument-hint`; word collection step before the preflight; pass `selection` to `begin`; refusal handling), `skills/ce-connect/references/headless-and-outcomes.md` (the new stop reasons)
- Modify: `src/lib/AGENTS.md`, `ARCHITECTURE.md` (module rows and codemap entries for the changed exports)
- Regenerate: `skills/ce-connect/scripts/connect.mjs`; any docs reference or registry surface that reads the skill's `argument-hint` (`bun run surfaces:affected --run`)
- Test: `tests/unit/ce-connect-helper-ops.test.ts`, `tests/unit/connect-helper-core.test.ts`, `tests/unit/connect-skill-contract.test.ts`

**Approach:**
- The skill lists every word that starts with `group:` or `projects:` first, as it does for `mode:`, from the skill arguments or from the invoking instruction. It passes the list unchanged. It does not parse values (KTD2).
- The helper bounds the list (provisional: 32 words, 2,048 characters each; more is `invalid-request`). It then removes identical repeats, detects conflicts, looks up the group, resolves each member through `resolveAllowEntry`, and requires each member's main root to equal a resolved allow-list entry's main root. For picks it matches names and 12-hex keys against the resolved allow-list projects (KTD3).
- Refusal reasons are fixed and distinct: conflicting selection, unknown group, unknown project, ambiguous project (with keys), group member not on the allow list (naming the member and, when it did not resolve, the reason). A refusal is a `failed` outcome, takes no lock and writes no state, in both modes.
- An allow-list entry the selection does not name is never touched. A stale entry outside the selection does not degrade the run.
- The resolved projects drive inventory, the rule index and the offer for the whole run. The answer and the digest header carry kind, name or picks, and the selection id (KTD6). The selection id is computed here and passed to U3's coverage code.

**Execution note:** Test-first in the helper test files; the resolver is a pure function with a table of word lists to outcomes.

**Patterns to follow:**
- The `mode:` procedure in `skills/ce-connect/SKILL.md` and its pins in `tests/unit/connect-skill-contract.test.ts`.
- `begin`'s existing refusal outcomes (`unsupported-host`, `busy`) for the shape of a fixed-reason `failed` answer.

**Test scenarios:**
- Happy path (AE1): a `harness-tools` group with five members, all on the allow list, resolves to exactly five projects; the inventory covers only those, and the digest header names the group.
- Happy path (AE4): no selection word reads the whole allow list and the digest names no group.
- Happy path (AE3): `group:a group:a` reads group `a` once.
- Happy path: `projects:metacogs,dev-like` resolves two names; `projects:` with a 12-hex key resolves by key.
- Edge case: a `projects:` entry that is 12-hex and matches no key but matches a name resolves by name.
- Edge case: a stale allow-list entry outside the selection leaves the run `complete`, not `degraded`.
- Edge case: two group members that resolve to the same main root count once.
- Error path (AE2): a group member not on the allow list stops before `begin`, names the member, takes no lock and writes nothing; the state root is untouched.
- Error path (AE3): `group:harness-tools projects:metacogs`, `group:a group:b` and `projects:x projects:y` each stop with the conflict reason; no lock.
- Error path: an unknown group, an unknown project name, and a name shared by two allowed projects (refusal lists both keys) each stop with their own reason.
- Error path: an empty value (`group:`, `projects:`), a value over the length cap and more than 32 words are each `invalid-request`.
- Integration: the skill's instruction-text path (a host that passes no arguments) and the arguments path produce the same `selection` list; the contract test pins the collection step before the preflight and the `argument-hint`.
- Integration: `run.json` carries `selection` with kind, name or picks, and the id; a no-selection run carries kind `all`.

**Verification:**
- Every refusal leaves no lock, no run directory and no ledger change, in both modes.
- The digest and run record of a group run name the group and the selection id.
- `bun run ce-connect-helper:drift` and `bun run surfaces:drift` pass after the final source edit.

- [ ] U3. Per-selection coverage and ledger version 2

**Goal:** Keep rotation, coverage and sweep progress per selection, so a narrow run never counts as coverage of the whole list, and migrate the ledger safely.

**Requirements:** R6, R7

**Dependencies:** U2

**Files:**
- Modify: `src/lib/connect-state.ts` (ledger version 2, coverage `selection` key, uniqueness on (selection, ruleId), migration, scoped apply)
- Modify: `src/lib/connect-helper-core.ts` (`planOffer`, `sweepProgress`, `renderSweepLine` scoped to a namespace)
- Modify: `src/ce-connect-helper.ts` (`scanAll` forces `pruneUnattributed` off for any selection run; coverage apply and `ledger show` and `ledger clear` read the namespace)
- Modify: `src/lib/AGENTS.md`, `ARCHITECTURE.md` (ledger and coverage description in the state module row and codemap entry)
- Regenerate: `skills/ce-connect/scripts/connect.mjs`
- Test: `tests/unit/connect-state.test.ts`, `tests/unit/connect-coverage.test.ts`, `tests/unit/connect-helper-core.test.ts`, `tests/unit/ce-connect-helper-sweep.test.ts`, `tests/unit/ce-connect-helper-ops.test.ts`, `tests/unit/connect-kill-recovery.test.ts`

**Approach:**
- Coverage records gain an optional `selection`. Absent means the `all` namespace, so a version-1 ledger's coverage migrates in place with no rewrite of its records (KTD5).
- The ledger reader accepts versions 1 and 2. The first write by this helper writes version 2 through the existing temp-and-rename path. Any other version, and any malformed file, reads as `ledger-unreadable` and is never replaced.
- `planOffer`, `sweepProgress` and the coverage apply take the run's namespace and look only at its records. A rule covered by a group run is still never-covered in `all`.
- Ledger entries (candidate identity, status, reason) are not namespaced. A candidate settled during any run is suppressed in every run, because identity does not depend on the selection.
- `pruneUnattributed` is false for every run with a selection, so unselected projects' coverage survives. Only a no-selection run may prune.
- `ledger show` lists coverage per namespace with its selection label where the run record has one; `ledger clear` removes every namespace.

**Execution note:** Test-first for the migration and the namespace rules; add a characterization test of today's coverage behavior before changing it.

**Patterns to follow:**
- The existing coverage write path (`applyCoverage`, post-commit ledger rewrite) and `tests/unit/connect-coverage.test.ts`.
- `decideLedgerEntry` and `clearLedger` for taking the lock around a ledger rewrite.

**Test scenarios:**
- Happy path (AE5): a `group:harness-tools` run covers a rule; a following no-selection run still offers that rule, and its sweep line counts it uncovered.
- Happy path: a second run of the same group offers rules the first did not cover, and its sweep line counts only the group's rules.
- Happy path: two groups with the same members share one namespace; renaming a group changes nothing, and adding a member starts a fresh sweep.
- Edge case: a version-1 ledger with coverage records is read and rewritten as version 2; its coverage is the `all` namespace, and a no-selection run's offer is unchanged from before.
- Edge case: a coverage record unique by (selection, ruleId) allows the same rule in two namespaces and rejects a duplicate within one.
- Edge case: overflow beyond `MAX_COVERAGE` drops the oldest records across namespaces and keeps the cap.
- Edge case: a group whose members equal the full list still keeps its own namespace and never prunes.
- Error path: a ledger with `version: 3`, a malformed file and an oversize file each read as `ledger-unreadable`; the file is byte-identical afterward and the run publishes nothing.
- Error path: a crash between the temp write and the rename of the migrated ledger leaves the version-1 file intact; the next run migrates again.
- Integration: a group run that hits `scanAll` with unselected projects keeps those projects' `all` coverage after publish (`pruneUnattributed` off), and a later no-selection run prunes only what it can attribute.
- Integration: `ledger show` after a group run and a no-selection run lists both namespaces; `ledger clear` removes both.

**Verification:**
- Narrow runs never change what a no-selection run offers, and no version-1 data is lost by migration.
- The shipped helper's strict version check is the downgrade guard: a version-2 ledger read by it reports `ledger-unreadable` and is not overwritten. The test suite pins that check on the new reader for version 3.
- Helper drift passes after the final source edit.

- [ ] U4. Portable project identity in the run record

**Goal:** Record `owner/repo` and the HEAD commit for each project in `run.json`, so a CI record can be mapped to the operator's own checkouts.

**Requirements:** R20 (foundation)

**Dependencies:** U2 (the same helper files; ordering only)

**Files:**
- Create: `src/lib/connect-repo-identity.ts` (remote and HEAD readers)
- Modify: `src/ce-connect-helper.ts` (add `repo` and `commit` to each `run.json` project entry)
- Modify: `src/lib/AGENTS.md` (new module row), `ARCHITECTURE.md` (new codemap entry), `scripts/lib/generated-surfaces.ts` (add the module to the `connect-helper` triggers)
- Regenerate: `skills/ce-connect/scripts/connect.mjs`
- Test: `tests/unit/connect-repo-identity.test.ts`, `tests/unit/ce-connect-helper-ops.test.ts`, `tests/unit/connect-promotion-contract.test.ts`

**Approach:**
- Read `<main root>/.git/config` through the bounded reader and take `remote "origin"`'s `url` only. Normalize the three GitHub forms in KTD7 to lowercase `owner/repo`. Any other host, an enterprise host, a malformed URL or a missing remote records no `repo`. Userinfo in a URL is dropped before anything is recorded.
- Read `.git/HEAD`: a symbolic ref resolves through the loose ref file and then `packed-refs`; a detached HEAD is the SHA itself. A missing or unreadable value records no `commit`.
- When `.git` is not a directory at the main root, both fields are absent. No git subprocess and no network are used.
- The fields are additive. `run.json` stays at `schemaVersion` 1, and the promotion-contract test proves `ce:compound`'s fixture still passes.

**Execution note:** Test-first. Characterize against real temporary clones for the HEAD forms.

**Patterns to follow:**
- `src/lib/search-project-identity.ts` for bounded identity-file reads, and `src/lib/search-bounded-read.ts` (`readBytesBounded`) for the read itself.

**Test scenarios:**
- Happy path: `https://github.com/Owner/Repo.git`, `git@github.com:owner/repo`, `ssh://git@github.com/owner/repo.git` and a trailing-slash variant all normalize to `owner/repo`.
- Happy path: a symbolic HEAD with a loose ref, one with the ref only in `packed-refs`, and a detached SHA each give the commit.
- Edge case: a remote on another host, a `github.example.com` host and a `file://` URL record no `repo`; the project is still read normally.
- Edge case: an unborn branch (no ref yet) records no `commit`. A repository with a second remote named `upstream` uses `origin` only.
- Error path: a `.git/config` over the bound, a symlinked `config`, and a `.git` that is a file each record nothing and never throw.
- Error path: a URL with credentials (`https://user:token@github.com/o/r.git`) records `o/r` and no part of the credential appears in `run.json`.
- Integration: a run over a real clone writes `repo` and `commit` into `run.json`; the existing promotion-contract fixture and `ce:compound`'s consumer checks still accept the record.

**Verification:**
- `run.json` for a clone with a GitHub origin carries `repo` and `commit`; one without carries neither.
- No credential text from a remote URL reaches any state file. Helper drift passes.

---

- [ ] U5. The `import` op and `fetch:<run>` in the skill

**Goal:** Let an operator pull a scheduled run's record, re-verify it against local checkouts, and get the usual local promotion lines.

**Requirements:** R20

**Dependencies:** U3 (ledger version 2), U4 (identity fields), U2 (token collection)

**Files:**
- Create: `src/lib/connect-import.ts` (record validation, repo-to-checkout mapping, local id recomputation, re-verification, import run assembly)
- Modify: `src/ce-connect-helper.ts` (`OPS`, `REQUEST_OPS`, `CE_CONNECT_USAGE`, the `import` handler)
- Modify: `src/lib/connect-state.ts` (a locked, publish-style insert for an import run; `kind: import` and provenance `{repo, runId, commit}` in the run record)
- Modify: `skills/ce-connect/SKILL.md` (the `fetch:` token, the download step, the refusal text; `argument-hint`), `skills/ce-connect/references/headless-and-outcomes.md`
- Create: `skills/ce-connect/references/fetch-and-import.md` (the download command, the fixed artifact name, the reasons the skill prints)
- Modify: `src/lib/AGENTS.md`, `ARCHITECTURE.md` (new module row and codemap entry; changed exports), `scripts/lib/generated-surfaces.ts` (add the module to the `connect-helper` triggers)
- Regenerate: `skills/ce-connect/scripts/connect.mjs` (`bun run surfaces:affected --run`, then `bun run surfaces:drift`)
- Test: `tests/unit/connect-import.test.ts`, `tests/unit/ce-connect-helper-ops.test.ts`, `tests/unit/connect-skill-contract.test.ts`, `tests/unit/connect-promotion-contract.test.ts`, `tests/unit/ce-connect-helper-packaging.test.ts`; fixtures under `tests/fixtures/connect-import/`

**Approach:**
- The skill treats `fetch:<run>` as exclusive with `group:` and `projects:` (a fixed conflict stop). The run value is a numeric GitHub run id. The download targets the fixed Systematic repository and the fixed artifact name (KTD8), into a fresh temporary directory that the skill removes afterward. A failed download prints one of three reasons: no such artifact for that run, artifact expired, or `gh` not authenticated. The flow dispatches no agent and asks nothing.
- The skill passes the downloaded directory to `import`. The artifact has a fixed layout (U8): the record at a fixed path, plus state files for the render job. The helper opens the record path only, through the bounded reader, and requires a regular file. It never opens, lists or follows anything else in the directory.
- The record is untrusted. The helper validates the schema version, size bounds, and every field type and cap; paths follow the `ce:compound` rules (a safe relative path under `docs/solutions`, `docs/plans` or `docs/brainstorms` for sources; contained tracked files for target evidence).
- Mapping uses the recorded `repo` against the `repo` of each allowed local checkout (U4's reader). Zero matches and two or more matches each refuse the candidates that depend on that project, with their own reason. A candidate depends on its target and all its sources.
- For each remaining candidate the helper recomputes the local rule id, source roles, target root and candidate id from local roots, and re-verifies every source and target-evidence fingerprint and excerpt against the local files. The recorded id, root, rule id and paths are never trusted. Free text goes through the same caps and fenced rendering as a local run.
- Accepted candidates are inserted through a locked path into the local ledger as an import run (`kind: import`, provenance, local candidate block) so `ce:compound`'s `candidate:<run-record> candidate-id:<id>` input works unchanged. Candidates already decided locally are skipped and named.
- A rerun is idempotent: when every accepted candidate is already recorded it adds no run record and no ledger entry, and reprints the lines for those still open. A busy lock is `busy`.
- The output shows the CI commit and the local commit side by side per project. A different local commit is accepted when all checks pass.

**Execution note:** Test-first. Build the fixture records (good, tampered, drifted) before the validator.

**Patterns to follow:**
- `checkCandidate`, `toCandidateRecord`, `classifyCandidate`, `publishRun`, `renderSummary` and `handoffLine` in the helper core and state modules.
- The consumer checks in `skills/ce-compound/SKILL.md` and `docs/solutions/best-practices/promote-a-cross-project-lesson-in-the-targets-own-words-2026-11-09.md`.

**Test scenarios:**
- Happy path: a record from a CI run with two projects mapped to two local clones, every fingerprint intact, inserts all candidates and prints promotion lines with local roots and local ids.
- Happy path: a different local commit with unchanged evidence is accepted, and the output shows both commits.
- Happy path: a rerun of the same record adds no run record and no ledger entry, and reprints the open lines.
- Edge case: a candidate already `rejected` locally is skipped and named; one already `promoted` is skipped and names its refresh pointer.
- Edge case: the record has a project with no `repo` (non-GitHub remote); candidates that depend on it are refused with a "cannot be mapped" reason, the rest import.
- Error path (AE11): a target file changed since the CI run; that candidate is refused with the file named, and tokens print for the others.
- Error path: two allowed local checkouts share one `repo`; dependent candidates are refused as ambiguous, naming both project keys. A recorded `repo` with no local checkout is refused as unmapped.
- Error path: a source path with `..`, an absolute path, a path outside the three corpus directories, and a symlink target are each rejected and counted.
- Error path: a tampered candidate id, a rule id not in the local index and an excerpt that is not verbatim each cause that candidate to be refused; nothing is inserted from it.
- Error path: an oversize record, a wrong `schemaVersion`, and a missing record file each fail with a distinct reason and change no state. A symlink at the record path is refused, and a directory holding state files beside the record (the real artifact layout) imports normally without those files being read.
- Error path (skill): a missing artifact, an expired artifact and an unauthenticated `gh` each print their own reason; none reaches the helper.
- Integration: an import run's record satisfies `ce:compound`'s promotion consumer fixture; `fetch:123 group:a` stops with the conflict reason; the packaged bundle runs `import` under the three shipped layouts.
- Integration: a held lock makes `import` answer `busy` and write nothing.

**Verification:**
- No candidate reaches the local ledger without passing local re-verification, and no field of the downloaded record is printed unfiltered.
- A CI lesson promotes through the unchanged `ce:compound` input after `fetch`.
- Helper drift and the packaging test pass after the final source edit.

- [ ] U6. CI helper ops: `apply-ticks`, `render-report` and the payload store

**Goal:** Ship the two deterministic ops the workflow needs, with an inert report body, a bounded payload store and idempotent tick recording, in the same release as the code that writes the state.

**Requirements:** R14, R15, R16, R19

**Dependencies:** U3 (ledger version 2)

**Files:**
- Create: `src/lib/connect-ci.ts` (tick acceptance, payload store, report rendering, neutralisation, manifest)
- Modify: `src/ce-connect-helper.ts` (`OPS`, `REQUEST_OPS`, `CE_CONNECT_USAGE`; handlers for `apply-ticks`, `render-report` and the payload-store write, see Approach)
- Modify: `src/lib/AGENTS.md`, `ARCHITECTURE.md` (new module row and codemap entry), `scripts/lib/generated-surfaces.ts` (add the module to the `connect-helper` triggers)
- Regenerate: `skills/ce-connect/scripts/connect.mjs`
- Test: `tests/unit/connect-ci.test.ts`, `tests/unit/ce-connect-helper-ops.test.ts`, `tests/unit/ce-connect-helper-packaging.test.ts`; fixtures under `tests/fixtures/connect-ci/`

**Approach:**
- `apply-ticks` follows KTD9. It takes the lock, accepts a tick only when its id is in the manifest and the candidate is open, skips conflicts and repeats, reports unknown ids, and records accepted ticks through the existing `decide` path with the fixed reason. The output is a structured list of accepted, skipped (with reason) and unresolved ids.
- The payload store holds one bounded record per open CI candidate (KTD10), outside `runs/` and untouched by prune. The run job writes payloads for the candidates its run left open. The write is a third small op (provisionally `store-payloads`) that reads the newest run record and the ledger; it is listed in `OPS` with the other two. A payload is deleted when its candidate is settled.
- `render-report` reads the ledger, the payload store, the run record and envelope, and the last manifest. It treats every one of them as untrusted: bounded sizes, typed fields, unknown keys dropped. A candidate with no payload (for example after a partial restore) is listed by id with a "details unavailable" line, never dropped.
- Neutralisation: model text goes in fences longer than any fence inside it, control characters stripped; `@name` is broken so it cannot mention; `#n`, `GH-n` and `owner/repo#n` are broken so they cannot link. The decision lines are generated and are the only place the id marker appears; a marker-shaped string inside model text is neutralised too.
- Body assembly follows KTD10: ordering newest first, the 60,000-character cap with whole blocks only and a hidden-count line, the "New" marker by first-shown UTC date, the outcome, degrade reasons, the sweep line, the selection, a "ledger reset" notice when the envelope says no cache was restored, and the `fetch` command for the run. It writes the manifest of the ids it rendered with boxes.
- `render-report` never reads the network or the clock beyond a supplied UTC date.

**Execution note:** Test-first. The neutralisation and the cap are the highest-risk logic; write their adversarial fixtures before the renderer.

**Patterns to follow:**
- `renderDigest` and `renderSummary` for free-text rendering (block quotes, fenced excerpts, longer fences, stripped control characters).
- `decideLedgerEntry` for the locked ledger write; `decide`'s validation for the reason bounds.

**Test scenarios:**
- Happy path: three ticks in the manifest for open candidates (two Rejected, one Promoted) are recorded with the reason `settled in report #<n>`, and the output lists them accepted.
- Happy path (AE8): a Rejected tick is recorded; `render-report` then omits that candidate and lists the unticked one again with its box.
- Happy path (AE7): a render with no restored cache includes the "ledger reset" notice, the sweep line and the fetch command.
- Edge case: a repeat of an already-recorded tick is skipped and the ledger bytes are unchanged; the op run twice gives the same result.
- Edge case: both boxes ticked for one id is reported as a conflict and neither is recorded.
- Edge case: an id absent from the manifest, and an id for a candidate no longer open, are reported and skipped; an id unknown to the ledger after a cache reset is reported, not fatal.
- Edge case: 200 open candidates exceed the cap; the newest are shown whole with their boxes, the hidden count is stated, none is cut mid-block, and the hidden ones stay open in the ledger and the next manifest.
- Edge case: a candidate with no payload is listed by id with a "details unavailable" line.
- Error path (AE10): an excerpt containing `- [x] Promoted` and a marker-shaped string renders fenced, and no tick parsed from the rendered body (only the delimited section) records a decision from it.
- Error path: model text with `@owner`, `#12`, `GH-12` and `owner/repo#12` renders with each neutralised; a fence of backticks inside the text does not close the surrounding fence.
- Error path: an oversize or malformed payload, a manifest with an unknown key and a run record with a wrong type are bounded or refused without throwing; a held lock makes `apply-ticks` answer `busy`.
- Integration: the payload written after a run, a cache round trip (copy the state directory), then `render-report` the next day lists the same open candidate with its details and marks it not new; settling it deletes the payload.
- Integration: the packaged bundle runs all three ops under the three shipped layouts.

**Verification:**
- A rendered body contains no decision line that the renderer did not generate, and no mention or reference that links.
- `apply-ticks` twice in a row changes nothing the second time.
- Helper drift and the packaging test pass after the final source edit.

- [ ] U7. Delivery A documentation and registration

**Goal:** Document groups, picks and `fetch`, register the architecture changes, and resolve the frozen-digest prose conflict.

**Requirements:** R21 (Delivery A part)

**Dependencies:** U1-U6

**Files:**
- Modify: `docs/src/content/docs/guides/cross-project-connections.mdx` (groups and picks under "Choose the projects", the selection refusals, per-selection sweep progress, `fetch` under "Promote a candidate", the `gh` requirement)
- Modify: `ARCHITECTURE.md` (the trust-boundary table: groups beside the allow list, import as a new ingress; the run lifecycle: selection resolution before the lock; the `import`, `apply-ticks`, `render-report` and payload ops)
- Modify: `src/lib/AGENTS.md`, `STRUCTURE.md` (only where they list the connect modules or ops)
- Modify: `docs/src/content/docs/privacy.mdx` ("Connecting your projects": `fetch` runs `gh run download` as an explicit command; the helper still opens no connection)
- Modify: `docs/solutions/best-practices/pre-registered-evaluation-of-a-model-driven-tool-2026-11-09.md` (steps 3 and 4) and `tests/manual/connect-eval/PRE-REGISTRATION.md` (the prose around later frozen-digest lines)
- Check: `HARNESSES.md` (no change expected in Delivery A; it gains the live dispatch proof in U10)
- Test: `tests/unit/content-integrity.test.ts` (existing gate), `tests/unit/connect-eval-fixture.test.ts` (must still pass unchanged)

**Approach:**
- The guide documents the group record, the two token forms, key-versus-name for ambiguous projects, the fixed refusals, why a narrow run's coverage is separate, and what `fetch` prints and refuses.
- The frozen-digest conflict: the prose still asks for a "last digest line must match the tree" test and a new digest line per change, and no test enforces either. Only the registered digest is pinned (`connect-eval-fixture.test.ts`). Reword the prose to say the registered digest is the pinned record and later digest lines are optional history. Do not change the registered digest line or the order the test pins.
- Run `bun scripts/content-integrity.ts` to confirm each new module has its codemap entry and module-table row, and each cited path and symbol still holds.

**Execution note:** none. Documentation unit; the content-integrity gate is the check.

**Patterns to follow:**
- The existing sections of the guide and the `ARCHITECTURE.md` table rows for style and length.

**Test scenarios:**
- Test expectation: none -- documentation and registration. The gates below are the check.

**Verification:**
- `bun scripts/content-integrity.ts` and `bunx markdownlint-cli2` pass on the edited docs, `bun run docs:build` passes, and `bun test tests/unit/connect-eval-fixture.test.ts` still passes.
- `bun run surfaces:drift` reports no drift. Delivery A can be released.

---

### Phase 2: Delivery B, workflow

- [ ] U8. The `connect.yaml` workflow

**Goal:** Run one headless slice daily over public repositories, keep the CI ledger in a cache, and post one rotating report issue per UTC date, with the agent step holding no write credential.

**Requirements:** R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19

**Dependencies:** U0 (passed), U6, U7, and the Systematic release that ships Delivery A (the workflow pins to that exact version)

**Files:**
- Create: `.github/workflows/connect.yaml` (all job scripts inline; no checkout of Systematic and no repository script runs in `render` or `post`)
- Test: `tests/unit/connect-workflow.test.ts` (U9)

**Approach:**
- Triggers, concurrency and permissions follow KTD11: daily `schedule` at a fixed off-hour minute, `workflow_dispatch` restricted to the default branch, group `ce-connect-scheduled` with `queue: max` and `cancel-in-progress: false`, top-level `permissions: {}`, per-job permissions as listed there, and a `timeout-minutes` on each job (the run job's exceeds the action's own 30-minute default).
- One workflow-level value holds the Systematic version. The action's `systematic-version` input and the `npm install` of the helper package in `prepare` and `render` read it, so the skill the action loads and the helper that wrote the state are one version. The install uses the exact version and `--ignore-scripts`. The action is pinned by full commit SHA with a version comment, as `fro-bot.yaml` does.
- Variables: `FRO_BOT_CONNECT_PROJECTS` (whitespace- or comma-separated `owner/repo`, shape-checked, deduplicated, bounded; provisional maximum 16), `FRO_BOT_CONNECT_MODEL` (required) and `FRO_BOT_CONNECT_VARIANT` (optional). The provider credential is the `OPENCODE_AUTH_JSON` secret already used by `fro-bot.yaml`.
- `prepare` and `render` both check visibility through the API and treat any error or a non-public result as not public, so a repository that turns private during the run is caught before the body is built.
- Checkouts are default-branch clones of public repositories made without credentials, placed under the layout in KTD11 and U0. The config directory reaches the action's child process by the route U0 found. The runner-local `systematic.jsonc` carries the allow list and the researcher model overlay, and the pre-dispatch check compares the file's contents with what was written.
- `run` records the envelope, then uploads one artifact named `connect-run-<GitHub run id>` with a fixed layout: the record at a fixed path (`U5` reads only that path) and the state files `render` needs. The `fetch:<run>` argument is that GitHub run id.
- Cache: `prepare` restores by the `connect-v1-` prefix; `render` saves under the unique key in KTD11 with `if: always()`. A cache save failure is reported in the body and turns the job red. The cache holds what KTD14 lists.
- Report lookup, tick parsing, rotation and the secret refusal are shell steps whose scripts are small enough to run in the U9 sandbox against a stub `gh`. The tick parser reads only the delimited section of the newest open report's body. A report is found by the exact title rule `ce:connect report — YYYY-MM-DD (UTC)` and the author, never by a search term alone.
- The post job writes through the issue API by number when today's report exists and creates it otherwise, then re-reads to confirm before closing any older connect report. It never opens a second issue for a date.
- Exit status follows the failure matrix (KTD12): `prepare` configuration failures and an action failure before `begin` are red with nothing posted; failed and no-final-line runs are posted and then red; cache-save failures are reported and red.
- The run job's token source (job `github.token` or a stored read-only secret) is chosen here, per the Open Questions entry.

**Execution note:** Build the sandbox scenarios in U9 alongside the scripts; write each script step so it can run from a plain shell with a stub `gh`.

**Patterns to follow:**
- `.github/workflows/release-gate.yaml` for the cron-plus-dispatch shape, empty top-level permissions and credentialed jobs that run no repository code.
- The `approval-backstop` job in `.github/workflows/fro-bot.yaml` for `needs`, `always()`, no checkout and `permissions`.
- The `fro-bot.yaml` action pin form and the Fro Bot title rule (to differ from it).

**Test scenarios:**
- Test expectation: none in this unit -- the workflow is exercised by U9's structure and sandbox tests and by the U10 dispatch proof.

**Verification:**
- `actionlint` (or the repo's workflow lint, if any) passes on the file, and U9 passes.
- A dry read of the file shows: no write permission outside `post`, no checkout in `render` or `post`, and the action step is the only step that receives `auth-json`.

- [ ] U9. Workflow guard tests

**Goal:** Pin the workflow's structure and prove its scripts against a stub `gh`, including every workflow-level acceptance example.

**Requirements:** R11, R12, R15, R17, R18, R19 (and the workflow side of R14, R16)

**Dependencies:** U8

**Files:**
- Create: `tests/unit/connect-workflow.test.ts` (parses `.github/workflows/connect.yaml` with `js-yaml` and `JSON_SCHEMA`; runs the real step scripts in a temporary sandbox with a stub `gh` and, for ops, the real `connect.mjs`)
- Test: `tests/unit/fro-bot-workflow.test.ts` (read only; its helpers are the model)

**Approach:**
- Structure tests read the YAML and assert triggers, concurrency, top-level and per-job permissions, `needs` and `if: always()` conditions, absence of checkout in `render` and `post`, which job receives `auth-json`, the action pin form (full SHA with a version comment, and the same ref as `fro-bot.yaml` unless the files legitimately diverge, in which case the form only), the Systematic version used in all three places, artifact names, variable names, and that the report title does not match Fro Bot's rule while Fro Bot's title does not match connect's.
- Script tests extract each named step's script and run it in a sandbox with a stub `gh` that records calls and serves fixtures. The post step's secret refusal runs with real values supplied through env.
- Op-level scenarios run the bundled `connect.mjs` against a temporary state directory, so the report and tick format that U6 chose is the format the parser reads.
- No test depends on a literal action or Systematic version; they assert wiring (see `release-workflow-test-pins-action-sha-2026-10-14`).

**Execution note:** Test-first for the script behaviors; the structure pins can land with the workflow.

**Patterns to follow:**
- `tests/unit/fro-bot-workflow.test.ts`: `stepNamed`, the sandbox helper, and the way it asserts pins by form.

**Test scenarios:**
- Happy path: schedule and dispatch triggers exist; dispatch is restricted to the default branch; the concurrency group is `ce-connect-scheduled` with `queue: max` and no cancel.
- Happy path (AE12): a dispatch after that day's scheduled run reads today's report first, records the ticks, then edits today's report by number; the stub records no create call and one edit.
- Happy path: a new date creates the report, confirms it, then closes the previous connect report; the close happens after the confirmation read.
- Edge case: zero open reports is a normal first run and creates one; the previous-report close list is empty.
- Edge case: an open issue with a look-alike title (extra text, wrong dash, wrong author) is not treated as a connect report and is never closed.
- Edge case: a report over the 60,000-character cap shows the hidden-count line and posts; the post step refuses a body over the cap or with a digest mismatch.
- Error path (AE6): a private repository in the list, an API error on the visibility call, an empty list, a malformed entry and an unset model each fail `prepare` red before any checkout; the stub records no post and no close.
- Error path: more than one open connect report with the newest date, or an error from the issue lookup, fails `prepare`. Several open reports with different dates do not fail it.
- Error path (AE9): an envelope with `begun` and no final line makes `render` produce a body that says the run ended with no final line, `post` posts it, and the workflow result is red.
- Error path: an envelope with `preflight-ok` and an action failure produces no body and no post; the job is red.
- Error path: the body contains the exact value of the provider credential, then of each token, then a near-miss (one character different); the first cases refuse to post and the near-miss posts. The refusal message names no value.
- Error path: `post` fails after the write and before rotation. Two connect reports stay open; the next run's `prepare` selects the newest by title date, and its `post` closes the older one after confirming its own write. Two open reports with the same date still fail the lookup.
- Error path (AE10): a candidate excerpt that contains `- [x]` and the marker syntax renders fenced; feeding the posted body back into the tick parser yields no tick from it.
- Error path: ticks outside the delimited section, in a closed report, or with an id not in the manifest are ignored or reported and record nothing.
- Integration (AE8): report N has one Rejected tick and one unticked candidate; `apply-ticks` records the rejection, and report N+1 omits it and lists the other again.
- Integration (AE7): `prepare` restores no cache; the body says the ledger was reset and the sweep restarted, and a tick for an id the fresh ledger does not know is reported as unresolved and is not fatal.
- Integration: the same tick list run through the prepare script twice leaves the ledger byte-identical.

**Verification:**
- The suite fails when a permission is widened, when `render` or `post` gains a checkout, when the title rule drifts to match Fro Bot's, when the Systematic version differs between uses, and when a decision can be parsed from model text.
- `bun test tests/unit/connect-workflow.test.ts` passes without network.

- [ ] U10. Delivery B documentation and live dispatch proof

**Goal:** Document the workflow for operators, and record a real dispatch as the evidence that the pinned release and the action work together.

**Requirements:** R21 (Delivery B part), R9, R10, R17, R18 (proof)

**Dependencies:** U8, U9, and the repository variables and secret set by the owner

**Files:**
- Modify: `docs/src/content/docs/guides/cross-project-connections.mdx` (a "Scheduled runs" section: the three variables and the secret, what the cache holds and when it resets, the report and its boxes, `fetch`, the public-only rule, the pin and how to bump it, and the residual exposure)
- Modify: `docs/src/content/docs/privacy.mdx` (a scheduled run sends content from public repositories to the model provider and posts a public issue)
- Modify: `ARCHITECTURE.md` (the report issue as the one unattended write, the four-job split and the artifact handoff)
- Modify: `HARNESSES.md` (the live dispatch proof: workflow run URL, action SHA, host version the run reported, Systematic version, outcome line)
- Check: `AGENTS.md` and `STRUCTURE.md` mention the workflow only if they list workflows
- Test: `tests/unit/content-integrity.test.ts` (existing gate)

**Approach:**
- The guide states plainly: the agent step can read the model-provider credential and the token on the runner, so a prompt injection hidden in a public repository's text could try to exfiltrate them; the mitigations are public-only repositories, a read-only token, no write path to any repository, and the post job's exact-value refusal, which does not catch an encoded secret. The guide says this is accepted and documented.
- It also states: tick one box per candidate; ticks in a closed report are ignored; the first run after a cache eviction restarts the sweep; and the `fetch` command is on each report.
- The live proof is a manual dispatch on the default branch after merge. Record the run, the outcome line, the report issue, and a second same-day dispatch that rewrites the report in place (AE12). Record the host version and Systematic version pair beside the `HOST_SUPPORT_TABLE` row it matches.
- After the proof, capture the layout and credential findings from U0 and U8 with `ce:compound`.

**Execution note:** none. Documentation plus a recorded manual proof.

**Patterns to follow:**
- The "Cross-project connections" row and evidence-registry style in `HARNESSES.md`.

**Test scenarios:**
- Test expectation: none -- documentation and a recorded live proof. The gates below and the proof are the check.

**Verification:**
- `bun scripts/content-integrity.ts`, `bunx markdownlint-cli2` and `bun run docs:build` pass.
- A live dispatch ended with a `Connect` final line and a posted report; a second same-day dispatch edited that report and opened no second issue; the HARNESSES entry names the run.

---

## System-Wide Impact

- **Interaction graph:** the skill's `begin` request gains a `selection` list; the helper gains `import`, `apply-ticks`, `render-report` and a payload-store write; the workflow runs the helper from the pinned package in `prepare` and `render`. `ce:compound`, `ce:compound-refresh` and the researcher agent are unchanged.
- **Helper version coupling:** the helper that wrote the cached ledger, the skill the action loads and the helpers `prepare` and `render` run must be one version. A single workflow-level value feeds all three and U9 pins that. A Systematic release that changes ledger or record formats needs a workflow pin bump in the same or the next PR.
- **Ledger format:** version 2 adds a coverage namespace. The first write by the new helper migrates version 1; the shipped helper reads a version-2 ledger as `ledger-unreadable` and writes nothing, so a downgrade stops safely. A CI cache restored by a helper that predates version 2 would be refused the same way, which the report would show.
- **Error propagation:** a selection refusal and a `fetch` refusal happen before any lock or ledger write. The workflow follows the matrix in KTD12; no failure after `begin` is silent.
- **State lifecycle:** the cache can be evicted or missing; the payload store can lag the ledger; the report can be written and not rotated. Each case has a defined result: a reset notice, a "details unavailable" line, and rotation by the next run.
- **API surface parity:** group and pick words work on every host because the skill reads them from arguments or from the invoking instruction. `fetch` needs `gh` and the operator's authentication on the local machine. Scheduled runs are OpenCode v2 only, through the action.
- **Integration coverage:** unit tests cannot prove that the action's real runner accepts the layout, the read-only token and the prompt. U0 and the U10 dispatch proof cover that. The packaging test proves the three new ops under the three shipped layouts.
- **Generated surfaces touched:** `connect-helper` (every helper unit), `schema` and `config-reference` (U1), and any surface that reads the skill's `argument-hint` or the new reference file (U2, U5; `surfaces:affected` names them). No ninth surface is added. The `schema` and `config-reference` trigger lists gain `src/lib/connect-config.ts`.
- **Fro Bot isolation:** Fro Bot's rotation closes reports whose title matches its own exact rule and author. The connect report has a different title and, by design, never matches that rule, and connect's own rotation matches only its own title. U9 pins both directions.
- **Required checks:** none. The workflow runs on cron and dispatch only, produces no pull-request check context, and does not belong in `.github/settings.yml` or the release gate's required checks.
- **Unchanged invariants:** the allow list is the only trust boundary and stays user-only; project config still strips the `connect` block; a run with no selection offers exactly what it offered before; the researcher's tools and the candidate contract are untouched; the local ledger and the CI ledger never sync.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The action's contract changes: inputs, permission stripping, credential mode, or the working-directory rule. | U0 proves the layout live; the action is pinned by SHA; the dispatch proof records the pair; any change fails red and is posted when it happens after `begin`. A failed spike stops the work and the fallback is an action change. |
| The action's OpenCode host version moves away from the `HOST_SUPPORT_TABLE` rows. | Headless `begin` refuses an unlisted pair, so the run is posted as failed and red. The action bump arrives as a Renovate PR; the table rows have their own Renovate manager. The dispatch proof records the pair. |
| Cache eviction or a missing cache resets the CI ledger. | The daily cadence keeps the cache warm. The report says the ledger was reset. Settled candidates can reappear once and unresolved ticks are reported. The cost is one fresh sweep. |
| A prompt injection in a public repository's text exfiltrates the provider credential or the token from the runner. | Accepted residual, documented in the guide and privacy page. Mitigations: public repositories only, a read-only token, no write path to any repository, an inert report, and an exact-value secret refusal in `post`. The refusal does not catch an encoded secret. |
| The report body outgrows the issue limit. | A 60,000-character cap with whole blocks only; hidden candidates stay open and are counted. |
| A repository turns private between the check and the post. | `render` rechecks visibility before it builds the body; any error counts as not public. |
| A ledger migration corrupts or loses coverage. | The migration is temp-and-rename, version 1 data keeps its meaning as the `all` namespace, and any unknown version is refused untouched. |
| A same-day dispatch races the scheduled run. | The concurrency group serializes runs with `queue: max`; the second run reads the first's ticks and rewrites the same report. |
| The workflow and the helper drift in version. | One workflow-level version feeds the action input and both helper installs; U9 pins the equality. |
| `fetch` meets an expired or missing artifact. | The skill prints a distinct reason for each case and changes nothing. Artifacts follow the repository's retention. |

---

## Documentation / Operational Notes

- The owner sets the repository variables `FRO_BOT_CONNECT_PROJECTS`, `FRO_BOT_CONNECT_MODEL` and optionally `FRO_BOT_CONNECT_VARIANT`. The secret `OPENCODE_AUTH_JSON` already exists. These settings and the spike-branch push need the owner's approval at the time (workflow and settings changes are Ask First).
- Release order: merge Delivery A, release, bump the workflow pin to that exact version, merge Delivery B, dispatch once for the proof. Later Systematic releases that change ledger or record formats need a pin bump.
- Rollback: disable the workflow in the repository settings. Delete the `connect-v1-` caches to reset the CI ledger. Open report issues can be closed by hand.
- The local ledger and the CI ledger are separate. An operator who promotes locally through `fetch` still ticks Promoted in the report so the CI ledger settles the candidate.
- Run `bun run surfaces:affected --run` then `bun run surfaces:drift` before each commit in Delivery A, and regenerate the helper after the final source edit (`registry-drift-on-skill-description-change-2026-05-20`).

---

## Sources & References

- **Origin document:** `docs/brainstorms/2026-11-12-ce-connect-groups-and-scheduled-runs-requirements.md`. This path is gitignored and untracked in this repository, so a clone will not contain it; the requirement and acceptance IDs above are the durable trace.
- Related past work: `docs/plans/2026-11-06-001-feat-cross-project-connections-plan.md`, recorded completed. It shipped the allow list, headless mode, the ledger and rotation, and deferred scheduling and unattended writes. This plan adds scheduling and one narrow report-issue write for public projects.
- Related past work: `docs/plans/2026-10-11-004-feat-gated-release-pr-plan.md` and `docs/plans/2026-09-04-001-refactor-ci-owned-host-contract-suite-plan.md`, both recorded completed. The job split with a data-only handoff, and CI-owned host evidence.
- Related code: `src/lib/connect-config.ts`, `src/lib/connect-state.ts`, `src/lib/connect-helper-core.ts`, `src/ce-connect-helper.ts`, `src/lib/search-project-identity.ts`, `skills/ce-connect/SKILL.md`, `.github/workflows/fro-bot.yaml`, `.github/workflows/release-gate.yaml`, `tests/unit/fro-bot-workflow.test.ts`, `scripts/lib/generated-surfaces.ts`.
- Solutions: `docs/solutions/security-issues/trusted-step-after-the-agent-needs-its-own-job-2026-11-09.md`, `docs/solutions/best-practices/evidence-boundary-for-reading-other-repositories-2026-11-09.md`, `docs/solutions/integration-issues/opencode-v1-headless-external-directory-auto-reject-2026-11-09.md`, `docs/solutions/best-practices/promote-a-cross-project-lesson-in-the-targets-own-words-2026-11-09.md`, `docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md`, `docs/solutions/best-practices/pre-registered-evaluation-of-a-model-driven-tool-2026-11-09.md`, `docs/solutions/workflow-issues/release-workflow-test-pins-action-sha-2026-10-14.md`, `docs/solutions/best-practices/skill-around-an-untrusted-researcher-needs-baseline-pressure-tests-2026-11-09.md`, `docs/solutions/workflow-issues/release-notes-narrative-ci-automation-architecture-2026-05-23.md`, `docs/solutions/workflow-issues/host-contract-evidence-is-ci-owned-2026-09-04.md`.
- External: `fro-bot/agent` at commit `f15b238b6` of its default branch (inputs, credential modes, config stripping, host pin), as read by the research lane.
