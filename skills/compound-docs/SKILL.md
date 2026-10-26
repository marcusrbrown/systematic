---
name: compound-docs
description: Capture solved problems as categorized documentation with YAML frontmatter for fast lookup
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
---

# compound-docs Skill

**Purpose:** Automatically document solved problems to build searchable institutional knowledge with category-based organization (enum-validated problem types).

## Overview

This skill captures problem solutions immediately after confirmation, creating structured documentation that serves as a searchable knowledge base for future sessions.

**Organization:** Single-file architecture - each learning documented as one markdown file in the category directory its `problem_type` maps to (e.g., `docs/solutions/performance-issues/n-plus-one-report-queries.md`). Files use YAML frontmatter for metadata and searchability.

**Two tracks:** The `problem_type` decides the track. The **bug track** documents a defect that was diagnosed and fixed, and requires `symptoms`, `root_cause` and `resolution_type`. The **knowledge track** documents a practice, pattern, convention or workflow decision, and needs none of those. The track lists live in [references/schema.yaml](./references/schema.yaml).

**Prerequisites:** The problem has been solved and the solution has been verified working, or the guidance has been confirmed. Do not document in-progress investigations as finalized solutions.

---

<critical_sequence name="documentation-capture" enforce_order="strict">

## 7-Step Process

<step number="1" required="true">
### Step 1: Detect Confirmation

**Auto-invoke after phrases:**

- "that worked"
- "it's fixed"
- "working now"
- "problem solved"
- "that did it"

**OR manual:** Invoke the `systematic:ce-compound` skill directly

**Non-trivial problems only:**

- Multiple investigation attempts needed
- Tricky debugging that took time
- Non-obvious solution
- Future sessions would benefit

**Skip documentation for:**

- Simple typos
- Obvious syntax errors
- Trivial fixes immediately corrected
</step>

<step number="2" required="true" depends_on="1">
### Step 2: Gather Context

Decide the track first: a fixed defect is the bug track, and a practice or decision worth keeping is the knowledge track. Then extract from conversation history:

**Required for both tracks:**

- **Module name**: Which module or area the learning applies to
- **Prevention or guidance**: How to avoid the problem, or what to do instead

**Bug track:**

- **Symptom**: Observable error/behavior (exact error messages)
- **Investigation attempts**: What didn't work and why
- **Root cause**: Technical explanation of actual problem
- **Solution**: What fixed it (code/config changes)

**Knowledge track:**

- **Context**: The situation, gap or friction that prompted the guidance
- **Guidance**: The practice, pattern or recommendation
- **Why it matters**: Rationale and impact
- **When it applies**: Conditions where the guidance holds

**Environment details (optional):**

- Runtime, framework or toolchain versions
- OS version
- File/line references

**BLOCKING REQUIREMENT:** If critical context is missing, ask the user and WAIT for response before proceeding to Step 3. Bug track needs the module name, the exact error or symptom, and the resolution steps. Knowledge track needs the module name, the guidance, and when it applies:

```
I need a few details to document this properly:

1. Which module or area is this about? [ModuleName]
2. Bug track: what was the exact error message or symptom?
   Knowledge track: what is the guidance, and when does it apply?
3. Bug track only: what fixed it?

[Continue after user provides details]
```
</step>

<step number="3" required="false" depends_on="2">
### Step 3: Check Existing Docs

Search docs/solutions/ for similar issues:

```bash
# Search by error message keywords
grep -r "exact error phrase" docs/solutions/

# Search by symptom category
ls docs/solutions/[category]/
```

**IF similar issue found:**

THEN present decision options:

```
Found similar issue: docs/solutions/[path]

What's next?
1. Create new doc with cross-reference (recommended)
2. Update existing doc (only if same root cause)
3. Other

Choose (1-3): _
```

WAIT for user response, then execute chosen action.

**ELSE** (no similar issue found):

Proceed directly to Step 4 (no user interaction needed).
</step>

<step number="4" required="true" depends_on="2">
### Step 4: Generate Filename

Format: `[sanitized-symptom-or-title]-[module]-[YYYYMMDD].md`

Bug-track docs name the file after the symptom. Knowledge-track docs have no symptom, so they use a short sanitized title of the guidance.

**Sanitization rules:**

- Lowercase
- Replace spaces with hyphens
- Remove special characters except hyphens
- Truncate to reasonable length (< 80 chars)

**Examples:**

- `n-plus-one-report-generation-ReportService-20251110.md` (bug track)
- `parameter-not-saving-state-Checkout-20251110.md` (bug track)
- `webview-crash-on-resize-Assistant-20251110.md` (bug track)
- `prefer-explicit-request-timeouts-HttpClient-20251110.md` (knowledge track)
</step>

