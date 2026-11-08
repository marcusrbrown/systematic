# Cross-project connections: evaluation

A hand-run, pre-registered evaluation of `ce:connect`. It is not part of `bun test` and it is never shipped. The registration is [`PRE-REGISTRATION.md`](PRE-REGISTRATION.md); read it first, because it fixes the models, the thresholds, the counting rules and what stops the work.

## What is in the repository

| Path | What it holds |
|---|---|
| `tests/manual/connect-eval/PRE-REGISTRATION.md` | The frozen design, thresholds, rules, stop rule and the real-use run-record template. |
| `tests/fixtures/connect-eval/labels.json` | Opaque ids and labels only: the registered thresholds, the four probe lessons, the seeded contradictions, the controls and the fresh-set labels. |
| `tests/fixtures/connect-eval/synthetic/` | Synthetic learnings: three seeded contradictions and three same-subject controls, with a manifest that names each pair. |
| `tests/unit/connect-eval-fixture.test.ts` | Checks the label file, the thresholds, the synthetic documents, the frozen-file digest and the leak scan. |

## What stays outside the repository

The fresh project, the three probe corpora, their pinned revisions, the labeler's report, Marcus's judgments, every run record, digest and transcript, the scratch copy with the planted seeds, and the scripts that drive the runs. None of it is committed, because it holds other people's text and private project names. The pre-registration carries digests of the pins and of the scripts so that a later reader can tell they were not changed.

## Order of work

1. Commit the registration (this directory and the fixtures). The frozen-file digest in it must match the working tree.
2. Run the blind labeler pass over the unseeded clones. Marcus judges each candidate. The accepted ones become the `fresh` labels, and `fresh.status` becomes `labeled` in a second commit.
3. Plant the seeds in the scratch copy.
4. Run the **main sweep**: one full sweep of headless `ce:connect` over the four allowed checkouts. Runs follow one another over a shared state directory until the helper reports the corpus covered, with a cap of the expected run count plus 2.
5. Run the **seed check**: 3 repetitions over the seeded copy alone, which is one slice of 48 learnings. Each repetition is a full sweep from a fresh state directory and is expected to take one run.
6. Marcus judges each distinct main-sweep candidate and each "already recorded" entry from the judging sheet.
7. Score. The report names every figure and the verdict: precision on the main sweep, seeds and controls in the seed check, and the regression and recall figures. A miss on precision or on the seed check stops the work for Marcus before the pull request.

## Checks the test runs

```sh
bun test tests/unit/connect-eval-fixture.test.ts
```

The leak scan always looks for home paths, scratch paths and organisation slugs. To also scan for private project names, put one term per line in a file outside the repository and point at it:

```sh
CONNECT_EVAL_PRIVATE_TERMS_FILE=/path/to/terms.txt bun test tests/unit/connect-eval-fixture.test.ts
```

CI does not have that file, so it runs the built-in scan only. Run the scan with your own terms before committing anything in these directories.

## Changing the frozen files

`skills/ce-connect/`, `agents/research/connections-researcher.md` and the generated helper bundle are frozen by digest. The test fails when any of them changes. After the first labeled run, such a change needs a new registration; before it, update the digest in the registration in the same commit.
