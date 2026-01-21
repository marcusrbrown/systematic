---
name: sys-compound
description: Document a recently solved problem to compound your team's knowledge
---

Coordinate documentation of a recently solved problem using the systematic:compound-docs skill.

## Purpose

Captures problem solutions while context is fresh, creating structured documentation in `docs/solutions/` for searchability and future reference.

**Why "compound"?** Each documented solution compounds your team's knowledge. The first time you solve a problem takes research. Document it, and next occurrence takes minutes.

## Usage

```
/sys-compound                    # Document the most recent fix
/sys-compound [brief context]    # Provide additional context hint
```

## Execution

1. Use systematic:compound-docs skill
2. Extract from conversation history:
   - Problem symptom (exact error messages)
   - Investigation steps tried
   - Root cause analysis
   - Working solution with code examples
   - Prevention strategies
3. Create documentation in `docs/solutions/[category]/`
4. Add cross-references to related docs

## What It Creates

**File:** `docs/solutions/[category]/[filename].md`

**Categories:**
- build-errors/
- test-failures/
- runtime-errors/
- performance-issues/
- database-issues/
- security-issues/
- ui-bugs/
- integration-issues/
- logic-errors/

## The Compounding Philosophy

```
Solve problem → Document solution → Future occurrence is fast lookup
     ↑                                           ↓
     └───────────── Knowledge compounds ─────────┘
```

**Each unit of engineering work should make subsequent units of work easier—not harder.**
