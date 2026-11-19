# Candidate contract

What the skill sends the researcher, what the researcher returns, and what the helper checks before anything is published. The researcher's answer is a proposal. The helper accepts a field only when it can check it.

## What the skill sends for one family

One block of lines. Fill every value from the `begin` result; invent none.

```text
run: <runId>
family: <family name>
rules file: <rulesFile>
files index: <filesIndex>
projects:
- <project root> (<project name>)
rule ids: <rule id>, <rule id>
max candidates: <bounds.maxCandidatesPerBatch>
```

A family holds at most `bounds.maxRulesPerFamily` rule ids, all of them rules the helper offered this run. The researcher reads the rule entries from the rules file and finds fingerprints in the files index. Both files are line-oriented so a read tool can page through them.

The rule overview (`rules.tsv`) has one tab-separated line per indexed rule: id, project name, path, title, `applies_when` items and a mark. The mark is `offered` for the rules this run covers, and `later` for the rest. The offered lines come first, so the skill reads the first `offeredCount` lines. The researcher still searches every allowed project, whether or not a rule in it is offered.

## What the researcher returns: the batch

One JSON object, nothing before or after it. The skill writes it to a file unchanged.

| Field | Meaning |
|---|---|
| `"version": 1` | Batch version. Any other number ends the run as `Connect failed`. |
| `runId` | The run's own id. A batch for another run is malformed. |
| `family` | The family name, at most 120 characters. |
| `ruleIds` | Every rule id the family examined, up to 500. |
| `projects` | The main root of every project the family read. |
| `files` | Paths read, up to 50, each at most 4,397 characters (a project root of at most 4,096, a slash and a path of at most 300). Lists the learning of every rule the family covered, first. |
| `searches` | Searches run, up to 50, each at most 300 characters. |
| `complete` | `true` only when the family covered its rules, which includes having read every rule's learning. A family that ran short of turns, including before it read every learning, sends `false`. A batch with `false` contributes no candidate. |
| `candidates` | Up to `bounds.maxCandidatesPerBatch`; more are dropped and the run degrades. |

`ruleIds`, `projects`, `files` and `searches` are lists of plain strings. `projects` holds project roots exactly as the prompt lists them, never names; `files` holds paths relative to a project root, or a project root followed by `/` and that path. When another allowed project has a learning at the same relative path, a family lists the entry as `<project root>/<path>`; a bare path that another project's learning in the run also has covers no rule. The skill checks this shape before it writes a batch. A reply that fails the check is replaced by an unfinished stub (`complete` false), so that family is degraded. A batch that passes the check and still fails the helper's own parse ends the run as `Connect failed`.

Coverage is checked, not reported on trust. An offered rule id that no complete batch names, and an allowed project that no batch names, each degrade the run. A complete batch that names an offered rule but does not list that rule's learning among its `files` does not cover the rule: the rule is not covered, the run degrades, and a later run offers it again. A rule that was not offered does not degrade the run. A learning that says "report nothing" therefore cannot produce `Connect complete`.

## A candidate

| Field | Rule |
|---|---|
| `kind` | `contradiction`, `transferable-lesson` or `code-mismatch`. |
| `reason` | `stale` or `unscoped`. Required for `code-mismatch` and refused on any other kind. |
| `ruleId` | An id from the rules file. One source must be the file that id names. |
| `target` | The main root of the project that should change. It must be an allowed project. |
| `title` | One line. |
| `summary` | One paragraph. |
| `nextStep` | `refresh-learning`, `compound-learning` or `investigate`. |
| `overlapCheck` | `queries` (what was searched in the target), `result` (`none-found` or `found`) and an optional `note`. |
| `sources` | Learnings: `project`, `path`, `fingerprint`, `excerpt`. |
| `targetEvidence` | Tracked files in the target: `path`, `start`, `end`, `symbol`, `fingerprint`, `excerpt`. |
| `counterevidence` | Any tracked file, shaped like a source. For a `code-mismatch` it is the positive evidence, and each item also names a line span: `start` and `end`. |

