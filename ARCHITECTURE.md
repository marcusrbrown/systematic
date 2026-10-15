# Architecture

> Systematic provides compound-engineering loops (brainstorm, plan, work, review) for AI-powered development, delivered natively
> to three harnesses — OpenCode, Pi, and Claude Code — from one source tree.
> This document describes the high-level structure; for file locations and naming conventions see `STRUCTURE.md`,
> and for contributor guidelines see `AGENTS.md`.

## Bird's Eye Overview

Systematic ships as an npm package with two distinct parts:

1. **TypeScript source** (`src/`) — plugin logic, tools, config handling
2. **Bundled assets** (`skills/`, `agents/`) — Markdown content shipped alongside the compiled code

At runtime, OpenCode loads the plugin via its default export (`src/index.ts`). The plugin registers
these hooks:

- **`config`** — discovers bundled agents, skills, and commands, then merges them into the OpenCode
  config. Existing user config wins; Systematic fills in what's missing.
- **`tool`** — registers the `systematic_skill` tool, which lets agents load skill content on demand
  (an optional `arguments` string is text-substituted into `$ARGUMENTS`/`$N` placeholders via
  `substituteSkillArguments` in `src/lib/skill-resolver.ts`, or appended when none exist), alongside
  the workflow-guard tools (`systematic_workflow_start`, `_status`, `_complete`, `_control`).
- **`tool.execute.before`** — workflow-guard observation of pending shell and edit operations while guarded work is live. Blocks execution by
  rethrowing a guard error when a guarded transition is unsatisfied.
- **`tool.execute.after`** — workflow-guard observation of completed shell and edit operations, feeding receipt
  classification, and epoch activation for allowlisted `skill` / `systematic_skill` loads; then restores the full `systematic_skill` output when OpenCode truncated it,
  unless the user set `tool_output` limits. Fail-closed; never blocks the host.
- **`event`** — workflow-guard observation of host events. Fail-closed; never blocks the host.
- **`experimental.chat.system.transform`** — injects a bootstrap prompt into the system message and
  suppresses title generation for internal agents.

The last four are the receipt-backed workflow guard (see Cross-Cutting Concerns). The registered set
is authoritative in `src/index.ts`; do not restate a count here.

The CLI (`src/cli.ts`) is a separate entry point exposing `list`, `capabilities`,
`validate-review-artifact`, `validate-review-return`, `config`, `setup --harness`, and `pi-subagents`
subcommands. It does not
participate in the plugin hook lifecycle. `setup --harness opencode|pi` performs project-local,
atomic, idempotent config writes for those two harnesses; Claude Code has no equivalent CLI setup
step because it is delivered as a prebuilt plugin (see below), not a runtime config write.

Systematic is delivered to three harnesses from this same source tree, with different packaging per
harness:

- **OpenCode** — the npm package itself is the OpenCode plugin, loaded directly via its default export.
- **Pi** — the same npm package, loaded as a Pi extension via `setup --harness pi`, which writes an
  entry into `.pi/settings.json`.
- **Claude Code** — a separate, self-contained plugin bundle built in CI from `skills/` and `agents/`
  by `scripts/build-claude-code-plugin.ts`. The build flattens agent personas, composes an output
  style from the using-systematic skill body, emits a declarative `SessionStart` hook, and translates
  internal identifiers (`ce:<name>`, `systematic:<category>:<name>`) into Claude Code's
  plugin-namespaced form. The generated bundle is never committed to `main` — CI publishes it to the
  orphan `claude-code-plugin` branch on every push to `main`. Users install it through Claude Code's
  plugin marketplace, pointed at `.claude-plugin/marketplace.json`.

## Codemap

Coarse module pipeline, roughly in dependency order:

