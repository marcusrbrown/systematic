---
name: writing-systematic-skills
description: Use when creating, editing, auditing, or fixing bundled Systematic skills, especially when authoring SKILL.md files, adding skill reference files, resolving content-integrity frontmatter failures, or deciding which Systematic conventions apply beyond the general writing-skills guidance.
---

# Writing Systematic Skills

Systematic skills are OpenCode-native workflow assets. Use this skill after loading the general `writing-skills` foundation; this file only covers the Systematic-specific delta.

## When To Use

Use this skill when you are:

- Creating a new bundled skill under `skills/`
- Editing an existing bundled skill's frontmatter or file layout
- Fixing content-integrity frontmatter or sub-file failures
- Deciding whether a skill needs references, scripts, assets, or templates
- Auditing bundled skills for provider-portable defaults

Do not use this as a replacement for `~/.agents/skills/writing-skills/SKILL.md`. Load that foundation first when authoring or substantially editing skill content.

## Foundation

`writing-skills` supplies the authoring discipline: pressure scenarios, clear trigger-oriented descriptions, concise bodies, and reference files only when depth earns its keep.

Systematic adds repository-specific constraints:

- Runtime-recognized frontmatter fields are fixed by the skill loader.
- Skill sub-files live in a small set of conventional directories.
- Bundled agents omit the `model` field; subagents inherit the invoking primary agent's model.
- Content-integrity enforces the mechanical parts in CI.

For worked examples and judgment calls, read `references/foundation-conventions.md`.

## Frontmatter Rules

Every bundled skill must have YAML frontmatter with:

- `name` - unprefixed skill identifier. The loader adds the `systematic:` command prefix automatically unless the skill intentionally belongs to another namespace such as `ce:`.
- `description` - third-person trigger conditions. Prefer `Use when...`; describe when to load the skill, not its internal workflow.

Optional fields are allowed only when the runtime loader recognizes them:

| Field | Use |
|---|---|
| `argument-hint` | Shows expected invocation arguments. |
| `disable-model-invocation` | Prevents direct model invocation for dispatcher-style skills. |
| `allowed-tools` | Declares tool constraints for skill execution. |
| `license` | Carries skill licensing metadata. |
| `compatibility` | Notes platform or version compatibility. |
| `metadata` | String-only metadata map. |
| `user-invocable` | Marks whether users should invoke the skill directly. |
| `agent` | Selects a companion agent when the loader supports it. |
| `model` | Selects a model for skill execution when justified. |
| `context` | Use `fork` when the skill should run in forked subtask context. |
| `subtask` | Explicit forked-subtask marker recognized by the runtime. |

`preconditions` is banned. It has no runtime consumer. Put prerequisite guidance in the skill body instead.

## File Layout

The required entry point is:

```text
skills/<skill-name>/SKILL.md
```

Optional sub-files must live under one of these directories:

- `references/` - deeper guidance, decision tables, long examples, or API notes
- `scripts/` - executable helpers an agent can run
- `assets/` - static files used by the skill
- `templates/` - reusable stubs or document templates

Keep the main `SKILL.md` small enough to decide whether and how to proceed. Move heavy detail to `references/`, and cite it with a repo-local path such as `references/foundation-conventions.md` so the sub-file integrity gate can verify it exists.

## Identity Defaults

Bundled agents must omit the `model` field entirely:

```yaml
---
name: example-agent
description: ...
# no `model:` line
---
```

Per [OpenCode's agent docs](https://opencode.ai/docs/agents/), subagents with no `model` inherit the model of the primary agent that invoked them — which is the desired portable behavior. Do **not** declare `model: inherit`: that literal value is undocumented and produces `ProviderModelNotFoundError` on OpenCode older than ~v1.13.x (pre [sst/opencode#17888](https://github.com/sst/opencode/pull/17888)). Hardcoded provider model IDs (`anthropic/...`, `openai/...`, etc.) are also banned from **bundled agent markdown/frontmatter** because they break users on other providers. Source-owned category model defaults in TypeScript code are a separate mechanism — they are audited, centrally maintained, and do not violate this markdown rule.

For agent or API attribution, `ai:systematic` is the machine ID used by Systematic-owned operations, such as Proof's `by` field and `X-Agent-Id` header. It is not a skill cross-reference convention.

## Validator

Run the content-integrity gate before shipping skill changes:

```bash
bun 'scripts/content-integrity.ts'
```

The gate checks:

- Skill frontmatter is present and uses only runtime-recognized fields.
- Required `name` and `description` fields are non-empty.
- Banned frontmatter such as `preconditions` is absent.
- Bundled agents omit the `model` field.
- Skill references to `references/`, `scripts/`, `assets/`, and `templates/` resolve on disk.

If the gate fails, fix the content rather than broadening the validator unless the runtime loader contract has actually changed.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Adding a new frontmatter field because it reads well | Add body prose instead, unless the runtime loader consumes the field. |
| Summarizing the whole workflow in `description` | Describe trigger conditions only. |
| Adding any `model` field to a bundled agent | Omit the field; subagents inherit from the invoking primary agent. |
| Linking to a non-existent reference file | Create the file or remove the link. |
| Duplicating the general writing-skills guidance | Link to the foundation and document only the Systematic delta. |
