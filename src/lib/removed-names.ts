/**
 * Known-removed bundled skill and agent names.
 *
 * Names listed here were present in a past release but have since been removed
 * from the bundled catalog. They are accepted (warn-and-ignore) in
 * `disabled_skills` and `disabled_agents` so that upgrading does not brick
 * configs that disabled them before removal. Genuinely-unknown names (typos,
 * names that never existed) are still rejected by strict validation.
 *
 * These lists were populated as of v3, which removed a batch of bundled
 * skills and agents. Add a name here only when the corresponding skill or
 * agent directory is actually deleted from the repo.
 */

export const REMOVED_BUNDLED_SKILL_NAMES: readonly string[] = [
  'andrew-kane-gem-writer',
  'changelog',
  'claude-permissions-optimizer',
  'dhh-rails-style',
  'dspy-ruby',
  'every-style-editor',
  'feature-video',
  'gemini-imagegen',
  'generate_command',
  'orchestrating-swarms',
  'proof',
  'rclone',
  'setup',
  'test-xcode',
  'todo-create',
  'todo-resolve',
  'todo-triage',
  'writing-systematic-skills',
] as const

export const REMOVED_BUNDLED_AGENT_NAMES: readonly string[] = [
  'ankane-readme-writer',
  'cli-agent-readiness-reviewer',
  'data-integrity-guardian',
  'data-migration-expert',
  'design-implementation-reviewer',
  'design/design-implementation-reviewer',
  'design/figma-design-sync',
  'dhh-rails-reviewer',
  'docs/ankane-readme-writer',
  'figma-design-sync',
  'julik-frontend-races-reviewer',
  'kieran-python-reviewer',
  'kieran-rails-reviewer',
  'lint',
  'performance-oracle',
  'review/cli-agent-readiness-reviewer',
  'review/data-integrity-guardian',
  'review/data-migration-expert',
  'review/dhh-rails-reviewer',
  'review/julik-frontend-races-reviewer',
  'review/kieran-python-reviewer',
  'review/kieran-rails-reviewer',
  'review/performance-oracle',
  'review/schema-drift-detector',
  'review/security-sentinel',
  'schema-drift-detector',
  'security-sentinel',
  'workflow/lint',
] as const

export const REMOVED_BUNDLED_AGENT_CATEGORIES: readonly string[] = [
  'docs',
] as const
