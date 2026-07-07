import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverSkills } from '../../src/lib/discovered-skills.ts'

function writeSkill(
  dir: string,
  name: string,
  opts: { frontmatterName?: string; description?: string; extra?: string } = {},
): void {
  fs.mkdirSync(dir, { recursive: true })
  const frontmatterName = opts.frontmatterName ?? name
  const description = opts.description ?? `Description for ${name}`
  const extra = opts.extra ?? ''
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---
name: ${frontmatterName}
description: ${description}
${extra}---
# Body for ${name}
`,
  )
}

describe('discoverSkills', () => {
  let root: string
  let homeDir: string
  let projectDir: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-discovered-'))
    homeDir = path.join(root, 'home')
    projectDir = path.join(root, 'project')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(projectDir, { recursive: true })
    // mark projectDir as a git worktree root
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('happy path: discovers a skill in project .opencode/skills', () => {
    writeSkill(path.join(projectDir, '.opencode/skills/foo'), 'foo', {
      description: 'A project opencode skill',
    })

    const result = discoverSkills({ startDir: projectDir, homeDir })

    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe('foo')
    expect(result[0]?.description).toBe('A project opencode skill')
    expect(result[0]?.skillPath).toBe(
      path.join(projectDir, '.opencode/skills/foo/SKILL.md'),
    )
    expect(result[0]?.root).toBe('project-opencode')
  })

  test('precedence: .opencode wins over project .claude and global .claude', () => {
    // global claude
    writeSkill(path.join(homeDir, '.claude/skills/foo'), 'foo', {
      description: 'global claude version',
    })
    // project .claude at worktree root
    writeSkill(path.join(projectDir, '.claude/skills/foo'), 'foo', {
      description: 'project claude version',
    })
    // project .opencode: must win over both external sources
    writeSkill(path.join(projectDir, '.opencode/skills/foo'), 'foo', {
      description: 'project opencode version',
    })

    const result = discoverSkills({ startDir: projectDir, homeDir })
    const winners = result.filter((s) => s.name === 'foo')

    expect(winners).toHaveLength(1)
    expect(winners[0]?.skillPath).toBe(
      path.join(projectDir, '.opencode/skills/foo/SKILL.md'),
    )
    expect(winners[0]?.root).toBe('project-opencode')
    expect(winners[0]?.description).toBe('project opencode version')
  })

  test('multi-level up-walk: worktree-root .claude skill wins over subdir-level .claude skill', () => {
    const nested = path.join(projectDir, 'nested', 'deep')
    fs.mkdirSync(nested, { recursive: true })

    // same name at the subdir level and at the worktree root
    writeSkill(path.join(nested, '.claude/skills/foo'), 'foo', {
      description: 'subdir level version',
    })
    writeSkill(path.join(projectDir, '.claude/skills/foo'), 'foo', {
      description: 'worktree root version',
    })

    const result = discoverSkills({ startDir: nested, homeDir })
    const winners = result.filter((s) => s.name === 'foo')

    expect(winners).toHaveLength(1)
    expect(winners[0]?.skillPath).toBe(
      path.join(projectDir, '.claude/skills/foo/SKILL.md'),
    )
    expect(winners[0]?.description).toBe('worktree root version')
  })

  test('multi-level up-walk: a skill only present at a subdirectory level is still discovered', () => {
    const nested = path.join(projectDir, 'nested', 'deep')
    fs.mkdirSync(nested, { recursive: true })

    writeSkill(path.join(nested, '.claude/skills/subdir-only'), 'subdir-only')

    const result = discoverSkills({ startDir: nested, homeDir })

    expect(result.map((s) => s.name)).toContain('subdir-only')
    const found = result.find((s) => s.name === 'subdir-only')
    expect(found?.skillPath).toBe(
      path.join(nested, '.claude/skills/subdir-only/SKILL.md'),
    )
  })

  test('recursive external glob: skills nested more than one level under skills/ are discovered', () => {
    writeSkill(
      path.join(homeDir, '.agents/skills/nested/deep/foo'),
      'nested-deep-foo',
    )

    const result = discoverSkills({ startDir: projectDir, homeDir })

    expect(result.map((s) => s.name)).toContain('nested-deep-foo')
  })

  test('{skill,skills}: a skill under the singular .opencode/skill/ dir is found', () => {
    writeSkill(path.join(projectDir, '.opencode/skill/singular'), 'singular')

    const result = discoverSkills({ startDir: projectDir, homeDir })

    expect(result.map((s) => s.name)).toEqual(['singular'])
    expect(result[0]?.root).toBe('project-opencode')
  })

  test('dedup by frontmatter name, not directory name', () => {
    // dir named "alpha" but frontmatter name is "beta"
    writeSkill(path.join(projectDir, '.opencode/skills/alpha'), 'alpha', {
      frontmatterName: 'beta',
      description: 'alpha dir, beta name',
    })

    const result = discoverSkills({ startDir: projectDir, homeDir })

    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe('beta')
    expect(result[0]?.description).toBe('alpha dir, beta name')
  })

  test('frontmatter: disable-model-invocation surfaces in result', () => {
    writeSkill(path.join(projectDir, '.opencode/skills/cmdonly'), 'cmdonly', {
      extra: 'disable-model-invocation: true\n',
    })

    const result = discoverSkills({ startDir: projectDir, homeDir })

    expect(result).toHaveLength(1)
    expect(result[0]?.frontmatter.disableModelInvocation).toBe(true)
  })

  test('regex skip: invalid frontmatter name is skipped, others still discovered', () => {
    // invalid frontmatter name (uppercase, underscore) — dir name is irrelevant now
    writeSkill(path.join(projectDir, '.opencode/skills/Foo_Bar'), 'Foo_Bar', {
      frontmatterName: 'Foo_Bar',
    })
    writeSkill(path.join(projectDir, '.opencode/skills/valid-one'), 'valid-one')

    const result = discoverSkills({ startDir: projectDir, homeDir })

    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe('valid-one')
  })

  test('missing root: none of the roots exist returns empty array, no throw', () => {
    // remove project skill dirs; only .git exists
    const result = discoverSkills({ startDir: projectDir, homeDir })
    expect(result).toEqual([])
  })

  test('worktree walk: skills above the worktree root are not discovered', () => {
    const nested = path.join(projectDir, 'nested', 'deep')
    fs.mkdirSync(nested, { recursive: true })

    // skill above the git root (in root/, not in projectDir) should NOT be discovered
    writeSkill(path.join(root, '.opencode/skills/above'), 'above')
    // skill inside the project worktree root
    writeSkill(path.join(projectDir, '.opencode/skills/inside'), 'inside')

    const result = discoverSkills({ startDir: nested, homeDir })

    expect(result.map((s) => s.name)).toEqual(['inside'])
  })

  test('error path: unreadable SKILL.md (directory named SKILL.md) is skipped, discovery completes', () => {
    const skillDir = path.join(projectDir, '.opencode/skills/broken')
    fs.mkdirSync(skillDir, { recursive: true })
    // SKILL.md is a directory, not a file - simulates unreadable content
    fs.mkdirSync(path.join(skillDir, 'SKILL.md'), { recursive: true })

    writeSkill(path.join(projectDir, '.opencode/skills/ok'), 'ok')

    const result = discoverSkills({ startDir: projectDir, homeDir })

    expect(result.map((s) => s.name)).toEqual(['ok'])
  })

  test('configDir override: skills discovered from custom OpenCode config dir', () => {
    const configDir = path.join(root, 'custom-config')
    writeSkill(path.join(configDir, 'skills/customcfg'), 'customcfg')

    const result = discoverSkills({
      startDir: projectDir,
      homeDir,
      configDir,
    })

    expect(result.map((s) => s.name)).toEqual(['customcfg'])
    expect(result[0]?.root).toBe('global-opencode-config')
  })

  test('opencodeConfigDirOverride: wins over everything, including the default global config dir', () => {
    writeSkill(path.join(homeDir, '.claude/skills/foo'), 'foo', {
      description: 'global claude version',
    })
    const overrideDir = path.join(root, 'env-override-config')
    writeSkill(path.join(overrideDir, 'skills/foo'), 'foo', {
      description: 'override config version',
    })

    const result = discoverSkills({
      startDir: projectDir,
      homeDir,
      opencodeConfigDirOverride: overrideDir,
    })
    const winners = result.filter((s) => s.name === 'foo')

    expect(winners).toHaveLength(1)
    expect(winners[0]?.description).toBe('override config version')
  })
})
