---
name: pr-attachments
description: "Use when attaching local screenshots or other images to a pull request, publishing evidence images as commit-pinned embeds in a managed Demo section of the PR description, re-pinning those embeds after a rebase or force-push, or cleaning up evidence images once the PR is done."
argument-hint: "[mode:embed] [image paths...] [pr:<number or branch>] | mode:carry old=<old body file> new=<new body file>"
metadata:
  harness-portability: neutral-v1
---

# PR Attachments

Publish local images as commit-pinned embeds in a managed `## Demo` section of a pull request description. Confirm that every embed serves an image before the description is written.

The images are committed under `docs/evidence/<topic>/` on the PR head branch and linked by commit SHA. Cleanup removes them from the branch once the PR is done. This skill does not capture screenshots.

The managed section starts at a `## Demo` heading at column 0. A `## Demo` line that is indented, or that sits inside a code fence, a quote, a comment or a `<pre>`, `<script>`, `<style>` or `<textarea>` block, is text and not the section. The helper never replaces or copies it, and it never removes a line outside the section.

The helper replaces or copies an existing Demo section only when every non-blank line under its heading is one this skill writes: an image embed (`![<file stem>](<url>)`) in the raw or the blob form. A heading, a fence, HTML, a table or free prose under the heading means the section is not the managed one, or its end was misjudged. The helper then changes nothing and reports `unexpected-section-content`.

| Mode | Trigger | Writes the description |
|---|---|---|
| PR mode | An open PR and image paths | Yes |
| Embed mode | `mode:embed` and image paths | No. Returns a Demo file and a status line |
| Carry mode | `mode:carry`, `old=` and `new=` | No. Edits the new body file in place and returns a status line |
| Re-pin mode | An open PR and no paths | Only when a pin is stale |
| Cleanup | Offered at the end of PR mode and Re-pin mode | No. Removes the evidence files from the branch |

## Preconditions

- `git`, and `gh` signed in with push access to the head repository.
- The helper needs node 18+ on PATH. Check `node --version` once. Without it, stop.
- Carry mode needs only node. The other modes also need the repository root: `git rev-parse --show-prefix` prints nothing there.
- Run from the repository root.
- Shell state does not persist between tool calls. Fill every placeholder in angle brackets with a real value in every block.
- Every block that calls the helper starts with the same anchor lines. Reuse them verbatim. Set `SKILL_DIR` to the skill directory stated when this skill loads.

## Never bypass the helper

The helper does the work that must be exact: classification, byte-exact splicing, pin selection, the cleanup set and verification. A helper failure (exit 1 or exit 2) is never permission to hand-write its output.

- If node is missing, cannot launch, or the helper exits 2, stop and report the state reached: what is committed, what is pushed, and that the description is untouched. In embed mode the reason is `node-unavailable` when node is missing or cannot launch.
- Never write Demo text, a pin, a cleanup set or a verification verdict by hand.
- Never run `git rm` by hand.
- A `usage-error` or `internal-error` is a stop in every mode. Report its `error`, and its `field` when it has one: `field` names the input field that failed. In embed mode the reason is `helper-failed`.
- Any other `git` or `gh` command that fails is a stop too. In embed mode the reason is `git-failed`.

In embed mode every stop ends with the failed status line (Step 8), and its reason comes from the table there. In carry mode every stop ends with the failed status line (Carry mode).

## Step 1: Read the arguments

Read tokens from the skill arguments, or from the invoking instruction when none are shown. Some hosts pass no arguments, so the instruction text then carries the tokens. Use no positional placeholders.

Split on whitespace. A path with spaces must be wrapped in double quotes; strip the quotes after splitting. A path that starts with `mode:`, `pr:`, `old=` or `new=` must be written with a leading `./`.

- `mode:embed` selects embed mode.
- `mode:carry` selects carry mode and skips Steps 2 to 8; go straight to Carry mode.
- Any other `mode:` token stops the run with an error that names the token. Two different `mode:` values stop the run too. The same `mode:` token twice counts as one token.
- `pr:<number or branch>` selects the PR. Without it, use the PR for the current branch.
- `old=<file>` and `new=<file>` are for carry mode only. An `old=` or `new=` token outside carry mode stops the run with a message that names the token. It is never read as an image path. In embed mode the reason is `bad-arguments`.
- Every other token is an image path, relative to the repository root.

`mode:embed` with no paths stops: embed mode needs image paths. In embed mode the reason is `no-target`.

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

