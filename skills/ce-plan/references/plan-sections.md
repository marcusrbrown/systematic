# Plan Sections

This reference describes what makes a great implementation plan. It does NOT
prescribe how the plan looks on the page — rendering is handled by
`references/markdown-rendering.md`.

## The outcome

A great plan enables three audiences to act:

- **The implementing agent** (`ce:work` or a human) starts from an informed
  baseline — load-bearing decisions are named, research breadcrumbs orient
  their own investigation, unit boundaries are clear. The plan gives the
  implementer a starting point, not a substitute for their own investigation.
- **The reviewer** identifies the load-bearing decisions and the boundaries
  of what's being changed in one pass.
- **The future reader** (anyone returning months later) traces why the work
  was done, what shaped it, and where the artifacts live.

Sections earn their place by serving one of these audiences. Omit padding.

## Section ordering

Render the `Prior-Art Survey` as a top-level section after `Context & Research` and before `Key Technical Decisions`. Keep it addressable and separate from general research so downstream review and execution checks can locate the result without interpreting surrounding prose. For qualifying software-work or behavior-changing plans, the section is part of the hard floor; omit it only when planning explicitly records the non-software or mechanical-no-behavior-change exemption.

## Prior-Art Survey rendering

The section must contain exactly one fenced `json` block and no alternate survey result in prose or another code block. Parse that block as JSON and validate it against `skills/ce-plan/references/prior-art-survey-schema.json`; a missing, malformed, schema-invalid, or placeholder block is not a survey result. Preserve the contract's field names, including `schema_version`, `verdict`, `scope`, `freshness`, `budget`, and `candidates`. Each candidate must name what it owns in the code's vocabulary and its disposition. Include `scopes_considered` for an `unscoped` verdict and `acceptance` only when the user accepts an `unscoped` or `unresolved` verdict. An `unscoped` or `unresolved` result without that acceptance record remains a planning blocker, not explanatory prose.

## Decide whether a plan doc is warranted at all

Not every invocation of `ce:plan` should produce a plan document. For
genuinely atomic work, the doc is ceremony — the implementer (whether
`ce:work` or a human) can act directly without IDed units, KTDs, or
Requirements as a checklist.

**Bias toward producing a plan.** The risk asymmetry favors writing one:
a thin plan doc for small work is mild ceremony, but skipping a plan when
one was warranted costs the implementer real time (reinvented decisions,
lost unit boundaries, no IDed requirements to verify against). When unsure,
write the plan.

**Skip plan creation only when ALL of these hold:**

- The work is **atomic** — fits in one commit, no meaningful unit boundaries
  to break out independently.
- There are **no design choices that constrain implementation** — no
  Key Technical Decisions worth recording. If the work needs the implementer
  to make a choice between two approaches, those approaches are KTDs and
  a plan is warranted.
- There are **no scope boundaries worth pinning** in writing — the work
  scope is self-evident from the user's request.
- **No upstream artifact** (a brainstorm with R-IDs, an incident report,
  a deferred-follow-up item from a prior plan) needs traceability through
  this plan.

**Stress test the "looks atomic" case.** Many requests look atomic at first
glance but hide design decisions:

- *"Add caching to this endpoint"* — sounds atomic, but TTL, invalidation,
  cache key shape, and backend selection are all KTDs. Write the plan.
- *"Migrate from package A to package B"* — sounds mechanical, but
  semantic differences between the packages create migration KTDs. Write
  the plan.
- *"Add rate limiting"* — sounds small, but algorithm, scope, and
  configurability are all KTDs. Write the plan.

vs. genuine skip cases:

- *"Fix typo in README line 47"* — atomic, no KTDs, skip the plan.
- *"Rename `oldFn` to `newFn` across the repo"* — mechanical, no design
  choices, skip the plan.
- *"Bump dependency X to v2.3.1"* — mechanical, skip the plan (unless the
  bump introduces breaking changes that warrant unit-by-unit migration).

When skipping the plan doc, the work proceeds directly to `ce:work` or to
implementation, and any decisions made along the way land in the commit
message or `docs/solutions/` if they're worth carrying forward.

> **Section inventory and meaning are owned by the Core Plan Template in `ce-plan/SKILL.md`; this file covers only how sections render and order.**

## Plan metadata fields

Every plan carries a small set of stable metadata fields that downstream
tooling depends on. In markdown these fields appear as YAML frontmatter at
the top of the file. Field names and semantics are stable across plan
revisions — never rename or repurpose a field.

### Required

- **`title`** — verbatim plan title. Matches the H1 heading so file metadata
  and visible heading don't drift.
- **`type`** — conventional-commit-prefix-aligned classification (`feat`,
  `fix`, `refactor`, `chore`, `docs`, `perf`, `test`, etc.). Carries the
  intent the eventual commit message should reflect.
- **`status`** — `active` on creation; `ce:work` flips to `completed` on
  ship. `ce:plan`'s Phase 0.1 resume fast path keys on `active`.
- **`date`** — creation date in ISO 8601 (`YYYY-MM-DD`), ASCII digits only.

### Optional but well-known

These fields are not required, but when set they have fixed names and
semantics so downstream tooling can rely on them:

- **`origin`** — repo-relative path to an upstream brainstorm requirements
  doc (e.g., `docs/brainstorms/2026-05-12-pagination-requirements.md`).
  Set when planning from an upstream brainstorm; carried for traceability
  and re-resolved when `ce:plan` re-deepens.
- **`deepened`** — ISO 8601 date marking the first time the confidence
  check substantively strengthened the plan. Presence affects Phase 0.1
  resume fast-path logic (see `references/deepening-workflow.md`).

Field names are stable across plan revisions — never rename a field or
repurpose its semantics. Agents composing new plans MUST use these exact
names; adding new fields is fine, but renaming `status` to `state` or
`origin` to `source` breaks the downstream consumers above.

## Rendering

The format-specific reference describes how to render plan sections:

- **Markdown rendering:** `references/markdown-rendering.md`

This reference (`plan-sections.md`) covers metadata format and rendering conventions;
section inventory and content rules live in the Core Plan Template in `ce-plan/SKILL.md`.
