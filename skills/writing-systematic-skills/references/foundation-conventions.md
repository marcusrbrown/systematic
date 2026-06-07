# Foundation Conventions

This reference expands the Systematic-specific rules from `SKILL.md`. The mechanical rules are enforced by `bun scripts/content-integrity.ts`; this file explains the judgment calls behind them.

## Frontmatter

Systematic skill frontmatter mirrors what the runtime loader actually reads. Do not invent fields for documentation structure. If the loader does not consume the field, put the information in the body.

| Field | Required | When To Use | Enforcement | Example |
|---|---:|---|---|---|
| `name` | Yes | Every skill. Use the unprefixed skill identifier unless another namespace is intentional. | Read + enforced (loader rejects missing/null) | `name: writing-systematic-skills` |
| `description` | Yes | Trigger-oriented discovery text. Third person. Prefer `Use when...`. | Read + enforced (loader rejects missing/null) | `description: Use when fixing bundled skill frontmatter failures...` |
| `argument-hint` | No | The skill accepts meaningful invocation arguments. | Read + surfaced to callers | `argument-hint: "[path/to/document.md]"` |
| `disable-model-invocation` | No | Dispatcher or routing skills that should not be directly model-invoked. | Read + enforced (loader acts on it) | `disable-model-invocation: true` |
| `allowed-tools` | No | The skill needs an explicit tool allowlist. | **Read but not enforced.** `src/lib/skills.ts` parses it into `SkillFrontmatter.allowedTools` and passes it through, but no permission gate in `src/lib` acts on it. OpenCode treats it as metadata, not enforced permissions. Do not rely on this field to restrict tool access. | `allowed-tools: Bash, Read` |
| `license` | No | Licensing metadata matters for distribution. | Read, passed through as metadata | `license: MIT` |
| `compatibility` | No | A platform or version caveat is real and useful. | Read, passed through as metadata | `compatibility: OpenCode` |
| `metadata` | No | String-only metadata map. Keep it boring. | Read, passed through as metadata | `metadata: { owner: systematic }` |
| `user-invocable` | No | Direct user invocation should be explicitly advertised or suppressed. | Read + surfaced to callers | `user-invocable: false` |
| `agent` | No | A loader-supported companion agent is required. | Read + enforced (loader acts on it) | `agent: general` |
| `model` | No | A skill-level model choice is justified for *skill execution* (not bundled agents -- see below). | Read + enforced (loader acts on it; banned in bundled agent markdown) | `model: anthropic/claude-haiku-4-5` |
| `context` | No | Forked execution is required. `fork` derives subtask behavior at runtime. | Read + enforced (runtime-recognized) | `context: fork` |
| `subtask` | No | Explicit forked-subtask dispatch marker. | Read + enforced (runtime-recognized) | `subtask: true` |

### Required Fields

`name` and `description` must be present. Empty strings are not valid values. Bare YAML keys such as `name:` parse as null and count as missing.

### Banned Field

`preconditions` is banned because it has no runtime consumer. Use a body section instead:

```markdown
## Prerequisites

Only run this skill after the bug is reproduced and the fix has been verified.
```

### Runtime-Recognized Forking Fields

`context: fork` and `subtask: true` are allowed. They are runtime-recognized and must not be treated as idiosyncratic frontmatter.

Use them only when the skill genuinely needs forked subtask behavior. Do not cargo-cult them onto normal skills.

### Description Style

Good descriptions answer: should the agent load this skill now?

Good:

```yaml
description: Use when creating, editing, auditing, or fixing bundled Systematic skills, especially when authoring SKILL.md files or resolving content-integrity frontmatter failures.
```

Bad:

```yaml
description: This skill explains frontmatter, file layout, validation, and identity defaults for Systematic skills.
```

The bad version describes content. The good version describes trigger conditions.

## File Layout

Every skill has exactly one entry point:

```text
skills/<skill-name>/SKILL.md
```

