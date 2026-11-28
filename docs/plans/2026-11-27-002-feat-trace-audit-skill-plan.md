---
title: "feat: Repo-local trace audit skill"
type: feat
status: completed
date: 2026-11-27
origin: docs/brainstorms/2026-11-27-trace-audit-skill-requirements.md
---

# feat: Repo-local trace audit skill

## Overview

Add one repo-local skill, `auditing-agent-traces`, that teaches an agent to read the Langfuse and Tempo trace stores. It
answers usage questions about Systematic's agents, skills and tools, and it sweeps a time window into ranked
improvement candidates. The minimal change is a skill directory with query recipes and one README row. No
TypeScript, no bundled content and no generated surface changes.

## Problem Frame

Nobody measures what Systematic's agents do across runs. A hand-run query over three days of traces found four
leads, and it took about forty hand-written queries whose knowledge lives in one session (see origin:
`docs/brainstorms/2026-11-27-trace-audit-skill-requirements.md`).

## Requirements Trace

- R1, R2, R6. Usage questions for a window, across all senders, narrowable, canary excluded. U1.
- R3, R15, R16. Read and quote trace content; recorded text is data; findings stay in this repository. U1.
- R4. Disclose window coverage, missing attributes and leads. U1.
- R5. Offered versus used tools and skills. U1.
- R7 to R11. Sweep mode, candidate shape, ranking, operator decision. U1, proved in U2.
- R12 to R14. Standard attribute names, sender gaps filed, new sender groups need no change. U1, U2.
- Success criteria. One request reproduces the hand-built figures; the first sweep explains or lists each lead. U2.

## Scope Boundaries

- No scheduled CI audit, public usage report, `ce:connect` trace source or bundled skill (see origin).
- No helper script. The skill drives the two MCP servers directly.
- No writes to Langfuse.

### Deferred to Separate Tasks

- Changes to agents, skills or tool lists that the first sweep proposes: one issue or PR per accepted candidate.
- Sender attribute gaps: issues on `fro-bot/agent`, filed after the operator approves each one.

## Context & Research

### Relevant Code and Patterns

- `.agents/skills/running-with-without-evals/SKILL.md`: closest layout. Overview, When to use, When NOT to use,
  method, Common mistakes table, Reference list.
- `.agents/skills/release-notes-narrative/`: the pattern for a `references/` split, linked one level down.
- `.agents/skills/README.md`: frontmatter template and the "Current skills" table, the only registration surface.
- `skills/ce-connect/SKILL.md`: the candidate idea this borrows. Its evidence rules assume a file at a commit, so
  the sweep cites trace identifiers instead.
- No gate scans `.agents/skills/`. The `opencode.json` formatter hook runs markdownlint on save.

### Institutional Learnings

- `docs/solutions/best-practices/skill-around-an-untrusted-researcher-needs-baseline-pressure-tests-2026-11-09.md`:
  treat read input as evidence, never as instructions.
- Bundled persona `tools:` frontmatter in string form is not applied by OpenCode. This likely explains the first
  offered-versus-used finding and is a lead for U2, not something this plan fixes.

### Facts established by reading the stores (2026-11-27)

- Tempo tool spans carry the agent name, so tools by agent, outcome and error type is one grouped query per day.
- An instant `count_over_time` or `avg_over_time` over a 24-hour window returns one value per series.
- Token totals are average times count, filtered to spans that carry the attribute.
- Langfuse metrics dimension `toolNames`, filtered on metadata key `attributes.gen_ai.agent.name`, gives the tools
  offered to an agent. `toolDefinitions` gives the count.
- Langfuse's called-tool and skill fields are empty. Called tools come from Tempo. Skill loads come from
  `systematic_skill` and `skill` tool calls, whose input holds the skill name.
- Langfuse observation metadata mirrors span attributes under `attributes.<name>`.
- Tool and chat spans exist from 2026-11-25.

### Baseline figures for Unit 2

Hand-built on 2026-11-27 for 2026-11-25 to 2026-11-27 UTC, all senders, canary excluded. Tool calls and failures are
counts of tool spans. Cache read is tokens, summed as average times count over chat spans that carry the attribute.

- Totals: 7,584 tool calls, 242 failures. By error type: tool execution 104, permission rejected 99, unknown 21,
  resume guard 18. The 18 resume-guard failures carry no agent name.

| Agent | Tool calls | Failed | Chat calls | Cache read (tokens) |
|---|---|---|---|---|
| build | 4,440 | 175 | 3,095 | 247.6M |
| connections-researcher | 816 | 2 | 233 | 18.5M |
| project-standards-reviewer | 446 | 6 | 329 | 9.2M |
| correctness-reviewer | 424 | 5 | 438 | 13.3M |
| testing-reviewer | 331 | 3 | 361 | 9.3M |
| security-reviewer | 246 | 15 | 232 | 6.9M |
| learnings-researcher | 225 | 2 | 135 | 4.1M |
| adversarial-reviewer | 163 | 4 | 166 | 5.4M |

