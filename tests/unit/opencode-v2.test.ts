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

import SystematicPlugin from '../../src/index.js'
import {
  createSafeGuard,
  type OpenCodeV2Deps,
  setupOpenCodeV2,
  type V2Installer,
  type V2Snapshot,
} from '../../src/lib/opencode-v2.js'

const PACKAGE_ROOT = path.resolve(import.meta.dir, '../..')

interface FakeEditor {
  entries: Map<string, string>
  update(id: string, value: string): void
}

function createFakeEditor(): FakeEditor {
  const entries = new Map<string, string>()
  return {
    entries,
    update(id, value) {
      entries.set(id, value)
    },
  }
}

/**
 * A stand-in for the host context: just the members the scaffold reads
 * (`location`, `session`) and one transform registry so installers can
 * subscribe. Registered callbacks are kept so a test can replay them.
 */
interface FakeContext {
  ctx: Plugin.Context
  transforms: ((editor: FakeEditor) => unknown)[]
}

function createFakeContext(directory: string | undefined): FakeContext {
  const transforms: ((editor: FakeEditor) => unknown)[] = []
  const fake = {
    location: directory === undefined ? {} : { directory },
    session: {},
    agent: {
      transform(callback: (editor: FakeEditor) => unknown) {
        transforms.push(callback)
      },
    },
  }
  return { ctx: fake as unknown as Plugin.Context, transforms }
}

let tempRoot: string
let projectDir: string
let homeDir: string
let errorSpy: Mock<typeof console.error>
let warnSpy: Mock<typeof console.warn>
const ORIGINAL_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR

beforeEach(() => {
  tempRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'oc-v2-scaffold-'),
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

function writeProjectConfig(content: unknown): string {
  const configPath = path.join(projectDir, '.opencode/systematic.json')
  fs.writeFileSync(
    configPath,
    typeof content === 'string' ? content : JSON.stringify(content),
  )
  return configPath
}

function writeHomeProjectConfig(content: unknown): void {
  fs.mkdirSync(path.join(homeDir, '.opencode'), { recursive: true })
  fs.writeFileSync(
    path.join(homeDir, '.opencode/systematic.json'),
    JSON.stringify(content),
  )
}

function deps(overrides: Partial<OpenCodeV2Deps> = {}): OpenCodeV2Deps {
  return { packageRoot: PACKAGE_ROOT, homeDir, ...overrides }
}

function errorMessages(): string[] {
  return errorSpy.mock.calls.map((call) => String(call[0]))
}

describe('createSafeGuard', () => {
  test('passes arguments and return values through a sync callback', () => {
    const guard = createSafeGuard()
    const wrapped = guard.sync('add', (a: number, b: number) => a + b)
    expect(wrapped(2, 3)).toBe(5)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('a throwing sync callback returns undefined and reports with the systematic prefix', () => {
    const guard = createSafeGuard()
    const wrapped = guard.sync('agent transform', () => {
      throw new Error('boom')
    })
    expect(wrapped()).toBeUndefined()
    expect(errorMessages()).toEqual([
      'systematic: agent transform failed: boom',
    ])
  })

  test('a rejecting async callback resolves to undefined and reports', async () => {
    const guard = createSafeGuard()
    const wrapped = guard.async('prompt hook', async () => {
      throw new Error('late boom')
    })
    await expect(wrapped()).resolves.toBeUndefined()
    expect(errorMessages()).toEqual([
      'systematic: prompt hook failed: late boom',
    ])
  })

  test('a synchronously throwing async-guarded callback is also caught', async () => {
    const guard = createSafeGuard()
    const wrapped = guard.async('hook', (() => {
      throw new Error('sync boom')
    }) as () => Promise<void>)
    await expect(wrapped()).resolves.toBeUndefined()
    expect(errorMessages()).toEqual(['systematic: hook failed: sync boom'])
  })

  test('reports a non-Error throw without leaking object contents', () => {
    const guard = createSafeGuard()
    const wrapped = guard.sync('weird', () => {
      throw { token: 'secret-value' }
    })
    expect(wrapped()).toBeUndefined()
    expect(errorMessages()).toHaveLength(1)
    expect(errorMessages()[0]).toStartWith('systematic: weird failed:')
    expect(errorMessages()[0]).not.toContain('secret-value')
  })
})

describe('setupOpenCodeV2', () => {
  test('loads config once and hands every installer the same snapshot', async () => {
    writeProjectConfig({ bootstrap: { enabled: false } })
    const seen: Record<string, V2Snapshot> = {}
    const record =
      (slot: string): V2Installer =>
      ({ snapshot }) => {
        seen[slot] = snapshot
      }
    const { ctx } = createFakeContext(projectDir)

    await setupOpenCodeV2(
      ctx,
      deps({
        installers: {
          agents: record('agents'),
          skills: record('skills'),
          commands: record('commands'),
          bootstrap: record('bootstrap'),
        },
      }),
    )

    const snapshot = seen.agents
    expect(snapshot).toBeDefined()
    expect(seen.skills).toBe(snapshot as V2Snapshot)
    expect(seen.commands).toBe(snapshot as V2Snapshot)
    expect(seen.bootstrap).toBe(snapshot as V2Snapshot)
    // The project config is the source of the snapshot.
    expect(snapshot?.config.bootstrap.enabled).toBe(false)
    expect(snapshot?.bootstrapContent).toBeNull()
    expect(snapshot?.directory).toBe(projectDir)
    // The asset plan is built from the bundled assets.
    expect(Object.keys(snapshot?.plan.agents ?? {}).length).toBeGreaterThan(0)
    expect(snapshot?.plan.enabledSkills.length).toBeGreaterThan(0)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('builds the bootstrap content once when bootstrap is enabled', async () => {
    let captured: V2Snapshot | undefined
    const { ctx } = createFakeContext(projectDir)

    await setupOpenCodeV2(
      ctx,
      deps({
        installers: {
          bootstrap: ({ snapshot }) => {
            captured = snapshot
          },
        },
      }),
    )

    expect(typeof captured?.bootstrapContent).toBe('string')
    expect(captured?.bootstrapContent).toContain('SYSTEMATIC_WORKFLOWS')
  })

  test('a config edit after setup is not picked up, but a new setup sees it', async () => {
    const configPath = writeProjectConfig({ bootstrap: { enabled: false } })
    const first = createFakeContext(projectDir)
    let firstSnapshot: V2Snapshot | undefined
    const capture: V2Installer = ({ snapshot }) => {
      firstSnapshot = snapshot
    }
    await setupOpenCodeV2(first.ctx, deps({ installers: { agents: capture } }))

    fs.writeFileSync(
      configPath,
      JSON.stringify({ bootstrap: { enabled: true } }),
    )

    // The captured snapshot is the only state a later callback can read.
    expect(firstSnapshot?.config.bootstrap.enabled).toBe(false)
    expect(firstSnapshot?.bootstrapContent).toBeNull()

    let secondSnapshot: V2Snapshot | undefined
    const second = createFakeContext(projectDir)
    await setupOpenCodeV2(
      second.ctx,
      deps({
        installers: {
          agents: ({ snapshot }) => {
            secondSnapshot = snapshot
          },
        },
      }),
    )
    expect(secondSnapshot?.config.bootstrap.enabled).toBe(true)
    expect(firstSnapshot?.config.bootstrap.enabled).toBe(false)
  })

  test('no project directory loads user-level config only and reports one diagnostic', async () => {
    // Project configs that must not be read: the project's own, and the one
    // under the home directory that discovery is rooted at without a project.
    writeProjectConfig({ bootstrap: { enabled: false } })
    writeHomeProjectConfig({ bootstrap: { enabled: false } })
    fs.writeFileSync(
      path.join(homeDir, '.config/opencode/systematic.json'),
      JSON.stringify({ skills_as_commands: false }),
    )
    let captured: V2Snapshot | undefined
    const { ctx } = createFakeContext(undefined)

    await setupOpenCodeV2(
      ctx,
      deps({
        installers: {
          agents: ({ snapshot }) => {
            captured = snapshot
          },
        },
      }),
    )

    expect(captured?.config.skills_as_commands).toBe(false)
    expect(captured?.config.bootstrap.enabled).toBe(true)
    expect(errorMessages()).toHaveLength(1)
    expect(errorMessages()[0]).toStartWith('systematic: ')
    expect(errorMessages()[0]).toContain('project directory')
  })

  test('an empty project directory is treated as missing', async () => {
    writeProjectConfig({ bootstrap: { enabled: false } })
    writeHomeProjectConfig({ bootstrap: { enabled: false } })
    let captured: V2Snapshot | undefined
    const { ctx } = createFakeContext('')

    await setupOpenCodeV2(
      ctx,
      deps({
        installers: {
          agents: ({ snapshot }) => {
            captured = snapshot
          },
        },
      }),
    )

    expect(captured?.config.bootstrap.enabled).toBe(true)
    expect(errorMessages()).toHaveLength(1)
  })

  test('invalid config rejects setup with the named message and installs nothing', async () => {
    const configPath = writeProjectConfig('{ "bootstrap": ')
    const installed: string[] = []
    const { ctx } = createFakeContext(projectDir)

    const outcome = setupOpenCodeV2(
      ctx,
      deps({
        installers: {
          agents: () => {
            installed.push('agents')
          },
          bootstrap: () => {
            installed.push('bootstrap')
          },
        },
      }),
    )

    await expect(outcome).rejects.toThrow(
      `Invalid Systematic config in ${configPath}`,
    )
    expect(installed).toEqual([])
  })

  test('a config that parses but fails the schema rejects setup', async () => {
    const configPath = writeProjectConfig({ disabled_skills: 'not-a-list' })
    const { ctx } = createFakeContext(projectDir)

    await expect(setupOpenCodeV2(ctx, deps())).rejects.toThrow(
      `Invalid Systematic config in ${configPath}`,
    )
  })

  test('a throwing installer is caught and later installers still run', async () => {
    const order: string[] = []
    const { ctx } = createFakeContext(projectDir)

    await setupOpenCodeV2(
      ctx,
      deps({
        installers: {
          agents: () => {
            order.push('agents')
            throw new Error('agents exploded')
          },
          skills: async () => {
            order.push('skills')
            throw new Error('skills rejected')
          },
          commands: () => {
            order.push('commands')
          },
          bootstrap: () => {
            order.push('bootstrap')
          },
        },
      }),
    )

    expect(order).toEqual(['agents', 'skills', 'commands', 'bootstrap'])
    expect(errorMessages()).toEqual([
      'systematic: agents installer failed: agents exploded',
      'systematic: skills installer failed: skills rejected',
    ])
  })

  test('a throwing transform callback registered through the guard is caught', async () => {
    const fake = createFakeContext(projectDir)
    const replayed: unknown[] = []

    await setupOpenCodeV2(
      fake.ctx,
      deps({
        installers: {
          agents: ({ ctx, guard }) => {
            ctx.agent.transform(
              guard.sync('agent transform', () => {
                throw new Error('transform exploded')
              }) as never,
            )
            ctx.agent.transform(
              guard.sync('agent transform', (editor: FakeEditor) => {
                editor.update('survivor', 'ok')
              }) as never,
            )
          },
        },
      }),
    )

    const editor = createFakeEditor()
    for (const transform of fake.transforms) {
      replayed.push(transform(editor))
    }
    expect(replayed).toHaveLength(2)
    expect(editor.entries.get('survivor')).toBe('ok')
    expect(errorMessages()).toEqual([
      'systematic: agent transform failed: transform exploded',
    ])
  })

  test('the same transform replayed on two fresh editors gives identical results', async () => {
    const fake = createFakeContext(projectDir)

    await setupOpenCodeV2(
      fake.ctx,
      deps({
        installers: {
          agents: ({ ctx, snapshot, guard }) => {
            ctx.agent.transform(
              guard.sync('agent transform', (editor: FakeEditor) => {
                for (const name of Object.keys(snapshot.plan.agents)) {
                  editor.update(
                    name,
                    snapshot.plan.agents[name]?.config.description ?? '',
                  )
                }
              }) as never,
            )
          },
        },
      }),
    )

    const [transform] = fake.transforms
    expect(fake.transforms).toHaveLength(1)
    const first = createFakeEditor()
    const second = createFakeEditor()
    transform?.(first)
    transform?.(second)

    expect(first.entries.size).toBeGreaterThan(0)
    expect([...second.entries]).toEqual([...first.entries])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('two setups with two contexts keep independent snapshots and one subscription each', async () => {
    const first = createFakeContext(projectDir)
    const second = createFakeContext(projectDir)
    const snapshots: V2Snapshot[] = []
    const subscribe: V2Installer = ({ ctx, snapshot }) => {
      snapshots.push(snapshot)
      ctx.agent.transform((() => {}) as never)
    }

    await setupOpenCodeV2(
      first.ctx,
      deps({ installers: { agents: subscribe } }),
    )
    await setupOpenCodeV2(
      second.ctx,
      deps({ installers: { agents: subscribe } }),
    )

    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).not.toBe(snapshots[1] as V2Snapshot)
    expect(snapshots[0]?.plan).not.toBe(snapshots[1]?.plan as never)
    expect(first.transforms).toHaveLength(1)
    expect(second.transforms).toHaveLength(1)
  })

  test('the snapshot is frozen so one installer cannot rewrite what the next one reads', async () => {
    let attempted: unknown
    const { ctx } = createFakeContext(projectDir)

    await setupOpenCodeV2(
      ctx,
      deps({
        installers: {
          agents: ({ snapshot }) => {
            attempted = Object.isFrozen(snapshot)
          },
        },
      }),
    )

    expect(attempted).toBe(true)
  })

  test('the default empty installers register nothing and stay silent', async () => {
    const fake = createFakeContext(projectDir)

    await setupOpenCodeV2(fake.ctx, deps())

    expect(fake.transforms).toHaveLength(0)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('never reads the process working directory for project config', async () => {
    // The bundled working directory has its own `.opencode`; the context's
    // directory is the only project source.
    writeProjectConfig({ bootstrap: { enabled: false } })
    let captured: V2Snapshot | undefined
    const { ctx } = createFakeContext(projectDir)
    const cwdSpy = spyOn(process, 'cwd')

    await setupOpenCodeV2(
      ctx,
      deps({
        installers: {
          agents: ({ snapshot }) => {
            captured = snapshot
          },
        },
      }),
    )

    expect(cwdSpy).not.toHaveBeenCalled()
    cwdSpy.mockRestore()
    expect(captured?.directory).toBe(projectDir)
  })
})

describe('default export wiring', () => {
  const originalHome = process.env.HOME

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  test('setup does nothing for the reduced context a v1 host passes', async () => {
    await SystematicPlugin.setup({} as unknown as Plugin.Context)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('setup rejects on invalid project config for a v2 context', async () => {
    process.env.HOME = homeDir
    const configPath = writeProjectConfig('not json at all')
    const { ctx } = createFakeContext(projectDir)

    await expect(SystematicPlugin.setup(ctx)).rejects.toThrow(
      `Invalid Systematic config in ${configPath}`,
    )
  })

  test('setup resolves for a valid v2 context', async () => {
    process.env.HOME = homeDir
    const { ctx } = createFakeContext(projectDir)

    await expect(SystematicPlugin.setup(ctx)).resolves.toBeUndefined()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
