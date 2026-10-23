---
name: pr-attachments
description: "Use when attaching local screenshots or other images to a pull request, publishing evidence images as commit-pinned embeds in a managed Demo section of the PR description, re-pinning those embeds after a rebase or force-push, or cleaning up evidence images once the PR is done."
argument-hint: "[mode:embed] [image paths...] [pr:<number or branch>]"
metadata:
  harness-portability: neutral-v1
---

# PR Attachments

Publish local images as commit-pinned embeds in a managed `## Demo` section of a pull request description. Confirm that every embed serves an image before the description is written.

The images are committed under `docs/evidence/<topic>/` on the PR head branch and linked by commit SHA. Cleanup removes them from the branch once the PR is done. This skill does not capture screenshots.

| Mode | Trigger | Writes the description |
|---|---|---|
| PR mode | An open PR and image paths | Yes |
| Embed mode | `mode:embed` and image paths | No. Returns a Demo file and a status line |
| Re-pin mode | An open PR and no paths | Only when a pin is stale |
| Cleanup | Offered at the end of PR mode and Re-pin mode | No. Removes the evidence files from the branch |

## Preconditions

- `git`, and `gh` signed in with push access to the head repository.
- The helper needs node 18+ on PATH. Check `node --version` once. Without it, stop.
- Run from the repository root. `git rev-parse --show-prefix` prints nothing there.
- Shell state does not persist between tool calls. Fill every placeholder in angle brackets with a real value in every block.
- Every block that calls the helper starts with the same anchor lines. Reuse them verbatim. Set `SKILL_DIR` to the skill directory stated when this skill loads.

## Never bypass the helper

The helper does the work that must be exact: classification, byte-exact splicing, pin selection, the cleanup set and verification. A helper failure (exit 1 or exit 2) is never permission to hand-write its output.

- If node is missing, cannot launch, or the helper exits 2, stop and report the state reached: what is committed, what is pushed, and that the description is untouched.
- Never write Demo text, a pin, a cleanup set or a verification verdict by hand.
- Never run `git rm` by hand.
- A `usage-error` or `internal-error` is a stop in every mode.

In embed mode every stop ends with the failed status line (Step 8).

## Step 1: Read the arguments

Read tokens from the skill arguments, or from the invoking instruction when none are shown. Some hosts pass no arguments, so the instruction text then carries the tokens. Use no positional placeholders.

Split on whitespace. A path with spaces must be wrapped in double quotes; strip the quotes after splitting. A path that starts with `mode:` or `pr:` must be written with a leading `./`.

- `mode:embed` selects embed mode. Any other `mode:` token stops the run with an error that names the token.
- `pr:<number or branch>` selects the PR. Without it, use the PR for the current branch.
- Every other token is an image path, relative to the repository root.

`mode:embed` with no paths stops: embed mode needs image paths. Use the reason `no-target` in the failed status line.

## Step 2: Classify the images

Skip this step when there are no paths. This step is local and runs before any network call, so a bad batch is caught first.

Read the current branch. It is the topic source:

```bash
git branch --show-current
```

