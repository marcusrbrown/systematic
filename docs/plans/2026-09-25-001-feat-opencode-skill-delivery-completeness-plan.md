---
title: Complete OpenCode skill delivery
type: feat
status: completed
date: 2026-09-25
origin: docs/brainstorms/2026-09-25-skill-delivery-requirements.md
---

# Complete OpenCode skill delivery

## Overview

`systematic_skill` keeps each call's full output in plugin memory and restores it in the `tool.execute.after` hook after OpenCode truncates it. It skips restoration when the user has set their own `tool_output` limit. The tool gains an optional `arguments` string, substituted with OpenCode's native command semantics. Discovered-skill slash commands inline their full body once a real-host probe confirms how native shell snippets behave. The workflow guard stops ignoring skill loads larger than 32 KB.

## Problem Frame

OpenCode v1.18.32 truncates every plugin tool's output to 2,000 lines or 50 KiB (UTF-8 bytes), keeping the head, in `registry.ts` `fromPlugin`. This happens before any plugin hook runs, and the host overwrites any `metadata.truncated` value the plugin sets. `ce-review` (71.5 KB) and `ce-plan` (63 KB) reach the model cut off today, and `ce-compound-refresh` (48 KB) is close to the limit once wrapped. The origin document's claim that the tool "already delivers the complete body" is wrong. The body Systematic builds is complete; what the model receives is not.

Slash commands are a different path. Command templates become user-message text in `SessionPrompt.command`, and nothing truncates them. Bundled skill commands already inline the full body. Discovered, model-invocable skills get a one-line pointer shim instead (`buildDiscoveredSkillShimTemplate`).

Separately, the workflow guard's `parseHostOutput` rejects any tool output over 32,768 characters. `finishSkill` gates on that result, so loading any large skill never activates its guarded epoch. This happens with or without truncation, because even a truncated preview is about 51 KB.

## Requirements Trace

Carried from the origin document:

- R1. `systematic_skill` keeps its bundled-only lookup and delivers the complete body at the boundary the model sees, except where R10 applies.
- R2. Every Systematic-registered slash command, bundled or discovered, inlines the complete body. No pointer shim.
- R3. End-to-end full delivery is mandatory. A host limit does not satisfy R1 or R2, except as refined by R10.
- R4. `systematic_skill` gains an optional raw-string argument. When omitted, the body's placeholders stay literal, matching OpenCode's native `skill` tool and Pi. An explicit empty string substitutes empty. The value is never inferred. (Changed during implementation: bundled skills refer to `$ARGUMENTS` by name in their prose, and substituting empty broke those instructions.)
- R5. Both paths substitute `$ARGUMENTS` and positional placeholders with native OpenCode semantics.
- R6. The tool performs text substitution only. It never executes snippets.
- R7. Slash commands keep native OpenCode template processing unchanged.
- R8. An isolated real-host probe gates discovered-skill full-body inlining. An unsafe finding is escalated, not shipped.
- R9. Discovered-skill commands keep their existing eligibility, permission behavior, and routing.

Added during planning (user-confirmed):

- R10. When the user's OpenCode config sets `tool_output.max_lines` or `tool_output.max_bytes`, `systematic_skill` does not restore past that limit. The host's truncated result stands.
- R11. Guarded-skill activation depends on host success status, not on output length.

## Scope Boundaries

- OpenCode only. Pi keeps calling `buildSkillContentOutput` without arguments and must see identical output. Claude Code is untouched.
- `systematic_skill` lookup stays bundled-only.
- Tool output for other tools, including OpenCode's native `skill` tool, is not restored.
- The sampled `<skill_files>` list is unchanged.
- No global `tool_output` config writes, no dependency changes, no config schema changes.

### Deferred to Separate Tasks

- Compaction pruning: OpenCode's opt-in `compaction.prune` can later clear a restored `systematic_skill` result. It protects only the tool literally named `skill`, and there is no exemption mechanism. File an issue.

## Context & Research

### Relevant Code and Patterns

