import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  spyOn,
  test,
} from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin'

import { setupOpenCodeV2 } from '../../src/lib/opencode-v2.js'
import {
  BOOTSTRAP_ENTRY_KEY,
  BOOTSTRAP_MAX_BYTES,
  OPENCODE_V2_USAGE_TEMPLATE,
} from '../../src/lib/opencode-v2-bootstrap.js'

const PACKAGE_ROOT = path.resolve(import.meta.dir, '../..')
const WORKTREE_RULE = fs
  .readFileSync(
    path.join(
      PACKAGE_ROOT,
      'skills/using-systematic/references/worktree-placement.md',
    ),
    'utf8',
  )
  .trim()

interface PutCall {
  sessionID: string
  key: string
  value: unknown
}

type PromptHook = (event: unknown) => Promise<void> | void

/**
 * A stand-in host with the session members the bootstrap installer uses: the
 * hook registry and the instruction entry store. Every put is logged, and the
 * entries behave the way the host's do: one value per session and key.
 */
function createHost(
  options: {
    directory: string
    putFails?: () => boolean
    /** Refuse registration of the hook with this name. */
    refuseHook?: string
  } = { directory: '/unused' },
) {
  const puts: PutCall[] = []
  const entries = new Map<string, unknown>()
  const hooks: { name: string; callback: PromptHook }[] = []
  const ctx = {
    location: { directory: options.directory },
    command: {
      async list() {
        return { data: [] }
      },
      async transform() {},
    },
    agent: { async transform() {} },
    skill: { async transform() {} },
    tool: { async transform() {} },
    permission: { async assert() {} },
    session: {
      async hook(name: string, callback: PromptHook) {
        if (options.refuseHook === name) {
          throw new Error('hook registration refused')
        }
        hooks.push({ name, callback })
      },
      instructions: {
        entry: {
          async put(input: PutCall) {
            puts.push(input)
            if (options.putFails?.()) throw new Error('put refused')
            entries.set(`${input.sessionID}:${input.key}`, input.value)
          },
        },
      },
    },
  } as unknown as Plugin.Context
  return {
    ctx,
    puts,
    entries,
    hooks,
    promptHooks: () => hooks.filter((candidate) => candidate.name === 'prompt'),
    async prompt(sessionID: unknown) {
      const hook = hooks.find((candidate) => candidate.name === 'prompt')
      await hook?.callback({
        sessionID,
        messageID: 'm',
        prompt: { text: 'hi' },
      })
    },
  }
}

type Host = ReturnType<typeof createHost>

let tempRoot: string
let projectDir: string
let homeDir: string
let errorSpy: Mock<typeof console.error>
let warnSpy: Mock<typeof console.warn>
const ORIGINAL_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR

beforeEach(() => {
  tempRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'oc-v2-bootstrap-'),
  )
  projectDir = path.join(tempRoot, 'project')
  homeDir = path.join(tempRoot, 'home')
  fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true })
  fs.mkdirSync(path.join(homeDir, '.config/opencode'), { recursive: true })
  delete process.env.OPENCODE_CONFIG_DIR
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  warnSpy.mockRestore()
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR
  } else {
    process.env.OPENCODE_CONFIG_DIR = ORIGINAL_CONFIG_DIR
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function writeProjectConfig(content: unknown): void {
  fs.writeFileSync(
    path.join(projectDir, '.opencode/systematic.json'),
    JSON.stringify(content),
  )
}

function errorMessages(): string[] {
  return errorSpy.mock.calls.map((call) => String(call[0]))
}

async function setup(
  config?: unknown,
  hostOptions: Partial<Parameters<typeof createHost>[0]> = {},
) {
  if (config !== undefined) writeProjectConfig(config)
  const host = createHost({ directory: projectDir, ...hostOptions })
  await setupOpenCodeV2(host.ctx, { packageRoot: PACKAGE_ROOT, homeDir })
  return host
}

function firstValue(host: Host): string {
  const value = host.puts[0]?.value
  if (typeof value !== 'string') throw new Error('no string value was put')
  return value
}

describe('bootstrap entry', () => {
  test('the first prompt of a session puts one entry under the stable key', async () => {
    const host = await setup()

    await host.prompt('ses_a')

    expect(host.puts).toHaveLength(1)
    expect(host.puts[0]).toMatchObject({
      sessionID: 'ses_a',
      key: BOOTSTRAP_ENTRY_KEY,
    })
    expect(BOOTSTRAP_ENTRY_KEY).toBe('systematic.bootstrap')
    expect(host.promptHooks()).toHaveLength(1)
    // The prompt hook is the only one the bootstrap uses; the context hook
    // belongs to skill output restoration.
    expect(host.hooks.map((hook) => hook.name).sort()).toEqual([
      'context',
      'prompt',
    ])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('the value is the composed bootstrap with the v2 profile and the v2 usage template', async () => {
    const host = await setup()

    await host.prompt('ses_a')

    const value = firstValue(host)
    expect(value).toStartWith('<SYSTEMATIC_WORKFLOWS>')
    expect(value).toEndWith('</SYSTEMATIC_WORKFLOWS>')
    expect(value).toContain('# OpenCode v2 Capability Profile')
    expect(value).toContain(OPENCODE_V2_USAGE_TEMPLATE)
    expect(value).toContain(WORKTREE_RULE)
    // None of the v1 profile's mechanisms.
    expect(value).not.toContain('# OpenCode Capability Profile')
    expect(value).not.toContain('task({')
    // The delegation names appear only in the line that maps them to v2.
    expect(value).not.toContain('subagent_type: ')
    // The profile is inlined once.
    expect(value.split('# OpenCode v2 Capability Profile')).toHaveLength(2)
  })

  test('later prompts of the same session put nothing more', async () => {
    const host = await setup()

    await host.prompt('ses_a')
    await host.prompt('ses_a')
    await host.prompt('ses_a')

    expect(host.puts).toHaveLength(1)
  })

  test('another session, such as a subagent, gets its own entry with the same value', async () => {
    const host = await setup()

    await host.prompt('ses_parent')
    await host.prompt('ses_child')

    expect(host.puts.map((put) => put.sessionID)).toEqual([
      'ses_parent',
      'ses_child',
    ])
    expect(host.puts[1]?.value).toBe(host.puts[0]?.value)
  })

  test('bootstrap.enabled false registers no hook and puts nothing', async () => {
    const host = await setup({ bootstrap: { enabled: false } })

    await host.prompt('ses_a')

    expect(host.promptHooks()).toHaveLength(0)
    expect(host.puts).toHaveLength(0)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('git-worktree in disabled_skills leaves out the worktree rule', async () => {
    const host = await setup({ disabled_skills: ['git-worktree'] })

    await host.prompt('ses_a')

    const value = firstValue(host)
    expect(value).not.toContain(WORKTREE_RULE)
    expect(value).toContain('# OpenCode v2 Capability Profile')
  })

  test('a custom bootstrap.file is put verbatim, with no rule and no profile', async () => {
    const custom = path.join(tempRoot, 'custom-bootstrap.md')
    fs.writeFileSync(custom, 'CUSTOM BOOTSTRAP BODY')
    const host = await setup({ bootstrap: { enabled: true, file: custom } })

    await host.prompt('ses_a')

    expect(host.puts[0]?.value).toBe('CUSTOM BOOTSTRAP BODY')
  })

  test('a changed bootstrap is put again under the same key by the next setup', async () => {
    const first = await setup()
    await first.prompt('ses_a')
    const second = await setup({ disabled_skills: ['git-worktree'] })
    await second.prompt('ses_a')

    expect(second.puts[0]?.key).toBe(first.puts[0]?.key)
    expect(second.puts[0]?.value).not.toBe(first.puts[0]?.value)
  })

  test('a prompt event without a session id puts nothing and does not throw', async () => {
    const host = await setup()

    for (const bad of [undefined, null, 3, {}, { sessionID: 5 }, 'text']) {
      const hook = host.promptHooks()[0]
      await expect(
        Promise.resolve(hook?.callback(bad)),
      ).resolves.toBeUndefined()
    }

    expect(host.puts).toHaveLength(0)
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('a put that fails', () => {
  test('is reported once, never thrown, and retried on the next prompt', async () => {
    let failures = 2
    const host = await setup(undefined, {
      putFails: () => failures-- > 0,
    })

    await host.prompt('ses_a')
    await host.prompt('ses_a')
    await host.prompt('ses_a')
    await host.prompt('ses_a')

    // Two refused, one that went through, then nothing more to do.
    expect(host.puts).toHaveLength(3)
    expect(host.entries.has(`ses_a:${BOOTSTRAP_ENTRY_KEY}`)).toBe(true)
    const notes = errorMessages().filter((message) =>
      message.includes('put refused'),
    )
    expect(notes).toHaveLength(1)
    expect(notes[0]).toStartWith('systematic: ')
    expect(notes[0]).toContain('bootstrap')
  })

  test('does not stop the next session from getting its entry', async () => {
    let calls = 0
    const host = await setup(undefined, { putFails: () => calls++ === 0 })

    await host.prompt('ses_a')
    await host.prompt('ses_b')

    expect(host.entries.has(`ses_a:${BOOTSTRAP_ENTRY_KEY}`)).toBe(false)
    expect(host.entries.has(`ses_b:${BOOTSTRAP_ENTRY_KEY}`)).toBe(true)
  })

  test('a hook registration that is refused leaves setup alive with a diagnostic', async () => {
    await expect(
      setup(undefined, { refuseHook: 'prompt' }),
    ).resolves.toBeDefined()

    const notes = errorMessages().filter((message) =>
      message.includes('hook registration refused'),
    )
    expect(notes).toHaveLength(1)
    expect(notes[0]).toStartWith('systematic: ')
  })
})

describe('the size limit', () => {
  test('a bootstrap over the limit is not injected, with one diagnostic', async () => {
    const custom = path.join(tempRoot, 'huge-bootstrap.md')
    fs.writeFileSync(custom, 'x'.repeat(BOOTSTRAP_MAX_BYTES + 1))
    const host = await setup({ bootstrap: { enabled: true, file: custom } })

    await host.prompt('ses_a')

    expect(host.promptHooks()).toHaveLength(0)
    expect(host.puts).toHaveLength(0)
    const notes = errorMessages().filter((message) =>
      message.includes('bootstrap'),
    )
    expect(notes).toHaveLength(1)
    expect(notes[0]).toStartWith('systematic: ')
    expect(notes[0]).toContain(String(BOOTSTRAP_MAX_BYTES))
  })

  test('a bootstrap just under the limit is injected', async () => {
    const custom = path.join(tempRoot, 'big-bootstrap.md')
    // The value is JSON text, so the quotes around it count.
    fs.writeFileSync(custom, 'x'.repeat(BOOTSTRAP_MAX_BYTES - 2))
    const host = await setup({ bootstrap: { enabled: true, file: custom } })

    await host.prompt('ses_a')

    expect(host.puts).toHaveLength(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('the limit counts bytes, not characters', async () => {
    const custom = path.join(tempRoot, 'multibyte-bootstrap.md')
    // Three bytes per character: well under the limit in characters.
    fs.writeFileSync(custom, '€'.repeat(Math.ceil(BOOTSTRAP_MAX_BYTES / 3)))
    const host = await setup({ bootstrap: { enabled: true, file: custom } })

    await host.prompt('ses_a')

    expect(host.puts).toHaveLength(0)
    expect(errorMessages().filter((m) => m.includes('bootstrap'))).toHaveLength(
      1,
    )
  })

  test('the default bootstrap is far below the limit', async () => {
    const host = await setup()

    await host.prompt('ses_a')

    const bytes = new TextEncoder().encode(
      JSON.stringify(firstValue(host)),
    ).length
    expect(bytes).toBeLessThan(BOOTSTRAP_MAX_BYTES / 10)
  })
})

describe('memory', () => {
  test('many sessions keep working, and a session pushed out of memory is put again harmlessly', async () => {
    const host = await setup()

    for (let index = 0; index < 1500; index++) await host.prompt(`ses_${index}`)
    expect(host.puts).toHaveLength(1500)

    // The oldest session was forgotten: its next prompt puts the same value
    // again, which the host treats as no change.
    await host.prompt('ses_0')
    expect(host.puts).toHaveLength(1501)
    expect(host.puts[1500]?.value).toBe(host.puts[0]?.value)

    // A recent session is still remembered.
    await host.prompt('ses_1499')
    expect(host.puts).toHaveLength(1501)
  })
})

describe('the v2 usage template', () => {
  test('names only tools registered on v2, and their parameters', () => {
    // systematic_skill is registered on v2 and takes `arguments`; the host's
    // skill tool exists there and takes an `id`.
    const tools = new Set(
      [...OPENCODE_V2_USAGE_TEMPLATE.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)].map(
        (match) => match[1],
      ),
    )
    expect([...tools].sort()).toEqual([
      'arguments',
      'id',
      'skill',
      'systematic_skill',
    ])
  })

  test('keeps the naming rules the v1 template states', () => {
    expect(OPENCODE_V2_USAGE_TEMPLATE).toContain('`systematic:` prefix')
    expect(OPENCODE_V2_USAGE_TEMPLATE).toContain('`ce:brainstorm`')
  })

  test('says the skill tool takes an id and systematic_skill takes arguments', () => {
    expect(OPENCODE_V2_USAGE_TEMPLATE).toMatch(/`skill`.*`id`/)
    expect(OPENCODE_V2_USAGE_TEMPLATE).toContain('`arguments`')
  })
})
