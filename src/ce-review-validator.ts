import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runClaudeCodeValidator } from './claude-code-validator.js'
import {
  applyReviewAdjudication,
  finalizeReview,
  prepareReviewCandidates,
  screenReviewReturn,
} from './lib/review-pipeline.js'
import {
  AGGREGATE_STDIN_BYTE_CAP,
  FinalizeInputSchema,
  MergeInputSchema,
} from './lib/review-pipeline-contract.js'
import {
  defaultReadChunk,
  type ReadChunk,
  readBoundedStdin,
  runReviewReturnValidator,
} from './lib/review-return-validator.js'

/**
 * Entry point for the generated, self-contained `ce:review` skill-local
 * validator shim (`skills/ce-review/scripts/validate-review.mjs`).
 *
 * This is a thin packaging compatibility shim, not a public extension point:
 * it dispatches exactly six subcommands and owns no validation logic
 * beyond `screen`'s flag parsing and stdin plumbing.
 * - `return`   -> the bounded raw persona-return validator (stdin).
 * - `artifact` -> the existing aggregate review-artifact validator.
 * - `screen`   -> executable reviewer-return admission (`screenReviewReturn`),
 *                 reusing the same bounded stdin reader as `return`.
 * - `prepare`  -> executable candidate preparation (`prepareReviewCandidates`),
 *                 reusing the same bounded stdin reader with the larger
 *                 aggregate byte cap.
 * - `merge`    -> executable adjudication application
 *                 (`applyReviewAdjudication`), reusing the same bounded
 *                 stdin reader with the aggregate byte cap.
 * - `finalize` -> executable finalize-envelope synthesis (`finalizeReview`),
 *                 reusing the same bounded stdin reader with the aggregate
 *                 byte cap.
 *
 * It exists because shipped skill layouts cannot all rely on the npm CLI or
 * `dist/`; every harness invokes the committed bundle through `SKILL_DIR`.
 */

export const CE_REVIEW_VALIDATOR_USAGE =
  'Usage: node validate-review.mjs <return|artifact|screen|prepare|merge|finalize> [...]'

export const CE_REVIEW_SCREEN_USAGE =
  'Usage: node validate-review.mjs screen --reviewer <name> --harness <name>'

export const CE_REVIEW_SCREEN_STDIN_TTY_MESSAGE =
  'screen reads one raw reviewer return from stdin; interactive input is not supported'

export const CE_REVIEW_SCREEN_STDIN_READ_FAILED_MESSAGE =
  'screen could not read the reviewer return from stdin'

export const CE_REVIEW_SCREEN_STDIN_OVERSIZED_MESSAGE =
  'screen input exceeds the 1 MiB limit'

export const CE_REVIEW_SCREEN_STDIN_INVALID_UTF8_MESSAGE =
  'screen input is not valid UTF-8'

export const CE_REVIEW_SCREEN_REJECTED_MESSAGE =
  'screen rejected the reviewer return'

export const CE_REVIEW_SCREEN_INTERNAL_ERROR_MESSAGE =
  'ce-review-validator: internal error'

export const CE_REVIEW_PREPARE_USAGE = 'Usage: node validate-review.mjs prepare'

export const CE_REVIEW_PREPARE_STDIN_TTY_MESSAGE =
  'prepare reads one aggregate JSON envelope from stdin; interactive input is not supported'

export const CE_REVIEW_PREPARE_STDIN_READ_FAILED_MESSAGE =
  'prepare could not read the aggregate envelope from stdin'

export const CE_REVIEW_PREPARE_STDIN_OVERSIZED_MESSAGE =
  'prepare input exceeds the aggregate byte cap'

export const CE_REVIEW_PREPARE_STDIN_INVALID_UTF8_MESSAGE =
  'prepare input is not valid UTF-8'

export const CE_REVIEW_PREPARE_REJECTED_MESSAGE =
  'prepare rejected the aggregate envelope'

export const CE_REVIEW_MERGE_USAGE = 'Usage: node validate-review.mjs merge'

export const CE_REVIEW_MERGE_STDIN_TTY_MESSAGE =
  'merge reads one aggregate JSON envelope from stdin; interactive input is not supported'