- `src/lib/skill-tool.ts` `createSkillTool`: `execute` resolves the skill, builds output, awaits `context.ask`, sets metadata, and returns a string.
- `src/lib/skill-resolver.ts` `buildSkillContentOutput`: builds the `<skill_content>` wrapper. It is shared with `src/pi.ts`.
- `src/lib/config-handler.ts` `loadDiscoveredSkillAsCommand` / `buildDiscoveredSkillShimTemplate`: shim for model-invocable discovered skills. Skills marked `disable-model-invocation: true` already inline their body through `wrapSkillTemplate`.
- `src/index.ts`: the `tool.execute.after` wrapper calls `workflowGuard.hooks['tool.execute.after']` inside a swallow-all try.
- `src/lib/opencode-workflow-guard.ts`: `MAX_HOST_OUTPUT_LENGTH`, `parseHostOutput`, `isSuccessfulAfter`, `finishSkill`. `mergeProgressionMarker` writes into `output.metadata`.
- Mock OpenAI-compatible provider plus real OpenCode host: `tests/integration/fixtures/receipt-workflow-host.ts`, `tests/integration/receipt-workflow-guard-real-host.test.ts`, `tests/integration/ce-review-return-validation.test.ts`. These tests read `systematic_skill` tool parts and the provider's inbound request bodies.
- `tests/unit/opencode-workflow-guard.test.ts` models one shared output object across hooks. Use it for ordering and metadata-merge tests.

### Institutional Learnings

- `docs/solutions/best-practices/cross-harness-adapter-parity-contract-tests-2026-07-14.md`: shared-core tests do not prove adapter parity. Test the OpenCode adapter boundary and the unchanged Pi output separately.
- `docs/solutions/workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md`: prove delivery against a real host, not mocks.
- `docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md`: isolate HOME, XDG, and config for host probes.
- `docs/solutions/integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md`: `src/index.ts` keeps its single default export.

### External References (OpenCode `v1.18.32`, verified at the tag)

