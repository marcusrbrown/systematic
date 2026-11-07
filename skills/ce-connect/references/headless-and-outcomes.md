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

A run reads and writes its work files under the state directory, and the researcher reads the allowed projects. All of that is outside the project the session runs in. OpenCode asks before it touches a path outside the project, and a run with nobody to answer is refused: in a headless run on OpenCode 1.19.5 a read of a path outside the project was auto-rejected as an `external_directory` request. The state directory is in that position, so for a headless run, allow the state directory in the host's own permission config before the first run. The researcher's own definition already allows reading outside the project. If a work file cannot be read or written, stop with `Connect failed` and say which path the host refused; the lock is released by `publish` with `"abort": true`.

## Outcomes

Every run ends with exactly one of these lines as its last line. The reason and the artifact path go on the lines just before the final line. Nothing follows the final line.

| Final line | When |
|---|---|
| `Connect complete` | `publish` answered `complete`: every project read, every rule covered by a complete family, and the run committed. Nothing found is still `complete`, labeled "no candidate in searched scope". |
| `Connect degraded` | `publish` answered `degraded`: something was not read or a bound was reached. The digest names what. A degraded run is never proof that nothing is there. |
| `Connect busy` | `begin` answered `busy`: another run holds the lock, or the holder cannot be verified. Nothing was written and nothing was dispatched. |
| `Connect failed` | Any other stop: a bad mode token, the helper missing, an unsupported host in headless mode, consent declined, no allowed projects, a malformed batch, or a helper error. Nothing was published. |

Copy the final line from the helper's `finalLine` when `publish` answers. For every other stop, print the line from this table.

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