If any destination exists, run classify again with `"existing"` set to a map of destination to the blob SHA printed here. Include only destinations whose line printed a 40-hex SHA, and omit the `absent` ones. Copy the SHAs from the output. The second result wins.

Route the result:

- `accepted` (exit 0): `entries` hold `source`, `destination`, `type`, `bytes`, `blob_sha` and `status`, which is `new` or `reused`. Surface every warning: `trailing-data` means bytes after the image end are published as is.
- `rejected` (exit 1): the whole batch is rejected and nothing is copied. Relay each rejection `message` as is, for example "SVG is not supported by this skill". A file over 10 MiB is rejected before anything is published, because GitHub does not serve larger files as images; its code is `too-large`. Stop. In embed mode the reason is `rejected-images`.
- `needs-input` (exit 1): read `asks` and settle each with the user, then classify again. If the user cannot or will not settle one, stop. In embed mode the reason is `needs-input`.
  - `empty-topic`: ask for a topic and send it as `"topic"`.
  - `empty-name`: the source name slugs to nothing. Ask for a copy under a better name. Never move the original.
  - `duplicate-destination`: two inputs map to one name. Ask which one to rename.
  - `destination-conflict`: different bytes already sit at the destination. Ask for another topic or a rename.
- `usage-error` (exit 2) or `internal-error`: stop. In embed mode the reason is `helper-failed`.

## Step 3: Resolve the target and pick the mode

Pick the mode from the tokens and whether an open PR exists:

| Tokens | Open PR | Mode |
|---|---|---|
| `mode:carry`, `old=` and `new=` | Not needed | Carry mode |
| `mode:embed` and paths | Not needed | Embed mode |
| Paths, no `mode:embed` | Yes | PR mode |
| No paths, no `mode:embed` | Yes | Re-pin mode |
| No `mode:` token | No | Stop |

A load that sees no `mode:` token and finds no open PR stops with this message and never guesses a mode: open the PR first, or run through git-commit-push-pr. Never infer paths or a mode from the working directory.

### Embed mode

Resolve the head from the upstream of the current branch:

```bash
git rev-parse --abbrev-ref "@{u}"
git remote -v
```

The upstream prints `<remote>/<branch>`. With no upstream, stop. The remote is the text before the first `/` and must be listed by `git remote -v`. The head branch is the rest. Read owner and repo from that remote's URL. The URL host must be `github.com`; any other host is refused. Step 4 then runs `gh repo view` on that repository. In embed mode the reason for a missing upstream, an unlisted remote or a refused host is `no-target`.

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
gh repo view "<owner>/<repo>" --json visibility,isPrivate,viewerPermission,url,defaultBranchRef
```

Every repository must pass these checks:

- `url` starts with `https://github.com/`.
- `viewerPermission` is `ADMIN`, `MAINTAIN` or `WRITE`. Otherwise stop: the user cannot push to the head repository. A rejected push stops the run too. In embed mode the reason is `no-push-access`.
- In embed mode and PR mode, a push target equal to the default branch is refused: stop. The push target is the upstream branch in embed mode and `headRefName` in PR mode, and the default branch is `defaultBranchRef`. Pushing there would send the evidence commit, and any local commits that are not on the remote yet, straight to the default branch. Tell the user to create a feature branch and set its upstream, then run again. In embed mode the reason is `default-branch`. Re-pin mode does not push, so it skips this check. Cleanup applies it before its own push.

Then pick the link form from the visibility:

- `visibility` is `PUBLIC` and `isPrivate` is false: the repository is public, so use the raw form and go on.
- Anything else is a private, internal or unknown-visibility repository. Use the blob form, after the explicit answer below.

If `gh repo view` fails, stop. Remember the form for Steps 5 to 8. Re-pin mode takes it from the embeds that already exist.

### Private, internal and unknown-visibility repositories

PR mode and embed mode only. Re-pin mode publishes nothing, so it asks nothing and goes straight on.

Private repositories use the blob form because raw links do not render for signed-in members. Proceeding emits the blob form for every embed, and only the blob form.

Before anything is published, ask the user and wait for the answer. Name the repository:

> `<owner>/<repo>` is not public. The images stay in the repository's history. If the repository is later made public, or is forked, the images become public. Cleanup removes them from the branch but not from history. Publish them here?

Require an explicit answer. There is no default answer. Never infer consent from the original request. Only an explicit yes proceeds. On anything else the user declines: nothing is published and the images stay local. In embed mode finish with this line, and no Demo file:

```text
pr-attachments: status=failed evidence=none reason=declined
```

## Step 5: List the set and confirm the scrub

PR mode and embed mode only.

List for the user:

- the topic slug, for confirmation;
- each source, its destination, type, size and `blob_sha`, and whether it is `new` or `reused`;
- every warning from Step 2.

In embed mode the push also publishes local commits that are not on the remote yet. List them:

```bash
git log --oneline "@{u}..HEAD"
```

Then run the scrub confirmation. Ask the user, and wait for the answer:

> These images will be published to a public GitHub repository. Open each one. Confirm that its visible content shows no secrets, tokens, credentials, personal data or private URLs.

For a private, internal or unknown-visibility repository, say "a private GitHub repository" instead of "a public GitHub repository".

The scrub confirmation covers visible content only. Metadata inside an image (EXIF, text chunks, trailing bytes) is not stripped and is published as is.

Require an explicit yes. There is no default answer. Never infer consent from the original request. On anything else, stop and publish nothing. In embed mode the reason is `declined`.

## Step 6: Publish the evidence commit

PR mode and embed mode only. If every entry is `reused`, skip the copy and the commit and go to the push.

### Copy into place

Check every destination, new and reused:

```bash
set -- "<destination 1>" "<destination 2>";
for DEST in "$@"; do git check-ignore -- "$DEST"; git check-attr text eol filter -- "$DEST" | grep -Ev ': (text: (unspecified|unset|auto)|eol: unspecified|filter: unspecified)$'; git status --porcelain --untracked-files=all -- "$DEST"; done
```

Any output stops the run. In embed mode the reason is `destination-blocked`:

- `git check-ignore` printed the path: the destination is gitignored, so stop and never force-add.
- `git check-attr` printed a line: a git attribute would rewrite the bytes when they are staged. A `filter` (LFS or another) does, and so does an `eol` setting or a `text` that is set, such as `docs/evidence/** text eol=lf`, because git then normalizes the line endings and the committed file is no longer the approved image. Stop, and name the attribute. An unset `text` (`-text`, `binary`) and `text=auto` pass. With `auto`, git treats a real image as binary, because image files hold NUL bytes, and leaves it alone. The checks of the staged and the committed blob below catch what this rule cannot see, such as `core.autocrlf`.
- `git status` printed a line: the destination holds uncommitted content. Stop.

Copy each new entry. The copy leaves the original in place. Before each copy, recompute the git blob SHA of the source from its raw bytes and compare it with the `blob_sha` that classify reported, as shown in the Step 5 list. When the SHA differs, the file changed after the list was shown and confirmed, so stop and copy nothing. In embed mode the reason is `source-changed`. `--no-filters` makes git hash the raw bytes, which is how the helper computes `blob_sha`, so a text or LFS filter cannot change the result.

```bash
SRC="<source path>";
DEST="<destination path>";
BLOB_SHA="<blob_sha from the Step 5 list>";
if [ "$(git hash-object --no-filters -- "$SRC")" = "$BLOB_SHA" ]; then mkdir -p "$(dirname "$DEST")" && cp -- "$SRC" "$DEST"; else echo "source-changed $SRC"; false; fi
```

### Commit by pathspec

Stage and commit only the new destinations. A pathspec commit leaves other staged work out of the commit. Never pass `--no-verify`; a failing hook stops the run.

Stage the destinations:

```bash
set -- "<destination 1>" "<destination 2>";
git add -- "$@"
```

Staging can change bytes: a `.gitattributes` text, eol or filter setting, or `core.autocrlf`, normalizes the file as it goes in. The copy check passed on the source, so check what is staged. Each item is a destination and the `blob_sha` that classify reported for it, as shown in the Step 5 list:

```bash
set -- "<destination 1> <blob_sha 1>" "<destination 2> <blob_sha 2>";
FAILED=0
for ITEM in "$@"; do
  DEST="${ITEM% *}"; EXPECTED="${ITEM##* }"
  ACTUAL="$(git rev-parse ":$DEST")"
  [ "$ACTUAL" = "$EXPECTED" ] || { echo "blob-mismatch staged $DEST ${ACTUAL:-none}"; FAILED=1; }
done
test "$FAILED" = 0
```

Exit 0 passes. A `blob-mismatch` line means that git changed the bytes while staging. Unstage the paths with the recovery below, commit nothing and stop. Say that the likely cause is a `.gitattributes` text, eol or filter setting, or `core.autocrlf`. In embed mode the reason is `blob-mismatch`.

Commit the staged destinations:

```bash
TOPIC="<topic slug>";
set -- "<destination 1>" "<destination 2>";
git commit -m "chore(evidence): add screenshots for $TOPIC" -- "$@"
```