- `packages/opencode/src/tool/registry.ts` `fromPlugin`: spreads `Tool.Context` (including `callID`) into the plugin ctx, calls `truncate.output(output, {}, agent)`, and returns `{ truncated, outputPath? }` metadata.
- `packages/opencode/src/tool/truncate.ts`: defaults to `MAX_LINES = 2000` and `MAX_BYTES = 50 * 1024`, overridable by `tool_output.max_lines/max_bytes`. The head preview is followed by `\n\n...<n> <lines|bytes> truncated...\n\n<hint>`, and the full text is written to `outputPath`.
- `packages/opencode/src/session/tools.ts`: `tool.execute.after` receives `{ tool, sessionID, callID, args }` with the same `callID`. It runs only when `execute` returns. The host persists and returns the mutated `output`.
- `packages/opencode/src/session/message-v2.ts`, `processor.ts`: no further truncation between the persisted part and the model request at this version.
- `packages/opencode/src/session/prompt.ts` `SessionPrompt.command`: positional placeholders first, then `$ARGUMENTS`, with unplaced arguments appended. `!`-backtick snippets run through `Process.text` with no permission request. No size truncation.
- `packages/opencode/src/session/compaction.ts`: `PRUNE_PROTECTED_TOOLS = ["skill"]`, and pruning only runs when `compaction.prune` is set.
- `packages/opencode/src/plugin/index.ts`: hooks run sequentially and share one output object.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "repo root (bounded to src/lib, src/index.ts, src/pi.ts, tests/unit, tests/integration)",
  "freshness": {
    "vcs_reference": "09c0ad1"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/skill-tool.ts",
      "description": "Owns the systematic_skill tool factory, permission gate, and execute bridge; extended with argument input, output capture, and the restore helper.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/skill-resolver.ts",
      "description": "Owns bundled skill lookup and the <skill_content> payload; extended with optional native-semantics argument substitution.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/config-handler.ts",
      "description": "Owns skill-to-command emission and the discovered-skill shim; the shim is replaced by full-body inlining, and the config hook records whether tool_output limits are user-set.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts",
      "description": "Owns guarded-skill completion via finishSkill/isSuccessfulAfter; extended so skill completion no longer depends on output length.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/index.ts",
      "description": "Owns OpenCode hook wiring; the tool.execute.after wrapper gains the restore step after the guard.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "tests/integration/fixtures/receipt-workflow-host.ts",
      "description": "Real OpenCode host plus mock OpenAI-compatible provider fixture; reused for delivery, argument, and probe scenarios.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/pi.ts",
      "description": "Pi systematic_skill adapter calling buildSkillContentOutput; must remain behaviorally unchanged.",
      "disposition": "reuse"
    }
  ]
}
```

## Key Technical Decisions

- **Capture and restore, not regeneration:** `execute` stores the exact string it returns, after `context.ask` resolves. The after hook restores that string. This delivers exactly what the permission check approved, adds no disk read, and has no drift window. `callID` reaches `execute` at runtime, but the installed `@opencode-ai/plugin` `ToolContext` type omits it, so read it with a runtime record check.
- **Restore conditions:** restore only when all of these hold:
  - the tool is `systematic_skill`;
  - an entry exists for `sessionID + callID`;
  - `metadata.truncated === true`;
  - no user-set `tool_output` limit exists (R10);
  - the host's preview, before the truncation marker, is a prefix of the stored text.

  The prefix check protects any earlier plugin that replaced the output. Always delete the entry.
- **Metadata after restore:** merge into `output.metadata`; never replace it, because it carries the guard's progression markers. Set `truncated: false` and remove `outputPath`. Leave the host's saved file on disk; OpenCode manages it.
- **Bounded capture store:** plugin-instance memory, capped at 32 entries with oldest evicted, plus a 5-minute TTL. This bounds leaks from calls that abort or error after `execute` returns. The worst case is about 2.4 MB.
- **Hook order:** inside the existing `tool.execute.after` wrapper, the guard runs first and the restore second, each in its own try. The guard's observations stay exactly as they are today.
- **User-set limit detection:** the plugin's config hook receives the same merged config object that OpenCode's truncator reads. OpenCode never writes its default limits into that object; they are constants in `truncate.ts`. So a defined `tool_output.max_lines` or `tool_output.max_bytes` means the user or project set it. If both are absent, restore. The config hook records that flag on the plugin instance, and the restore step reads it. Treat the config as `unknown` and parse it defensively, because only the v2 SDK `Config` type declares `tool_output`. The Unit 6 host tests prove the flag end to end for both settings.
- **Native substitution, reimplemented:** the tool's substitution mirrors `SessionPrompt.command` at v1.18.32:
  - parse positional arguments with quote stripping;
  - the highest `$N` consumes the rest of the arguments;
  - missing positions become empty;
  - `$ARGUMENTS` becomes the raw string;
  - with no placeholders and a non-blank argument, the argument is appended after a blank line.

  The tool substitutes only the skill body, not the wrapper lines, and only when `arguments` is present. With `arguments` omitted, the tool's output is byte-identical to Pi's.
- **Argument text is data on the tool path:** the tool's substituted output is a tool result sent to the model. It never passes through command-template processing, so `!`-backtick text inside `arguments` is never executed. On the slash-command path, snippets that arrive through arguments are native OpenCode behavior (R7), and Unit 1 characterizes them.
- **Positional-placeholder hygiene in bundled skills:** `ce-review`'s awk snippet uses `$1`/`$2`, which native substitution (already applied by `/ce:review` today) blanks out. Rewrite it as awk `$(1)`/`$(2)`, which does not match the placeholder pattern. Add a unit test that fails if any bundled skill body contains a `$<digit>` token. This plan makes the tool apply positional substitution to every bundled skill, and `/skill` commands already do. A future `$1` in any shell example would silently corrupt both paths, so the check is a guard on the new behavior, not a general lint rule.
- **Guard fix is narrow:** skill completion checks success using host status and structure, without the output length cap. Other `isSuccessfulAfter` callers and `MAX_HOST_OUTPUT_LENGTH` stay as they are.
- **Discovered-skill trust boundary:** discovered skills have the same trust as OpenCode's own skill commands. OpenCode already registers each discovered skill as a native command whose template is the skill content, and its `!` snippets run on invocation. Inlining therefore adds no new kind of exposure for any skill directory OpenCode itself scans. Any directory that Systematic discovers but OpenCode does not is a new exposure; Unit 1 checks for that.
- **Discovered-skill inlining is gated:** Unit 5 does not start until Unit 1's probe evidence is recorded in the plan. Escalate before Unit 5 if either is true: the probe shows Systematic's inlining makes snippets execute where native OpenCode would not, or Systematic discovers a directory that OpenCode does not.

## Open Questions

### Resolved During Planning

- Does `callID` reach plugin `execute`? Yes. `fromPlugin` spreads `Tool.Context`, and `session/tools.ts` sets `callID: options.toolCallId`. It is the same value the after hook receives.
- Is anything truncated after the after hook? Not at v1.18.32. Persistence and model conversion carry the output through unchanged, except for opt-in compaction pruning, which is deferred.
- Do slash-command templates get truncated? No. They become user-message text.
- Does the after hook run on errors? No. It runs only after `execute` returns, so denied permissions never leave entries behind.

### Deferred to Implementation

- Does the config the plugin's config hook receives actually carry `tool_output` from user and project config? Verify against the real host before relying on the R10 flag.
- The exact form of the truncation-marker match used by the prefix check: match the literal `\n\n...` + count + `lines|bytes truncated...` pattern from `truncate.ts`.
- The Unit 1 probe outcomes, recorded under Unit 1 before Unit 5 starts.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```mermaid
sequenceDiagram
  participant M as Model
  participant H as OpenCode host
  participant T as systematic_skill.execute
  participant S as Capture store
  participant G as Guard after-hook
  participant R as Restore after-hook
  M->>H: tool call (name, arguments?)
  H->>T: execute(args, ctx{sessionID, callID})
  T->>T: resolve, build body, substitute arguments
  T->>H: context.ask(permission: skill)
  T->>S: store(sessionID+callID, full output)
  T-->>H: full output
  H->>H: truncate.output (2000 lines / 50 KiB)
  H->>G: after(input, output)  %% sees truncated preview
  G->>G: finishSkill (success by status, not length)
  H->>R: after(input, output)
  R->>S: take(sessionID+callID)
  R->>R: truncated && no user limit && preview is prefix?
  R-->>H: output.output = full; metadata.truncated=false
  H->>M: full skill body
