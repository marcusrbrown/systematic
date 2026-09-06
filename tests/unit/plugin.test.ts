import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyBootstrapContent } from '../../src/lib/bootstrap.js'

const SRC_DIR = path.resolve(import.meta.dirname, '../../src')
const ROOT_DIR = path.resolve(import.meta.dirname, '../..')

describe('plugin loading', () => {
  test('plugin file exists at src/index.ts', () => {
    const pluginPath = path.join(SRC_DIR, 'index.ts')
    expect(fs.existsSync(pluginPath)).toBe(true)
  })

  test('cli file exists at src/cli.ts', () => {
    const cliPath = path.join(SRC_DIR, 'cli.ts')
    expect(fs.existsSync(cliPath)).toBe(true)
  })

  test('plugin module loads', async () => {
    const pluginPath = path.join(SRC_DIR, 'index.ts')
    const pluginModule = await import(pathToFileURL(pluginPath).href)
    expect(pluginModule.default).toBeDefined()
    expect(pluginModule.SystematicPlugin).toBeUndefined()
  })

  test('plugin snapshots bootstrap content at init instead of re-reading files per transform', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-plugin-'))
    const opencodeDir = path.join(tempDir, '.opencode')
    const bootstrapPath = path.join(tempDir, 'bootstrap.md')
    const configPath = path.join(opencodeDir, 'systematic.json')

    fs.mkdirSync(opencodeDir, { recursive: true })
    fs.writeFileSync(bootstrapPath, 'INITIAL bootstrap content')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        bootstrap: {
          enabled: true,
          file: bootstrapPath,
        },
      }),
    )

    try {
      const pluginPath = path.join(SRC_DIR, 'index.ts')
      const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
        default: (args: {
          client: { app: { log: (entry: unknown) => Promise<void> } }
          directory: string
        }) => Promise<{
          'experimental.chat.system.transform': (
            input: unknown,
            output: { system: string[] },
          ) => Promise<void>
        }>
      }

      const plugin = await pluginModule.default({
        client: {
          app: {
            log: async () => {},
          },
        },
        directory: tempDir,
      })

      fs.writeFileSync(bootstrapPath, 'UPDATED bootstrap content')

      const output = { system: ['Existing system prompt'] }
      await plugin['experimental.chat.system.transform']({}, output)

      expect(output.system).toEqual([
        'Existing system prompt\n\nINITIAL bootstrap content',
      ])
      expect(output.system[0]).not.toContain('UPDATED bootstrap content')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('loads bootstrap config from systematic.jsonc with comments', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-plugin-'))
    const opencodeDir = path.join(tempDir, '.opencode')
    const bootstrapPath = path.join(tempDir, 'bootstrap.md')
    const configPath = path.join(opencodeDir, 'systematic.jsonc')

    fs.mkdirSync(opencodeDir, { recursive: true })
    fs.writeFileSync(bootstrapPath, 'JSONC bootstrap content')
    fs.writeFileSync(
      configPath,
      '{\n  // Bootstrap via JSONC\n  "bootstrap": {\n    "enabled": true,\n    "file": "' +
        bootstrapPath.replace(/\\/g, '\\\\') +
        '"\n  }\n}\n',
    )

    try {
      const pluginPath = path.join(SRC_DIR, 'index.ts')
      const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
        default: (args: {
          client: { app: { log: (entry: unknown) => Promise<void> } }
          directory: string
        }) => Promise<{
          'experimental.chat.system.transform': (
            input: unknown,
            output: { system: string[] },
          ) => Promise<void>
        }>
      }

      const plugin = await pluginModule.default({
        client: {
          app: {
            log: async () => {},
          },
        },
        directory: tempDir,
      })

      const output = { system: ['Existing system prompt'] }
      await plugin['experimental.chat.system.transform']({}, output)

      expect(output.system).toEqual([
        'Existing system prompt\n\nJSONC bootstrap content',
      ])
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('CI smoke test validates the workflow plugin export and registry drift contract', () => {
    const workflowPath = path.join(ROOT_DIR, '.github/workflows/main.yaml')
    const workflow = fs.readFileSync(workflowPath, 'utf8')

    expect(workflow).toContain('const pluginFactory = m.default;')
    expect(workflow).toContain('await pluginFactory({')
    expect(workflow).not.toContain('m.SystematicPlugin')
    expect(workflow).toContain('bun run registry:drift')
  })

  test('package exposes distinct registry validation and drift commands', () => {
    const packageJsonPath = path.join(ROOT_DIR, 'package.json')
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf8'),
    ) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.['registry:validate']).toBe(
      'bun scripts/build-registry.ts --validate-only',
    )
    expect(packageJson.scripts?.['registry:drift']).toBe(
      'bun scripts/generate-registry.ts --check',
    )
  })

  test('cli runs under Bun', async () => {
    const cliPath = path.join(SRC_DIR, 'cli.ts')
    const result = Bun.spawnSync(['bun', cliPath, '--help'])
    expect(result.exitCode).toBe(0)
  })

  test('duplicate factory invocations return real hooks without warnings', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-singleton-'),
    )
    const opencodeDir = path.join(tempDir, '.opencode')
    fs.mkdirSync(opencodeDir, { recursive: true })

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    }

    try {
      const pluginPath = path.join(SRC_DIR, 'index.ts')
      const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
        default: (args: {
          client: { app: { log: (entry: unknown) => Promise<void> } }
          directory: string
        }) => Promise<Record<string, unknown>>
      }

      const input = {
        client: {
          app: {
            log: async () => {},
          },
        },
        directory: tempDir,
      }

      const hooks1 = await pluginModule.default(input)
      const hooks2 = await pluginModule.default(input)
      const hooks3 = await pluginModule.default(input)

      // All invocations — including duplicates — get the real hook surface
      // (config + tool + transform). The singleton returns cached real hooks
      // instead of an empty object, so the OpenCode host never sees a stale
      // registration surface from duplicate config sources.
      for (const hooks of [hooks1, hooks2, hooks3]) {
        expect(hooks.tool).toBeDefined()
        expect(hooks.config).toBeDefined()
        expect(hooks['experimental.chat.system.transform']).toBeDefined()
      }

      // No duplicate warnings are emitted.
      const duplicateWarnings = warnings.filter((w) =>
        w.includes('duplicate factory invocation'),
      )
      expect(duplicateWarnings.length).toBe(0)
    } finally {
      console.warn = originalWarn
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('bundled content', () => {
  test('skills directory exists at top level', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'skills'))).toBe(true)
  })

  test('agents directory exists at top level', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'agents'))).toBe(true)
  })

  test('commands directory removed (commands converted to skills)', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'commands'))).toBe(false)
  })

  test('bundled skills have valid structure', () => {
    const skillsDir = path.join(ROOT_DIR, 'skills')
    const skillDirs = fs.readdirSync(skillsDir).filter((f) => {
      const fullPath = path.join(skillsDir, f)
      return (
        fs.statSync(fullPath).isDirectory() &&
        fs.existsSync(path.join(fullPath, 'SKILL.md'))
      )
    })

    expect(skillDirs.length).toBeGreaterThan(0)

    for (const skillName of skillDirs) {
      const skillPath = path.join(skillsDir, skillName, 'SKILL.md')
      expect(fs.existsSync(skillPath)).toBe(true)
    }
  })

  test('bundled agents have valid structure', () => {
    const agentsDir = path.join(ROOT_DIR, 'agents')
    const reviewDir = path.join(agentsDir, 'review')
    const agentFiles = fs
      .readdirSync(reviewDir)
      .filter((f) => f.endsWith('.md'))

    expect(agentFiles.length).toBeGreaterThan(0)
  })

  test('bundled skills cover former commands', () => {
    const skillsDir = path.join(ROOT_DIR, 'skills')
    const skillDirs = fs.readdirSync(skillsDir).filter((f) => {
      const stat = fs.statSync(path.join(skillsDir, f))
      return stat.isDirectory()
    })
    expect(skillDirs.length).toBeGreaterThan(0)
    expect(skillDirs).toContain('ce-brainstorm')
    expect(skillDirs).toContain('ce-plan')
    expect(skillDirs).toContain('ce-review')
    expect(skillDirs).toContain('ce-work')
    expect(skillDirs).toContain('ce-compound')
  })
})