If the commit fails (a hook rejects it, or git reports an error), run `git restore --staged` with the same paths and check that none of them is still staged. Then stop with the state reached. The copied files stay in the working tree, untracked. In embed mode the reason is `commit-failed`.

```bash
set -- "<destination 1>" "<destination 2>";
git restore --staged -- "$@"
test -z "$(git diff --cached --name-only -- "$@")"
```

Exit 0 means that none of the paths is staged. A failed cleanup commit uses the same recovery.

A hook can also change the content during the commit, so check the committed blobs against the same list:

```bash
set -- "<destination 1> <blob_sha 1>" "<destination 2> <blob_sha 2>";
FAILED=0
for ITEM in "$@"; do
  DEST="${ITEM% *}"; EXPECTED="${ITEM##* }"
  ACTUAL="$(git rev-parse "HEAD:$DEST")"
  [ "$ACTUAL" = "$EXPECTED" ] || { echo "blob-mismatch committed $DEST ${ACTUAL:-none}"; FAILED=1; }
done
test "$FAILED" = 0
```

On a `blob-mismatch` line, do not push. The altered image is in a local commit. Leave the commit as it is and report the state: the evidence commit is local, and it holds a blob that differs from the approved one. In embed mode the reason is `blob-mismatch`, and the evidence commit is local.

### Assert the committed file set

The commit must hold exactly the new destinations:

```bash
set -- "<destination 1>" "<destination 2>";
EXPECTED="$(printf '%s\n' "$@" | LC_ALL=C sort)"
ACTUAL="$(git diff-tree --no-commit-id --name-only -r --no-renames HEAD | LC_ALL=C sort)"
test "$ACTUAL" = "$EXPECTED"
```

Exit 0 passes. On a mismatch, stop. Do not push. Tell the user the commit holds files outside the list, and leave it as it is until they decide. In embed mode the reason is `file-set-mismatch`, and the evidence commit is local.

### Push with an explicit refspec

`REMOTE` is the remote from Step 3. `BRANCH` is `headRefName`, or the upstream branch in embed mode.

```bash
REMOTE="<remote>";
BRANCH="<head branch>";
GIT_TERMINAL_PROMPT=0 git push "$REMOTE" "HEAD:refs/heads/$BRANCH"
```

`GIT_TERMINAL_PROMPT=0` turns credential prompts off, so a push that needs input fails instead of hanging. The push has no timeout wrapper, because `timeout` is not on every platform's default PATH and nothing else in this skill depends on it.

If the push is rejected, stop and report. Never force-push and never retry with another refspec. A non-fast-forward rejection means the branch moved. Tell the user to fetch and rebase or merge, then re-run. A re-run reuses evidence that is already committed, because reuse is keyed on the destination and the blob SHA. In embed mode the reason is `push-rejected`.

If the push exits non-zero, check what the remote holds with `git ls-remote` before reporting anything, because the remote may have accepted the push even though the command failed (for example, when the connection dropped afterwards):

```bash
REMOTE="<remote>";
BRANCH="<head branch>";
if REMOTE_LINE="$(GIT_TERMINAL_PROMPT=0 git ls-remote "$REMOTE" "refs/heads/$BRANCH")"; then
  if [ "${REMOTE_LINE%%[[:space:]]*}" = "$(git rev-parse HEAD)" ]; then echo landed; else echo local; fi
else
  echo unchecked
fi
```

- `landed`: the remote SHA equals `HEAD`, so the push landed and counts as pushed. Go on as if the push had succeeded.
- `local`: the remote SHA differs from `HEAD`, or the branch is not on the remote. The evidence commit exists only locally. In embed mode the status line carries `evidence=local`.
- `unchecked`: `git ls-remote` failed too, so the push is not confirmed. Treat it as `local` and say that the remote could not be checked.

## Step 7: Verify the embeds

Verification runs in every mode, before the description is written or the Demo file is returned. The link form from Step 4 picks the subsection: public repositories use the raw form, and every other repository uses the blob form.

Make the temp files. Each is created with mode 0600. Note the three paths:

```bash
for NAME in demo backup new-body; do printf '%s %s\n' "$NAME" "$(mktemp)"; done
```

### Select the pins and write the Demo text

PR mode and embed mode only. Every pin the skill embeds comes from the helper. Never choose a pin with `git log` and never retype or transcribe a SHA by hand. For each destination the helper picks the newest commit on `HEAD` that added or changed the file, counting a merge that resolved it. It then checks that the blob at that pin is the `blob_sha` that classify reported for the destination, and writes the Demo text to the Demo file. The form is `raw` for a public repository and `blob` for every other repository.

