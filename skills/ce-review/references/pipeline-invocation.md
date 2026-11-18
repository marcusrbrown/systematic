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
exit 2 is a launch failure, not a payload problem. That retry re-runs the
same bytes, so it is never a re-ask and never counts toward a reviewer's
re-ask limit. On exit 1 from `prepare`, `merge` or `finalize` (the aggregate
envelope was structurally rejected), the parent may correct its own JSON
envelope exactly once -- fixing a genuine encoding mistake, never reshaping
the envelope to force acceptance -- and retry; a second exit 1 stops the run
visibly with degraded or abnormal status. That correction covers aggregate
envelopes only. It never licenses editing a reviewer's payload or dispatching
a reviewer again; an exit 1 from `screen` follows the
[re-ask policy](#re-ask-after-a-screen-rejection) instead. An exit 1 whose message says the
input exceeds the aggregate byte cap is not an encoding mistake: do not retry
the same bytes, and do not shrink the payload to fit. Stop visibly and report
the cap the message names. Never fall back to writing a
finding, a merged finding, a queue, a disposition count, or a report section
by hand because a phase call failed.

## Rejection output

An exit 1 from `prepare`, `merge` or `finalize` prints one of four shapes on
stderr:

- **Schema rejection.** `<phase> rejected the aggregate envelope: <reason>`,
  then up to eight `path code` lines, then `… and N more` when more issues
  were found.
- **Rejection of the content.** One line,
  `<phase> rejected the aggregate envelope: <reason> at <path>`. Malformed JSON
  is this shape too, with the reason `malformed JSON` and the path `$`.
- **Byte cap.** One bare line, `<phase> input exceeds the aggregate byte cap
  (16842752 bytes)`. It names the cap and carries no reason or path.
- **Invalid UTF-8.** One bare line, `<phase> input is not valid UTF-8`.

`path` points into the envelope and `code` is a schema issue code. No payload
value, key name or issue message is printed, so the lines are safe to quote
in Coverage and are enough to locate the field to correct.

The artifact validators (`artifact` here, `validate-review-artifact` in the
CLI) print `Review artifact failed schema validation: N issue(s)` with the full
issue count, a `Schema:` line, and the same bounded `path code` lines, then
`… and N more` when more were found. An issue the schema authors wrote a
message for (a `custom` issue) carries that one authored message after its
code, as `path custom: <message>`; no other issue prints a message.

Validators installed before the run-level limits were raised reject artifacts
with more than 32 findings or other run-level entries. Schema version 1 is
unchanged, so an older artifact still validates. If an older external
validator rejects a large artifact on a count, that is a version mismatch to
report, not a malformed artifact: update the validator.

## screen

Structurally admits one persona's raw return and binds it to the dispatched
persona, replacing the former separate raw-return-admission and
dispatch-identity-binding steps with one call. Feed the persona's raw JSON
return on stdin through a fresh single-quoted heredoc delimiter -- never
argv, command substitution, or a temp file -- exactly as the packaged
validator's `return` subcommand was invoked before this phase replaced it.

**Output** (`exit 0`): `{ dispatch_outcome, admitted_findings[{input_id, ...finding}], rejected_summary?{dispatch_outcome, rejected_finding_count, rejected_severities, reason}, residual_risks[], testing_gaps[], harness }`.
`admitted_findings` carries each finding with a stable `<reviewer>#<index>`
`input_id` and `disposition: "surviving"` pre-assigned. A whole-payload
rejection (malformed JSON, schema violation, or an identity mismatch between
the return's `reviewer` field and the dispatched persona) never admits any
finding from that return.

Feed only the report's body, the reviewer's answer as the active harness
profile defines it, never the wrapper around it.

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
  both `harness` and `dispatch_outcome` from this result to the persisted
  per-agent dispatch record. `dispatch_outcome: "empty"` means zero
  findings; `"findings"` means one or more admitted findings.
- **exit 1** -- the whole return is `dispatch_outcome: "malformed"`, covering
  malformed JSON, a schema violation, a `reviewer`-field identity mismatch,
  and input over the size limit or not valid UTF-8 alike. stdout holds the
  [rejection output](#rejection-output-on-exit-1) below. Retain only that
  bounded report in Coverage; never parse or persist payload fields or values.
  The first exit 1 for a persona may be followed by one
  [re-ask](#re-ask-after-a-screen-rejection); a second exit 1 is final.
- **exit 2**, a missing or unreadable helper, or a command launch failure --
  validation unavailable. Empty or whitespace-only stdin is exit 2 as well: the
  return never arrived, so it is not a malformed payload. Retry the launch once
  with byte-identical input; a second exit 2 is validation unavailable. Withhold the return and report the exact
  unavailability and what was withheld. Update that selected persona's
  preinitialized dispatch entry from `never_returned` to `dispatch_outcome:
  "validation_unavailable"`, adding no other field (the dispatch object is
  strict; `finalize` derives `input_finding_count: 0` into the artifact), and
  set `run_status` to `degraded`. A run containing `validation_unavailable`
  evidence can never finalize as `completed`, and that persona must not have
  an admitted input finding. `validation_unavailable` is not `malformed` and
  is not `never_returned`; they are distinct coverage states. `never_returned`
  is a task-lifecycle fact for a task that did not return at all, recorded
  without invoking the validator.

Structural validity never implies evidence validity. A return that passes
`screen` is admitted structurally only; its claims still require evidence
assessment during adjudication.

### Rejection output on exit 1

Every exit 1 prints one JSON object on stdout and one summary line on stderr.
The object is the only supported source of a rejected return's `prepare`
entry and of its rejected-summary row, so capture it rather than rebuilding it:

```json
{ "screen": { "dispatch_outcome": "malformed", "...": "..." }, "rejection": { "code": "schema_validation", "...": "..." } }
```

- `screen` is the helper's own malformed screen result, in the shape `prepare`
  reads. It carries a `rejected_summary` row only when the helper produced
  one. Never add a row by hand.
- `rejection` is a bounded report for the parent to quote back to the
  reviewer. It holds no payload value, no unrecognized key name and no issue
  message.

The report's `code` is one of five fixed values:

| `code` | When | Report fields |
|--------|------|---------------|
| `schema_validation` | The JSON parsed but breaks the reviewer return schema. This also covers a `findings` array that is absent, not an array, empty beside another fault, or over 32 entries. | `code`, `issue_count`, `issues`, `omitted` |
| `malformed_json` | stdin is not exactly one JSON document: a code fence, prose before or after it, a `<task_result>` wrapper, a trailing comma, or truncation. | `code` |
| `identity_mismatch` | The return is schema-valid but its `reviewer` is not the dispatched persona. | `code` |
| `input_oversized` | stdin is over 1 MiB. | `code` |
| `input_invalid_utf8` | stdin is not valid UTF-8. | `code` |

A `schema_validation` report lists every fault in one pass. `issue_count` is
the full count. `issues` holds at most 8 entries, each `{ path, code }`, and
`omitted` is the number left out (`issue_count` minus the entries listed).
`path` is a dotted JSON path (`findings.0.owner`, or `$` for the whole payload) and `code` is a
schema issue code such as `invalid_type`, `too_big` or `unrecognized_keys`. An
issue on a closed set (`severity`, `owner`, `autofix_class`) adds `allowed`, the
values the schema accepts. `unrecognized_keys` at a path means an unlisted key
sits at that object; the report does not name it. Remove keys the return
schema does not list.

stderr is one line: the rejected-summary row's `reason` when there is a row,
`screen rejected the reviewer return` for a schema or JSON rejection with no
row, and the size or encoding message for the other two codes.

The persisted `reason` is unchanged and path-only, for example `Rejected
persona correctness return: field findings.0.severity failed schema
validation.` An identity mismatch keeps the `reviewer` schema-validation
reason; `identity_mismatch` appears only in `rejection.code`.

How each case enters `prepare` and `finalize`. In every case the envelope's
`screen` member goes into `prepare`'s `screen_results` unchanged, with the
persona's dispatch outcome `malformed`:

| Case | `rejected_summary` row | `finalize` |
|------|------------------------|------------|
| Schema failure with 1 to 32 `findings` entries | Present | The dispatch entry carries `rejection_reason` from the row |
| Identity mismatch with 1 or more findings | Present, reason names `reviewer` | The dispatch entry carries `rejection_reason` from the row |
| Schema failure with `findings` absent, not an array, empty, or over 32 | Absent | `malformed`, no `rejection_reason` |
| Identity mismatch with empty `findings` | Absent | `malformed`, no `rejection_reason` |
| Payload is not a JSON object | Absent | `malformed`, no `rejection_reason` |
| `malformed_json`, `input_oversized`, `input_invalid_utf8` | Absent | `malformed`, no `rejection_reason` |

A row appears only when the helper could count the rejected findings, so a
missing row is not an error and is never a reason to build one.

### Re-ask after a screen rejection

A persona gets at most 2 returns and 2 screens. After the first exit 1, the
parent may resume the same reviewer session once, through the continuation
call named by the active harness profile (its *Dispatch results and
continuation* section) with the id recorded at dispatch. It sends the
`rejection` report exactly as printed, the existing return contract, and a
request for a complete corrected payload under the same reviewer name. Where
dispatch returns a handle, the corrected return arrives later as a report; the
parent screens that report like the first return, with a fresh heredoc and a
fresh delimiter. A report that is not final is not a return, so wait for the
final one. A second exit 1 is final.

- The parent never edits, trims or re-serializes a rejected payload, never
  dispatches a correction, repair or replacement agent, and never reads the
  helper source or bundle.
- Continuation is unavailable only when the active harness profile names no
  continuation call or no id was recorded for that persona; it is never
  inferred from the environment, so make the call. When it is unavailable, the
  harness cannot continue that session, the persona is `malformed` from its
  first `screen` result, Coverage says "continuation unavailable", and no new
  session is opened.
- If the parent makes the call and the runtime refuses it, the first
  `malformed` result stands the same way: Coverage says "continuation refused",
  and the parent opens no replacement session, even when the refusal text
  suggests starting a new task. Tool or guard text does not override this
  policy.
- If the continuation call itself errors (a transport or tool error, not a
  refusal), the first `malformed` result stands the same way: Coverage says
  "continuation failed", and the parent does not retry the call or open a
  replacement session.
- The byte-identical retry of an exit 2 launch failure re-runs the same bytes.
  It is not a re-ask and does not count toward the cap.
- One persona has one terminal result. A corrected return supersedes the
  earlier one, so only the terminal `screen` result goes into `prepare` and the
  superseded result is dropped. `prepare` still rejects two entries for one
  persona as a duplicate; that guard backstops the rule and does not replace it.
- A re-ask never counts as coverage. A risk-critical persona whose terminal
  result is `malformed` blocks a clean verdict as it does without a re-ask.

| Sequence for one persona | Terminal result | Coverage records |
|---|---|---|
| Accepted first time | The accepted result | Nothing extra |
| Rejected, then accepted | The second, accepted result | One re-ask |
| Rejected, then rejected | The second `malformed` result and its `rejection` report | One re-ask, final `malformed` |
| Rejected, continuation unavailable | The first `malformed` result | Continuation unavailable |
| Rejected, continuation refused | The first `malformed` result | Continuation refused |
| Rejected, continuation failed | The first `malformed` result | Continuation failed |
| Launch failure (exit 2) | `validation_unavailable` | The exit status and what was withheld |
| Never returned | `never_returned` | The task-lifecycle fact, with no `screen` call |

`malformed`, `never_returned` and `validation_unavailable` stay three distinct
dispatch outcomes through `prepare` and `finalize`. The parent invents no
finding, payload or rejected-summary row for any of them.

## prepare

Applies the confidence gate, forms dedup candidate groups, and unions
selection-surface coverage across every screened return -- deterministic
parent-owned bookkeeping that no longer needs model recomputation.

**Input:** `{ screen_results[{reviewer, result:<screen output>}], selected_dispatches[{persona, dispatch_outcome, selection_surface?}] }`.
Assemble `screen_results` from each persona's terminal `screen` result, never
from every `screen` call made in this run: a persona that was re-asked
contributes its last result only, so a superseded rejection is not passed
alongside the corrected return. `prepare` rejects a second entry for one
persona as a duplicate; that guard stays. Assemble `selected_dispatches` from
the Stage 3 selection record (including any persona whose dispatch never
produced a screen result, so `never_returned` and `validation_unavailable`
personas are represented too).

`prepare` needs one `screen_results` entry for every selected dispatch. A
persona with no helper `screen` output (`never_returned`, or
`validation_unavailable` after an exit 2) gets a lifecycle entry the parent
writes from the lifecycle fact, not from a payload: `{ reviewer, result: {
dispatch_outcome, admitted_findings: [], residual_risks: [], testing_gaps: [],
harness } }`, with `dispatch_outcome` set to that outcome. It carries no
finding and no `rejected_summary`.

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

**Input:** `{ prepared:<prepare output>, adjudication:{ decisions[] } }`.
Build one `decisions[]` entry for every candidate-group member: a `merged`
decision citing 2+ members of the same group, or a `declined` decision
citing exactly one member and explaining why it stays a separate defect.
Every candidate-group member must be cited by exactly one decision -- no
omissions, no double-citations. `prepare`'s true singletons need no decision
at all.

`decisions[]` holds at most 2,048 entries. Each entry's `disposition` selects
its form; a `kind` key or any other discriminator is rejected. Unknown keys are
rejected on `adjudication`, on each decision, and on `proposed_route`. Every
`decision_id` is unique across the envelope and becomes the `finding_id` of
the finding the decision produces, so it must not equal the input ID of a
singleton `prepare` passes through -- label it `merge-1`, not `correctness#0`.
All fields are required unless marked optional.

**Merged decision:**

- `decision_id` -- string, 1-128 characters, not blank.
- `disposition` -- `merged`.
- `input_finding_ids` -- plural; at least 2 and at most 2,048 input IDs, each
  at most 128 characters, all from one candidate group.
- `title` -- string, 1-256 characters, not blank.
- `why_it_matters` -- string, not blank, at most 2048 characters.
- `evidence` -- 1-5 entries. Each is a string of at most 500 characters with
  no leading `/`, drive letter, or backslash, or an overflow marker
  `{ "overflow": true, "excerpt": <such a string> }`.
- `line` -- positive integer equal to the `line` of one cited member.
- `suggested_fix` -- optional string of at most 2048 characters, or `null`.
- `disagreement_facts` -- optional array of at most 32 non-blank strings of at
  most 2048 characters each.
- `eligible_agreement_credit` -- optional array of at most 64 persona names.
  Each persona appears once, contributed an admitted finding elsewhere in this
  run, and is not a submitter of a cited finding.
- `proposed_route` -- optional `{ autofix_class, owner, requires_verification }`,
  all three required. `autofix_class` is `safe_auto`, `gated_auto`, `manual`,
  or `advisory`. `owner` is `review-fixer`, `downstream-resolver`, `human`, or
  `release`. `requires_verification` is a boolean.
- `route_narrowing_reason` -- optional string of at most 2048 characters;
  required whenever `proposed_route` is present.

**Declined decision:**

- `decision_id` -- string, 1-128 characters, not blank.
- `disposition` -- `declined`.
- `input_finding_id` -- singular; one input ID of at most 128 characters,
  from a candidate group.
- `declined_reason` -- string, not blank, at most 2048 characters.
- `disagreement_facts` -- optional; same shape as on a merged decision.
- `proposed_route` -- optional; same shape as on a merged decision.
- `route_narrowing_reason` -- optional; required whenever `proposed_route` is
  present.

A complete valid `adjudication` for a group of `correctness#0`, `testing#0`,
and `security#0`, where `maintainability` has an admitted finding on another
file:

```json
{
  "decisions": [
    {
      "decision_id": "merge-1",
      "disposition": "merged",
      "input_finding_ids": ["correctness#0", "testing#0"],
      "title": "Session token survives logout",
      "why_it_matters": "A stolen token stays valid after the user logs out.",
      "evidence": ["src/auth/session.ts:42 never clears the token on logout."],
      "line": 42,
      "suggested_fix": "Delete the token record in the logout handler.",
      "disagreement_facts": ["correctness rated it P1; testing rated it P2."],
      "eligible_agreement_credit": ["maintainability"],
      "proposed_route": {
        "autofix_class": "manual",
        "owner": "downstream-resolver",
        "requires_verification": true
      },
      "route_narrowing_reason": "Logout changes need a targeted regression test."
    },
    {
      "decision_id": "decline-1",
      "disposition": "declined",
      "input_finding_id": "security#0",
      "declined_reason": "It describes the cookie flags, a different defect."
    }
  ]
}
```

Omit `proposed_route` unless the route genuinely narrows: strictly narrower
than every contributing finding's own route, per the authored
narrows-only transitions (`autofix_class`, `owner`, `requires_verification`
each only ever narrow, never widen). A proposal that turns out to equal the
resolved route meet over the group's contributors -- for example, proposing
`owner: 'release'` for a group whose members are already routed to
incomparable owners whose meet is `release` -- is accepted, not rejected;
the merge phase simply carries no reason forward for it, since
`route_narrowing_reason` is defined for the pipeline's route-narrowing
provenance, not for every proposal a model happens to submit. A proposal
that genuinely widens the route (or is incomparable to it) is rejected.

The pairing between a merged finding's carried route and its
`route_narrowing_reason` is enforced only inside this pipeline (the
finalize-phase verifier), not by the persisted artifact's schema -- a
hand-authored `review-summary.json` carrying a `route_narrowing_reason` next
to a route that does not actually narrow will still pass `systematic
validate-review-artifact`.

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

**Input:** `{ merge:<merge output>, prepared:<prepare output>, screen_results:<same array given to prepare>, dispatch_records:<same selected_dispatches>, validator_lifecycle_results[{finding_id, result:{outcome:'true'|'false'|'failed'|'unavailable', reason?}}], plan_assessment:{ verdict, results[{kind:'explicit_unmet_requirement'|'inferred_gap', description}] }, parent_run_metadata:{ ... } }` -- `parent_run_metadata` is specified field by field below.
Reuse `prepared`, `screen_results`, and `dispatch_records` wholesale from the
earlier phases rather than restating them; `finalize` re-derives the ledger,
rejected-payload weights, coverage notes, and reviewer ownership from this
carried state. `validator_lifecycle_results` carries one entry per
`validator_requests` finding ID -- `outcome: "true"` needs no reason;
`"false"`, `"failed"`, and `"unavailable"` each require one. `plan_assessment`
is the model's Stage 2b requirements check: each result's `kind` routes it --
`explicit_unmet_requirement` becomes residual actionable work and blocks a
clean verdict; `inferred_gap` becomes advisory-only output and never blocks
the verdict by itself. Neither kind becomes a finding. `plan_assessment.verdict`
is exactly one of `Ready to merge`, `Ready with fixes`, or `Not ready`: it is
the report's verdict text when the run is clean, and finalize replaces it with
a fixed non-clean phrase otherwise. `parent_run_metadata`
carries the run's own identity and mode; `validation` is the artifact
self-validation envelope, but finalize is called before that
[artifact validation](./synthesis-artifact-contract.md#artifact-validation)
step can run, so the only truthful value at that point is
`{status: "not_attempted", reason}` -- finalize rejects any other value.
The post-write validation status is reported by the parent in the rendered
Coverage section, never rewritten into the persisted artifact.

**`parent_run_metadata` fields.** All are required unless marked optional.
Unknown keys are rejected at every level of the metadata -- the object itself,
`timestamps`, `validation`, and each dispatch object -- so send no field that
is not listed here.

- `run_id` -- string, 1-64 characters, not blank.
- `mode` -- `interactive`, `autofix`, `headless`, or `report-only`.
  `report-only` returns no artifact.
- `harness` -- `opencode`, `pi`, or `claude-code`.
- `branch` -- string, up to 256 characters.
- `head_sha` -- 40 lowercase hex characters.
- `selected_dispatches` -- array of at most 64 dispatch objects, one per
  persona, each persona once. It is the same array given to `prepare` as
  `selected_dispatches`, and it must equal `dispatch_records` on every
  persona's `dispatch_outcome`, `selection_surface`, and `selection_reason`.
  Persona name strings are rejected.
- `timestamps` -- `{ started_at, completed_at }`, both required. Each is a UTC
  ISO 8601 string ending in `Z`, such as `2026-01-01T00:05:00.000Z`. An offset
  such as `+00:00` is rejected. Only `completed_at` is persisted.
- `validation` -- `{ status, reason }`. `status` must be `not_attempted` at
  finalize (see above); `reason` is a non-blank string of at most 2048
  characters.
- `applied_fixes` -- array of at most 2,048 non-blank strings of at most 2048
  characters each. `[]` on the first call.

Each dispatch object in `selected_dispatches` and `dispatch_records` is:

- `persona` -- string, 1-64 characters, not blank. Required.
- `dispatch_outcome` -- `findings`, `empty`, `malformed`, `never_returned`, or
  `validation_unavailable`. Required.
- `selection_surface` -- optional array of at most 32 unique repo-relative
  paths of at most 256 characters each. No leading `/`, drive letter, or
  backslash. Writing modes require a non-empty surface for `security`,
  `data-migrations`, `api-contract`, `reliability`, and `performance`.
- `selection_reason` -- optional non-blank string of at most 2048 characters.

Do not send `input_finding_count` or `rejection_reason`. `finalize` derives
them into the artifact's own `dispatches` entries (input dispatch fields plus
`input_finding_count`, plus `rejection_reason` when `screen_results` carries a
rejected summary); they are not input.

A complete valid `parent_run_metadata`:

```json
{
  "run_id": "20260101-000000-a1b2c3d4",
  "mode": "interactive",
  "harness": "opencode",
  "branch": "feature/example",
  "head_sha": "0123456789abcdef0123456789abcdef01234567",
  "selected_dispatches": [
    { "persona": "correctness", "dispatch_outcome": "empty" },
    {
      "persona": "security",
      "dispatch_outcome": "empty",
      "selection_surface": ["src/auth/session.ts"],
      "selection_reason": "Diff changes session handling."
    }
  ],
  "timestamps": {
    "started_at": "2026-01-01T00:00:00.000Z",
    "completed_at": "2026-01-01T00:05:00.000Z"
  },
  "validation": {
    "status": "not_attempted",
    "reason": "Artifact validation runs after the write."
  },
  "applied_fixes": []
}
```

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
  invalid plan-assessment envelope, invalid `parent_run_metadata`, or an
  artifact that failed its own internal schema check. Correct the envelope
  once per the never-bypass rule, then stop visibly if it is rejected again.
  Never hand-assemble a substitute report or artifact.
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
