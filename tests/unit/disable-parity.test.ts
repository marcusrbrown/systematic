import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAgentCatalog } from '../../src/lib/agent-resolver.js'
import { isAgentDisabled, loadConfigWithSources } from '../../src/lib/config.js'
import { createConfigHandler } from '../../src/lib/config-handler.js'

/**
 * Pi decides which personas are disabled with `isAgentDisabled`; OpenCode
 * decides with its own inline checks in `config-handler.ts`. Each row runs one
 * user config through both and compares them with a literal expected list, so
 * a drift in either side fails here.
 */

const bundledSkillsDir = fileURLToPath(new URL('../../skills', import.meta.url))
const bundledAgentsDir = fileURLToPath(new URL('../../agents', import.meta.url))
const bundledCommandsDir = fileURLToPath(
  new URL('../../commands', import.meta.url),
)

interface ParityRow {
  label: string
  config: Record<string, unknown>
  /** Persona file stems, sorted. Stems are unique across categories. */
  disabled: string[]
}

const ROWS: ParityRow[] = [
  {
    label: 'a bare disabled_agents entry',
    config: { disabled_agents: ['repo-research-analyst'] },
    disabled: ['repo-research-analyst'],
  },
  {
    label: 'a qualified disabled_agents entry',
    config: { disabled_agents: ['research/repo-research-analyst'] },
    disabled: ['repo-research-analyst'],
  },
  {
    label: 'a bare agents overlay with disable: true',
    config: { agents: { 'security-reviewer': { disable: true } } },
    disabled: ['security-reviewer'],
  },
  {
    label: 'a qualified agents overlay with disable: true',
    config: { agents: { 'review/security-reviewer': { disable: true } } },
    disabled: ['security-reviewer'],
  },
  {
    label: 'a mix of list entries and overlays across categories',
    config: {
      disabled_agents: ['git-history-analyzer', 'review/testing-reviewer'],
      agents: { 'design-iterator': { disable: true } },
    },
    disabled: ['design-iterator', 'git-history-analyzer', 'testing-reviewer'],
  },
  {
    label: 'an overlay that sets disable: false',
    config: { agents: { 'repo-research-analyst': { disable: false } } },
    disabled: [],
  },
  {
    label: 'no disable settings',
    config: {},
    disabled: [],
  },
]

describe('disable parity between Pi and OpenCode', () => {
  let testDir: string
  let originalHomedir: () => string
  let originalConfigDir: string | undefined
  let originalCwd: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-parity-'))
    originalHomedir = os.homedir
    originalConfigDir = process.env.OPENCODE_CONFIG_DIR
    originalCwd = process.cwd()
    delete process.env.OPENCODE_CONFIG_DIR
    os.homedir = () => testDir
    fs.mkdirSync(path.join(testDir, 'project'), { recursive: true })
    process.chdir(path.join(testDir, 'project'))
  })

  afterEach(() => {
    process.chdir(originalCwd)
    os.homedir = originalHomedir
    if (originalConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalConfigDir
    }
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  function writeUserConfig(config: Record<string, unknown>): void {
    const file = path.join(testDir, '.config', 'opencode', 'systematic.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(config))
  }

  function allStems(): string[] {
    return buildAgentCatalog(bundledAgentsDir).map((entry) => entry.key)
  }

  /** The personas Pi's predicate disables for the config now on disk. */
  function piDisabled(): string[] {
    const { config, overlays } = loadConfigWithSources(process.cwd())
    const disabledAgents = new Set(config.disabled_agents)
    return buildAgentCatalog(bundledAgentsDir)
      .filter((entry) =>
        isAgentDisabled(
          disabledAgents,
          overlays.agents,
          entry.category,
          entry.key,
        ),
      )
      .map((entry) => entry.key)
      .sort()
  }

  /** The bundled personas OpenCode's config handler does not emit. */
  async function openCodeOmitted(): Promise<string[]> {
    const handler = createConfigHandler({
      directory: process.cwd(),
      bundledSkillsDir,
      bundledAgentsDir,
      bundledCommandsDir,
      homeDir: testDir,
    })
    const config: Record<string, unknown> = {}
    await handler(config)
    const emitted = new Set(Object.keys(config.agent ?? {}))
    return allStems()
      .filter((stem) => !emitted.has(stem))
      .sort()
  }

  test.each(ROWS)(
    '$label disables the same personas on both harnesses',
    async ({ config, disabled }) => {
      writeUserConfig(config)

      expect(piDisabled()).toEqual(disabled)
      expect(await openCodeOmitted()).toEqual(disabled)
    },
  )

  test('every row that disables something yields a non-empty set', () => {
    const disabling = ROWS.filter(
      (row) =>
        'disabled_agents' in row.config ||
        Object.values(
          (row.config.agents ?? {}) as Record<string, { disable?: boolean }>,
        ).some((overlay) => overlay.disable === true),
    )

    expect(disabling.length).toBeGreaterThan(0)
    for (const row of disabling) {
      expect(row.disabled.length).toBeGreaterThan(0)
    }
  })

  test('the matrix expects only personas that are bundled', () => {
    const bundled = new Set(allStems())
    for (const row of ROWS) {
      for (const stem of row.disabled) expect(bundled.has(stem)).toBe(true)
    }
  })

  test('every bundled persona declares a name equal to its file stem', () => {
    const catalog = buildAgentCatalog(bundledAgentsDir)

    expect(catalog.length).toBeGreaterThan(0)
    for (const entry of catalog) {
      expect(entry.name).toBe(entry.key)
    }
  })
})