Send one `select` item for every destination, new and reused, in the order the images should appear:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/pr-attachments.mjs" pins <<'JSON'
{"select": [{"path": "<destination 1>", "blob_sha": "<blob_sha 1>"}, {"path": "<destination 2>", "blob_sha": "<blob_sha 2>"}], "head_repo": "<owner/repo of the head repository>", "form": "<raw or blob>", "out_file": "<demo file>"}
JSON
```

- `selected` (exit 0): the Demo file is written. `evidence_sha` is the newest commit that added or changed any of these files. Copy it for the status line.
- `pin-mismatch` (exit 1): at a chosen pin, the blob of a destination differs from its `blob_sha`. Read `mismatched`. The Demo file is not written. Stop: the pushed image is not the approved one. In embed mode the reason is `pin-mismatch`.
- `unresolved` (exit 1): no commit on `HEAD` added a destination, so there is no pin to embed. Treat it as a `pin-mismatch`, and name `unresolved_paths`.
- `head-not-found`, `git-failed` or `git-timeout` (exit 1): stop and report `reached`. In embed mode the reason is `git-failed`.
- `write-failed` (exit 1): the Demo file could not be written. Stop with `status=failed`, `reason=helper-failed` and `evidence=pushed`.
- `usage-error` (exit 2): stop. In embed mode the reason is `helper-failed`.

Never write the description, and never return the Demo file, after a stop here. The evidence commit is pushed and unreferenced. In PR mode say: the evidence commit is pushed, the description is not written, and a re-run retries and reuses the pushed commit.

### Public repositories: the raw form

List the URLs to verify, from the Demo file that the helper wrote:

```bash
FILE="<Demo file, the new body file in Re-pin mode, or the backup file after an already-valid result>";
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
- `failed` (exit 1): read `failed`. Report each failing URL with its `status` and `http_status`. If the top-level `retryable` is true, call again with the same URLs and `waited_s` set to the `waited_s` of the latest report, unchanged. That value is already the running total of all calls. When the latest report has a `resume_at`, add `"resume_at"` to the JSON and set it to that value, unchanged. Stop once `retryable` is false.

  `resume_at` is an epoch-millisecond deadline. A 429 with a Retry-After longer than one call sets it, because the helper keeps no state and a new call would otherwise send a request at once. The call that gets it sleeps until `resume_at` before its first request, within its own `max_wait_s`, and counts the sleep in `waited_s`, so no request goes out before the deadline. Omit `resume_at` on the first call and when the latest report has none. Never compute, edit or drop it. A `resume_at` past the 300 s total ends the run: `retryable` is false.
- `usage-error` (exit 2) with `blob-url`: a blob-form URL never goes to this call, so stop.
- Any other `usage-error`: stop.

In embed mode a `usage-error` here ends with the reason `helper-failed`, and `evidence` is `pushed`.

Never print or paste a response body, and never fetch one yourself.

Never write the description, and never return the Demo file, when verification fails. The evidence commit is pushed and unreferenced. In PR mode say: the evidence commit is pushed, the description is not written, and a re-run retries and reuses the pushed commit. In embed mode the reason is `verify-failed`.

### Private repositories: the blob form

The Demo text is written in the blob form by the pin selection above. List the URLs to check, from the Demo file that the helper wrote:

```bash
FILE="<Demo file, the new body file in Re-pin mode, or the backup file after an already-valid result>";
OWNER_REPO="<owner/repo of the head repository>";
grep -o -E "https://github\.com/$OWNER_REPO/blob/[0-9a-f]{40}/docs/evidence/[a-z0-9._/-]+\?raw=true" "$FILE" | sort -u
```

Check each URL through `gh`, never through the helper's `verify`, which fetches anonymously and cannot see a private repository. The check asks GitHub for the file at the pinned commit and compares its git blob SHA with the expected one. Equal blob SHAs mean the file is byte-identical to the one that classify already accepted as an image, so nothing is downloaded.

The expected SHA is the `blob_sha` that classify reported for that file. Pair each URL with the entry whose `destination` ends the URL path. Re-pin mode has no classify result, so write `local` in place of the SHA: the block then reads the blob SHA from git at the pinned commit.

