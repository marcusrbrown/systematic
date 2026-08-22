#!/usr/bin/env bun
/**
 * Generate the JSON Schema for the persisted code-review artifact from the
 * Zod source of truth.
 *
 * Usage:
 *   bun scripts/generate-review-artifact-schema.ts         # Write the artifact
 *   bun scripts/generate-review-artifact-schema.ts --check # Exit 1 on drift
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { ReviewArtifactSchema } from '../src/lib/review-artifact-schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

export const REVIEW_SCHEMA_RELATIVE_PATH =
  'skills/ce-review/references/review-summary-schema.json'

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
function formatJsonWithBiome(content: string): string {
  const result = spawnSync(
    'bun',
    ['biome', 'format', '--stdin-file-path=review-summary-schema.json'],
    { input: content, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(
      `biome format failed (exit ${result.status}): ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout
}

/**
 * Generate the formatted JSON Schema content from the Unit 1 Zod schema.
 */
export function generateSchemaContent(): string {
  const result = z.toJSONSchema(ReviewArtifactSchema, getGenerationOptions())
  const { '~standard': _standard, ...clean } = result as Record<string, unknown>
  return formatJsonWithBiome(`${JSON.stringify(clean, null, 2)}\n`)
}

export function normalizeForCompare(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\s+$/, '')
}

function getSchemaPath(rootDir: string): string {
  return path.join(rootDir, REVIEW_SCHEMA_RELATIVE_PATH)
}

/** Write the generated schema and return its absolute path. */
export function writeSchema(rootDir = PROJECT_ROOT): string {
  const targetPath = getSchemaPath(rootDir)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, generateSchemaContent(), 'utf8')
  return targetPath
}

/**
 * Compare the generated schema with the committed artifact on disk.
 *
 * The committed file is read at comparison time rather than imported, avoiding
 * ESM module-cache staleness after a write.
 */
export function checkSchema(rootDir = PROJECT_ROOT): {
  ok: boolean
  message: string
} {
  const targetPath = getSchemaPath(rootDir)
  const displayPath = REVIEW_SCHEMA_RELATIVE_PATH

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

  const expected = generateSchemaContent()
  if (normalizeForCompare(existing) !== normalizeForCompare(expected)) {
    return {
      ok: false,
      message: `${displayPath} is out of date. Run \`bun run review-schema:generate\` to update it.`,
    }
  }

  return { ok: true, message: `${displayPath} is up to date.` }
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

  const targetPath = writeSchema()
  console.log(`Generated ${path.relative(PROJECT_ROOT, targetPath)}`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
  }
}
