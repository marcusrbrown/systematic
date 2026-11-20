# Fetch and import

`fetch:<run>.<attempt>` brings the candidates of one attempt of a scheduled CI run to this machine, so a lesson the runner found can be promoted here after the runner is gone. A bare `fetch:<run>` does the same for the newest attempt of that run. A bare word means Systematic. A named word, `fetch:<owner>/<repo>:<run>.<attempt>`, does the same for one attempt of a scheduled run in another repository that called Systematic's reusable workflow; there the attempt is required. In every command below, `<run>` and `<attempt>` are the numbers `SKILL.md` already checked: positive integers, nothing else. `<repo>` is `marcusrbrown/systematic` for a bare word, and for a named word the `owner/repo` of the word, lowercased, after step 1 found it among the allowed origins. The skill does the part that needs the network, with the user's own `gh`. The helper's `import` operation does the rest and never touches the network.

Every `gh` call below names github.com explicitly, as a host flag or as a `github.com/` repository, because the allow-list origin is a github.com origin, so `GH_HOST` or a GHE remote must not redirect the checks.

A fetch dispatches no agent, asks nothing and takes no host observation. It uses neither `begin` nor `publish`. It ends with the `finalLine` that `import` answers, or with `Connect failed` for a stop before `import`.

The repository of a bare word is fixed: `marcusrbrown/systematic`. The repository of a named word is the one in the word, used only after step 1 found it among the allowed origins. Never take a repository, a path or a workflow name from the downloaded record or from any other file: a repository comes from the user's word, never from a downloaded file.

A bare word never reads `referenced_workflows`. Its whole check is the fixed repository, the event and the run's top-level workflow path, so Systematic's own fetch does not depend on the proof a named word needs.

## Order

Do these in order. Start every block that runs a command with the same anchor lines as the other steps, with `SKILL_DIR` set to the skill directory stated when this skill loads. A bare word skips steps 1 and 3.

### 1. Resolve the repository

A bare word keeps the fixed repository; skip to step 2 and check no origin.

For a named word, ask the helper which origins are allowed before any `gh` command:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/connect.mjs" allowed-origins
```

It takes no request and answers one line of JSON with three fields: `origins`, the lowercase `owner/repo` of the GitHub origin of each allowed checkout; `ambiguous`, the origins that two or more allowed checkouts share; and `configUnreadable`. It reads configuration only: it takes no lock, writes nothing and never prints a local path. Never read the configuration yourself.

Lowercase the word's `<owner>/<repo>` and look for it in `origins`, which is already lowercase, so the match ignores case: `Fro-Bot/Agent` matches the origin `fro-bot/agent`. From here on, use that lowercase form as `<repo>`.

- It is not in `origins`: stop with `origin-not-allowed`. Run no `gh` command. Nothing was downloaded. To fix it, allow-list a checkout of that repository: add a local checkout whose `origin` remote is `<repo>` to `connect.allow_projects`, then try again. When `configUnreadable` is `true`, say that the allow list could not be read.
- It is in `ambiguous`: stop with `repo-ambiguous`. `import` would refuse every candidate of that repository for the same reason. Nothing was downloaded. Remove all but one of the checkouts from the allow list, then try again.
- The answer is JSON with `ok: false`, or JSON without `origins`: stop and print the helper's `reason`, then `Connect failed`, without running `gh`. Nothing was downloaded. Never guess an origin from a path or from the checkouts you can see.
- If `node` is missing, the helper file is gone, or `allowed-origins` prints no JSON answer, the helper is unavailable: print `helper-unavailable` and its hint, then `Connect failed`. Nothing was downloaded.

### 2. Check the run, before any download

`gh run view --json` has no workflow path, so the API call is the check.

#### Bare word

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
gh api --hostname github.com "repos/marcusrbrown/systematic/actions/runs/<run>" --jq '[.path, .event, .head_sha] | @tsv'
```

It prints three tab-separated values: the workflow path, the event and the head commit.

