# Cross-Project Connections: Pre-Registered Evaluation

## Status

REGISTERED. No labeled run has happened. This file is committed before any `ce:connect` run on the fixtures below, before the blind labeler pass, and before Marcus judges anything. It is written so that a result cannot be fitted to it afterwards.

Nothing above the `## Results` heading changes after the first labeled run. If a change is needed, it is a new registration, committed first, and the earlier one stays in history.

## Claim

`ce:connect` is judged on one fresh project, a fresh project chosen by Marcus, read together with three corpora from an earlier hand probe. The claim has two parts:

1. Of what the main sweep proposes on those projects, at least 0.7 holds up when Marcus judges it.
2. Every seeded contradiction is found in 3 of 3 seed-check repetitions, where a repetition is one full sweep of the seeded scratch copy of the fresh project alone and a seed counts as found if any run of that sweep produced it.

Precision rests on one full sweep because a full sweep costs about 4 hours of runs and three of them would cost about 12. The seeds, which need repetition, are checked on the seeded scratch copy alone, which is one slice of 48 learnings, so each repetition costs about one run.

What the claim does not cover:

- Recall is claimed only for the seeded cases and for the connections Marcus accepts from the blind labeler pass. It is not a claim about all connections in any project.
- The figures come from a small sample, one invoking model and one host (OpenCode). They are not a benchmark. Pi and Claude Code are not evaluated here.
- A run that publishes candidates is evidence about candidates. A run that publishes none is not evidence that nothing is there.
- A run covers one slice of the learnings. Only a complete sweep covers the corpus, and a sweep covers it once per repetition, not exhaustively: researchers search every allowed project, but only the rules a run is offered are examined for connections.

## Frozen design

Host and model:

- Host: OpenCode v1 1.19.5, the exact pin in `scripts/opencode-host-pins.json`.
- Invoking model for `ce:connect`: `claude-sonnet-5-5`, reached through the project's model gateway.
- Labeler model: `gpt-5.6-luna`, reached the same way. It is a different model family from the invoking model.

What is exercised:

- Revision the registration was prepared on: `6118ddb4ed0f8ea0c4f06f1f3177bb621b936bea`, which includes the change that rotates coverage across runs.
- The binding freeze is the digest of the files a run executes: the skill text, its two references, the generated helper bundle and the researcher agent. The helper bundle holds every bound (rules per family, families per run, candidates per batch, files per project) and the rotation that chooses each run's slice. A run builds the plugin from an archive of the registered revision, then checks the digest before it starts.

Frozen files digest: sha256:a189dd1e24cb892cf1adae455467434d557c7776a5c41532613d9bd40b2791a4

- The digest is `sha256` over one line per file, `path NUL sha256-of-file LF`, in path order. `tests/unit/connect-eval-fixture.test.ts` recomputes it and fails when a frozen file changes.

How each repetition runs:

- Each run is one headless `opencode run --format json`. A repetition is a sequence of runs in one throwaway isolated fixture: empty home, empty config and state directories, a throwaway owner-only credential file that is deleted when the repetition ends, and a child environment built from nothing. The runs of a repetition share one state directory, so the helper's coverage accumulates from run to run. Each repetition starts from a fresh state directory, so neither the coverage nor the ledger of one repetition reaches the next.
- The Systematic plugin built from the registered revision is the only plugin. The one host permission line added is the one that lets the session use its own state directory.
- The prompt, exactly: `Use the ce:connect skill. mode:headless`
- The allow list of the main sweep holds four main checkouts: the seeded scratch copy of the fresh project and three corpora, each at a pinned revision. The allow list of the seed check holds one: the same seeded scratch copy. Nothing else is allowed in either.
- Repetitions and the runs inside them go one after another. Each run has a timeout of 5400 seconds. A timeout is a recorded run with no result, not a retry.
- After each run and after each repetition the script checks that every allowed checkout has the same HEAD and the same `git status` as before.

What the outcomes mean after the rotation change:

- A run covers a slice of at most 48 rules (6 families of at most 8). The helper chooses the slice, not the model: rules never covered or changed first, then the least recently covered, taking the projects in turn.
- `complete` means the run's whole slice was covered and nothing failed. `degraded` means a slice was not fully covered, or something failed (a project unread, a git error, a batch cut off or incomplete). It does not mean the corpus was unread. Coverage of the corpus is the sweep line that every run reports.
- No outcome is built in by design, `degraded` included. Each outcome is recorded as it happened.

