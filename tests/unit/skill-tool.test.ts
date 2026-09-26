import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ToolResult } from '@opencode-ai/plugin'
import { buildCatalogEntries } from '../../src/lib/skill-catalog.ts'
import {
  createSkillOutputStore,
  createSkillTool,
  restoreSkillOutput,
} from '../../src/lib/skill-tool.ts'

const mockContext = {
  ask: async () => {},
  metadata: () => {},
} as never

/** `ToolDefinition['execute']` returns the SDK's `ToolResult` union; the skill tool always resolves the string branch. */
function expectStringToolResult(result: ToolResult): string {
  if (typeof result !== 'string') {
    throw new Error(
      'Expected the skill tool to return a string ToolResult, got a structured result instead.',
    )
  }
  return result
}

describe('skill-tool', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-skill-test-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('createSkillTool', () => {
    test('creates tool with description property', () => {
      const skillDir = path.join(testDir, 'test-skill')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill for unit testing
---
# Test Skill Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(tool.description).toContain('systematic:test-skill')
      expect(tool.description).toContain('A test skill for unit testing')
    })

    test('description bullet identities match the independently discovered, model-invocable bundled catalog and include ce:review-cleanup', () => {
      const options = {
        bundledSkillsDir: path.resolve(process.cwd(), 'skills'),
        disabledSkills: [],
      }

      // Ground truth: the exported discovery API, not a re-render of the
      // tool description or a hand-maintained numeric literal.
      // buildCatalogEntries already applies the intended catalog filter
      // (excludes disabled skills and skills with
      // disable-model-invocation: true).
      const expectedEntries = buildCatalogEntries(options)
      expect(expectedEntries.length).toBeGreaterThan(0)
      const expectedIdentities = expectedEntries
        .map((entry) => entry.prefixedName)
        .sort()

      const tool = createSkillTool(options)
      const renderedIdentities = [...tool.description.matchAll(/^- (\S+):/gm)]
        .map((match) => match[1])
        .filter((name): name is string => typeof name === 'string')
        .sort()

      expect(renderedIdentities).toEqual(expectedIdentities)
      expect(renderedIdentities).toContain('ce:review-cleanup')
    })

    test('description uses compact catalog format, not verbose XML', () => {
      const skillDir = path.join(testDir, 'ce-brainstorm')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: ce:brainstorm
description: Explore requirements and approaches through collaborative dialogue
---
# Brainstorm Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      // Compact format: markdown bullet list
      expect(tool.description).toContain('ce:brainstorm')
      expect(tool.description).toContain(
        'Explore requirements and approaches through collaborative dialogue',
      )
      // Must NOT contain verbose XML catalog
      expect(tool.description).not.toContain('<available_skills>')
      expect(tool.description).not.toContain('</available_skills>')
      expect(tool.description).not.toContain('<location>')
    })

    test('filters out disabled skills from description', () => {
      const skill1Dir = path.join(testDir, 'enabled-skill')
      const skill2Dir = path.join(testDir, 'disabled-skill')
      fs.mkdirSync(skill1Dir)
      fs.mkdirSync(skill2Dir)

      fs.writeFileSync(
        path.join(skill1Dir, 'SKILL.md'),
        `---
name: enabled-skill
description: Enabled
---
# Content`,
      )

      fs.writeFileSync(
        path.join(skill2Dir, 'SKILL.md'),
        `---
name: disabled-skill
description: Disabled
---
# Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: ['disabled-skill'],
      })

      expect(tool.description).toContain('systematic:enabled-skill')
      expect(tool.description).not.toContain('systematic:disabled-skill')
    })

    test('excludes disableModelInvocation skills from description', () => {
      const visibleDir = path.join(testDir, 'visible-skill')
      const hiddenDir = path.join(testDir, 'hidden-skill')
      fs.mkdirSync(visibleDir)
      fs.mkdirSync(hiddenDir)

      fs.writeFileSync(
        path.join(visibleDir, 'SKILL.md'),
        `---
name: visible-skill
description: Visible to model
---
# Content`,
      )

      fs.writeFileSync(
        path.join(hiddenDir, 'SKILL.md'),
        `---
name: hidden-skill
description: Hidden from model
disable-model-invocation: true
---
# Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(tool.description).toContain('systematic:visible-skill')
      expect(tool.description).not.toContain('systematic:hidden-skill')
    })

    test('compact description and execution loadability agree on disabled vs disable-model-invocation skills', async () => {
      const normalDir = path.join(testDir, 'normal-skill')
      const disabledDir = path.join(testDir, 'disabled-skill')
      const hiddenDir = path.join(testDir, 'hidden-skill')
      fs.mkdirSync(normalDir)
      fs.mkdirSync(disabledDir)
      fs.mkdirSync(hiddenDir)

      fs.writeFileSync(
        path.join(normalDir, 'SKILL.md'),
        `---
name: normal-skill
description: Normal skill
---
# Normal`,
      )

      fs.writeFileSync(
        path.join(disabledDir, 'SKILL.md'),
        `---
name: disabled-skill
description: Disabled skill
---
# Disabled`,
      )

      fs.writeFileSync(
        path.join(hiddenDir, 'SKILL.md'),
        `---
name: hidden-skill
description: Hidden skill
disable-model-invocation: true
---
# Hidden`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: ['disabled-skill'],
      })

      // Disabled: not in description, not loadable
      expect(tool.description).not.toContain('systematic:disabled-skill')
      await expect(
        tool.execute({ name: 'systematic:disabled-skill' }, mockContext),
      ).rejects.toThrow()

      // Hidden (disableModelInvocation): not in description, IS loadable
      expect(tool.description).not.toContain('systematic:hidden-skill')
      const hiddenResult = await tool.execute(
        { name: 'systematic:hidden-skill' },
        mockContext,
      )
      expect(hiddenResult).toContain('# Hidden')

      // Normal: in description, loadable
      expect(tool.description).toContain('systematic:normal-skill')
      const normalResult = await tool.execute(
        { name: 'systematic:normal-skill' },
        mockContext,
      )
      expect(normalResult).toContain('# Normal')
    })
  })

  describe('execute', () => {
    test('loads systematic skill with prefix', async () => {
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

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute(
        { name: 'systematic:load-test' },
        mockContext,
      )

      expect(result).toContain('systematic:load-test')
      expect(result).toContain('# Load Test Skill')
      expect(result).toContain('This is the skill content.')
      expect(result).not.toContain('<skill-instruction>')
    })

    test('loads systematic skill without prefix', async () => {
      const skillDir = path.join(testDir, 'no-prefix')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: no-prefix
description: Test
---
# No Prefix Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute({ name: 'no-prefix' }, mockContext)

      expect(result).toContain('systematic:no-prefix')
      expect(result).toContain('# No Prefix Content')
    })

    test('loads skill that uses a non-systematic colon prefix', async () => {
      const skillDir = path.join(testDir, 'ce-plan')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: ce:plan
description: Test CE skill
---
# CE Plan Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const askCalls: unknown[] = []
      const metadataCalls: unknown[] = []
      const context = {
        ask: async (payload: unknown) => {
          askCalls.push(payload)
        },
        metadata: (payload: unknown) => {
          metadataCalls.push(payload)
        },
      } as never

      const result = await tool.execute({ name: 'ce:plan' }, context)

      expect(result).toContain('ce:plan')
      expect(result).toContain('# CE Plan Content')
      expect(result).not.toContain('systematic:ce:plan')
      expect(askCalls).toEqual([
        {
          permission: 'skill',
          patterns: ['ce:plan'],
          always: ['ce:plan'],
          metadata: {},
        },
      ])
      expect(metadataCalls).toEqual([
        {
          title: 'Loaded skill: ce:plan',
          metadata: {
            name: 'ce:plan',
            dir: skillDir,
          },
        },
      ])
    })

    test('throws error when skill not found', async () => {
      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      await expect(
        tool.execute({ name: 'nonexistent' }, mockContext),
      ).rejects.toThrow('Skill "nonexistent" not found')
    })

    test('does not call ask or metadata when skill not found', async () => {
      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const askCalls: unknown[] = []
      const metadataCalls: unknown[] = []
      const context = {
        ask: async (payload: unknown) => {
          askCalls.push(payload)
        },
        metadata: (payload: unknown) => {
          metadataCalls.push(payload)
        },
      } as never

      await expect(
        tool.execute({ name: 'nonexistent' }, context),
      ).rejects.toThrow('Skill "nonexistent" not found')

      expect(askCalls).toEqual([])
      expect(metadataCalls).toEqual([])
    })

    test('strips frontmatter from loaded skill content', async () => {
      const skillDir = path.join(testDir, 'frontmatter-strip')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: frontmatter-strip
description: Test frontmatter stripping
---
# Actual Content

No frontmatter visible here.`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute(
        { name: 'frontmatter-strip' },
        mockContext,
      )

      expect(result).not.toContain('description: Test frontmatter stripping')
      expect(result).toContain('# Actual Content')
    })

    test('wraps output with skill_content tags and omits skill_files when no files found', async () => {
      const skillDir = path.join(testDir, 'wrap-test')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: wrap-test
description: Test wrapper
---
# Wrapped Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute({ name: 'wrap-test' }, mockContext)

      // New wrapper format
      expect(result).toContain('<skill_content name="systematic:wrap-test">')
      expect(result).toContain('</skill_content>')
      // New heading format
      expect(result).toContain('# Skill: systematic:wrap-test')
      // New base directory format with file:// URL
      expect(result).toContain('Base directory for this skill: file://')
      expect(result).toContain('# Wrapped Content')
      // skill_files section should be omitted when no files
      expect(result).not.toContain('<skill_files>')
      expect(result).not.toContain('</skill_files>')
    })

    test('includes discovered files in skill_files section', async () => {
      const skillDir = path.join(testDir, 'file-discovery-test')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: file-discovery-test
description: Test file discovery
---
# Test Content`,
      )
      // Add extra files to be discovered
      fs.writeFileSync(
        path.join(skillDir, 'helper.ts'),
        'export function helper() {}',
      )
      fs.writeFileSync(
        path.join(skillDir, 'utils.ts'),
        'export function util() {}',
      )
      fs.writeFileSync(path.join(skillDir, '.hidden'), 'hidden file')

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute(
        { name: 'file-discovery-test' },
        mockContext,
      )

      expect(result).toContain('<skill_files>')
      expect(result).toContain('</skill_files>')
      // Check for absolute paths ending with the filenames
      expect(result).toMatch(/<file>.*\/helper\.ts<\/file>/)
      expect(result).toMatch(/<file>.*\/utils\.ts<\/file>/)
      // SKILL.md should not be in the file list
      expect(result).not.toContain('<file>SKILL.md</file>')
      // Hidden files should be included (matches OpenCode v1.1.50 behavior)
      expect(result).toMatch(/<file>.*\/\.hidden<\/file>/)
    })

    test('enforces 10-file limit in skill_files section', async () => {
      const skillDir = path.join(testDir, 'file-limit-test')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: file-limit-test
description: Test file limit
---
# Test Content`,
      )
      // Create 15 extra files
      for (let i = 1; i <= 15; i++) {
        fs.writeFileSync(
          path.join(skillDir, `file${i}.ts`),
          `export const file${i} = ${i}`,
        )
      }

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = expectStringToolResult(
        await tool.execute({ name: 'file-limit-test' }, mockContext),
      )

      // Count the number of <file> tags
      const fileMatches = result.match(/<file>/g)
      expect(fileMatches).toBeDefined()
      expect(fileMatches?.length).toBe(10)
      // Verify at least one of the first 10 files is present
      const hasLimitedFiles = /file[0-9]\.ts/.test(result)
      expect(hasLimitedFiles).toBe(true)
    })

    test('loads disableModelInvocation skill when explicitly requested', async () => {
      const hiddenDir = path.join(testDir, 'hidden-skill')
      fs.mkdirSync(hiddenDir)
      fs.writeFileSync(
        path.join(hiddenDir, 'SKILL.md'),
        `---
name: hidden-skill
description: Hidden from model
disable-model-invocation: true
---
# Hidden Skill Content

This skill is only loadable by explicit request.`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      expect(tool.description).not.toContain('hidden-skill')

      const result = await tool.execute(
        { name: 'systematic:hidden-skill' },
        mockContext,
      )

      expect(result).toContain('systematic:hidden-skill')
      expect(result).toContain('# Hidden Skill Content')
      expect(result).toContain(
        'This skill is only loadable by explicit request.',
      )
    })

    test('does not list disableModelInvocation skills in error suggestions', async () => {
      const visibleDir = path.join(testDir, 'visible-skill')
      const hiddenDir = path.join(testDir, 'hidden-skill')
      fs.mkdirSync(visibleDir)
      fs.mkdirSync(hiddenDir)

      fs.writeFileSync(
        path.join(visibleDir, 'SKILL.md'),
        `---
name: visible-skill
description: Visible to model
---
# Content`,
      )

      fs.writeFileSync(
        path.join(hiddenDir, 'SKILL.md'),
        `---
name: hidden-skill
description: Hidden from model
disable-model-invocation: true
---
# Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      try {
        await tool.execute({ name: 'nonexistent' }, mockContext)
        expect.unreachable('Should have thrown')
      } catch (error) {
        const message = (error as Error).message
        expect(message).toContain('systematic:visible-skill')
        expect(message).not.toContain('hidden-skill')
      }
    })
  })

  describe('execute with arguments', () => {
    test('substitutes $ARGUMENTS in the skill body when arguments is supplied', async () => {
      const skillDir = path.join(testDir, 'arg-skill')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: arg-skill
description: Skill accepting arguments
---
# Arg Skill

Target: $ARGUMENTS`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute(
        { name: 'arg-skill', arguments: 'the-thing' },
        mockContext,
      )

      expect(result).toContain('Target: the-thing')
      expect(result).not.toContain('$ARGUMENTS')
    })

    test('omitting arguments leaves placeholders literal, matching the native skill tool', async () => {
      const skillDir = path.join(testDir, 'arg-skill-omitted')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: arg-skill-omitted
description: Skill accepting arguments
---
# Arg Skill Omitted

Target: [$ARGUMENTS]`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute(
        { name: 'arg-skill-omitted' },
        mockContext,
      )

      expect(result).toContain('Target: [$ARGUMENTS]')
    })

    test('an explicit empty arguments string substitutes empty', async () => {
      const skillDir = path.join(testDir, 'arg-skill-empty')
      fs.mkdirSync(skillDir)
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: arg-skill-empty
description: Skill accepting arguments
---
# Arg Skill Empty

Target: [$ARGUMENTS]`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const result = await tool.execute(
        { name: 'arg-skill-empty', arguments: '' },
        mockContext,
      )

      expect(result).toContain('Target: []')
    })
  })

  describe('deprecated skill frontmatter', () => {
    test('a skill with a deprecated: block gets no special handling — field is ignored', async () => {
      const skillDir = path.join(testDir, 'old-skill')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: old-skill
description: A deprecated skill
deprecated:
  since: v2.19.0
  removal: v3.0.0
  replacement: new-skill
  reason: "Old API no longer supported."
---
# Deprecated Skill Content`,
      )

      const tool = createSkillTool({
        bundledSkillsDir: testDir,
        disabledSkills: [],
      })

      const warnSpy = spyOn(console, 'warn')

      await tool.execute({ name: 'old-skill' }, mockContext)

      const deprecationWarns = (warnSpy.mock.calls as unknown[][]).filter(
        (args: unknown[]) =>
          typeof args[0] === 'string' && args[0].includes('deprecated'),
      )
      expect(deprecationWarns).toEqual([])

      warnSpy.mockRestore()
    })
  })
})

