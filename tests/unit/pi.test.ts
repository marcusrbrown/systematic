import { describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AgentToolResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { ToolResult } from '@opencode-ai/plugin'
import type { Config } from '@opencode-ai/sdk'
import { createConfigHandler } from '../../src/lib/config-handler.ts'
import { formatSkillCommandName } from '../../src/lib/skill-loader.ts'
import {
  buildSkillContentOutput,
  buildSkillToolDescription,
  buildSkillToolParameterHint,
  resolveSkill,
} from '../../src/lib/skill-resolver.ts'
import { createSkillTool } from '../../src/lib/skill-tool.ts'
import { findSkillsInDir } from '../../src/lib/skills.ts'
import piExtension from '../../src/pi.ts'

const bundledSkillsDir = fileURLToPath(new URL('../../skills', import.meta.url))
const resolverOptions = { bundledSkillsDir, disabledSkills: [] }

/** `ToolDefinition['execute']` returns the SDK's `ToolResult` union; the skill tool always resolves the string branch. */
function expectStringToolResult(result: ToolResult): string {
  if (typeof result !== 'string') {
    throw new Error(
      'Expected the skill tool to return a string ToolResult, got a structured result instead.',
    )
  }
  return result
}

interface RegisterToolSpy {
  registeredTools: ToolDefinition[]
}

interface OnSpy {
  handlers: Record<string, ExtensionHandler<unknown, unknown>>
}

/** Captures registerTool() and on() calls; other ExtensionAPI members are unused. */
function createFakeExtensionApi(): ExtensionAPI & RegisterToolSpy & OnSpy {
  const registeredTools: ToolDefinition[] = []
  const handlers: Record<string, ExtensionHandler<unknown, unknown>> = {}
  const fake = {
    registeredTools,
    handlers,
    registerTool(tool: ToolDefinition) {
      registeredTools.push(tool)
    },
    on(event: string, handler: ExtensionHandler<unknown, unknown>) {
      handlers[event] = handler
    },
  }
  return fake as unknown as ExtensionAPI & RegisterToolSpy & OnSpy
}

const fakeExtensionContext = {} as ExtensionContext

/** Looks up a registered tool by name; throws if not found so tests fail loudly. */
function findToolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name)
  if (!tool) {
    throw new Error(`Tool not found: ${name}`)
  }
  return tool
}

