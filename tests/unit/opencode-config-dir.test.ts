import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { opencodeUserConfigDir } from '../../src/lib/opencode-config-dir.js'

// The host rule (OpenCode v1 `packages/core/src/global.ts` via `xdg-basedir`
// 5.1.0, v2 `packages/util/src/global-roots.ts`):
//   config = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode')
// An empty value is falsy and falls back to home. The one deliberate
// difference: the XDG Base Directory spec calls a non-absolute value invalid
// and says to ignore it, and the host would resolve it against the working
// directory, so a checkout could plant a trusted user config. Here a
// non-absolute value counts as unset.
describe('opencodeUserConfigDir', () => {
  const home = path.join(path.sep, 'home', 'someone')

  test('uses an absolute XDG_CONFIG_HOME', () => {
    const xdg = path.join(path.sep, 'custom', 'xdg')
    expect(opencodeUserConfigDir(home, { XDG_CONFIG_HOME: xdg })).toBe(
      path.join(xdg, 'opencode'),
    )
  })

  test('falls back to <home>/.config/opencode when XDG_CONFIG_HOME is unset', () => {
    expect(opencodeUserConfigDir(home, {})).toBe(
      path.join(home, '.config', 'opencode'),
    )
    expect(opencodeUserConfigDir(home, { XDG_CONFIG_HOME: undefined })).toBe(
      path.join(home, '.config', 'opencode'),
    )
  })

  test('treats an empty XDG_CONFIG_HOME as unset, as the host does', () => {
    expect(opencodeUserConfigDir(home, { XDG_CONFIG_HOME: '' })).toBe(
      path.join(home, '.config', 'opencode'),
    )
  })

  test('ignores a relative XDG_CONFIG_HOME, which the XDG spec calls invalid', () => {
    for (const relative of ['rel/cfg', 'rel', '.', './cfg', '../cfg', ' ']) {
      expect(opencodeUserConfigDir(home, { XDG_CONFIG_HOME: relative })).toBe(
        path.join(home, '.config', 'opencode'),
      )
    }
  })

  test('reads process.env when no environment is injected', () => {
    const previous = process.env.XDG_CONFIG_HOME
    const xdg = path.join(path.sep, 'from', 'process-env')
    process.env.XDG_CONFIG_HOME = xdg
    try {
      expect(opencodeUserConfigDir(home)).toBe(path.join(xdg, 'opencode'))
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
    }
  })
})
