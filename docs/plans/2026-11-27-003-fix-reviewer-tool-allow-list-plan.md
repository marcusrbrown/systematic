---
title: "fix: Offer review agents only the tools they use on OpenCode"
type: fix
status: active
date: 2026-11-27
---

# fix: Offer review agents only the tools they use on OpenCode

## Overview

On OpenCode, the 18 code-review agents are offered every tool the session has, because the host drops their
`tools: Read, Grep, Glob, Bash` line. Each gets an ordered `permission:` allow list in its frontmatter: deny
everything, then allow the seven tools a reviewer uses. Both OpenCode hosts are expected to leave the rest out of the
model request; U3 checks that. The work is a baseline run, one parser change, one block in 18 files, and proof of the
offered list on both hosts.

## Changed after review: a deny list

The units below were built as written, with an allow list. Code review then found that an allow list overrides the
user's own rules. Both hosts apply the last matching rule, and an agent's rules come after the host's defaults and
the user's top-level rules. After `'*': deny`, each allowed tool needs a whole-tool allow, and that allow wins over a
host-wide `bash: deny` and over the host's default ask on `.env` reads. The operator chose to replace it.

- The block in the 18 files now denies tools by name: `edit`, `task`, `skill`, `systematic_skill`, `websearch`,
  `question`, `todowrite`, `generate_image`, `generate_video` and four session tools. It has no `'*'` key, no allow
  and no `external_directory` line.
- R1 becomes: a dispatched reviewer is not offered the denied tools, and otherwise gets what an agent with no block
  gets. A tool the block does not name stays offered. R3's block is the deny list.
- The v1 change to reads outside the project, the limit on an overlay `'*': deny` and the loss of a top-level
  `external_directory` setting no longer apply.
- The parser change (U1) stays: `systematic_skill` and `question` are tool-name keys. It still accepts `'*'`, and
  the docs say not to ship an allow list in a bundled agent.
- Tests added: a host-config shell deny still removes a reviewer's shell, and a reviewer's `.env` read and outside
  read have the same outcome as an agent with no block.
- U4 reads the withheld tools from a trace instead of an exact list.

## Problem Frame

A reviewer is offered up to 18 tools per model call (OpenCode v2 traces, 2026-11-25 to 2026-11-27). Their definitions
total 38,961 characters, about 9,700 tokens at four characters per token (an estimate). `subagent` is 12,950 and
`systematic_skill` is 9,837. A reviewer is also offered `write`, `edit` or `patch`, media generation and `session_*`
tools.

Reading the calls shows what the dropped tools were used for. Reviewers loaded `ce:review`, `systematic:writing-skills`
and `systematic:agent-native-architecture` a handful of times, though no file under `agents/review/` tells a reviewer
to load a skill and the reviewer template forbids it. `agent-native-reviewer` used `session_search` 7 times in one run.
So no per-reviewer exception is planned.

The kept list is read, grep, glob, shell, web fetch, `systematic_search` and `execute`. `execute` stays because
`api-contract-reviewer` (16 calls) and `agent-native-reviewer` (6) used it to fetch and filter upstream source. That
list is about 7,600 characters, a cut of about 80%. Most reviewer input is cache reads (94 to 96% on the gpt calls
read), so the money saved is much smaller than the token share. The clearer gain is that a reviewer is no longer
offered write or dispatch tools.

## Requirements Trace

- R1. On v1 and v2, a dispatched code-review agent is offered only read, grep, glob, shell, web fetch,
  `systematic_search` and `execute` (written `bash` and `webfetch` in the files; the v2 adapter renames `bash` to
  `shell`). U1, U2, U3.
- R2. It takes effect at agent registration, so unlisted tools are not offered. A call-time guard is not the
  mechanism. U1, U3.
- R3. The list is a `permission:` block in each of the 18 files under `agents/review/`, identical in all. U2.
- R4. The parser accepts the block and both adapters emit it in order. Overlay precedence is unchanged. U1.
- R5. Pi and Claude Code behaviour does not change. The Claude Code build output gains the new field, as
  `connections-researcher`'s already does; Pi's generated personas do not carry it. `agents/document-review/`,
  `connections-researcher` and reviewer prompt text do not change. U2.
- R6. The offered list is asserted on both hosts before and after, with a control agent, then read once from real
  traces after release. U0, U3, U4.

## Scope Boundaries

- Allow list, not a deny list. The list is written by hand in each file, not derived from the `tools:` string and not
  a code-side category list.