Pins:

- The revisions of the fresh project and of the three corpora are recorded in a scratch file kept outside the repository. This file carries only its digest and opaque references.

Pins digest: sha256:7f56e1563ec81fbd3c86fc630e9692f1cd7c2d2bb7768280ee8a5ff11c31a09f

- Scratch kit (digest taken at registration, informational): the labeler brief, the run prompt, the transport and seeding scripts, the scoring script and the probe-lesson matcher.

Scratch kit digest: sha256:e5845796174133999883333fea2a95477e94e04ca4ae9ea64a23d58a5413559d

- The kit digest is `shasum -a 256` of the sha256 lines of the kit files in name order. A later change is a deviation and is logged (see Deviations).

## Main sweep and seed check

The evaluation has two parts. They use different allow lists, and each repetition of either part starts from a fresh state directory.

The main sweep is one main sweep, a single repetition of the sweep rules below over the four allowed projects.

- Precision is computed over the distinct candidates of this sweep.
- Recall on the fresh labels comes from this sweep and is reported with no threshold.
- The regression check on the four probe lessons comes from the main sweep. A miss is reported and does not stop the evaluation.
- Seeds found in the main sweep are reported too. No threshold rests on them.

The seed check is a seed check of 3 repetitions over the seeded scratch copy of the fresh project alone. That is 36 learnings plus the 12 planted documents, so 48 learnings: one slice of 48. Each repetition applies the same sweep, cap and incomplete rules as the main sweep. Because one slice covers every learning on the list, a repetition is expected to finish in one run. The seeds and controls are same-project pairs and all sit in that one slice.

- Every seeded contradiction must be found in 3 of 3 seed-check repetitions.
- No same-subject control may be reported in any seed-check repetition. A reported control is a failure of the seed check.
- A reported control counts in the precision denominator, from the main sweep and from the seed check. Each control counts once.
- Other candidates from the seed check are listed in the report. They are not judged and not scored.

## Sweeps

Each repetition, of the main sweep and of the seed check, is one full sweep: headless `ce:connect` runs one after another, sharing a state directory, until the allow list is covered.

- Slice size: 48 rules per run, fixed by the frozen bounds.
- Stop when done: after each published run the script reads its run record. When the sweep says no runs are left (`runsLeft` is 0, so every rule is covered at its current hash), the repetition ends.
- Expected run count: the number of learnings in the allowed projects, divided by 48 and rounded up. The script reads the number of learnings from the first published run record. For the main sweep, with the four projects and the 12 planted documents, that is about 376 learnings, so about 8 runs. For a seed-check repetition it is 48 learnings, so 1 run.
- Hard cap: the expected run count plus 2 attempts per repetition. Every `opencode run` attempt counts toward the cap, including one lost to transport. Every attempt is kept.
- A repetition that reaches the cap before the sweep is complete is recorded as incomplete. It is not run again. Its seeds count as found only if a run produced them, and the report names it.
- Before any run record exists, 3 attempts without one abandon the repetition. It is recorded as abandoned.
- Because the order depends only on the index and on committed coverage, a repetition covers the same slices in the same order as any other repetition over the same checkouts. What differs between repetitions is what the model finds in each slice.
- Within a sweep the helper's ledger suppresses a candidate it has already published, so a repeat inside one sweep is not proposed again. A seed whose two documents sit in different slices may still be published under more than one candidate id, because the id includes the rule. Any such candidate counts as the seed being found.

## Cost and time

This is an estimate to size the work. It is not a measurement, and it is not a threshold. No run at this size has happened. The only measured run was on three tiny projects with two researcher dispatches, and it took about 100 seconds and about 230 thousand processed tokens on a small model.

Assumptions: each of the at most 6 researcher dispatches in a run makes 15 to 35 tool calls and takes 3 to 6 minutes; the invoking session adds 3 to 6 minutes for the skill, the helper calls, reading the rule overview, grouping, writing batches and publishing. A run on the seeded copy alone costs the same as a run in the main sweep, because both cover a full slice of 48.

| Unit | Estimate | Range |
|---|---|---|
| One run | 30 minutes | 20 to 45 minutes |
| Main sweep (about 8 runs, about 48 researcher dispatches) | 4 hours | 2.7 to 6 hours |
| Seed check (3 repetitions of about 1 run, so about 3 runs and 18 dispatches) | 1.5 hours | 1 to 2.3 hours |
| Both parts (about 11 runs) | 5.5 hours | 3.7 to 8.3 hours |
| Hard ceiling (main cap of 10 attempts, seed-check cap of 3 attempts per repetition, each at the 5400-second timeout) | 15 hours main, 4.5 hours per repetition | 28.5 hours in all |