describe('createSkillTool with outputStore', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-skill-output-test-'),
    )
    const skillDir = path.join(testDir, 'output-test')
    fs.mkdirSync(skillDir)
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: output-test
description: Skill for output store testing
---
# Output Test Skill`,
    )
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  test('stores the exact returned output keyed by sessionID and callID', async () => {
    const outputStore = createSkillOutputStore()
    const tool = createSkillTool({
      bundledSkillsDir: testDir,
      disabledSkills: [],
      outputStore,
    })

    const context = {
      sessionID: 's',
      callID: 'c',
      ask: async () => {},
      metadata: () => {},
    } as never

    const result = expectStringToolResult(
      await tool.execute({ name: 'output-test' }, context),
    )

    expect(outputStore.take('s', 'c')).toBe(result)
  })

  test('stores nothing when ask rejects', async () => {
    const outputStore = createSkillOutputStore()
    const tool = createSkillTool({
      bundledSkillsDir: testDir,
      disabledSkills: [],
      outputStore,
    })

    const context = {
      sessionID: 's',
      callID: 'c',
      ask: async () => {
        throw new Error('denied')
      },
      metadata: () => {},
    } as never

    await expect(
      tool.execute({ name: 'output-test' }, context),
    ).rejects.toThrow('denied')

    expect(outputStore.take('s', 'c')).toBeUndefined()
  })

  test('stores nothing and does not throw when the context has no callID', async () => {
    const outputStore = createSkillOutputStore()
    const tool = createSkillTool({
      bundledSkillsDir: testDir,
      disabledSkills: [],
      outputStore,
    })

    const context = {
      sessionID: 's',
      ask: async () => {},
      metadata: () => {},
    } as never

    const result = await tool.execute({ name: 'output-test' }, context)

    expect(result).toBeTruthy()
    expect(outputStore.take('s', 'anything')).toBeUndefined()
  })
})

