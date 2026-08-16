---
title: gh api PR/issue body with heredoc escapes backticks visibly
module: scripts (PR/issue authoring)
date: 2026-05-17
last_updated: 2026-08-16
problem_type: developer_experience
component: tooling
severity: low
tags:
  - gh-cli
  - heredoc
  - bash-quoting
  - pr-body
  - github-api
applies_when:
  - Authoring PR or issue body content via `gh api -X POST ... -f body=...` with a shell heredoc
  - Using `gh pr create --body "$(cat <<EOF ... EOF)"` patterns
  - Migrating existing PR-creation scripts and seeing escaped backticks render on GitHub
  - Passing any multi-line message body through a shell, including `git commit -m`
---

# gh api PR/issue body with heredoc escapes backticks visibly

## Context

When `gh pr create` fails to GraphQL rate limits, the documented workaround is the REST API path: `gh api -X POST repos/<owner>/<repo>/pulls -f body=...`. The simplest way to assemble a multi-line body is a heredoc.

There's a subtle bash trap here that GitHub renders visibly in the PR body. The escape requirements depend on the heredoc's quoting style, and getting it wrong means the rendered Markdown shows literal backslashes everywhere inline code and code fences should be.

This bit twice during the v2.19.0 release sprint — once on PR #401's initial body, then again before the squash-commit body was finalized. The fix is mechanical once you see the pattern. The trap is that the heredoc looks plausible and the failure surfaces only after the PR is created.

## Guidance

**For `gh api -F body=...` (and any `-f body=`) content, prefer the temp-file pattern over inline heredoc command substitution. Write the body to a file with a single-quoted heredoc using zero backtick escapes, then pass `-F body=@FILE`.**

The single-quoted heredoc (`<<'EOF'`) suppresses ALL shell interpretation including command substitution, so backticks need no escape. The `-F body=@FILE` form reads the file verbatim without further interpretation. Together they remove every escape concern.

If you must use inline command substitution (`--body "$(cat <<EOF ... EOF)"`), the heredoc quoting matters:

| Heredoc form | Backticks | Triple-backtick fence |
|---|---|---|
| `<<'EOF'` (single-quoted) | Literal — DO NOT escape | Literal — DO NOT escape |
| `<<EOF` (unquoted) | Command substitution — MUST escape with `` \` `` | Must escape every backtick |

The most common mistake is using `<<'EOF'` (correct quoting) but then ALSO escaping backticks out of habit, producing visible backslashes in the rendered output.

## Why This Matters

GitHub renders the literal backslash in the PR body as a visible character. A PR body that should show:

````
```yaml
deprecated:
  since: v2.19.0
```
````

...instead shows:

````
\`\`\`yaml
deprecated:
  since: v2.19.0
\`\`\`
````

The PR description loses its formatted code blocks. Inline code references like `` `orchestrating-swarms` `` render as `` \`orchestrating-swarms\` ``. The review reads as if the author can't write Markdown, which undermines the value of detailed PR descriptions.

The fix is gh `api -X PATCH repos/.../pulls/N -F body=@FILE` after the fact, but the cleaner habit is to use the temp-file pattern up front.

## When to Apply

- Whenever authoring PR or issue bodies that contain Markdown code blocks via `gh` CLI
- When authoring release notes via `gh release create --notes-file` or `gh release edit --notes-file`
- When authoring squash-commit messages via `gh pr merge --body-file`
- Whenever a generated body is more than a few lines and includes any backticks

## Examples

### Wrong: single-quoted heredoc with escaped backticks (looks safe, isn't)

```bash
gh api -X POST repos/owner/repo/pulls \
  -f title="..." \
  -f head="..." \
  -f base="main" \
  -f body="$(cat <<'EOF'
Run \`bun test\` first.

\`\`\`yaml
deprecated:
  since: v2.19.0
\`\`\`
EOF
)"
```

Single-quoted heredoc suppresses interpolation already. The backslashes survive verbatim into the API payload. GitHub renders them.

### Right: temp-file with single-quoted heredoc, no backtick escapes

```bash
BODY_FILE=$(mktemp -t pr-body-XXXXXX.md)
cat > "$BODY_FILE" <<'EOF'
Run `bun test` first.

```yaml
deprecated:
  since: v2.19.0
```
EOF

gh api -X POST repos/owner/repo/pulls \
  -f title="..." \
  -f head="..." \
  -f base="main" \
  -F body=@"$BODY_FILE"

rm -f "$BODY_FILE"
```

Backticks land as literal backticks. Code fences render correctly. No escape thinking needed.

### Right: inline unquoted heredoc with proper escapes

```bash
gh api -X POST repos/owner/repo/pulls \
  -f title="..." \
  -f head="..." \
  -f base="main" \
  -f body="$(cat <<EOF
Run \`bun test\` first.

\`\`\`yaml
deprecated:
  since: v2.19.0
\`\`\`
EOF
)"
```

Unquoted heredoc DOES interpolate, so the escapes are necessary here to preserve backticks as literals. Equivalent output, but more fragile — any future contributor who adds `$VAR` or `$(cmd)` content has to keep track of two different escape rules in the same heredoc.

### Same trap, different command: `git commit -m`

The backtick rule is not a `gh` rule — it is a shell rule, and it bites hardest where there is no rendering step to make the damage obvious. In a double-quoted `git commit -m "..."`, backticks are command substitution. They are evaluated and their contents vanish. Git records whatever is left, silently and with exit code 0.

```bash
# Wrong: inside double quotes, every backtick-wrapped identifier is
# executed as a command and its output (nothing) is substituted in.
git commit -m "`origin/main` bumped `@opencode-ai/sdk` to 1.18.18."
```

The recorded body becomes:

```text
 bumped  to 1.18.18.
```

No error, no warning — just broken prose in permanent history. This repo squash-merges with `squash_merge_commit_message: COMMIT_MESSAGES`, so a mangled branch commit body is concatenated into the public squash commit and flows onward into release notes.

```bash
# Right: write the message to a file, commit with -F.
MSG_FILE=$(mktemp -t commit-msg-XXXXXX.txt)
cat > "$MSG_FILE" <<'EOF'
build(evals): move host pin to OpenCode 1.18.18

`origin/main` bumped `@opencode-ai/plugin` and `@opencode-ai/sdk` to 1.18.18,
which trips the host-pin drift guard this branch introduced.
EOF

git commit -F "$MSG_FILE"
git log -1 --format=%B    # verify the backticks and blank lines survived
rm -f "$MSG_FILE"
```

Recovery is disproportionately expensive relative to the mistake. Fixing an already-pushed mangled body means rewriting history — rebuild the branch on its base, re-commit with `-F`, prove the resulting tree is byte-identical to the original, then `git push --force-with-lease` and wait out a full CI re-run. Writing the message to a file the first time costs one extra line.

### Verification after PR creation

```bash
gh pr view N --json body --jq '.body' | grep -c '\\`'
# Should print: 0
# If it prints anything else, the body has escape damage — patch via:
gh api -X PATCH repos/owner/repo/pulls/N -F body=@FILE
```

## Related

- `docs/solutions/developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md` — sibling lesson from the same release; both about `gh` CLI body content for PRs and releases
- [`docs/solutions/workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md`](../workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md) — the other half of squash-merge message hygiene: the header decides whether a release happens at all
- PR #401 — where the trap was caught mid-flight
- PR #786 / commit `932be10` — where the same trap hit `git commit -m` and cost a history rewrite
