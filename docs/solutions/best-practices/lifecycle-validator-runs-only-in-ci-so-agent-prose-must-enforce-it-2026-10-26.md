---
title: Restate CI-only validator rules in agent prose at the step that acts on each pointer
date: 2026-10-26
category: best-practices
module: content-integrity
problem_type: best_practice
component: assistant
related_components:
  - tooling
severity: high
applies_when:
  - A rule is enforced by a script in Systematic's own CI but ships to user repos only as skill or agent instructions
  - Agent prose follows, resolves or deletes by reference, such as a path-valued frontmatter field
  - Changing checkSolutionLifecycle or the solution-doc lifecycle fields
tags:
  - lifecycle
  - superseded-by
  - agent-prose
  - validator-parity
  - learnings-researcher
  - compound-refresh
---

# Restate CI-only validator rules in agent prose at the step that acts on each pointer

## Context

A solution doc can be marked `status: superseded` and name its successor in `superseded_by`. In this repo, `checkSolutionLifecycle` (`scripts/content-integrity.ts:2011-2046`) checks on every CI run that the successor is named by repo-root path, exists, parses, and is not itself superseded.

That validator never runs in a user's repo. There, the same rules are enforced twice, and only one of the two is code. The `systematic_search` tool resolves the lifecycle in code (`resolveLifecycle` in `src/lib/search-core.ts`, with the same 5-hop cap, visited set and form rule). The learnings-researcher calls the tool first, and its grep steps (Step 4's successor walk) are the fallback when search has no hits, is disabled, errors or is absent. ce-compound-refresh's Lifecycle Consistency rules stay prose only. The refresh skill says so (`skills/ce-compound-refresh/SKILL.md:542`). Prose that states only the outcome, "a superseded doc points at a live successor", leaves out the checks that make it true.

Both resolvers answer an unresolvable successor the same way. The matched superseded doc is kept at its own rank with `Caution: successor unresolved`. The researcher used to omit such a doc and report it on a `Skipped:` line, and that label is retired. A reader still sees the doc and learns that its pointer is broken.

## Guidance

Write each check as a step at the point where the agent acts on a pointer.

1. **Check form and existence at every hop.** `classifySupersededBy` (`scripts/content-integrity.ts:1949`) rejects a target outside the solution-file set as `dangling-superseded-by`. The researcher runs the same check before any target becomes the successor, and says why a search miss proves nothing (`agents/research/learnings-researcher.md:144`, quoted with an elision):

   ```md
   2. At every hop, before taking the target as the successor, check that it passes the form rule above and that the file exists. [...] A target that did not match the search is not evidence that it exists, because most active docs have no `status` line.
   ```

2. **Read lifecycle fields from parsed frontmatter, and use search only to find files.** Values lifted from matched lines misread `status: superseded # retired`, folded scalars and `status:` lines inside a body example. The researcher's Step 4 uses search only to choose files, then reads each doc's frontmatter (`agents/research/learnings-researcher.md:119-131`).

3. **Write out the exclusions.** The validator's solution set leaves out every `README.md` (`scripts/content-integrity.ts:2019-2024`). The researcher's form rule names that exclusion and also skips `_archived/` as a defensive check, even though no such directory exists here (`agents/research/learnings-researcher.md:141`).

4. **Delete only after every prerequisite write succeeded.** Refresh retargets `superseded_by` before Replace or Consolidate removes a doc, and it removes the doc only once the survivor exists and every write succeeded. That rule overrides autofix's record-and-continue rule (`skills/ce-compound-refresh/SKILL.md:546`).

5. **Bound and order every cascade.** A plain Delete collects the pointing docs transitively with a visited set. It defers the whole Delete when any of them must remain. Otherwise it deletes the farthest dependents first and the target last, and stops at the first failure (`skills/ce-compound-refresh/SKILL.md:547`).

## Why This Matters

Steps 1, 4 and 5 keep the pointers that the validator's `dangling-superseded-by` and `successor-superseded` classes check from breaking. Steps 2 and 3 make the prose read the corpus the way the validator does. In a user repo nothing reports a miss, so a gap in the prose becomes a silent wrong answer: a deleted successor returned as live guidance, or a retired doc pointing at a file that no longer exists.

Prose cannot enforce "no dangling pointer" after the fact. It can only order its steps so that every pointer's target outlives the pointer.

## When to Apply

- Adding or changing a rule in `checkSolutionLifecycle` or `classifySupersededBy`. Check that the researcher's Step 4 and refresh's Lifecycle Consistency still state it.
- Changing the hop cap, the successor form rule or the unresolved-caution text in `src/lib/search-core.ts`. The researcher's Step 4 fallback has to say the same, and no gate compares the two, so review the prose by hand.
- Writing any agent instruction that dereferences a path-valued frontmatter field.
- Writing any agent instruction that deletes files that other files point at.
- When the prose is deliberately more lenient than the validator, say so next to the rule in the prose, so the next change does not "fix" it.

## Examples

One rule, two behaviours on purpose. The validator forbids a chain (`scripts/content-integrity.ts:1987-1992`):

```ts
if (successor.status === 'superseded') {
  return {
    class: 'successor-superseded',
    // ...
  }
}
```

The researcher follows one, for up to 5 hops with a visited set, because a repo that never ran the validator can contain chains (`agents/research/learnings-researcher.md:146`):

```md
4. Read the target's frontmatter and take its `status`. If it is `superseded`, follow its `superseded_by` and repeat from step 2.
```

## Related

- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md`: the opposite direction, where a gate must mirror what the runtime parser actually does.
- `docs/solutions/runtime-errors/circular-yaml-alias-aborts-content-integrity-report-2026-10-26.md`: reporting circular YAML values in `checkSolutionLifecycle` and the other frontmatter checks without throwing.
- `docs/solutions/logic-errors/frontmatter-close-delimiter-must-be-a-whole-line-2026-10-30.md`: a value ending in `---` closed the frontmatter early and dropped `status` and `superseded_by`; a regression test asserts such a superseded doc resolves to its successor.
