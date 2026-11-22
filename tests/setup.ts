import { beforeEach } from 'bun:test'
import { resetSkippedProjectConfigNotices } from '../src/lib/config.js'

// Bun test preload (see bunfig.toml `[test].preload`). Runs once before any
// test file. `SYSTEMATIC_PROFILE` selects the active model profile
// (src/lib/config.ts), so an ambient value in the developer's or CI's shell
// would otherwise silently steer config-loading assertions across every
// suite. Clearing it here makes the whole suite hermetic by construction
// -- tests that deliberately want the variable set still set it themselves
// (e.g. `withEnvProfile` in tests/unit/config.test.ts) and restore it
// afterward.
delete process.env.SYSTEMATIC_PROFILE

// `XDG_CONFIG_HOME` decides where the user-level OpenCode config directory is
// (src/lib/opencode-config-dir.ts), and many suites point `homeDir` at a temp
// dir and expect `<home>/.config/opencode`. A real value in the developer's
// shell would redirect those reads to their live config, so it is cleared for
// the whole suite. A test that wants it set uses `withXdgConfigHome`
// (tests/helpers/xdg-env.ts) or sets and restores it itself.
delete process.env.XDG_CONFIG_HOME

// A skipped project config warns once per file for the process, so a warning
// asserted in one test would otherwise be swallowed by an earlier test that
// skipped the same file. Forgetting the notices before every test keeps each
// test independent of the order the suite runs in.
beforeEach(() => {
  resetSkippedProjectConfigNotices()
})
