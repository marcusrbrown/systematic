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
| `Connect complete` | `publish` answered `complete`: every project read, every offered rule covered by a complete family, nothing failed, and the run committed. Rules the run was not offered are not a degrade reason. Nothing found is still `complete`, labeled "no candidate in searched scope". |
| `Connect degraded` | `publish` answered `degraded`: something was not read, an offered rule was not covered, or a bound was reached. The digest names what. A degraded run is never proof that nothing is there. |
| `Connect busy` | `begin` answered `busy`: another run holds the lock, or the holder cannot be verified. Nothing was written and nothing was dispatched. |
| `Connect failed` | Any other stop: a bad mode token, the helper missing, an unsupported host in headless mode, consent declined, no allowed projects, a malformed batch, or a helper error. Nothing was published. |

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

Offer this only in interactive mode, only after the user says no other run is active. Never run `ledger unlock` on your own, and never in headless mode. A lock whose holder process has died is reclaimed by the next run without it.

## Stopping after `begin`

Once `begin` answered `begun`, the lock is held. Every stop after that, whatever the reason, ends the run with `publish` and `"abort": true`, which releases the lock and discards the work files. A run that stops without it leaves the lock held until its host process ends.
