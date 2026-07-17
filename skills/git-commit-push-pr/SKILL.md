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

Read the current PR description to drive the compare-and-confirm step later:

```bash
gh pr view --json body --jq '.body'
```

**Generate the updated title and body** — using the PR URL from DU-2 and the commit range it covers, write an updated PR title and body. The URL preserves repo/PR identity even when invoked from a worktree or subdirectory. If the user provided a focus (e.g., "include the benchmarking results"), incorporate it into the generated content. Write the body to an OS temp file:

```bash
BODY_FILE=$(mktemp /tmp/pr-body-XXXXXX.md)
cat > "$BODY_FILE" << 'EOF'
<generated body>
EOF
```

If the PR is not open or the commit range cannot be resolved, report the issue and stop.

**Evidence decision:** Preserve any existing `## Demo` or `## Screenshots` block from the current body by default. If the user's focus asks to refresh or remove evidence, honor that intent.

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
3. Stage and commit each group in a single call. Avoid `git add -A` or `git add .`. Follow conventions from Step 2:
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
- **Skip** -- proceed with no evidence section.

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
- Splice any captured evidence as a `## Demo` section into the body file before applying.

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

- If **yes**, run Step 6 now to generate the title and body file (passing the existing PR URL for context), then apply:

  ```bash
  gh pr edit --title "<title>" --body "$(cat "<body_file>")"
  ```

- If **no** -- skip Step 6 entirely and finish. Do not run evidence capture when the user declined the rewrite.

### Step 8: Report

Output the PR URL.
