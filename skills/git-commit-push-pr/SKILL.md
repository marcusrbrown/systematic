---
name: git-commit-push-pr
description: Commit, push, and open a PR with an adaptive, value-first description. Use when the user says "commit and PR", "push and open a PR", "ship this", "create a PR", "open a pull request", "commit push PR", or wants to go from working changes to an open pull request in one step. Also use when the user says "update the PR description", "refresh the PR description", "freshen the PR", or wants to rewrite an existing PR description. Produces PR descriptions that scale in depth with the complexity of the change, avoiding cookie-cutter templates.
---

# Git Commit, Push, and PR

Go from working changes to an open pull request, or rewrite an existing PR description.

**Asking the user:** When this skill says "ask the user", use the platform's blocking question tool (`question` in OpenCode, `request_user_input` in Codex, `ask_user` in Gemini; in Pi, use the blocking-question extension if available, otherwise present numbered options in chat and wait). If unavailable, present the question and wait for a reply.

## Mode detection

If the user is asking to update, refresh, or rewrite an existing PR description (with no mention of committing or pushing), this is a **description-only update**. The user may also provide a focus (e.g., "update the PR description and add the benchmarking results"). Note any focus for DU-3.

For description-only updates, follow the Description Update workflow below. Otherwise, follow the full workflow.

## Context

**If you are not OpenCode**, skip to the "Context fallback" section below and run the command there to gather context.

**If you are OpenCode**, the six labeled sections below contain pre-populated data. Use them directly -- do not re-run these commands.

**Git status:**
!`git status`

**Working tree diff:**
!`git diff HEAD`

**Current branch:**
!`git branch --show-current`

**Recent commits:**
!`git log --oneline -10`

**Remote default branch:**
!`git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo 'DEFAULT_BRANCH_UNRESOLVED'`

**Existing PR check:**
!`gh pr view --json url,title,state 2>/dev/null || echo 'NO_OPEN_PR'`

### Context fallback

**If you are OpenCode, skip this section — the data above is already available.**

Run this single command to gather all context:

```bash
printf '=== STATUS ===\n'; git status; printf '\n=== DIFF ===\n'; git diff HEAD; printf '\n=== BRANCH ===\n'; git branch --show-current; printf '\n=== LOG ===\n'; git log --oneline -10; printf '\n=== DEFAULT_BRANCH ===\n'; git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo 'DEFAULT_BRANCH_UNRESOLVED'; printf '\n=== PR_CHECK ===\n'; gh pr view --json url,title,state 2>/dev/null || echo 'NO_OPEN_PR'
```

---

## Description Update workflow

### DU-1: Confirm intent

Ask the user: "Update the PR description for this branch?" If declined, stop.

### DU-2: Find the PR

Use the current branch and existing PR check from context. If the current branch is empty (detached HEAD), report no branch and stop. If the PR check returned `state: OPEN`, note the PR `url` from the context block — this is the unambiguous reference to pass downstream — and proceed to DU-3. Otherwise, report no open PR and stop.

### DU-3: Write and apply the updated description

Read the current PR description. It drives the compare-and-confirm step later, and it is saved to an old body file for the carry:

```bash
OLD_BODY_FILE=$(mktemp) && gh pr view "<PR URL>" --json body --jq '.body' > "$OLD_BODY_FILE" && cat "$OLD_BODY_FILE" && echo saved
```

When the command does not print `saved`, the temp file could not be created or the `gh` read failed. Stop and apply nothing, because the current description was never saved. Tell the user why, remove the old file, and ask how to proceed.

**Generate the updated title and body** — using the PR URL from DU-2 and the commit range it covers, write an updated PR title and body. The URL preserves repo/PR identity even when invoked from a worktree or subdirectory. If the user provided a focus (e.g., "include the benchmarking results"), incorporate it into the generated content. Write the body to an OS temp file:

```bash
BODY_FILE=$(mktemp /tmp/pr-body-XXXXXX.md)
cat > "$BODY_FILE" << 'EOF'
<generated body>
EOF
```

If the PR is not open or the commit range cannot be resolved, report the issue and stop.

**Evidence decision:** Preserve any existing `## Demo` or `## Screenshots` block from the current body by default. Carry the `## Demo` section with `mode:carry`, by following Carrying the Demo section: `old=` is the old body file saved above, and `new=` is the body file written above. The carry always runs, and it runs before the compare-and-confirm step. If the user's focus asks to refresh or remove evidence, honor that intent and skip the carry. When the carry ends, remove the old file:

```bash
rm -f "$OLD_BODY_FILE"
```

