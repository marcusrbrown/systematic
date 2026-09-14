# Pipeline Phase Invocation

This is the canonical invocation detail for the four pure stdin phases of the
packaged validator shim that `ce:review`'s Stage 4-6 and post-review handoff
call at their decision boundaries: `screen`, `prepare`, `merge`, and
`finalize`. `SKILL.md` keeps
terse call sites; this document carries the envelope shapes and the full
invocation blocks. `return` and `artifact` are unchanged and documented at
their existing call sites (Stage 4 raw-return history and the
[synthesis artifact contract](./synthesis-artifact-contract.md)).

Every block below reassigns `SKILL_DIR` in the same fenced block, terminated
with `;`, and invokes `node "$SKILL_DIR/scripts/validate-review.mjs" <phase>`
-- never a bare relative path, and never a Claude-only path substitution
(off-Claude harnesses would silently expand it to nothing).

## Never-bypass

A helper failure (exit 1 or exit 2) is never permission to hand-synthesize
the phase's output. On exit 2 (usage error, TTY input, or a stdin read
failure), retry the launch exactly once with byte-identical input; a second
exit 2 is a launch failure, not a payload problem. On exit 1 (the input
was structurally rejected), the parent may correct its own JSON envelope
exactly once -- fixing a genuine encoding mistake, never reshaping the
envelope to force acceptance -- and retry; a second exit 1 stops the run
visibly with degraded or abnormal status. Never fall back to writing a
finding, a merged finding, a queue, a disposition count, or a report section
by hand because a phase call failed.

## screen

Structurally admits one persona's raw return and binds it to the dispatched
persona, replacing the former separate raw-return-admission and
dispatch-identity-binding steps with one call. Feed the persona's raw JSON
return on stdin through a fresh single-quoted heredoc delimiter -- never
argv, command substitution, or a temp file -- exactly as the packaged
validator's `return` subcommand was invoked before this phase replaced it.

**Output** (`exit 0`): `{ dispatch_outcome, admitted_findings[{input_id, ...finding}], rejected_summary?{dispatch_outcome, rejected_finding_count, rejected_severities, reason}, residual_risks[], testing_gaps[] }`.
`admitted_findings` carries each finding with a stable `<reviewer>#<index>`
`input_id` and `disposition: "surviving"` pre-assigned. A whole-payload
rejection (malformed JSON, schema violation, or an identity mismatch between
the return's `reviewer` field and the dispatched persona) never admits any
finding from that return.

Before each invocation, choose a fresh delimiter for that exact raw payload
over a safe token alphabet (`A-Z`, `0-9`, `_`), for example a random hex
token, and verify the delimiter is absent as a complete line in that exact
raw payload before running. Never reuse a fixed delimiter across payloads.
Open the heredoc with a single-quoted heredoc opener (`<<'DELIM'`) so the
payload is never interpolated, and close it with a line containing exactly
that delimiter.

```bash
# Resolve the validator relative to the skill's own directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/validate-review.mjs" screen --reviewer <persona> --harness <opencode|pi|claude-code> <<'SCREEN_INPUT_A1B2C3D4'
<the persona's returned JSON payload, copied verbatim>
SCREEN_INPUT_A1B2C3D4
```

Read the exit status:

- **exit 0** -- structurally admitted. Parse the already structurally
  validated JSON without logging the raw text; the parent may then attach
  `harness` and `dispatch_outcome` from this result to the persisted
  per-agent dispatch record. `dispatch_outcome: "empty"` means zero findings;
  `"findings"` means one or more admitted findings.
- **exit 1** -- the whole return is `dispatch_outcome: "malformed"`, covering
  malformed JSON, a schema violation, and a `reviewer`-field identity
  mismatch alike. Retain only the bounded validator diagnostic on stderr in
  Coverage; never parse or persist payload fields or values.
- **exit 2**, a missing or unreadable helper, or a command launch failure --
  validation unavailable. Withhold the return and report the exact
  unavailability and what was withheld. Update that selected persona's
  preinitialized dispatch entry from `never_returned` to `dispatch_outcome:
  "validation_unavailable"` with `input_finding_count: 0`, and set
  `run_status` to `degraded`. A run containing `validation_unavailable`
  evidence can never finalize as `completed`, and that persona must not have
  an admitted input finding. `validation_unavailable` is not `malformed` and
  is not `never_returned`; they are distinct coverage states. `never_returned`
  is a task-lifecycle fact for a task that did not return at all, recorded
  without invoking the validator.

Structural validity never implies evidence validity. A return that passes
`screen` is admitted structurally only; its claims still require evidence
assessment during adjudication.

## prepare

Applies the confidence gate, forms dedup candidate groups, and unions
selection-surface coverage across every screened return -- deterministic
parent-owned bookkeeping that no longer needs model recomputation.

**Input:** `{ screen_results[{reviewer, result:<screen output>}], selected_dispatches[{persona, dispatch_outcome, selection_surface?}] }`.
Assemble `screen_results` from every `screen` call made in this run, and
`selected_dispatches` from the Stage 3 selection record (including any
persona whose dispatch never produced a screen result, so `never_returned`
and `validation_unavailable` personas are represented too).

**Output:** `{ confidence_dispositions, coverage_union, singletons, candidate_groups[{file, members[{input_id,line}]}], surviving_findings }`.
`candidate_groups` are the file-grouped, line-sorted sets of two or more
admitted findings from different personas that the model must adjudicate in
`merge`. `singletons` are admitted findings that passed the confidence gate
but did not land in any candidate group -- they need no adjudication and flow
straight through. `confidence_dispositions` and `coverage_union` are the
suppressed-finding ledger and the unioned selection-surface coverage list
respectively; both feed later phases and Coverage reporting without further
recomputation.

```bash
# Resolve the validator relative to the skill's own directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/validate-review.mjs" prepare <<'PREPARE_INPUT_A1B2C3D4'
{ "screen_results": [...], "selected_dispatches": [...] }
PREPARE_INPUT_A1B2C3D4
```

Choose a fresh delimiter the same way as `screen`'s. Read the exit status:

- **exit 0** -- the aggregate envelope validated; parse the JSON result and
  carry it into adjudication.
- **exit 1** -- the aggregate envelope was rejected (malformed JSON or a
  structural violation against the screen results and selected dispatches
  supplied). Never hand-assemble a substitute `prepare` output.
- **exit 2**, a missing helper, or a launch failure -- unavailable; retry
  once with identical bytes per the never-bypass rule above, then stop
  visibly.

## merge

Applies the model's adjudication decisions to `prepare`'s candidate groups,
deriving each merged finding's severity, confidence (including the
cross-reviewer agreement boost), fingerprint, submitters, and conservatively
narrowed route -- the model supplies judgment per candidate group; the helper
supplies the arithmetic and the narrowing rule.