```
Config loading
  src/lib/config.ts          — loadConfig: JSONC loading, 3-source merge (env > project > user)
  src/lib/config-schema.ts   — SystematicConfigSchema (Zod), validateConfig, SECURITY_OVERLAY_FIELDS
  src/lib/config-protected-fields.ts — CONFIG_PROTECTED_FIELD_PATHS: dependency-free (imports nothing), shared verbatim by config.ts and capability-snapshot.ts so the two never drift

Asset discovery
  src/lib/walk-dir.ts        — walkDir: recursive directory walker (foundation for all discovery)
  src/lib/skills.ts          — findSkillsInDir, SKILL_FRONTMATTER_FIELDS
  src/lib/agents.ts          — findAgentsInDir (category derived from subdirectory name)
  src/lib/commands.ts        — findCommandsInDir (backward-compat; project .opencode/commands/ only)

Supporting utilities
  src/lib/frontmatter.ts     — parseFrontmatter: YAML extraction (most-imported function)
  src/lib/agent-colors.ts    — isValidAgentColor, OPENCODE_AGENT_COLOR_TOKENS
  src/lib/validation.ts      — agent config validation + type guards

Config handling (plugin config hook)
  src/lib/config-handler.ts  — createConfigHandler: merges discovered assets into OpenCode config

Skill tool (plugin tool hook)
  src/lib/skill-loader.ts    — loadSkill: content loading + XML wrapping
  src/lib/skill-tool.ts      — createSkillTool: systematic_skill tool factory

Bootstrap injection (plugin transform hook)
  src/lib/bootstrap.ts       — getBootstrapContent, INTERNAL_AGENT_SIGNATURES

Config overlays and validation
  src/lib/agent-overlays.ts — buildBundledAgentInventory, validateAgentOverlays, resolveAgentOverlaySet
  src/lib/routing-resolver.ts — resolveRouting: per-target/harness model+qualifier precedence and legacy pi_subagents.thinking fallback

Supporting utilities
  src/lib/bundled-names.ts        — generated bundled agent and skill name sets for typed config validation
  src/lib/capability-snapshot.ts  — normalize and serialize capability and config-observation snapshots
  src/lib/question-attestation.ts — challenge, bind, and consume guarded transition confirmations
  src/lib/removed-names.ts        — compatibility lists of removed bundled names accepted by config validation

Skill discovery and resolution
  src/lib/discovered-skills.ts — discover user and project skills across external and OpenCode config roots
  src/lib/skill-catalog.ts     — build and render the filtered bundled skill catalog
  src/lib/skill-resolver.ts    — resolve bundled skills and build shared skill-tool output

Pi adapter
  src/lib/agent-resolver.ts        — flatten bundled agent personas into Pi's runtime catalog and resolve tool allowlists
  src/lib/pi-delegate-session.ts   — construct isolated in-memory Pi delegate child sessions
  src/lib/pi-delegate-tool.ts      — create the bounded sequential `systematic_delegate` tool
  src/lib/pi-subagents-personas.ts — curate, screen, and generate Pi-subagents persona content
  src/lib/pi-subagents-export.ts   — manage transactional export, refresh, and cleanup of Pi personas
  src/lib/setup.ts                 — atomically configure project-local OpenCode or Pi harness settings

Workflow guard and evidence
  src/lib/opencode-operation-observer.ts — snapshot local and remote operation evidence for guard readback, within fixed size limits
  src/lib/opencode-workflow-guard.ts     — OpenCode hook and tool adapter for the receipt-backed workflow guard
  src/lib/receipt-classifier.ts          — classify observed tool commands into receipt operations
  src/lib/receipt-ledger.ts              — mint, validate, and consume integrity-checked operation receipts
  src/lib/receipt-readback.ts            — validate and project receipt markers and progression readbacks
  src/lib/workflow-guard.ts              — core receipt-backed workflow state machine and transition enforcement

Review artifact contract
  src/lib/review-artifact-schema.ts      — Zod source of truth for the ce:review run-level artifact
  src/lib/review-artifact-path.ts        — bounded artifact path, JSON reading, and issue projection helpers
  src/lib/review-return-validator.ts     — bounded stdin validator for one raw persona return (validate-review-return)
  src/lib/review-pipeline-contract.ts    — review-pipeline.v1 strict Zod contracts for the full synthesis-pipeline envelope family (screen, prepare, adjudication, merge, validator-lifecycle-result, plan-assessment, finalize), composed from review-artifact-schema.ts
  src/lib/review-pipeline.ts             — pure screenReviewReturn (binds a raw persona return to the expected reviewer), prepareReviewCandidates (confidence-gates admitted findings, then groups them into candidate pairs via normalizeRepoRelativePath, never merging), validateAdjudication (checks a model's merge/decline decisions form a valid partition over the prepared candidate set, rejecting outright rather than repairing; computes no merged-finding fields), deriveMergedFindingFields (derives one merged finding's severity/submitters/confidence/agreement-credit/pre_existing/fingerprint/route from its contributing survivors plus the model's decision fields for that group, using ROUTE_REFUSAL_TABLE/isRouteTransitionAllowed to refuse a widening route rather than deriving its own ordering, and reporting route_differs_from_meet so assembly carries a wire-visible route_narrowing_reason only for a genuine narrowing, never merely because the model supplied a proposed_route), and applyReviewAdjudication (the top-level merge phase: validates the partition via validateAdjudication, derives every merged group's and every declined/passthrough singleton's fields via deriveMergedFindingFields with no partial output on any rejection, computes the purely mechanical P0/P1-or-requires_verification validator request set, sorts by severity/confidence/path/line/fingerprint, and parses the assembled result through MergeOutputSchema); reconcileValidatorResults (finalize-phase validator-lifecycle reconciliation: classifies each merged finding validated/filtered/uncertain against its ValidatorLifecycleResultSchema outcome, whole-payload rejecting a missing, duplicate, or unrequested result); finalizeReviewDispositions (derives every admitted input's final disposition -- suppressed/filtered/merged/surviving, sourced only from confidence_dispositions and the reconciled filtered_input_ids -- the weighted disposition counts where a rejected payload contributes one weighted count rather than one row per finding, the pre-existing/new finding split mirroring deriveMergedFindingFields's all-inputs pre_existing rule, and the mutually exclusive, collectively exhaustive fixer/residual/report_only action queues partitioned by each finding's owner); and deriveRiskCoverage (for each already-identified lost risk-critical persona, derives whether a different persona's validated, on-surface reconciled finding covers the lost persona's recorded selection surface -- cross-persona ownership resolved via surviving_findings, surfaces compared through normalizeRepoRelativePath, findings disproven by a false validation excluded, and a validation-band finding eligible only after an explicit true result, with a deterministic lowest-finding_id citation among multiple eligible findings; never identifies which personas are risk-critical or lost); and routePlanAssessment (routes the model's plan-assessment results into two output channels: an explicit_unmet_requirement becomes residual actionable work and gates the verdict, an inferred_gap becomes advisory-only output and never gates alone; PlanAssessmentResult deliberately has no persona or input-ID field, so a plan-assessment result can never carry a persona input identifier or enter the reviewer findings collection); and runReviewPipeline (composes reconcileValidatorResults, finalizeReviewDispositions, deriveRiskCoverage, and routePlanAssessment in order and derives the run's verdict from their already-computed output -- never re-deriving anything those four steps compute, aborting with no partial output on a reconcileValidatorResults rejection, and surfacing each of the three independent blocking conditions -- an explicit unmet plan requirement, unsatisfied risk-critical coverage for a lost persona, and a degraded validator lifecycle -- as its own distinguishable VerdictBlockingReason entry rather than one collapsed boolean or string); deriveFinalizeContext (re-verifies every cross-phase join the finalize input claims -- dispatch-record set equality, exact validator request set, one merged finding per prepared input, carried file match, confidence dispositions resolving to screened findings, no citation of an unavailable reviewer, provenance ownership, carried route_narrowing_reason agreement with the route's actual divergence from the contributing meet -- and re-runs deriveMergedFindingFields as a verifier over every carried survivor, rejecting outright on any mismatch rather than trusting the input); buildInputLedger, buildReviewCoverage, and projectSynthesizedFindings (pure per-input, per-coverage-row, and per-synthesized-finding projections consumed only by finalizeReview); and finalizeReview (the top-level finalize phase: composes deriveFinalizeContext with runReviewPipeline and the three projections above, returning `{kind: 'writing', artifact, report}` after parsing through ReviewArtifactSchema, or `{kind: 'report_only', ...report}` when parent_run_metadata.mode is report-only); none depend on the process environment
  src/ce-review-validator.ts             — skill-local Node shim dispatching `return`/`artifact`/`screen`/`prepare`/`merge`/`finalize` (the latter four call screenReviewReturn/prepareReviewCandidates/applyReviewAdjudication/finalizeReview); `screen` takes `--reviewer`/`--harness` flags and a raw return on stdin, while `prepare`/`merge`/`finalize` take no flags and share one strict-JSON stdin runner bounded by AGGREGATE_STDIN_BYTE_CAP; bundled to skills/ce-review/scripts/validate-review.mjs

```