Do not offer to publish images here. If the user asks to attach local images, route that request to `systematic:pr-attachments` in PR mode, with the image paths as its only tokens. PR mode writes the Demo section itself, and a later rewrite carries it through.

**Compare and confirm** — briefly explain what the new description covers differently from the old one. This helps the user decide whether to apply; the description itself does not narrate these differences. Summarize from the body already in context (from the bash call that wrote `body_file`); do not `cat` the temp file, which would re-emit the body.

- If the user provided a focus, confirm it was addressed.
- Ask the user to confirm before applying.

If confirmed, apply with the returned title and body file:

```bash
gh pr edit --title "<returned title>" --body "$(cat "<returned body_file>")"
```

Report the PR URL.

---

## Full workflow

### Step 1: Gather context

Use the context above. All data needed for this step and Step 3 is already available -- do not re-run those commands.

The remote default branch value returns something like `origin/main`. Strip the `origin/` prefix. If it returned `DEFAULT_BRANCH_UNRESOLVED` or a bare `HEAD`, try:

```bash
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
```

If both fail, fall back to `main`.

If the current branch is empty (detached HEAD), explain that a branch is required. Ask whether to create a feature branch now.
- If yes, derive a branch name from the change content, create with `git checkout -b <branch-name>`, and use that for the rest of the workflow.
- If no, stop.

If the working tree is clean (no staged, modified, or untracked files), determine the next action:

1. Run `git rev-parse --abbrev-ref --symbolic-full-name @{u}` to check upstream.
2. If upstream exists, run `git log <upstream>..HEAD --oneline` for unpushed commits.

Decision tree:

- **On default branch, unpushed commits or no upstream** -- ask whether to create a feature branch (pushing default directly is not supported). If yes, create and continue from Step 5. If no, stop.
- **On default branch, all pushed, no open PR** -- report no feature branch work. Stop.
- **Feature branch, no upstream** -- skip Step 4, continue from Step 5.
- **Feature branch, unpushed commits** -- skip Step 4, continue from Step 5.
- **Feature branch, all pushed, no open PR** -- skip Steps 4-5, continue from Step 6.
- **Feature branch, all pushed, open PR** -- report up to date. Stop.

### Step 2: Determine conventions

Priority order for commit messages and PR titles:

1. **Repo conventions in context** -- follow project instructions if they specify conventions. Do not re-read; they load at session start.
2. **Recent commit history** -- match the pattern in the last 10 commits.
3. **Default** -- `type(scope): description` (conventional commits).

### Step 3: Check for existing PR

Use the current branch and existing PR check from context. If the branch is empty, report detached HEAD and stop.

If the PR check returned `state: OPEN`, note the URL -- this is the existing-PR flow. Continue to Step 4 and 5 (commit any pending work and push), then go to Step 7 to ask whether to rewrite the description. Only run Step 6 (which generates a new description) if the user confirms the rewrite; Step 7's existing-PR sub-path uses the title and body file that Step 6 produces. Otherwise (no open PR), continue through Steps 6, 7, and 8 in order.

### Step 4: Branch, stage, and commit

1. If on the default branch, create a feature branch first with `git checkout -b <branch-name>`.
2. Scan changed files for naturally distinct concerns. If files clearly group into separate logical changes, create separate commits (2-3 max). Group at the file level only (no `git add -p`). When ambiguous, one commit is fine.
3. Never stage an untracked image file without asking. Image files are PNG, JPEG, GIF and WebP, such as `.png` or `.jpg`. A screenshot meant for the PR description is evidence, not part of the change, so it stays out of the feature commit. When untracked images exist, ask the evidence-source question from Step 6 first, and do not ask again in Step 6. Stage an image only when the user says it is part of the change.
4. Stage and commit each group in a single call. Avoid `git add -A` or `git add .`. Follow conventions from Step 2:
   ```bash
   git add file1 file2 file3 && git commit -m "$(cat <<'EOF'
   commit message here
   EOF
   )"
   ```

### Step 5: Push

```bash
git push -u origin HEAD
```

### Step 6: Generate the PR title and body

The working-tree diff from Step 1 only shows uncommitted changes at invocation time. The PR description must cover **all commits** in the PR.

**Detect the base branch and remote.** Resolve both the base branch and the remote (fork-based PRs may use a remote other than `origin`). Stop at the first that succeeds:

1. **PR metadata** (if existing PR found in Step 3):
   ```bash
   gh pr view --json baseRefName,url
   ```
   Extract `baseRefName`. Match `owner/repo` from the PR URL against `git remote -v` fetch URLs to find the base remote. Fall back to `origin`.
