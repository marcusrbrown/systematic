/**
 * Synthetic package-root asset tree for the OpenCode v1 goldens.
 *
 * The goldens deliberately do not run over the real bundled `skills/` and
 * `agents/`, so routine skill edits do not churn them. Names that the config
 * schema validates against the real inventory (`git-worktree` in
 * `disabled_skills`, and agent names in `disabled_agents` and the `agents`
 * overlay map) reuse real names with synthetic content. Skill names, which
 * overlays validate against this tree, and command names are fixture-only.
 *
 * Keys are paths relative to the temp package root the test builds.
 */
export const GOLDEN_ASSET_FILES: Readonly<Record<string, string>> = {
  'skills/using-systematic/SKILL.md': `---
name: using-systematic
description: Synthetic bootstrap skill
---
# Using Fixture Systematic

Synthetic bootstrap body for the v1 goldens.
`,
  'skills/using-systematic/references/opencode-profile.md': `# Fixture OpenCode Profile

FIXTURE-OPENCODE-PROFILE-MARKER
`,
  'skills/using-systematic/references/worktree-placement.md': `FIXTURE-WORKTREE-RULE-MARKER: create worktrees under the fixture path.
`,
  'skills/git-worktree/SKILL.md': `---
name: git-worktree
description: Synthetic worktree skill
---
# Fixture Worktree

Worktree skill body.
`,
  'skills/fixture-alpha/SKILL.md': `---
name: fixture-alpha
description: Alpha fixture skill
---
# Fixture Alpha

Alpha body.
`,
  'skills/fixture-alpha/notes.txt': 'alpha sidecar file\n',
  'skills/fixture-beta/SKILL.md': `---
name: fixture-beta
description: Beta fixture skill
---
# Fixture Beta

Beta body.
`,
  'skills/fixture-gamma/SKILL.md': `---
name: ns:fixture-gamma
description: Namespaced fixture skill
---
# Fixture Gamma

Gamma body.
`,
  'skills/2/SKILL.md': `---
name: "2"
description: Integer-like fixture skill two
---
# Fixture Two

Two body.
`,
  'skills/10/SKILL.md': `---
name: "10"
description: Integer-like fixture skill ten
---
# Fixture Ten

Ten body.
`,
  'skills/fixture-hidden/SKILL.md': `---
name: fixture-hidden
description: Tool-only fixture skill, not a command
user-invocable: false
---
# Fixture Hidden

Hidden body.
`,
  'skills/fixture-manual/SKILL.md': `---
name: fixture-manual
description: Command-only fixture skill, not in the tool catalog
disable-model-invocation: true
---
# Fixture Manual

Manual body.
`,
  'skills/fixture-routed/SKILL.md': `---
name: fixture-routed
description: Routed fixture skill
agent: repo-research-analyst
model: fixture-provider/fixture-model
subtask: true
argument-hint: "<topic>"
---
# Fixture Routed

Routed body.
`,
  'skills/fixture-args/SKILL.md': `---
name: fixture-args
description: Argument-substitution fixture skill
---
# Fixture Args

First: $1
Everything: $ARGUMENTS
`,
  'agents/review/correctness-reviewer.md': `---
name: correctness-reviewer
description: Reviews fixture correctness
mode: subagent
temperature: 0.1
permission:
  edit: deny
---
# Correctness Reviewer

Fixture reviewer prompt.
`,
  'agents/review/adversarial-reviewer.md': `---
name: adversarial-reviewer
description: Adversarially reviews fixtures
mode: subagent
---
# Adversarial Reviewer

Adversarial fixture prompt.
`,
  'agents/research/repo-research-analyst.md': `---
name: repo-research-analyst
description: Researches fixture repos
mode: subagent
model: fixture-provider/planner-model
---
# Repo Research Analyst

Fixture research prompt.
`,
  'agents/review/security-reviewer.md': `---
name: security-reviewer
description: Shadowed by a user native agent
mode: subagent
---
# Security Reviewer

This bundled agent loses to the native agent of the same name.
`,
  'commands/fixture-command.md': `---
name: fixture-command
description: Synthetic command
agent: repo-research-analyst
model: fixture-provider/fixture-model
subtask: true
---
Command body with $ARGUMENTS reference.
`,
}

/** A user-owned skill discovered under the project, to exercise `skills_as_commands`. */
export const GOLDEN_DISCOVERED_SKILL_FILES: Readonly<Record<string, string>> = {
  '.claude/skills/fixture-discovered/SKILL.md': `---
name: fixture-discovered
description: Discovered fixture skill
---
# Fixture Discovered

Discovered body.
`,
}
