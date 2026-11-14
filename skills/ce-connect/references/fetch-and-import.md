# Fetch and import

`fetch:<run>.<attempt>` brings the candidates of one attempt of a scheduled CI run to this machine, so a lesson the runner found can be promoted here after the runner is gone. A bare `fetch:<run>` does the same for the newest attempt of that run. In every command below, `<run>` and `<attempt>` are the numbers `SKILL.md` already checked: positive integers, nothing else. The skill does the part that needs the network, with the user's own `gh`. The helper's `import` operation does the rest and never touches the network.

A fetch dispatches no agent, asks nothing and takes no host observation. It uses neither `begin` nor `publish`. It ends with the `finalLine` that `import` answers, or with `Connect failed` for a stop before `import`.

The repository is fixed: `marcusrbrown/systematic`. Never take a repository, a path or a workflow name from the user's words or from a downloaded file.

## Order

Do these in order. Start every block that runs a command with the same anchor lines as the other steps, with `SKILL_DIR` set to the skill directory stated when this skill loads.

### 1. Check the run, before any download

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
gh api "repos/marcusrbrown/systematic/actions/runs/<run>" --jq '[.path, .event, .head_sha] | @tsv'
```

`gh run view --json` has no workflow path, so the API call is the check. It prints three tab-separated values: the workflow path, the event and the head commit.

- The path must be `.github/workflows/connect.yaml`. Drop a trailing `@<ref>` before comparing. Any other path: stop with `not-a-connect-run`.
- The event must be `schedule` or `workflow_dispatch`. Any other event: stop with `unsupported-run-event`. A run triggered by a pull request is never read, whatever its artifacts hold.
- The command fails with a 404: stop with `run-not-found`. It fails because `gh` is not logged in: stop with `gh-not-authenticated`.
- Keep the head commit for the request below. It must be 40 or 64 lowercase hex characters; otherwise leave `commit` out.

### 2. Choose the artifact

```bash
gh api "repos/marcusrbrown/systematic/actions/runs/<run>/artifacts?per_page=100" --jq '[.artifacts[] | {name: .name, expired: .expired}]'
```

It prints one JSON array of `{name, expired}` objects. Check the call before you read the array:

- The command fails because `gh` is not logged in: stop with `gh-not-authenticated`.
- The command fails for any other reason (a non-zero exit), or its output is not a JSON array: stop with `artifact-list-failed`. An empty array is an answer; a failed call is not. Never read a failed call as `artifact-not-found`.

The record is in an artifact named `connect-run-<run>-<attempt>`, where `<attempt>` is digits only. Take the names that match that pattern for this run id exactly.

- With a bare `fetch:<run>`, pick the one with the highest attempt. A run with attempts 1 and 2 downloads `connect-run-<run>-2`.
- With `fetch:<run>.<attempt>`, download exactly `connect-run-<run>-<attempt>` with that attempt. Do not pick the highest attempt. A report names the attempt a candidate came from, and a later attempt may not hold it.

Then:

- The call succeeded and no name matches: stop with `artifact-not-found`.
- The chosen artifact is expired: stop with `artifact-expired`. The user can tick Rejected in the scheduled run's report, or wait for the candidate to be proposed again.
- If the named attempt has no artifact, stop with `artifact-not-found`, even when another attempt of the run has one. If the named attempt's artifact is expired, stop with `artifact-expired`. Print the fixed reason and its hint only. Never fall back to another attempt and do not suggest one.

### 3. Download into a fresh directory

```bash
mktemp -d
```

Shell state does not persist between tool calls, so write the absolute path it prints (`<DEST>`) into each later command. Then download into it:

```bash
gh run download <run> --repo marcusrbrown/systematic --name "connect-run-<run>-<attempt>" --dir "<DEST>"
```

- `gh` fails because it is not logged in or the token cannot read the run: stop with `gh-not-authenticated`.
- Any other failure: stop with `download-failed`.
- Remove `<DEST>` with `rm -rf -- "<DEST>"` on every path that follows, including a stop. The directory is only ever one this step made.

The artifact holds one file, `run.json`, at its root. Do not open it and do not list the directory. The helper reads that one path and nothing else.

### 4. Import

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/connect.mjs" import <<'JSON'
{"directory": "<DEST>", "provenance": {"repo": "marcusrbrown/systematic", "runId": "<run>", "commit": "<head commit>"}}
JSON
```

`directory` is the absolute path `mktemp -d` printed. `runId` is the run id from the `fetch:` word, without the attempt. Leave `commit` out when step 1 gave none. The record carries no attempt, so the request carries none either: the artifact name in step 2 is the only place the attempt is checked.

If `node` is missing, the helper file is gone, or `import` prints no JSON answer, the helper is unavailable. Remove `<DEST>`, print `helper-unavailable` and its hint, then `Connect failed`. Nothing was imported.

### 5. Report

The helper answers one line of JSON. Read `outcome`:

- `complete`: every candidate in the record was checked against a local checkout and none was refused.
- `degraded`: at least one candidate was refused. The helper's `summary` names each, with its reason, and the file when a file is the cause. Candidates already decided here are skipped and named.
- `busy`: another run holds the lock. Print `reason` and `hint`, then `Connect busy`. Nothing was written. Never run `ledger unlock` on a `busy` answer.
- `failed`: print the `reason`, then each of these fields the answer carries: `detail`, `unmatched` and `configWarnings`. Print them as the helper wrote them; they say what to fix, such as which allow-list entry matched no project or which part of the configuration was ignored. Then print `Connect failed`. Nothing was written, except after `ledger-write-failed`, where the run directory exists and the ledger does not list its candidates.

Print the `summary` as the helper wrote it, unchanged. It holds, under each candidate title, the same promotion lines a local run prints: `candidate:<run record path> candidate-id:<id>` for a lesson, and a `/systematic:ce-compound-refresh path:<docs/solutions/...>` line for a contradiction. They are local paths and local ids, so `systematic:ce-compound` takes them as they are, from the target project. Never retype, shorten or build one. Print `finalLine` last, with nothing after it.

A rerun of the same fetch writes nothing new and prints the lines for the candidates that are still open.

## Reasons the skill prints

Print the reason as it is, then the hint.

| Reason | Hint |
|---|---|
| `not-a-connect-run` | The run is not a run of `.github/workflows/connect.yaml`. Nothing was downloaded. |
| `unsupported-run-event` | Only `schedule` and `workflow_dispatch` runs are read. Nothing was downloaded. |
| `run-not-found` | No run with that id in `marcusrbrown/systematic`. |
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