Classify the paths. JSON-escape each string:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/pr-attachments.mjs" classify <<'JSON'
{"paths": ["<image path>"], "branch": "<current branch>"}
JSON
```

A detached HEAD prints no branch. Ask the user for a topic and send `"topic"` in place of `"branch"`. A topic from the user goes through the same slug function and wins over the branch.

Then check which destinations already exist at `HEAD`. Run it once with every `destination` from the result:

```bash
set -- "<destination 1>" "<destination 2>";
for DEST in "$@"; do printf '%s ' "$DEST"; git rev-parse --verify --quiet "HEAD:$DEST" || echo absent; done
```

If any destination exists, run classify again with `"existing"` set to a map of destination to the blob SHA printed here. Copy the SHAs from the output. The second result wins.

Route the result:

- `accepted` (exit 0): `entries` hold `source`, `destination`, `type`, `bytes`, `blob_sha` and `status`, which is `new` or `reused`. Surface every warning: `trailing-data` means bytes after the image end are published as is; `large-file` means the file is over 10 MB and may not render.
- `rejected` (exit 1): the whole batch is rejected and nothing is copied. Relay each rejection `message` as is, for example "SVG is not supported by this skill". Stop.
- `needs-input` (exit 1): read `asks` and settle each with the user, then classify again.
  - `empty-topic`: ask for a topic and send it as `"topic"`.
  - `empty-name`: the source name slugs to nothing. Ask for a copy under a better name. Never move the original.
  - `duplicate-destination`: two inputs map to one name. Ask which one to rename.
  - `destination-conflict`: different bytes already sit at the destination. Ask for another topic or a rename.
- `usage-error` (exit 2) or `internal-error`: stop.

## Step 3: Resolve the target and pick the mode

Pick the mode from the tokens and whether an open PR exists:

| Tokens | Open PR | Mode |
|---|---|---|
| `mode:embed` and paths | Not needed | Embed mode |
| Paths, no `mode:embed` | Yes | PR mode |
| No paths, no `mode:embed` | Yes | Re-pin mode |
| No `mode:embed` | No | Stop |

A load that sees no `mode:embed` token and finds no open PR stops with this message and never guesses a mode: open the PR first, or run through git-commit-push-pr. Never infer paths or a mode from the working directory.

### Embed mode

Resolve the head from the upstream of the current branch:

```bash
git rev-parse --abbrev-ref "@{u}"
git remote -v
```

The upstream prints `<remote>/<branch>`. With no upstream, stop. The remote is the text before the first `/` and must be listed by `git remote -v`. The head branch is the rest. Read owner and repo from that remote's URL. The URL host must be `github.com`; any other host is refused. Step 4 then runs `gh repo view` on that repository.

### PR mode and Re-pin mode

```bash
gh pr view "<PR>" --json number,url,state,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,isCrossRepository
```

Omit the PR argument when no `pr:` token was given.

- The command fails, or `state` is not `OPEN`: there is no open PR. Stop with the message above.
- A null `headRepository` (a deleted fork) is refused: stop.
- The head repo is `headRepositoryOwner.login` and `headRepository.name`.
- The remote is the one in `git remote -v` whose URL is `github.com` and this repo, compared without case. If none maps, stop and name the remote to add. If several map, use `origin`, else ask.
- Another host is refused. Fork PRs need push access, which Step 4 checks.

The PR head must be checked out and level. Fetch, then compare:

```bash
git fetch "<remote>" "<head branch>"
git branch --show-current
git rev-parse HEAD
```

The current branch must equal `headRefName` and `HEAD` must equal `headRefOid`. On any difference, stop with the exact fix. If `git merge-base --is-ancestor "<headRefOid>" HEAD` succeeds, local is ahead: say push first. Otherwise say to check out the PR head and update it to `headRefOid`.

## Step 4: Check visibility

Applies to embed mode, PR mode and Re-pin mode.

```bash
gh repo view "<owner>/<repo>" --json visibility,isPrivate,viewerPermission,url
```

Proceed only when all of these hold:

- `visibility` is `PUBLIC` and `isPrivate` is false.
- `url` starts with `https://github.com/`.
- `viewerPermission` is `ADMIN`, `MAINTAIN` or `WRITE`. Otherwise stop: the user cannot push to the head repository. A rejected push stops the run too.

A private, internal or unknown-visibility repository stops the run. Offer skip only: nothing is published and the images stay local. This version publishes to public repositories only. Name the repository in the message. In embed mode the reason is `not-public`.

## Step 5: List the set and confirm the scrub

PR mode and embed mode only.

List for the user:

- the topic slug, for confirmation;
- each source, its destination, type and size, and whether it is `new` or `reused`;
- every warning from Step 2.

In embed mode the push also publishes local commits that are not on the remote yet. List them:

```bash
git log --oneline "@{u}..HEAD"
```

Then run the scrub confirmation. Ask the user, and wait for the answer:

> These images will be published to a public GitHub repository. Open each one. Confirm that its visible content shows no secrets, tokens, credentials, personal data or private URLs.

The scrub confirmation covers visible content only. Metadata inside an image (EXIF, text chunks, trailing bytes) is not stripped and is published as is.

Require an explicit yes. There is no default answer. Never infer consent from the original request. On anything else, stop and publish nothing. In embed mode the reason is `declined`.

## Step 6: Publish the evidence commit

PR mode and embed mode only. If every entry is `reused`, skip the copy and the commit and go to the push.

### Copy into place

Check every destination, new and reused:

```bash
set -- "<destination 1>" "<destination 2>";
for DEST in "$@"; do git check-ignore -- "$DEST"; git check-attr filter -- "$DEST" | grep -v ': unspecified$'; git status --porcelain --untracked-files=all -- "$DEST"; done
```

Any output stops the run:

- `git check-ignore` printed the path: the destination is gitignored, so stop and never force-add.
- `git check-attr` printed a filter: an LFS or other filter applies. Stop.
- `git status` printed a line: the destination holds uncommitted content. Stop.

Copy each new entry. The copy leaves the original in place:

```bash
SRC="<source path>";
DEST="<destination path>";
mkdir -p "$(dirname "$DEST")"
cp -- "$SRC" "$DEST"
```

### Commit by pathspec

Stage and commit only the new destinations. A pathspec commit leaves other staged work out of the commit. Never pass `--no-verify`; a failing hook stops the run.

```bash
TOPIC="<topic slug>";
set -- "<destination 1>" "<destination 2>";
git add -- "$@"
git commit -m "chore(evidence): add screenshots for $TOPIC" -- "$@"
```

### Assert the committed file set

The commit must hold exactly the new destinations:

```bash
set -- "<destination 1>" "<destination 2>";
EXPECTED="$(printf '%s\n' "$@" | LC_ALL=C sort)"
ACTUAL="$(git diff-tree --no-commit-id --name-only -r --no-renames HEAD | LC_ALL=C sort)"
test "$ACTUAL" = "$EXPECTED"
```

Exit 0 passes. On a mismatch, stop. Do not push. Tell the user the commit holds files outside the list, and leave it as it is until they decide.

### Push with an explicit refspec

`REMOTE` is the remote from Step 3. `BRANCH` is `headRefName`, or the upstream branch in embed mode.

```bash
REMOTE="<remote>";
BRANCH="<head branch>";
git push "$REMOTE" "HEAD:refs/heads/$BRANCH"
```

If the push is rejected, stop and report. Never force-push and never retry with another refspec. A non-fast-forward rejection means the branch moved. Tell the user to fetch and rebase or merge, then re-run. The remote is unchanged. A re-run reuses evidence that is already committed, because reuse is keyed on the destination and the blob SHA. In embed mode the reason is `push-rejected`.

## Step 7: Verify the embeds

Verification runs in every mode, before the description is written or the Demo file is returned.

Make the temp files. Each is created with mode 0600. Note the three paths:

```bash
for NAME in demo backup new-body; do printf '%s %s\n' "$NAME" "$(mktemp)"; done
```

Build the Demo text from the pins git reports. Never retype or transcribe a SHA by hand. The block prints the evidence commit SHA, which is the newest commit that added or changed any of these files:

```bash
DEMO_FILE="<demo file>";
OWNER_REPO="<owner/repo of the head repository>";
set -- "<destination 1>" "<destination 2>";
printf '## Demo\n' > "$DEMO_FILE"
for DEST in "$@"; do PIN="$(git log -n 1 --no-renames --diff-filter=AM --format=%H HEAD -- "$DEST")"; printf '\n![%s](https://raw.githubusercontent.com/%s/%s/%s)\n' "$(basename "${DEST%.*}")" "$OWNER_REPO" "$PIN" "$DEST" >> "$DEMO_FILE"; done
git log -n 1 --no-renames --diff-filter=AM --format=%H HEAD -- "$@"
```

List the URLs to verify, from the file that is about to be written:

```bash
FILE="<Demo file, or the new body file in Re-pin mode>";
OWNER_REPO="<owner/repo of the head repository>";
grep -Eo "https://raw\.githubusercontent\.com/$OWNER_REPO/[0-9a-f]{40}/docs/evidence/[a-z0-9._/-]+" "$FILE" | sort -u
```

Copy the printed URLs into the call. Use at most 50 per call and at most 90 for `max_wait_s`, so a call fits a host timeout:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/pr-attachments.mjs" verify <<'JSON'
{"head_repo": "<owner/repo>", "urls": ["<raw URL 1>", "<raw URL 2>"], "max_wait_s": 90, "waited_s": 0}
JSON
```

Route the result:

- `verified` (exit 0): every embed serves an image. Continue.
- `failed` (exit 1): read `failed`. Report each failing URL with its `status` and `http_status`. If the top-level `retryable` is true, call again with the same URLs and `waited_s` set to the sum of the `waited_s` values of the earlier reports. Stop once `retryable` is false.
- `usage-error` (exit 2) with `blob-url`: a blob-form URL is not verified here. Stop.
- Any other `usage-error`: stop.

Never print or paste a response body, and never fetch one yourself.

Never write the description, and never return the Demo file, when verification fails. The evidence commit is pushed and unreferenced. In PR mode say: the evidence commit is pushed, the description is not written, and a re-run retries and reuses the pushed commit. In embed mode the reason is `verify-failed`.

## Step 8: Write the description or return the Demo file

### PR mode

Back up the description, then splice the Demo file into a copy of it. The backup is the helper input: JSON whose `body` field holds the original description. Tell the user the backup path now.

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
PR="<PR number>";
BACKUP="<backup file>";
gh pr view "$PR" --json body --jq '{body: .body, demo_file: "<demo file>", out_file: "<new body file>"}' > "$BACKUP"
node "$SKILL_DIR/scripts/pr-attachments.mjs" splice < "$BACKUP"
```

