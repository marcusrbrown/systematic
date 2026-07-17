---
title: When detection is undecidable, ban the pattern instead of guessing
category: best_practice
problem_type: best_practice
module: content-integrity
component: frontmatter-parse-safety
tags:
  - yaml
  - frontmatter
  - ci-gate
  - data-integrity
  - code-review
  - verification
  - heuristics
related_components:
  - tooling
date: 2026-06-04
---

# When detection is undecidable, ban the pattern instead of guessing

## Context

Two verification layers were ported from upstream CEP into Systematic: a `ce:review`
independent finding-validation pass, and a content-integrity check for silent YAML
frontmatter truncation in `docs/solutions/` (where the knowledge store lives). The
frontmatter check was meant to detect the silent-data-loss class where an unquoted value
containing ` #` is truncated by the YAML parser with no error (`problem: cache miss # under load`
parses to `"cache miss"`, dropping the rest, with `parseError: false`).

The first implementation tried to detect *actual content loss* by comparing the parsed value
against the author's raw intended value. Code review (running with the very validation pass
being shipped) caught that the detector had its own blind spots, and pushing on those exposed a
deeper problem: **the target case is undecidable.**

## Guidance

When a detector tries to distinguish a "bad" pattern from a "fine" pattern that is
**indistinguishable at the data level**, stop trying to detect the bad case and instead **ban
the ambiguous pattern outright**, with a remediation that removes the ambiguity.

For the YAML case: `problem: cache miss # under load` (truncation — bad) and
`date: 2026-01-01 # created` (intentional comment — fine) are **byte-identical to the parser** —
both parse to the text before ` #`. No parse-diff, heuristic, or "did we lose content?" check can
separate them, because YAML strips comments by design and the result is the same either way.

The honest resolution is a flat lexical rule: **flag any unquoted inline comment** (whitespace
before `#`, or a value starting with `#`) in the scanned frontmatter, with remediation "quote the
value or remove the comment." This:

- Is *correct* (no false claim of detecting loss it cannot detect)
- Has zero data-loss risk (the banned pattern is always quotable)
- Is *simpler* than the guessing version (removing the parse-diff machinery cut ~50 lines)
- Produces a clear, actionable remediation rather than a probabilistic warning

State the scope boundary honestly too: a purely lexical line scan covers only flat top-level
`key: value` lines, not nested/indented mapping values. Document that limit rather than pretending
to cover it.

## Why This Matters

Heuristic detectors that guess at an undecidable distinction fail in both directions: they miss
real cases (false negatives) and flag legitimate ones (false positives). Worse, they *look* like
they work, so a wrong assumption gets locked into a test fixture and ships as a silent gap. The
first implementation here did exactly that — a fixture asserted `tag: #important` was "safe" when
the parser actually drops it to `null`.

A ban rule trades a small amount of author friction (quote your value, or drop the comment) for a
detector that is honest about what it does. For a knowledge store, silent loss of a documented
solution is far more costly than the friction of quoting a value.

Two companion lessons from the same work:

- **Independent verification passes should re-prioritize, not delete.** The `ce:review`
  validation pass annotates findings `validated: true|false` and surfaces rejected ones in a
  "Filtered (not validated)" group — it never drops a finding. A validator that deletes assumes it
  is more reliable than the original reviewer; if it is just another model pass, its failure mode
  is dropping real findings. Validate-only neutralizes that.
- **Port discrete capabilities, not workflow architecture.** When adopting from an upstream
  project you deliberately diverged from, take the one capability and leave the surrounding
  machinery (here: the validator template was taken without upstream's `mode:agent` apply model,
  action-class rubric, or internal skill dependencies). "Upstream ships it" is never sufficient
  justification on its own.

## When to Apply

- A CI gate or linter needs to flag a "dangerous" form that is data-level identical to a benign
  form (comment stripping, whitespace collapsing, lossy coercion, normalization that discards
  input).
- A heuristic detector keeps accreting special cases to handle edge inputs — a sign the underlying
  distinction may be undecidable and a ban rule would be both simpler and more correct.
- You are reviewing or porting an "independent verification" layer and need to decide whether it
  may remove items or only re-rank them.

## Examples

Guessing version (undecidable — flags legitimate comments, misses edge cases, ~50 extra lines):

```text
# tried to prove "content was lost" by comparing parsed vs raw-before-comment
problem: cache miss # under load   -> parsed "cache miss", before-# "cache miss"  -> EQUAL -> flag?
date: 2026-01-01 # created          -> parsed "2026-01-01", before-# "2026-01-01" -> EQUAL -> flag?
# both EQUAL -> the check cannot tell truncation from a real comment
```

Ban-rule version (honest, simpler — lexical, with a clear fix):

```text
# flag ANY unquoted inline comment in scanned frontmatter; remediation: quote or remove
problem: cache miss # under load   -> unquoted, has " #"   -> FLAG ("quote the value or remove the comment")
date: 2026-01-01 # created          -> unquoted, has " #"   -> FLAG (same remediation)
tag: #important                     -> unquoted, starts #   -> FLAG
problem: "cache miss # under load"  -> quoted               -> safe
# a real comment line
title: My Feature                   -> no inline #          -> safe
```

The remediation is always available and unambiguous: quote the value, or remove the comment.

## Related

- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md`
  — companion content-integrity gate-design lesson (mirror runtime rules in the gate).
- `docs/solutions/best-practices/neutral-v1-marker-migrated-set-identifier-gate-2026-07-17.md`
  — check #13 applies this honest-ban discipline: nine bounded lexical identifiers, scope stated in-gate, paraphrases declared out of scope.