<step number="5" required="true" depends_on="4" blocking="true">
### Step 5: Validate YAML Schema

**CRITICAL:** All docs require validated YAML frontmatter with enum validation.

<validation_gate name="yaml-schema" blocking="true">

**Validate against schema:**
Load [references/schema.yaml](./references/schema.yaml) and classify the problem against the enum values defined there and summarized in [yaml-schema.md](./references/yaml-schema.md). Ensure all required fields are present and match allowed values exactly.

- Required for both tracks: `module`, `date`, `problem_type`, `component`, `severity`.
- Required for the bug track only: `symptoms` (1-5 items), `root_cause`, `resolution_type`. A knowledge-track doc may omit all three.
- Offer and write only the `values` lists. A value under `legacy_values` is accepted when an existing doc already carries it, and is never chosen for a new doc.

**BLOCK if validation fails:**

```
❌ YAML validation failed

Errors:
- problem_type: must be one of schema enums, got "compilation_error"
- severity: must be one of [critical, high, medium, low], got "invalid"
- symptoms (bug track): must be array with 1-5 items, got string

Please provide corrected values.
```

**GATE ENFORCEMENT:** Do NOT proceed to Step 6 (Create Documentation) until YAML frontmatter passes all validation rules defined in `references/schema.yaml`.

</validation_gate>
</step>

<step number="6" required="true" depends_on="5">
### Step 6: Create Documentation

**Determine category from problem_type:** Use the Category Mapping section of [yaml-schema.md](./references/yaml-schema.md). The narrow knowledge types (`architecture_pattern`, `design_pattern`, `tooling_decision`, `convention`) share `best-practices/` with `best_practice`.

**Create documentation file:** The directory is created on first use, so no category directory needs to exist beforehand.

```bash
PROBLEM_TYPE="[from validated YAML]"
CATEGORY="[mapped from problem_type]"
FILENAME="[generated-filename].md"
DOC_PATH="docs/solutions/${CATEGORY}/${FILENAME}"

# Create directory on first use
mkdir -p "docs/solutions/${CATEGORY}"

# Write documentation using the template for the track in assets/resolution-template.md
# (Content populated with Step 2 context and validated YAML frontmatter)
```

**Result:**
- Single file in category directory
- Enum validation ensures consistent categorization

**Create documentation:** Populate the Bug Track or Knowledge Track template from `assets/resolution-template.md` with context gathered in Step 2 and validated YAML frontmatter from Step 5.
</step>

<step number="7" required="false" depends_on="6">
### Step 7: Cross-Reference

If similar issues found in Step 3:

**Update existing doc:**

```bash
# Add Related Issues link to similar doc
echo "- See also: [$FILENAME]($REAL_FILE)" >> [similar-doc.md]
```

**Update new doc:**
Already includes cross-reference from Step 6.
</step>

</critical_sequence>

---

<decision_gate name="post-documentation" wait_for_user="true">

## Decision Menu After Capture

After successful documentation, present options and WAIT for user response:

```
✓ Solution documented

File created:
- docs/solutions/[category]/[filename].md

What's next?
1. Continue workflow (recommended)
2. Link related issues - Connect to similar problems
3. Create new skill - Extract into new learning skill
4. View documentation - See what was captured
5. Other
```

**Handle responses:**

**Option 1: Continue workflow**

- Return to calling skill/workflow
- Documentation is complete

**Option 2: Link related issues**

- Prompt: "Which doc to link? (provide filename or describe)"
- Search docs/solutions/ for the doc
- Add cross-reference to both docs
- Confirm: "✓ Cross-reference added"

**Option 3: Create new skill**

User selects this when the solution represents the start of a new learning domain:

Action:
1. Prompt: "What should the new skill be called? (e.g., release-automation, api-versioning)"
2. Run `python3 .opencode/skills/skill-creator/scripts/init_skill.py [skill-name]`
3. Create initial reference files with this solution as first example
4. Confirm: "✓ Created new [skill-name] skill with this solution as first example"

**Option 4: View documentation**

- Display the created documentation
- Present decision menu again

**Option 5: Other**

- Ask what they'd like to do

</decision_gate>

---

<integration_protocol>

## Integration Points

**Invoked by:**
- `/systematic:ce-compound` skill (primary interface)
- Manual invocation in conversation after solution confirmed
- Can be triggered by detecting confirmation phrases like "that worked", "it's fixed", etc.

**Invokes:**
- None (terminal skill - does not delegate to other skills)

**Handoff expectations:**
All context needed for documentation should be present in conversation history before invocation.

</integration_protocol>

---

<success_criteria>

## Success Criteria

Documentation is successful when ALL of the following are true:

- ✅ YAML frontmatter validated (all required fields, correct formats)
- ✅ File created in docs/solutions/[category]/[filename].md
- ✅ Enum values match references/schema.yaml exactly, offered `values` only
- ✅ Code examples included in solution section
- ✅ Cross-references added if related issues found
- ✅ User presented with decision menu and action confirmed

</success_criteria>

---

## Error Handling

**Missing context:**

- Ask user for missing details
- Don't proceed until critical info provided

**YAML validation failure:**

- Show specific errors
- Present retry with corrected values
- BLOCK until valid

**Similar issue ambiguity:**

- Present multiple matches
- Let user choose: new doc, update existing, or link as duplicate

**Module not in modules documentation:**

- Warn but don't block
- Proceed with documentation
- Suggest: "Add [Module] to modules documentation if not there"

---

## Execution Guidelines

**MUST do:**
- Validate YAML frontmatter (BLOCK if invalid per Step 5 validation gate)
- Extract exact error messages from conversation (bug track)
- Include code examples in solution section
- Create directories before writing files (`mkdir -p`)
- Ask user and WAIT if critical context missing

**MUST NOT do:**
- Skip YAML validation (validation gate is blocking)
- Use vague descriptions (not searchable)
- Omit code examples or cross-references
- Require `symptoms` or an error message for a knowledge-track doc

---

## Quality Guidelines

**Good documentation has:**

- ✅ Exact error messages (copy-paste from output)
- ✅ Specific file:line references (see Citing code below)
- ✅ Observable symptoms (what you saw, not interpretations)
- ✅ Failed attempts documented (helps avoid wrong paths)
- ✅ Technical explanation (not just "what" but "why")
- ✅ Code examples (before/after if applicable)
- ✅ Prevention guidance (how to catch early)
- ✅ Cross-references (related issues)

**Citing code:**

- Write a repo-relative path with the line or range, as `<file>:<line>` or `<file>:<start>-<end>`. Never cite a bare file name.
- Put the backticked symbol the citation points at in the same sentence, so a moved line is caught.
- For code outside the repo, or code that has been deleted, link a tag or commit, not a path.
- In examples, write placeholders such as `<file>:<line>`, not real citations.
- The content-integrity gate checks the citations in `docs/solutions/` and fails on a missing file, a line outside the file, a span of only blanks or comments, or a named symbol that is not in the span.

**Avoid:**

- ❌ Vague descriptions ("something was wrong")
- ❌ Missing technical details ("fixed the code")
- ❌ No context (which version? which file?)
- ❌ Just code dumps (explain why it works)
- ❌ No prevention guidance
- ❌ No cross-references

---

## Example Scenario

**User:** "That worked! The N+1 query is fixed."

**Skill activates:**

1. **Detect confirmation:** "That worked!" triggers auto-invoke
2. **Gather context (bug track):**
   - Module: Report Service
   - Symptom: Report generation taking >5 seconds, N+1 query when loading comment threads
   - Failed attempts: Added pagination (didn't help), checked background job performance
   - Solution: Loaded the comments for all reports in one eager-loaded query
   - Root cause: Missing eager loading causing a separate database query per comment thread
3. **Check existing:** No similar issue found
4. **Generate filename:** `n-plus-one-report-generation-ReportService-20251110.md`
5. **Validate YAML:**
   ```yaml
   module: Report Service
   date: 2025-11-10
   problem_type: performance_issue
   component: backend
   symptoms:
     - "N+1 query when loading comment threads"
     - "Report generation taking >5 seconds"
   root_cause: missing_include
   severity: high
   tags: [n-plus-one, eager-loading, performance]
   ```
   ✅ Valid
6. **Create documentation:**
   - `docs/solutions/performance-issues/n-plus-one-report-generation-ReportService-20251110.md`
7. **Cross-reference:** None needed (no similar issues)

**Output:**

```
✓ Solution documented

File created:
- docs/solutions/performance-issues/n-plus-one-report-generation-ReportService-20251110.md

What's next?
1. Continue workflow (recommended)
2. Link related issues - Connect to similar problems
3. Create new skill - Extract into new learning skill
4. View documentation - See what was captured
5. Other
```

**Knowledge-track variant:** For "we should always set explicit request timeouts", the same flow asks only for the module, the guidance and when it applies. The frontmatter carries `problem_type: convention` and no `symptoms`, the file goes to `docs/solutions/best-practices/`, and the directory is created if it does not exist yet.

---

## Future Enhancements

**Not in Phase 7 scope, but potential:**

- Search by date range
- Filter by severity
- Tag-based search interface
- Metrics (most common issues, resolution time)
- Export to shareable format (community knowledge sharing)
- Import community solutions
