import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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

interface Observed {
  readonly gitCalls: readonly string[]
  readonly messageReads: number
  readonly childReads: number
  readonly systemText: string
}

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

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-guard-off-'))
    priorConfigDir = process.env.OPENCODE_CONFIG_DIR
    priorPath = process.env.PATH
    priorLog = process.env[SHIM_LOG_ENV]
  })

  afterEach(() => {
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
  async function drive(
    mode: 'disabled' | 'observe',
  ): Promise<Observed & { readonly toolResults: Record<string, unknown> }> {
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

    const toolResults: Record<string, unknown> = {}
    for (const name of [
      'systematic_workflow_start',
      'systematic_workflow_status',
      'systematic_workflow_complete',
      'systematic_workflow_control',
    ]) {
      const args =
        name === 'systematic_workflow_complete'
          ? { target: 'unit' }
          : name === 'systematic_workflow_control'
            ? { mode: 'disabled' }
            : {}
      toolResults[name] = await hooks.tool[name]?.execute(args, toolContext())
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
    }
  }

  test('a disabled plugin makes no git call, reads no session, and injects no guard marker', async () => {
    const observed = await drive('disabled')

    expect(observed.gitCalls).toEqual([])
    expect(observed.messageReads).toBe(0)
    expect(observed.childReads).toBe(0)
    expect(observed.systemText).not.toContain(MARKER)
  })

  test('control: an observe plugin does reach git, so the shim and counters are live', async () => {
    const observed = await drive('observe')

    expect(observed.gitCalls.length).toBeGreaterThan(0)
  })
})
