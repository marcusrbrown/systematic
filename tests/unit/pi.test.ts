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
import {
  type AgentCatalogEntry,
  buildAgentCatalog,
} from '../../src/lib/agent-resolver.ts'
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
    const [firstMetadataCall] = metadataCalls
    if (!firstMetadataCall) throw new Error('expected a recorded metadata call')
    expect(piResult.details.skillDir).toBe(firstMetadataCall.metadata.dir)

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

// `messageType` exists only in newer Pi releases; assigning a variable (not a literal) skips the excess-property check, so one fixture types on both.
function userEvent(systemPrompt: string): BeforeAgentStartEvent {
  const event = {
    type: 'before_agent_start' as const,
    messageType: 'user' as const,
    prompt: 'do the thing',
    systemPrompt,
    systemPromptOptions: {} as BeforeAgentStartEvent['systemPromptOptions'],
  }
  return event
}

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
    const event = userEvent(earlierContribution)

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
    const event = userEvent('Earlier extension prompt contribution.')

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
    const event = userEvent('Earlier extension prompt contribution.')

    const first = (await handler(event, fakeExtensionContext))
      ?.systemPrompt as string
    const second = (
      await handler({ ...event, systemPrompt: first }, fakeExtensionContext)
    )?.systemPrompt as string
    const profileMarker = '# Pi Capability Profile'

    expect(second.split(profileMarker)).toHaveLength(2)
    expect(second).toBe(first)
  })

  test('a run started by a custom message, which carries no prompt, still gets the bootstrap', async () => {
    const api = createFakeExtensionApi()
    await piExtension(api)
    // Typed on `unknown`: a prompt-less custom event is not a `BeforeAgentStartEvent` in older Pi releases.
    const handler = api.handlers.before_agent_start as ExtensionHandler<
      unknown,
      BeforeAgentStartEventResult
    >
    const earlierContribution = 'Earlier extension prompt contribution.'

    const result = await handler(
      {
        type: 'before_agent_start',
        messageType: 'custom',
        message: {
          role: 'custom',
          customType: 'note',
          content: 'a custom message',
          display: true,
          timestamp: 0,
        },
        systemPrompt: earlierContribution,
        systemPromptOptions: {},
      },
      fakeExtensionContext,
    )

    const prompt = (result as BeforeAgentStartEventResult)
      .systemPrompt as string
    expect(prompt.indexOf(earlierContribution)).toBe(0)
    expect(prompt.split('<SYSTEMATIC_WORKFLOWS>')).toHaveLength(2)
    expect(prompt).toContain('# Pi Capability Profile')
  })
})

