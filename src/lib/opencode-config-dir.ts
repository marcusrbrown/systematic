import path from 'node:path'

/**
 * The OpenCode user config directory, resolved the way the host resolves it,
 * except for a value the XDG Base Directory spec calls invalid.
 *
 * OpenCode v1 (`packages/core/src/global.ts`, through `xdg-basedir` 5.1.0) and
 * v2 (`packages/util/src/global-roots.ts`) both compute
 * `join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')`. An empty
 * `XDG_CONFIG_HOME` is falsy and falls back to home, here and in the host.
 *
 * The one difference: the spec says these paths must be absolute and that a
 * relative value is invalid and should be ignored, so a non-absolute value
 * counts as unset here. The host would resolve it against the working
 * directory, which would let a checkout ship `<rel>/opencode/systematic.json`
 * and have it read as the trusted user layer (it anchors `connect.allow_projects`
 * and `connect.pins`). The value is otherwise used as given: not trimmed, not
 * normalized.
 *
 * `homeDir` is injected so tests and the loaders can point at a temp home. This
 * is the user-config *default*: an explicit `userConfigDir`, `opencodeConfigDir`
 * or `configDir` still wins at the call site, and `OPENCODE_CONFIG_DIR` is a
 * separate extra directory that this does not read.
 *
 * Import rule: node builtins only. The `ce-connect` and `systematic-search`
 * bundles inline it through `connect-config.ts` and `search-user-config.ts`.
 */
export function opencodeUserConfigDir(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const xdg = env.XDG_CONFIG_HOME
  return path.join(
    xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir, '.config'),
    'opencode',
  )
}
