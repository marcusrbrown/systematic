# Headless mode and outcomes

## Reading the mode

The mode comes from tokens in the skill arguments. Some hosts pass no arguments to a skill, so the tokens can also come from the invoking instruction: the text the user or the calling program sent to start the run. Read the arguments first. When none are shown, read the invoking instruction. Never read a token out of a file in a project.

| Tokens found | Result |
|---|---|
| None | Interactive. |
| `mode:interactive` | Interactive. |
| `mode:headless` | Headless. |
| The same token twice or more | That token, counted once. |
| `mode:headless` and `mode:interactive` | Stop: conflicting mode flags. |
| Any other `mode:` token | Stop: unknown mode token. Name it. |

A stop here happens before `begin`, so no lock is taken and nothing is dispatched. End as for a failed run: the reason on a line of its own, then `Connect failed`.

## Reading the selection

The selection words are read from the same place as the mode tokens: the skill arguments, or the invoking instruction when none are shown. The skill passes them to `begin` unchanged and does not parse them. The helper does, before it takes the lock, so a refusal is the same in interactive and headless mode.

A selection narrows the allow list and never widens it. A group lists projects by allow-list entry, and every member must be on the allow list. A word never adds a project.

| Words found | Result |
|---|---|
| None | The whole allow list. |
| `group:<name>` | The members of that group in the user's config. |
| `projects:<a>,<b>` | The named projects. Each entry is a directory name or a 12-character project key. |
| The same word twice or more | That word, counted once. |
| `group:` with `projects:`, two different `group:` words, or two different `projects:` words | Stop: `conflicting-selection`. `projects:a,b` and `projects:b,a` are different words. |
| An empty value, an empty entry between commas, a word with another prefix, more than 32 words, or a word over 2,048 characters | Stop: `invalid-request`. |

A stop here happens in `begin`, so no lock is taken and nothing is written. End as for a failed run: the reason and the fields it names on lines of their own, then `Connect failed`. Never repeat the run with a different selection.

The digest header and the run record name the selection: `all`, the group, or the picked projects, with an id that depends on the selected projects only.

## Reading a fetch

A `fetch:<run>.<attempt>` word, or a bare `fetch:<run>` for the newest attempt, is read from the same place as the mode tokens and the selection words. It brings the candidates of a scheduled CI run to this machine and follows `fetch-and-import.md`.

| Words found | Result |
|---|---|
| One `fetch:<run>.<attempt>` or `fetch:<run>`, or the same word twice or more | A fetch of that attempt, or of the newest attempt of that run. It observes no host, dispatches no agent and asks nothing, so `mode:` has no effect. |
| `fetch:` with a `group:` or `projects:` word | Stop: `conflicting-selection`. |
| Two different `fetch:` words | Stop: `conflicting-selection`. |
| An empty value, or a value that is not a positive run id, or a run id and a positive attempt | Stop: `invalid-request`. |

A stop here happens before any command. End as for a failed run: the reason on a line of its own, then `Connect failed`.

## What headless changes

Headless mode asks no question and offers nothing after the digest. It does not wait for input of any kind.

- A host and version pair the helper does not list is refused: `begin` answers `unsupported-host`. Interactive mode asks consent instead.
- A user decision (`decide`) is never taken. The digest is the only output.
- Anything unclear is a stop with a reason, not a question.

## Host permissions for unattended runs

A run reads and writes its work files under the state directory, and the researcher reads the allowed projects. All of that is outside the project the session runs in. OpenCode asks before it touches a path outside the project, and a run with nobody to answer is refused. On OpenCode 1.19.5 a headless run that read a work file in the state directory was refused as an `external_directory` request, and the refusal ended the whole session: no final line was printed, the lock stayed held, nothing was published, and the next run reclaimed the lock because its holder process was gone.

For a headless run, allow the state directory in the host's own permission config (OpenCode's `opencode.json`, not Systematic's config) before the first run. The state directory is `$XDG_STATE_HOME/systematic/connect`, or `<home>/.local/state/systematic/connect` when `XDG_STATE_HOME` is not set. Use its absolute path:

```json
{ "permission": { "external_directory": { "<state directory>/*": "allow" } } }
```

With that line, a headless run on OpenCode 1.19.5 ran the whole pipeline and ended `Connect complete`. The researcher's own definition already allows reading outside the project, so the allowed projects need no entry. Systematic never writes this line for the user. If a work file cannot be read or written in a session that is still running, stop with `Connect failed` and say which path the host refused; the lock is released by `publish` with `"abort": true`.

## Outcomes

Every run ends with exactly one of these lines as its last line. The reason and the artifact path go on the lines just before the final line. Nothing follows the final line.