```

## Implementation Units

- [x] **Unit 1: Real-host probe for native command snippet execution**

**Goal:** Record, before discovered-skill inlining, whether and how OpenCode runs `!`-backtick snippets from an inlined command template, including snippets that come from arguments.

**Requirements:** R8, R9

**Dependencies:** None

**Files:**
- Create: `tests/integration/skill-command-probe.test.ts`
- Modify: this plan (record the findings under this unit)

**Approach:**
- Use an isolated real host: temp HOME/XDG, the project checkout loaded as a plugin, and the mock provider from the existing fixtures.
- Add a discovered project skill whose body contains a harmless `!`-backtick snippet that writes a sentinel file inside the temp directory. Invoke its slash command through the SDK command API.
- Observe: whether the sentinel exists; whether a permission request was raised; what text reached the provider in place of the snippet. Run once with the snippet in the body and once supplied only through `$ARGUMENTS`.
- Compare the skill directories Systematic's discovery scans (`src/lib/discovered-skills.ts`) with the directories OpenCode v1.18.32 registers as native skill commands. Record any directory that only Systematic scans.
- Keep the probe as a characterization test, so a future host bump re-proves it.

**Execution note:** Characterization first. Record the observed behavior; do not assert a desired behavior.

**Test scenarios:**
- Integration: a body snippet invoked via slash command → record sentinel existence, whether permission was asked, and the substituted text.
- Integration: a snippet supplied only via `$ARGUMENTS` to a body containing `$ARGUMENTS` → record the same three observations.
- Integration: the same skill invoked through today's shim (before Unit 5) → no sentinel. This is the baseline.
- Integration: the same skill invoked through OpenCode's own native command for it, if one exists → record the same observations for comparison with native behavior.

**Findings (OpenCode v1.18.32, `tests/integration/skill-command-probe.test.ts`):**
- OpenCode's own command for a discovered skill (`source: "skill"`) inlines the raw body. Its `!` snippets run before the model sees the text.
- Systematic's current shim shadows that command: OpenCode skips native registration for any name already claimed. So today's shim hides the body, and the body snippet does not run.
- Snippets supplied as arguments run even through today's shim, because the shim contains `$ARGUMENTS` and substitution happens before the snippet scan.
- `disable-model-invocation: true` skills, which Systematic already inlines, run body snippets too.
- No permission request was raised in any case, even under a deny-all ruleset. Command-template snippets have no permission gate at this version.
- Every directory Systematic scans for skills, OpenCode also scans. OpenCode additionally scans `skills.paths` and `skills.urls`.
- Gate result: neither escalation condition holds. Inlining restores exactly what OpenCode itself does without Systematic, and no Systematic-only directory exists. Unit 5 proceeds.

**Verification:**
- Findings are recorded under this unit. If execution happens without a permission request for body or argument snippets, stop and escalate the decision before Unit 5.
- The probe run reaps every spawned `opencode` process by baseline diff, never with a blanket kill.

- [x] **Unit 2: Guard skill activation independent of output size**

**Goal:** Loading a skill larger than 32 KB activates its guarded epoch.

**Requirements:** R11

**Dependencies:** None

**Files:**
- Modify: `src/lib/opencode-workflow-guard.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- `finishSkill` uses a success check that validates output shape and failure status but has no output length cap. Other callers keep `isSuccessfulAfter`.