describe('src/pi.ts config loading', () => {
  test('a user config that still carries the removed workflow_guard key loads and warns once, naming the file and no value', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-pi-removed-key-'),
    )
    const originalHomedir = os.homedir
    const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_DIR
    os.homedir = () => tempDir
    const configFile = path.join(
      tempDir,
      '.config',
      'opencode',
      'systematic.json',
    )
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(
      configFile,
      JSON.stringify({ workflow_guard: { mode: 'SENTINEL_PI_VALUE' } }),
    )
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await piExtension(createFakeExtensionApi())

      const messages = warnSpy.mock.calls.map((call) => String(call[0]))
      const removed = messages.filter((message) =>
        message.includes('workflow_guard'),
      )
      expect(removed).toHaveLength(1)
      expect(removed[0]).toContain(configFile)
      expect(removed[0]).not.toContain('SENTINEL_PI_VALUE')
    } finally {
      warnSpy.mockRestore()
      os.homedir = originalHomedir
      if (originalConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR
      } else {
        process.env.OPENCODE_CONFIG_DIR = originalConfigDir
      }
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
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

describe('src/pi.ts disabled skills and agents', () => {
  const bundledAgentsDir = fileURLToPath(
    new URL('../../agents', import.meta.url),
  )
  const catalog = buildAgentCatalog(bundledAgentsDir)
  // The first persona by name appears in the delegate's parameter hint, so a
  // hint that stops naming it is observable; the second stays enabled.
  const disabledPersona = catalog[0] as AgentCatalogEntry
  const enabledPersona = catalog[1] as AgentCatalogEntry
  const DISABLED_SKILL = 'ce:brainstorm'
  const ENABLED_SKILL = 'ce:plan'

  interface PiConfigFiles {
    /** Written to the user config file. */
    user?: Record<string, unknown>
    /** Written to `<cwd>/.opencode/systematic.json`. */
    project?: Record<string, unknown>
  }

  /** Runs the extension against isolated config: no ambient user config reaches it. */
  async function loadPiTools(
    files: PiConfigFiles = {},
    deps?: Parameters<typeof piExtension>[1],
  ): Promise<ToolDefinition[]> {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-pi-disable-'),
    )
    const originalHomedir = os.homedir
    const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
    const originalCwd = process.cwd()
    const projectDir = path.join(tempDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    delete process.env.OPENCODE_CONFIG_DIR
    os.homedir = () => tempDir
    if (files.user !== undefined) {
      const userFile = path.join(
        tempDir,
        '.config',
        'opencode',
        'systematic.json',
      )
      fs.mkdirSync(path.dirname(userFile), { recursive: true })
      fs.writeFileSync(userFile, JSON.stringify(files.user))
    }
    if (files.project !== undefined) {
      const projectFile = path.join(projectDir, '.opencode', 'systematic.json')
      fs.mkdirSync(path.dirname(projectFile), { recursive: true })
      fs.writeFileSync(projectFile, JSON.stringify(files.project))
    }
    process.chdir(projectDir)

    try {
      const api = createFakeExtensionApi()
      await piExtension(api, deps)
      return api.registeredTools
    } finally {
      process.chdir(originalCwd)
      os.homedir = originalHomedir
      if (originalConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR
      } else {
        process.env.OPENCODE_CONFIG_DIR = originalConfigDir
      }
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }

  const toolContext = {
    cwd: os.tmpdir(),
    model: undefined,
    modelRegistry: { find: () => undefined },
  } as unknown as Parameters<ToolDefinition['execute']>[4]

  /** The text of the `name` / `agent` parameter hint. */
  function parameterHint(tool: ToolDefinition, parameter: string): string {
    const schema = tool.parameters as unknown as {
      properties: Record<string, { description: string }>
    }
    return schema.properties[parameter]?.description ?? ''
  }

  async function executeError(
    tool: ToolDefinition,
    params: Record<string, string>,
  ): Promise<string> {
    try {
      await tool.execute(
        'test-tool-call-id',
        params,
        undefined,
        undefined,
        toolContext,
      )
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('execute unexpectedly succeeded')
  }

  describe('skills', () => {
    test('with no disable settings the skill is listed, hinted and loadable', async () => {
      const tools = await loadPiTools()
      const skillTool = findToolByName(tools, 'systematic_skill')

      expect(skillTool.description).toContain(`- ${DISABLED_SKILL}:`)
      expect(parameterHint(skillTool, 'name')).toContain(DISABLED_SKILL)
    })

    test.each([
      ['user config', { user: { disabled_skills: [DISABLED_SKILL] } }],
      ['project config', { project: { disabled_skills: [DISABLED_SKILL] } }],
    ])(
      'a disabled skill in %s leaves the Pi systematic_skill description, hint and loader',
      async (_label, files) => {
        const tools = await loadPiTools(files)
        const skillTool = findToolByName(tools, 'systematic_skill')
        const expectedOptions = {
          bundledSkillsDir,
          disabledSkills: [DISABLED_SKILL],
        }

        expect(skillTool.description).toBe(
          buildSkillToolDescription(expectedOptions),
        )
        expect(skillTool.description).not.toContain(`- ${DISABLED_SKILL}:`)
        expect(parameterHint(skillTool, 'name')).toBe(
          buildSkillToolParameterHint(expectedOptions),
        )
        expect(parameterHint(skillTool, 'name')).not.toContain(DISABLED_SKILL)
        expect(await executeError(skillTool, { name: DISABLED_SKILL })).toBe(
          await executeError(skillTool, { name: 'nonexistent' }).then(
            (message) =>
              message.replace('"nonexistent"', `"${DISABLED_SKILL}"`),
          ),
        )
      },
    )

    test('an enabled skill still loads when another skill is disabled', async () => {
      const tools = await loadPiTools({
        user: { disabled_skills: [DISABLED_SKILL] },
      })
      const skillTool = findToolByName(tools, 'systematic_skill')
      const expected = buildSkillContentOutput(
        resolveSkill(resolverOptions, ENABLED_SKILL),
      )

      const result = (await skillTool.execute(
        'test-tool-call-id',
        { name: ENABLED_SKILL },
        undefined,
        undefined,
        toolContext,
      )) as AgentToolResult<{ skillDir: string }>

      expect(result.content).toEqual([{ type: 'text', text: expected.output }])
    })

    test('a known-removed skill name warns and changes nothing else', async () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const baseline = findToolByName(await loadPiTools(), 'systematic_skill')
        const tools = await loadPiTools({
          user: { disabled_skills: ['todo-create'] },
        })
        const skillTool = findToolByName(tools, 'systematic_skill')

        const warnings = warnSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((message) => message.includes('todo-create'))
        expect(warnings).toHaveLength(1)
        expect(skillTool.description).toBe(baseline.description)
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  describe('personas', () => {
    const rows: [
      string,
      (entry: AgentCatalogEntry) => Record<string, unknown>,
    ][] = [
      ['a bare disabled_agents entry', (e) => ({ disabled_agents: [e.key] })],
      [
        'a qualified disabled_agents entry',
        (e) => ({ disabled_agents: [e.id] }),
      ],
      [
        'a bare agents overlay with disable: true',
        (e) => ({ agents: { [e.key]: { disable: true } } }),
      ],
      [
        'a qualified agents overlay with disable: true',
        (e) => ({ agents: { [e.id]: { disable: true } } }),
      ],
    ]

    function delegateTool(tools: ToolDefinition[]): ToolDefinition {
      return findToolByName(tools, 'systematic_delegate')
    }

    test('with no disable settings every persona is listed, hinted and resolvable', async () => {
      const tool = delegateTool(await loadPiTools())

      expect(tool.description).toContain(`- ${disabledPersona.name}:`)
      expect(parameterHint(tool, 'agent')).toContain(
        `'${disabledPersona.name}'`,
      )
      expect(
        await executeError(tool, { agent: disabledPersona.name, task: 'x' }),
      ).not.toContain('Unknown persona')
    })

    test.each(rows)(
      '%s removes the persona from the delegate description, hint and lookup',
      async (_label, build) => {
        const tool = delegateTool(
          await loadPiTools({ user: build(disabledPersona) }),
        )

        expect(tool.description).not.toContain(`- ${disabledPersona.name}:`)
        expect(tool.description).toContain(`- ${enabledPersona.name}:`)
        expect(parameterHint(tool, 'agent')).not.toContain(
          `'${disabledPersona.name}'`,
        )
        const error = await executeError(tool, {
          agent: disabledPersona.name,
          task: 'x',
        })
        expect(error).toContain(`Unknown persona "${disabledPersona.name}"`)
        const available = error.split('Available personas: ')[1]?.split(', ')
        expect(available).not.toContain(disabledPersona.name)
        expect(available).toContain(enabledPersona.name)
      },
    )

    test.each(rows)(
      'with %s an enabled persona still resolves',
      async (_label, build) => {
        const tool = delegateTool(
          await loadPiTools({ user: build(disabledPersona) }),
        )

        // Resolution succeeds and routing then stops at the missing parent model.
        const error = await executeError(tool, {
          agent: enabledPersona.name,
          task: 'x',
        })
        expect(error).not.toContain('Unknown persona')
        expect(error).toContain('no model is available')
      },
    )

    test('a persona disabled in project config is removed too', async () => {
      const tool = delegateTool(
        await loadPiTools({
          project: { disabled_agents: [disabledPersona.key] },
        }),
      )

      expect(tool.description).not.toContain(`- ${disabledPersona.name}:`)
    })

    test('a bare and a qualified overlay for one persona disable it when only one sets disable', async () => {
      const tool = delegateTool(
        await loadPiTools({
          user: {
            agents: {
              [disabledPersona.key]: { disable: false },
              [disabledPersona.id]: { disable: true },
            },
          },
        }),
      )

      expect(tool.description).not.toContain(`- ${disabledPersona.name}:`)
    })

    test('disabling every persona registers the delegate tool with an empty catalog', async () => {
      const tools = await loadPiTools({
        user: { disabled_agents: catalog.map((entry) => entry.key) },
      })
      const tool = delegateTool(tools)

      expect(tool.description).toContain(
        'No Systematic personas are currently available.',
      )
      const error = await executeError(tool, {
        agent: enabledPersona.name,
        task: 'x',
      })
      expect(error).toMatch(/Unknown persona .*Available personas: $/)
    })

    test('a known-removed agent name warns and changes nothing else', async () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const baseline = delegateTool(await loadPiTools())
        const tool = delegateTool(
          await loadPiTools({ user: { disabled_agents: ['lint'] } }),
        )

        const warnings = warnSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((message) => message.includes('"lint"'))
        expect(warnings).toHaveLength(1)
        expect(tool.description).toBe(baseline.description)
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('the filter also applies to a catalog built by an injected dependency', async () => {
      const injected = [disabledPersona, enabledPersona]
      const tool = delegateTool(
        await loadPiTools(
          { user: { disabled_agents: [disabledPersona.key] } },
          { buildAgentCatalog: () => injected },
        ),
      )

      expect(tool.description).not.toContain(`- ${disabledPersona.name}:`)
      expect(tool.description).toContain(`- ${enabledPersona.name}:`)
    })

    test('the bundled catalog builder itself stays config-neutral', () => {
      expect(catalog.some((entry) => entry.key === disabledPersona.key)).toBe(
        true,
      )
    })
  })
})
