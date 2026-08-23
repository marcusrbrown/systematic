---
title: A learning filed under its lesson is invisible to someone living its symptom
date: 2026-08-23
category: documentation-gaps
module: docs-solutions
problem_type: documentation_gap
component: documentation
severity: high
applies_when:
  - "Writing a learning whose title states a general principle rather than the concrete failure"
  - "A learning's frontmatter omits the module, tool, or identifier that produced it"
  - "An issue is filed about a system that already has a documented learning"
  - "A retrieval pass returns a doc as a cross-reference rather than as the answer"
related_components:
  - development_workflow
  - tooling
tags:
  - knowledge-retrieval
  - frontmatter
  - indexing
  - docs-solutions
  - compounding
  - prior-art
  - ce-review
---

# A learning filed under its lesson is invisible to someone living its symptom

## Context

On 2026-08-16 a learning landed at
[`best-practices/a-perfect-measurement-means-a-broken-instrument`](../best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md).
It named a specific defect in `ce:review`'s deduplication fingerprint:

> Two reviewers describing the same defect in different words produce different
> titles, so they produce different fingerprints. The instrument could not
> detect the thing it was built to measure.

Three days later, on 2026-08-20, issue #820 was filed against the same
fingerprint. It observed both relevant facts — "the line buckets are more than
a hundred lines apart **and** the titles normalize differently" — and then
attributed the failure to the line component, framing it as a problem specific
to prose files. All three fixes it proposed loosened the line term.

On 2026-08-23 the root cause was re-derived from scratch by measuring the
artifact corpus: 375 cross-persona pairs on the same file, 55 within ±3 lines,
39 on the exact same line, and **zero** merges. The line term was already
satisfied in 55 non-merging cases. The blocker was title equality — the same
conclusion the 2026-08-16 doc had already reached, by a different route.

The answer was already in `docs/solutions/`, and neither the issue nor the
investigation reached it.

## Guidance

### Index by the symptom, not only by the lesson

The 2026-08-16 doc is titled for its epistemic lesson — a perfect measurement
is evidence about the instrument. That is the right lesson and a good title.
Its frontmatter, however, was filed the same way:

```yaml
module: measurement
component: testing_framework
tags: [measurement, evidence, ground-truth, instrument-validation, analysis]
```

Nothing there says `ce-review`, `dedup`, `fingerprint`, or `merge`. Someone
debugging review deduplication searches for the system they are standing in
front of. They do not search for the epistemology they have not learned yet.

Frontmatter is the retrieval surface. It should answer *where would someone be
standing when they need this*, not only *what does this teach*.

This is a genuine tension rather than an oversight. A learning is worth writing
because it generalizes past its originating incident, and generalization is
exactly what strips out the searchable particulars. Separate the two jobs: the
title and body carry the lesson, the frontmatter carries the particulars. They
are not competing for the same space.

Concretely, a learning's frontmatter should carry:

- the module or skill that produced it, under `module` or in `tags`
- the identifier a person would grep for — the function, field, rule, or
  algorithm by name
- the symptom vocabulary, not just the diagnosis vocabulary

### Check prior art against the symptom before filing an issue

Search `docs/solutions/` by system name and stable identifiers, not by a
description of the problem. Identifiers persist; problem descriptions are
invented fresh each time — the same reason the fingerprint's title term failed.

### Measurement is the backstop, not the mechanism

Measuring the corpus recovered the right answer despite retrieval failing, and
that is worth keeping as a habit — see
[measure producers before accepting a contract issue's framing](../best-practices/unvalidated-artifact-contracts-have-no-conforming-producers-2026-08-23.md).
It is also expensive and conditional: the corpus lives under `.context/`, which
is gitignored (`.gitignore:49`, zero tracked files), so the numbers above are
not reproducible from a fresh checkout. Measure while the evidence exists and
record the result somewhere durable.

## Why This Matters

A knowledge store's value is entirely a function of retrieval. An unfindable
learning is worse than no learning, because it consumed the effort to write and
still let the work be redone.

The cost here was not just duplicated effort. The rediscovery arrived at the
correct answer, but the intermediate artifact — issue #820 — recorded a wrong
diagnosis for three days, and its three proposed fixes were all inert. Anyone
who had implemented them would have shipped a change that provably could not
work, against an issue that read as well-researched.

The failure mode is quiet. Nothing errors. The issue looks legitimate, the
investigation looks thorough, and the only signal that the knowledge already
existed is a coincidence of someone reading an unrelated doc.

## When to Apply

Apply when writing any learning whose title is a principle rather than an
incident, and when the originating system has a name someone would search for.

Apply when a retrieval pass surfaces a doc as a *cross-reference* rather than
as the answer. That is the observable symptom of this defect: the doc was
reachable, but its indexing did not mark it as authoritative for the question
being asked.

Do not apply it by stuffing frontmatter with every plausible keyword. `tags`
is capped at 8 by
[`schema.yaml`](../../../skills/ce-compound/references/schema.yaml), and a tag
list that matches everything ranks nothing. Choose the identifiers someone
would actually type.

## Examples

**Before** — indexed by the lesson only:

```yaml
title: A perfect measurement is evidence about the instrument, not the system
module: measurement
component: testing_framework
tags: [measurement, evidence, ground-truth, instrument-validation, analysis]
```

Unreachable from `dedup`, `fingerprint`, `ce-review`, or `merge`.

**After** — the title and `module` still carry the lesson; the tags carry the
symptom:

```yaml
title: A perfect measurement is evidence about the instrument, not the system
module: measurement
component: testing_framework
tags: [measurement, evidence, ground-truth, instrument-validation, analysis,
       dedup, fingerprint, ce-review]
```



## Related

- [A perfect measurement is evidence about the instrument, not the system](../best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md)
  — the learning that went unfound, and the source of the fingerprint diagnosis
  that #820 re-derived.
- [An artifact contract with no validated write path has no conforming producers](../best-practices/unvalidated-artifact-contracts-have-no-conforming-producers-2026-08-23.md)
  — the measurement discipline that recovered the answer when retrieval did not.
- [A repository claim is not a fact until the input set is defined](../workflow-issues/clean-checkout-baselines-before-quoting-metrics-2026-08-17.md)
  — the adjacent rule for trusting your own measurements rather than someone
  else's premise.
- Issues: [#820](https://github.com/marcusrbrown/systematic/issues/820)
  (the rediscovery), resolved in
  [PR #846](https://github.com/marcusrbrown/systematic/pull/846).