describe('CLI functionality', () => {
  const CLI_PATH = path.join(SRC_DIR, 'cli.ts')

  test('cli --help returns usage info', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, '--help'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('systematic')
    expect(output).toContain('list')
    expect(output).toContain('config')
  })

  test('cli convert falls through to unknown-command handling', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, 'convert', 'agent', 'x'])
    const stderr = result.stderr.toString()
    expect(result.exitCode).toBe(1)
    expect(stderr).toContain('Unknown command: convert')
  })

  test('cli --version returns version', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, '--version'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toMatch(/systematic v\d+\.\d+\.\d+/)
  })

  test('cli list skills shows bundled skills', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, 'list', 'skills'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('ce:brainstorm')
  })

  test('cli list agents shows bundled agents', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, 'list', 'agents'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('architecture-strategist')
  })

  test('cli list commands exits successfully with empty result', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, 'list', 'commands'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('No commands found')
  })

  test('cli config path shows paths', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, 'config', 'path'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('User:')
    expect(output).toContain('Project:')
  })
})

describe('per-invocation plugin registration', () => {
  const makeInput = (
    tempDir: string,
    logSpy?: (entry: unknown) => Promise<void>,
  ) => ({
    client: {
      app: {
        log: logSpy ?? (async () => {}),
      },
    },
    directory: tempDir,
  })

  test('each SystematicPlugin call returns a distinct hooks object', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-per-init-'),
    )
    fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true })
    try {
      const pluginPath = path.join(SRC_DIR, 'index.ts')
      const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
        default: (
          args: ReturnType<typeof makeInput>,
        ) => Promise<Record<string, unknown>>
      }
      const input = makeInput(tempDir)
      const result1 = await pluginModule.default(input)
      const result2 = await pluginModule.default(input)
      expect(result1).not.toBe(result2)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('each invocation returns distinct function references for all three hook surfaces', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-per-init-'),
    )
    fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true })
    try {
      const pluginPath = path.join(SRC_DIR, 'index.ts')
      const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
        default: (args: ReturnType<typeof makeInput>) => Promise<{
          config: unknown
          tool: {
            systematic_skill: unknown
            systematic_workflow_start: unknown
          }
          'tool.execute.before': unknown
          'tool.execute.after': unknown
          'experimental.chat.system.transform': unknown
        }>
      }
      const input = makeInput(tempDir)
      const result1 = await pluginModule.default(input)
      const result2 = await pluginModule.default(input)
      expect(result1.tool.systematic_skill).not.toBe(
        result2.tool.systematic_skill,
      )
      expect(Object.keys(result1.tool).sort()).toEqual([
        'systematic_skill',
        'systematic_workflow_complete',
        'systematic_workflow_control',
        'systematic_workflow_start',
        'systematic_workflow_status',
      ])
      expect(result1.tool.systematic_workflow_start).not.toBe(
        result2.tool.systematic_workflow_start,
      )
      expect(result1['tool.execute.before']).not.toBe(
        result2['tool.execute.before'],
      )
      expect(result1['tool.execute.after']).not.toBe(
        result2['tool.execute.after'],
      )
      expect(result1.config).not.toBe(result2.config)
      expect(result1['experimental.chat.system.transform']).not.toBe(
        result2['experimental.chat.system.transform'],
      )
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('two independent registrations leave exactly one marker block in the system array', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-per-init-'),
    )
    fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true })
    try {
      const pluginPath = path.join(SRC_DIR, 'index.ts')
      const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
        default: (args: ReturnType<typeof makeInput>) => Promise<{
          'experimental.chat.system.transform': (
            input: unknown,
            output: { system: string[] },
          ) => Promise<void>
        }>
      }
      const input = makeInput(tempDir)
      const plugin1 = await pluginModule.default(input)
      const plugin2 = await pluginModule.default(input)

      const output = { system: ['base system prompt'] }
      await plugin1['experimental.chat.system.transform'](
        { sessionID: 'plugin-session' },
        output,
      )
      await plugin2['experimental.chat.system.transform'](
        { sessionID: 'plugin-session' },
        output,
      )

      const joined = output.system.join('\n')
      expect((joined.match(/<SYSTEMATIC_WORKFLOWS>/g) ?? []).length).toBe(1)
      expect((joined.match(/<SYSTEMATIC_WORKFLOW_GUARD>/g) ?? []).length).toBe(
        1,
      )
      const markerBody = joined.match(
        /<SYSTEMATIC_WORKFLOW_GUARD>(.*?)<\/SYSTEMATIC_WORKFLOW_GUARD>/s,
      )?.[1]
      if (!markerBody) throw new Error('workflow guard marker missing')
      const marker = JSON.parse(markerBody) as { sources: unknown[] }
      expect(marker.sources).toHaveLength(2)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('each independent registration logs its own init message', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-per-init-'),
    )
    fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true })
    try {
      const pluginPath = path.join(SRC_DIR, 'index.ts')
      const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
        default: (args: ReturnType<typeof makeInput>) => Promise<{
          'experimental.chat.system.transform': (
            input: unknown,
            output: { system: string[] },
          ) => Promise<void>
        }>
      }

      const logCalls: unknown[] = []
      const logSpy = async (entry: unknown) => {
        logCalls.push(entry)
      }

      const input = makeInput(tempDir, logSpy)
      const plugin1 = await pluginModule.default(input)
      const plugin2 = await pluginModule.default(input)

      const output1 = { system: ['base'] }
      const output2 = { system: ['base'] }
      await plugin1['experimental.chat.system.transform']({}, output1)
      await plugin2['experimental.chat.system.transform']({}, output2)

      const initLogs = logCalls.filter(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'body' in entry &&
          typeof (entry as { body: unknown }).body === 'object' &&
          (entry as { body: { message?: unknown } }).body !== null &&
          (entry as { body: { message?: unknown } }).body.message ===
            'Systematic plugin initialized',
      )
      expect(initLogs).toHaveLength(2)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('invoking one registration transform twice produces exactly one marker block per turn', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-per-init-'),
    )
    fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true })
    try {
      const pluginPath = path.join(SRC_DIR, 'index.ts')
      const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
        default: (args: ReturnType<typeof makeInput>) => Promise<{
          'experimental.chat.system.transform': (
            input: unknown,
            output: { system: string[] },
          ) => Promise<void>
        }>
      }
      const input = makeInput(tempDir)
      const plugin = await pluginModule.default(input)

      const output1 = { system: ['turn one base'] }
      await plugin['experimental.chat.system.transform']({}, output1)
      const count1 = (
        output1.system.join('\n').match(/<SYSTEMATIC_WORKFLOWS>/g) ?? []
      ).length
      expect(count1).toBe(1)

      const output2 = { system: ['turn two base'] }
      await plugin['experimental.chat.system.transform']({}, output2)
      const count2 = (
        output2.system.join('\n').match(/<SYSTEMATIC_WORKFLOWS>/g) ?? []
      ).length
      expect(count2).toBe(1)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('workflow-guard transform failure is fail-closed and does not propagate to the host', async () => {
    // This test verifies the adapter's transform wrapper is symmetric with after/event hooks:
    // all three must be fail-closed (never propagate a throw to the host).
    //
    // RED before fix: the adapter's transform delegation had no try/catch, so if
    // workflowGuard.hooks['experimental.chat.system.transform'] threw for any reason
    // (e.g. unguarded state machine failure) it would escape to the host.
    // GREEN after fix: the adapter wraps the delegation in try/catch matching after/event.
    //
    // We test by verifying that even when the adapter's bootstrapContent path is
    // skipped and the guard path is reached with a session that was never initialised,
    // the transform hook still resolves without throwing.
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-transform-failclosed-'),
    )
    fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true })
    try {
      const pluginPath = path.join(SRC_DIR, 'index.ts')
      const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
        default: (args: ReturnType<typeof makeInput>) => Promise<{
          'experimental.chat.system.transform': (
            input: unknown,
            output: { system: string[] },
          ) => Promise<void>
        }>
      }
      const plugin = await pluginModule.default(makeInput(tempDir))
      const output = { system: ['base'] }

      // A call with a fresh sessionID that has no prior state still must not throw.
      await expect(
        plugin['experimental.chat.system.transform'](
          { sessionID: 'never-touched-session-id' },
          output,
        ),
      ).resolves.toBeUndefined()
      // Output is intact and not corrupted.
      expect(output.system.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('applyBootstrapContent marker-based idempotency', () => {
  const MARKER_OPEN = '<SYSTEMATIC_WORKFLOWS>'
  const MARKER_CLOSE = '</SYSTEMATIC_WORKFLOWS>'
  const wrap = (body: string) => `${MARKER_OPEN}${body}${MARKER_CLOSE}`

  test('pushes content as sole entry when system array is empty', () => {
    const output = { system: [] as string[] }
    applyBootstrapContent(output, wrap('NEW CONTENT'))
    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toBe(wrap('NEW CONTENT'))
  })

  test('appends content to system[0] when no prior marker block exists', () => {
    const output = { system: ['existing system prompt'] }
    applyBootstrapContent(output, wrap('NEW CONTENT'))
    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toBe(
      `existing system prompt\n\n${wrap('NEW CONTENT')}`,
    )
  })

  test('two system entries with no marker: bootstrap appended to system[0], system[1] unchanged', () => {
    const output = { system: ['slot 0 content', 'slot 1 content'] }
    applyBootstrapContent(output, wrap('NEW CONTENT'))
    expect(output.system).toHaveLength(2)
    expect(output.system[0]).toBe(`slot 0 content\n\n${wrap('NEW CONTENT')}`)
    expect(output.system[1]).toBe('slot 1 content')
  })

  test('removes existing marker block from system[0] then appends current content', () => {
    const output = {
      system: [`existing prompt with ${wrap('OLD CONTENT')} embedded`],
    }
    applyBootstrapContent(output, wrap('NEW CONTENT'))
    expect(output.system).toHaveLength(1)
    const result = output.system[0]
    const openTagCount = (result.match(new RegExp(MARKER_OPEN, 'g')) ?? [])
      .length
    expect(openTagCount).toBe(1)
    expect(result).toContain('NEW CONTENT')
    expect(result).not.toContain('OLD CONTENT')
  })

  test('removes complete marker block from a non-first slot and appends current content to system[0]', () => {
    const output = {
      system: ['slot 0', `slot 1 with ${wrap('OLD CONTENT')}`, 'slot 2'],
    }
    applyBootstrapContent(output, wrap('NEW CONTENT'))
    expect(output.system).toHaveLength(3)
    // Block removed from slot 1
    expect(output.system[1]).not.toContain('OLD CONTENT')
    expect(output.system[1]).not.toContain(MARKER_OPEN)
    // Current content appended to slot 0
    expect(output.system[0]).toContain('NEW CONTENT')
    expect(output.system[0]).toContain(MARKER_OPEN)
    // slot 2 unchanged
    expect(output.system[2]).toBe('slot 2')
  })

  test('removes all complete blocks across all entries then appends one current block to system[0]', () => {
    const twoBlocks = `${wrap('A')}B${wrap('C')}`
    const output = { system: [twoBlocks, wrap('D')] }
    applyBootstrapContent(output, wrap('X'))
    // Both complete blocks in system[0] removed, block in system[1] removed
    const openTagCount = (
      output.system.join('\n').match(new RegExp(MARKER_OPEN, 'g')) ?? []
    ).length
    expect(openTagCount).toBe(1)
    expect(output.system[0]).toContain('X')
    expect(output.system[0]).not.toContain(wrap('A'))
    expect(output.system[0]).not.toContain(wrap('C'))
    expect(output.system[1]).not.toContain(wrap('D'))
    expect(output.system[1]).not.toContain(MARKER_OPEN)
  })

  test('fully replaces an entry that is only the marker block', () => {
    const output = { system: [wrap('A')] }
    applyBootstrapContent(output, wrap('B'))
    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toBe(wrap('B'))
  })

  test('two sequential transform invocations leave exactly one marker block with content from the second call', () => {
    const output = { system: ['base system prompt'] }
    applyBootstrapContent(output, wrap('FIRST REGISTRATION'))
    applyBootstrapContent(output, wrap('SECOND REGISTRATION'))
    const joined = output.system.join('\n')
    const openTagCount = (joined.match(new RegExp(MARKER_OPEN, 'g')) ?? [])
      .length
    expect(openTagCount).toBe(1)
    expect(joined).toContain('SECOND REGISTRATION')
    expect(joined).not.toContain('FIRST REGISTRATION')
  })

  test('malformed open-only marker fragment is left untouched while current block is appended to system[0]', () => {
    const malformed = `${MARKER_OPEN} trailing content with no close`
    const output = { system: [malformed] }
    applyBootstrapContent(output, wrap('NEW CONTENT'))
    // No complete block matched, so the fragment remains and content is appended
    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain(MARKER_OPEN)
    expect(output.system[0]).toContain('trailing content with no close')
    expect(output.system[0]).toContain('NEW CONTENT')
    // Exactly one complete block (the appended one)
    const openTagCount = (
      output.system[0].match(new RegExp(MARKER_OPEN, 'g')) ?? []
    ).length
    const closeTagCount = (
      output.system[0].match(new RegExp(MARKER_CLOSE, 'g')) ?? []
    ).length
    expect(closeTagCount).toBe(1)
    // Two open tags: one from the malformed fragment, one from the appended block
    expect(openTagCount).toBe(2)
  })

  test('malformed open-only marker fragment survives sequential transforms', () => {
    const malformed = `${MARKER_OPEN} USER FRAGMENT KEEP`
    const output = { system: [malformed] }

    applyBootstrapContent(output, wrap('FIRST REGISTRATION'))
    applyBootstrapContent(output, wrap('SECOND REGISTRATION'))

    const result = output.system[0]
    expect(result).toContain(malformed)
    expect(result).toContain('SECOND REGISTRATION')
    expect(result).not.toContain('FIRST REGISTRATION')
    const closeTagCount = (result.match(new RegExp(MARKER_CLOSE, 'g')) ?? [])
      .length
    expect(closeTagCount).toBe(1)
  })

  test('removes nested complete blocks in a single call', () => {
    const nested = `${MARKER_OPEN}outer ${wrap('inner')} tail${MARKER_CLOSE}`
    const output = { system: [nested] }
    applyBootstrapContent(output, wrap('NEW'))

    const joined = output.system.join('\n')
    const openTagCount = (joined.match(new RegExp(MARKER_OPEN, 'g')) ?? [])
      .length
    expect(openTagCount).toBe(1)
    // Only the appended block remains
    expect(output.system[0]).toBe(wrap('NEW'))
  })

  test('nested block with surrounding content converges in one call', () => {
    const nested = `intro ${MARKER_OPEN}outer ${wrap('inner')} tail${MARKER_CLOSE} more`
    const output = { system: [nested] }
    applyBootstrapContent(output, wrap('NEW'))

    const joined = output.system.join('\n')
    const openTagCount = (joined.match(new RegExp(MARKER_OPEN, 'g')) ?? [])
      .length
    expect(openTagCount).toBe(1)
    // User text outside the outermost block survives
    expect(output.system[0]).toContain('intro')
    expect(output.system[0]).toContain('more')
    // Text inside the outermost block is removed with it
    expect(output.system[0]).not.toContain('outer')
    expect(output.system[0]).not.toContain('tail')
  })

  test('two levels of nesting converge in one call', () => {
    const nested = `${MARKER_OPEN}${MARKER_OPEN}${wrap('deep')}${MARKER_CLOSE}${MARKER_CLOSE}`
    const output = { system: [nested] }
    applyBootstrapContent(output, wrap('NEW'))

    const joined = output.system.join('\n')
    const openTagCount = (joined.match(new RegExp(MARKER_OPEN, 'g')) ?? [])
      .length
    expect(openTagCount).toBe(1)
    expect(output.system[0]).toBe(wrap('NEW'))
  })

  test('malformed open-only fragment survives even when nesting is also present', () => {
    // No outer close tag — the outer open is an orphan fragment that should
    // survive, while the complete inner block is removed.
    const mixed = `${MARKER_OPEN}keep me ${wrap('inner')}`
    const output = { system: [mixed] }
    applyBootstrapContent(output, wrap('NEW'))

    // The fragment open tag survives (no matching close for outermost)
    expect(output.system[0]).toContain(MARKER_OPEN)
    expect(output.system[0]).toContain('keep me')
    // The appended block exists
    expect(output.system[0]).toContain('NEW')
    // The inner block is removed — only fragment + appended block remain
    const openTagCount = (
      output.system[0].match(new RegExp(MARKER_OPEN, 'g')) ?? []
    ).length
    expect(openTagCount).toBe(2)
    const closeTagCount = (
      output.system[0].match(new RegExp(MARKER_CLOSE, 'g')) ?? []
    ).length
    expect(closeTagCount).toBe(1)
  })

  test('malformed open-only fragment survives sequential transforms when nesting preceeded it', () => {
    // No outer close tag — the outer open is an orphan that should survive
    // across sequential transforms.
    const mixed = `${MARKER_OPEN}keep me ${wrap('first')}`
    const output = { system: [mixed] }

    applyBootstrapContent(output, wrap('FIRST'))
    applyBootstrapContent(output, wrap('SECOND'))

    // Fragment still survives after second transform
    expect(output.system[0]).toContain('keep me')
    expect(output.system[0]).toContain('SECOND')
    expect(output.system[0]).not.toContain('FIRST')
    // One complete block (the appended second one)
    const closeTagCount = (
      output.system[0].match(new RegExp(MARKER_CLOSE, 'g')) ?? []
    ).length
    expect(closeTagCount).toBe(1)
  })

  test('completes in linear time on malicious input with many opening markers and no closing tag', () => {
    // Regression: the prior regex implementation was vulnerable to ReDoS on
    // inputs starting with the opening marker repeated and missing a closing
    // tag. The linear-scan helper is provably immune; this pins the failure
    // mode without relying on benchmarking.
    const malicious = `${MARKER_OPEN.repeat(10000)} trailing content with no close`
    const output = { system: [malicious] }
    const startedAt = Date.now()
    applyBootstrapContent(output, wrap('NEW CONTENT'))
    const elapsedMs = Date.now() - startedAt
    // No marker block matched (no closing tag), so content is appended.
    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain('NEW CONTENT')
    expect(output.system[0]).toContain(MARKER_OPEN.repeat(10000))
    // Loose upper bound — linear scan finishes in well under 100ms even on
    // slow CI runners. A polynomial-backtracking regex would take seconds or
    // longer on this input shape.
    expect(elapsedMs).toBeLessThan(1000)
  })
})
