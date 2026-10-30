/**
 * Entry point of the `systematic-search` bin that ships in the plugin bundle.
 * `scripts/build-claude-code-plugin.ts` bundles it into one
 * self-contained file, and the foreign-directory run in
 * `tests/unit/claude-code-search.test.ts` proves that bundle runs under `node`
 * with no `node_modules`.
 *
 * It reads search settings from the two user-level files only (through
 * `loadUserLevelSearchSettings`) and never reads project config, so a
 * repository cannot point search at an endpoint or switch it off. Because it
 * never reads the project file it also cannot print the project-config strip
 * warning that `systematic search` prints; that asymmetry is accepted.
 *
 * Import rule: nothing here may import `config.ts` or `config-schema.ts`.
 * The bundle would then carry the config loader and its UMD jsonc build, which
 * crashes when run from a foreign directory. The bin reaches zod only through
 * `search-user-config.ts`.
 */

import { isMainModule } from './lib/main-module.js'
import { runSearchCli } from './lib/search-cli.js'
import {
  loadUserLevelSearchSettings,
  type UserLevelConfigDirOptions,
} from './lib/search-user-config.js'

interface ClaudeCodeSearchOptions {
  /** Query words and flags, as `systematic search` takes them after the command. */
  readonly argv: readonly string[]
  readonly cwd?: string
  /** Override the config directories. Tests use this; the bin reads the real ones. */
  readonly userLevel?: UserLevelConfigDirOptions
  readonly outputSink?: (message: string) => void
  readonly errorSink?: (message: string) => void
}

export function runClaudeCodeSearch(
  options: ClaudeCodeSearchOptions,
): Promise<number> {
  return runSearchCli({
    argv: options.argv,
    cwd: options.cwd,
    outputSink: options.outputSink,
    errorSink: options.errorSink,
    loadSettings: () => loadUserLevelSearchSettings(options.userLevel),
  })
}

if (isMainModule(import.meta.url)) {
  // `.then` rather than top-level await keeps the entry valid if the bundle is
  // ever emitted as CommonJS.
  runClaudeCodeSearch({ argv: process.argv.slice(2) }).then((status) => {
    process.exitCode = status
  })
}
