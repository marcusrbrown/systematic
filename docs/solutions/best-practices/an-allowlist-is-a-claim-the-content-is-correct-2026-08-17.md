---
title: An allowlist is a claim that the rejected content is correct
date: 2026-08-17
category: best-practices
module: content-integrity
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "A new or tightened fail-closed gate rejects pre-existing content"
  - "The proposed remedy is an allowlist, exemption, or suppression entry"
  - "The rejected content is an example intended for readers or downstream users"
  - "Content may depend on capabilities the package does not itself ship"
tags:
  - allowlist
  - content-integrity
  - fail-closed
  - gate-design
  - root-cause
---

# An allowlist is a claim that the rejected content is correct

## Context

A new fail-closed gate, `checkDispatchIdentifiers` in `scripts/content-integrity.ts`, requires every `subagent_type` value in bundled content to resolve to a bundled agent filename stem.

It immediately failed on `skills/using-systematic/references/opencode-profile.md`, which demonstrated dispatch with `explorer` and `fixer`. The first response was to add an allowlist constant so those values would pass.

That was the wrong branch. Neither agent ships in this package:

```bash
ls agents/*/explorer.md agents/*/fixer.md
# No such file or directory
```

They came from the maintainer's own OpenCode configuration. The examples worked when *he* read them and failed for everyone else — a reader without those agents would copy the snippet and get an unresolvable dispatch. The gate was right; the content was wrong.

The correction deleted the allowlist constant, its two call sites, a helper function, and its documentation, and changed the examples to bundled agents. The fix removed code rather than adding it.

## Guidance

When a new gate fails on pre-existing content, there are exactly two hypotheses:

1. The gate is too strict.
2. The content is wrong.

**An allowlist silently selects the first.** Writing one asserts that the rejected content is correct and the gate should tolerate it. That assertion deserves the same scrutiny as any other claim about the codebase — it is easy to make, permanent once written, and it conceals the defect it tolerates.

Rule out hypothesis 2 before writing the entry. For a reference gate, that means checking whether the referenced thing exists:

```bash
for name in explorer fixer; do
  ls agents/*/"$name".md >/dev/null 2>&1 || echo "not bundled: $name"
done
```

This is not an argument against allowlists. Existing ones in this repo are legitimate — `scripts/.drift-allowlist.json` preserves historical fidelity in third-party skills with a required reason field, and trust-boundary allowlists are how the config overlay stays fail-closed. What distinguishes those from this case is that each documents an *intentional* exception. The narrow rule:

> Do not use an allowlist to avoid deciding whether the rejected content is actually wrong.

A useful tell: if the allowlist entry would need a reason field and you cannot write a truthful one beyond "the gate flags it," you are exempting a defect.

## Why This Matters

The gate found a real bug on its first run — a documented example that could not work for its audience. Adding the allowlist would have converted that signal into permanent silence, and the example would have stayed broken indefinitely with a config entry asserting it was fine.

There is a second cost. An allowlist is a maintenance surface: an entry to keep current, a constant to discover, and an exception every future reader has to reason about. Fixing two example values removed all of it. When the correct fix deletes code and the workaround adds it, that asymmetry is itself evidence about which hypothesis was right.

## When to Apply

- A validation gate is introduced or tightened and pre-existing content fails for the first time.
- The proposed remedy is an exemption, suppression comment, allowlist entry, or a widened pattern.
- The failing content is an example, template, or documentation snippet — anything a reader is meant to copy. These fail silently for the reader, not for you.
- The content depends on something present in your environment but not in the package.

## Examples

**Wrong sequence:**

```text
new gate rejects `subagent_type: explorer`
→ add `explorer` to HOST_PROVIDED_AGENT_STEMS
→ gate passes, example stays broken for every reader
```

**Right sequence:**

```text
new gate rejects `subagent_type: explorer`
→ check: does agents/*/explorer.md exist?  no
→ conclude: the example cannot work for anyone without that host config
→ replace with a bundled agent
→ gate stays fail-closed with no exception to maintain
```

**The diff shapes differ, and that is the signal:**

```diff
- export const HOST_PROVIDED_AGENT_STEMS: ReadonlySet<string> = new Set([
-   'explorer',
-   'fixer',
- ])
```

```diff
- subagent_type: "explorer",
+ subagent_type: "repo-research-analyst",
```

## Related

- [`docs/solutions/best-practices/content-integrity-has-no-warning-channel-2026-06-06.md`](content-integrity-has-no-warning-channel-2026-06-06.md) — gates here fail closed or do nothing, which is why an exemption is the only escape valve and why writing one deserves scrutiny.
- [`docs/solutions/best-practices/third-party-bundled-skills-light-adaptation-2026-05-17.md`](third-party-bundled-skills-light-adaptation-2026-05-17.md) — the contrasting case: drift-allowlist entries that are legitimate because they preserve intentional historical fidelity and carry a reason.
- [`docs/solutions/best-practices/neutral-v1-marker-migrated-set-identifier-gate-2026-07-17.md`](neutral-v1-marker-migrated-set-identifier-gate-2026-07-17.md) — exemptions in a lexical gate kept deliberately narrow and identifier-aware.
- [`docs/solutions/best-practices/qualified-persona-ids-are-canonical-validated-references-2026-07-17.md`](qualified-persona-ids-are-canonical-validated-references-2026-07-17.md) — the same gate family; its addendum covers the inverse failure, where unvalidated forms rot unnoticed.