2. **Remote default branch from context** -- if resolved, strip `origin/` prefix. Use `origin`.
3. **GitHub metadata:**
   ```bash
   gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
   ```
   Use `origin`.
4. **Common names** -- check `main`, `master`, `develop`, `trunk` in order:
   ```bash
   git rev-parse --verify origin/<candidate>
   ```
   Use `origin`.

If none resolve, ask the user to specify the target branch.

**Gather the full branch diff (before evidence decision).** The working-tree diff from Step 1 only reflects uncommitted changes at invocation time — on the common "feature branch, all pushed, open PR" path, Step 1 skips the commit/push steps and the working-tree diff is empty. The evidence decision below needs the real branch diff to judge whether behavior is observable, so compute it explicitly against the base resolved above. Only fetch when the local ref isn't available — if `<base-remote>/<base-branch>` already resolves locally, run the diff from local state so offline / restricted-network / expired-auth environments don't hard-fail:

```bash
git rev-parse --verify <base-remote>/<base-branch> >/dev/null 2>&1 \
  || git fetch --no-tags <base-remote> <base-branch>
git diff <base-remote>/<base-branch>...HEAD
```

Use this branch diff (not the working-tree diff) for the evidence decision. If the branch diff is empty (e.g., HEAD is already merged into the base or the branch has no unique commits), skip the evidence prompt and continue to delegation.

**Evidence decision (before delegation).** If the branch diff changes observable behavior (UI, CLI output, API behavior with runnable code, generated artifacts, workflow output) and evidence is not otherwise blocked (unavailable credentials, paid services, deploy-only infrastructure, hardware), ask: "This PR has observable behavior. Capture evidence for the PR description?"

- **Use existing evidence** -- ask for the URL or markdown embed, then splice it into the PR body as a `## Demo` section before applying.
- **Publish local images** -- publish image files from this machine as commit-pinned embeds. Ask for the image paths, or offer the untracked images found in Step 4. Then load the `systematic:pr-attachments` skill in embed mode. State the tokens in the instruction text only, because some hosts pass no skill arguments and the same tokens in two places would be read twice. For example: `mode:embed shots/a.png "shots/b c.png"`. Wrap a path that has spaces in double quotes.
- **Skip** -- proceed with no evidence section.

The skill ends with one status line:

```text
pr-attachments: status=ok evidence_sha=<40-hex> demo_file=<path> images=<count>
pr-attachments: status=failed evidence=<pushed|local|none> reason=<reason>
```

- `status=ok`: take `demo_file` from the line. The file holds the Demo section. Keep it for the splice below. The narrative range below does not use `evidence_sha`.
- `status=failed` with `evidence=pushed`: the evidence files are pushed but unreferenced. Tell the user the reason, and keep the image paths for the retry command in Step 8. Then continue without evidence.
- `status=failed` with `evidence=local`: the evidence commit is local and unpushed. It exists only on this machine, and the remote does not hold it. Tell the user the reason and that the branch needs a push (after a fetch and a rebase or merge, when the push was rejected) before the images can be published. Then continue without evidence.
- `status=failed` with `reason=blob-mismatch`: the exception to the push advice above. The local evidence commit holds an image that git changed on its way in, for example through a `.gitattributes` setting or a hook. Tell the user it must not be pushed as it is, and continue without evidence.
- `status=failed` with `evidence=none`: nothing was published. Tell the user the reason, then continue without evidence.

**Fallback.** If loading `systematic:pr-attachments` fails, or it loads but sees no `mode:` token and stops without a status line, offer only the two existing options: **Use existing evidence** and **Skip**.

When evidence is not possible (docs-only, markdown-only, changelog-only, release metadata, CI/config-only, test-only, or pure internal refactors), skip without asking.

**Generate title and body.** Using the branch diff and commit log, write a PR title and body directly:

- **Title**: conventional-commit format, under 72 characters, describing the value delivered (not the implementation).
- **Body**: value-first narrative scaled to the change size. Apply the writing principles, commit classification, sizing, and narrative framing described in this skill. Write the body to an OS temp file:
  ```bash
  BODY_FILE=$(mktemp /tmp/pr-body-XXXXXX.md)
  cat > "$BODY_FILE" << 'EOF'
  <generated body>
  EOF
  ```
- Splice any captured evidence as a `## Demo` section into the body file before applying. For the file that **Publish local images** returned, append it with the shell and delete it once it is appended, so no SHA is retyped:
  ```bash
  printf '\n' >> "<body_file>" && cat "<demo_file>" >> "<body_file>" && rm -f "<demo_file>"
  ```

