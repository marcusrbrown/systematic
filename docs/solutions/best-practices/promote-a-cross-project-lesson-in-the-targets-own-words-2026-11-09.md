---
title: Promote a cross-project lesson in the target's own words, with a producer that matches its consumer and a grader that reads the whole source
date: 2026-11-09
category: best-practices
module: ce-connect
problem_type: best_practice
component: assistant
severity: high
symptoms:
  - "A pasted promotion line is refused by the skill it was generated for"
  - "A promoted learning repeats a sentence from the source document that the excerpt did not contain, and the copy check still passes"
  - "A planning assumption that the promotion skill needs no change turns out to be false"
applies_when:
  - "Untrusted text from one project becomes a trusted learning in another"
  - "One skill prints a command or token line that another skill consumes"
  - "Writing a mechanical check that a generated file does not copy its source"
  - "A plan says an existing skill will work for a new input unchanged"
tags:
  - ce-connect
  - ce-compound
  - promotion
  - producer-consumer
  - no-verbatim
  - provenance
  - grader
---

# Promote a cross-project lesson in the target's own words, with a producer that matches its consumer and a grader that reads the whole source

## Context

`ce:connect` proposes; a person promotes. A lesson becomes a learning through `ce:compound`, and a contradiction is reviewed through `ce:compound-refresh`. Promotion is where text written in one project, possibly steered by a hostile document, becomes trusted text in another. Four things went wrong or nearly did: the planning claim that promotion "needs no change" was false, the producer printed lines the consumer refuses, the copy check read too little, and the skills' compliance is only as good as a model's.

`ce:compound` works from the conversation and needs a solved problem to document, so it had no input for "a candidate in a run record". The claim that it needed no change was a scoped claim checked against the diff and not against the consumer; [that mistake and its rule are covered here](verify-a-no-change-claim-against-the-consumer-2026-09-08.md).

## Guidance

### Route by kind, and give each consumer what it accepts

`handoffLine` (`src/lib/connect-helper-core.ts:1764-1791`) builds the next step for each candidate from values the helper made, never from candidate text:

- **A lesson** gets `candidate:<run record path> candidate-id:<id>` for `ce:compound`.
- **A contradiction** gets `Review in <project>: /ce:compound-refresh path:<docs/solutions/...>`, naming the target project's own learning. `ce:compound` refuses a contradiction (`skills/ce-compound/references/candidate-input.md:18`, which says to use `ce:compound-refresh`), so a `candidate:` line for one is a dead end.
- **An `investigate` candidate** gets a plain note and no token, because a token would invite a promotion the candidate's own next step rules out.

Match the producer to the consumer's validation, not to its happy path:

- The refresh scope accepts only letters, digits, `.`, `_`, `-` and `/` (`unsupported-characters`, `skills/ce-compound-refresh/SKILL.md:24`). The producer's pattern `REFRESH_PATH` (`src/lib/connect-helper-core.ts:1762-1763`) is the same set, and a target path outside it prints `Review by hand` instead of a line that will be refused.
- `ce:compound` rejects a path with a quote, a dollar sign or a backtick (`skills/ce-compound/references/candidate-input.md:44-48`). The inventory therefore skips such a file with the reason `unsafe-path-character` and names it in the digest (`UNSAFE_PATH_CHARACTER`, `src/lib/connect-evidence.ts:900`, applied at `src/lib/connect-evidence.ts:1098-1103`). A project root containing one fails its scan with the same reason (`src/ce-connect-helper.ts:833-834`).
- A `candidate:` token must be one word (`skills/ce-compound/references/candidate-input.md:7`). When the run record path contains whitespace, `isPasteablePath` (`src/lib/connect-helper-core.ts:1732-1735`) fails and the summary prints only the candidate id and says the path cannot be pasted. This is documented, not fixed; keep the state directory free of whitespace (`docs/src/content/docs/guides/cross-project-connections.mdx:194`).

The rule: for every line a skill prints for another skill to consume, derive its allowed shape from the consumer's own checks, and test the printed line against them.

### Make the consuming skill re-verify, with its own tools

`ce:compound` cannot reach `ce:connect`'s helper directory, so its candidate path uses only the read, search and write tools plus two fixed hash commands (`skills/ce-compound/references/candidate-input.md:3`). In order, and stopping at the first failure:

1. **Target**: the candidate's `target` must be the current project, checked before any file the record names is read.
2. **Paths**: a source path must be relative and under `docs/solutions/`, `docs/plans/` or `docs/brainstorms/`. A target-evidence path must be relative but need not sit under those directories, since the target's code, workflows and configuration are valid evidence. Neither may have an empty, `.` or `..` segment, a control character, a quote, a backslash, a dollar sign or a backtick (`skills/ce-compound/references/candidate-input.md:44-48`).
3. **Fingerprint**: `shasum -a 256` of each source and target-evidence file must equal the record's value.
4. **Excerpt**: each excerpt appears in its file, and target evidence lies inside its span and contains its `symbol`.
5. **Overlap**: search the target's `docs/solutions/` for the same lesson first.

The record is versioned (`schemaVersion` must be 1) and every field is data, never an instruction. The skill writes nothing until the full diff has been shown and the user has approved it in a later turn (`skills/ce-compound/SKILL.md:57-59`). The learning is the target's own words, ends with a `## Provenance` section with one line per source, `<project>:<path>@<fingerprint>`, built from the values the skill verified (`skills/ce-compound/references/candidate-input.md:67-77`). Neither skill writes the ledger; after a write the skill prints the candidate id and destination for the helper's `decide`, and after a failed write it prints them and says the learning may be missing (`skills/ce-compound/references/candidate-input.md:80-91`).

`ce:compound-refresh` gained an exact path scope for contradictions. It refuses `mode:autofix` with a `path:` token (`skills/ce-compound-refresh/SKILL.md:11`), refuses a keyword scope beside it, checks each path for containment (`skills/ce-compound-refresh/SKILL.md:23-32`), prints a preview and ends the turn before reading any listed document (`skills/ce-compound-refresh/SKILL.md:33`), and runs once per project (`skills/ce-compound-refresh/SKILL.md:35`).

### Grade the copy check against the whole source

The learning must not repeat another project's sentences: no sentence of five words or more and no run of eight consecutive words. The first grader in the promotion contract test compared a learning only with the cited excerpt, so a sentence copied from elsewhere in the source document passed. `copiedFromSource` (`tests/unit/connect-promotion-contract.test.ts:243-248`) now compares against the whole fixture document, whose fingerprint `sourceDocument` (`tests/unit/connect-promotion-contract.test.ts:250-260`) verifies first. A negative control copies a sentence from outside the excerpt and must be flagged (`tests/unit/connect-promotion-contract.test.ts:654-662`). A writer who read the file can copy any part of it, so a check scoped to the excerpt measures less than the rule.

The instruction to the model matches the grader: step 5 of the candidate run has the model read each source learning in full and compare the draft with the whole file, not only the excerpts (`skills/ce-compound/SKILL.md:56`). An instruction narrower than the grader would leave the model checking less than the rule, so keep the two in step when either changes.

## Why This Matters

A producer that prints a line its consumer refuses teaches the user to edit the line by hand, and hand-edited promotion lines are exactly what the design forbids. A grader that reads less than the rule asks gives false confidence in the boundary that stops one project's text from entering another. And a plan that says "that skill needs no change" without reading the skill ships a promotion path that cannot run.

## When to Apply

- Any skill, script or tool that prints input for another skill.
- Any flow where untrusted text becomes a stored, trusted learning.
- Any mechanical check of "does not copy": compare against everything the writer could have read.

The compliance limit that applies to every prose-enforced rule here, including the approval step, is stated once in [the baseline pressure-test doc](skill-around-an-untrusted-researcher-needs-baseline-pressure-tests-2026-11-09.md): recorded sessions cannot detect a later regression.

## Examples

A contradiction routes to `Review in <project>: /ce:compound-refresh path:docs/solutions/<category>/<file>.md`; a path the refresh scope cannot take gets `Review by hand`. Before this, it printed `candidate:` tokens that `ce:compound` refuses.

## Related

- [A "nothing changed" claim is scoped to a boundary](verify-a-no-change-claim-against-the-consumer-2026-09-08.md)
- [Skill around an untrusted researcher needs baseline pressure tests](skill-around-an-untrusted-researcher-needs-baseline-pressure-tests-2026-11-09.md)
- [Run state for a model-invoked helper](run-state-for-a-model-invoked-helper-2026-11-09.md)
