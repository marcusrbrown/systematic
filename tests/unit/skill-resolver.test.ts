import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripFrontmatter } from '../../src/lib/frontmatter.ts'
import {
  buildSkillContentOutput,
  buildSkillToolDescription,
  buildSkillToolParameterHint,
  resolveSkill,
  substituteSkillArguments,
} from '../../src/lib/skill-resolver.ts'

const BUNDLED_SKILLS_DIR = path.resolve(process.cwd(), 'skills')

function makeSkillsDir(): string {
  const testDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'systematic-skill-resolver-test-'),
  )
  const skillDir = path.join(testDir, 'load-test')
  fs.mkdirSync(skillDir)
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
name: load-test
description: Skill for loading test
---
# Load Test Skill

This is the skill content.`,
  )
  return testDir
}

describe('skill-resolver (harness-neutral core)', () => {
  test('resolveSkill returns the matched skill for a prefixed name', () => {
    const testDir = makeSkillsDir()
    try {
      const skill = resolveSkill(
        { bundledSkillsDir: testDir, disabledSkills: [] },
        'systematic:load-test',
      )
      expect(skill.name).toBe('load-test')
      expect(skill.prefixedName).toBe('systematic:load-test')
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('resolveSkill throws byte-identical not-found error text', () => {
    const testDir = makeSkillsDir()
    try {
      expect(() =>
        resolveSkill(
          { bundledSkillsDir: testDir, disabledSkills: [] },
          'nonexistent',
        ),
      ).toThrow(
        'Skill "nonexistent" not found. Available systematic skills: systematic:load-test',
      )
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('buildSkillToolDescription matches catalog-derived description', () => {
    const testDir = makeSkillsDir()
    try {
      const description = buildSkillToolDescription({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })
      expect(description).toContain('systematic:load-test')
      expect(description).toContain('Skill for loading test')
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('buildSkillToolParameterHint includes example skill names', () => {
    const testDir = makeSkillsDir()
    try {
      const hint = buildSkillToolParameterHint({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })
      expect(hint).toContain('The name of the skill from available_skills')
      expect(hint).toContain("'systematic:load-test'")
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('buildSkillContentOutput wraps skill content and reports skillDir', () => {
    const testDir = makeSkillsDir()
    try {
      const skill = resolveSkill(
        { bundledSkillsDir: testDir, disabledSkills: [] },
        'load-test',
      )
      const { output, dir } = buildSkillContentOutput(skill)

      expect(dir).toBe(path.join(testDir, 'load-test'))
      expect(output).toStartWith('<skill_content name="systematic:load-test">')
      expect(output).toContain('# Skill: systematic:load-test')
      expect(output).toContain('# Load Test Skill')
      expect(output).toContain('This is the skill content.')
      expect(output).toContain(`Base directory for this skill: file://${dir}`)
      expect(output).toEndWith('</skill_content>')
      // No extra files beyond SKILL.md in this fixture: no <skill_files> block.
      expect(output).not.toContain('<skill_files>')
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('buildSkillContentOutput with no argument is byte-identical to omitting substitution entirely', () => {
    const testDir = makeSkillsDir()
    try {
      const skill = resolveSkill(
        { bundledSkillsDir: testDir, disabledSkills: [] },
        'load-test',
      )
      const withoutArg = buildSkillContentOutput(skill)
      const withUndefinedArg = buildSkillContentOutput(skill, undefined)
      expect(withoutArg.output).toBe(withUndefinedArg.output)
      expect(withoutArg.output).not.toContain('$ARGUMENTS')
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('buildSkillContentOutput leaves a literal $ARGUMENTS body untouched when no argument is passed', () => {
    const testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-skill-resolver-argtest-'),
    )
    try {
      const skillDir = path.join(testDir, 'arg-test')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: arg-test
description: Skill with a literal placeholder
---
# Arg Test Skill

Run with: $ARGUMENTS`,
      )
      const skill = resolveSkill(
        { bundledSkillsDir: testDir, disabledSkills: [] },
        'arg-test',
      )
      const { output } = buildSkillContentOutput(skill)
      expect(output).toContain('Run with: $ARGUMENTS')
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('buildSkillContentOutput substitutes $ARGUMENTS into the trimmed body when an argument is given', () => {
    const testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-skill-resolver-argtest2-'),
    )
    try {
      const skillDir = path.join(testDir, 'arg-test')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: arg-test
description: Skill with a literal placeholder
---
# Arg Test Skill

Run with: $ARGUMENTS`,
      )
      const skill = resolveSkill(
        { bundledSkillsDir: testDir, disabledSkills: [] },
        'arg-test',
      )
      const { output } = buildSkillContentOutput(skill, 'do the thing')
      expect(output).toContain('Run with: do the thing')
      expect(output).not.toContain('$ARGUMENTS')
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })
})