Use sub-files only when the content is too bulky or operationally distinct for the main skill.

```text
skills/<skill-name>/
├── SKILL.md
├── references/
│   └── detailed-guidance.md
├── scripts/
│   └── helper.mjs
├── assets/
│   └── diagram.svg
└── templates/
    └── output-template.md
```

### Directory Choices

| Directory | Use For | Do Not Use For |
|---|---|---|
| `references/` | Long explanations, decision tables, extended examples | Required setup that must be read before deciding to use the skill |
| `scripts/` | Executable helpers the agent can run | Pseudocode or prose examples |
| `assets/` | Static images, fixtures, or other bundled files | Markdown guidance that belongs in `references/` |
| `templates/` | Fillable documents, prompts, or output stubs | Examples that should not be copied verbatim |

### Sub-File Links

When `SKILL.md` mentions a sub-file path, the content-integrity gate verifies it exists. Prefer direct repo-local paths:

```markdown
Read `references/foundation-conventions.md` for examples.
```

Avoid ambiguous references such as "the conventions doc". They are harder for agents to follow and impossible for the gate to verify.

## Identity Defaults

### Bundled Agent Model

Bundled agents must omit the `model` field entirely:

```yaml
---
name: example-agent
description: ...
# no `model:` line
---
```

Per [OpenCode's agent docs](https://opencode.ai/docs/agents/): **"If you don't specify a model, primary agents use the model globally configured while subagents will use the model of the primary agent that invoked the subagent."** All bundled Systematic agents are subagents, so omitting `model` gives the desired portable inheritance behavior.

Do **not** declare `model: inherit`. That literal value is undocumented and was treated as a real provider/model string by `Provider.parseModel()` until [sst/opencode#17888](https://github.com/sst/opencode/pull/17888) landed in mid-March 2026 — producing `ProviderModelNotFoundError` on every subagent invocation for anyone on an older OpenCode. Omitting the field works on every OpenCode version and is what the docs canonically describe.

Hardcoded provider IDs (`anthropic/claude-...`, `openai/gpt-...`, etc.) are also banned from **bundled agent markdown/frontmatter** because they make an agent unusable for users on other providers. This ban does not apply to source-owned category model defaults in TypeScript code, which are centrally maintained, structurally validated, and emitted at the built-in/default layer during config handling. If a future agent truly depends on a specific provider in its markdown, document the constraint in the plan and get explicit review before adding the hardcoded model.

Systematic provides source-owned category model defaults in TypeScript code for all six bundled agent categories (`design`, `docs`, `document-review`, `research`, `review`, `workflow`). These code-level defaults are emitted during config handling and do not change the markdown contract: bundled agent files must still omit `model` frontmatter. The content-integrity gate continues to enforce the markdown-level ban independently of what source code defaults provide.

### Machine ID

`ai:systematic` is a machine identity string for Systematic-owned operations. Proof uses it as the `by` field on operations and the `X-Agent-Id` header. Keep it lowercase and stable.

Do not use `ai:systematic` as a skill-reference pattern. Skill and agent references use their own namespaces, such as `systematic:writing-systematic-skills` or `systematic:research:best-practices-researcher`.

### Public-Facing Voice

Skill text should be reusable guidance, not a session transcript. Avoid first-person process narration, internal note IDs, and references to how a particular implementation session unfolded.

## Validator Workflow

Run:

```bash
bun scripts/content-integrity.ts --verbose
```

Use the output as the source of truth for cleanup. If a violation surprises you, check the runtime loader before changing the validator:

- Skill frontmatter rules mirror `src/lib/skills.ts`.
- YAML parsing behavior comes from `src/lib/frontmatter.ts`.
- Sub-file directories come from `SUBFILE_DIRECTORY_NAMES` in `scripts/content-integrity.ts`.

When the runtime contract changes, update the loader and validator together. A validator allow-list that drifts from the loader creates false failures or misses real runtime-invisible fields.
