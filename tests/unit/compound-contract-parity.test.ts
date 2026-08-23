// Claude Code flattens each skill into a self-contained bundle, so these files must stay duplicated.
// Parity tests are safer than cross-skill references that would not survive that build.
import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dir, '../..')
const SOURCE_SKILL = 'skills/ce-compound'
const REFRESH_SKILL = 'skills/ce-compound-refresh'

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a mapping`)
  }
  return value
}

function readContract(skill: string, relativePath: string): Buffer {
  return fs.readFileSync(path.join(REPO_ROOT, skill, relativePath))
}

function assertContractParity(relativePath: string): void {
  const sourcePath = `${SOURCE_SKILL}/${relativePath}`
  const refreshPath = `${REFRESH_SKILL}/${relativePath}`
  if (
    !readContract(SOURCE_SKILL, relativePath).equals(
      readContract(REFRESH_SKILL, relativePath),
    )
  ) {
    throw new Error(
      `${sourcePath} and ${refreshPath} diverged. Copy the ce-compound version to ce-compound-refresh.`,
    )
  }
}

function readKnowledgeProblemTypes(skill: string): Set<string> {
  const relativePath = 'references/schema.yaml'
  const filePath = `${skill}/${relativePath}`
  const parsed = yaml.load(readContract(skill, relativePath).toString('utf8'))
  const schema = asRecord(parsed, filePath)
  const tracks = asRecord(schema.tracks, `${filePath}: tracks`)
  const knowledge = asRecord(tracks.knowledge, `${filePath}: tracks.knowledge`)
  const values = knowledge.problem_types

  if (
    !Array.isArray(values) ||
    !values.every((value): value is string => typeof value === 'string')
  ) {
    throw new Error(
      `${filePath}: tracks.knowledge.problem_types must be an array of strings`,
    )
  }

  return new Set(values)
}

describe('ce:compound contract parity', () => {
  it('keeps schema.yaml identical', () => {
    assertContractParity('references/schema.yaml')
  })

  it('keeps yaml-schema.md identical', () => {
    assertContractParity('references/yaml-schema.md')
  })

  it('keeps resolution-template.md identical', () => {
    assertContractParity('assets/resolution-template.md')
  })

  it('keeps knowledge-track problem_type values equal', () => {
    const sourceTypes = readKnowledgeProblemTypes(SOURCE_SKILL)
    const refreshTypes = readKnowledgeProblemTypes(REFRESH_SKILL)
    const setsMatch =
      sourceTypes.size === refreshTypes.size &&
      [...sourceTypes].every((value) => refreshTypes.has(value))

    if (!setsMatch) {
      throw new Error(
        `${SOURCE_SKILL}/references/schema.yaml and ${REFRESH_SKILL}/references/schema.yaml have different knowledge-track problem_type values. Copy the ce-compound version to ce-compound-refresh.`,
      )
    }

    expect([...refreshTypes].sort()).toEqual([...sourceTypes].sort())
  })
})