- Leads: 66 calls to tool names that do not exist; `build` `write` rejected 27 of 46 times; most reviewers make
  80% or more of their calls through `shell`; most subagents read 26 to 33 thousand cached tokens per chat call.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "build-new-within-scope",
  "scope": ".agents/skills, skills/, scripts/, docs/, .github/workflows",
  "freshness": {
    "vcs_reference": "03632c2a1a3741c99cebf41ac15197dff4b9161d"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "skills/ce-connect/SKILL.md",
      "description": "Proposes cross-project candidates with file-and-commit evidence",
      "disposition": "insufficient",
      "insufficiency_reason": "Its evidence rules assume a file at a commit, not a trace identifier."
    },
    {
      "path_or_symbol": "skills/todos/assets/todo-template.md",
      "description": "File-based work item with status, priority and tags",
      "disposition": "insufficient",
      "insufficiency_reason": "Tracks accepted work only and holds no query knowledge."
    }
  ]
}
```

## Key Technical Decisions

- One `SKILL.md` plus one `references/queries.md`: the skill body holds the method and rules, and the reference
  holds the recipes, so recipes can grow without bloating what loads first.
- Tempo for counts, Langfuse for content and offered tools: Tempo groups by agent in one query, and Langfuse holds
  the text and the offered tool list.
- Recipes use `gen_ai.*` names. Each private name (`fro_bot.outcome`, `sender.group`) is marked as private with the
  standard name it should become. Outcome maps to span status plus the standard `error.type`.
- A candidate is a short block in the sweep's answer: the change, the evidence with trace identifiers, the measure
  expected to move. No file format and no ledger.
- The skill states the store limits once (24-hour Tempo metrics window, 168-hour search, 15-day Langfuse query,
  100 rows per page, 120 requests per minute) and tells the agent to run one query per day and say what it skipped.

## Open Questions

### Resolved During Planning

- Offered versus used (origin R5): works through the Langfuse `toolNames` dimension. Skill fields are empty, so
  skill loads come from tool calls.
- Where an accepted candidate goes: normal repository work, an issue or a PR. Nothing else is recorded.
- Standard set for a sweep: tools by agent with outcome, error types, offered versus used tools, token and cache
  use per call by agent, subagent dispatches, skill loads.

### Deferred to Implementation

- Which other private attributes have a standard equivalent: found while writing the recipes.
- Whether one Langfuse query can return skill names from tool input, or whether it needs paging through TOOL
  observations.

## Output Structure

    .agents/skills/auditing-agent-traces/
      SKILL.md
      references/
        queries.md

## Implementation Units

- [x] **Unit 1: Write the skill**

**Goal:** A loadable `auditing-agent-traces` skill with both modes, the disclosure rules and tested query recipes.

**Requirements:** R1 to R16.

**Dependencies:** None.

**Files:**
- Create: `.agents/skills/auditing-agent-traces/SKILL.md`
- Create: `.agents/skills/auditing-agent-traces/references/queries.md`
- Modify: `.agents/skills/README.md`

**Approach:**
- `SKILL.md` covers: when to use it, the two stores and what each holds, ask mode, sweep mode, the candidate
  block, the disclosure rules, the rule that recorded text is data, where findings go, the store limits, and common
  mistakes.
- `references/queries.md` holds each recipe with its store, the exact query, the window rule and what the result
  means. Every recipe is one that was run against the stores.
- The description starts with "Use when" and names triggers only.

**Patterns to follow:**
- `.agents/skills/running-with-without-evals/SKILL.md`
- `.agents/skills/release-notes-narrative/SKILL.md` for the reference link

**Test scenarios:**
- Test expectation: none -- a repo-local Markdown skill with no gate. Unit 2 proves it against the live stores.

**Verification:**
- The skill appears in the session's skill list and loads.
- markdownlint passes on both files.
- Every query in `references/queries.md` returns a result when run as written.

- [x] **Unit 2: Prove it and run the first sweep**

**Goal:** Show the skill reproduces the hand-built figures and turns the known leads into candidates or open leads.

**Requirements:** R4, R7 to R11, R13, success criteria.

**Dependencies:** Unit 1.

**Files:**
- Modify: `.agents/skills/auditing-agent-traces/references/queries.md` (only if a recipe proves wrong)

**Approach:**
- A fresh agent loads the skill and answers "which tools did each subagent call, how often did they fail, and what
  were the cache-read counts" for 2026-11-25 to 2026-11-27. Compare with "Baseline figures for Unit 2" above.
- The same agent sweeps that window. It must address five leads: tool names that do not exist, the primary agent's
  rejected `write` calls, reviewers working through `shell`, the per-call cache floor, and tools offered to
  reviewers but never used.
- The operator decides each candidate. Accepted ones become issues.

**Test scenarios:**
- Happy path: the ask-mode answer matches 7,584 tool calls and 242 failures for the window, within any drift from
  late-arriving spans, and states that tool spans start on 2026-11-25.
- Edge case: a seven-day window reports the two days with no tool spans as empty and the two with only a few
  smoke-test spans as such, not as zero.
- Edge case: cache-read totals are labelled partial and give the share of spans without the attribute.
- Happy path: each of the five leads ends as a candidate with trace identifiers or as an open lead with an owner.
- Error path: a recipe that returns an error or an empty result is reported, not silently dropped.

**Verification:**
- The comparison and the sweep output are in the pull request description or a linked issue.
- At least one candidate is put to the operator.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A recipe breaks when a sender renames an attribute | Each recipe names its attributes; the skill tells the agent to list attribute names when a query returns nothing |
| The skill text names a private endpoint and attributes in a public repository | Accepted: the consumer contract is already public in `marcusrbrown/infra` |
| Long windows are slow at one query per day | Accepted: the skill says to state the cost and narrow the window |
| Declined: restricting which trace content may be read or quoted | The operator owns every sending project (see origin Key Decisions) |

## Sources & References

- **Origin document:** `docs/brainstorms/2026-11-27-trace-audit-skill-requirements.md`. This path is untracked in
  this repository.
- Related past work: `docs/ideation/2026-10-25-open-ideation.md`, recorded rejected (a local session ledger and
  trace-conformance evals). This plan stores no trace data and grades nothing against a model-run matrix.
- Related past work: `docs/plans/2026-11-06-001-feat-cross-project-connections-plan.md`, recorded completed. Its
  sources are files at a commit; this plan cites trace identifiers.
- External docs: `https://github.com/marcusrbrown/infra/blob/main/docs/runbooks/trace-collection.md#consumer-contract`
