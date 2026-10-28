import type { PermissionRuleTriple } from './asset-plan.js'
import { isPermissionSetting, isRecord } from './validation.js'

/**
 * Translation from the shared asset plan's ordered permission triples to the
 * rule list OpenCode v2 evaluates.
 *
 * The plan lists rules in true order, and v2 uses the same last-match-wins
 * rule over an ordered list, so the translation is one rule per triple in the
 * same order. Nothing is merged, sorted or de-duplicated here: integer-like
 * skill ids keep their place (the v1 object fold cannot), and a managed skills
 * list stays `deny *` followed by one allow per skill.
 *
 * Operations that touch several resources (a compound shell command) are
 * denied when any resource is denied. The translation never depends on a later
 * allow undoing an earlier deny across resources.
 */

export interface V2PermissionRule {
  action: string
  resource: string
  effect: 'allow' | 'ask' | 'deny'
}

/** v1 action names that v2 spells differently. */
const RENAMED_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['bash', 'shell'],
  ['task', 'subagent'],
])

/** v1 actions with no v2 counterpart. */
const DROPPED_ACTIONS: ReadonlySet<string> = new Set(['doom_loop', 'lsp'])

const SKILL_PREFIX = 'systematic:'

/**
 * v1 asks permission for `systematic:<id>`, so a rule written against that
 * name is valid on v1. The v2 tool asserts the bare id, so the prefix is
 * dropped from skill rules and both spellings match the same skill.
 */
function skillResource(pattern: string): string {
  return pattern.startsWith(SKILL_PREFIX)
    ? pattern.slice(SKILL_PREFIX.length)
    : pattern
}

/**
 * Ordered triples to v2 rules. Every other action name passes through
 * unchanged: v2 action names are open strings, and `skill` carries the bare
 * skill id as its resource.
 */
export function translatePermissionRules(
  rules: readonly PermissionRuleTriple[],
): V2PermissionRule[] {
  const translated: V2PermissionRule[] = []
  for (const { permission, pattern, setting } of rules) {
    if (DROPPED_ACTIONS.has(permission)) continue
    translated.push({
      action: RENAMED_ACTIONS.get(permission) ?? permission,
      resource: permission === 'skill' ? skillResource(pattern) : pattern,
      effect: setting,
    })
  }
  return translated
}

/**
 * A v1 permission object (`{edit: 'deny', bash: {'*': 'ask'}}`) as triples, in
 * key order. A bare setting applies to `*`. Anything that is not a permission
 * setting is ignored, as the v1 plan builder does.
 */
export function permissionMapToTriples(
  permission: unknown,
): PermissionRuleTriple[] {
  if (!isRecord(permission)) return []
  const triples: PermissionRuleTriple[] = []
  for (const [tool, rule] of Object.entries(permission)) {
    if (isPermissionSetting(rule)) {
      triples.push({ permission: tool, pattern: '*', setting: rule })
      continue
    }
    if (!isRecord(rule)) continue
    for (const [pattern, setting] of Object.entries(rule)) {
      if (isPermissionSetting(setting)) {
        triples.push({ permission: tool, pattern, setting })
      }
    }
  }
  return triples
}