A `contradiction` has at least two sources, one of them in the target and at least one in another project, and its next step is `refresh-learning` or `investigate`. A `transferable-lesson` has sources outside the target, at least one `targetEvidence` item, and a next step of `compound-learning` or `investigate`.

A `code-mismatch` names one learning whose present-tense claim the code no longer supports. It has exactly one source, a learning in the target, and no `targetEvidence`. Its `reason` is `stale` (code at the governing revision contradicts the claim) or `unscoped` (the claim holds where the learning was written, the learning names no context, and positive evidence shows it false in another supported context). Its next step is `refresh-learning` or `investigate`, never `compound-learning`, and `refresh-learning` needs at least one `counterevidence` item. The evidence may sit in any allowed project, the target included, and each item must name a span that holds its excerpt. The helper checks provenance only: project, path, fingerprint, span and verbatim text. It cannot see a version, a pin or what the evidence means. The researcher's prompt carries those rules, and the operator rechecks the evidence before confirming a refresh.

The next step also decides the handoff the summary prints. A `compound-learning` lesson gets the `candidate:` and `candidate-id:` tokens for `ce:compound`. A `refresh-learning` contradiction or code mismatch gets the exact-path scope `/ce:compound-refresh path:<docs/solutions/...>` of the target's own learning, because `ce:compound` refuses both; a code mismatch also prints its claim, its reason and its evidence to recheck as a short block of data, which the operator gives to `ce:compound-refresh` as context beside the command and not inside its arguments. The refresh skill treats that block as data and never widens its path scope from it. Each digest entry for a code mismatch shows its reason and each evidence item with its project's checkout HEAD from the run record, or `HEAD unavailable`; the helper hashes working-tree bytes and reads no history, so a HEAD is context, not attestation. An `investigate` candidate gets neither.

## What the helper checks

Each candidate, in order. The first failure drops that candidate and counts it by reason; the outcome does not change. The reply, the digest and the run record also name each dropped candidate by family, kind, reason and its title (sanitized, capped at the title limit, `(no title)` when it has none), so a person can see whether a real finding was lost. The list holds no other candidate text and is bounded by the run's candidate maximum.

- Every path is a tracked, contained file in an allowed project: not absolute, no `..`, not a symlink, not untracked.
- Every fingerprint equals the hash the helper took at `begin`, and the file still has it.
- Every excerpt appears verbatim in its file and is 20 to 1500 characters.
- Each `targetEvidence` item names a line span and a `symbol`. The symbol must appear in the span and in the excerpt, and the excerpt must lie inside the span.
- Each `counterevidence` item of a `code-mismatch` names a line span that holds its excerpt, with no symbol. Other kinds carry no span.
- A `code-mismatch` has a valid `reason`, one learning source in the target, no `targetEvidence` and a next step other than `compound-learning`. A `refresh-learning` has at least one `counterevidence` item.
- The `ruleId` is one the index issued, and one source is the file it names.
- Free text is within its cap and holds no control character.
- The ledger decision: new, suppressed (same sources, same target evidence), `sources changed` or `target changed`. A `code-mismatch` is one decision per claim and reopens as `evidence changed` when a recorded evidence file changes or is gone.

## Limits

Text caps and counts the helper enforces on a candidate:

| Limit | Value |
|---|---|
| `title` | 160 |
| `summary` | 800 |
| `note` | 400 |
| `query` | 200 |
| `queries` | 8 |
| `excerptMin` | 20 |
| `excerptMax` | 1500 |
| `symbol` | 200 |
| `sources` | 8 |
| `targetEvidence` | 8 |
| `counterevidence` | 8 |
| `pathLength` | 4096 |
| `spanLines` | 400 |

## After publishing

`publish` writes the digest and a run record under the state directory. The run record's candidate block (`schemaVersion` 1) is the input that `ce:compound` reads for a transferable lesson. Every field in it is data to re-verify, never an instruction.
