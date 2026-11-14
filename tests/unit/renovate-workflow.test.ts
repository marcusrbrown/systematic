import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { HOST_SUPPORT_TABLE } from '../../src/lib/connect-config.js'

/**
 * `Renovate / Renovate` is a required status context on main. A push to the
 * gated release PR's head branch (`release/pending`) is what reports it, so
 * that branch must not be ignored.
 */

const WORKFLOW_PATH = path.resolve(
  process.cwd(),
  '.github/workflows/renovate.yaml',
)

function readOn(): Record<string, unknown> {
  const { JSON_SCHEMA } = yaml
  const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'), {
    schema: JSON_SCHEMA,
  }) as { on: Record<string, unknown> }
  return workflow.on
}

describe('renovate workflow push filter', () => {
  const push = () => readOn().push as { 'branches-ignore'?: string[] }

  test('pushes to release/** trigger Renovate: the required check comes from that run', () => {
    const ignored = push()['branches-ignore'] ?? []
    expect(ignored.some((pattern) => pattern.startsWith('release'))).toBe(false)
  })

  test('main is still ignored on push', () => {
    expect(push()['branches-ignore']).toEqual(['main'])
  })
})

/**
 * The host pins live in `scripts/opencode-host-pins.json`. Renovate bumps the
 * two moving pins (v2 and v1 current) through regex managers, each in its own
 * package group, and never bumps either floor.
 */
const RENOVATE_CONFIG_PATH = path.resolve(
  process.cwd(),
  '.github/renovate.json5',
)
const PIN_FILE_RELATIVE_PATH = 'scripts/opencode-host-pins.json'

interface RegexManager {
  customType: string
  managerFilePatterns: string[]
  matchStrings: string[]
  depNameTemplate?: string
  datasourceTemplate?: string
}

interface PackageRule {
  matchPackageNames?: string[]
  matchManagers?: string[]
  groupName?: string
  semanticCommitType?: string
  minimumReleaseAge?: string | null
}

interface RenovateConfig {
  ignorePaths: string[]
  customManagers: RegexManager[]
  packageRules: PackageRule[]
}

function readRenovateConfig(): RenovateConfig {
  return Bun.JSON5.parse(
    fs.readFileSync(RENOVATE_CONFIG_PATH, 'utf8'),
  ) as RenovateConfig
}

/** A pin file whose four versions differ, so a match can be traced to its key. */
const SAMPLE_PIN_FILE = JSON.stringify(
  { v2: '9999.2.1', v2Floor: '9999.2.0', v1: '9999.1.1', v1Floor: '9999.1.0' },
  null,
  2,
)

/** Renovate's `managerFilePatterns` entries are `/regex/` strings. */
function matchesFilePattern(pattern: string, filePath: string): boolean {
  return new RegExp(pattern.slice(1, -1)).test(filePath)
}

/** The regex managers whose file patterns select `filePath`. */
function managersFor(config: RenovateConfig, filePath: string): RegexManager[] {
  return config.customManagers.filter((manager) =>
    manager.managerFilePatterns.some((pattern) =>
      matchesFilePattern(pattern, filePath),
    ),
  )
}

/** The version and dependency each pin-file manager extracts from `text`. */
function extractDependencies(
  config: RenovateConfig,
  text: string,
): { depName: string; currentValue: string }[] {
  return managersFor(config, PIN_FILE_RELATIVE_PATH).flatMap((manager) =>
    manager.matchStrings.flatMap((pattern) =>
      [...text.matchAll(new RegExp(pattern, 'g'))].map((match) => ({
        depName: manager.depNameTemplate ?? '',
        currentValue: match.groups?.currentValue ?? '',
      })),
    ),
  )
}

/** The group a dependency lands in, using Renovate's glob matching on package names. */
function groupFor(config: RenovateConfig, depName: string): string | undefined {
  return config.packageRules.find(
    (rule) =>
      rule.groupName !== undefined &&
      rule.matchPackageNames?.some((pattern) =>
        new Bun.Glob(pattern).match(depName),
      ),
  )?.groupName
}