**Input:** `{ prepared:<prepare output>, adjudication:<model envelope with decisions[]> }`.
Build one `decisions[]` entry for every candidate-group member: a `merged`
decision citing 2+ input IDs from the same group with the merged finding's
`title`, `why_it_matters`, `evidence`, `line`, `proposed_route` (when the
merge's route should narrow), `route_narrowing_reason` (required whenever
`proposed_route` is present), and optional `disagreement_facts` and
`eligible_agreement_credit`; or a `declined` decision citing exactly one
input ID with a `declined_reason` explaining why it stays a separate defect.
Every candidate-group member must be cited by exactly one decision -- no
omissions, no double-citations. `prepare`'s true singletons need no decision
at all.

**Output:** `{ merged_findings, validator_requests[{finding_id,file,line}], disagreement_facts }`.
`validator_requests` names the merged findings that fall inside the Stage 5b
gating band (P0/P1 severity, or `requires_verification: true`) -- dispatch
exactly one validator subagent per entry, looking up that finding's full
fields from `merged_findings` by `finding_id`.

```bash
# Resolve the validator relative to the skill's own directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/validate-review.mjs" merge <<'MERGE_INPUT_A1B2C3D4'
{ "prepared": { ... }, "adjudication": { "decisions": [...] } }
MERGE_INPUT_A1B2C3D4
```

Choose a fresh delimiter the same way as `screen`'s. Read the exit status:

- **exit 0** -- the adjudication envelope validated against the prepared
  candidate set; parse the JSON result and carry `merged_findings` and
  `validator_requests` forward.
- **exit 1** -- the envelope was rejected: malformed JSON, a schema
  violation, an omitted or double-cited candidate member, or a merged
  decision inconsistent with its cited members. Correct the envelope once
  per the never-bypass rule, then stop visibly if it is rejected again.
  Never hand-assemble a substitute merged-finding set.
- **exit 2**, a missing helper, or a launch failure -- unavailable; retry
  once with identical bytes, then stop visibly.

## finalize

Synthesizes the run's final report and, in writing modes, the persistable
artifact: reconciles validator lifecycle results against `merge`'s
`validator_requests`, routes the model's plan-assessment results into
residual actionable work and advisory output, derives the risk-aware
verdict, and computes every queue, disposition count, and coverage entry.
Called once with `applied_fixes: []` to obtain the queues that drive fix
dispatch; fix-applying modes call it again with the exact applied-fix
outcomes and the same validator results, and only that second call is
persisted. Report-only calls it once and writes nothing.

