---
title: OpenCode v1 names one skill two ways, so generated permissions need per-rule provenance
date: 2026-10-29
category: logic-errors
module: plugin-permissions
problem_type: logic_error
component: configuration
symptoms:
  - "A managed `skills` list allows its skills through the native `skill` tool but refuses them through `systematic_skill`"
  - "A skill in `disabled_skills` is hidden from `systematic_skill` but still listed and loadable through the native `skill` tool"
  - "A hand-written bare allow caused the plugin to mirror an allow over the user's own prefixed deny"
  - "Re-enabling a skill deleted a deny the user had written into a replaced `permission.skill` map"
root_cause: missing_permission
resolution_type: code_fix
severity: medium
related_components:
  - src/lib/asset-plan.ts
tags:
  - opencode-v1
  - permissions
  - systematic-skill
  - disabled-skills
  - skills-list
  - provenance
  - ownership
---

# OpenCode v1 names one skill two ways, so generated permissions need per-rule provenance

## Problem

On OpenCode v1 the same bundled skill is reachable through two tools, and each tool asks permission under a different name. The native `skill` tool asks with the bare name, such as `git-worktree`. `systematic_skill` asks with the prefixed name, `systematic:git-worktree` (`src/lib/skill-tool.ts:200`, which passes `matchedSkill.prefixedName`). A permission rule reaches only the tool whose name form it uses. A local probe on OpenCode 1.19.4 (not committed) showed the native tool and `systematic_skill` asking under different names.

Two bugs came from writing rules in one form only:

- #1243: a managed `skills` list emitted a bare `* deny` and bare allows. The list's own skills were refused through `systematic_skill`.
- #1242: `disabled_skills` removed a skill from `systematic_skill` and from commands, but OpenCode registers the whole bundled skills directory, so the native `skill` tool still listed and loaded the disabled skill.

## What Didn't Work

- **Provenance per name.** Tracking which names came from a skills list (`skillsListNames`) cannot tell a list's allow from a hand-written allow for the same name. Mirroring keyed on list membership copies a hand-written bare allow over a user's prefixed deny, across category and agent overlays, because the name is still "in the list" after the user overrides it.
- **Ownership keyed by the outer config.** Recording the config object plus the pattern assumes the user's `permission` and `permission.skill` maps stay the same objects between runs. They do not. After the user replaces the map, the record points at a rule the plugin never wrote, and re-enabling a skill deletes the user's deny.

## Solution

Three rules.

**1. Cover both names, and mark each generated rule.** `PermissionRuleTriple` carries an optional `fromSkillsList` marker (`src/lib/asset-plan.ts:53`). `addManagedSkillRules` sets it on the list's `* deny` and on each allow (`src/lib/asset-plan.ts:451-459`). `setPermissionRule` replaces the marker along with the rule, so a hand-written rule that overrides a list rule for the same pattern is no longer marked (`src/lib/asset-plan.ts:480-496`). The v1 fold in `foldPermissionRulesToV1Map` mirrors only an allow whose `fromSkillsList` marker survived last-match-wins (`src/lib/config-handler.ts:155-165`):

```ts
if (permission !== 'skill' || setting !== 'allow' || !fromSkillsList) continue
const prefixed = formatSkillCommandName(pattern)
const explicit = explicitSkillSettings.get(prefixed)
if (prefixed !== pattern && (explicit ?? 'allow') === 'allow') {
  setRule(permission, prefixed, setting)
}
```

**2. Generated rules never override user rules.** The fold first collects every unmarked skill rule into `explicitSkillSettings` (`src/lib/config-handler.ts:137-142`). The mirror applies only when the prefixed name has no explicit rule, or its explicit rule is `allow` (`src/lib/config-handler.ts:161-164`). A prefixed deny or ask the user wrote stays. A prefixed allow the user wrote agrees with the mirror, so it is moved after the list's `* deny` and not duplicated. The doc comment on `foldPermissionRulesToV1Map` states the rule (`src/lib/config-handler.ts:124-132`).

**3. Bind ownership to the object that was written.** `denyDisabledSkills` adds a bare and a prefixed deny for each disabled skill at the top level of the host config (`src/lib/config-handler.ts:328`, called at `src/lib/config-handler.ts:277`). It records what it added in a `WeakMap` keyed by the config, storing the `permission` map, the `permission.skill` map, and the added patterns (`src/lib/config-handler.ts:295`). On the next run it removes those denies only while both maps are still the same objects (`src/lib/config-handler.ts:335-339`). A rule the user already wrote for the same name is left alone and never recorded.

Tests in `tests/unit/config-handler.test.ts` pin each rule:

- `tests/unit/config-handler.test.ts:1861`, `tests/unit/config-handler.test.ts:1884`, `tests/unit/config-handler.test.ts:1903`: an explicit prefixed deny survives a bare allow, whether set before or after the list.
- `tests/unit/config-handler.test.ts:1924`: an explicit prefixed allow is kept and not duplicated.
- `tests/unit/config-handler.test.ts:1945`: a replaced `permission.skill` map is not touched when a skill is re-enabled.

OpenCode v2 uses one name, and its output is unchanged. `skillResource` strips the `systematic:` prefix from skill rules, so both spellings match the same skill (`src/lib/opencode-v2-permissions.ts:41-44`).

## Why This Works

The marker records who wrote a rule, which is the fact the mirror needs. "The name appears in the list" is a weaker fact: it stays true after a user overrides the rule. Because the marker moves with the rule inside `setPermissionRule`, the winning rule's author is known when the fold runs.

Checking explicit settings before mirroring keeps the order of authority simple: the user's rules, then generated rules. A generated rule can add coverage for the other name but cannot contradict anything the user said about that name.

Holding the map identities answers the ownership question without guessing. If both maps are the ones the plugin wrote into, its record is accurate. If either was replaced, the record is stale and nothing is removed.

## Prevention

These apply to any host that names one resource two ways, not only OpenCode.

- When two consumers name the same resource differently, generate rules for both names. Keep the two forms in sync by construction, from one source, and not by a second hand-maintained list.
- Record provenance on each rule, not on each name. A name can have a generated rule and a hand-written rule over time; only the rule that wins has an author.
- Write down which settings "agree" with a generated rule. Here a prefixed allow agrees and a prefixed deny or ask does not. Without that sentence, "never override the user" gets implemented as "skip anything explicit", which leaves a user's allow in the wrong position.
- Bind ownership of a mutation to the object you wrote into, not to a key path. A user-owned config can be replaced between runs. Test the replacement path directly, as `tests/unit/config-handler.test.ts:1945` does.
- Probe the host with each name form before trusting the model of how it evaluates.

## Related Issues

- [`docs/solutions/workflow-issues/subagent-skill-permission-scoping-2026-05-20.md`](../workflow-issues/subagent-skill-permission-scoping-2026-05-20.md): the same two-name root, seen from hand-written rules in a restrictive layer.
- #1242 and #1243: fixed in v3.27.1 (#1246).
