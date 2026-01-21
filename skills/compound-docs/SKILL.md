---
name: compound-docs
description: Capture solved problems as categorized documentation for fast lookup - use after confirming a fix works
---

# Compound Docs Skill

**Purpose:** Document solved problems immediately after confirmation, creating structured documentation for future reference.

**Philosophy:** Each documented solution compounds your team's knowledge. First time solving a problem takes research. Document it, and next occurrence takes minutes.

## When to Use

**Auto-invoke after phrases:**
- "that worked"
- "it's fixed"
- "working now"
- "problem solved"

**Or manual invocation** after solving non-trivial problems.

## 7-Step Process

### Step 1: Detect Confirmation

Document when problem was:
- Non-trivial (multiple investigation attempts needed)
- Tricky debugging that took time
- Non-obvious solution
- Future sessions would benefit

**Skip for:** Simple typos, obvious syntax errors, trivial fixes.

### Step 2: Gather Context

Extract from conversation history:

**Required:**
- **Symptom**: Observable error/behavior (exact error messages)
- **Investigation attempts**: What didn't work and why
- **Root cause**: Technical explanation of actual problem
- **Solution**: What fixed it (code/config changes)
- **Prevention**: How to avoid in future

**If critical context missing:** Ask and wait for response.

### Step 3: Check Existing Docs

Search `docs/solutions/` for similar issues:

```bash
grep -r "exact error phrase" docs/solutions/
ls docs/solutions/[category]/
```

If similar found, present options:
1. Create new doc with cross-reference
2. Update existing doc (if same root cause)

### Step 4: Generate Filename

Format: `[sanitized-symptom]-[YYYYMMDD].md`

Examples:
- `missing-include-brief-system-20260120.md`
- `n-plus-one-query-fix-20260120.md`

### Step 5: Determine Category

Categories:
- `build-errors/`
- `test-failures/`
- `runtime-errors/`
- `performance-issues/`
- `database-issues/`
- `security-issues/`
- `ui-bugs/`
- `integration-issues/`
- `logic-errors/`

### Step 6: Create Documentation

Create file at `docs/solutions/[category]/[filename].md`:

```markdown
---
date: YYYY-MM-DD
category: [category]
symptoms:
  - "exact error message or symptom"
tags: [relevant, keywords]
---

# [Problem Title]

## Symptom

[What was observed - exact error messages, behavior]

## Investigation

[What was tried and why it didn't work]

## Root Cause

[Technical explanation of the actual problem]

## Solution

[Step-by-step fix with code examples]

```[language]
// Before (broken)
...

// After (fixed)
...
```

## Prevention

[How to avoid this in future]

## Related

- [Links to related docs or issues]
```

### Step 7: Cross-Reference

If similar issues found:
- Add link to existing doc
- Consider creating pattern doc if 3+ similar issues

## Success Criteria

- File created in `docs/solutions/[category]/`
- Exact error messages included
- Code examples in solution section
- Cross-references added if related issues found

## Quality Guidelines

**Good documentation has:**
- Exact error messages (copy-paste from output)
- Specific file:line references
- Observable symptoms (what you saw, not interpretations)
- Failed attempts documented
- Technical explanation (not just "what" but "why")
- Code examples (before/after)
- Prevention guidance

**Avoid:**
- Vague descriptions ("something was wrong")
- Missing technical details
- No context (which version? which file?)
- Just code dumps without explanation
