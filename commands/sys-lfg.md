---
name: sys-lfg
description: Full autonomous engineering workflow - plan, deepen, work, review
---

Execute a complete engineering workflow from feature description to implementation.

## Purpose

Run the full systematic workflow autonomously:
1. Plan the feature
2. Deepen the plan with research
3. Execute the work
4. Review the implementation

## Usage

```
/sys-lfg [feature description]
```

## Workflow Steps

Execute these commands in sequence:

### Step 1: Plan
```
/sys-plan [feature description]
```
Create the initial implementation plan using brainstorming skill.

### Step 2: Deepen
```
/sys-deepen [plan path]
```
Enhance the plan with research, best practices, and edge cases.

### Step 3: Work
```
/sys-work [plan path]
```
Execute the plan using the executing-plans skill.

### Step 4: Review
```
/sys-review
```
Verify all work is complete with evidence.

## Execution Notes

- Each step builds on the previous
- Stop and ask if blockers encountered
- Create commits at logical checkpoints
- Run tests after implementation

## When to Use

- Starting a new feature from scratch
- Need full autonomous execution
- Want structured plan → implement → verify cycle

## When NOT to Use

- Quick fixes (just fix directly)
- Exploring options (use /sys-plan alone)
- Already have a plan (use /sys-work)