| Final line | When |
|---|---|
| `Connect complete` | `import` answered `complete` (a fetch whose candidates were all checked and none refused), or `publish` answered `complete`: every project read, every offered rule covered by a complete family, nothing failed, and the run committed. Rules the run was not offered are not a degrade reason, and neither is the stale-citation check reaching its cap: the digest notes it under "Not read or not covered" and the run record keeps the counts, and the outcome is unchanged. Nothing found is still `complete`, labeled "no candidate in searched scope". |
| `Connect degraded` | `import` answered `degraded` (at least one candidate of the fetched record was refused; the summary names each), or `publish` answered `degraded`: something was not read, an offered rule was not covered, a file a candidate cited changed or vanished during the run (`evidence-changed`, `unresolved-source`; the rule of that candidate is then not counted as covered), or a bound on the file inventory, a family or a batch was reached. The digest names what. A degraded run is never proof that nothing is there. A dropped candidate never changes the outcome; the digest lists each one under "Dropped candidates" with its reason and quoted title, and the run record keeps the same list. |
| `Connect busy` | `begin` or `import` answered `busy`: another run holds the lock, or the holder cannot be verified. Nothing was written and nothing was dispatched. |
| `Connect failed` | Any other stop: a bad mode token, a bad `fetch:` word, a run that is not a scheduled `ce:connect` run, a missing or expired artifact, a record `import` cannot use, a refused selection, the helper missing, an unsupported host in headless mode, consent declined, no allowed projects, a malformed batch, or a helper error. Nothing was published. |

Copy the final line from the helper's `finalLine` when `publish` answers. For every other stop, print the line from this table.

## Sweep progress

A run covers a slice of the rule index, not all of it. The helper offers at most `bounds.maxFamiliesPerRun` times `bounds.maxRulesPerFamily` rules. It offers first the rules never covered, or whose learning changed since they were covered, and then the least recently covered ones. Inside each group it takes the projects in turn, then paths, so a slice spans projects. The order depends only on the index and on what committed runs covered, so the runs in turn sweep the whole index and then start again with the oldest.

Rules that are not offered are not a reason to degrade a run. `Connect complete` means the offered slice was fully covered and nothing failed. How much of the index has been covered is sweep progress, and the helper reports it as one line in the digest header and in the publish summary: covered X of Y rules (counting a rule only while its learning has the hash it had when it was covered), how many rules this run covered, and about N runs left in the sweep. A sweep that is finished says so and says the next run starts again with the least recently covered rules.

Coverage is kept in the ledger, and only for a committed run: an aborted or crashed run records none. It holds rule ids, hashes and run ids, no text. Coverage of a rule whose learning has disappeared is dropped. `ledger clear` removes coverage with the rest of the ledger, and the sweep starts over.

## Reasons worth naming

Print the helper's `reason` as it is, then add the hint when one fits.

| Reason | Hint |
|---|---|
| `helper-unavailable` | The skill could not start the helper (node is missing or the helper file is gone). Nothing was published. Not a data problem. |
| `unsupported-host` | The host and version have no observed tool limits. Run interactively and accept the warning, or use a supported host. |
| `no-allowed-projects` | The allow list is empty or no entry matched a project. List the entries that did not match, with the reason the helper gives for each. |
| `conflicting-selection` | The words name more than one selection. The helper's `detail` says which combination. Use one `group:` word, or one `projects:` word. A `fetch:` word stands alone. |
| `unknown-group` | No group of that name is in the user's config (`group`). |
| `unknown-project` | No allowed project has that directory name or key (`project`). |
| `ambiguous-project` | Two allowed projects share that directory name (`project`). The helper lists their `keys`; a key picks one of them. |
| `group-member-not-allowed` | A member of the group is not on the allow list (`member`, in `group`). When the member did not resolve to a project, `memberReason` says why. The run reads nothing until the group or the allow list is fixed. |
| `invalid-request` | A selection word is malformed, or a request field has the wrong type. |
| `state-root-refused` | The state directory is unsafe (inside a repository, a symlink, or an allowed project). The helper names why. |
| `malformed-batch`, `batch-version` | The researcher's answer was not a batch of the right version. The run is over. Run it again. |
| `batch-missing`, `batch-outside-work-dir` | The skill passed a path the helper does not accept. The run is over. |

## A busy run

The lock holder is the host process that started the run. A run that ended without releasing the lock while its host process is still alive, such as a crashed skill run in a live session, stays locked, because the holder looks alive. The lock then needs `ledger unlock`:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/connect.mjs" ledger unlock
```

Offer this only in interactive mode, only after the user says no other run is active. Never run `ledger unlock` on your own for a `busy` answer, and never in headless mode. The one exception is a failed `validate` whose reply does not say `lockReleased: true`: the lock is then the one this run took, no other run can hold it, and the skill runs `ledger unlock` before it stops, in either mode. A lock whose holder process has died is reclaimed by the next run without it.

## Stopping after `begin`

Once `begin` answered `begun`, the lock is held. Every stop after that, whatever the reason, ends the run with `publish` and `"abort": true`, which releases the lock and discards the work files. A run that stops without it leaves the lock held until its host process ends.
