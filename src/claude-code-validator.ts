import {
  formatReviewArtifactIssuePath,
  isLegacyReviewArtifact,
  readReviewArtifact,
  resolveReviewArtifactPath,
} from './lib/review-artifact-path.js'
import { ReviewArtifactSchema } from './lib/review-artifact-schema.js'

const VALIDATE_REVIEW_ARTIFACT_USAGE =
  'Usage: systematic validate-review-artifact <path> [--allow-outside-artifact-root]'
const REVIEW_ARTIFACT_SCHEMA_RELATIVE_PATH =
  'skills/ce-review/references/review-summary-schema.json'
const ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG = '--allow-outside-artifact-root'

interface ValidatorOptions {
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly outputSink?: (message: string) => void
  readonly errorSink?: (message: string) => void
}

interface ValidateReviewArtifactArguments {
  readonly path: string
  readonly allowOutsideArtifactRoot: boolean
}

function validateReviewArtifactArgument(
  argv: readonly string[],
): ValidateReviewArtifactArguments | undefined {
  const flagIndex = argv.indexOf(ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG)
  const allowOutsideArtifactRoot = flagIndex !== -1
  const positional =
    flagIndex === -1
      ? argv
      : [...argv.slice(0, flagIndex), ...argv.slice(flagIndex + 1)]
  if (positional.length !== 1) return undefined
  const path = positional[0]
  if (path === undefined) return undefined
  return { allowOutsideArtifactRoot, path }
}

export function runClaudeCodeValidator(options: ValidatorOptions): number {
  const outputSink =
    options.outputSink ?? ((message: string) => console.log(message))
  const errorSink =
    options.errorSink ?? ((message: string) => console.error(message))
  const parsedArgs = validateReviewArtifactArgument(options.argv)
  if (parsedArgs === undefined) {
    errorSink(VALIDATE_REVIEW_ARTIFACT_USAGE)
    return 2
  }

  const resolved = resolveReviewArtifactPath(
    parsedArgs.path,
    options.cwd ?? process.cwd(),
    { allowOutsideArtifactRoot: parsedArgs.allowOutsideArtifactRoot },
  )
  if (!resolved.ok) {
    errorSink(resolved.message)
    return 2
  }

  const artifact = readReviewArtifact(resolved.path)
  if (!artifact.ok) {
    errorSink(artifact.message)
    return 2
  }

  if (isLegacyReviewArtifact(artifact.value)) {
    errorSink('Legacy review artifact: no schema_version field')
    return 3
  }

  const result = ReviewArtifactSchema.safeParse(artifact.value)
  if (!result.success) {
    for (const issue of result.error.issues) {
      const issuePath = formatReviewArtifactIssuePath(issue.path)
      // The custom-message exception depends on author-written constants;
      // tests/unit/review-artifact-schema.test.ts enforces that contract.
      const authoredMessage =
        issue.code === 'custom' ? `: ${issue.message}` : ''
      errorSink(`${issuePath} ${issue.code}${authoredMessage}`)
    }
    errorSink(`Schema: ${REVIEW_ARTIFACT_SCHEMA_RELATIVE_PATH}`)
    errorSink(
      `Review artifact validation failed: ${result.error.issues.length} issue(s)`,
    )
    return 1
  }

  outputSink('Review artifact is valid')
  return 0
}

if (import.meta.main) {
  process.exitCode = runClaudeCodeValidator({
    argv: process.argv.slice(2),
  })
}