describe('createSkillOutputStore', () => {
  test('evicts the oldest entry once maxEntries is exceeded', () => {
    const store = createSkillOutputStore({ maxEntries: 32 })
    for (let i = 0; i < 32; i++) {
      store.put('s', `c${i}`, `full-${i}`)
    }
    store.put('s', 'c32', 'full-32') // 33rd put evicts the oldest (c0)

    expect(store.take('s', 'c0')).toBeUndefined()
    expect(store.take('s', 'c1')).toBe('full-1')
    expect(store.take('s', 'c32')).toBe('full-32')
  })

  test('does not return an expired entry', () => {
    let currentTime = 0
    const store = createSkillOutputStore({
      ttlMs: 1000,
      now: () => currentTime,
    })
    store.put('s', 'c', 'full-text')
    currentTime = 2000 // past ttlMs

    expect(store.take('s', 'c')).toBeUndefined()
  })
})

describe('restoreSkillOutput', () => {
  test('restores full output when truncated and the preview matches', () => {
    const store = createSkillOutputStore()
    const full = `head-content-${'x'.repeat(60_000)}`
    store.put('s', 'c', full)

    const preview = full.slice(0, 100)
    const output = {
      output: `${preview}\n\n...500 lines truncated...\n\nRe-run with a narrower scope.`,
      metadata: { truncated: true, outputPath: '/tmp/x', marker: 'keep' },
    }

    restoreSkillOutput(
      store,
      { tool: 'systematic_skill', sessionID: 's', callID: 'c' },
      output,
      { userOutputLimitSet: false },
    )

    expect(output.output).toBe(full)
    expect(output.metadata.truncated).toBe(false)
    expect(output.metadata).not.toHaveProperty('outputPath')
    expect(output.metadata.marker).toBe('keep')
  })

  test('leaves output unchanged and still deletes the entry when metadata.truncated is not true', () => {
    const store = createSkillOutputStore()
    store.put('s', 'c', 'full-text')

    const output = {
      output: 'preview text',
      metadata: { truncated: false },
    }

    restoreSkillOutput(
      store,
      { tool: 'systematic_skill', sessionID: 's', callID: 'c' },
      output,
      { userOutputLimitSet: false },
    )

    expect(output.output).toBe('preview text')
    expect(output.metadata.truncated).toBe(false)
    expect(store.take('s', 'c')).toBeUndefined()
  })

  test('leaves output unchanged and still deletes the entry when the user set an explicit output limit', () => {
    const store = createSkillOutputStore()
    store.put('s', 'c', 'full-text')

    const output = {
      output: 'preview\n\n...10 lines truncated...\n\nhint',
      metadata: { truncated: true, outputPath: '/tmp/x' },
    }

    restoreSkillOutput(
      store,
      { tool: 'systematic_skill', sessionID: 's', callID: 'c' },
      output,
      { userOutputLimitSet: true },
    )

    expect(output.output).toBe('preview\n\n...10 lines truncated...\n\nhint')
    expect(output.metadata.truncated).toBe(true)
    expect(store.take('s', 'c')).toBeUndefined()
  })

  test('leaves output unchanged when the stored full text does not start with the preview', () => {
    const store = createSkillOutputStore()
    store.put('s', 'c', 'completely different full text')

    const output = {
      output: 'preview-that-does-not-match\n\n...10 lines truncated...\n\nhint',
      metadata: { truncated: true, outputPath: '/tmp/x' },
    }

    restoreSkillOutput(
      store,
      { tool: 'systematic_skill', sessionID: 's', callID: 'c' },
      output,
      { userOutputLimitSet: false },
    )

    expect(output.output).toContain('preview-that-does-not-match')
    expect(output.metadata.truncated).toBe(true)
    expect(store.take('s', 'c')).toBeUndefined()
  })

  test('ignores input for a different tool and does not consume the stored entry', () => {
    const store = createSkillOutputStore()
    store.put('s', 'c', 'full-text')

    const output = {
      output: 'preview\n\n...10 lines truncated...\n\nhint',
      metadata: { truncated: true, outputPath: '/tmp/x' },
    }

    restoreSkillOutput(
      store,
      { tool: 'other_tool', sessionID: 's', callID: 'c' },
      output,
      { userOutputLimitSet: false },
    )

    expect(output.output).toBe('preview\n\n...10 lines truncated...\n\nhint')
    expect(output.metadata.truncated).toBe(true)
    // Entry NOT consumed: still retrievable.
    expect(store.take('s', 'c')).toBe('full-text')
  })

  test('restores two callIDs within the same session independently', () => {
    const store = createSkillOutputStore()
    store.put('s', 'c1', 'full-text-one')
    store.put('s', 'c2', 'full-text-two')

    const output1 = {
      output: '\n\n...5 lines truncated...\n\nhint-one',
      metadata: { truncated: true, outputPath: '/tmp/1' },
    }
    const output2 = {
      output: '\n\n...5 lines truncated...\n\nhint-two',
      metadata: { truncated: true, outputPath: '/tmp/2' },
    }

    restoreSkillOutput(
      store,
      { tool: 'systematic_skill', sessionID: 's', callID: 'c1' },
      output1,
      { userOutputLimitSet: false },
    )
    restoreSkillOutput(
      store,
      { tool: 'systematic_skill', sessionID: 's', callID: 'c2' },
      output2,
      { userOutputLimitSet: false },
    )

    expect(output1.output).toBe('full-text-one')
    expect(output2.output).toBe('full-text-two')
  })
})