export const CE_REVIEW_MERGE_STDIN_READ_FAILED_MESSAGE =
  'merge could not read the aggregate envelope from stdin'

export const CE_REVIEW_MERGE_STDIN_OVERSIZED_MESSAGE =
  'merge input exceeds the aggregate byte cap'

export const CE_REVIEW_MERGE_STDIN_INVALID_UTF8_MESSAGE =
  'merge input is not valid UTF-8'

export const CE_REVIEW_MERGE_REJECTED_MESSAGE =
  'merge rejected the aggregate envelope'

export const CE_REVIEW_FINALIZE_USAGE =
  'Usage: node validate-review.mjs finalize'

export const CE_REVIEW_FINALIZE_STDIN_TTY_MESSAGE =
  'finalize reads one aggregate JSON envelope from stdin; interactive input is not supported'

export const CE_REVIEW_FINALIZE_STDIN_READ_FAILED_MESSAGE =
  'finalize could not read the aggregate envelope from stdin'

export const CE_REVIEW_FINALIZE_STDIN_OVERSIZED_MESSAGE =
  'finalize input exceeds the aggregate byte cap'

export const CE_REVIEW_FINALIZE_STDIN_INVALID_UTF8_MESSAGE =
  'finalize input is not valid UTF-8'

export const CE_REVIEW_FINALIZE_REJECTED_MESSAGE =
  'finalize rejected the aggregate envelope'

export interface CeReviewValidatorOptions {
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly isTTY?: boolean
  readonly readChunk?: ReadChunk
  readonly outputSink?: (message: string) => void
  readonly errorSink?: (message: string) => void
}

const SCREEN_FLAGS = ['--reviewer', '--harness'] as const
type ScreenFlag = (typeof SCREEN_FLAGS)[number]

function isScreenFlag(token: string): token is ScreenFlag {
  return (SCREEN_FLAGS as readonly string[]).includes(token)
}

type ScreenFlagParse =
  | { readonly ok: true; readonly reviewer: string; readonly harness: string }
  | { readonly ok: false }

/**
 * Parse `screen`'s two required flags. Rejects duplicate flags, missing
 * flags, unknown flags, a flag consumed as another flag's value, and stray
 * positional arguments -- returning only a boolean-shaped result so the
 * caller emits one fixed usage message rather than echoing argv back.
 */
function parseScreenFlags(argv: readonly string[]): ScreenFlagParse {
  const values = new Map<ScreenFlag, string>()
  let index = 0

  while (index < argv.length) {
    const token = argv[index]
    if (token === undefined) break
    if (!isScreenFlag(token)) return { ok: false }
    if (values.has(token)) return { ok: false }

    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) return { ok: false }

    values.set(token, value)
    index += 2
  }

  const reviewer = values.get('--reviewer')
  const harness = values.get('--harness')
  if (reviewer === undefined || harness === undefined) return { ok: false }

  return { harness, ok: true, reviewer }
}

function runScreenSubcommand(
  options: CeReviewValidatorOptions,
  outputSink: (message: string) => void,
  errorSink: (message: string) => void,
): number {
  const flags = parseScreenFlags(options.argv.slice(1))
  if (!flags.ok) {
    errorSink(CE_REVIEW_SCREEN_USAGE)
    return 2
  }

  const fd = 0
  const isTTY = options.isTTY ?? process.stdin.isTTY === true
  if (isTTY) {
    errorSink(CE_REVIEW_SCREEN_STDIN_TTY_MESSAGE)
    return 2
  }

  const read = readBoundedStdin(fd, options.readChunk ?? defaultReadChunk)
  if (read.status === 'read-error') {
    errorSink(CE_REVIEW_SCREEN_STDIN_READ_FAILED_MESSAGE)
    return 2
  }
  if (read.status === 'oversized') {
    errorSink(CE_REVIEW_SCREEN_STDIN_OVERSIZED_MESSAGE)
    return 1
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.buffer)
  } catch {
    errorSink(CE_REVIEW_SCREEN_STDIN_INVALID_UTF8_MESSAGE)
    return 1
  }

  const result = screenReviewReturn({
    expected_reviewer: flags.reviewer,
    raw_return: text,
  })

  if (result.dispatch_outcome === 'malformed') {
    errorSink(
      result.rejected_summary?.reason ?? CE_REVIEW_SCREEN_REJECTED_MESSAGE,
    )
    return 1
  }

  outputSink(JSON.stringify(result))
  return 0
}