Tokens: about 2 to 4 million processed tokens per run, most of it cached input, so about 22 to 44 million over the 11 runs. Output is small by comparison. The estimate does not model provider rate limits, which can stretch the time.

For comparison, three full sweeps over the four projects would be about 24 runs and about 12 hours.

Not included: the blind labeler pass (one read-only session, about 30 to 90 minutes) and the time Marcus spends judging.

## Corpora and labeling

Corpora, by opaque name:

- `fresh`: a fresh project chosen by Marcus. 36 learnings at the pin.
- `probe-1`, `probe-2`, `probe-3`: the three corpora from the earlier hand probe. `probe-2` and `probe-3` are at the revision the probe used. `probe-1` is at a later revision whose learnings directory is identical to the probe's.
- The seed check uses `fresh` alone, as the seeded scratch copy. No probe corpus is in its allow list.

Procedure, in this order:

1. Pins are recorded, and standalone clones are made at the pins. The allowed checkouts are read-only for the whole evaluation.
2. **Blind labeler pass.** A fresh, read-only labeler on `gpt-5.6-luna` reads the unseeded clones of `fresh` and the three probe corpora. It runs without plugins, in an empty home, with only read, glob, grep and list allowed. It has no access to the `ce:connect` skill text or the researcher agent text. Its brief is the hand probe's brief with the output format tightened so that every excerpt can be checked: candidates of both kinds, counterevidence, an overlap check, at most 12 candidates, and an empty answer allowed. A script checks each excerpt character for character against the file it cites.
3. **Marcus judges each labeler candidate**: real and worth promoting, real but not worth it, or false. This happens before any `ce:connect` run.
4. **The recall labels** are the candidates judged real (either class). They are recorded in `tests/fixtures/connect-eval/labels.json` under `fresh` as opaque ids with their class, and `fresh.status` changes from `awaiting-labeler` to `labeled`. False candidates are not labels. The text and the matchers stay in scratch.
5. **Seeds.** `tests/fixtures/connect-eval/synthetic/` holds three seeded contradictions and three same-subject controls as synthetic learnings. Each seed is a pair of documents that give conflicting guidance for the same contract in the same situation. Each control is a pair of documents on one subject that do not conflict: one is a different context with a different right answer, or one is the more detailed version of the other. The documents are planted and committed in a scratch copy of `fresh`; the copy used for the labeler pass stays unseeded. Marcus may add seeds of his own to the scratch copy; they are scored the same way, and only their count is recorded here.
6. **Probe lessons.** The four lessons from the hand probe that were judged worth promoting are `r-01` to `r-04` in the label file. They drove the method, so they are a regression check and not quality evidence.

The label file is edited only to set `fresh.status` and to add the `fresh` labels. Its thresholds and every other entry stay as registered.

## Thresholds

- Precision at least 0.7 on the main sweep. Definition under "Precision denominator".
- Every seeded contradiction found in 3 of 3 seed-check repetitions. The seed check passes only when, in addition, no control is reported in any of its repetitions.

The regression check (4 of 4 probe lessons) is reported next to these and is not one of the two thresholds.

A seeded contradiction is found in a repetition when a `contradiction` candidate published by any run of that sweep cites both documents of its pair as sources. A control is reported when a candidate published by any run cites both documents of its pair.

## Repetitions and equivalence

- The main sweep is one repetition over the four-project allow list. The seed check is 3 repetitions over the one-project allow list. All use the same prompt, models, fixture, seeded copy and pins, and each repetition has a fresh state directory.
- A run lost to transport (a provider error before the helper began) is attempted again inside the same repetition. It counts toward the cap, and the earlier attempt is kept. A run in which the helper began counts, whatever its outcome. A run that ends `failed` or `busy` publishes nothing, so it finds no seed.
- A whole repetition is run again only when none of its attempts reached the helper. The earlier attempt is kept.
- Nothing is run again to improve a result.
- Two candidates are equivalent when they share a candidate id, which the helper derives from kind, target, source paths and rule. Candidates with different ids are equivalent only when Marcus groups them while judging; the groups are recorded before any figure is computed.
- Precision is computed over the distinct candidates proposed by the main sweep, after equivalence. A candidate proposed in two runs of the sweep is judged once.
- Seeds are counted per repetition over the pooled runs of its sweep. Recall and the regression check are counted over the pooled runs of the main sweep.
- A group's judgment must be the same for every member. Scoring stops on a conflict.