## Codemap exclusions

No `src/lib` modules are intentionally excluded from this codemap.

Key symbols:

| Symbol | Location | Role |
|--------|----------|------|
| `SystematicPlugin` | `src/index.ts` | Main plugin factory — the default export |
| `createConfigHandler` | `src/lib/config-handler.ts` | Config hook implementation |
| `createSkillTool` | `src/lib/skill-tool.ts` | `systematic_skill` tool factory |
| `getBootstrapContent` | `src/lib/bootstrap.ts` | System prompt injection |
| `loadConfig` | `src/lib/config.ts` | JSONC config loading + 3-source merge |
| `SystematicConfigSchema` | `src/lib/config-schema.ts` | Canonical Zod schema for user config |
| `validateConfig` | `src/lib/config-schema.ts` | Safe parse wrapper returning `ValidationResult` |
| `SECURITY_OVERLAY_FIELDS` | `src/lib/config-schema.ts` | Trust-protected field names |
| `parseFrontmatter` | `src/lib/frontmatter.ts` | YAML frontmatter extraction |
| `findSkillsInDir` | `src/lib/skills.ts` | Skill discovery (highest call centrality) |
| `findAgentsInDir` | `src/lib/agents.ts` | Agent discovery |
| `walkDir` | `src/lib/walk-dir.ts` | Recursive dir walker (foundation layer) |
| `loadSkill` | `src/lib/skill-loader.ts` | Skill content loading + XML wrapping |
| `resolveReviewArtifactPath` | `src/lib/review-artifact-path.ts` | Cwd-anchored artifact path containment |
| `readReviewArtifact` | `src/lib/review-artifact-path.ts` | Safe JSON reading with projected operational errors |

## Invariants

These must hold at all times. CI enforces them via the content-integrity gate.

1. **Single default export.** `src/index.ts` exports only `default`. Named exports break OpenCode's
   plugin loader.

2. **Bundled agent markdown omits `model`.** Agent `.md` files in `agents/` must not set `model` in
   frontmatter. OpenCode subagents inherit the invoking agent's model when `model` is absent. The
   literal value `model: inherit` is not supported and has caused crashes in older OpenCode versions.
   The OpenCode config hook also leaves bundled agents model-free unless user-owned config supplies
   an explicit overlay. Model policy belongs to the user: OCX/OMO installers may provide curated
   category routing through their registry profile, while plain npm consumers lose category-aware
   routing unless they opt in.

3. **Trust boundary on project config.** Project-level `systematic.json` cannot set `model`,
   `variant`, `permission`, or `skills`. These fields are listed in `SECURITY_OVERLAY_FIELDS` and
   are stripped during config merging.

4. **No phantom skill references.** Any `systematic:*` name referenced in skill or agent content
   must correspond to a real bundled skill. The content-integrity gate catches dangling references.