function runPrepareSubcommand(
  options: CeReviewValidatorOptions,
  outputSink: (message: string) => void,
  errorSink: (message: string) => void,
): number {
  if (options.argv.slice(1).length > 0) {
    errorSink(CE_REVIEW_PREPARE_USAGE)
    return 2
  }

  const fd = 0
  const isTTY = options.isTTY ?? process.stdin.isTTY === true
  if (isTTY) {
    errorSink(CE_REVIEW_PREPARE_STDIN_TTY_MESSAGE)
    return 2
  }

  const read = readBoundedStdin(
    fd,
    options.readChunk ?? defaultReadChunk,
    AGGREGATE_STDIN_BYTE_CAP,
  )
  if (read.status === 'read-error') {
    errorSink(CE_REVIEW_PREPARE_STDIN_READ_FAILED_MESSAGE)
    return 2
  }
  if (read.status === 'oversized') {
    errorSink(CE_REVIEW_PREPARE_STDIN_OVERSIZED_MESSAGE)
    return 1
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.buffer)
  } catch {
    errorSink(CE_REVIEW_PREPARE_STDIN_INVALID_UTF8_MESSAGE)
    return 1
  }

  const result = prepareReviewCandidates({ raw_input: text })
  if (!result.ok) {
    errorSink(CE_REVIEW_PREPARE_REJECTED_MESSAGE)
    return 1
  }

  outputSink(JSON.stringify(result.value))
  return 0
}

function runMergeSubcommand(
  options: CeReviewValidatorOptions,
  outputSink: (message: string) => void,
  errorSink: (message: string) => void,
): number {
  if (options.argv.slice(1).length > 0) {
    errorSink(CE_REVIEW_MERGE_USAGE)
    return 2
  }

  const fd = 0
  const isTTY = options.isTTY ?? process.stdin.isTTY === true
  if (isTTY) {
    errorSink(CE_REVIEW_MERGE_STDIN_TTY_MESSAGE)
    return 2
  }

  const read = readBoundedStdin(
    fd,
    options.readChunk ?? defaultReadChunk,
    AGGREGATE_STDIN_BYTE_CAP,
  )
  if (read.status === 'read-error') {
    errorSink(CE_REVIEW_MERGE_STDIN_READ_FAILED_MESSAGE)
    return 2
  }
  if (read.status === 'oversized') {
    errorSink(CE_REVIEW_MERGE_STDIN_OVERSIZED_MESSAGE)
    return 1
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.buffer)
  } catch {
    errorSink(CE_REVIEW_MERGE_STDIN_INVALID_UTF8_MESSAGE)
    return 1
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    errorSink(CE_REVIEW_MERGE_REJECTED_MESSAGE)
    return 1
  }

  const parsed = MergeInputSchema.safeParse(value)
  if (!parsed.success) {
    errorSink(CE_REVIEW_MERGE_REJECTED_MESSAGE)
    return 1
  }

  const result = applyReviewAdjudication({
    prepared: parsed.data.prepared,
    decisions: parsed.data.adjudication.decisions,
  })
  if (!result.ok) {
    errorSink(CE_REVIEW_MERGE_REJECTED_MESSAGE)
    return 1
  }

  outputSink(JSON.stringify(result.value))
  return 0
}

