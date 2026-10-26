// Claude Code flattens each skill into a self-contained bundle, so these files must stay duplicated.
// Parity tests are safer than cross-skill references that would not survive that build.
import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { collectSkillFiles } from '../../scripts/build-claude-code-plugin.ts'

const REPO_ROOT = path.resolve(import.meta.dir, '../..')
const SOURCE_SKILL = 'skills/ce-compound'
const REFRESH_SKILL = 'skills/ce-compound-refresh'
const DOCS_SKILL = 'skills/compound-docs'

/** Skills that ship byte copies of the canonical ce-compound contract. */
const COPY_SKILLS: string[] = [REFRESH_SKILL, DOCS_SKILL]

const CONTRACT_FILES: string[] = [
  'references/schema.yaml',
  'references/yaml-schema.md',
  'assets/resolution-template.md',
]

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

function assertContractParity(copySkill: string, relativePath: string): void {
  const sourcePath = `${SOURCE_SKILL}/${relativePath}`
  const copyPath = `${copySkill}/${relativePath}`
  if (
    !readContract(SOURCE_SKILL, relativePath).equals(
      readContract(copySkill, relativePath),
    )
  ) {
    throw new Error(
      `${sourcePath} and ${copyPath} diverged. Copy the ce-compound version to ${path.basename(copySkill)}.`,
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
  describe.each(COPY_SKILLS)('%s', (copySkill) => {
    it.each(CONTRACT_FILES)('keeps %s identical to ce-compound', (file) => {
      assertContractParity(copySkill, file)
    })

    it('keeps knowledge-track problem_type values equal', () => {
      const sourceTypes = readKnowledgeProblemTypes(SOURCE_SKILL)
      const copyTypes = readKnowledgeProblemTypes(copySkill)
      const setsMatch =
        sourceTypes.size === copyTypes.size &&
        [...sourceTypes].every((value) => copyTypes.has(value))

      if (!setsMatch) {
        throw new Error(
          `${SOURCE_SKILL}/references/schema.yaml and ${copySkill}/references/schema.yaml have different knowledge-track problem_type values. Copy the ce-compound version to ${path.basename(copySkill)}.`,
        )
      }

      expect([...copyTypes].sort()).toEqual([...sourceTypes].sort())
    })

    it('ships every contract file inside its own Claude Code skill bundle', () => {
      const bundle = collectSkillFiles(REPO_ROOT)
      for (const file of CONTRACT_FILES) {
        const packaged = bundle.get(`${copySkill}/${file}`)
        expect(packaged).toBeDefined()
        expect(packaged?.equals(readContract(SOURCE_SKILL, file))).toBe(true)
      }
    })
  })

  it('leaves compound-docs without a second, root-level schema.yaml', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, DOCS_SKILL, 'schema.yaml'))).toBe(
      false,
    )
  })

  it('leaves compound-docs without the orphaned critical-pattern template', () => {
    expect(
      fs.existsSync(
        path.join(REPO_ROOT, DOCS_SKILL, 'assets/critical-pattern-template.md'),
      ),
    ).toBe(false)
  })
})
