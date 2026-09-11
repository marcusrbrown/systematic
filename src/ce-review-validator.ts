import { fileURLToPath } from 'node:url'
import { runClaudeCodeValidator } from './claude-code-validator.js'
import {
  type ReadChunk,
  runReviewReturnValidator,
} from './lib/review-return-validator.js'

/**
 * Entry point for the generated, self-contained `ce:review` skill-local
 * validator shim (`skills/ce-review/scripts/validate-review.mjs`).
 *
 * This is a thin packaging compatibility shim, not a public extension point:
 * it dispatches exactly two subcommands and owns no validation logic itself.
 * - `return`   -> the bounded raw persona-return validator (stdin).
 * - `artifact` -> the existing aggregate review-artifact validator.
 *
 * It exists because shipped skill layouts cannot all rely on the npm CLI or
 * `dist/`; every harness invokes the committed bundle through `SKILL_DIR`.
 */

export const CE_REVIEW_VALIDATOR_USAGE =
  'Usage: node validate-review.mjs <return|artifact> [...]'

export interface CeReviewValidatorOptions {
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly isTTY?: boolean
  readonly readChunk?: ReadChunk
  readonly outputSink?: (message: string) => void
  readonly errorSink?: (message: string) => void
}

export function runCeReviewValidator(
  options: CeReviewValidatorOptions,
): number {
  const outputSink =
    options.outputSink ?? ((message: string) => console.log(message))
  const errorSink =
    options.errorSink ?? ((message: string) => console.error(message))

  const subcommand = options.argv[0]

  if (subcommand === 'return') {
    return runReviewReturnValidator({
      argv: ['systematic', 'validate-review-return', ...options.argv.slice(1)],
      isTTY: options.isTTY,
      readChunk: options.readChunk,
      outputSink,
      errorSink,
    })
  }

  if (subcommand === 'artifact') {
    return runClaudeCodeValidator({
      argv: options.argv.slice(1),
      cwd: options.cwd,
      outputSink,
      errorSink,
    })
  }

  errorSink(CE_REVIEW_VALIDATOR_USAGE)
  return 2
}

// Explicit direct-execution guard, portable across Bun and Node: only run when
// this file is the process entry point. This also keeps `import()` of the
// bundle side-effect free for tests and tooling, without depending on the
// Bun-specific `import.meta.main`.
const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]

if (isMainModule) {
  process.exitCode = runCeReviewValidator({ argv: process.argv.slice(2) })
}
