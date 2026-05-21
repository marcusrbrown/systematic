---
title: Subagent skill tool permissions require explicit per-agent configuration
date: 2026-05-20
category: workflow-issues
module: plugin-permissions
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - A subagent needs to load a Systematic skill via the systematic_skill tool
  - Using OMO Slim or any OpenCode config that restricts agent tool permissions
  - Delegating design, review, or other skill-dependent work to a subagent
tags:
  - permissions
  - subagent
  - systematic-skill
  - omo-slim
  - opencode-config
---

# Subagent skill tool permissions require explicit per-agent configuration

## Context

OpenCode subagents do not inherit the parent agent's tool permission allow-rules. When using a plugin configuration layer like OMO Slim (`oh-my-opencode-slim.jsonc`) that restricts agent tool access via explicit `skills` arrays, each subagent that needs to invoke `systematic_skill` must have the tool explicitly permitted in its own agent configuration.

This was discovered when `@designer` failed to load `systematic:frontend-design` during a GREEN verification test. The orchestrator had `skills: ["*"]` but designer only had `skills: ["agent-browser"]`, so `systematic_skill` tool calls were denied.

## Guidance

When configuring agents that may need Systematic skills, add the appropriate permission:

```jsonc
// In oh-my-opencode-slim.jsonc or equivalent
{
  "agents": {
    "designer": {
      "skills": ["agent-browser", "systematic:*"]
      //                          ^^^^^^^^^^^^^^^^
      // Without this, designer cannot load any systematic skill
    }
  }
}
```

The wildcard `"systematic:*"` covers all Systematic-namespaced skills. For tighter scoping, list specific skills:

```jsonc
{
  "agents": {
    "designer": {
      "skills": ["agent-browser", "systematic:frontend-design"]
    }
  }
}
```

## Why This Matters

A subagent that cannot load its domain skill falls back to general knowledge, producing significantly lower-quality output for specialized tasks. The failure is silent from the orchestrator's perspective — the subagent simply proceeds without the skill's guidance, and the quality gap only surfaces during verification.

## When to Apply

- Adding a new subagent that should use Systematic skills
- Debugging why a subagent's output lacks skill-specific patterns (OKLCH, design laws, TDD phases, etc.)
- Configuring OMO Slim or similar permission-restricting OpenCode config layers

## Examples

**Failure scenario:**

1. Orchestrator dispatches `@designer` to apply frontend-design skill
2. Designer attempts `systematic_skill({ name: "systematic:frontend-design" })`
3. OMO Slim denies the call — designer's `skills` array lacks the entry
4. Designer proceeds without the skill, producing generic output
5. Orchestrator's verification catches the quality gap

**Diagnostic check:**

```bash
# Inspect the agent's effective config
grep -A 10 '"designer"' ~/.config/opencode/oh-my-opencode-slim.jsonc
# Look for "skills" array — must include "systematic:*" or the specific skill name
```

## Related

- Oracle troubleshooting session on PR #418 — root cause analysis
- OMO Slim documentation for agent permission configuration