**Test scenarios:**
- Happy path: guarded skill with a 60 KB successful output → epoch activates and progression markers merge into metadata.
- Edge case: a 51 KB host truncation preview with `metadata.truncated: true` → activates.
- Error path: 60 KB output with `metadata.status: 'error'` → no activation.
- Regression: other operation receipts still reject output over the cap.

**Verification:**
- The guard's unit suite passes, and a large-skill activation is observable in unit tests.

- [x] **Unit 3: Argument parameter and native substitution**

**Goal:** `systematic_skill` accepts an optional `arguments` string and substitutes it into the skill body with native command semantics.

**Requirements:** R4, R5, R6

**Dependencies:** None

**Files:**
- Modify: `src/lib/skill-resolver.ts`, `src/lib/skill-tool.ts`, `skills/ce-review/SKILL.md`
- Test: `tests/unit/skill-tool.test.ts`, `tests/unit/skill-resolver.test.ts` (create if absent), `tests/unit/pi.test.ts`

**Approach:**
- Substitution is a pure function over the body. `buildSkillContentOutput` takes an optional argument. When the argument is `undefined`, no substitution runs. The OpenCode tool passes `args.arguments` through unchanged, so an omitted argument leaves placeholders literal.
- The parameter description tells the model to pass only text the user explicitly supplied.
- Rewrite the `ce-review` awk placeholders to `$(1)`/`$(2)`. Add a test that no bundled skill body contains a `$<digit>` token.
- No snippet execution anywhere in this path.

**Patterns to follow:**
- Native `SessionPrompt.command` ordering and quote handling at v1.18.32, per Key Technical Decisions.

**Test scenarios:**
- Happy path: body with `$ARGUMENTS`, argument `fix the thing` → substituted verbatim.
- Happy path: body with `$1 $2`, argument `a "b c" d` → `a` and `b c d`.
- Edge case: argument omitted → placeholders stay literal.
- Edge case: explicit empty string → `$ARGUMENTS` and `$1` become empty.
- Edge case: no placeholders, non-blank argument → appended after a blank line. Whitespace-only → not appended.
- Edge case: argument containing `!` plus backticks → substituted as literal text, and nothing executes.
- Regression: Pi call without an argument → byte-identical to the pre-change output.
- Regression: every bundled skill body has no `$<digit>` token.

