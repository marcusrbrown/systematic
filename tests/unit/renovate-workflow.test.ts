import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

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
 * package group, and never bumps the v1 floor.
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
  depNameTemplate: string
  datasourceTemplate: string
}

interface PackageRule {
  matchPackageNames?: string[]
  groupName?: string
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

/** A pin file whose three versions differ, so a match can be traced to its key. */
const SAMPLE_PIN_FILE = JSON.stringify(
  { v2: '9999.2.0', v1: '9999.1.1', v1Floor: '9999.1.0' },
  null,
  2,
)

/** The version and dependency each regex manager extracts from `text`. */
function extractDependencies(
  config: RenovateConfig,
  text: string,
): { depName: string; currentValue: string }[] {
  return config.customManagers.flatMap((manager) =>
    manager.matchStrings.flatMap((pattern) =>
      [...text.matchAll(new RegExp(pattern, 'g'))].map((match) => ({
        depName: manager.depNameTemplate,
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

  test('the regex managers match the v2 and v1 current entries and never the floor', () => {
    expect(extractDependencies(config, SAMPLE_PIN_FILE)).toEqual([
      { depName: 'opencode-ai', currentValue: '9999.1.1' },
      { depName: '@opencode/cli', currentValue: '9999.2.0' },
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
    for (const manager of config.customManagers) {
      expect(manager.customType).toBe('regex')
      expect(manager.datasourceTemplate).toBe('npm')
      const [pattern] = manager.managerFilePatterns
      const regex = new RegExp((pattern ?? '').slice(1, -1))
      expect(regex.test(PIN_FILE_RELATIVE_PATH)).toBe(true)
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
