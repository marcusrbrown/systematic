---
title: A source-scanning guard needs its blind spots measured, not reviewed
date: 2026-09-07
category: best-practices
module: measurement
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - "A guard scans repository source text for a forbidden literal or pattern"
  - "A scanner must skip comments or strings, so its correctness depends on tokenizing"
  - "A parameterised fixture holds a realistic value that reality could later reach"
  - "A guard passes and is taken as proof that the scanned files are clean"
tags:
  - guard
  - scanner
  - tokenizer
  - fixture
  - false-positive
  - blind-spot
  - version-literal
  - renovate
---

# A source-scanning guard needs its blind spots measured, not reviewed

## Context

`tests/unit/opencode-pin.test.ts` holds two guards that scan repository source text:

- **R1** (`:175`) — the real OpenCode pin literal must appear nowhere under `scripts/` or `tests/`;
  code that needs it calls `readOpencodeSdkPin()` (`scripts/lib/opencode-pin.ts:120`).
- **R2** (`:522`) — fixture files must use unpinnable sentinel versions, never realistic ones.

R2 exists because R1 had a design flaw. `probeOpencodeAvailability` takes `pin` as a *parameter*,
so `tests/unit/opencode-availability.test.ts` held ~30 arbitrary literals like `'1.18.28'`. When a
dependency bump moved the real pin to that value, R1 fired on a non-violation and blocked the bump
(PR #944). The same collision had already occurred once (PR #928) and was resolved by swapping in a
different realistic version — which re-armed the trap for the next bump.

Three successive designs of R2's scanner each read as correct, and each had a hole that only a
measurement found.

## Guidance

1. **Measure a scanner's blind spots by planting a violation at every line position.** Insert the
   forbidden literal at each line of each scanned file in turn and assert the scanner reports it
   every time. A *position* is an insertion point in the file, counted so that these four files of
   400 / 652 / 644 / 659 lines yielded 402 / 654 / 646 / 661 positions; the exact convention lives
   in the probe, and pinning it is part of landing that probe as a test. Reading the code found
   none of the three holes below; this found all of them. Measured at `dbe2b12`: 0 genuine misses.

   Those counts are a measurement taken at one commit, not a standing property: the files and the
   scanner both change. The probe was run ad hoc, which is its weakness — a technique the reader
   cannot re-run is a technique they will not use. Prefer landing the probe as a test so coverage
   is re-proven on every change rather than asserted from a snapshot.

2. **Prefer a structural bound over another heuristic patch.** A `'` or `"` string cannot span a
   newline in JS/TS, so an unterminated string ends at the line break
   (`tryConsumeStringLiteral`, `tests/unit/opencode-pin.test.ts:364-373`). That caps how far *any*
   mis-detection can blind the scan, whatever caused it — including causes not yet known. It is
   worth more than a third refinement of the heuristic that keeps being wrong: `precedesRegexLiteral`
   (`:386`) still only recognises a regex after `(`, `,`, `=`, or `[`, and the bound makes that
   residual harmless.

3. **Never put a realistic value in a parameterised fixture.** If the argument does not need to be
   real, use one reality can never reach: `SENTINEL_PIN = '9999.0.0'` and
   `SENTINEL_MISMATCH_PIN = '9999.0.1'` (`tests/unit/opencode-availability.test.ts:29,31`), checked
   by an anchored `SENTINEL_PATTERN = /^9999\./` (`tests/unit/opencode-pin.test.ts:242`). A
   realistic literal in a fixture is a delayed false positive: it fires the moment reality reaches
   it, and it will be "fixed" by picking another realistic value unless the range is impossible.

4. **Inside an allowlist, prefer blanket matching plus justified exemptions to context-anchored
   matching.** When the scanned scope is already a short file list
   (`ALLOWLISTED_FIXTURE_FILES`, `tests/unit/opencode-pin.test.ts:256`), take precision from the
   file list and completeness from the rule. Anchoring instead to recognised contexts trades away
   completeness for a precision the allowlist already provides. Each exemption carries its reason;
   an unexplained exemption is how the guard rots.

5. **Make the failure message name every remedy, including "this value never needed to be real."**
   R1's original message said only to read the pin from the helper — correct for production code,
   wrong for a fixture that wants a value that is never the pin. A message that names one remedy
   sends the reader to fix the wrong thing.

## Why This Matters

A guard with a blind spot is worse than no guard: it reports green over exactly the case it exists
to catch, and its green is then cited as evidence. Two of the three designs below would have passed
CI while blind, and the first would not have caught the bug it was written for.

The measurement is cheap enough to clear a guard as well as condemn one. The same technique applied
to the sibling guards in `tests/unit/spawn-and-signal-conventions.test.ts` (PR #939) returned 0
misses — they already used a single-pass tokenizer — which is a result worth having.

## When to Apply

Any repository rule enforced by scanning source text rather than an AST: banned literals, import
conventions, call-shape guards, fixture-value policies. Especially when the scanner must ignore
comments or strings, since that is where the tokenizing bugs live, and when a passing guard is
about to be treated as proof of coverage.

## Examples

Three designs, three measured outcomes.

**1. Context-anchored matching** — match a version only after `pin:`, `opencodeVersion:`,
`opencode-ai@`, or the SDK/plugin keys. Chosen deliberately for precision, to avoid flagging
other-domain versions such as `packageVersion: '1.2.3'`. Measured: it missed four shapes —
`expectedVersion:`, `reportedVersion:`, a version inside a launcher template string, and a bare
regex `.toThrow(/1\.18\.28.*1\.18\.99/)`. All four were shapes that same file used before the fix,
so the guard would not have caught the bug it was written for.

**2. Blanket matching with a two-pass comment stripper** — measured 143 misses out of 143 positions
after line 502 of `eval-redaction.test.ts`: 100% of the file's tail. The stripper blanked
`//`-to-end-of-line on raw source, so a string containing `//` (for example
`'//server/share/x.json'`) lost its closing quote, quote parity desynced, and every later string
paired with the wrong delimiter. It passed only because that file's one real literal sat before the
hazard. A single URL added to any scanned file would blind everything after it.

**3. Removing comment awareness entirely** — the tempting simplification, since the tokenizer only
existed to skip comment prose. Measured on a draft: 166–580 missed positions, because an apostrophe
in ordinary prose (`doesn't`) opens a phantom string span. The same desync class, arrived at from
the opposite direction.

The shipped design keeps comment awareness — `tryConsumeLineComment` and `tryConsumeBlockComment`
remain — but as a single pass over the source rather than a separate stripping pass, plus the
newline bound from Guidance 2. Three regression tests pin both hazards and the bound
(`tests/unit/opencode-pin.test.ts:638`). What was removed was the two-pass stripper, not comment
handling itself.

## Related

- [A perfect measurement is evidence about the instrument, not the system](./a-perfect-measurement-means-a-broken-instrument-2026-08-16.md) — the closest relative: a clean result that was really a report about a blind instrument. This doc adds the positional probe as a concrete way to test the instrument.
- [A deletion gate must observe every field the deleted code wrote](./deletion-gates-must-observe-every-field-the-deleted-code-wrote-2026-08-16.md) — the same partial-observation failure, over fields rather than source positions.
- [Schemas need adversarial probes, not just compilation](./schemas-need-adversarial-probes-not-just-compilation-2026-08-16.md) — a check that compiles is not a check that enforces.
- [Version-pinned evidence must be re-proven](../workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md) — the dependency-bump context in which this false positive surfaced.
