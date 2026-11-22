import path from 'node:path'

/**
 * The OpenCode user config directory, resolved as OpenCode v1 and v2 resolve it:
 * `XDG_CONFIG_HOME` when non-empty (used as given), else `<home>/.config`, then
 * `opencode`. This is the default only; call-site overrides still win.
 *
 * Node builtins only: the ce-connect and search bundles inline it.
 */
export function opencodeUserConfigDir(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return path.join(
    env.XDG_CONFIG_HOME || path.join(homeDir, '.config'),
    'opencode',
  )
}
