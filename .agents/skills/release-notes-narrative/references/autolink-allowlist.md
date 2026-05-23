# Autolink Strip Rules

## The v2.21.0 Failure Mode

Commit bodies sometimes contain autolinked cross-references in the form:

```
closes [fro.bot/systematic/reference/configuration#typed-validation](https://github.com/fro.bot/systematic/reference/configuration/issues/typed-validation)
```

semantic-release's `@semantic-release/release-notes-generator` scans the raw text of commit bodies for `Closes #N` footers. When a commit body contains a `path#fragment` substring — as in `reference/configuration#typed-validation` — the generator misparses the fragment as a numeric issue reference, producing malformed release notes that reference nonexistent issue numbers or corrupt the changelog entry entirely.

The fix is to strip these autolinks from the rendered body before passing it to the generator. The strip must be surgical: it should remove only the links that trigger the misparse, leaving all other markdown links intact.

## The Four-Condition Allowlist

A link is stripped only when **all four** of the following conditions hold:

**(a)** The link is parsed from the rendered body's markdown AST as a discrete `[text](url)` node — not matched via raw-string regex over the body. Regex sweeps fail on multiline content and nested markdown; AST traversal is the only reliable approach.

**(b)** The link text equals the URL's last path segment, or contains the last path segment as a single-line substring. This catches both the compact form `[typed-validation](.../issues/typed-validation)` (text equals the segment) and the verbose form `[fro.bot/systematic/reference/configuration#typed-validation](.../issues/typed-validation)` (text contains the segment).

**(c)** The target URL, after stripping any query string or fragment, matches the shape:

```
https://github.com/<path-with-zero-or-more-slashes>/issues/<segment>
```

where `<segment>` contains at least one non-digit character. Purely-numeric segments (e.g., `/issues/42`) do not satisfy this condition.

**(d)** The link is the immediate next AST sibling after a text node ending with the literal token `closes` (case-insensitive, optionally preceded by `,` or `;`, with optional whitespace between). "Immediate next sibling" is per markdown AST node order, not raw-string proximity.

## Worked Examples

### Positive — MUST strip

**Example 1 — the v2.21.0 shape**

Commit body fragment:

```
closes [fro.bot/systematic/reference/configuration#typed-validation](https://github.com/fro.bot/systematic/reference/configuration/issues/typed-validation)
```

Condition check:
- (a) AST contains a link node with text `fro.bot/systematic/reference/configuration#typed-validation` and href `https://github.com/fro.bot/systematic/reference/configuration/issues/typed-validation` ✓
- (b) Link text `fro.bot/systematic/reference/configuration#typed-validation` contains the last path segment `typed-validation` as a substring ✓
- (c) Bare URL `https://github.com/fro.bot/systematic/reference/configuration/issues/typed-validation` matches the shape; segment `typed-validation` contains non-digit characters ✓
- (d) Preceding text node ends with `closes` ✓

Result: link stripped, leaving the plain text `closes` in the body.

---

**Example 2 — non-trivial path depth**

Commit body fragment:

```
closes [docs/foo#section-bar](https://github.com/marcusrbrown/example/issues/section-bar)
```

Condition check:
- (a) AST link node present ✓
- (b) Link text `docs/foo#section-bar` contains the last path segment `section-bar` as a substring ✓
- (c) Bare URL matches shape; segment `section-bar` contains non-digit characters ✓
- (d) Preceding text node ends with `closes` ✓

Result: link stripped.

---

### Negative — MUST preserve

**Example 3 — purely-numeric segment, condition (c) fails**

```markdown
Closes [#42](https://github.com/anomalyco/opencode/issues/42)
```

The last path segment is `42`, which contains no non-digit characters. Condition (c) fails. Link preserved.

---

**Example 4 — no `closes` prefix, condition (d) fails**

```markdown
See the related [typed-validation](https://github.com/marcusrbrown/systematic/issues/typed-validation) issue for context.
```

The AST sibling preceding the link node is a text node ending with `the related`, not `closes`. Condition (d) fails. Link preserved.

---

**Example 5 — `closes` not the immediate AST predecessor, condition (d) fails**

```markdown
The refactor closes the loop. See [the docs](https://github.com/foo/bar/issues/explanation).
```

The word `closes` appears in the paragraph, but the immediate preceding sibling of the link node is the text `See `, not a node ending with `closes`. Condition (d) requires the link to be the immediate next sibling after a text node ending with `closes`. Condition (d) fails. Link preserved.

---

**Example 6 — query params present; bare segment is numeric, condition (c) fails**

```
https://github.com/foo/bar/issues/42?ref=main
```

Strip query string before evaluating: bare URL is `https://github.com/foo/bar/issues/42`. Last segment is `42`, purely numeric. Condition (c) fails. Link preserved.

---

**Example 7 — link text contains the word `closes` but is unrelated to the URL segment, condition (b) fails**

```markdown
[closes the loop](https://github.com/foo/bar/issues/explanation)
```

Link text is `closes the loop`. Last URL segment is `explanation`. The text neither equals `explanation` nor contains it as a substring. Condition (b) fails. Link preserved.

---

## Implementation Note

Parse the rendered commit body once with a markdown AST library (e.g., `remark` with `remark-parse`, or a CommonMark-compliant parser). Walk the tree, collect link nodes, and evaluate each against conditions (a)–(d) in order. Drop nodes that satisfy all four.

Do not use a single regex sweep over the raw body string. The v2.21.0 failure mode is exactly that kind of overgeneralization — a regex that matched `path#fragment` substrings regardless of surrounding context. AST traversal gives precise sibling relationships and avoids false positives on nested or multiline markdown.
