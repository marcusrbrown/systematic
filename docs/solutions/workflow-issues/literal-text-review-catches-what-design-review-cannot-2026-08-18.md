---
title: When prose is the enforcement mechanism, read it literally as a separate pass
date: 2026-08-18
category: workflow-issues
module: code-review
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A contract, gate, or workflow rule is expressed in prose rather than code"
  - "A new rule carries a backward-compatibility exception for artifacts created before it existed"
  - "A rule distinguishes an absent thing from an invalid present thing"
tags:
  - code-review
  - workflow-contract
  - prose-enforcement
  - backward-compatibility
  - review-coverage
---

# When prose is the enforcement mechanism, read it literally as a separate pass

## Context

A change added a workflow rule: work execution refuses a plan whose prior-art survey is empty, unaccepted, or stale — but proceeds when the plan has no survey section at all, because such a plan predates the contract. That exemption is load-bearing; without it, every previously written plan becomes unexecutable.

Nine specialist review personas examined the branch. They found real defects: an exemption that defeated its own gate, a stop condition with no recorded evidence, a missing version discriminator, a contract restated across three surfaces.

An automated reviewer then read the shipped paragraph and found something none of the nine had:

> If the plan has a `Prior-Art Survey` section, validate it before environment setup. For a qualifying plan, a missing section or a section without exactly one fenced `json` block is a contract failure. […] stop before setup when any of these conditions applies:
> 1. **Missing or non-unique survey block:** the section is absent, empty, or …

The first sentence scopes validation to plans that *have* the section. The second calls a missing section a contract failure. The first condition lists "the section is absent" as a stop.

Both readings are supported by the text. One of them makes every pre-existing plan unexecutable — the exact outcome the exemption existed to prevent.

## Guidance

**Design review and literal-text review find different defect classes. Running one does not cover the other.**

Design review asks whether the mechanism is right, where it breaks, what it costs, what it misses. The nine personas did this well, and the design *was* right — the intended behavior was coherent and correctly motivated.

Literal-text review asks a narrower question: taken as written, sentence by sentence, can all of this be true at once? That question is uninteresting for code, because a compiler answers it. It is the only question that matters for prose that governs behavior, because nothing else will.

When prose is the enforcement mechanism, add an explicit pass that reads the final wording as an executable contract, separate from reviewing the design behind it.

## Why This Matters

A contradiction in prose does not fail loudly. It resolves differently depending on who reads it, which means behavior varies by reader while every individual reading looks defensible. For instructions consumed by agents, that variance is invisible until it produces divergent outcomes across sessions.

The reviewers were looking at the design through it. They were the wrong instrument for the question, not inattentive.

## When to Apply

Run a literal-text pass when any of these hold:

- Prose *is* the enforcement mechanism, with no code path behind it.
- A new rule carries a backward-compatibility exception.
- A rule distinguishes **absent** from **present but invalid** — this pairing produced the defect here and is a recurring trap.
- The text contains "all", "only", "exactly", "must", "unless", or "otherwise", each of which partitions behavior.
- Multiple reviewers approved the design and none quoted the actual wording back.

## Examples

**Ambiguous — two supported readings:**

> If the plan has a survey section, validate it. A missing section is a contract failure. Stop when: the section is absent, empty, or malformed.

**Unambiguous — the partition is explicit and total:**

> If the plan has no survey section at all, it predates this contract — proceed without rejecting it. Otherwise validate the section: it must contain exactly one fenced `json` block that validates against the schema. Stop when the section is present but empty, contains zero or multiple blocks, or fails validation.

The rewrite changes no intent. It makes the state partition — absent, present-and-valid, present-and-invalid — complete and non-overlapping, so there is exactly one reading.

A useful check: enumerate every state the subject can be in, and confirm the text assigns each state to exactly one branch. The defect here was that "absent" appeared in two branches.

## Related

- [Comments and commit messages are claims, not evidence](../best-practices/comments-and-commit-messages-are-claims-not-evidence-2026-08-16.md) — prose asserting a state the code does not back; this doc covers prose that contradicts itself.
- [An exemption must be predicated on the uncheckable condition](../best-practices/exemption-predicates-must-name-the-uncheckable-condition-2026-08-18.md) — a defect from the same branch that design review *did* catch, for contrast.