**Input:** `{ merge:<merge output>, prepared:<prepare output>, screen_results:<same array given to prepare>, dispatch_records:<same selected_dispatches>, validator_lifecycle_results[{finding_id, result:{outcome:'true'|'false'|'failed'|'unavailable', reason?}}], plan_assessment:{ verdict, results[{kind:'explicit_unmet_requirement'|'inferred_gap', description}] }, parent_run_metadata:{ run_id, mode:'interactive'|'autofix'|'headless'|'report-only', harness, branch, head_sha, selected_dispatches, timestamps:{started_at, completed_at}, validation:{status, reason?}, applied_fixes[] } }`.
Reuse `prepared`, `screen_results`, and `dispatch_records` wholesale from the
earlier phases rather than restating them; `finalize` re-derives the ledger,
rejected-payload weights, coverage notes, and reviewer ownership from this
carried state. `validator_lifecycle_results` carries one entry per
`validator_requests` finding ID -- `outcome: "true"` needs no reason;
`"false"`, `"failed"`, and `"unavailable"` each require one. `plan_assessment`
is the model's Stage 2b requirements check: each result's `kind` routes it --
`explicit_unmet_requirement` becomes residual actionable work and blocks a
clean verdict; `inferred_gap` becomes advisory-only output and never blocks
the verdict by itself. Neither kind becomes a finding. `parent_run_metadata`
carries the run's own identity and mode; `validation` is the artifact
self-validation status set from the [artifact validation](./synthesis-artifact-contract.md#artifact-validation)
step, required for every status except `passed`.

**Output:** `{ kind:'writing', artifact, report }` or `{ kind:'report_only', ...report }`.
`report` carries `verdict`, `findings`, `applied_fixes`,
`residual_actionable_work`, `advisory_outputs`, `coverage`,
`input_dispositions`, `disposition_counts`, `queues{fixer,residual,report_only}`,
`pre_existing_findings`, and `risk_coverage` -- render Stage 6 directly from
this projection rather than recomputing any of it. In writing modes,
`artifact` is the exact `review-summary.json` payload to persist.

```bash
# Resolve the validator relative to the skill's own directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/validate-review.mjs" finalize <<'FINALIZE_INPUT_A1B2C3D4'
{ "merge": { ... }, "prepared": { ... }, "screen_results": [...], "dispatch_records": [...], "validator_lifecycle_results": [...], "plan_assessment": { ... }, "parent_run_metadata": { ... } }
FINALIZE_INPUT_A1B2C3D4
```

Choose a fresh delimiter the same way as `screen`'s. Read the exit status:

- **exit 0** -- parse the JSON result. In writing modes, capture the exact
  stdout bytes to a same-directory temp file (see
  [Persisting the artifact](#persisting-the-artifact) below) before rendering
  the report; report-only renders `report` directly and writes nothing.
- **exit 1** -- the aggregate envelope was rejected: a shape mismatch against
  `merge`/`prepared`, a missing or extra validator-lifecycle result, an
  invalid plan-assessment envelope, or an artifact that failed its own
  internal schema check. Correct the envelope once per the never-bypass
  rule, then stop visibly if it is rejected again. Never hand-assemble a
  substitute report or artifact.
- **exit 2**, a missing helper, or a launch failure -- unavailable; retry
  once with identical bytes, then stop visibly.

### Persisting the artifact

Writing-mode `finalize` stdout is the wrapper
`{ kind: 'writing', artifact, report }`, not the artifact by itself. In
interactive, autofix, and headless modes, after the persisted `finalize` call
succeeds, extract only the captured stdout's `artifact` member -- never the
whole wrapper -- and write that JSON to a temp file created exclusively with
owner-only permissions in the same `.context/systematic/ce-review/<run-id>`
directory as the final artifact, then atomically rename it over
`review-summary.json`. Render the report from the same captured stdout's
`report` member. No `jq` dependency is assumed; Node performs the extraction:

```bash
node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(JSON.stringify(r.artifact))' \
  < "$FINALIZE_STDOUT" > "$TEMP_FILE"
```

Remove the temp file on any non-success (a rejected `finalize` call, a write
failure, or an interrupted run) instead of leaving a partial file behind.
Only after the rename succeeds does the parent run the existing `artifact`
subcommand (see the
[synthesis artifact contract](./synthesis-artifact-contract.md#artifact-validation))
against the persisted path. Report-only never creates the run directory,
never writes a temp file, and never runs `artifact` validation -- it has no
artifact to validate.