describe('src/pi.ts systematic_skill tool registration', () => {
  test('registers exactly two tools: systematic_skill and systematic_delegate', async () => {
    const api = createFakeExtensionApi()

    await piExtension(api)

    expect(api.registeredTools).toHaveLength(2)
    expect(api.registeredTools.map((t) => t.name).sort()).toEqual([
      'systematic_delegate',
      'systematic_skill',
    ])
    const registered = api.registeredTools.find(
      (t) => t.name === 'systematic_skill',
    )
    expect(registered).toBeDefined()
    expect(registered?.label).toBe('Systematic Skill')
    expect(registered?.description).toBe(
      buildSkillToolDescription(resolverOptions),
    )
    expect(registered?.promptSnippet).toBe(
      'Use `systematic_skill` to load Systematic skills.',
    )
  })

  test('systematic_skill description lists every discoverable bundled skill by name and description', async () => {
    const api = createFakeExtensionApi()
    await piExtension(api)
    const registered = findToolByName(api.registeredTools, 'systematic_skill')
    const expectedSkills = findSkillsInDir(bundledSkillsDir)
      .filter((skill) => skill.disableModelInvocation !== true)
      .sort((a, b) => a.name.localeCompare(b.name))

    expect(expectedSkills.length).toBeGreaterThan(0)
    expect(registered.description.match(/^- /gm)).toHaveLength(
      expectedSkills.length,
    )
    for (const skill of expectedSkills) {
      expect(registered.description).toContain(
        `- ${formatSkillCommandName(skill.name)}: ${skill.description}`,
      )
    }
  })

  test('omits disabled bundled skills from the Pi systematic_skill description', async () => {
    const api = createFakeExtensionApi()
    await piExtension(api)
    const registered = findToolByName(api.registeredTools, 'systematic_skill')
    const disabledSkills = findSkillsInDir(bundledSkillsDir).filter(
      (skill) => skill.disableModelInvocation === true,
    )

    expect(disabledSkills.length).toBeGreaterThan(0)
    for (const skill of disabledSkills) {
      expect(registered.description).not.toContain(
        `- ${formatSkillCommandName(skill.name)}: ${skill.description}`,
      )
    }
  })

  test('parameters schema exposes the exact shared parameter hint on the name property', async () => {
    const api = createFakeExtensionApi()

    await piExtension(api)

    const registered = findToolByName(api.registeredTools, 'systematic_skill')
    const schema = registered.parameters as unknown as {
      type: string
      required: string[]
      properties: { name: { type: string; description: string } }
    }

    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['name'])
    expect(schema.properties.name.type).toBe('string')
    expect(schema.properties.name.description).toBe(
      buildSkillToolParameterHint(resolverOptions),
    )
  })

  test('execute returns Pi text content byte-identical to the shared skill content output', async () => {
    const api = createFakeExtensionApi()
    await piExtension(api)
    const registered = findToolByName(api.registeredTools, 'systematic_skill')

    const expectedSkill = resolveSkill(resolverOptions, 'ce:plan')
    const expected = buildSkillContentOutput(expectedSkill)

    const result = (await registered.execute(
      'test-tool-call-id',
      { name: 'ce:plan' },
      undefined,
      undefined,
      {} as unknown as Parameters<ToolDefinition['execute']>[4],
    )) as AgentToolResult<{ skillDir: string }>

    expect(result.content).toEqual([{ type: 'text', text: expected.output }])
    expect(result.details.skillDir).toBe(expected.dir)
  })

  test('execute throws the exact shared not-found error text for an unknown skill name', async () => {
    const api = createFakeExtensionApi()
    await piExtension(api)
    const registered = findToolByName(api.registeredTools, 'systematic_skill')

    let thrown: unknown
    try {
      await registered.execute(
        'test-tool-call-id',
        { name: 'nonexistent' },
        undefined,
        undefined,
        {} as unknown as Parameters<ToolDefinition['execute']>[4],
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      (() => {
        try {
          resolveSkill(resolverOptions, 'nonexistent')
          throw new Error('resolveSkill unexpectedly succeeded')
        } catch (error) {
          return (error as Error).message
        }
      })(),
    )
  })

  test('Pi and OpenCode adapters return the same wrapped success content and not-found error text for the same real skill fixture', async () => {
    const api = createFakeExtensionApi()
    await piExtension(api)
    const piTool = findToolByName(api.registeredTools, 'systematic_skill')
    const openCodeTool = createSkillTool({
      bundledSkillsDir,
      disabledSkills: [],
    })

    const metadataCalls: Array<{
      title: string
      metadata: { name: string; dir: string }
    }> = []
    const openCodeContext = {
      ask: async () => {},
      metadata: (payload: {
        title: string
        metadata: { name: string; dir: string }
      }) => {
        metadataCalls.push(payload)
      },
    } as never

    const skillName = 'ce:plan'
    const openCodeResult = await openCodeTool.execute(
      { name: skillName },
      openCodeContext,
    )
    const piResult = (await piTool.execute(
      'test-tool-call-id',
      { name: skillName },
      undefined,
      undefined,
      {} as unknown as Parameters<ToolDefinition['execute']>[4],
    )) as AgentToolResult<{ skillDir: string }>

    expect(piResult.content).toEqual([
      { type: 'text', text: expectStringToolResult(openCodeResult) },
    ])
    expect(metadataCalls).toEqual([
      {
        title: 'Loaded skill: ce:plan',
        metadata: {
          name: 'ce:plan',
          dir: expect.any(String),
        },
      },
    ])
    expect(piResult.details.skillDir).toBe(metadataCalls[0]?.metadata.dir)

    const unknownName = '__missing_skill__'
    const openCodeError = await (async () => {
      try {
        await openCodeTool.execute({ name: unknownName }, openCodeContext)
        throw new Error('openCodeTool.execute unexpectedly succeeded')
      } catch (error) {
        return (error as Error).message
      }
    })()
    const piError = await (async () => {
      try {
        await piTool.execute(
          'test-tool-call-id',
          { name: unknownName },
          undefined,
          undefined,
          {} as unknown as Parameters<ToolDefinition['execute']>[4],
        )
        throw new Error('piTool.execute unexpectedly succeeded')
      } catch (error) {
        return (error as Error).message
      }
    })()

    expect(piError).toBe(openCodeError)
  })
})

