/**
 * Known-removed bundled skill and agent names.
 *
 * Names listed here were present in a past release but have since been removed
 * from the bundled catalog. They are accepted (warn-and-ignore) in
 * `disabled_skills` and `disabled_agents` so that upgrading does not brick
 * configs that disabled them before removal. Genuinely-unknown names (typos,
 * names that never existed) are still rejected by strict validation.
 *
 * This list is empty until v3 populates it with the first removed names.
 * Add a name here only when the corresponding skill or agent directory is
 * actually deleted from the repo.
 */

export const REMOVED_BUNDLED_SKILL_NAMES: readonly string[] = [] as const

export const REMOVED_BUNDLED_AGENT_NAMES: readonly string[] = [] as const
