---
title: Evaluate a model-driven tool with a pre-registered protocol, and drop any outcome label that every run trips
date: 2026-11-09
category: best-practices
module: ce-connect
problem_type: best_practice
component: testing_framework
severity: medium
symptoms:
  - "Every run in a full sweep ends with the same degraded outcome and the same single reason"
  - "A fix to the tool is blocked mid-evaluation because the files under test are frozen"
  - "A judge cannot decide from a question because the candidate detail sits in a side sheet"
  - "An evaluation script reports a check failed when the checked thing exists"
applies_when:
  - "Evaluating a tool whose output depends on a model and varies between runs"
  - "Choosing outcome labels such as complete and degraded for a bounded run"
  - "Planting known defects to measure whether a tool finds them"
  - "A human judges model output and the result will gate a decision"
tags:
  - evaluation
  - pre-registration
  - seeds
  - precision
  - recall
  - outcome-labels
  - ce-connect
---

# Evaluate a model-driven tool with a pre-registered protocol, and drop any outcome label that every run trips

## Context

`ce:connect` is nondeterministic and slow: each run of the main sweep over four projects took 13 to 16 minutes, and the sweep took nine runs. Before its first labeled run, the repository committed a registration of the claim, the frozen files, the thresholds and the stop rule (`tests/manual/connect-eval/PRE-REGISTRATION.md`). The evaluation met both thresholds and still exposed a classification defect, a mistake in judging and several defects in the evaluation's own scripts. This doc keeps the protocol and the five lessons. It builds on [counting real misses before adding a search lane](count-real-lexical-misses-before-adding-an-embeddings-lane-2026-11-01.md), which pre-registered a lexical ranker's evaluation.

## Guidance

### Register the claim, the freeze and the stop rule first

Commit these before the first labeled run (`tests/manual/connect-eval/PRE-REGISTRATION.md:3-23`):

- **The claim and what it does not cover.** Two thresholds: precision of at least 0.7 over a full sweep, and every planted defect found in 3 of 3 repetitions with no control reported. The registration also says recall is claimed only for planted cases and labeled connections, and that a run that proposes nothing is not evidence that nothing is there.
- **A digest over the files a run executes.** One line per file, `path NUL sha256-of-file LF`, in path order (`tests/manual/connect-eval/PRE-REGISTRATION.md:40`). A test recomputes it and fails when a frozen file changes (`frozenDigest`, `tests/helpers/connect-eval-fixture.ts:205`; the check at `tests/unit/connect-eval-fixture.test.ts:423-435`). A pins digest covers the revisions of the corpora, kept outside the repository, and an informational digest covers the evaluation scripts.
- **One repetition per sweep, with a stop rule and a hard cap.** A sweep ends when the tool says no runs are left. The cap is the expected run count plus two, and every attempt counts, including one lost to transport (`tests/manual/connect-eval/PRE-REGISTRATION.md:89-97`).
- **No re-run to improve a result, and a miss stops the work** for a human decision (`tests/manual/connect-eval/PRE-REGISTRATION.md:153` and `tests/manual/connect-eval/PRE-REGISTRATION.md:181`).
- **A deviations log** for anything outside the frozen files, each entry with the evaluation scripts' digest before and after (`tests/manual/connect-eval/PRE-REGISTRATION.md:189-205`).
- **Evidence outside the repository.** The corpora are other people's projects, so the committed record has aggregate figures only, corpora are named by opaque ids, and a test scans committed files for private terms (`leak check`, `tests/unit/connect-eval-fixture.test.ts:486`).
- **Labels before runs.** A read-only labeler on a different model family, with no access to the tool under test, labels the corpora first, and a person judges those labels before any run (`tests/manual/connect-eval/PRE-REGISTRATION.md:131-135`).

### Design the planted-defect check to fit one slice

Plant the defects in a scratch copy of one project and make the copy small enough to be a single slice of the tool's bounded run. Here that was 36 learnings plus 12 planted documents, 48 in all, one slice, so each repetition cost about one run instead of a full sweep (`tests/manual/connect-eval/PRE-REGISTRATION.md:80`).

- **Define "found" before the runs.** A planted contradiction counts as found when a published contradiction cites both documents of its pair as sources (`tests/manual/connect-eval/PRE-REGISTRATION.md:146`). A candidate that cites one planted document as a source and the other as counterevidence is an ordinary candidate. Scoring it as a seed was a classification mistake made once during the evaluation.
- **Plant controls.** A control is a same-subject pair that does not conflict. A control reported in any repetition fails the check, and counts once in the precision denominator (`tests/manual/connect-eval/PRE-REGISTRATION.md:83-84`).
- **Report planted defects found in the main sweep with no threshold**, since they are synthetic pairs inside one project (`tests/manual/connect-eval/PRE-REGISTRATION.md:78`).