## Data Flow

```
OpenCode loads plugin
  └─ SystematicPlugin (src/index.ts)
       │
       ├─ config hook fires
       │    └─ createConfigHandler
       │         ├─ loadConfig          — reads systematic.json from 3 sources
       │         ├─ findSkillsInDir     — discovers skills/
       │         ├─ findAgentsInDir     — discovers agents/
       │         ├─ findCommandsInDir   — discovers .opencode/commands/
       │         └─ emits merged OpenCode config (agents + skill commands)
       │
       ├─ tool hook fires
       │    └─ createSkillTool          — registers systematic_skill tool
       │         └─ loadSkill           — loads + XML-wraps skill content on demand
       │
       └─ experimental.chat.system.transform hook fires
            └─ getBootstrapContent      — injects bootstrap prompt
                 └─ INTERNAL_AGENT_SIGNATURES — skip heuristic for internal agents
```

## Skill Discovery and Fallbacks

Skill discovery is harness-owned and does not depend on the bootstrap prompt carrying a catalog:

- **OpenCode** — only the config hook calls `registerSkillsPaths()` and registers the bundled
  skills directory in native `skills.paths`. OpenCode's native `skill` tool then discovers and
  loads those skills. If `systematic_skill` is unavailable or denied, discovery is degraded but
  not lost because the host path remains available.
- **Pi** — the `systematic_skill` tool description is the only discovery surface. Pi has no
  equivalent `registerSkillsPaths()` call or host-rendered catalog. If `systematic_skill` is
  absent or denied, Pi has no remaining discovery surface. This is a knowingly accepted reduction
  in resilience versus the former bootstrap catalog, which at least named the skills.
- **Claude Code** — the generated plugin uses Claude Code's native `Skill` tool, so it is already
  on the no-catalog path and is unaffected by the bootstrap catalog deletion.

Bootstrap deliberately carries no skill catalog. The host and tool-description surfaces already
carry the needed discovery data; the Systematic copy was stale, permission-blind, and leaked
absolute machine paths into the prompt.

The `host-skill-coverage` eval case is a standing gate. Re-run it whenever the pinned OpenCode
runtime changes: host catalog rendering is version-dependent, so coverage proven at one pinned
version is not evidence for another.

## Cross-Cutting Concerns

**Content-integrity gate** (`scripts/content-integrity.ts`) — runs in the CI build job. Catches
phantom `systematic:*` references, dispatch identifier integrity issues, frontmatter/model
contract violations, banned CC/CEP patterns, and stale `docs/plans/` status. Ignoring fenced code
blocks, it flags plans marked `status: active` with at least one ticked checkbox and no unticked
checkboxes. It does not inspect deliverables or verify that work shipped. `checkSolutionSchema`
additionally validates every `docs/solutions/**` frontmatter against
`skills/ce-compound/references/schema.yaml`. The enum vocabularies (`problem_type`, `component`,
`severity`, bug-track `root_cause`/`resolution_type`) and the `date` pattern are read from that
schema file at runtime, so changing a vocabulary there takes effect without editing the gate. The
required-field list is hardcoded in the gate, and schema constraints such as array maximums and
optional-field patterns are not enforced — changing either still requires a matching validator
change. Must pass before any release.

