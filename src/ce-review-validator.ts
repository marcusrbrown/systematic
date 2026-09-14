import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { z } from 'zod'

import { runClaudeCodeValidator } from './claude-code-validator.js'
import { formatReviewArtifactIssuePath } from './lib/review-artifact-path.js'
import { HarnessSchema } from './lib/review-artifact-schema.js'
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
  ScreenInputSchema,
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
  'Usage: node validate-review.mjs screen --reviewer <name> --harness <opencode|pi|claude-code>'

export const CE_REVIEW_SCREEN_STDIN_TTY_MESSAGE =
  'screen reads one raw reviewer return from stdin; interactive input is not supported'

export const CE_REVIEW_SCREEN_STDIN_READ_FAILED_MESSAGE =
  'screen could not read the reviewer return from stdin'

export const CE_REVIEW_SCREEN_STDIN_OVERSIZED_MESSAGE =
  'screen input exceeds the 1 MiB limit'

export const CE_REVIEW_SCREEN_STDIN_INVALID_UTF8_MESSAGE =
  'screen input is not valid UTF-8'

export const CE_REVIEW_SCREEN_STDIN_EMPTY_MESSAGE =
  'screen received empty stdin'

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

export const CE_REVIEW_PREPARE_STDIN_EMPTY_MESSAGE =
  'prepare received empty stdin'

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

export const CE_REVIEW_MERGE_STDIN_EMPTY_MESSAGE = 'merge received empty stdin'

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

export const CE_REVIEW_FINALIZE_STDIN_EMPTY_MESSAGE =
  'finalize received empty stdin'

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
  | {
      readonly ok: true
      readonly reviewer: string
      readonly harness: z.infer<typeof HarnessSchema>
    }
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
  const rawHarness = values.get('--harness')
  if (reviewer === undefined || rawHarness === undefined) return { ok: false }
  const harnessParse = HarnessSchema.safeParse(rawHarness)
  if (!harnessParse.success) return { ok: false }
  const harness = harnessParse.data
  // Validated against the same schema `screenReviewReturn` binds
  // `expected_reviewer` to (`ScreenInputSchema`), so an invalid argv value
  // is rejected here as a usage error rather than reaching
  // `screenReviewReturn` and being recorded as a malformed persona payload.
  if (!ScreenInputSchema.shape.expected_reviewer.safeParse(reviewer).success) {
    return { ok: false }
  }

  return { harness, ok: true, reviewer }
}

/** Bounded, payload-safe rejection message: `<phase> rejected the aggregate
 * envelope: <reason> at <path>`. `reason` is a fixed-vocabulary string from
 * the pipeline and `path` is a safe JSON pointer; never payload content. */