**Verification:**
- Unit suites pass. `tests/unit/pi.test.ts` passes unchanged.

- [x] **Unit 4: Capture and restore full tool output**

**Goal:** The model receives the complete `systematic_skill` output past the host's default truncation, unless the user has set a limit.

**Requirements:** R1, R3, R10

**Dependencies:** Unit 3 (the stored output is post-substitution)

**Files:**
- Modify: `src/lib/skill-tool.ts`, `src/lib/config-handler.ts`, `src/index.ts`
- Test: `tests/unit/skill-tool.test.ts`, `tests/unit/plugin.test.ts`, `tests/unit/config-handler.test.ts`

**Approach:**
- `skill-tool.ts` keeps the capture store and exports a restore function. The `createSkillTool` return shape does not change.
- Store only after `context.ask` resolves, when a `callID` is present. With no `callID`, skip capture and let host behavior stand.
- The config handler records whether `tool_output` limits are user-set. It passes the flag to the restore step through the plugin instance, not a global.
- `src/index.ts` runs the restore step after the guard in the existing after wrapper, in its own try. It never throws to the host.

**Test scenarios:**
- Happy path: execute stores the output; the after hook receives a head preview with the marker and `truncated: true` → full output restored, `truncated: false`, `outputPath` removed, guard markers preserved.
- Edge case: output under the limit (`truncated: false`) → untouched; entry deleted.
- Edge case: user-set `tool_output.max_bytes` → not restored; entry deleted.
- Edge case: user-set `tool_output.max_lines` only → not restored; entry deleted.
- Edge case: config with a `tool_output` object but neither limit defined → restored.
- Edge case: preview is not a prefix of the stored output (another plugin rewrote it) → untouched.
- Edge case: two concurrent calls with different `callID`s → each restores its own output.
- Error path: `context.ask` rejects → nothing stored.
- Edge case: 33 stored entries → oldest evicted. An expired entry is not restored.
- Integration (unit-level): the shared output object passes through the guard hook, then the restore hook → markers survive and the output is full.
- Regression: other tools' outputs are never modified.

**Verification:**
- Unit suites pass. `src/index.ts` still has only a default export.

- [x] **Unit 5: Inline full body for discovered-skill slash commands**

**Goal:** Model-invocable discovered skills' commands carry their full body instead of the shim.

**Requirements:** R2, R7, R9

**Dependencies:** Unit 1 findings accepted (the gate)

**Files:**
- Modify: `src/lib/config-handler.ts`
- Test: `tests/unit/config-handler.test.ts`

**Approach:**
- Use `wrapSkillTemplate(skill.skillPath, skill.body)` for every discovered skill and delete `buildDiscoveredSkillShimTemplate`. Keep the description, `disabled_commands` filtering, and precedence exactly as they are.
- Update the doc comment to describe the new behavior and the native processing it inherits.

**Test scenarios:**
- Happy path: a model-invocable discovered skill → the template contains the full body and base-directory note, with no shim text.
- Regression: a `disable-model-invocation: true` skill → unchanged template.
- Regression: disabled commands and name precedence → unchanged command set.
- Regression: command entries keep only the fields they had before. No new `agent`, `model`, or `subtask` keys.

**Verification:**
- Unit suite passes. The command set for a fixture tree is identical apart from the template content.

- [x] **Unit 6: Real-host delivery and regression coverage**

**Goal:** Prove end-to-end delivery at the model boundary on the pinned host.

**Requirements:** R1–R5, R9–R11, success criteria

**Dependencies:** Units 2–5

**Files:**
- Create: `tests/integration/skill-delivery.test.ts`
- Modify: `scripts/host-contract-guard.ts` (add the new suite files to the expected-suite list)

**Approach:**
- Use the mock provider plus the real host. Assert on the provider's inbound request that follows the tool call, not only the stored part.
- Size tiers use fixture skills, not bundled ones, so the test doesn't depend on content size. Bundled skills are only reached through the tool, so add one bundled check using `ce-review`, the largest.

