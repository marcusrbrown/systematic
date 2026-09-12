#!/usr/bin/env bun
/**
 * Generate the committed code-review JSON Schemas from the Zod source of truth.
 *
 * Targets:
 *   - skills/ce-review/references/review-summary-schema.json (aggregate artifact)
 *   - skills/ce-review/references/findings-schema.json (raw return + parent record)
 *
 * Usage:
 *   bun scripts/generate-review-artifact-schema.ts         # Write every target
 *   bun scripts/generate-review-artifact-schema.ts --check # Exit 1 on any drift
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  ParentFindingSchema,
  ParentRecordSchema,
  ReviewArtifactSchema,
  SubAgentFindingSchema,
  SubAgentReturnSchema,
} from '../src/lib/review-artifact-schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

export const REVIEW_SCHEMA_RELATIVE_PATH =
  'skills/ce-review/references/review-summary-schema.json'
export const FINDINGS_SCHEMA_RELATIVE_PATH =
  'skills/ce-review/references/findings-schema.json'

const DRAFT_7_URI = 'http://json-schema.org/draft-07/schema#'
const FINDINGS_SCHEMA_TITLE = 'Code Review Findings'
const FINDINGS_SCHEMA_DESCRIPTION =
  'Structured output schemas for code review sub-agent returns and parent-persisted records'

/**
 * Keep JSON Schema generation options in one place so generation and drift
 * checking cannot silently diverge.
 */
function getGenerationOptions(): { target: 'draft-7' } {
  return { target: 'draft-7' }
}

/**
 * Run Biome's formatter over JSON content via stdin, matching the repository's
 * other generated schema artifacts.
 */
function formatJsonWithBiome(content: string, stubFilename: string): string {
  const result = spawnSync(
    'bun',
    ['biome', 'format', `--stdin-file-path=${stubFilename}`],
    { input: content, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(
      `biome format failed (exit ${result.status}): ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`
}

/**
 * Generate the formatted JSON Schema content for the aggregate artifact.
 */
export function generateSchemaContent(): string {
  const result = z.toJSONSchema(ReviewArtifactSchema, getGenerationOptions())
  const { '~standard': _standard, ...clean } = result as Record<
    string,
    unknown
  > &
    typeof result
  const formatted = formatJsonWithBiome(
    `${JSON.stringify(clean, null, 2)}\n`,
    'review-summary-schema.json',
  )
  return ensureTrailingNewline(formatted)
}

/**
 * Convert a Zod schema into an inline Draft-7 definition object, dropping the
 * per-schema document keywords (`$schema`, `~standard`) that only belong at the
 * document root.
 */
function toDefinition(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema, getGenerationOptions()) as Record<
    string,
    unknown
  >
  const { '~standard': _standard, $schema: _schema, ...definition } = result
  return definition
}

/** Point a generated return/record's findings array at a named definition. */
function setFindingsItemsRef(
  definition: Record<string, unknown>,
  ref: string,
): void {
  const properties = definition.properties as
    | Record<string, unknown>
    | undefined
  const findings = properties?.findings as Record<string, unknown> | undefined
  if (!findings) {
    throw new Error('generated schema is missing its findings property')
  }
  findings.items = { $ref: ref }
}

/**
 * Generate the formatted findings JSON Schema (raw return + parent record) from
 * the canonical Zod schemas.
 *
 * The published document keeps its envelope (title, description, draft, and a
 * top-level `$ref` to the parent record) and hoists both finding shapes into
 * named `subAgentFinding` / `parentFinding` definitions referenced by the
 * `subAgentReturn` / `parentRecord` definitions.
 */
export function generateFindingsSchemaContent(): string {
  const subAgentFinding = toDefinition(SubAgentFindingSchema)
  const parentFinding = toDefinition(ParentFindingSchema)
  const subAgentReturn = toDefinition(SubAgentReturnSchema)
  const parentRecord = toDefinition(ParentRecordSchema)

  setFindingsItemsRef(subAgentReturn, '#/definitions/subAgentFinding')
  setFindingsItemsRef(parentRecord, '#/definitions/parentFinding')

  const document = {
    $schema: DRAFT_7_URI,
    title: FINDINGS_SCHEMA_TITLE,
    description: FINDINGS_SCHEMA_DESCRIPTION,
    $ref: '#/definitions/parentRecord',
    definitions: {
      subAgentFinding,
      parentFinding,
      subAgentReturn,
      parentRecord,
    },
  }

  const formatted = formatJsonWithBiome(
    `${JSON.stringify(document, null, 2)}\n`,
    'findings-schema.json',
  )
  return ensureTrailingNewline(formatted)
}

export interface ReviewSchemaTarget {
  relativePath: string
  generate: () => string
}

/** The committed review schemas this generator owns, in write order. */
export const REVIEW_SCHEMA_TARGETS: readonly ReviewSchemaTarget[] = [
  {
    relativePath: REVIEW_SCHEMA_RELATIVE_PATH,
    generate: generateSchemaContent,
  },
  {
    relativePath: FINDINGS_SCHEMA_RELATIVE_PATH,
    generate: generateFindingsSchemaContent,
  },
]

export function normalizeForCompare(content: string): string {
  return content.replace(/\r\n?/g, '\n')
}

/** Write every committed schema and return the absolute paths written. */
export function writeSchema(rootDir = PROJECT_ROOT): string[] {
  return REVIEW_SCHEMA_TARGETS.map((target) => {
    const targetPath = path.join(rootDir, target.relativePath)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, target.generate(), 'utf8')
    return targetPath
  })
}

/**
 * Compare every generated schema with its committed artifact on disk.
 *
 * The committed files are read at comparison time rather than imported,
 * avoiding ESM module-cache staleness after a write. The first drifted or
 * missing target stops the check and is named in the message.
 */
export function checkSchema(rootDir = PROJECT_ROOT): {
  ok: boolean
  message: string
} {
  for (const target of REVIEW_SCHEMA_TARGETS) {
    const targetPath = path.join(rootDir, target.relativePath)
    const displayPath = target.relativePath

    if (!fs.existsSync(targetPath)) {
      return {
        ok: false,
        message: `${displayPath} does not exist. Run \`bun run review-schema:generate\` to create it.`,
      }
    }

    let existing: string
    try {
      existing = fs.readFileSync(targetPath, 'utf8')
    } catch (error) {
      return {
        ok: false,
        message: `${displayPath} could not be read: ${(error as Error).message}`,
      }
    }

    const expected = target.generate()
    if (normalizeForCompare(existing) !== normalizeForCompare(expected)) {
      return {
        ok: false,
        message: `${displayPath} is out of date. Run \`bun run review-schema:generate\` to update it.`,
      }
    }
  }

  const displayPaths = REVIEW_SCHEMA_TARGETS.map(
    (target) => target.relativePath,
  ).join(', ')
  return {
    ok: true,
    message: `${displayPaths} are up to date.`,
  }
}

function main(): void {
  if (process.argv.slice(2).includes('--check')) {
    const result = checkSchema()
    if (!result.ok) {
      console.error(`Error: ${result.message}`)
      process.exitCode = 1
      return
    }
    console.log(result.message)
    return
  }

  for (const targetPath of writeSchema()) {
    console.log(`Generated ${path.relative(PROJECT_ROOT, targetPath)}`)
  }
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
  }
}