- The plan claims what is offered, not enforcement. `connections-researcher`, its guard and its fail-closed
  registration are untouched. The `tools:` string stays in each file for Pi and Claude Code, where it already works.

### Deferred to Separate Tasks

- The seven `agents/document-review/` agents: a later plan, once traces show what they call.
- A recipe in the repo-local `auditing-agent-traces` skill for reading tool-definition sizes.
- Translating the `tools:` string for every agent.

## Context & Research

### Relevant Code and Patterns

- `src/lib/asset-plan.ts`: one shared plan feeds both adapters. An agent with no permission overlay keeps its
  frontmatter `permission` as written. With an overlay, frontmatter entries go in first, grouped by permission name, and
  a later rule for a name already present updates that group in place (`setPermissionRule`). So with a
  `systematic.json` overlay a user can deny one listed tool (`bash: deny`) or add one unlisted tool
  (`systematic_skill: allow`), but an overlay `'*': deny` leaves the block's allows in force. To replace the whole
  list, define an agent of the same name in the host's own config, which Systematic leaves as is.
- `src/lib/config-handler.ts` (`toV1AgentConfig`), `src/lib/opencode-v2.ts` (`writeAgentFields`) and
  `src/lib/opencode-v2-permissions.ts`: v2 appends one ordered rule per triple and renames `bash` to `shell` and
  `task` to `subagent`.
- `src/lib/validation.ts` (`normalizePermission`) keeps eight fixed keys and drops the rest. One bad value drops the
  whole map. `agents/research/connections-researcher.md` already carries a frontmatter `permission:` block.
- Offered-list checks: `tests/integration/opencode-v2.test.ts` and `tests/integration/opencode-v1-isolation.test.ts`,
  with `toolNamesOf` in `tests/helpers/delegated-search-proof.ts`.

### Institutional Learnings

- `docs/solutions/integration-issues/cross-harness-tools-frontmatter-divergence-2026-08-16.md`: a string `tools:` is
  permissive on OpenCode and restrictive on Pi.
- `docs/solutions/integration-issues/opencode-v2-session-allow-overrides-agent-deny-2026-11-09.md`: on v2, session rules
  come after agent rules, so a session-level allow can re-offer a tool.

### Host behaviour (read from host source, not run)

- Both hosts drop a tool from the model request when its last matching permission rule is a whole deny. Both hosts'
  built-in `explore` agent is an ordered `*: deny` then allows. Pins: v1 1.19.6, v2 2.4.1.
