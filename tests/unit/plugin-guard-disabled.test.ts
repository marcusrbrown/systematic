import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SRC_DIR = path.resolve(import.meta.dirname, '../../src')
const MARKER = '<SYSTEMATIC_WORKFLOW_GUARD>'
const SESSION = 'guard-off-session'
const CHILD_SESSION = 'guard-off-child'
// Not prefixed `GIT_`: the observer strips every `GIT_*` variable before it
// runs git, so a `GIT_`-named log path would never reach the shim.
const SHIM_LOG_ENV = 'SYSTEMATIC_TEST_GIT_SHIM_LOG'

interface ToolDefinition {
  execute: (args: object, context: object) => Promise<unknown>
}

interface PluginHooks {
  tool: Record<string, ToolDefinition>
  'tool.execute.before': (input: unknown, output: unknown) => Promise<void>
  'tool.execute.after': (input: unknown, output: unknown) => Promise<void>
  event: (input: unknown) => Promise<void>
  'experimental.chat.system.transform': (
    input: unknown,
    output: { system: string[] },
  ) => Promise<void>
}

/** One host tool call as the host sequences it: before, execute, after. */
interface ToolCall {
  readonly title: string
  readonly output: string
  readonly metadata: Record<string, unknown>
}

interface Observed {
  readonly gitCalls: readonly string[]
  readonly messageReads: number
  readonly childReads: number
  readonly systemText: string
}

const WORKFLOW_TOOLS = [
  'systematic_workflow_start',
  'systematic_workflow_status',
  'systematic_workflow_complete',
  'systematic_workflow_control',
] as const

function run(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`)
}

/** A `git` that logs its arguments, then hands off to the real binary. */
function writeGitShim(binDir: string, realGit: string): void {
  fs.mkdirSync(binDir, { recursive: true })
  const shim = path.join(binDir, 'git')
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$${SHIM_LOG_ENV}"\nexec "${realGit}" "$@"\n`,
  )
  fs.chmodSync(shim, 0o755)
}