```bash
OWNER_REPO="<owner/repo of the head repository>";
set -- "<blob URL 1> <blob_sha 1, or local>" "<blob URL 2> <blob_sha 2, or local>";
ERR_FILE="$(mktemp)"
FAILED=0
for ITEM in "$@"; do
  URL="${ITEM%% *}"; EXPECTED="${ITEM#* }"
  REST="${URL#https://github.com/$OWNER_REPO/blob/}"; PIN="${REST%%/*}"; DEST="${REST#*/}"; DEST="${DEST%%\?*}"
  [ "$EXPECTED" = local ] && EXPECTED="$(git rev-parse "$PIN:$DEST")"
  printf '%s\n' "$EXPECTED" | grep -Eqx '[0-9a-f]{40}' || { echo "no expected blob SHA for $DEST"; FAILED=1; continue; }
  ACTUAL=""; API_FAILED=0
  for ATTEMPT in 1 2 3 4; do
    API_FAILED=0
    ACTUAL="$(gh api "repos/$OWNER_REPO/contents/$DEST?ref=$PIN" --jq .sha 2>"$ERR_FILE")" || API_FAILED=1
    [ "$API_FAILED" = 0 ] && [ "$ACTUAL" = "$EXPECTED" ] && break
    [ "$ATTEMPT" -lt 4 ] && sleep 5
  done
  if [ "$API_FAILED" = 1 ]; then echo "api-error $DEST $(head -n 1 "$ERR_FILE" | cut -c1-200)"; FAILED=1
  elif [ "$ACTUAL" = "$EXPECTED" ]; then echo "ok $DEST"
  else echo "mismatch $DEST ${ACTUAL:-none}"; FAILED=1; fi
done
rm -f "$ERR_FILE"
test "$FAILED" = 0
```

Exit 0 passes: every file exists at its pinned commit with the expected blob SHA. Each file gets four attempts, five seconds apart, so GitHub has time to serve a new commit. Every file prints one line:

- `ok`: the file is at its pinned commit with the expected blob SHA.
- `mismatch`: GitHub answered, and the blob SHA differs from the expected one.
- `api-error`: the `gh api` call itself failed (access denied, a rate limit, a missing file or a network failure), and the line carries the first line of stderr, which the block keeps in a temp file instead of discarding it. An `api-error` is not a content problem, so report it as an access or API problem.

A file that still fails after the attempts, or a line that says `no expected blob SHA`, stops the run. Stop with the state reached: what is committed, what is pushed, which files failed and how, and that the description is untouched.

Never write the description, and never return the Demo file, when this check fails. The evidence commit is pushed and unreferenced. In PR mode say: the evidence commit is pushed, the description is not written, and a re-run retries and reuses the pushed commit. In embed mode the reason is `verify-failed`.

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
  - `unterminated-region`: a code fence (also one inside a list item or a quote), a comment, or a `<pre>`, `<script>`, `<style>` or `<textarea>` block is never closed. It would swallow the section, or it sits inside the existing Demo section so that the end of that section is unknown. Nothing is replaced. Ask the user to close it.
  - `unexpected-section-content`: the existing Demo section holds a line this skill does not write, such as a heading, a table or prose. The section is not the managed one, or its end is misjudged. Nothing is replaced and the description stays untouched. Ask the user to move that content out of the section.
  - `line-ending-conflict`: the Demo text and the description use different line endings at the join. Ask the user.
- `write-failed` (exit 1): the output file could not be written. Stop.
- `usage-error` (exit 2): stop.

If `screenshots_present` is true, warn the user: the description has a `## Screenshots` section, which is left alone. Nothing is merged into it.

Re-read the description immediately before writing, and write only if it is unchanged since the backup. Compare only the `body` field of the backup and of the re-read. The two files are JSON objects whose other fields differ by mode (PR mode and Re-pin mode build their backups with different fields), so a whole-file comparison would never match. This guard applies to every mode that writes. A changed description stops the run with nothing written; re-run to start from the new text. Write with a body file, never an inline body:

```bash
PR="<PR number>";
BACKUP="<backup file>";
NEW_BODY="<new body file>";
RECHECK="$(mktemp)"
gh pr view "$PR" --json body > "$RECHECK"
node -e 'const body = (file) => JSON.parse(require("fs").readFileSync(file, "utf8")).body; process.exit(body(process.argv[1]) === body(process.argv[2]) ? 0 : 1)' "$BACKUP" "$RECHECK" && gh pr edit "$PR" --body-file "$NEW_BODY"
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
pr-attachments: status=failed evidence=<pushed|local|none> reason=<reason>
```

- `evidence_sha` is the SHA that the pin selection in Step 7 reported. Copy it.
- `evidence` is `pushed` once the push landed, `local` when the evidence commit exists only on this machine (it was committed, but the push did not land), and `none` otherwise. A failed line never comes with a Demo file.
- `reason` comes from this table. Every embed-mode stop has exactly one row:

