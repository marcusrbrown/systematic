---
title: gh api PR/issue body with heredoc escapes backticks visibly
module: scripts (PR/issue authoring)
date: 2026-05-17
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

### Verification after PR creation

```bash
gh pr view N --json body --jq '.body' | grep -c '\\`'
# Should print: 0
# If it prints anything else, the body has escape damage — patch via:
gh api -X PATCH repos/owner/repo/pulls/N -F body=@FILE
```

## Related

- `docs/solutions/developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md` — sibling lesson from the same release; both about `gh` CLI body content for PRs and releases
- PR #401 — where the trap was caught mid-flight