describe('substituteSkillArguments (OpenCode native slash-command semantics)', () => {
  test('$ARGUMENTS is replaced verbatim with the raw argument string', () => {
    const body = 'Do this: $ARGUMENTS'
    expect(substituteSkillArguments(body, 'fix the bug')).toBe(
      'Do this: fix the bug',
    )
  })

  test('$1 $2 with a quoted middle argument: last placeholder absorbs the remaining args', () => {
    // args parsed from `a "b c" d` => ['a', 'b c', 'd']
    // $1 = args[0] = 'a'; $2 is the highest placeholder number, so it joins
    // args.slice(1) = ['b c', 'd'] with a space => 'b c d'
    const body = '$1 $2'
    expect(substituteSkillArguments(body, 'a "b c" d')).toBe('a b c d')
  })

  test('single-quoted segments are also treated as one argument with quotes stripped', () => {
    const body = '$1 $2'
    expect(substituteSkillArguments(body, "x 'y z'")).toBe('x y z')
  })

  test('omitted (empty string) argument leaves positional placeholders empty', () => {
    const body = 'before [$1] middle [$2] after'
    expect(substituteSkillArguments(body, '')).toBe('before [] middle [] after')
  })

  test('a placeholder beyond the supplied arg count is empty even when earlier placeholders are filled', () => {
    const body = '$1|$2|$3'
    // args = ['only']; $1='only'; $2 is last => args.slice(1).join(' ') = ''
    // $3 also empty (n-1=2 >= args.length=1)
    expect(substituteSkillArguments(body, 'only')).toBe('only||')
  })

  test('no positional placeholders and no $ARGUMENTS: non-blank raw argument is appended after a blank line', () => {
    const body = '# Some Skill\n\nFixed instructions only.'
    const result = substituteSkillArguments(body, 'extra context here')
    expect(result).toBe(
      '# Some Skill\n\nFixed instructions only.\n\nextra context here',
    )
  })

  test('no positional placeholders and no $ARGUMENTS: whitespace-only raw argument is not appended', () => {
    const body = '# Some Skill\n\nFixed instructions only.'
    expect(substituteSkillArguments(body, '   \t  ')).toBe(body)
  })

  test('no positional placeholders and no $ARGUMENTS: empty raw argument is not appended', () => {
    const body = '# Some Skill\n\nFixed instructions only.'
    expect(substituteSkillArguments(body, '')).toBe(body)
  })

  test('argument text containing shell metacharacters and backticks is substituted literally, never executed', () => {
    const body = 'Run: $ARGUMENTS'
    const dangerous = '`rm -rf /` && echo pwned! $(whoami)'
    expect(substituteSkillArguments(body, dangerous)).toBe(`Run: ${dangerous}`)
  })

  test('positional placeholders are substituted before $ARGUMENTS is replaced', () => {
    // $1 is the only (and therefore highest-numbered) placeholder, so it
    // absorbs the full argument list before $ARGUMENTS is substituted with
    // the raw string.
    const body = '$1 / $ARGUMENTS'
    expect(substituteSkillArguments(body, 'first second')).toBe(
      'first second / first second',
    )
  })
})

describe('bundled skill bodies never contain raw $N placeholders', () => {
  test('every skills/*/SKILL.md body is free of $1, $2, ... (would collide with argument substitution)', () => {
    const skillDirs = fs
      .readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(BUNDLED_SKILLS_DIR, entry.name, 'SKILL.md'))
      .filter((skillFile) => fs.existsSync(skillFile))

    expect(skillDirs.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const skillFile of skillDirs) {
      const content = fs.readFileSync(skillFile, 'utf8')
      const body = stripFrontmatter(content)
      if (/\$\d/.test(body)) {
        offenders.push(skillFile)
      }
    }

    expect(offenders).toEqual([])
  })
})
