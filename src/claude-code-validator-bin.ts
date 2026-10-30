/**
 * Entry point of the `systematic-validate-review-artifact` bin that ships in
 * the plugin bundle. `scripts/build-claude-code-plugin.ts` bundles this
 * file, not `claude-code-validator.ts`.
 *
 * The entry guard lives here and not in `claude-code-validator.ts` on purpose.
 * `ce-review-validator.ts` imports `runClaudeCodeValidator` from that module
 * and is bundled into the committed `validate-review.mjs`. In a bundle every
 * module shares one `import.meta.url`, so a realpath guard inside
 * `claude-code-validator.ts` would fire in that bundle as well and run the
 * validator a second time next to `ce-review-validator.ts`'s own entry. The
 * old `import.meta.main` check avoided this only because Bun's bundler folds it
 * to false in every module but the entry. Keeping the guard in a file nothing
 * imports restores that property without relying on a Bun-only global, which
 * Node gained only in 24.2.
 */

import { runClaudeCodeValidator } from './claude-code-validator.js'
import { isMainModule } from './lib/main-module.js'

if (isMainModule(import.meta.url)) {
  process.exitCode = runClaudeCodeValidator({
    argv: process.argv.slice(2),
  })
}
