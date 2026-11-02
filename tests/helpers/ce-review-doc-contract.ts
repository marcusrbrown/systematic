// Shared helpers for the tests that tie a `## <phase>` section of
// `skills/ce-review/references/pipeline-invocation.md` to the shipped
// validator: extract a section and its documented JSON example, check that a
// schema-derived name is documented, and run a phase through the real
// `validate-review.mjs`.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const DOC_PATH = path.join(
  ROOT_DIR,
  'skills/ce-review/references/pipeline-invocation.md',
)
const VALIDATOR_PATH = path.join(
  ROOT_DIR,
  'skills/ce-review/scripts/validate-review.mjs',
)

export type JsonRecord = Record<string, unknown>

/** The text of the `## <name>` section, up to the next `## ` heading. */
export function docSection(name: string): string {
  const doc = fs.readFileSync(DOC_PATH, 'utf8')
  const section = doc.split(/^## /m).find((s) => s.startsWith(`${name}\n`))
  if (section === undefined) throw new Error(`no "## ${name}" section found`)
  return section
}

/** The first fenced `json` block of a section, parsed. */
export function documentedJsonExample(section: string): unknown {
  const block = /```json\n([\s\S]*?)\n```/.exec(section)
  if (block?.[1] === undefined) {
    throw new Error('no fenced json example in the section')
  }
  return JSON.parse(block[1])
}

/** Whether the section documents `name` as a list bullet: "- `name` --". */
export function hasBullet(section: string, name: string): boolean {
  return section.includes(`\n- \`${name}\` --`)
}

/**
 * Whether `name` appears inside an inline code span, outside fenced blocks, so
 * `{ started_at, completed_at }` counts as naming both.
 */
export function hasMention(section: string, name: string): boolean {
  const spans = [
    ...section.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`]+)`/g),
  ].map((match) => match[1] ?? '')
  return spans.some((span) => new RegExp(`\\b${name}\\b`).test(span))
}

/** Runs one stdin phase of the shipped validator with a JSON envelope. */
export function runShippedPhase(
  phase: string,
  envelope: unknown,
): {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
} {
  const result = spawnSync(process.execPath, [VALIDATOR_PATH, phase], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
    input: JSON.stringify(envelope),
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}
