import {
  formatReviewArtifactSuccessMessage,
  formatReviewArtifactValidationFailure,
  isLegacyReviewArtifact,
  parseValidateReviewArtifactArguments,
  REVIEW_ARTIFACT_SCHEMA_RELATIVE_PATH,
  readReviewArtifact,
  resolveReviewArtifactPath,
  VALIDATE_REVIEW_ARTIFACT_USAGE,
} from './lib/review-artifact-path.js'
import { ReviewArtifactSchema } from './lib/review-artifact-schema.js'

interface ValidatorOptions {
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly outputSink?: (message: string) => void
  readonly errorSink?: (message: string) => void
}

export function runClaudeCodeValidator(options: ValidatorOptions): number {
  const outputSink =
    options.outputSink ?? ((message: string) => console.log(message))
  const errorSink =
    options.errorSink ?? ((message: string) => console.error(message))
  const parsedArgs = parseValidateReviewArtifactArguments(options.argv)
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
    for (const line of formatReviewArtifactValidationFailure(
      result.error.issues,
      REVIEW_ARTIFACT_SCHEMA_RELATIVE_PATH,
    )) {
      errorSink(line)
    }
    return 1
  }

  outputSink(
    formatReviewArtifactSuccessMessage(parsedArgs.allowOutsideArtifactRoot),
  )
  return 0
}

if (import.meta.main) {
  process.exitCode = runClaudeCodeValidator({
    argv: process.argv.slice(2),
  })
}
