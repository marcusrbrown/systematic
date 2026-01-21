---
name: sys-deepen
description: Enhance a plan with parallel research for each section
---

Take an existing plan and enhance each section with deep research to add best practices, performance optimizations, and implementation details.

## Purpose

Transform a basic plan into a production-ready specification with:
- Best practices and industry patterns
- Performance optimizations
- Edge cases and error handling
- Real-world implementation examples
- Documentation references

## Usage

```
/sys-deepen [path to plan file]
```

If no path provided, list plans in `docs/plans/` and ask which to deepen.

## Execution

### 1. Parse Plan Structure

Read the plan and identify major sections:
- Overview/Problem Statement
- Technical Approach/Architecture
- Implementation phases
- Code examples
- Acceptance criteria

### 2. Research Each Section

For each identified section, research:
- Industry standards and conventions
- Performance considerations
- Common pitfalls and how to avoid them
- Documentation and tutorials

### 3. Check Existing Solutions

Search `docs/solutions/` for relevant documented learnings from previous work.

### 4. Enhance Sections

Add research insights to each section:

```markdown
## [Original Section Title]

[Original content preserved]

### Research Insights

**Best Practices:**
- [Concrete recommendation 1]
- [Concrete recommendation 2]

**Performance Considerations:**
- [Optimization opportunity]
- [Benchmark or metric to target]

**Implementation Details:**
```[language]
// Concrete code example
```

**Edge Cases:**
- [Edge case 1 and how to handle]

**References:**
- [Documentation URL]
```

### 5. Add Enhancement Summary

At the top of the plan:

```markdown
## Enhancement Summary

**Deepened on:** [Date]
**Sections enhanced:** [Count]

### Key Improvements
1. [Major improvement 1]
2. [Major improvement 2]
```

## Output

Updates the plan file in place, or creates `[original-name]-deepened.md` if requested.

## Post-Enhancement Options

1. View diff - Show what was added
2. Run /sys-review - Get feedback on enhanced plan
3. Start /sys-work - Begin implementing
4. Deepen further - More research on specific sections