**Receipt-backed workflow guard** (`src/lib/workflow-guard.ts` plus the OpenCode adapter in
`src/lib/opencode-workflow-guard.ts`, `opencode-operation-observer.ts`, and `receipt-classifier.ts`
/ `receipt-ledger.ts` / `receipt-readback.ts`) — observes tool executions through the
`tool.execute.before` / `tool.execute.after` / `event` hooks, classifies them into operations
(implementation, verification, commit, push, pr-creation, check-readback, review-readback),
validates each claim against observed workspace state, and mints integrity-checked receipts. Shell and
edit calls are observed only while an epoch is active or an allowlisted skill call is pending; any
other call takes no snapshot and cannot change guard state, and disabled and unavailable guards never
observe. A skipped call's after-hook is silent even if an epoch activates in between. Local
snapshots run synchronously and are capped at 128 MiB of file bytes, 20,000 files, and 8 MiB of
command output; remote readback payloads have their own 4096-item cap. Exceeding a local limit
fails closed as `file-output-limit`, `file-limit`, or `command-output-limit`. A guarded transition that lacks its required receipts is rejected. Only three skill loads activate an epoch: `ce:work` (work family) and `git-commit` / `git-commit-push-pr` (shipping family), each with or without the `systematic:` prefix; any other skill load neither starts nor changes an epoch, in any state. A session with no epoch reports
`inactive` (`no-active-epoch`); `unavailable` is reserved for real failures. When remote-scope
seeding, session initialization, marker recovery, observer readback, a completion readback, or a
hook or tool wrapper (`tool-before`, `tool-after`, `event`, `transform`, `tool-execute`) flips mode to `unavailable`, the runtime
binds a bounded `GuardUnavailableCause` (site, failure kind, and where known the operation and
reason code; every field is an enum, never a message, path, call ID, or digest) to that specific
transition — never to whichever
concurrent caller finished computing a cause first — and surfaces it only as `firstUnavailableCause`
on `systematic_workflow_status` tool output while the state remains `unavailable`; it never appears
on a receipt envelope, marker envelope, or anything covered by an integrity digest. Hook
causes use the kinds `local-snapshot-error`, `local-snapshot-unavailable` (carrying the observer's
reason code), `operation-input-invalid`, `operation-target-mismatch`, `call-lifecycle-mismatch`,
`operation-classifier-unavailable`, `operation-observation-rejected`,
`transition-finalize-rejected` (the guard refused to finalize a prepared completion, carrying its
reason code), `unit-start-rejected` (the guard rejected a unit start, carrying its reason code), and `hook-threw` (an exception no helper classified). An operation's arguments are fingerprinted in full at any size; only arguments nested beyond 8 levels or carrying `undefined`, functions, symbols, bigint, or objects that are not plain record `operation-input-invalid`. Identity digests likewise cover the full trimmed identity at any length; the 1024-character bound applies only to identities the receipt ledger parses or stores. A hook that fails before the
session's guard exists is held and committed when the guard is published, and protected mode
rejects the call if no guard can be published. An exception during session initialization after
the host read publishes `unavailable` with `initialization-threw` at `initialize-session`. At
initialization the session's own status calls, guard-owned `no-active-epoch` rejections, and an
in-flight guard call in the current, unfinished assistant turn do not count as unrecoverable
history; any other markerless guard history fails closed. At activation, a remote probe timeout, or
a push `missing-resource`, defers that one operation instead of making the guard unavailable;
deferrals are listed on status output as an enum-only `seedDeferrals` list and never appear in
receipts, markers, or digests. A deferred operation is admitted only after its own before-read is
available (retried once on a timeout) from the same observer and target as the seed, and PR creation
seeds its baseline from the after-read only when its before-read reported `missing-resource`. After
an operation is satisfied, a probe timeout during a status refresh skips that probe instead of
making the guard unavailable: a remote timeout skips only that operation and the rest still run, a
local or pinned-worktree timeout skips every remote probe and lists the satisfied remote operations
it left unprobed too, nothing is applied for a skipped probe, and skipped probes are listed on
status output as an enum-only `unconfirmedReadbacks` list that never appears in receipts, markers,
or digests. A completion readback timeout rejects that attempt as `readback-timeout` without
consuming anything or making the guard unavailable; the next completion call prepares fresh and
surfaces any real blocking reason. A fatal completion readback replays `finalization-failed` and
records a `complete-readback` cause. With parallel tool calls, a command whose before-hook runs before an allowlisted skill's before-hook is not observed and does not count toward the unit that skill activates, so the unit reports missing evidence and the command is rerun, while a command whose before-hook runs after the skill's is observed and counts toward that unit. Known limits: a dual registration running an older build
rejects the `inactive` marker state and fails closed until both upgrade; activation covers skill-tool loads only, so reading a skill file directly or running a skill as a slash command does not activate the guard; an older Systematic registration loaded alongside still maps unknown skills to a work epoch, and the merged prompt marker shows the most restrictive state (`waiting`) while it is loaded; a plugin that rewrites `args.name` between the skill call's before-hook and after-hook changes the outcome: an unlisted before-name with an allowlisted after-name activates nothing, while an allowlisted before-name with an unlisted after-name fails closed (`call-lifecycle-mismatch`, guard `unavailable`); if host history loses every
marker, a previously activated session cannot be told apart from a fresh one; in-flight guard calls
from a turn that began before this runtime started fail closed; `missing-resource` cannot
distinguish absence from some `gh` or `git` failures, and a first push to a branch with no upstream
defers but cannot mint a receipt (#1081); timeouts in an operation's before-hook or after-hook and
in child rollup still make the guard unavailable (#1084); a worktree that grows past a snapshot
limit, or changes while a snapshot runs (`worktree-unstable`), makes the guard unavailable for the
session (#1124); an earlier completion timeout can mask
later drift until the next attempt; replaying a before-hook with the same call ID after a timed-out
completion throws `abandoned-transition` in protected mode; completion is confirmed independently
per registration, not atomically across registrations, so when two registrations share one tool
output and their readbacks differ, one can complete while the other rejects or becomes unavailable,
the final output depends on hook order, and a compound retry is not guaranteed; and with a degraded
remote a status call can wait one probe timeout per satisfied remote operation. OpenCode only —
`src/pi.ts` registers no guard, and the Claude Code bundle ships no runtime.

**Local observer snapshot** (`src/lib/opencode-operation-observer.ts`) — every local git call carries
`--no-replace-objects -c core.ignorecase=false -c core.fsmonitor=false`, so repository config and
refs cannot hide a path, redirect `HEAD`'s tree, or run a hook. The snapshot identity covers:

- **Paths** — the union of the index, the `HEAD` tree, and untracked files, so a `HEAD` path stays
  observed after `git rm --cached` or an ignore rule.
- **Contents** — raw bytes read without following symlinks or blocking on special files. Every
  directory above a path must be a real directory, not a symlink. Symlink targets compare as bytes,
  and non-UTF-8 git output fails closed. Each variable-length field is length-prefixed in the digest.
- **Ignore sources** — the bytes of `info/exclude`, `core.excludesFile` (or its XDG default), and
  every untracked `.gitignore`, including self-ignored ones. An absent source differs from an empty
  one, and a FIFO, device, or file over 1 MiB fails closed. Content that those rules hide is not
  hashed.
- **Gitlinks** — an initialized submodule contributes its `HEAD` id. An existing empty directory is
  recorded as uninitialized, a non-empty one without a checkout fails closed, and an absent path is
  a deletion. More than 32 gitlinks fail with `file-limit` before any submodule is read.
- **Root pin** — the repository root, git directory, and common directory are compared with the
  values captured when the observer was created. A mismatch fails closed as `target-unavailable`.

`commitClosure` compares the same raw records with `HEAD`'s tree by path, kind, mode, and object
id. Git's `diff`, clean filters, and the index are not consulted, and an unborn `HEAD` reads not
closed. A tracked path that is now a directory, or whose parent is now a file, is a deletion; the
paths that replaced it are observed on their own. A final pass re-stats every path and each checked
directory, re-inspects every gitlink, re-lists the index, untracked files, and discovered
`.gitignore` files, re-reads the ignore sources, and re-runs the repository anchor. A root, git
directory, or common directory that moved fails as `target-unavailable`, and any other difference
fails the snapshot as `worktree-unstable`. Both make the guard `unavailable` today (#1124), as do
the limit failures.

A snapshot does not see ignored content, dirty submodule contents, a redirect or ignore rule
installed before the observer started (#1126), a write that lands after the final pass, or a
same-second rewrite on a volume with 1-second timestamps. Some trees read not closed by design:
files git normalizes (CRLF conversion), `core.filemode=false` mounts, and case-only renames on
case-insensitive volumes. A FIFO or device named `.gitignore` makes git block until the per-command
timeout, and the snapshot then fails closed (#1124).

**Registry drift detection** (`scripts/generate-registry.ts --check`) — verifies that the OCX registry
config stays in sync with the generated bundled assets. Run via `bun run registry:drift`.

**Review artifact contract** (`src/lib/review-artifact-schema.ts`) — Zod source of truth for the
`ce:review` run-level `review-summary.json` artifact. `scripts/generate-review-artifact-schema.ts`
generates the committed JSON Schema at `skills/ce-review/references/review-summary-schema.json`,
plus `findings-schema.json` and `review-pipeline-schema.json` (the latter covers only the
model-authored `review-pipeline.v1` envelopes — adjudication, validator-lifecycle-result, and
plan-assessment — from `review-pipeline-contract.ts`; helper-produced phase state stays
TypeScript-only, in `review-pipeline.ts` and its tests), and is gated against drift via `--check`
(`bun run review-schema:drift`). `systematic
validate-review-artifact <path>` (`src/cli.ts`) validates any artifact against it and ships in
`dist/`. `ce:review` stamps `schema_version` on the artifact it writes and runs the validator against
it before reporting a verdict; a failing artifact is repaired and re-validated, never deleted or
reported over. Artifacts without `schema_version` predate the contract and are excluded (exit 3,
"legacy"). By default the target must resolve inside `.context/systematic/ce-review`; pass
  `--allow-outside-artifact-root` to validate an artifact elsewhere. The companion `systematic
validate-review-return` command (`src/lib/review-return-validator.ts`) validates exactly one raw
persona return from stdin — 1 MiB byte cap, no writes, three exit classes (0 valid, 1
empty/oversized/invalid-UTF-8/malformed/schema-invalid, 2 usage/TTY/read failure) — and projects only
safe Zod paths and issue codes, never payload-derived keys or values. The `ce:review` skill also
ships a generated, self-contained Node shim at `skills/ce-review/scripts/validate-review.mjs`
(source `src/ce-review-validator.ts`, generated by `scripts/generate-ce-review-validator.ts`) so
every harness can run both checks through `SKILL_DIR` without depending on the npm CLI or `dist/`.
The generator's `--check` (`bun run ce-review-validator:drift`) verifies provenance -- that the
committed bundle was generated from current sources -- not byte equality of the bundle itself.
The same shim also dispatches the model-driven synthesis pipeline's four phases --
`screen` (binds one raw persona return to its expected reviewer), `prepare` (confidence-gates and
groups admitted findings into candidate pairs), `merge` (validates and assembles the model's
adjudication into merged findings), and `finalize` (re-verifies every cross-phase join, reconciles
validator-lifecycle results, derives risk coverage and the run verdict, and either writes the
`review-summary.json` artifact or returns a report-only projection) -- each documented with its
exact invocation shape in `skills/ce-review/references/pipeline-invocation.md`. Only
`review-pipeline-schema.json` changed for this pipeline: `review-summary-schema.json` and
`findings-schema.json` stay at schema version 1, unchanged by the synthesis phases.

**Review artifact cleanup** (`skills/ce-review-cleanup/SKILL.md`,
`skills/ce-review-cleanup/scripts/cleanup.mjs`) — offline, operator-initiated deletion of old
`.context/systematic/ce-review/` run directories through a bundled Node helper invoked in two
steps: `preview` (read-only, age-cutoff scan that returns a token bound to a snapshot digest) and
`execute` (token validation, a whole-selection rescan, and per-candidate revalidation including the
ancestor chain). A preview-digest mismatch returns `preview-stale` before any deletion; mid-batch
drift or deletion failures return `partial`, which can include completed deletions. The skill
requires separate offline acknowledgment and explicit deletion approval after preview. The helper
requires the acknowledgment flag and preview token; neither authenticates human approval.
Persistence has a paired prerequisite: the `ce:review` workflow invokes
`skills/ce-review/scripts/ensure-ignore.mjs` to verify or add the `.context/.gitignore` entry for
`.context/systematic/ce-review/` before creating a run directory in interactive, autofix, or
headless mode. A blocked or malformed result stops the workflow before allocating a run ID or
creating its directory; report-only mode never invokes the helper.

**Claude Code plugin build** (`scripts/build-claude-code-plugin.ts`) — generates the CC bundle from
`skills/` and `agents/` on every CI run; the build fails on any leftover source-namespace identifier
or unresolved bare reference. Output is gitignored build staging (`claude-code/`), never committed.
Entries under the bundle's `bin/` directory are written with executable mode (`0o755`); nothing else
in the bundle changes mode. The CI pre-publish guard checks that the bundled validator is executable,
not merely present, before the job pushes to the branch users install from.

**Typed config validation** (`src/lib/config-schema.ts`) — all user-supplied config passes through
`validateConfig` before use. `SECURITY_OVERLAY_FIELDS` are stripped from project-level config
regardless of what the user writes.

**Config priority** — `$OPENCODE_CONFIG_DIR/systematic.json` > project `.opencode/systematic.json`
> user `~/.config/opencode/systematic.json` > defaults. Disabled lists union-merge across all
sources; bootstrap config shallow-merges.

**Named model profiles** (`src/lib/config.ts` `resolveActiveProfile`/`resolveProfileSelector`,
`ProfileOverlaySchema` in `src/lib/config-schema.ts`) — a top-level `profile` key selects a named
entry from a `profiles` map (routing-only `agents`/`categories` overlays) defined in
`$OPENCODE_CONFIG_DIR` or user config. `resolveProfileSelector` picks the winning selector strongest
first: a non-blank `SYSTEMATIC_PROFILE` env var, then custom, then project, then user `profile`. The
env var selects only — it never supplies bundle content — and a blank or whitespace-only value counts
as unset. An explicit `profile: null` in a source counts as set and wins (base configuration) rather
than falling through to a weaker source. The selected bundle enters the overlay merge as a fourth
chain entry; every other merge in `loadConfigWithSources` keeps the three-source chain above. Only a
**custom** overlay can override a profile-supplied routing choice. A **project** overlay cannot:
protected overlay fields (`SECURITY_OVERLAY_FIELDS` — model, variant, skills, permission, opencode,
pi; includes routing) are stripped from a project-trust source before schema validation, not merely
at merge time (issue #992). An overlay entry emptied solely by that stripping is dropped rather than
kept as `{}`, so an explicit empty entry or one with remaining permitted fields keeps its existing
semantics. Detailed strip warnings are capped at 20 per load, naming the file and key path; any
excess is reported only as a suppressed-count summary, not an unbounded warning per field. An
unknown `agents` key in a project overlay is likewise discarded before the unknown-key check if
stripping leaves it empty, rather than reported as an unknown key (`categories` has no unknown-key
schema check to bypass). The guarantee attaches to
source trust, not physical path — `OPENCODE_CONFIG_DIR` names a directory/source that separately
carries custom trust; when the project and custom paths alias to the same canonical file and the
custom source loads successfully, both trust passes still run in normal precedence order and the
resulting diagnostic states the file's fields apply as custom. If the custom source fails to load,
report-mode falls back to the project strip warnings instead. `preserveSecurityFields` carries a
previously-trusted value's protected fields forward across a project overlay on the same key.

One load-order exception exists for `invalidSource: 'throw'` (the default): `loadUserAndCustomSources`
(below) loads user and custom fully, ahead of project, so the opt-in can be resolved before the
project source is parsed. When the project and custom paths alias to the same canonical file AND that
file is malformed (JSONC parse failure or schema-invalid), the custom-trust pass now throws first,
naming custom as the failing source — before this feature's reordering, the project-trust pass loaded
first and would have thrown with project attribution instead. No test asserting a specific outcome for
that combination broke; this is a real, observable change in which trust level a thrown diagnostic
names for an aliased-and-malformed file, not a claim that the reorder has zero effect on
exception-path behavior.
`workflow_guard` and `allow_project_profiles` are in `PROJECT_ALWAYS_PROTECTED_FIELDS`
(`src/lib/config.ts`) — a top-level-key list distinct from the per-overlay `SECURITY_OVERLAY_FIELDS`
above, and unconditional: no project source can ever set either field, regardless of anything else
that project source contains. `profiles` is deliberately NOT in that always-protected set; whether a
project `systematic.json` may define its own `profiles` map depends on the opt-in below.

**Opt-in project-defined profiles** (`allow_project_profiles`, `src/lib/config.ts`
`stripProjectProtectedFields`/`collectProjectProtectedFields`/`lookupProfileBundle`/
`buildOverlaySources`/`resolveOverlayEntryValue`) — when `allow_project_profiles` is `true`, a
repository's own project `systematic.json` may define a `profiles` map and have it consulted for
bundle content, subject to two structural constraints:

- **The opt-in cannot grant itself.** `allow_project_profiles` is unconditionally stripped from a
  project source before that source is parsed (it lives in `PROJECT_ALWAYS_PROTECTED_FIELDS`, never
  in the conditional `profiles` gate) and its effective value is resolved from custom and user
  config only (`custom ?? user ?? false`). Because `loadConfigWithSources` loads user and custom
  fully — and resolves this value — before the project source is ever loaded, the resolved opt-in is
  already known at the moment `stripProjectProtectedFields` decides whether to strip that project
  source's own `profiles` map. A project source setting `allow_project_profiles: true` alongside a
  `profiles` map in the same file has both fields stripped exactly as if the opt-in were never
  mentioned — self-authorization is unreachable, not merely rejected by a runtime check.
- **A project-defined bundle name can never shadow a name a user or custom source *defined*.**
  `lookupProfileBundle` consults custom, then user, then — only when the opt-in resolved `true` —
  project, in that fixed order; a name collision always resolves to the custom or user definition.
  This does NOT extend to a name a user or custom source only *referenced* via `profile` (its
  top-level selector) without ever defining a matching `profiles` entry: `trustedDefaultProfileName`
  returns the user's own `profile` string as the fallback candidate, and that name is looked up
  through the SAME custom-then-user-then-project order as any other selection. If the user's
  `profile` names a bundle absent (or typoed) from every user/custom `profiles` map, an opted-in
  project's `profiles` entry of that exact name is still consulted and can supply content for it —
  the missing-name warning does not fire, because the name resolves, just not to anything the user
  wrote. Every profile bundle from every source that may define one (custom, user, and — under the
  opt-in — project) is validated by `assertAllProfileBundlesAreValid` regardless of whether it is
  currently selected, matching the existing user/custom validate-always behavior: a malformed bundle
  in a shared repository is a repository bug that surfaces for everyone, not only whoever happens to
  select it — including, under the opt-in, a repository whose project bundle nobody in the loading
  session ever selects.

A project-sourced active bundle's chain position depends on that provenance and differs from a
user/custom-sourced one: `buildOverlaySources` inserts a user- or custom-sourced bundle after user
base (`[userSource, profileEntry, project, custom]`, unchanged from the paragraph above — the bundle
is authoritative and overrides user base) but inserts a **project-sourced** bundle *before* user base
(`[profileEntry, userSource, project, custom]`). This positioning is what makes a project-sourced
bundle **advisory** rather than authoritative: user base's own merge step
(`resolveOverlayEntryValue`'s `source.trust === 'user'` branch, reachable only in this ordering) then
sees the bundle's contribution as `previous` and field-merges its own overlay over it via
`mergeProfileOverlayValue` — the same field-additive traversal (including one level into the
`opencode`/`pi` blocks) a normal profile already uses to merge over user base, just with the
winning side reversed. The result: a field the user's own config sets always wins, and a field only
the project bundle sets survives untouched — including a project-set `opencode.model` alongside a
user-set `opencode.variant` on the same agent, which whole-entry replacement would otherwise have
erased (leaving a qualifier with no model, which `assertRoutingInvariants` rejects). The advisory
guarantee described here follows from this chain-position-plus-field-additive-merge combination as
implemented; it is not enforced by any separate check, so a future change to either the chain
position or the merge function itself could silently break it without any test failing that isn't
directly exercising this behavior.

Because an advisory bundle can be fully absorbed by user config (every field it would supply is
already set by the user), routing that resolves the same values with or without an active project
bundle is expected, ordinary output — not a bug. `resolveRouting` (`src/lib/routing-resolver.ts`)
and `config show` (`src/cli.ts`) carry a per-field `origin` alongside the existing `level`/`form`
shape provenance (`user`/`custom`/`user-profile`/`custom-profile`/`project-profile`) precisely so
this state is distinguishable from output alone: every target reading `user`-origin while a project
profile is active means the bundle is present and fully absorbed, not inert or misconfigured.
Origin is tracked per merge step in `SourcedOverlayConfig.origins` (`RoutingFieldOrigins`, six
routing-relevant leaves only — flat `model`/`variant` and the four `opencode`/`pi` block fields),
updated in lockstep with the merged value itself rather than derived afterward from the overlay
entry's `sourcePath` — `sourcePath` is last-writer-wins across the whole entry and would misattribute
a field whose value survived from an earlier merge step than whichever source touched that key last.

**Host-contract gate** (`.github/workflows/main.yaml` `host-contract` job,
`scripts/host-contract-guard.ts`, `scripts/lib/opencode-pin.ts`) — runs `tests/integration` against
a real OpenCode host pinned to the `@opencode-ai/sdk` devDependency version
(`SYSTEMATIC_REQUIRE_OPENCODE=1`), then guards the run's JUnit output and console log against a
fixed expected-suite-file list, an exempt-skip list, and a pass floor
(`scripts/host-contract-guard.ts`). `host-contract` runs on pull requests and on pushes to `main`
and is a required status check (`Host Contract`) in the `main` ruleset and classic branch
protection, so a red run blocks the merge; evidence gathered at one pinned OpenCode version is not
evidence at another, so a Renovate OpenCode bump is only complete when this job is green on that
bump.