| Stop | Reason |
|---|---|
| Node is missing or cannot launch | `node-unavailable` |
| A helper call exits 2 with a `usage-error` | `helper-failed` |
| A helper call returns `internal-error` | `helper-failed` |
| A helper call returns `write-failed` | `helper-failed` |
| Classify returns `rejected` | `rejected-images` |
| Classify returns `needs-input` and the user does not settle it | `needs-input` |
| No image paths, no upstream, an unlisted remote or a host other than github.com | `no-target` |
| A stray `old=` or `new=` token | `bad-arguments` |
| The user cannot push to the head repository | `no-push-access` |
| Any other git or gh command fails | `git-failed` |
| The user declines the private-repository question or the scrub | `declined` |
| The push target is the default branch | `default-branch` |
| A destination is gitignored | `destination-blocked` |
| A destination has an LFS filter, or an `eol` or `text` attribute that rewrites bytes | `destination-blocked` |
| A destination holds uncommitted content | `destination-blocked` |
| A source file changed since classify | `source-changed` |
| A hook rejects the evidence commit, or the commit fails | `commit-failed` |
| A staged or committed blob differs from the one classify reported | `blob-mismatch` |
| The committed file set differs from the destinations | `file-set-mismatch` |
| The push is rejected, or exits non-zero and the remote does not hold `HEAD` | `push-rejected` |
| The pin chosen for a destination is missing, or its blob differs from the one classify reported | `pin-mismatch` |
| An embed does not serve the image, or its blob check fails | `verify-failed` |

## Carry mode

`mode:carry old=<old body file> new=<new body file>` copies the `## Demo` section of an old description into a regenerated one. A caller that rewrites a description uses it, because the caller cannot reach this skill's helper from its own directory.

Carry mode reads and writes the two named files and nothing else. It never commits, never pushes, never calls `gh` and never touches the network. The caller owns both files and writes the description itself. Carry mode ends at the status line, with no cleanup offer.

Take both `old=` and `new=` from Step 1. Wrap a value that has spaces in double quotes, for example `old="/tmp/a b/old.md"`, and strip the quotes after splitting. If either is missing, or any image path or `pr:` token is present, stop. There are no image paths and no `pr:` token in carry mode. The reason is `bad-arguments`.

Make the file that holds the extracted section. Note its path:

```bash
printf 'demo %s\n' "$(mktemp)"
```

Extract the section from the old body. The `node -e` part only reads the old file into the helper's JSON input, so the text is never retyped:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
OLD_BODY="<old body file>";
DEMO_FILE="<demo file>";
node -e 'process.stdout.write(JSON.stringify({body: require("fs").readFileSync(process.argv[1], "utf8"), out_file: process.argv[2]}))' "$OLD_BODY" "$DEMO_FILE" | node "$SKILL_DIR/scripts/pr-attachments.mjs" extract
```

Route the result:

- `extracted` (exit 0): continue.
- `absent` (exit 0): the old description has no Demo section, so there is nothing to carry; leave the new file untouched, remove the demo file and finish with `status=absent`, which is not a failure.
- `needs-input` (exit 1): the old file is untouched and nothing is copied. Finish with `status=failed`. The reason is the code in `asks`: `multiple-demo-sections` (the old description has more than one `## Demo` section), `unterminated-region` (an unclosed block sits inside its Demo section, so where that section ends is unknown) or `unexpected-section-content` (its Demo section holds a line this skill does not write, such as a heading, a table or prose).
- `write-failed` (exit 1): finish with `status=failed`.
- `usage-error` (exit 2) or `internal-error`: finish with `status=failed`.

Splice the section into the new body. The new file is read first and then written in place:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
NEW_BODY="<new body file>";
DEMO_FILE="<demo file>";
node -e 'process.stdout.write(JSON.stringify({body: require("fs").readFileSync(process.argv[1], "utf8"), demo_file: process.argv[2], out_file: process.argv[1]}))' "$NEW_BODY" "$DEMO_FILE" | node "$SKILL_DIR/scripts/pr-attachments.mjs" splice
```

Route the result:

- `spliced` (exit 0): `appended`, `replaced` and `unchanged` all finish with `status=ok`.
- `needs-input` (exit 1): the new file is untouched. Finish with `status=failed`. The reason is the code in `asks`: `multiple-demo-sections` (the new file has more than one `## Demo` section), `unterminated-region` (an unclosed code fence, comment or HTML block would swallow the section), `unexpected-section-content` (the existing Demo section in the new file holds a line this skill does not write) or `line-ending-conflict` (the two texts use different line endings at the join).
- `write-failed` (exit 1): finish with `status=failed`. The new file may be partly written, so the caller discards it.
- `usage-error` (exit 2) or `internal-error`: finish with `status=failed`.