function toolContext(): object {
  return {
    sessionID: SESSION,
    messageID: 'guard-off-message',
    agent: 'systematic',
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

describe('a plugin whose workflow guard mode is set explicitly', () => {
  let tempDir: string
  let priorConfigDir: string | undefined
  let priorPath: string | undefined
  let priorLog: string | undefined
  let originalHomedir: () => string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-guard-off-'))
    priorConfigDir = process.env.OPENCODE_CONFIG_DIR
    priorPath = process.env.PATH
    priorLog = process.env[SHIM_LOG_ENV]
    // An empty home, so a user-level systematic.json on the machine cannot
    // set the mode a default-asserting run reads.
    originalHomedir = os.homedir
    os.homedir = () => path.join(tempDir, 'home')
  })

  afterEach(() => {
    os.homedir = originalHomedir
    if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    if (priorLog === undefined) delete process.env[SHIM_LOG_ENV]
    else process.env[SHIM_LOG_ENV] = priorLog
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /**
   * Loads the plugin against a real git repository with a logging `git` first
   * on PATH and a client that counts session reads, then drives init, the four
   * workflow tools, the before and after hooks for bash, write and task, an
   * event, and the system transform.
   */
  async function drive(mode: 'disabled' | 'observe'): Promise<
    Observed & {
      readonly toolResults: Record<string, ToolCall>
      readonly completeReplay: ToolCall
    }
  > {
    const project = path.join(tempDir, 'project')
    fs.mkdirSync(path.join(project, '.opencode'), { recursive: true })
    run(project, ['init', '--quiet'])
    run(project, ['config', 'user.email', 'guard-off@example.invalid'])
    run(project, ['config', 'user.name', 'Guard Off'])
    run(project, ['commit', '--quiet', '--allow-empty', '-m', 'initial'])

    const configDir = path.join(tempDir, 'config')
    fs.mkdirSync(configDir)
    fs.writeFileSync(
      path.join(configDir, 'systematic.json'),
      JSON.stringify({ workflow_guard: { mode } }),
    )
    process.env.OPENCODE_CONFIG_DIR = configDir

    const realGit = Bun.which('git')
    if (!realGit) throw new Error('git is required for this test')
    const binDir = path.join(tempDir, 'bin')
    writeGitShim(binDir, realGit)
    const logPath = path.join(tempDir, 'git-calls.log')
    fs.writeFileSync(logPath, '')
    process.env[SHIM_LOG_ENV] = logPath
    process.env.PATH = `${binDir}${path.delimiter}${priorPath ?? ''}`

    let messageReads = 0
    let childReads = 0
    const pluginModule = (await import(
      pathToFileURL(path.join(SRC_DIR, 'index.ts')).href
    )) as { default: (args: object) => Promise<PluginHooks> }
    const hooks = await pluginModule.default({
      client: {
        app: { log: async () => {} },
        session: {
          messages: async () => {
            messageReads += 1
            return { data: [] }
          },
          children: async () => {
            childReads += 1
            return { data: [{ id: CHILD_SESSION, parentID: SESSION }] }
          },
        },
      },
      directory: project,
    })

    // One host tool call: before hook, the tool's own result, then the after
    // hook over that result. `afterRuns` > 1 repeats the after hook, as a
    // duplicate delivery would. Returns what the output held after each run.
    const runTool = async (
      name: (typeof WORKFLOW_TOOLS)[number],
      args: Record<string, unknown>,
      afterRuns = 1,
    ): Promise<ToolCall[]> => {
      const tool = hooks.tool[name]
      if (!tool) throw new Error(`tool not registered: ${name}`)
      const input = {
        tool: name,
        sessionID: SESSION,
        callID: `guard-off-${name}`,
      }
      await hooks['tool.execute.before'](input, { args })
      const result = (await tool.execute(args, toolContext())) as {
        title?: string
        output: string
        metadata?: Record<string, unknown>
      }
      const call = {
        title: result.title ?? '',
        output: result.output,
        metadata: { ...(result.metadata ?? {}) },
      }
      const afterEach: ToolCall[] = []
      for (let run = 0; run < afterRuns; run++) {
        await hooks['tool.execute.after']({ ...input, args }, call)
        afterEach.push({ ...call, metadata: { ...call.metadata } })
      }
      return afterEach
    }
    for (const name of WORKFLOW_TOOLS) {
      expect(hooks.tool[name]).toBeDefined()
    }
    const lastOf = (calls: readonly ToolCall[]): ToolCall => {
      const last = calls.at(-1)
      if (!last) throw new Error('no tool call recorded')
      return last
    }
    const [completeFirst, completeReplay] = await runTool(
      'systematic_workflow_complete',
      { target: 'unit' },
      2,
    )
    if (!completeFirst || !completeReplay) throw new Error('no completion')
    const toolResults: Record<string, ToolCall> = {
      systematic_workflow_start: lastOf(
        await runTool('systematic_workflow_start', {}),
      ),
      systematic_workflow_status: lastOf(
        await runTool('systematic_workflow_status', {}),
      ),
      systematic_workflow_complete: completeFirst,
      systematic_workflow_control: lastOf(
        await runTool('systematic_workflow_control', { mode: 'disabled' }),
      ),
    }

    const calls: Array<{ tool: string; args: object; output: object }> = [
      { tool: 'bash', args: { command: 'echo hi' }, output: { metadata: {} } },
      {
        tool: 'write',
        args: { filePath: 'a.txt', content: 'x' },
        output: { metadata: {} },
      },
      {
        tool: 'task',
        args: {},
        output: { metadata: { sessionId: CHILD_SESSION } },
      },
    ]
    for (const [index, call] of calls.entries()) {
      const input = {
        tool: call.tool,
        sessionID: SESSION,
        callID: `guard-off-call-${index}`,
      }
      await hooks['tool.execute.before'](input, { args: call.args })
      await hooks['tool.execute.after'](
        { ...input, args: call.args },
        {
          title: call.tool,
          output: 'ok',
          ...call.output,
        },
      )
    }
    await hooks.event({
      event: { type: 'session.idle', properties: { sessionID: SESSION } },
    })
    const output = { system: ['base system prompt'] }
    await hooks['experimental.chat.system.transform'](
      { sessionID: SESSION },
      output,
    )

    return {
      gitCalls: fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0),
      messageReads,
      childReads,
      systemText: output.system.join('\n'),
      toolResults,
      completeReplay,
    }
  }

  test('a disabled plugin makes no git call, reads no session, and injects no guard marker', async () => {
    const observed = await drive('disabled')

    expect(observed.gitCalls).toEqual([])
    expect(observed.messageReads).toBe(0)
    expect(observed.childReads).toBe(0)
    expect(observed.systemText).not.toContain(MARKER)
  })

  test('a disabled plugin keeps the four workflow tools registered and answers each one terminally', async () => {
    const { toolResults, completeReplay } = await drive('disabled')
    const result = (name: (typeof WORKFLOW_TOOLS)[number]): ToolCall => {
      const call = toolResults[name]
      if (!call) throw new Error(`no result for ${name}`)
      return call
    }

    expect(
      JSON.parse(result('systematic_workflow_status').output),
    ).toMatchObject({ state: 'disabled' })
    expect(
      result('systematic_workflow_start').metadata.workflowGuard,
    ).toMatchObject({ status: 'rejected', reasonCode: 'disabled' })
    expect(JSON.parse(result('systematic_workflow_complete').output)).toEqual({
      status: 'rejected',
      reasonCode: 'disabled',
    })
    // A duplicate after hook replays the same rejection.
    expect(JSON.parse(completeReplay.output)).toEqual({
      status: 'rejected',
      reasonCode: 'disabled',
    })
    expect(JSON.parse(result('systematic_workflow_control').output)).toEqual({
      status: 'disabled',
    })
  })

  test('control: an observe plugin does reach git, so the shim and counters are live', async () => {
    const observed = await drive('observe')

    expect(observed.gitCalls.length).toBeGreaterThan(0)
    expect(observed.messageReads + observed.childReads).toBeGreaterThan(0)
  })
})

describe('the workflow guard guidance in the OpenCode system prompt', () => {
  // Distinctive wording from the guidance, so a match cannot come from the
  // profile or from the shared skill text.
  const GUIDANCE_OPENING =
    'Check the workflow guard availability once per execution unit.'
  const GUIDANCE_DISABLED_NOTE =
    '`disabled` means the user turned the guard off; do not call the workflow tools.'
  const BLOCK_CLOSE = '</SYSTEMATIC_WORKFLOWS>'
  const PROFILE_HEADING = '# OpenCode Capability Profile'

  let tempDir: string
  let priorConfigDir: string | undefined
  let originalHomedir: () => string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-guidance-'))
    priorConfigDir = process.env.OPENCODE_CONFIG_DIR
    // An empty home, so the default-mode cases cannot read a user config.
    originalHomedir = os.homedir
    os.homedir = () => path.join(tempDir, 'home')
  })

  afterEach(() => {
    os.homedir = originalHomedir
    if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  interface TransformHooks {
    'experimental.chat.system.transform': (
      input: unknown,
      output: { system: string[] },
    ) => Promise<void>
  }

  function occurrences(text: string, needle: string): number {
    return text.split(needle).length - 1
  }

  /**
   * Registers the plugin `registrations` times against one project and runs the
   * system transform of each registration, in order, over one system array.
   * That is what the host does when a plugin is listed twice.
   */
  async function systemPrompt(
    systematicConfig: Record<string, unknown>,
    registrations = 1,
  ): Promise<string> {
    const project = path.join(tempDir, 'project')
    fs.mkdirSync(path.join(project, '.opencode'), { recursive: true })
    const configDir = path.join(tempDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'systematic.json'),
      JSON.stringify(systematicConfig),
    )
    process.env.OPENCODE_CONFIG_DIR = configDir

    const pluginModule = (await import(
      pathToFileURL(path.join(SRC_DIR, 'index.ts')).href
    )) as { default: (args: object) => Promise<TransformHooks> }
    const input = {
      client: { app: { log: async () => {} }, session: {} },
      directory: project,
    }
    const output = { system: ['base system prompt'] }
    for (let index = 0; index < registrations; index++) {
      const hooks = await pluginModule.default(input)
      await hooks['experimental.chat.system.transform'](
        { sessionID: 'guidance-session' },
        output,
      )
    }
    return output.system.join('\n')
  }

  test('an enabled guard puts the guidance in the workflow block once, after the profile and before the marker', async () => {
    const text = await systemPrompt({ workflow_guard: { mode: 'observe' } })

    expect(occurrences(text, GUIDANCE_OPENING)).toBe(1)
    expect(occurrences(text, GUIDANCE_DISABLED_NOTE)).toBe(1)
    const profile = text.indexOf(PROFILE_HEADING)
    const guidance = text.indexOf(GUIDANCE_OPENING)
    const blockClose = text.indexOf(BLOCK_CLOSE)
    const marker = text.indexOf(MARKER)
    expect(profile).toBeGreaterThan(-1)
    expect(marker).toBeGreaterThan(-1)
    expect(guidance).toBeGreaterThan(profile)
    expect(blockClose).toBeGreaterThan(guidance)
    expect(marker).toBeGreaterThan(blockClose)
  })

  test('a protected guard gets the same single copy of the guidance', async () => {
    const text = await systemPrompt({ workflow_guard: { mode: 'protected' } })

    expect(occurrences(text, GUIDANCE_OPENING)).toBe(1)
  })

  test('two registrations in one request still leave one copy of the guidance', async () => {
    const text = await systemPrompt({ workflow_guard: { mode: 'observe' } }, 2)

    expect(occurrences(text, GUIDANCE_OPENING)).toBe(1)
    expect(occurrences(text, '<SYSTEMATIC_WORKFLOWS>')).toBe(1)
    expect(occurrences(text, MARKER)).toBe(1)
  })

  test('a disabled guard leaves the system prompt with no guard text at all', async () => {
    const text = await systemPrompt({ workflow_guard: { mode: 'disabled' } })

    expect(text).toContain('<SYSTEMATIC_WORKFLOWS>')
    expect(text).not.toContain(GUIDANCE_OPENING)
    expect(text).not.toContain(GUIDANCE_DISABLED_NOTE)
    expect(text).not.toContain('systematic_workflow_')
    expect(text).not.toMatch(/workflow guard/i)
    expect(text).not.toContain(MARKER)
  })

  test('a plugin with no workflow_guard setting is disabled and carries no guard text', async () => {
    const text = await systemPrompt({})

    expect(text).toContain('<SYSTEMATIC_WORKFLOWS>')
    expect(text).not.toMatch(/workflow guard/i)
  })

  test('an enabled guard adds no guidance when the bootstrap is turned off', async () => {
    const text = await systemPrompt({
      workflow_guard: { mode: 'observe' },
      bootstrap: { enabled: false },
    })

    expect(text).not.toContain(GUIDANCE_OPENING)
    expect(text).not.toContain('<SYSTEMATIC_WORKFLOWS>')
  })

  test('an enabled guard adds no guidance to a custom bootstrap file', async () => {
    const custom = path.join(tempDir, 'custom-bootstrap.md')
    fs.writeFileSync(custom, 'CUSTOM BOOTSTRAP TEXT')

    const text = await systemPrompt({
      workflow_guard: { mode: 'observe' },
      bootstrap: { enabled: true, file: custom },
    })

    expect(text).toContain('CUSTOM BOOTSTRAP TEXT')
    expect(text).not.toContain(GUIDANCE_OPENING)
    expect(text).not.toContain(PROFILE_HEADING)
  })

  test('an enabled guard still adds the guidance once when the harness profile cannot be read', async () => {
    const realRead = fs.readFileSync.bind(fs)
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (String(file).endsWith('opencode-profile.md')) {
        throw new Error('profile unreadable')
      }
      return (realRead as (...args: unknown[]) => unknown)(file, ...rest)
    }) as typeof fs.readFileSync)
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const text = await systemPrompt({ workflow_guard: { mode: 'observe' } })

      expect(text).not.toContain(PROFILE_HEADING)
      expect(occurrences(text, GUIDANCE_OPENING)).toBe(1)
      expect(text.indexOf(BLOCK_CLOSE)).toBeGreaterThan(
        text.indexOf(GUIDANCE_OPENING),
      )
    } finally {
      readSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})
