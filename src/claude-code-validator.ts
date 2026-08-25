import {
  formatReviewArtifactIssuePath,
  isLegacyReviewArtifact,
  readReviewArtifact,
  resolveReviewArtifactPath,
} from './lib/review-artifact-path.js'
import { ReviewArtifactSchema } from './lib/review-artifact-schema.js'

const VALIDATE_REVIEW_ARTIFACT_USAGE =
  'Usage: systematic validate-review-artifact <path>'
const REVIEW_ARTIFACT_SCHEMA_RELATIVE_PATH =
  'skills/ce-review/references/review-summary-schema.json'

interface ValidatorOptions {
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly outputSink?: (message: string) => void
  readonly errorSink?: (message: string) => void
}

function validateReviewArtifactArgument(
  argv: readonly string[],
): string | undefined {
  if (argv.length !== 1) return undefined
  return argv[0]
}

export function runClaudeCodeValidator(options: ValidatorOptions): number {
  const outputSink =
    options.outputSink ?? ((message: string) => console.log(message))
  const errorSink =
    options.errorSink ?? ((message: string) => console.error(message))
  const input = validateReviewArtifactArgument(options.argv)
  if (input === undefined) {
    errorSink(VALIDATE_REVIEW_ARTIFACT_USAGE)
    return 2
  }

  const resolved = resolveReviewArtifactPath(
    input,
    options.cwd ?? process.cwd(),
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