function runFinalizeSubcommand(
  options: CeReviewValidatorOptions,
  outputSink: (message: string) => void,
  errorSink: (message: string) => void,
): number {
  if (options.argv.slice(1).length > 0) {
    errorSink(CE_REVIEW_FINALIZE_USAGE)
    return 2
  }

  const fd = 0
  const isTTY = options.isTTY ?? process.stdin.isTTY === true
  if (isTTY) {
    errorSink(CE_REVIEW_FINALIZE_STDIN_TTY_MESSAGE)
    return 2
  }

  const read = readBoundedStdin(
    fd,
    options.readChunk ?? defaultReadChunk,
    AGGREGATE_STDIN_BYTE_CAP,
  )
  if (read.status === 'read-error') {
    errorSink(CE_REVIEW_FINALIZE_STDIN_READ_FAILED_MESSAGE)
    return 2
  }
  if (read.status === 'oversized') {
    errorSink(CE_REVIEW_FINALIZE_STDIN_OVERSIZED_MESSAGE)
    return 1
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.buffer)
  } catch {
    errorSink(CE_REVIEW_FINALIZE_STDIN_INVALID_UTF8_MESSAGE)
    return 1
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    errorSink(CE_REVIEW_FINALIZE_REJECTED_MESSAGE)
    return 1
  }

  const parsed = FinalizeInputSchema.safeParse(value)
  if (!parsed.success) {
    errorSink(CE_REVIEW_FINALIZE_REJECTED_MESSAGE)
    return 1
  }

  const result = finalizeReview(parsed.data)
  if (!result.ok) {
    errorSink(CE_REVIEW_FINALIZE_REJECTED_MESSAGE)
    return 1
  }

  outputSink(JSON.stringify(result.value))
  return 0
}

let processExceptionBoundaryInstalled = false

/**
 * Install process-scope `unhandledRejection`/`uncaughtException` handlers
 * exactly once per process, routed through the same fixed-reason-code
 * boundary as a synchronous throw. Without this, an untrapped async
 * rejection prints a raw stack straight to stderr and defeats the no-echo
 * contract this shim exists to enforce.
 */
function installProcessExceptionBoundary(
  errorSink: (message: string) => void,
): void {
  if (processExceptionBoundaryInstalled) return
  processExceptionBoundaryInstalled = true

  const handleFatal = (): void => {
    errorSink(CE_REVIEW_SCREEN_INTERNAL_ERROR_MESSAGE)
    process.exitCode = 1
  }
  process.on('unhandledRejection', handleFatal)
  process.on('uncaughtException', handleFatal)
}

export function runCeReviewValidator(
  options: CeReviewValidatorOptions,
): number {
  const outputSink =
    options.outputSink ?? ((message: string) => console.log(message))
  const errorSink =
    options.errorSink ?? ((message: string) => console.error(message))

  installProcessExceptionBoundary(errorSink)

  try {
    const subcommand = options.argv[0]

    if (subcommand === 'return') {
      return runReviewReturnValidator({
        argv: [
          'systematic',
          'validate-review-return',
          ...options.argv.slice(1),
        ],
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

    if (subcommand === 'screen') {
      return runScreenSubcommand(options, outputSink, errorSink)
    }

    if (subcommand === 'prepare') {
      return runPrepareSubcommand(options, outputSink, errorSink)
    }

    if (subcommand === 'merge') {
      return runMergeSubcommand(options, outputSink, errorSink)
    }

    if (subcommand === 'finalize') {
      return runFinalizeSubcommand(options, outputSink, errorSink)
    }

    errorSink(CE_REVIEW_VALIDATOR_USAGE)
    return 2
  } catch {
    errorSink(CE_REVIEW_SCREEN_INTERNAL_ERROR_MESSAGE)
    return 1
  }
}

/** Resolve a path to its real location without throwing on missing input. */
function resolveRealPath(candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined
  try {
    return fs.realpathSync(candidate)
  } catch {
    return undefined
  }
}

// Explicit direct-execution guard, portable across Bun and Node and insensitive
// to the path spelling used to reach this file (for example macOS `/var` ->
// `/private/var` symlinks). Fail-closed: when either side is missing or
// unresolvable the module does not self-execute, so `import()` stays
// side-effect free for tests and tooling without depending on the Bun-specific
// `import.meta.main`.
const entryPath = resolveRealPath(process.argv[1])
const modulePath = resolveRealPath(fileURLToPath(import.meta.url))
const isMainModule =
  entryPath !== undefined &&
  modulePath !== undefined &&
  entryPath === modulePath

if (isMainModule) {
  process.exitCode = runCeReviewValidator({ argv: process.argv.slice(2) })
}