**Test scenarios:**
- Integration: tool call for a fixture skill below the limit, at exactly 50 KiB, and above it → the provider request contains a unique tail sentinel at every tier.
- Integration: tool call for `ce-review` → its final line reaches the provider.
- Integration: host started with a user `tool_output.max_bytes` → the provider sees the host's truncated preview (R10).
- Integration: host started with a user `tool_output.max_lines` → the provider sees the host's truncated preview (R10).
- Integration: tool call with `arguments` → substituted text reaches the provider. Omitted → placeholders stay literal.
- Integration: slash command for a bundled skill and a discovered skill with a body above the limit → the tail sentinel reaches the provider, and arguments are substituted.
- Integration: loading a guarded skill over 32 KB → the epoch activates, observed through `systematic_workflow_status`.
- Regression: the `tests/integration/pi.test.ts` and `tests/integration/claude-code.test.ts` suites pass unchanged.

**Verification:**
- The integration suites pass locally against the pinned OpenCode version. The host-contract guard lists the new files. No spawned `opencode` processes are left behind.

- [x] **Unit 7: Documentation**

**Goal:** Document the new tool argument, the restoration behavior and how to opt out, and discovered-command inlining.

**Requirements:** R4, R10, R2

**Dependencies:** Units 3–5

**Files:**
- Modify: `ARCHITECTURE.md` (the `tool.execute.after` hook purpose), `docs/src/content/docs/` (the page describing `systematic_skill` and slash commands; locate it during implementation)

**Approach:**
- Explain that OpenCode truncates plugin tool output and that Systematic restores the full skill body unless `tool_output` is set. Note the pruning caveat. Describe the `arguments` parameter.
- `ARCHITECTURE.md` already has unrelated local edits in the working tree. Coordinate so those edits are neither lost nor bundled in unintentionally.

**Test expectation:** none (documentation only). Verify with `bun run docs:build`.

**Verification:**
- The docs build passes and the content-integrity gate passes.

## System-Wide Impact

- **Interaction graph:** the `tool.execute.after` wrapper now has two steps, guard then restore. The config hook gains one read-only observation.
- **Error propagation:** both after steps swallow errors, as today. A restore failure leaves the host's truncated output.
- **State lifecycle risks:** capture entries are bounded by cap and TTL. The host's truncation files are never touched.
- **API surface parity:** Pi's `systematic_skill` does not get the argument parameter in this work (OpenCode-only scope). Its output stays byte-identical.
- **Integration coverage:** truncation, hook ordering, and command processing only show up against the real host; Unit 6 covers them.
- **Unchanged invariants:** the single default export, bundled-only tool lookup, native command processing, and guard receipt caps for non-skill operations.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A future OpenCode version changes truncation, hook order, or the marker format | The prefix check fails safe (no restore). The Unit 6 host-contract tests catch it on the next pin bump. |
| Restoring 70 KB outputs raises context cost | This is intended (R3). Users can opt out with `tool_output`. |
| The probe finds unapproved snippet execution for discovered skills | Unit 5 is gated; escalate before shipping. |
| Opt-in compaction pruning clears restored skills | Deferred; issue to be filed. |
| Tool arguments corrupt skill bodies that use `$<digit>` as literal text | The bundled hygiene test plus the `ce-review` rewrite. Discovered skills already get this treatment from native commands today. |

## Documentation / Operational Notes

- Unit 6 adds real-host suites, which run under the required `host-contract` job.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-09-25-skill-delivery-requirements.md](../brainstorms/2026-09-25-skill-delivery-requirements.md). This file is gitignored and exists only locally. Its summary claim that the tool already delivers the complete body is corrected in this plan's Problem Frame.
- Related code: `src/lib/skill-tool.ts`, `src/lib/skill-resolver.ts`, `src/lib/config-handler.ts`, `src/lib/opencode-workflow-guard.ts`, `src/index.ts`
- External: `https://github.com/anomalyco/opencode/tree/v1.18.32/packages/opencode/src` (`tool/registry.ts`, `tool/truncate.ts`, `session/tools.ts`, `session/prompt.ts`, `session/compaction.ts`, `plugin/index.ts`)