describe('renovate host pin tracking', () => {
  const config = readRenovateConfig()

  test('the regex managers match the v2 and v1 current entries and never a floor', () => {
    expect(extractDependencies(config, SAMPLE_PIN_FILE)).toEqual([
      { depName: 'opencode-ai', currentValue: '9999.1.1' },
      { depName: '@opencode/cli', currentValue: '9999.2.1' },
    ])
  })

  test('the regex managers read the real pin file the same way', () => {
    const real = fs.readFileSync(
      path.resolve(process.cwd(), PIN_FILE_RELATIVE_PATH),
      'utf8',
    )
    const pins = JSON.parse(real) as { v1: string; v2: string }

    expect(extractDependencies(config, real)).toEqual([
      { depName: 'opencode-ai', currentValue: pins.v1 },
      { depName: '@opencode/cli', currentValue: pins.v2 },
    ])
  })

  test('each manager targets the pin file, which no ignorePaths entry covers', () => {
    const managers = managersFor(config, PIN_FILE_RELATIVE_PATH)
    expect(managers).toHaveLength(2)
    for (const manager of managers) {
      expect(manager.customType).toBe('regex')
      expect(manager.datasourceTemplate).toBe('npm')
    }
    for (const ignored of config.ignorePaths) {
      expect(new Bun.Glob(ignored).match(PIN_FILE_RELATIVE_PATH)).toBe(false)
    }
  })

  test.each([
    ['opencode-ai', 'OpenCode'],
    ['@opencode-ai/sdk', 'OpenCode'],
    ['@opencode-ai/plugin', 'OpenCode'],
    ['@opencode/cli', 'OpenCode v2'],
    ['@opencode/sdk', 'OpenCode v2'],
    ['@opencode/plugin', 'OpenCode v2'],
    ['@opencode/client', 'OpenCode v2'],
  ])('%s lands in the %s group', (depName, group) => {
    expect(groupFor(config, depName)).toBe(group)
  })

  test('the two OpenCode groups never share a package', () => {
    const groups = config.packageRules.filter(
      (rule) =>
        rule.groupName === 'OpenCode' || rule.groupName === 'OpenCode v2',
    )
    expect(groups.map((rule) => rule.groupName)).toEqual([
      'OpenCode',
      'OpenCode v2',
    ])
    expect(groupFor(config, '@opencode/cli')).not.toBe('OpenCode')
    expect(groupFor(config, 'opencode-ai')).not.toBe('OpenCode v2')
  })
})

/**
 * The `ce:connect` host-support rows follow their host pins. Each annotated
 * row carries a `renovate:` comment that a regex manager reads, so the row
 * bumps in the same group PR as the pin it was proven on. The Claude Code row
 * has no package Renovate can bump and carries no annotation.
 */
const CONNECT_CONFIG_RELATIVE_PATH = 'src/lib/connect-config.ts'

describe('renovate host-support row tracking', () => {
  const config = readRenovateConfig()
  const [manager, ...others] = managersFor(config, CONNECT_CONFIG_RELATIVE_PATH)
  const source = fs.readFileSync(
    path.resolve(process.cwd(), CONNECT_CONFIG_RELATIVE_PATH),
    'utf8',
  )

  /** Every match of the manager's patterns over `text`, as Renovate reads them. */
  function matches(text: string) {
    return (manager?.matchStrings ?? []).flatMap((pattern) =>
      [...text.matchAll(new RegExp(pattern, 'g'))].map((match) => ({
        datasource: match.groups?.datasource,
        depName: match.groups?.depName,
        currentValue: match.groups?.currentValue,
      })),
    )
  }

  const rowFor = (host: string) =>
    HOST_SUPPORT_TABLE.find((row) => row.host === host)

  test('exactly one regex manager targets the connect config file', () => {
    expect(manager).toBeDefined()
    expect(others).toHaveLength(0)
    expect(manager?.customType).toBe('regex')
  })

  test('it matches the v1, v2 and Pi rows on npm and nothing else', () => {
    expect(
      matches(source).map(({ datasource, depName }) => ({
        datasource,
        depName,
      })),
    ).toEqual([
      { datasource: 'npm', depName: 'opencode-ai' },
      { datasource: 'npm', depName: '@opencode/cli' },
      { datasource: 'npm', depName: '@earendil-works/pi-coding-agent' },
    ])
  })

  test('each captured currentValue is the version of its row in the table', () => {
    expect(matches(source).map((entry) => entry.currentValue)).toEqual([
      rowFor('opencode-v1')?.version,
      rowFor('opencode-v2')?.version,
      rowFor('pi')?.version,
    ])
  })

  test('the Claude Code row is not matched', () => {
    const claude = rowFor('claude-code')
    expect(claude).toBeDefined()
    expect(matches(source)).toHaveLength(3)
    expect(
      matches(source).some((entry) => entry.currentValue === claude?.version),
    ).toBe(false)
  })

  test('a version line without an annotation directly above it does not match', () => {
    const annotation = '// renovate: datasource=npm depName=some-package\n'
    expect(matches(`${annotation}  other: 'x',\n  version: '1.2.3',`)).toEqual(
      [],
    )
    expect(matches("  version: '1.2.3',")).toEqual([])
    expect(matches(`    ${annotation}    version: '1.2.3',`)).toEqual([
      { datasource: 'npm', depName: 'some-package', currentValue: '1.2.3' },
    ])
  })

  test('its file pattern selects the connect config file, which no ignorePaths entry covers', () => {
    expect(
      manager?.managerFilePatterns.some((pattern) =>
        matchesFilePattern(pattern, CONNECT_CONFIG_RELATIVE_PATH),
      ),
    ).toBe(true)
    for (const ignored of config.ignorePaths) {
      expect(new Bun.Glob(ignored).match(CONNECT_CONFIG_RELATIVE_PATH)).toBe(
        false,
      )
    }
  })

  test.each([
    ['opencode-ai', 'OpenCode'],
    ['@opencode/cli', 'OpenCode v2'],
    ['@earendil-works/pi-coding-agent', 'Pi'],
  ])('%s lands in the %s group, with its host pin', (depName, group) => {
    expect(groupFor(config, depName)).toBe(group)
  })
})