- The path must be `.github/workflows/connect.yaml` (a direct run) or `.github/workflows/connect-scheduled.yaml` (Systematic's own scheduled wrapper). Drop a trailing `@<ref>` before comparing. Any other path (for example `.github/workflows/fro-bot.yaml`): stop with `not-a-connect-run`.
- The event must be `schedule` or `workflow_dispatch`. Any other event: stop with `unsupported-run-event`. A run triggered by a pull request is never read, whatever its artifacts hold.
- The command fails with a 404: stop with `run-not-found`. It fails because `gh` is not logged in: stop with `gh-not-authenticated`.
- Keep the head commit for the request below. It must be 40 or 64 lowercase hex characters; otherwise leave `commit` out.
- Skip step 3 and go to step 4.

#### Named word

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
gh api --hostname github.com "repos/<repo>/actions/runs/<run>" --jq '[.event, .head_sha] | @tsv'
```

It prints two tab-separated values: the event and the head commit.

- The event must be `schedule` or `workflow_dispatch`. Any other event: stop with `unsupported-run-event`.
- The command fails with a 404: stop with `run-not-found`. It fails because `gh` is not logged in: stop with `gh-not-authenticated`. It fails for any other reason: stop with `provenance-unprovable`.
- The run's own path is the caller's wrapper, so it is not read here, and a wrapper's own path proves nothing. Step 3 proves what the run called.
- Keep the head commit for the request below. It must be 40 or 64 lowercase hex characters; otherwise leave `commit` out.

### 3. Prove the provenance (named words only)

The helper decides this step. You fetch the text from `gh`, send it to the helper and act on the answer. Never judge `referenced_workflows` yourself: never read the list, pick an entry or check a hash. The helper's `verify-provenance` operation takes no lock, writes nothing, reads no network or configuration and never prints a path.

Read the exact attempt the word names. Never read the run's newest attempt instead.

```bash
gh api --hostname github.com "repos/<repo>/actions/runs/<run>/attempts/<attempt>" --jq .referenced_workflows
```

It prints the attempt's `referenced_workflows`.

- The attempt does not exist (a 404): stop with `run-not-found`.
- `gh` is not logged in: stop with `gh-not-authenticated`.
- The API call fails for any other reason: stop with `provenance-unprovable`, with its remedy from the table below.

Never download on any stop below. Send the text `gh` printed, unchanged, to the helper on stdin:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/connect.mjs" verify-provenance <<'JSON'
<the text gh printed, unchanged>
JSON
```

It answers one line of JSON. It takes the text as it is, so text that is not JSON is judged by the helper, not refused as a bad request. It decides, in this order:

- The value is absent or `null`, is not a list, is empty, or an entry has no string `path`: `provenance-unprovable`.
- It takes the entries whose `path`, the part before the `@`, is `marcusrbrown/systematic/.github/workflows/connect.yaml`, comparing `marcusrbrown/systematic` without regard to case and the rest exactly (`MarcusRBrown/Systematic/.github/workflows/connect.yaml@<sha>` matches; `marcusrbrown/systematic/.github/Workflows/connect.yaml` does not). It matches by path, never by position in the list.
- No entry matches: `not-a-connect-run`. The run is proven to be another workflow, such as another repository's workflow, a fork or another path.
- More than one entry matches: `provenance-unprovable`.
- The matching entry's `sha` is not 40 lowercase hex characters: `provenance-unprovable`. It never uses `ref` or the text after the `@`.

Read the answer:

- `ok: true` with `stage: "selected"`: the answer carries `sha`. Go on to the compare below.
- `ok: false`: stop with the `reason` it names, `provenance-unprovable` or `not-a-connect-run`, and print the remedy from the table below. Download nothing and run no further `gh` command.
- JSON with any other `reason` (such as `invalid-request`), or JSON with neither `ok: true` nor a `reason`: stop and print that `reason`, then `Connect failed`, without running `gh`. Nothing was downloaded.
- If `node` is missing, the helper file is gone, or the operation prints no JSON answer, the helper is unavailable: print `helper-unavailable` and its hint, then `Connect failed`. Nothing was downloaded.

Then check that the commit is on Systematic's default branch:

```bash
gh api --hostname github.com "repos/marcusrbrown/systematic/compare/main...<sha>" --jq .status
```

`<sha>` is the `sha` the helper answered. The base is `main` and the head is the `sha`. Never swap the two sides of the range.

- The command fails (a 404, which an unknown commit and no access both give, or any other failure): stop with `provenance-unprovable`, with its remedy from the table below. Do not call the helper again.
- It prints a status. Send the same text again, with the status as `gh` printed it, with no trailing newline:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/connect.mjs" verify-provenance --status "<status>" <<'JSON'
<the same text again>
JSON
```

- `ok: true` with `stage: "accepted"`: the commit is behind or identical to `main`, so it is in the history of `main`. Go on.
- `ok: false`: stop with the `reason` it names. The helper refuses `ahead` (the commit is not in `main`), `diverged`, an empty status and any other status as `provenance-unprovable`.
- Any other answer: stop as above.

`provenance-unprovable` means the proof is missing. It is not a finding that the run is hostile. To fix it, check that the caller's wrapper calls `marcusrbrown/systematic/.github/workflows/connect.yaml` at a commit on Systematic's `main`, then try again. If an API call failed, try again later.

### 4. Choose the artifact

The record is in an artifact named `connect-run-<run>-<attempt>`, where `<attempt>` is digits only. How to list it depends on whether the attempt is known.

For a named word or an explicit attempt (`fetch:<run>.<attempt>` or `fetch:<owner>/<repo>:<run>.<attempt>`), look the artifact up by its exact name:

```bash
gh api --hostname github.com "repos/<repo>/actions/runs/<run>/artifacts?name=connect-run-<run>-<attempt>" --jq '[.artifacts[] | {name: .name, expired: .expired}]'
```

It prints one JSON array of `{name, expired}` objects. Check the call before you read the array:

- The command fails because `gh` is not logged in: stop with `gh-not-authenticated`.
- The command fails for any other reason (a non-zero exit), or its output is not a JSON array: stop with `artifact-list-failed`. An empty array is an answer; a failed call is not. Never read a failed call as `artifact-not-found`.

Only a name that is exactly `connect-run-<run>-<attempt>` counts.

For a bare `fetch:<run>`, the attempt is not known, so list every artifact of the run. A run can hold more than one page of them, so paginate:

```bash
gh api --hostname github.com --paginate "repos/<repo>/actions/runs/<run>/artifacts?per_page=100" --jq '.artifacts[] | {name: .name, expired: .expired}'
```

It prints one JSON object per line, `{name, expired}`, across all pages. Check the call before you read the lines:

- The command fails because `gh` is not logged in: stop with `gh-not-authenticated`.
- The command fails for any other reason (a non-zero exit), or a line is not a JSON object: stop with `artifact-list-failed`. An empty output with a zero exit is an answer; a failed call is not. Never read a failed call as `artifact-not-found`.

Take the names that match `connect-run-<run>-<attempt>` for this run id exactly.

- With a bare `fetch:<run>`, pick the one with the highest attempt. A run with attempts 1 and 2 downloads `connect-run-<run>-2`.
- With `fetch:<run>.<attempt>`, download exactly `connect-run-<run>-<attempt>` with that attempt. Do not pick the highest attempt. A report names the attempt a candidate came from, and a later attempt may not hold it.
- With `fetch:<owner>/<repo>:<run>.<attempt>`, download exactly `connect-run-<run>-<attempt>` with the attempt that step 3 proved, from the named repository's run. There is no other choice.

Then:

- The call succeeded and no name matches: stop with `artifact-not-found`.
- The chosen artifact is expired: stop with `artifact-expired`. The user can tick Rejected in the scheduled run's report, or wait for the candidate to be proposed again.
- If the named attempt has no artifact, stop with `artifact-not-found`, even when another attempt of the run has one. If the named attempt's artifact is expired, stop with `artifact-expired`. Print the fixed reason and its hint only. Never fall back to another attempt and do not suggest one.

### 5. Download into a fresh directory

```bash
mktemp -d
```

Shell state does not persist between tool calls, so write the absolute path it prints (`<DEST>`) into each later command. Then download into it. For a bare word:

```bash
gh run download <run> --repo github.com/marcusrbrown/systematic --name "connect-run-<run>-<attempt>" --dir "<DEST>"
```

For a named word, use the repository step 1 checked:

```bash
gh run download <run> --repo github.com/<repo> --name "connect-run-<run>-<attempt>" --dir "<DEST>"
```

- `gh` fails because it is not logged in or the token cannot read the run: stop with `gh-not-authenticated`.
- Any other failure: stop with `download-failed`.
- Remove `<DEST>` with `rm -rf -- "<DEST>"` on every path that follows, including a stop. The directory is only ever one this step made.

The artifact holds one file, `run.json`, at its root. Do not open it and do not list the directory. The helper reads that one path and nothing else.

### 6. Import

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/connect.mjs" import <<'JSON'
{"directory": "<DEST>", "provenance": {"repo": "<repo>", "runId": "<run>", "commit": "<head commit>"}}
JSON
```

`directory` is the absolute path `mktemp -d` printed. `repo` is `<repo>`: `<repo>` is `marcusrbrown/systematic` for a bare word, and the named repository for a named word. `runId` is the run id from the `fetch:` word, without the attempt. Leave `commit` out when step 2 gave none. For a named word that `head_sha` is the caller's wrapper commit, not the callee's commit of Systematic's workflow. The record carries no attempt, so the request carries none either: the artifact name in step 4 is the only place the attempt is checked.

A named fetch that passed steps 1 to 3 has proven where the run came from. It has not widened what `import` accepts: `import` still checks every project of the record against the allowed checkouts by its own check, and refuses a candidate from a project that is not allowed as `repo-not-allowed`.

If `node` is missing, the helper file is gone, or `import` prints no JSON answer, the helper is unavailable. Remove `<DEST>`, print `helper-unavailable` and its hint, then `Connect failed`. Nothing was imported.

### 7. Report

The helper answers one line of JSON. Read `outcome`:

- `complete`: every candidate in the record was checked against a local checkout and none was refused.
- `degraded`: at least one candidate was refused. The helper's `summary` names each, with its reason, and the file when a file is the cause. Candidates already decided here are skipped and named.
- `busy`: another run holds the lock. Print `reason` and `hint`, then `Connect busy`. Nothing was written. Never run `ledger unlock` on a `busy` answer.
- `failed`: print the `reason`, then each of these fields the answer carries: `detail`, `unmatched` and `configWarnings`. Print them as the helper wrote them; they say what to fix, such as which allow-list entry matched no project or which part of the configuration was ignored. Then print `Connect failed`. Nothing was written, except after `ledger-write-failed`, where the run directory exists and the ledger does not list its candidates.

Print the `summary` as the helper wrote it, unchanged. It holds, under each candidate title, the same promotion lines a local run prints: `candidate:<run record path> candidate-id:<id>` for a lesson, and a `/ce:compound-refresh path:<docs/solutions/...>` line for a contradiction. They are local paths and local ids, so `ce:compound` takes them as they are, from the target project. Never retype, shorten or build one. Print `finalLine` last, with nothing after it.

A rerun of the same fetch writes nothing new and prints the lines for the candidates that are still open.

## Reasons the skill prints

Print the reason as it is, then the hint.

| Reason | Hint |
|---|---|
| `origin-not-allowed` | The named repository is not the origin of any allowed checkout. Nothing was downloaded. Allow-list a checkout of that repository in `connect.allow_projects`, then try again. |
| `repo-ambiguous` | Two or more allowed checkouts have the named repository as their origin. Nothing was downloaded. Remove all but one from the allow list. |
| `provenance-unprovable` | The named run cannot be shown to have called Systematic's `connect.yaml` at a commit on Systematic's default branch: the attempt's `referenced_workflows` is absent, empty or malformed, more than one entry matches, the `sha` is not 40 lowercase hex characters, the commit is not behind or identical to `main`, or an API call failed. Nothing was downloaded. This fails closed: it is a missing proof, not a finding that the run is hostile. To fix it, check that the caller's wrapper calls `marcusrbrown/systematic/.github/workflows/connect.yaml` at a commit on Systematic's `main`, then try again. If an API call failed, try again later. |
| `not-a-connect-run` | The run is not a run of Systematic's `connect.yaml`. For a bare word its top-level path is neither `.github/workflows/connect.yaml` nor `.github/workflows/connect-scheduled.yaml`. For a named word the attempt's `referenced_workflows` names other workflows only. Nothing was downloaded. Name a scheduled run of Systematic's `connect.yaml`, or of a caller that calls it, then try again. |
| `unsupported-run-event` | Only `schedule` and `workflow_dispatch` runs are read. Nothing was downloaded. Name a scheduled or manually dispatched run, then try again. |
| `run-not-found` | No run with that id in the repository, or, for a named word, no such attempt of it. Check the run and attempt in the report's fetch word, then try again. |
| `gh-not-authenticated` | `gh` is not logged in, or its token cannot read this repository's runs. Run `gh auth login` and try again. |
| `artifact-list-failed` | `gh` could not list the run's artifacts, or its answer was not a JSON array. Nothing was downloaded. Try again. |
| `artifact-not-found` | The run has no `connect-run-<run>-<attempt>` artifact for the attempt asked for. It stopped before it made a record. |
| `artifact-expired` | The record was kept for a limited time and is gone. Tick Rejected in the report, or wait for the candidate to be proposed again. |
| `download-failed` | `gh run download` failed for another reason. Nothing was imported. |
| `record-missing`, `record-symlink`, `record-not-regular`, `record-unreadable`, `directory-unreadable` | The downloaded directory does not hold a plain `run.json`. |
| `record-too-large` | The record is over 2 MiB. |
| `record-malformed`, `record-schema-version` | The record is not a version 1 run record. |
| `helper-unavailable` | `node` is missing, the helper file is gone, or `import` printed no JSON answer. Nothing was imported. |
| `invalid-request` | The skill sent a malformed request. |
| `no-allowed-projects` | The allow list is empty or no entry matched a project. |
| `state-root-refused` | The state directory is unsafe. The helper names why. |
| `ledger-unreadable` | The ledger cannot be read and is not replaced. |
| `lock-failed`, `publish-…` | The run could not be written. Nothing was imported. |
| `ledger-write-failed` | The run directory was written and the ledger was not. Run the fetch again. |

A run of `connect-scheduled.yaml`, Systematic's own wrapper, can be fetched only by a skill from a Systematic release that includes this change. An earlier skill refuses that path as `not-a-connect-run`. Earlier runs of `connect.yaml` fetch on any version.

## Reasons a candidate is refused

The helper prints one of these for each refused candidate. The record never supplies the text: it supplies only the candidate's title, which is cleaned of control characters and shortened first.

| Reason | Meaning |
|---|---|
| `project-without-repo` | A project of the candidate had no GitHub remote in the run, so it cannot be matched to a local checkout. |
| `repo-not-allowed` | No allowed local checkout has the recorded repository as its origin. |
| `repo-ambiguous` | Two or more allowed local checkouts have it as their origin. The helper lists their keys; remove one from the allow list or fetch from the project that holds the other. |
| `file-changed` | A cited file differs from the file the run read. The helper names the file. |
| `file-not-tracked`, `file-symlink`, `file-vanished` | A cited file is not tracked locally, is a symlink, or is gone. |
| `path-rejected` | A cited path is absolute, climbs out of the project, holds an unsafe character, or is a source outside `docs/solutions`, `docs/plans` and `docs/brainstorms`. |
| `candidate-id-mismatch`, `rule-id-mismatch` | The record was changed after it was written. |
| `check-failed` | The candidate failed a local check, such as an excerpt that is not in its file. |
| `candidate-malformed`, `duplicate-candidate`, `project-not-in-record`, `project-unreadable` | The candidate or the record is not in the expected shape, or a mapped checkout could not be read. |

A refused candidate is not proof the lesson is wrong. The same lesson is proposed again by a later scheduled run when its evidence still holds.