describe('src/pi.ts before_agent_start bootstrap injection', () => {
  test('registers exactly one before_agent_start handler', async () => {
    const api = createFakeExtensionApi()
    await piExtension(api)
    expect(api.handlers.before_agent_start).toBeDefined()
  })

  test('emits one constant stderr diagnostic and still initializes when bootstrap computation fails', async () => {
    const api = createFakeExtensionApi()
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(
      () => true,
    )
    const originalReadFileSync = fs.readFileSync
    const readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation(
      // Cast to the overloaded `readFileSync` type: every readFileSync call
      // reachable from piExtension()'s bootstrap computation (src/lib/bootstrap.ts,
      // agent-resolver.ts, config-handler.ts, config.ts) passes an explicit
      // 'utf8'/'utf-8' encoding, so this fixture only needs to honor the
      // string-returning overload; the cast avoids re-declaring all native fs
      // overloads here. (src/lib/setup.ts reads a Buffer via a bare fd with no
      // encoding, but that path is not exercised by piExtension().)
      ((
        path: fs.PathOrFileDescriptor,
        options?: Parameters<typeof fs.readFileSync>[1],
      ): string => {
        const filePath = String(path)
        if (filePath.endsWith('using-systematic/SKILL.md')) {
          throw new Error('bootstrap failure')
        }
        return originalReadFileSync(
          path,
          options as unknown as BufferEncoding,
        ) as string
      }) as unknown as typeof fs.readFileSync,
    )

    await expect(piExtension(api)).resolves.toBeUndefined()

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledWith(
      '[systematic] Failed to compute Pi bootstrap; continuing without injection.\n',
    )
    expect(api.handlers.before_agent_start).toBeDefined()
    expect(api.registeredTools).toHaveLength(2)

    readFileSyncSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  test('continues initialization when catalog construction throws, keeps systematic_skill registered, omits systematic_delegate, and writes the catalog failure diagnostic with a trailing newline', async () => {
    const api = createFakeExtensionApi()
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(
      () => true,
    )

    try {
      await expect(
        piExtension(api, {
          buildAgentCatalog() {
            throw new Error('catalog failure')
          },
        } as never),
      ).resolves.toBeUndefined()

      expect(api.handlers.before_agent_start).toBeDefined()
      expect(api.registeredTools).toHaveLength(1)
      expect(api.registeredTools.map((tool) => tool.name)).toEqual([
        'systematic_skill',
      ])
      expect(
        findToolByName(api.registeredTools, 'systematic_skill'),
      ).toBeDefined()
      expect(() =>
        findToolByName(api.registeredTools, 'systematic_delegate'),
      ).toThrow('Tool not found: systematic_delegate')
      expect(stderrSpy).toHaveBeenCalledTimes(1)
      expect(stderrSpy).toHaveBeenCalledWith(
        '[systematic] Failed to build Pi agent catalog; systematic_delegate will not be registered: catalog failure\n',
      )
    } finally {
      stderrSpy.mockRestore()
    }
  })

  test('an earlier extension contribution remains before exactly one real Systematic bootstrap block', async () => {
    const api = createFakeExtensionApi()
    await piExtension(api)
    const handler = api.handlers.before_agent_start as ExtensionHandler<
      BeforeAgentStartEvent,
      BeforeAgentStartEventResult
    >
    expect(handler).toBeDefined()

    const earlierContribution = 'Earlier extension prompt contribution.'
    const event: BeforeAgentStartEvent = {
      type: 'before_agent_start',
      prompt: 'do the thing',
      systemPrompt: earlierContribution,
      systemPromptOptions: {} as BeforeAgentStartEvent['systemPromptOptions'],
    }

    const result = await handler(event, fakeExtensionContext)

    expect(result).toBeDefined()
    const systemPrompt = (result as BeforeAgentStartEventResult).systemPrompt
    expect(systemPrompt).toBeDefined()
    const prompt = systemPrompt as string

    expect(prompt.indexOf(earlierContribution)).toBe(0)
    const occurrences = prompt.split('<SYSTEMATIC_WORKFLOWS>').length - 1
    expect(occurrences).toBe(1)
    expect(prompt).toContain('</SYSTEMATIC_WORKFLOWS>')
    expect(prompt.indexOf('<SYSTEMATIC_WORKFLOWS>')).toBeGreaterThan(
      prompt.indexOf(earlierContribution),
    )
  })

  test('Pi bootstrap uses native skill guidance and omits the generic skill tool instruction', async () => {
    const api = createFakeExtensionApi()
    await piExtension(api)
    const handler = api.handlers.before_agent_start as ExtensionHandler<
      BeforeAgentStartEvent,
      BeforeAgentStartEventResult
    >
    const event: BeforeAgentStartEvent = {
      type: 'before_agent_start',
      prompt: 'do the thing',
      systemPrompt: 'Earlier extension prompt contribution.',
      systemPromptOptions: {} as BeforeAgentStartEvent['systemPromptOptions'],
    }

    const result = await handler(event, fakeExtensionContext)

    expect(result).toBeDefined()
    const systemPrompt = (result as BeforeAgentStartEventResult)
      .systemPrompt as string
    expect(systemPrompt).toContain(
      'Use `systematic_skill` for Systematic skills.',
    )
    expect(systemPrompt).toContain(
      "For non-Systematic skills, follow Pi's native skill instructions and read the listed SKILL.md path.",
    )
    expect(systemPrompt).not.toContain(
      'Use the skill tool for non-Systematic skills',
    )
  })

  test('Pi handler composes the capability profile exactly once across double-run', async () => {
    const api = createFakeExtensionApi()
    await piExtension(api)
    const handler = api.handlers.before_agent_start as ExtensionHandler<
      BeforeAgentStartEvent,
      BeforeAgentStartEventResult
    >
    const event: BeforeAgentStartEvent = {
      type: 'before_agent_start',
      prompt: 'do the thing',
      systemPrompt: 'Earlier extension prompt contribution.',
      systemPromptOptions: {} as BeforeAgentStartEvent['systemPromptOptions'],
    }

    const first = (await handler(event, fakeExtensionContext))
      ?.systemPrompt as string
    const second = (
      await handler({ ...event, systemPrompt: first }, fakeExtensionContext)
    )?.systemPrompt as string
    const profileMarker = '# Pi Capability Profile'

    expect(second.split(profileMarker)).toHaveLength(2)
    expect(second).toBe(first)
  })
})

describe('OpenCode native skill discovery fallback', () => {
  test('keeps bundled skills in native skills.paths without relying on systematic_skill', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-opencode-skill-paths-'),
    )
    const originalHomedir = os.homedir
    const bundledAgentsDir = path.join(tempDir, 'agents')
    const bundledCommandsDir = path.join(tempDir, 'commands')
    fs.mkdirSync(bundledAgentsDir)
    fs.mkdirSync(bundledCommandsDir)
    os.homedir = () => tempDir

    try {
      const handler = createConfigHandler({
        directory: tempDir,
        bundledSkillsDir,
        bundledAgentsDir,
        bundledCommandsDir,
      })
      const config = {} as Config & { skills?: { paths?: string[] } }

      // Exercise the OpenCode config hook directly; no systematic_skill tool is
      // registered in this test, so native path registration is the fallback.
      await handler(config)

      expect(config.skills?.paths).toEqual([bundledSkillsDir])
    } finally {
      os.homedir = originalHomedir
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('src/pi.ts systematic_delegate tool registration', () => {
  test('registers systematic_delegate with only {agent, task} parameters', async () => {
    const api = createFakeExtensionApi()
    await piExtension(api)

    const delegateTool = api.registeredTools.find(
      (t) => t.name === 'systematic_delegate',
    )
    expect(delegateTool).toBeDefined()
    expect(delegateTool?.executionMode).toBe('sequential')

    const schema = delegateTool?.parameters as unknown as {
      type: string
      required: string[]
      properties: Record<string, unknown>
    }
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties).sort()).toEqual(['agent', 'task'])
    expect(schema.required.sort()).toEqual(['agent', 'task'])
  })

  test('description references real bundled persona names', async () => {
    const api = createFakeExtensionApi()
    await piExtension(api)

    const delegateTool = api.registeredTools.find(
      (t) => t.name === 'systematic_delegate',
    )
    expect(delegateTool?.description).toContain('git-history-analyzer')
  })
})