/**
 * `.github/workflows/connect.yaml` pins `env.SYSTEMATIC_VERSION`, the release
 * the scheduled run installs for the helper and passes to the agent action. A
 * `renovate:` comment directly above the line lets a regex manager bump it when
 * a new `@fro.bot/systematic` release reaches npm.
 */
const CONNECT_WORKFLOW_RELATIVE_PATH = '.github/workflows/connect.yaml'
const SYSTEMATIC_PACKAGE = '@fro.bot/systematic'
const SYSTEMATIC_ANNOTATION = `# renovate: datasource=npm depName=${SYSTEMATIC_PACKAGE}`

describe('renovate Systematic pin tracking', () => {
  const config = readRenovateConfig()
  const managers = managersFor(config, CONNECT_WORKFLOW_RELATIVE_PATH)
  const [manager] = managers
  const source = fs.readFileSync(
    path.resolve(process.cwd(), CONNECT_WORKFLOW_RELATIVE_PATH),
    'utf8',
  )
  const workflow = yaml.load(source, { schema: yaml.JSON_SCHEMA }) as {
    env: Record<string, unknown>
  }

  /** Every match of the manager's patterns over `text`, as Renovate reads them. */
  function matches(text: string) {
    return (manager?.matchStrings ?? []).flatMap((pattern) =>
      [...text.matchAll(new RegExp(pattern, 'g'))].map((match) => ({
        datasource: match.groups?.datasource,
        depName: match.groups?.depName,
        currentValue: match.groups?.currentValue,
      })),
    )
  }

  test('exactly one regex manager targets the connect workflow', () => {
    expect(managers).toHaveLength(1)
    expect(manager?.customType).toBe('regex')
  })

  test('it reads the annotated line as the Systematic package on npm', () => {
    expect(matches(source)).toEqual([
      {
        datasource: 'npm',
        depName: SYSTEMATIC_PACKAGE,
        currentValue: workflow.env.SYSTEMATIC_VERSION as string,
      },
    ])
  })

  test('the annotation sits directly above the SYSTEMATIC_VERSION line', () => {
    const lines = source.split('\n')
    const index = lines.findIndex((line) =>
      /^\s*SYSTEMATIC_VERSION:/.test(line),
    )
    expect(index).toBeGreaterThan(0)
    expect(lines[index - 1]?.trim()).toBe(SYSTEMATIC_ANNOTATION)
  })

  test('a version line without the annotation directly above it does not match', () => {
    expect(matches('  SYSTEMATIC_VERSION: "1.2.3"')).toEqual([])
    expect(
      matches(`  ${SYSTEMATIC_ANNOTATION}\n\n  SYSTEMATIC_VERSION: "1.2.3"`),
    ).toEqual([])
    expect(
      matches(`  ${SYSTEMATIC_ANNOTATION}\n  OTHER_VERSION: "1.2.3"`),
    ).toEqual([])
    expect(
      matches(`  ${SYSTEMATIC_ANNOTATION}\n  SYSTEMATIC_VERSION: "1.2.3"`),
    ).toEqual([
      { datasource: 'npm', depName: SYSTEMATIC_PACKAGE, currentValue: '1.2.3' },
    ])
  })

  test('its file pattern selects the connect workflow, which no ignorePaths entry covers', () => {
    for (const ignored of config.ignorePaths) {
      expect(new Bun.Glob(ignored).match(CONNECT_WORKFLOW_RELATIVE_PATH)).toBe(
        false,
      )
    }
  })

  test('no rule groups, holds back or releases the Systematic bump', () => {
    const rules = config.packageRules.filter((rule) =>
      rule.matchPackageNames?.some((pattern) =>
        new Bun.Glob(pattern).match(SYSTEMATIC_PACKAGE),
      ),
    )
    expect(groupFor(config, SYSTEMATIC_PACKAGE)).toBeUndefined()
    for (const rule of rules) {
      expect(rule.minimumReleaseAge ?? null).toBeNull()
    }
    // A pin bump is not a release of this package: `ci` is outside the
    // releaseRules and the commit-analyzer defaults, where `feat` and `fix` release.
    expect(rules.map((rule) => rule.semanticCommitType)).toContain('ci')
    for (const rule of rules) {
      expect(['feat', 'fix']).not.toContain(rule.semanticCommitType)
    }
  })
})