- A `tools` boolean map from a plugin hook is ignored by v1.19.6, and v2 never reads it.
- `edit`, `write` and `patch` share the permission name `edit`. On v2, denying `execute` turns Code Mode tools into
  direct tools unless they are denied too; `*: deny` covers them.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "systematic repo: src/lib agent registration (v1 config-handler and v2 adapter), agents/, tests/, docs/solutions",
  "freshness": { "vcs_reference": "6d0d2abac1359019beb8ccad165994faecee5af3" },
  "budget": { "max_search_passes": 6, "max_candidate_inspections": 12, "exhausted": false },
  "candidates": [
    { "path_or_symbol": "src/lib/asset-plan.ts (PlannedAgent, PermissionRuleTriple, applyAgentOverlays)", "description": "Shared ordered-permission plan that both host adapters consume", "disposition": "extend" },
    { "path_or_symbol": "src/lib/config-handler.ts toV1AgentConfig", "description": "v1 emission of permission rule maps to the host's agent config", "disposition": "reuse" },
    { "path_or_symbol": "src/lib/opencode-v2.ts writeAgentFields and src/lib/opencode-v2-permissions.ts translatePermissionRules", "description": "v2 emission of ordered action, resource, effect rules, with bash to shell and task to subagent renames", "disposition": "reuse" },
    { "path_or_symbol": "src/lib/validation.ts normalizePermission", "description": "Frontmatter permission parser, fixed eight keys", "disposition": "extend" },
    { "path_or_symbol": "src/lib/agents.ts extractAgentFrontmatter", "description": "Boolean-map-only tools parsing, where the string form is lost", "disposition": "insufficient", "insufficiency_reason": "Neither host honors a tools map from a plugin; the allow list goes through permission rules instead" },
    { "path_or_symbol": "src/lib/agent-resolver.ts resolveToolAllowlist", "description": "Parses the tools string to a Pi allow list", "disposition": "insufficient", "insufficiency_reason": "Pi-specific name table, throws on unknown names, has no OpenCode or Systematic tool names" },
    { "path_or_symbol": "src/lib/opencode-v2-tool-guard.ts", "description": "v2 call-time refusal for connections-researcher", "disposition": "insufficient", "insufficiency_reason": "Refuses calls only and does not shrink the offered list; keyed on one agent; v2 only" }
  ]
}
```

## Key Technical Decisions

- Ordered permission rules through the shared plan, not the `tools` map. Both adapters already consume the plan, so
  they stay in step.
- The block is in each file's frontmatter, the form `connections-researcher` uses. Eighteen identical blocks cost a
  contract test; each file then shows what its agent is offered. The wildcard key must be quoted, `'*': deny`: an
  unquoted `*` is a YAML alias, `parseFrontmatter` swallows the error and returns empty data, and the agent would get
  no permission block at all.
- `normalizePermission` validates the eight existing keys exactly as today (one bad value among them still drops the
  map). New: `'*'` and any other key are accepted when the value is a bare setting, in file order. Any other value for
  a new key is ignored, as an unknown key is today; pattern maps for new keys stay unsupported. A misspelt setting on
  a tool line leaves that tool denied; one on the `'*'` line would leave the agent unrestricted, so the U2 contract
  test guards the shipped files. This also widens what a user-authored agent file may write, and the docs say so.
  Overlays are unaffected: they use the open-key `permissionSchema` in `src/lib/config-schema.ts`, so the generated
  config schema does not change because of this parser.
- Names are written once in the v1 vocabulary (`bash`) and renamed for v2 by the existing table. A name a host lacks
  is harmless.
- `'*': deny` also matches `external_directory`, so the block carries `external_directory: allow`. U0 found today's
  value is `ask` on v1 and `allow` on v2, both host defaults. The line keeps v2 as it is and removes the prompt on v1.
  A user's top-level `external_directory` setting no longer reaches a reviewer; an overlay on the reviewer does.
- U0 found v1 accepts `'*'` as a top-level key, as a bare setting and as the rule map the managed fold emits. The
  fold does not change.
- U0 found v2 2.4.1 still offers a reviewer the host's own `skill` tool and refuses the call. The host's browser
  plugin appends `skill browser deny` after every agent rule, and 2.4.1 hides a tool only when its last matching rule
  covers every resource. No agent block can change that. v2 2.4.2 hides `skill`. The v2 test allows `skill` in the
  offered list and asserts that a call to it is refused when it is offered.
- U0 found v1 has no `execute` tool, and v1 gives no child `task` or `todowrite`.

## Implementation Units

All units ship in one pull request.

### U0. Take the baseline

**Goal:** Record what a reviewer is offered today and settle the two host questions. No shipped file changes.

**Requirements:** R6.

**Dependencies:** None.

**Files:**
- Create: a reviewer runner, either a new helper under `tests/helpers/` or a parameter on the existing
  `tests/helpers/connect-delegated-proof.ts` and `tests/helpers/delegated-search-proof.ts`; the implementer picks
- Modify: `tests/integration/opencode-v2.test.ts` and `tests/integration/opencode-v1-isolation.test.ts` to call it

**Approach:**
- The existing runners are specific to the researcher (v1 hard-codes it through `connect-delegated-proof.ts`; the v2
  delegated-search runner dispatches `learnings-researcher`). Only `toolNamesOf` is reusable as is. Build a runner that
  packs the shipped agents, has a scripted model dispatch one shipped review agent and finish at once, and returns the
  tool names offered to the parent and to the child.
- Run it on the unchanged tree on both hosts. This is the RED run: record the tools a reviewer is offered today.
- Record a reviewer's effective `external_directory` behaviour today on each host.
- On v1, check that the host accepts a top-level `'*'` key in an agent's permission map, as a bare setting and as the
  rule map the managed fold emits (`foldPermissionRulesToV1Map` in `src/lib/config-handler.ts`).
- Write the three facts into the pull request description. They decide whether the block needs an
  `external_directory` line and whether U1 changes the fold.

**Test scenarios:**
- Test expectation: none beyond the runner itself. The recorded baseline is the output.

### U1. Parser and plan accept an ordered allow list

**Goal:** A frontmatter `permission:` block of `'*'` plus tool names reaches both adapters as ordered rules.

**Requirements:** R2, R4.

**Dependencies:** None.

**Files:**
- Modify: `src/lib/validation.ts` (`PermissionConfig`, `normalizePermission`) and `src/lib/asset-plan.ts`
  (`loadAgentAsConfig`, which assigns the parsed permission to the host agent config); `src/lib/config-handler.ts` only
  if U0 shows v1 rejects the fold's shape
- Test: `tests/unit/validation.test.ts`, `tests/unit/agents.test.ts`, `tests/unit/asset-plan.test.ts`,
  `tests/unit/config-handler.test.ts`, `tests/unit/opencode-v2.test.ts`, `tests/unit/opencode-v2-permissions.test.ts`

**Approach:**
- Validate the eight old keys exactly as today. Accept `'*'` and any other key when the value is a bare setting, in
  file order; ignore a new key with any other value. Widen `PermissionConfig` to allow them.
- Check that the plan and both adapters keep the order, with and without a permission overlay. No code-side tool list.

**Execution note:** Test-first. Write the failing parser and ordering tests before the change.

**Test scenarios:**
- Happy path: `permission:` with `'*': deny`, `read: allow`, `bash: allow` parses to keys in the order `*`, `read`,
  `bash`. A block of only the eight old keys parses as before, and their existing tests pass unchanged.
- Error path: `read: maybe` is ignored and the rest of the block is kept; `bash: maybe` still drops the whole map.
- Error path: frontmatter with an unquoted `*: deny` yields no permission block. This pins why the quote matters.
- Integration: an agent with no overlay reaches v2 as triples that start with `*` deny, then each allow, `bash` as
  `shell`.
- Integration: an overlay `bash: deny` is the last rule for bash in both the v1 fold and the v2 rules.
- Integration: an overlay `systematic_skill: allow` is appended after the block, and the tool is offered.
- Edge case: an overlay `'*': deny` leaves the listed tools allowed. This pins the stated limit.

**Verification:**
- The new tests pass and the existing permission tests in these files pass unchanged.

### U2. Add the block to the 18 reviewers and pin it

**Goal:** Every agent file under `agents/review/` carries the same block, and a test keeps it so.

**Requirements:** R1, R3, R5.

**Dependencies:** U1, and U0 for the `external_directory` decision.

**Files:**
- Modify: the 18 agent files under `agents/review/` (not `README.md`)
- Test: a contract test over the shipped definitions in `tests/unit/`, after
  `tests/unit/ce-review-reviewer-contract.test.ts`
- Regenerate: run `bun run surfaces:affected --run` and commit what it changes. Expected: schema, registry and
  pi-personas from the agent edits, config-reference through U1's edit to `validation.ts`. A surface that regenerates
  with no diff is expected. Then `bun run surfaces:drift` is clean
- Regenerate: `tests/fixtures/config-corpus/*/expected.opencode.json`, the byte-identity fixtures

**Approach:**
- Add one `permission:` block, in this literal form: `'*': deny` first, then `read`, `grep`, `glob`, `bash`,
  `webfetch`, `systematic_search`, `execute` and `external_directory` each `allow`. Leave `tools:` and the prompt
  alone.
- The Claude Code build copies agent frontmatter as written (`scripts/build-claude-code-plugin.ts`), so each built
  reviewer gains the field, as `connections-researcher` already does. Pi reads `tools:` and the body, not `permission:`.
- The contract test parses the real YAML of each shipped file through the real frontmatter parser. It asserts
  `'*': deny` is first, the allows are exactly the decided list, and the 18 blocks are equal. It asserts the
  document-review agents and `connections-researcher` are unchanged.

**Test scenarios:**
- Happy path: each agent file in `agents/review/` parses to the decided ordered block.
- Error path: removing one allow, or putting `*` after an allow, fails the test and names the file.
- Edge case: a document-review agent and `connections-researcher` keep their existing blocks.

**Verification:**
- The contract and config corpus tests pass, the drift check is clean, and no unrelated file changed.

### U3. Prove the offered list on both hosts and update the docs

**Goal:** The GREEN run: a dispatched reviewer's offered tool list is asserted on v1 and v2 against the U0 baseline,
with a control agent that stays unrestricted.

**Requirements:** R1, R2, R6.

**Dependencies:** U0, U1, U2.

**Files:**
- Modify: `tests/integration/opencode-v2.test.ts`, `tests/integration/opencode-v1-isolation.test.ts`, and U0's runner
  (`tests/helpers/`) for the assertions
- Modify: `HARNESSES.md` (the lines saying a string `tools:` is dropped and not relied on), `ARCHITECTURE.md` (near the
  researcher's per-host mechanism table), and a short note in
  `docs/solutions/integration-issues/cross-harness-tools-frontmatter-divergence-2026-08-16.md`

**Approach:**
- Do not assert an exact list: a test host may lack a listed tool (`execute` needs Code Mode, `systematic_search`
  needs search enabled). Per host, assert that every tool offered to the child is on the decided list (in that host's
  names), that the child is offered read, grep, glob and the shell tool, and that it is not offered dispatch,
  `systematic_skill`, `skill` or write/edit/patch, each of which the parent is offered in the same run. The parent's
  offer shows the tools exist, so a typo cannot pass.
- Docs say what is offered, that this is not enforcement on v2 (a session-level allow can still re-offer a tool), that
  user agents may now write `*` and tool-name keys, and what an overlay can do: deny one listed tool or add one
  unlisted tool, but not turn everything off with `'*': deny`.
- Follow the repo's opencode process hygiene rule: record the opencode process IDs before a run, diff after, and reap
  only the new ones. Never a blanket kill.

**Test scenarios:**
- Happy path (v1 and v2): the child's tools are all on the decided list, and it is offered read, grep, glob and the
  shell tool (`bash` on v1, `shell` on v2).
- Edge case: the child is not offered dispatch (`task` or `subagent`), `systematic_skill` or write/edit/patch, each
  of which the parent is offered in the same run. On v1 it is not offered `skill` either. On v2 `skill` may be
  offered, and a call to it is refused.
- Edge case: a control agent with no block is offered the parent's tools on v2, and the parent's minus `task` and
  `todowrite` on v1.
- Error path: with the block removed from the reviewer, the test fails and names the extra tools.
- Integration: a reviewer under a user overlay that sets `bash: deny` is not offered shell on either host.
- Integration: a reviewer reads a file outside the project on both hosts.

**Verification:**
- GREEN on both host majors at their pins against U0's RED, the docs say offering only, and no opencode process is
  left.

### U4. Read the result from real traces after release

**Goal:** Confirm a real session shows what the tests show, and no reviewer lost a tool it needs.

**Requirements:** R6.

**Dependencies:** The release containing U1 to U3 has reached the version pinned by the traced deployment.

**Files:** None; the result goes in a pull request comment.

**Approach:**
- Read one reviewer model call: its offered list is the decided list and its definitions total is near 7,600
  characters.
- Rerun the reviewer tool-call counts for a window after release and confirm no reviewer shows a new class of failed
  call. Manual, not CI; use the `auditing-agent-traces` skill.

**Test scenarios:**
- Test expectation: none. This is a trace read. If it fails, add the missing line to all 18 blocks and to the contract
  test's decided list.

**Verification:** the offered list, the size and the failed-call comparison are reported with trace identifiers.

## Stop rule

If U3's GREEN run shows that either host offers a reviewer a tool off the decided list, other than `skill` on v2,
stop and return to the operator. Do not open the pull request.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A host offers a reviewer a denied tool | U0 ran the mechanism on both hosts. v2 2.4.1 offers `skill` and refuses the call; 2.4.2 hides it. If U3's GREEN run shows any other tool off the decided list, stop and return to the operator; do not open the pull request |
| A reviewer needs a dropped tool | U4 reads failed calls. Add the line to all 18 blocks and to the contract test's decided list, since the blocks are identical. One user can add it for themselves with an overlay |
| A user overlay or same-name host key changes the list | With a `systematic.json` overlay a user can deny one listed tool or add one unlisted tool, but not turn everything off with `'*': deny`. A same-name agent in the host's own config is kept as is and gets no block |
| A misspelt setting on the `'*'` line leaves a reviewer unrestricted | The U2 contract test parses every shipped block |
| `'*': deny` changes `external_directory` for reviewers | The block carries `external_directory: allow`, and U3 pins an outside read on both hosts |
| Declined — covered by a same-name host config entry replacing the whole agent: making an overlay wildcard override the block's allows | The ordering is unchanged |
| Declined — covered by the plan's claim, which is what is offered and not enforcement: a v2 session-level allow re-offering a tool | No enforcement is claimed |
| Declined — covered by the reviewer template's read-only rule and CI: a reviewer still changing files through `shell` | Out of scope and unchanged by this plan |
| Declined — covered by existing precedent (`connections-researcher` ships the same field into the Claude Code build): stripping the field from the Claude Code output | The build copies frontmatter as written |
| Release | PR title type `fix`, which publishes a patch |
## Sources & References

- Related code: `src/lib/asset-plan.ts`, `src/lib/validation.ts`, `src/lib/opencode-v2-permissions.ts`,
  `agents/research/connections-researcher.md`
- Related past work: `docs/plans/2026-11-27-002-feat-trace-audit-skill-plan.md`, recorded completed. It supplies the
  skill U4 uses.
- No origin document. There is no brainstorm for this plan.