On every path, remove the demo file:

```bash
DEMO_FILE="<demo file>";
rm -f "$DEMO_FILE"
```

Then print exactly one status line:

```text
pr-attachments: status=<ok|absent|failed> [reason=<reason>]
```

`reason` appears only with `failed`. It is one of `node-unavailable`, `bad-arguments`, `helper-failed`, `multiple-demo-sections`, `unterminated-region`, `unexpected-section-content`, `line-ending-conflict` or `write-failed`. A missing node is `node-unavailable`, and a `usage-error` or `internal-error` is `helper-failed`. Never write a Demo section by hand when carry mode fails.

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

With no managed URL, report that there is nothing to re-pin and go to Cleanup.

Each URL reports its `form`. The form must match the repository (`raw` for a public repository, `blob` for any other) or the run stops. Say which embeds use the wrong form and why: a raw link does not render in a private repository, and a blob link cannot be verified anonymously in a public one. To fix it, re-run in PR mode with the image paths, which replaces the Demo section.

### Pick the pins

Ask git for the newest commit of each managed path. Send the `urls` array unchanged:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/pr-attachments.mjs" pins <<'JSON'
{"head_ref_oid": "<headRefOid>", "urls": [<the urls array from the previous report>]}
JSON
```

- `already-valid` (exit 0): write nothing. The pins were checked only against local git, so verify the embed URLs that the description holds before Cleanup. Read them from the backup file made above, and use the same checks as in Step 7: a public repository uses "Public repositories: the raw form", and any other repository uses "Private repositories: the blob form" with `local` as the expected SHA of every URL. If a check fails, report each failure, write nothing and do not offer Cleanup. If every check passes, report already valid and go to Cleanup.
- `repin-needed` (exit 0): continue with the `pins` map.
- `partial` (exit 1): report partial and name `unresolved_paths`. Write nothing yet. Then offer the next actions: re-pin the resolved paths, which still writes only the resolved ones through the normal write guard, or re-add the missing images in PR mode. If the user chooses to re-pin the resolved paths, continue with the `pins` map.
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

- `repinned` (exit 0): report `rewritten`, `ignored` and `unmapped_paths`. A non-empty `unmapped_paths` means the description changed since the first read: stop and re-run. After a `partial` result, `unmapped_paths` holds exactly the `unresolved_paths`, and anything else stops the run.
- `write-failed` (exit 1): stop.
- `usage-error` (exit 2): stop.

### Verify and write

Verify the URLs of the rewritten file with Step 7. Take the list from the new body file. A public repository uses the raw form subsection. Any other repository uses "Private repositories: the blob form", with `local` as the expected SHA of every URL.

Re-pin mode never meets `unexpected-section-content`, because it does not call `splice` or `extract`: it edits only the 40-hex segment of managed URLs and no other line.

Then do the write step of Step 8 with the new body file and this backup. Tell the user the backup path first. The guard compares only `body`, so this backup works although it also holds `head_repo` and `pins`. Then go to Cleanup.

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

  For a private, internal or unknown-visibility repository, cleanup works the same way, and you also say that the images stay in the repository's history and become public if it is later made public or forked.

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

If the commit fails, run `git restore --staged` with the same paths, as in Commit by pathspec, and stop. The removed files then show as deleted but unstaged.

Then run the file-set assertion from Assert the committed file set, with these paths as the expected set. Before the push, apply the refusal from Step 4 for a push target that is the default branch. Then run the push from Push with an explicit refspec. A rejection stops the run as it does there.

## Disclosures

- Evidence binaries appear in the Files tab of the PR until cleanup.
- Published images stay in git history, forks and caches. Cleanup removes files from the branch. It does not revoke access.
- For a public repository, verification confirms the raw URL serves an image. For a private repository, it confirms that the file at the pinned commit is the image that was classified. Neither confirms GitHub renders it. Files over 10 MiB never reach this point, because they are rejected before anything is published.
- A private repository's images stay in its history. If it is later made public or forked, they become public. Cleanup does not remove them from history.
- Blob links in a private repository render only for signed-in viewers who have access to it. Anyone else sees no image.
- A commit-pinned link survived cleanup, squash merge and branch deletion on one observed PR. That is observed, not guaranteed. A re-run re-verifies.
- A rebase or force-push needs a re-run with no paths.