### Put the whole candidate inside the question

A judge decides from what the question shows. The first judging sheets kept the detail elsewhere (in chat prose and a side file), and the judge said they lacked it, so the questions were asked again. Put the full block in the question text: summary, source excerpt, target evidence, counterevidence searched and overlap check.

Report judging honestly (`tests/manual/connect-eval/PRE-REGISTRATION.md:266-272`):

- Judging a tool's candidates after seeing them is not blind. Say so.
- Precision of 1.00 over 35 judged candidates reads as "no false candidate in 35", not as a rate.
- Recall was weak: 1 of 4 earlier hand-probe lessons and 0 of 1 labeled connections. Precision measures what a run reports and says nothing about what it leaves out.

### Drop an outcome label that every run trips

All nine runs of the main sweep ended `degraded`, and every one carried the reason `citations-truncated`; seven carried nothing else. The helper checks at most 500 citations per project (`CONNECT_BOUNDS`, `src/lib/connect-evidence.ts:51-68`), and the real projects reached it on every run. A bound had been classified as a failure, so the label could not tell a run with a problem from one without.

The frozen digest then blocked the fix: the file that classified the outcome was a file under test. The recorded way through:

1. Score and record the results as they happened, including the nine degraded runs.
2. Make the change after scoring. Reaching the cap became a reported fact: `scanGaps` (`src/ce-connect-helper.ts:907-946`) lists it under what was not read and adds no degrade reason, and the run record keeps per-project `citationsChecked` and `citationsTruncated` (`src/ce-connect-helper.ts:470-481`). A project with another gap still ends `degraded` and still reports the cap (`tests/unit/ce-connect-helper-ops.test.ts:1219-1277`).
3. Split the frozen-digest test in two: the registered digest never changes, and the last digest line must match the tree (`tests/unit/connect-eval-fixture.test.ts:415-435`).
4. Append each later change as a new digest line under the results, with a statement that no earlier figure is re-measured for the new files (`tests/manual/connect-eval/PRE-REGISTRATION.md:283-305`).

The check to run before freezing is cheap: run the tool once on a realistic input and ask, for every outcome label, whether a run could end differently. A constant result implicates the instrument; see [a perfect measurement is evidence about the instrument](a-perfect-measurement-means-a-broken-instrument-2026-08-16.md).

### Check the evaluation's own instruments

The scripts around the tool failed in small ways, each worth a guard:

- **A partial clone cannot serve a full clone.** The source checkout had its file contents filtered out. Clone from the origin URL and check after every clone that the pinned revision is a commit in it (`tests/manual/connect-eval/PRE-REGISTRATION.md:200`); the scripts, which live outside the repository, use `git cat-file -e <rev>^{commit}`.
- **Finder `.DS_Store` files broke "is the checkout clean" checks** on macOS. Ignore an entry whose final path component is exactly `.DS_Store`, delete existing ones before each check, and ignore nothing else (`tests/manual/connect-eval/PRE-REGISTRATION.md:203`).
- **The labeler returned one candidate**, though it was allowed up to twelve, so the recall labels were thin. Plan for a small label set and say recall is bounded by it.
- **An excerpt-check script reported 0 of 2 excerpts verified although both existed**, because of a doubled path prefix and dropped backticks. Observed once, in a script outside the repository, and not re-checked. When a check reports total failure on a handful of items, check the checker before the items.

Log each fix as a deviation with the new digest, and make it before the first model call when possible.

## Why This Matters

A registration written after the numbers cannot be told apart from fitting. The freeze, the stop rule and the cap are what let a good result mean something and a miss stop the work. The label lesson matters beyond this tool: a health label that every real input reaches carries no signal, and it hides the one run that has a real problem.

## When to Apply

- Before the first labeled run of any tool whose output varies by run.
- When a run is bounded and outcomes are labeled by whether a bound was hit.
- When a person's judgment of model output will gate a decision.
- When an evaluation harness runs on scratch clones of real repositories.

## Examples

**Post-evaluation amendment** (appended under the results, never above them):

```text
A change after the evaluation altered how a run is classified, not what it finds,
so none of the figures above is re-measured for the new files.
Frozen files digest after the change: sha256:<64 hex>
```

## Related

- [Count real lexical misses before adding an embeddings lane to search](count-real-lexical-misses-before-adding-an-embeddings-lane-2026-11-01.md)
- [A perfect measurement is evidence about the instrument, not the system](a-perfect-measurement-means-a-broken-instrument-2026-08-16.md)
- [Mining real needs cannot settle whether an external decision store matters](mining-real-needs-cannot-settle-whether-a-decision-store-matters-2026-11-02.md)
- [Hand-probe a cross-corpus capability before building it](hand-probe-a-cross-corpus-capability-before-building-2026-11-09.md)