function formatAggregateRejectionMessage(
  rejectedMessage: string,
  rejection: { readonly path: string; readonly reason: string },
): string {
  return `${rejectedMessage}: ${rejection.reason} at ${rejection.path}`
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

  if (text.trim() === '') {
    errorSink(CE_REVIEW_SCREEN_STDIN_EMPTY_MESSAGE)
    return 2
  }

  const result = screenReviewReturn({
    expected_reviewer: flags.reviewer,
    invoking_harness: flags.harness,
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

  if (text.trim() === '') {
    errorSink(CE_REVIEW_PREPARE_STDIN_EMPTY_MESSAGE)
    return 2
  }

  const result = prepareReviewCandidates({ raw_input: text })
  if (!result.ok) {
    errorSink(
      formatAggregateRejectionMessage(
        CE_REVIEW_PREPARE_REJECTED_MESSAGE,
        result.rejection,
      ),
    )
    return 1
  }

  outputSink(JSON.stringify(result.value))
  return 0
}

interface AggregateStdinSubcommandSpec<Input> {
  readonly usage: string
  readonly ttyMessage: string
  readonly readFailedMessage: string
  readonly oversizedMessage: string
  readonly invalidUtf8Message: string
  readonly emptyMessage: string
  readonly rejectedMessage: string
  readonly schema: z.ZodType<Input>
  readonly execute: (input: Input) =>
    | { readonly ok: true; readonly value: unknown }
    | {
        readonly ok: false
        readonly rejection: { readonly path: string; readonly reason: string }
      }
}

/**
 * Shared skeleton for the `merge` and `finalize` subcommands: both read one
 * bounded aggregate JSON envelope from stdin, decode/parse/schema-validate
 * it, hand the validated input to a phase function, and emit its result.
 * `prepare` does not fit this skeleton -- it feeds `prepareReviewCandidates`
 * raw decoded text directly, with no `JSON.parse`/schema step of its own --
 * so it stays a standalone implementation above.
 */
function runAggregateStdinSubcommand<Input>(
  options: CeReviewValidatorOptions,
  outputSink: (message: string) => void,
  errorSink: (message: string) => void,
  spec: AggregateStdinSubcommandSpec<Input>,
): number {
  if (options.argv.slice(1).length > 0) {
    errorSink(spec.usage)
    return 2
  }

  const fd = 0
  const isTTY = options.isTTY ?? process.stdin.isTTY === true
  if (isTTY) {
    errorSink(spec.ttyMessage)
    return 2
  }

  const read = readBoundedStdin(
    fd,
    options.readChunk ?? defaultReadChunk,
    AGGREGATE_STDIN_BYTE_CAP,
  )
  if (read.status === 'read-error') {
    errorSink(spec.readFailedMessage)
    return 2
  }
  if (read.status === 'oversized') {
    errorSink(spec.oversizedMessage)
    return 1
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.buffer)
  } catch {
    errorSink(spec.invalidUtf8Message)
    return 1
  }

  if (text.trim() === '') {
    errorSink(spec.emptyMessage)
    return 2
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    errorSink(spec.rejectedMessage)
    return 1
  }

  const parsed = spec.schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    errorSink(
      issue
        ? formatAggregateRejectionMessage(spec.rejectedMessage, {
            path: formatReviewArtifactIssuePath(issue.path),
            reason: issue.code,
          })
        : spec.rejectedMessage,
    )
    return 1
  }

  const result = spec.execute(parsed.data)
  if (!result.ok) {
    errorSink(
      formatAggregateRejectionMessage(spec.rejectedMessage, result.rejection),
    )
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
  return runAggregateStdinSubcommand(options, outputSink, errorSink, {
    emptyMessage: CE_REVIEW_MERGE_STDIN_EMPTY_MESSAGE,
    execute: (input) =>
      applyReviewAdjudication({
        prepared: input.prepared,
        decisions: input.adjudication.decisions,
      }),
    invalidUtf8Message: CE_REVIEW_MERGE_STDIN_INVALID_UTF8_MESSAGE,
    oversizedMessage: CE_REVIEW_MERGE_STDIN_OVERSIZED_MESSAGE,
    readFailedMessage: CE_REVIEW_MERGE_STDIN_READ_FAILED_MESSAGE,
    rejectedMessage: CE_REVIEW_MERGE_REJECTED_MESSAGE,
    schema: MergeInputSchema,
    ttyMessage: CE_REVIEW_MERGE_STDIN_TTY_MESSAGE,
    usage: CE_REVIEW_MERGE_USAGE,
  })
}

function runFinalizeSubcommand(
  options: CeReviewValidatorOptions,
  outputSink: (message: string) => void,
  errorSink: (message: string) => void,
): number {
  return runAggregateStdinSubcommand(options, outputSink, errorSink, {
    emptyMessage: CE_REVIEW_FINALIZE_STDIN_EMPTY_MESSAGE,
    execute: (input) => finalizeReview(input),
    invalidUtf8Message: CE_REVIEW_FINALIZE_STDIN_INVALID_UTF8_MESSAGE,
    oversizedMessage: CE_REVIEW_FINALIZE_STDIN_OVERSIZED_MESSAGE,
    readFailedMessage: CE_REVIEW_FINALIZE_STDIN_READ_FAILED_MESSAGE,
    rejectedMessage: CE_REVIEW_FINALIZE_REJECTED_MESSAGE,
    schema: FinalizeInputSchema,
    ttyMessage: CE_REVIEW_FINALIZE_STDIN_TTY_MESSAGE,
    usage: CE_REVIEW_FINALIZE_USAGE,
  })
}

let processExceptionBoundaryInstalled = false

interface ActiveInvocation {
  readonly phase: string
  readonly errorSink: (message: string) => void
}

/**
 * The subcommand and error sink currently being dispatched, replaced
 * wholesale at the top of every {@link runCeReviewValidator} call before
 * entering its `try` block. The process-scope exception boundary reads both
 * fields from here at fault time (not at closure-creation time), so a fatal
 * error is always routed through the CURRENT call's injected `errorSink` and
 * names the CURRENT call's phase -- even though the boundary's own listener
 * registration happens only once per process. Without this indirection, the
 * boundary's closure would capture only the first call's `errorSink`
 * forever, silently misrouting later calls' fatal errors (relevant to the
 * unit suite, which calls `runCeReviewValidator` repeatedly with distinct
 * injected sinks in the same process; the real CLI only ever calls it once).
 */
let activeInvocation: ActiveInvocation = {
  errorSink: (message: string) => console.error(message),
  phase: 'unknown',
}

/** Fixed-template fatal message naming the active subcommand. Keeps
 * {@link CE_REVIEW_SCREEN_INTERNAL_ERROR_MESSAGE} exported for backward
 * compatibility, but the text actually emitted always names the phase. */
function formatInternalErrorMessage(phase: string): string {
  return `ce-review-validator: internal error in ${phase}`
}

/**
 * Install process-scope `unhandledRejection`/`uncaughtException` handlers
 * exactly once per process, routed through the same fixed-reason-code
 * boundary as a synchronous throw. Without this, an untrapped async
 * rejection prints a raw stack straight to stderr and defeats the no-echo
 * contract this shim exists to enforce. The listener itself is installed
 * only once, but it always reads {@link activeInvocation} at fault time, so
 * it stays correct across repeated calls.
 */
function installProcessExceptionBoundary(): void {
  if (processExceptionBoundaryInstalled) return
  processExceptionBoundaryInstalled = true

  const handleFatal = (): void => {
    activeInvocation.errorSink(
      formatInternalErrorMessage(activeInvocation.phase),
    )
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

  const subcommand = options.argv[0]
  activeInvocation = { errorSink, phase: subcommand ?? 'unknown' }
  installProcessExceptionBoundary()

  try {
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
    errorSink(formatInternalErrorMessage(activeInvocation.phase))
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