Route the result:

- `spliced` (exit 0): read `action`. `appended` and `replaced` continue. On `replaced`, tell the user the old Demo section is replaced and the backup holds it. On `unchanged`, the description already holds this Demo text: write nothing and go to Cleanup.
- `needs-input` (exit 1): read `asks` and stop. Write nothing.
  - `multiple-demo-sections`: the description has more than one `## Demo` section. Ask the user which to keep.
  - `unterminated-region`: an unclosed code fence or comment would swallow the section. Ask the user to close it.
  - `line-ending-conflict`: the Demo text and the description use different line endings at the join. Ask the user.
- `write-failed` (exit 1): the output file could not be written. Stop.
- `usage-error` (exit 2): stop.

If `screenshots_present` is true, warn the user: the description has a `## Screenshots` section, which is left alone. Nothing is merged into it.

Re-read the description immediately before writing, and write only if it is unchanged since the backup. A changed description stops the run with nothing written; re-run to start from the new text. Write with a body file, never an inline body:

```bash
PR="<PR number>";
BACKUP="<backup file>";
NEW_BODY="<new body file>";
RECHECK="$(mktemp)"
gh pr view "$PR" --json body --jq '{body: .body, demo_file: "<demo file>", out_file: "<new body file>"}' > "$RECHECK"
cmp -s "$BACKUP" "$RECHECK" && gh pr edit "$PR" --body-file "$NEW_BODY"
```

Re-read it afterwards and compare it with the body file. This holds the regions outside Demo to the same bytes too:

```bash
PR="<PR number>";
NEW_BODY="<new body file>";
POST="$(mktemp)"
gh pr view "$PR" --json body --jq .body > "$POST"
{ cat "$NEW_BODY"; printf '\n'; } | cmp -s - "$POST"
```

Exit 0 passes. Then delete the temp files with `rm -f` and go to Cleanup.

On a mismatch, warn the user and print the backup path. Never auto-restore: a restore could overwrite a concurrent edit. Keep the backup until the re-read passes.

### Embed mode

Embed mode returns the Demo file from Step 7, made with mktemp (mode 0600), and prints one status line. Embed mode never edits the pull request. The caller splices the file and deletes it. Embed mode ends here, with no cleanup offer. The caller prints the cleanup command after the PR opens.

```text
pr-attachments: status=ok evidence_sha=<40-hex> demo_file=<path> images=<count>
pr-attachments: status=failed evidence=<pushed|none> reason=<reason>
```

- `evidence_sha` is the SHA the Step 7 Demo block printed. Copy it.
- `evidence` is `pushed` once the push succeeded, otherwise `none`. A failed line never comes with a Demo file.
- `reason` is one of `node-unavailable`, `helper-failed`, `rejected-images`, `declined`, `not-public`, `no-target`, `git-failed`, `push-rejected` or `verify-failed`.

## Re-pin mode

An open PR and no paths. It re-points the embeds after a rebase or force-push. On a fresh PR it changes nothing.

After a rebase or force-push, re-run this skill with no paths. Steps 3 and 4 apply. `HEAD` must equal `headRefOid`; if it does not, say push first.

### Read the managed URLs

Read them from the description. Other URLs are ignored; report how many.

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
PR="<PR number>";
BACKUP="<backup file>";
gh pr view "$PR" --json body --jq '{body: .body, head_repo: "<owner/repo>"}' > "$BACKUP"
node "$SKILL_DIR/scripts/pr-attachments.mjs" urls < "$BACKUP"
```

With no managed URL, report that there is nothing to re-pin and go to Cleanup. A `blob` form means a private-repository embed, which this skill does not handle: stop.

### Pick the pins

Ask git for the newest commit of each managed path. Send the `urls` array unchanged:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/pr-attachments.mjs" pins <<'JSON'
{"head_ref_oid": "<headRefOid>", "urls": [<the urls array from the previous report>]}
JSON
```

- `already-valid` (exit 0): report already valid. Write nothing. Go to Cleanup.
- `repin-needed` (exit 0): continue with the `pins` map.
- `partial` (exit 1): report partial and name `unresolved_paths`. Write nothing. Stop.
- `unresolved` (exit 1): no managed path ever existed on the head. Stop and point to PR mode: re-run with image paths.
- `head-not-found` (exit 1): the head commit is not in this repository. Stop and say fetch or push first.
- `git-failed` or `git-timeout` (exit 1): report `reached`. Stop.