## Precision denominator

The denominator counts distinct items that a human is asked to look at:

- distinct published candidates from all runs of the main sweep, after equivalence, including stray candidates that cite one planted document or pair and are not a seed or a control;
- distinct "already recorded" entries from the main sweep, which count in the denominator and never in the numerator;
- each control that was reported, counted as false without a human judgment. A reported control counts in the precision denominator, from the main sweep and from the seed check. Each control counts once, however often it was reported.

The numerator counts distinct candidates that Marcus judged real, worth promoting or not.

Left out of both: the exact seeded pairs found as contradictions, in either part. Other candidates from the seed check are not judged and are not in the denominator. They are recall, not precision, and counting them would lift the figure for free.

If the denominator is 0, precision is undefined and the claim has nothing to rest on; that counts as a miss.

Also reported, and not gating:

- the stricter figure that counts only candidates judged worth promoting;
- the figure without "already recorded" entries;
- recall on the fresh labels, from the main sweep.

## Stop rule

A miss on either threshold (precision on the main sweep, or the seed check) stops the work for Marcus before the pull request. The miss is recorded as it happened. No prompt, skill, helper, agent, bound or model changes under this registration to fix a miss. Any such change is a new registration, committed before its first labeled run. Marcus decides what happens next.

## Regression check

Four lessons from the hand probe were judged worth promoting. A candidate matches a lesson when its target is the lesson's target and one of its sources is the lesson's source document. One lesson has two targets and counts when either is matched. The check comes from the main sweep and is reported over its pooled runs.

It is not quality evidence. A miss is reported to Marcus together with the results. It does not stop the evaluation and does not start the stop rule by itself.

## Deviations

These do not change the registration, and are logged in the results with the reason and the new kit digest:

- a fix to transport that leaves the prompt, models, fixture, pins and frozen files alone (for example a host flag or a timeout);
- an attempt or a repetition run again under the transport rules above.

Everything else is a change to the registration (see the stop rule).

Logged deviations:

1. Transport fix, made before the first model call. The scratch clone script failed while cloning the fresh project, because that project's local checkout is a partial clone (file contents filtered out) and cannot serve a full clone. The scripts now clone from the checkout's origin URL when the source is a partial clone, and from the local checkout otherwise. They also check, after each clone, that the pinned revision is a commit in it, and stop if it is not. The source checkouts are only read. The pins, the frozen files, the prompt, the models, the fixtures and every rule above are unchanged.
   - Kit digest before the fix: sha256:e5845796174133999883333fea2a95477e94e04ca4ae9ea64a23d58a5413559d
   - Kit digest after the fix: sha256:ab8a362dc66dd86a6332ca0c70c3c73a1f762adbb73fc7befe43cd93313f69f0
2. Second transport fix, made before the first `ce:connect` model call. macOS Finder keeps writing `.DS_Store` files into the scratch tree, and they come back after they are deleted. The scripts' "is this checkout clean" check and their before-and-after comparison of the allowed checkouts counted them as changes, and the first main-sweep start stopped on one. Every such check and comparison now ignores an entry whose final path component is exactly `.DS_Store`, and ignores nothing else. The scripts also delete existing `.DS_Store` files under the scratch clone, seeded-copy and fixture trees before each clone check. The pins, the frozen files, the prompt, the models, the fixtures and every rule above are unchanged.
   - Kit digest before the fix: sha256:ab8a362dc66dd86a6332ca0c70c3c73a1f762adbb73fc7befe43cd93313f69f0
   - Kit digest after the fix: sha256:f333df22cd6b18c6be2dd00abec1880aebf592c7f53a48585dca40a794124bad

## Real-use window

The evaluation above does not replace use. After merge, the first 5 real runs are recorded with the template below. Nothing is tuned between them on the strength of one run.

```text
Real run N of 5
Date:
Host and version:
Mode: interactive | headless
Allowed projects (opaque): <count>, <what kind of project each is>
Outcome: complete | degraded | busy | failed (reason)
Sweep line (covered X of Y rules, this run Z, about N runs left):
Candidates proposed:
Candidates promoted: <count>, to which skill and which project
Candidates rejected: <count>, with reason categories
Dropped by validation: <count>
Digest errors noticed (stale, false, missing):
Time spent reading the digest:
Worth the time: yes | no, in one sentence
```

