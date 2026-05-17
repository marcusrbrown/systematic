> **Source**: Modified from [Anthropic's Skill authoring best practices](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices) ([CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)). Retrieved 2026-05-17.

# Skill Authoring: Distilled Reference for Systematic

This reference organizes skill authoring guidance around six Systematic authoring tasks. See the upstream source for advanced patterns (executable scripts, MCP tools, runtime environments).

## Triggering Skills Through Precise Descriptions

A skill's `description` field drives discovery. Agents scan descriptions to decide whether to load a skill.

**What works:**

- State both capability and trigger context: "Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction."
- Write in third person: "Processes Excel files" not "I can help you process Excel files."
- Include specific terms users employ: "Excel," "spreadsheets," "tabular data," ".xlsx files."
- Avoid vague language: "Helps with documents" is too generic.

Test your description: if a user said the triggering phrase, would an agent recognize this skill as relevant?

## Organizing Content for Progressive Disclosure

Skills grow. Simple skills use only SKILL.md; mature skills bundle reference files. Load only what's needed—metadata is always pre-loaded; detailed content is read on-demand.

**When to split:**

- Keep SKILL.md body under 500 lines. Move detailed content to separate files as you approach this limit.
- Use reference files for API docs, extensive examples, domain-specific schemas, or advanced features.
- Link directly from SKILL.md to references; avoid nesting references within references.

**Naming and structure:**

- Use descriptive filenames: `form_validation_rules.md`, not `doc2.md`.
- Organize by domain: `reference/finance.md`, `reference/sales.md`.
- For reference files longer than 100 lines, include a table of contents at the top.

## Writing Concise Prose

The context window is shared. Every token competes with conversation history, other skills, and the user's request. Conciseness is a design constraint.

**Principles:**

- Assume the agent is already smart. Don't explain what PDFs are or how libraries work.
- Cut explanatory preamble. Write "Use pdfplumber for text extraction" and show the code instead of lengthy introductions.
- Justify token cost. If a paragraph doesn't add information the agent lacks, remove it.

## Matching Skill Rigidity to Task Variance

Not all tasks are equally fragile. Match your skill's prescriptiveness to the task's variability.

**High freedom:** Use when multiple approaches are valid and decisions depend on context. Example: code review.

**Medium freedom:** Use when a preferred pattern exists but variation is acceptable. Example: report generation with a template.

**Low freedom:** Use when operations are fragile, consistency is critical, or a specific sequence must be followed. Example: database migration. "Run exactly this script: `python scripts/migrate.py --verify --backup`. Do not modify the command."

## Testing Skills Through Evaluation

Build evaluations before writing extensive documentation. This ensures your skill solves real problems rather than documenting imagined ones.

**Evaluation-driven development:**

1. Identify gaps: run the agent on representative tasks without the skill. Document specific failures or missing context.
2. Create evaluations: build three scenarios that test these gaps. Specify the task, expected behavior, and success criteria.
3. Establish baseline: measure the agent's performance without the skill.
4. Write minimal instructions: create just enough content to address gaps and pass evaluations.
5. Iterate: execute evaluations, compare against baseline, and refine based on observed behavior.

**Iterative development with agents:**

The most effective skill development involves two agents: one authoring the skill (Agent A) and one testing it in real tasks (Agent B). Complete a task with Agent A, ask Agent A to create a skill, test with Agent B on related tasks, return to Agent A for improvements, and iterate based on real behavior rather than assumptions.

**What to watch:** Does the skill activate when expected? Are instructions clear? If the agent repeatedly reads the same file, consider moving that content to SKILL.md. If the agent never accesses a bundled file, it may be unnecessary.

## Common Content Patterns and Naming

Reusable patterns reduce authoring friction and help agents navigate skills consistently.

**Naming conventions:**

- Use gerund form (verb + -ing): "Processing PDFs," "Analyzing spreadsheets," "Managing databases."
- Acceptable alternatives: noun phrases ("PDF Processing") or action-oriented ("Process PDFs").
- Avoid vague names: "Helper," "Utils," "Tools," "Documents," "Data," "Files."

**Template pattern:**

Provide templates for output format. Strict: "ALWAYS use this exact template structure: `# [Title]\n## Executive summary\n[Overview]\n## Key findings\n[Findings]`" Flexible: "Here is a sensible default format, but use your best judgment: [template]. Adjust sections as needed for the specific context."

**Examples pattern:**

Show input/output pairs. This teaches style and detail level more effectively than descriptions alone.

**Workflow pattern:**

Break complex operations into clear, sequential steps. Provide a checklist agents can copy and check off as they progress.

**Feedback loops:**

Implement validation loops that catch errors early. Run validator → fix errors → repeat.

**Consistent terminology:**

Choose one term and use it throughout. Don't mix "API endpoint," "URL," "API route," and "path." Consistency helps agents understand and follow instructions.

**Avoid time-sensitive information:**

Don't include information that will become outdated. Use an "Old patterns" section for deprecated details instead.
