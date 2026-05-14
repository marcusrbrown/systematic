import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildCatalogEntries,
  type CatalogOptions,
  escapeXml,
  renderCatalogCompact,
  renderCatalogVerbose,
} from '../../src/lib/skill-catalog.js'

function writeSkill(
  dir: string,
  name: string,
  description: string,
  extra = '',
): string {
  const skillDir = path.join(dir, name)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`,
  )
  return skillDir
}

describe('skill-catalog', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-skill-catalog-test-'),
    )
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('buildCatalogEntries', () => {
    test('returns skills sorted by name', () => {
      writeSkill(testDir, 'zebra-skill', 'Zebra description')
      writeSkill(testDir, 'alpha-skill', 'Alpha description')
      writeSkill(testDir, 'middle-skill', 'Middle description')

      const entries = buildCatalogEntries({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(entries.map((e) => e.name)).toEqual([
        'alpha-skill',
        'middle-skill',
        'zebra-skill',
      ])
    })

    test('excludes configured disabled skills', () => {
      writeSkill(testDir, 'git-commit', 'Commit skill')
      writeSkill(testDir, 'ce-brainstorm', 'Brainstorm skill')
      writeSkill(testDir, 'ce-plan', 'Plan skill')

      const entries = buildCatalogEntries({
        bundledSkillsDir: testDir,
        disabledSkills: ['ce-brainstorm'],
      })

      const names = entries.map((e) => e.name)
      expect(names).not.toContain('ce-brainstorm')
      expect(names).toContain('git-commit')
      expect(names).toContain('ce-plan')
    })

    test('excludes skills with disable-model-invocation: true', () => {
      writeSkill(testDir, 'git-commit', 'Commit skill')
      writeSkill(
        testDir,
        'internal-only',
        'Internal skill',
        'disable-model-invocation: true\n',
      )

      const entries = buildCatalogEntries({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const names = entries.map((e) => e.name)
      expect(names).not.toContain('internal-only')
      expect(names).toContain('git-commit')
    })

    test('returns empty array when no skills are discoverable', () => {
      const entries = buildCatalogEntries({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(entries).toEqual([])
    })

    test('returns empty array when all skills are disabled', () => {
      writeSkill(testDir, 'git-commit', 'Commit skill')

      const entries = buildCatalogEntries({
        bundledSkillsDir: testDir,
        disabledSkills: ['git-commit'],
      })

      expect(entries).toEqual([])
    })

    test('each entry has prefixedName with systematic: prefix', () => {
      writeSkill(testDir, 'ce-plan', 'Plan skill')

      const entries = buildCatalogEntries({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(entries[0]?.prefixedName).toBe('systematic:ce-plan')
    })
  })

  describe('renderCatalogVerbose', () => {
    test('renders skills in sorted order as XML', () => {
      writeSkill(testDir, 'zebra-skill', 'Zebra description')
      writeSkill(testDir, 'alpha-skill', 'Alpha description')

      const opts: CatalogOptions = {
        bundledSkillsDir: testDir,
        disabledSkills: [],
      }
      const result = renderCatalogVerbose(opts)

      const alphaPos = result.indexOf('systematic:alpha-skill')
      const zebraPos = result.indexOf('systematic:zebra-skill')
      expect(alphaPos).toBeGreaterThanOrEqual(0)
      expect(zebraPos).toBeGreaterThanOrEqual(0)
      expect(alphaPos).toBeLessThan(zebraPos)
    })

    test('renders XML with available_skills wrapper', () => {
      writeSkill(testDir, 'git-commit', 'Create a git commit')

      const result = renderCatalogVerbose({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(result).toContain('<available_skills>')
      expect(result).toContain('</available_skills>')
      expect(result).toContain('<name>systematic:git-commit</name>')
      expect(result).toContain('<description>Create a git commit</description>')
    })

    test('excludes disabled skills from verbose output', () => {
      writeSkill(testDir, 'git-commit', 'Commit skill')
      writeSkill(testDir, 'ce-brainstorm', 'Brainstorm skill')

      const result = renderCatalogVerbose({
        bundledSkillsDir: testDir,
        disabledSkills: ['ce-brainstorm'],
      })

      expect(result).not.toContain('systematic:ce-brainstorm')
      expect(result).toContain('systematic:git-commit')
    })

    test('excludes disable-model-invocation skills from verbose output', () => {
      writeSkill(testDir, 'git-commit', 'Commit skill')
      writeSkill(
        testDir,
        'internal-only',
        'Internal skill',
        'disable-model-invocation: true\n',
      )

      const result = renderCatalogVerbose({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(result).not.toContain('systematic:internal-only')
      expect(result).toContain('systematic:git-commit')
    })

    test('returns empty string when no skills are discoverable', () => {
      const result = renderCatalogVerbose({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(result).toBe('')
    })
  })

  describe('renderCatalogCompact', () => {
    test('renders heading and bullet list in sorted order', () => {
      writeSkill(testDir, 'zebra-skill', 'Zebra description')
      writeSkill(testDir, 'alpha-skill', 'Alpha description')

      const result = renderCatalogCompact({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(result).toContain('## Available Systematic Skills')
      const alphaPos = result.indexOf('systematic:alpha-skill')
      const zebraPos = result.indexOf('systematic:zebra-skill')
      expect(alphaPos).toBeLessThan(zebraPos)
    })

    test('renders bullet format: - prefixedName: description', () => {
      writeSkill(testDir, 'git-commit', 'Create a git commit')

      const result = renderCatalogCompact({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(result).toContain('- systematic:git-commit: Create a git commit')
    })

    test('excludes disabled skills from compact output', () => {
      writeSkill(testDir, 'git-commit', 'Commit skill')
      writeSkill(testDir, 'ce-brainstorm', 'Brainstorm skill')

      const result = renderCatalogCompact({
        bundledSkillsDir: testDir,
        disabledSkills: ['ce-brainstorm'],
      })

      expect(result).not.toContain('systematic:ce-brainstorm')
      expect(result).toContain('systematic:git-commit')
    })

    test('excludes disable-model-invocation skills from compact output', () => {
      writeSkill(testDir, 'git-commit', 'Commit skill')
      writeSkill(
        testDir,
        'internal-only',
        'Internal skill',
        'disable-model-invocation: true\n',
      )

      const result = renderCatalogCompact({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(result).not.toContain('systematic:internal-only')
      expect(result).toContain('systematic:git-commit')
    })

    test('renders no-skills message when no skills are discoverable', () => {
      const result = renderCatalogCompact({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(result).toContain('## Available Systematic Skills')
      expect(result).toContain('No Systematic skills are currently available.')
    })

    test('renders no-skills message when all skills are disabled', () => {
      writeSkill(testDir, 'git-commit', 'Commit skill')

      const result = renderCatalogCompact({
        bundledSkillsDir: testDir,
        disabledSkills: ['git-commit'],
      })

      expect(result).toContain('No Systematic skills are currently available.')
    })
  })

  describe('escapeXml', () => {
    test('escapes &, <, > characters', () => {
      expect(escapeXml('A & B <test>')).toBe('A &amp; B &lt;test&gt;')
    })

    test('passes through text without special chars', () => {
      expect(escapeXml('normal text')).toBe('normal text')
    })

    test('escapes multiple occurrences', () => {
      expect(escapeXml('<a> & <b>')).toBe('&lt;a&gt; &amp; &lt;b&gt;')
    })

    test('handles empty string', () => {
      expect(escapeXml('')).toBe('')
    })
  })

  describe('renderCatalogVerbose XML escaping', () => {
    test('escapes XML special chars in name and description', () => {
      writeSkill(testDir, 'a&b', 'Skill with A & B <special> chars')

      const result = renderCatalogVerbose({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(result).toContain('<name>systematic:a&amp;b</name>')
      expect(result).toContain(
        '<description>Skill with A &amp; B &lt;special&gt; chars</description>',
      )
    })
  })
})