Stop rule for the window: if none of the first 5 real runs yields a candidate that a human promotes, the capability is reconsidered, not tuned further.

## Results

Recorded 2026-11-07 (US Mountain time; the runs went from about 01:35 to 04:03 UTC on 2026-11-08). Aggregate figures only. The candidates, their text and their sources come from other people's projects, and some describe unfixed gaps, so none of it is committed. Nothing is removed from this section later.

Small sample, OpenCode only, one fresh project, one invoking model. Not a benchmark.

### Verdict

Both pre-registered thresholds were met: precision at least 0.7 on the main sweep, and every seed found in 3 of 3 seed-check repetitions with no control reported.

### Precision (threshold: at least 0.7)

- Distinct judged candidates: 35, from 36 raw candidates. One pair was grouped as equivalent before any figure was computed.
- Judged real: 35. Worth promoting: 35. False: 0.
- Kinds among the 35: 4 contradictions and 31 transferable lessons.
- "Already recorded" entries: 0. Reported controls, main sweep and seed check: 0.
- Denominator: 35. Precision: 1.00. The stricter figure (worth promoting only) is 1.00, and so is the figure without "already recorded" entries.

### Seed check (threshold: every seed in 3 of 3 repetitions, no control reported)

- 3 repetitions. Each was one complete run that covered 48 of 48 rules, with the projects unchanged.
- Every seeded contradiction was found in 3 of 3 repetitions.
- No control was reported.

### Main sweep

- One full sweep: 9 runs (expected 8, cap 10), 376 of 376 rules covered, projects unchanged before and after.
- Every run ended `degraded` with the reason `citations-truncated`. Two of them also ended with `uncovered-rules` and `incomplete-batch`; the rotation offered those rules again in a later run, and the sweep still ended with every rule covered.
- No run ended `complete`, `busy` or `failed`. No run, in either part, timed out.

### Reported only (no threshold)

- Regression check on the earlier probe lessons: 1 of 4 found.
- Recall on the fresh labels: 0 of 1 labeled connections found by the main sweep.
- Seeds found in the main sweep: 3 of 3.

### What the figures do and do not say

What was proposed held up: every distinct candidate was judged real, and the planted contradictions were found every time with no control reported. Recall on known lessons is low, though. The sweep found 1 of 4 earlier probe lessons and 0 of 1 fresh-set labels, so a run that proposes little is not evidence that nothing is there. The precision figure measures what a run reports. It says nothing about what a run leaves out. The seeds are synthetic pairs inside one project and one slice, so finding them says less than finding a cross-project connection would.

The judging was done by the project owner after seeing the candidates, not blind, and the sample is one fresh project plus three corpora from the earlier probe. Read 1.00 as "no false candidate in 35", not as a rate.

The nine `degraded` outcomes of the main sweep came from a bound, not from a failure. The helper caps the citations it checks and reported a run that reached the cap as degraded, and real projects reach it on every run. The outcome line therefore did not separate runs with a problem from runs without one. That is recorded here as it happened; the evaluated files were not changed to improve it.

### Deviations

Both logged transport fixes (see Deviations above) were made before the first `ce:connect` model call, and neither changed a frozen file, the prompt, the models, the fixtures or the pins.

1. The scratch clone script now clones from the checkout's origin URL when the source is a partial clone, and checks after every clone that the pinned revision is present.
2. The scripts now ignore, and delete, Finder `.DS_Store` files in their clean-checkout checks and before-and-after comparisons, and ignore nothing else.

No attempt was run again to improve a result.

### Change after the evaluation

After the results above were recorded, the helper changed so that a run whose only gap is the citation cap ends `complete`. The cap, its value, the rule index, the coverage rules and every other degrade reason are unchanged. The cap is still reported: the digest names the project under "Not read or not covered", and the run record keeps, per project, whether the cap was reached and how many citations were checked.

This changes how a run is classified, not what it finds, so none of the figures above is re-measured and none is claimed for the new files. They describe the files of the digest registered above. A skill reference and the generated helper bundle changed with it, so the digest of the frozen files changed too:

Frozen files digest after the change: sha256:42f50007fb558d5529bea76e63973e9ec0ceb13b00d8157d277675bd4200d658

Any further change to a frozen file needs its own line here.