### Rewrite the stale pins

Rewrite only the 40-hex segment of the stale URLs. Send the `pins` map unchanged:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
PR="<PR number>";
BACKUP="<backup file>";
gh pr view "$PR" --json body --jq '{body: .body, head_repo: "<owner/repo>", pins: {<the pins map from the previous report>}, out_file: "<new body file>"}' > "$BACKUP"
node "$SKILL_DIR/scripts/pr-attachments.mjs" repin-rewrite < "$BACKUP"
```

- `repinned` (exit 0): report `rewritten`, `ignored` and `unmapped_paths`. A non-empty `unmapped_paths` means the description changed since the first read: stop and re-run.
- `write-failed` (exit 1): stop.
- `usage-error` (exit 2): stop.

### Verify and write

Verify the URLs of the rewritten file with Step 7. Take the list from the new body file.

Then do the write step of Step 8 with the new body file and this backup. Tell the user the backup path first. Then go to Cleanup.

## Cleanup

Offered only once a PR exists, at the end of PR mode and Re-pin mode. Embed mode never offers it. Recommended before merge: it removes the evidence files the PR added from the head branch. The embeds keep working, because they point at the pinned commit.

Cleanup works with no Demo section, because the set comes from git and not from the description. Never run `git rm` by hand, including when the helper cannot run, and never fall back to a manual removal.

Fetch the base first. `BASE_REMOTE` is the remote that maps to the repository in the PR URL. If none maps, stop.

```bash
BASE_REMOTE="<remote that maps to the base repository>";
BASE_BRANCH="<baseRefName>";
git fetch "$BASE_REMOTE" "+refs/heads/$BASE_BRANCH:refs/remotes/$BASE_REMOTE/$BASE_BRANCH"
```

Compute the set. `head_ref_oid` is `headRefOid`, or local `HEAD` after a push in this run:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/pr-attachments.mjs" cleanup-set <<'JSON'
{"head_ref_oid": "<headRefOid>", "base_ref_name": "<baseRefName>", "remote": "<base remote>"}
JSON
```

Route the result:

- `empty` (exit 0): report cleanup already done. Stop.
- `set` (exit 0): list `paths` and `count`, and say cleanup is recommended before merge. Read the merge methods:

```bash
gh repo view "<owner>/<repo>" --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
```

  If `mergeCommitAllowed` or `rebaseMergeAllowed` is true, add one line: the images stay in default-branch history unless the PR is squash-merged. Always add this disclosure verbatim: Cleanup does not revoke access, so any published secret must be rotated.

  Then ask whether to remove the files, and wait for an explicit yes. On anything else, stop and leave the files.
- `base-not-found`, `no-merge-base`, `head-not-found` (exit 1): stop. Report the state. Fetch the base or push first.
- `git-failed` or `git-timeout` (exit 1): stop. Report `reached`.
- `usage-error` (exit 2): stop.

After the yes, call again with the `digest` from the `set` result. The helper recomputes the set and stages the removals; it commits nothing:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/pr-attachments.mjs" cleanup-set <<'JSON'
{"head_ref_oid": "<headRefOid>", "base_ref_name": "<baseRefName>", "remote": "<base remote>", "remove_digest": "<digest>"}
JSON
```

- `removed` (exit 0): the removals are staged. Commit them.
- `digest-mismatch` (exit 1): the set changed since the yes, so show the new set and ask again for an explicit yes. Nothing was removed.
- `head-not-checked-out` (exit 1): check out the PR head first. Stop.
- `git-failed` with step `remove`: `git rm` refuses a locally modified file and is never forced. Report it and stop.
- Any other result: as above.

Commit the removals by pathspec, using the `paths` from the result. The slug is the directory under `docs/evidence/`:

```bash
TOPIC="<topic slug>";
set -- "<path 1>" "<path 2>";
git commit -m "chore(evidence): remove screenshots for $TOPIC" -- "$@"
```

Then run the file-set assertion from Assert the committed file set, with these paths as the expected set. Then run the push from Push with an explicit refspec. A rejection stops the run as it does there.

## Disclosures

- Evidence binaries appear in the Files tab of the PR until cleanup.
- Published images stay in git history, forks and caches. Cleanup removes files from the branch. It does not revoke access.
- Verification confirms the raw URL serves an image. It does not confirm GitHub renders it. Files over about 10 MB may not render.
- A commit-pinned link survived cleanup, squash merge and branch deletion on one observed PR. That is observed, not guaranteed. A re-run re-verifies.
- A rebase or force-push needs a re-run with no paths.
