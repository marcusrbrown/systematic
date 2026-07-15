import { describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
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
import {
  buildSkillContentOutput,
  buildSkillToolDescription,
  buildSkillToolParameterHint,
  resolveSkill,
} from '../../src/lib/skill-resolver.ts'
import { createSkillTool } from '../../src/lib/skill-tool.ts'
import piExtension from '../../src/pi.ts'

const bundledSkillsDir = fileURLToPath(new URL('../../skills', import.meta.url))
const resolverOptions = { bundledSkillsDir, disabledSkills: [] }

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
  })

  test('parameters schema exposes the exact shared parameter hint on the name property', async () => {
    const api = createFakeExtensionApi()

    await piExtension(api)

    const [registered] = api.registeredTools
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
    const [registered] = api.registeredTools

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
    const [registered] = api.registeredTools

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
    const [piTool] = api.registeredTools
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

    expect(piResult.content).toEqual([{ type: 'text', text: openCodeResult }])
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
    const readFileSyncSpy = spyOn(fs, 'readFileSync')
      .mockImplementationOnce(() => {
        throw new Error('bootstrap failure')
      })
      .mockImplementation((...args) => {
        return originalReadFileSync(...args)
      })

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