**Narrative range after publishing.** An evidence commit on the branch is housekeeping, not part of the change. Use the same two commands on every path: `status=ok`, `status=failed` with `evidence=pushed`, and no publish at all. Both leave `docs/evidence/**` out by path, so a commit that touches only evidence files drops out of the log on its own, and later feature commits stay in:

```bash
git log --oneline <base-remote>/<base-branch>..HEAD -- . ':(exclude)docs/evidence/**'
git diff <base-remote>/<base-branch>...HEAD -- . ':(exclude)docs/evidence/**'
```

Fill in the real values each time. No shell variable carries values from one call to the next.

If the branch diff is empty or the base ref is unresolved, report the issue and stop — do not create or edit the PR.

### Step 7: Create or update the PR

#### New PR (no existing PR from Step 3)

Using the title and body file generated in Step 6:

```bash
gh pr create --title "<title>" --body "$(cat "<body_file>")"
```

Keep the title under 72 characters.

#### Existing PR (found in Step 3)

The new commits are already on the PR from Step 5. Report the PR URL, then ask whether to rewrite the description.

- If **yes**, run Step 6 now to generate the title and body file (passing the existing PR URL for context), then carry the Demo section and apply.

  **Carry the Demo section.** The rewrite replaces the whole description, so a `## Demo` section in the current one has to be carried into the new one. The carry always runs; do not gate it on a heading check, because the helper decides whether a Demo section exists. Skip it only when the new body already holds a `## Demo` section from Step 6. Save the current description to a file:

  ```bash
  OLD_BODY_FILE=$(mktemp) && gh pr view "<PR URL>" --json body --jq '.body' > "$OLD_BODY_FILE" && echo saved
  ```

  When the command does not print `saved`, the temp file could not be created or the `gh` read failed. Stop the carry and do not apply the new body file, because the current description was never saved. Tell the user why, remove the old file, and ask how to proceed, with the options listed in Carrying the Demo section. Otherwise follow Carrying the Demo section, with `old=` set to the old body file and `new=` set to the new body file. Then remove the old file:

  ```bash
  rm -f "$OLD_BODY_FILE"
  ```

  **Apply.** Only after `status=ok` or `status=absent`. The carry step edits the body file in place, so the apply step is the same:

  ```bash
  gh pr edit --title "<title>" --body "$(cat "<body_file>")"
  ```

- If **no** -- skip Step 6 entirely and finish. Do not run evidence capture when the user declined the rewrite.

### Step 8: Report

Output the PR URL.

When this run published evidence images, print the command that fits the outcome. Take `<N>` from the PR URL:

- `status=ok`: print the zero-path command, marked as recommended before merge:

  > Recommended before merge: load `systematic:pr-attachments` with no tokens (or with `pr:<N>`). It re-checks the embed pins and offers to remove the evidence images from the branch.

- `status=failed` with `evidence=pushed` and `reason=verify-failed`, or any other pushed state in which the Demo section was not written: print a retry command instead. The zero-path command re-pins and cleans up, and there is nothing to re-pin yet. The retry is to load `systematic:pr-attachments` with the same image paths and `pr:<N>`. It reuses the pushed commit, verifies the embeds and writes the description. Do not print the zero-path command until a publish succeeds.
- `status=failed` with `evidence=local`: say that the evidence commit is local and unpushed, so the branch needs a push first, and print no re-run command. For `reason=blob-mismatch` say instead that the local evidence commit holds an altered image and must not be pushed as it is.

---

## Carrying the Demo section

A description rewrite replaces the whole body, so a `## Demo` section in the current description has to be carried into the new one. Both rewrite paths, the Description Update workflow and the existing-PR path of Step 7, first save the current description to an old body file, and then follow this section. The carry always runs, whatever the old description holds: `status=absent` is a success and leaves the new file untouched.

Load the `systematic:pr-attachments` skill in carry mode. State the tokens in the instruction text only, because some hosts pass no skill arguments and the same tokens in two places would be read twice: `mode:carry old=<old body file> new=<new body file>`, with the real paths from this run. Wrap a path that has spaces in double quotes. Carry mode edits the new body file in place. It never touches the PR.

The skill ends with one status line, `pr-attachments: status=<ok|absent|failed> [reason=<reason>]`.

- `status=ok` or `status=absent`: apply the new body file.
- `status=failed`, a skill that fails to load, a skill that prints no status line, or the setup stops: the carry failed. Do not apply the rewritten body, and do not write a `## Demo` section by hand. The PR description stays as it is. Report the reason (the `reason` on the status line, or what stopped the setup) and ask the user how to proceed. Offer only these options: retry the carry, apply the rewritten body without a Demo section after an explicit yes, or keep the current description.
