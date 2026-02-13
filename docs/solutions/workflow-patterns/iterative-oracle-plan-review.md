---
title: Iterative Oracle Plan Review Loop
date: 2026-02-12
category: workflow-patterns
tags: [oracle, subagent, plan-review, iterative-feedback, quality-gate, session-continuity]
component: workflow-system
severity: low
resolution_time: ~30 minutes per review cycle
---

# Iterative Oracle Plan Review Loop

## Problem

Implementation plans executed literally by agents need quality-gating before execution. Without structured review, plans ship with issues like dead code, bad edge-case fallbacks, fragile dependencies on library internals, ambiguous wording, brittle line-number anchors, and missing verification steps — all of which cascade into broken implementations.

## Solution

Submit the plan to an Oracle subagent with a structured 6-dimension review framework. Address feedback, resubmit using session continuity, and repeat until the Oracle certifies GREEN.

### The Loop

```
Write plan → Oracle review → YELLOW? → Fix issues → Re-review (session_id) → GREEN? → Execute
                              RED?   → Fix issues ↗                          No  → Loop ↗
```

### Step 1: Write the plan

Use the `writing-plans` skill to create a plan at `docs/plans/YYYY-MM-DD-<name>.md`. Include:
- Exact file paths and function names for each modification
- Complete code blocks (not "add validation" — show the code)
- Verification steps with expected output
- Commit messages per task

### Step 2: Send to Oracle with structured review prompt

```typescript
task(
  subagent_type="oracle",
  run_in_background=false,
  load_skills=[],
  description="Review implementation plan",
  prompt=`
    Review the implementation plan at docs/plans/YYYY-MM-DD-<name>.md.

    ## Context
    [Project summary, what the plan modifies, key architectural decisions]

    ## Source files to read for verification
    1. [file path] — [what to check]
    2. [file path] — [what to check]

    ## Review dimensions (rate each RED/YELLOW/GREEN)
    1. Correctness — code changes produce intended output, references accurate
    2. Completeness — no missing steps, edge cases handled
    3. Consistency — matches existing code style and conventions
    4. Risk — could changes break existing functionality
    5. YAGNI — no unnecessary features or premature abstractions
    6. Testability — verification steps sufficient, implementer can confirm success

    ## Expected output
    - Rating per dimension with specific issues and locations
    - Overall verdict: RED (blocking), YELLOW (fix first), GREEN (execute)
    - This plan will be executed literally by an agent — ambiguity cascades
  `
)
```

### Step 3: Address feedback

If YELLOW or RED:
1. Create a todo item per issue raised
2. Fix each issue directly in the plan document
3. Mark todos complete as fixes are applied

### Step 4: Re-submit using session_id

```typescript
task(
  session_id="<session_id from Step 2 response>",
  subagent_type="oracle",
  load_skills=[],
  description="Re-review plan after fixes",
  prompt=`
    Re-reviewing the updated plan after addressing your feedback.

    Previous issues and fixes:
    1. [Issue] — FIXED: [what changed]
    2. [Issue] — FIXED: [what changed]

    Re-evaluate against the same 6 dimensions.
    Certify GREEN if ready to implement.
  `
)
```

Session continuity preserves the Oracle's full context — it knows what it reviewed, what issues it raised, and can verify fixes without re-reading everything. Saves ~70% tokens on re-reviews.

### Step 5: Repeat until GREEN

Continue Steps 3–4 until all dimensions are GREEN. In practice this takes 1–2 iterations.

## 6-Dimension Review Framework

| Dimension | What Oracle checks | Common YELLOW triggers |
|---|---|---|
| **Correctness** | Code compiles, APIs exist, references accurate | Wrong function signatures, stale line numbers |
| **Completeness** | All steps present, edge cases handled | Missing fallbacks, no error handling |
| **Consistency** | Matches project style, naming, patterns | Mixed conventions, wrong import style |
| **Risk** | No breaking changes, no fragile dependencies | Using library internals, OS-specific paths |
| **YAGNI** | Minimal scope, no speculative features | Dead code, unused parameters |
| **Testability** | Verification steps exist and are sufficient | No visual check for UI changes, vague "expected" |

## Example: Reference Section Refresh (YELLOW → GREEN)

### Initial review: YELLOW

Oracle identified 5 issues:
1. **Completeness/YELLOW** — Skill files named `SKILL.md` fall back to basename `"SKILL"` instead of directory name
2. **Correctness/YELLOW** — `path.relative()` uses OS separators; GitHub URLs would break on Windows
3. **Risk/YELLOW** — Plan uses Starlight's internal `sl-badge` CSS class which could change
4. **Correctness/YELLOW** — Goal says "type badge in header" but implementation puts it in sidebar only
5. **Risk/YELLOW** — Line-number anchors drift after intermediate commits

Plus a missing visual verification step.

### Fixes applied

Each issue was fixed in the plan document:
1. Added type-aware fallback: `definitionType === 'skill' ? path.basename(path.dirname(file)) : path.basename(file, '.md')`
2. Added POSIX normalization: `.split(path.sep).join('/')`
3. Removed `sl-badge` dependency, self-styled `.definition-category` with own CSS
4. Updated goal wording to "sidebar type badges"
5. Replaced all line-number references with function/string anchors
6. Added `bun run docs:dev` + browser checklist to Task 5

### Re-review: GREEN

Oracle re-evaluated with session continuity and certified GREEN across all 6 dimensions.

## When to Use

- Multi-step implementation plans (3+ tasks)
- Plans that modify multiple files or introduce new patterns
- Changes with UI/UX impact that need visual verification
- Architectural decisions with tradeoff implications

## When to Skip

- Single-file changes with obvious correctness
- Trivial fixes (typos, formatting, dependency bumps)
- Plans under 3 steps with no external dependencies

## Prevention: Pre-Review Checklist

Before submitting to Oracle, self-check:

- [ ] All file references use function/string anchors, not line numbers
- [ ] Edge cases have explicit fallback logic (test with sample data)
- [ ] No dependencies on library internals — use public APIs or self-style
- [ ] Wording is precise (no "type badge in header" when it's sidebar)
- [ ] UI changes have a visual verification step
- [ ] Code blocks are complete and compilable, not pseudocode

## Anti-Patterns

| Don't | Do |
|---|---|
| Submit without self-review | Run the pre-review checklist first |
| Include speculative features in plans | Stick to immediate scope (YAGNI) |
| Iterate more than 3 rounds | If still RED after 3, rethink the approach |
| Use vague prompts ("review this plan") | Specify dimensions, source files, and context |
| Start fresh sessions for re-review | Use `session_id` for continuity |
| Defend flawed plans | Treat feedback as data, fix and resubmit |

## Related

- `commands/workflows/plan.md` — Plan creation workflow
- `commands/workflows/review.md` — Multi-agent code review (post-implementation)
- `skills/document-review/` — Lighter-weight document refinement (no Oracle)
- `agents/review/` — 12 specialized review agents for different domains
- `docs/plans/2026-02-12-reference-section-refresh.md` — The plan that was reviewed in this example
