/**
 * The list of top-level and per-overlay field paths a project-trust config
 * source can never set, expressed as dotted paths with `*` standing in for
 * any overlay key (e.g. `agents.*.model`).
 *
 * Extracted into its own dependency-free module so `src/lib/capability-snapshot.ts`
 * -- which is deliberately import-free so it never pulls in `jsonc-parser`
 * or the rest of `config.ts`'s transitive dependency graph -- can share the
 * exact same list `src/lib/config.ts` enforces at load time, instead of
 * maintaining a hand-duplicated copy that can silently drift out of sync.
 * A stale duplicate here once made every `systematic capabilities`
 * invocation fail with a cause-less "Capabilities diagnostic unavailable"
 * (see `SourceAwareConfigResult.activeProfileSourcePath`'s doc comment in
 * `config.ts` for the incident this module exists to prevent from
 * recurring).
 *
 * This module must import nothing, ever -- that constraint is the entire
 * reason it exists as a separate file rather than living directly in
 * `config.ts`.
 */
export const CONFIG_PROTECTED_FIELD_PATHS = [
  'workflow_guard',
  'profiles',
  'allow_project_profiles',
  'agents.*.model',
  'agents.*.permission',
  'agents.*.skills',
  'agents.*.variant',
  'agents.*.opencode',
  'agents.*.pi',
  'categories.*.model',
  'categories.*.permission',
  'categories.*.skills',
  'categories.*.variant',
  'categories.*.opencode',
  'categories.*.pi',
] as const

export type ConfigProtectedFieldPath =
  (typeof CONFIG_PROTECTED_FIELD_PATHS)[number]
