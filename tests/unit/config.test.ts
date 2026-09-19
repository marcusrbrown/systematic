import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUNDLED_AGENT_QUALIFIED_IDS,
  BUNDLED_SKILL_NAMES,
} from '../../src/lib/bundled-names.js'
import {
  buildCapabilitySnapshot,
  serializeCapabilitySnapshot,
} from '../../src/lib/capability-snapshot.js'
import {
  computeDroppedNames,
  DEFAULT_CONFIG,
  getConfigPaths,
  loadConfig,
  loadConfigWithSources,
  warnDroppedNames,
} from '../../src/lib/config.js'
import {
  REMOVED_BUNDLED_AGENT_CATEGORIES,
  REMOVED_BUNDLED_AGENT_NAMES,
} from '../../src/lib/removed-names.js'
import {
  type RoutingTarget,
  resolveRouting,
} from '../../src/lib/routing-resolver.js'

const OBSERVED_AT = '2026-08-13T12:34:56.000Z'

// SYSTEMATIC_PROFILE is cleared from the ambient environment by the
// tests/setup.ts preload (see bunfig.toml) before any test file runs, so
// this suite is hermetic against it by construction. Tests that
// deliberately want it set use `withEnvProfile` below and restore it
// afterward.

describe('config', () => {
  let testDir: string
  let originalOsHomedir: (() => string) | undefined

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-test-'))
    originalOsHomedir = os.homedir
    os.homedir = () => path.join(testDir, 'home')
  })

  afterEach(() => {
    if (originalOsHomedir) os.homedir = originalOsHomedir
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  function userConfigPath(): string {
    return path.join(os.homedir(), '.config', 'opencode', 'systematic.json')
  }

  function writeUserConfig(config: Record<string, unknown>): string {
    const filePath = userConfigPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(config))
    return filePath
  }

  describe('loadConfig', () => {
    describe('no config files', () => {
      test('returns DEFAULT_CONFIG when no config files exist', () => {
        const result = loadConfig(testDir)
        expect(result).toEqual(DEFAULT_CONFIG)
      })

      test('returned config has empty disabled arrays', () => {
        const result = loadConfig(testDir)
        expect(result.disabled_skills).toEqual([])
        expect(result.disabled_agents).toEqual([])
        expect(result.disabled_commands).toEqual([])
      })

      test('returned config has bootstrap enabled by default', () => {
        const result = loadConfig(testDir)
        expect(result.bootstrap.enabled).toBe(true)
      })
    })

    describe('project config only', () => {
      test('merges project config with defaults', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_skills: ['ce:plan'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toContain('ce:plan')
        expect(result.disabled_agents).toEqual([])
        expect(result.disabled_commands).toEqual([])
        expect(result.bootstrap).toEqual(DEFAULT_CONFIG.bootstrap)
      })

      test('project bootstrap overrides default', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            bootstrap: {
              enabled: false,
            },
          }),
        )

        const result = loadConfig(testDir)
        expect(result.bootstrap.enabled).toBe(false)
      })

      test('project bootstrap file overrides default', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            bootstrap: {
              file: 'custom-bootstrap.md',
            },
          }),
        )

        const result = loadConfig(testDir)
        expect(result.bootstrap.file).toBe('custom-bootstrap.md')
      })
    })

    describe('user config only', () => {
      test('merges user config with defaults', () => {
        writeUserConfig({ disabled_agents: ['correctness-reviewer'] })

        const result = loadConfig(testDir)
        expect(result.disabled_agents).toContain('correctness-reviewer')
        expect(result.disabled_skills).toEqual([])
        expect(result.disabled_commands).toEqual([])
      })
    })

    describe('both configs', () => {
      test('project config overrides user config', () => {
        writeUserConfig({ disabled_skills: ['ce:brainstorm'] })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_skills: ['ce:compound'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toContain('ce:brainstorm')
        expect(result.disabled_skills).toContain('ce:compound')
      })

      test('project bootstrap overrides user bootstrap', () => {
        writeUserConfig({ bootstrap: { enabled: true } })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            bootstrap: {
              enabled: false,
            },
          }),
        )

        const result = loadConfig(testDir)
        expect(result.bootstrap.enabled).toBe(false)
      })
    })

    describe('read-only observation metadata', () => {
      test('reports source presence and field-specific authority without values', () => {
        writeUserConfig({
          bootstrap: { enabled: false },
          workflow_guard: { mode: 'protected' },
          skills_as_commands: false,
          agents: {
            'correctness-reviewer': {
              model: 'openai/secret-model',
              permission: { bash: 'deny' },
            },
          },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            bootstrap: { enabled: true },
            workflow_guard: { mode: 'disabled' },
            skills_as_commands: true,
            agents: {
              'correctness-reviewer': { temperature: 0.4 },
            },
          }),
        )

        const customDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'systematic-custom-'),
        )
        process.env.OPENCODE_CONFIG_DIR = customDir
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          JSON.stringify({
            skills_as_commands: false,
            categories: { review: { temperature: 0.7 } },
          }),
        )

        try {
          const result = loadConfigWithSources(testDir)

          expect(result.metadata.sources).toEqual([
            { kind: 'custom', presence: 'present' },
            { kind: 'project', presence: 'present' },
            { kind: 'user', presence: 'present' },
          ])
          expect(result.metadata.authorities).toEqual(
            expect.arrayContaining([
              { fieldPath: 'bootstrap.enabled', sourceKind: 'project' },
              { fieldPath: 'skills_as_commands', sourceKind: 'custom' },
              { fieldPath: 'workflow_guard.mode', sourceKind: 'user' },
            ]),
          )
          expect(result.metadata.authorities).not.toContainEqual({
            fieldPath: 'workflow_guard.mode',
            sourceKind: 'project',
          })
          expect(result.metadata.protectedFields).toContainEqual({
            fieldPath: 'workflow_guard',
            outcome: 'blocked',
            sourceKind: 'project',
          })
          expect(JSON.stringify(result.metadata)).not.toContain('secret-model')
          expect(JSON.stringify(result.metadata)).not.toContain('permission')
          expect(result.config.skills_as_commands).toBe(false)
          expect(result.config.bootstrap.enabled).toBe(true)
          expect(result.config.workflow_guard.mode).toBe('protected')
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
          fs.rmSync(customDir, { recursive: true, force: true })
        }
      })

      test('reports malformed source metadata only in opt-in mode', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')
        fs.writeFileSync(projectConfigPath, '{invalid json')

        const result = loadConfigWithSources(testDir, {
          invalidSource: 'report',
        })

        expect(result.metadata.sources).toContainEqual({
          errorCode: 'parse-failed',
          kind: 'project',
          presence: 'invalid',
        })
        expect(JSON.stringify(result.metadata)).not.toContain(projectConfigPath)
        expect(() => loadConfig(testDir)).toThrow(projectConfigPath)
      })

      test('deduplicates symlink-equivalent config sources without leaking paths', () => {
        const realProjectDir = path.join(testDir, 'real-project')
        const realConfigDir = path.join(realProjectDir, '.opencode')
        const aliasedProjectDir = path.join(testDir, 'aliased-project')
        const aliasedCustomDir = path.join(testDir, 'aliased-custom')
        fs.mkdirSync(realConfigDir, { recursive: true })
        fs.writeFileSync(
          path.join(realConfigDir, 'systematic.json'),
          JSON.stringify({ skills_as_commands: false }),
        )
        fs.symlinkSync(realProjectDir, aliasedProjectDir, 'dir')
        fs.symlinkSync(realConfigDir, aliasedCustomDir, 'dir')
        process.env.OPENCODE_CONFIG_DIR = aliasedCustomDir

        try {
          const result = loadConfigWithSources(aliasedProjectDir)
          expect(result.metadata.sources).toEqual([
            { kind: 'custom', presence: 'present' },
            { kind: 'user', presence: 'absent' },
          ])

          const serialized = serializeCapabilitySnapshot(
            buildCapabilitySnapshot({
              argv: ['systematic', 'capabilities'],
              clock: () => Date.parse(OBSERVED_AT),
              config: result.metadata,
              package: { name: '@fro.bot/systematic', version: '1.2.3' },
              roots: [],
            }),
          )
          expect(serialized).not.toContain(realProjectDir)
          expect(serialized).not.toContain(aliasedProjectDir)
          expect(serialized).not.toContain(aliasedCustomDir)
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })
    })

    describe('project and custom config resolving to the same file', () => {
      test('direct alias: one notice, no ignored-field warnings, protected field applied', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'correctness-reviewer': { model: 'openai/aliased' } },
          }),
        )
        process.env.OPENCODE_CONFIG_DIR = projectConfigDir

        try {
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
            'openai/aliased',
          )
          expect(
            warnings.some((message) =>
              message.includes('is only valid in user config'),
            ),
          ).toBe(false)
          expect(
            warnings.filter((message) =>
              message.includes('resolve to the same file'),
            ),
          ).toHaveLength(1)
          expect(warnings[0]).toContain(
            'apply through the custom-trust pass instead',
          )
          // The stripped field applied through the custom-trust pass of the
          // same file, so it is not genuinely "blocked" -- must not appear
          // in observation metadata (regression for the duplicate-record bug).
          expect(result.metadata.protectedFields).toEqual([])
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })

      test('non-alias: separate project and custom paths keep prior strip-warning behavior', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')
        fs.writeFileSync(
          projectConfigPath,
          JSON.stringify({
            agents: { 'correctness-reviewer': { model: 'openai/project' } },
          }),
        )
        const customDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'systematic-custom-'),
        )
        process.env.OPENCODE_CONFIG_DIR = customDir

        try {
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          expect(warnings).toEqual([
            `[systematic] \`agents.correctness-reviewer.model\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
          ])
          expect(result.config.agents).toEqual({})
          // No aliasing here -- the field is genuinely blocked (never applied
          // anywhere), so its record must be retained.
          expect(result.metadata.protectedFields).toEqual([
            {
              fieldPath: 'agents.*.model',
              outcome: 'blocked',
              sourceKind: 'project',
            },
          ])
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
          fs.rmSync(customDir, { recursive: true, force: true })
        }
      })

      test('symlink alias: a symlinked custom config directory resolving to the project file behaves the same as a direct alias', () => {
        const realProjectDir = path.join(testDir, 'real-project')
        const realConfigDir = path.join(realProjectDir, '.opencode')
        fs.mkdirSync(realConfigDir, { recursive: true })
        fs.writeFileSync(
          path.join(realConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'correctness-reviewer': { model: 'openai/aliased' } },
          }),
        )
        const aliasedCustomDir = path.join(testDir, 'aliased-custom')
        fs.symlinkSync(realConfigDir, aliasedCustomDir, 'dir')
        process.env.OPENCODE_CONFIG_DIR = aliasedCustomDir

        try {
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(realProjectDir, { warningSink })

          expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
            'openai/aliased',
          )
          expect(
            warnings.some((message) =>
              message.includes('is only valid in user config'),
            ),
          ).toBe(false)
          expect(
            warnings.filter((message) =>
              message.includes('resolve to the same file'),
            ),
          ).toHaveLength(1)
          expect(warnings[0]).toContain(
            'apply through the custom-trust pass instead',
          )
          // Same duplicate-suppression invariant applies through a symlinked
          // custom config dir, not just a direct path alias.
          expect(result.metadata.protectedFields).toEqual([])
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })

      test('an invalid-shape protected field still rejects via the custom-trust pass when aliased', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'correctness-reviewer': { model: 42 } },
          }),
        )
        process.env.OPENCODE_CONFIG_DIR = projectConfigDir

        try {
          expect(() => loadConfigWithSources(testDir)).toThrow('model')
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })

      test('alias + invalid protected field + report mode: buffered strip warnings flush and no alias notice is emitted, without throwing', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'correctness-reviewer': { model: 42 } },
          }),
        )
        process.env.OPENCODE_CONFIG_DIR = projectConfigDir

        try {
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, {
            warningSink,
            invalidSource: 'report',
          })

          expect(
            warnings.some((message) =>
              message.includes('is only valid in user config'),
            ),
          ).toBe(true)
          expect(
            warnings.some((message) =>
              message.includes('resolve to the same file'),
            ),
          ).toBe(false)
          expect(result.metadata.sources).toContainEqual(
            expect.objectContaining({ kind: 'custom', presence: 'invalid' }),
          )
          // The custom-trust pass of the aliased file failed, so the field
          // never actually applied -- its blocked record must be retained,
          // not suppressed as a false "applied via custom" duplicate.
          expect(result.metadata.protectedFields).toEqual([
            {
              fieldPath: 'agents.*.model',
              outcome: 'blocked',
              sourceKind: 'project',
            },
          ])
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })

      test('alias + valid protected fields: buffered strip warnings are discarded and exactly one alias notice is emitted', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: {
              'correctness-reviewer': {
                model: 'openai/aliased',
                permission: { bash: 'allow' },
              },
            },
          }),
        )
        process.env.OPENCODE_CONFIG_DIR = projectConfigDir

        try {
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          loadConfigWithSources(testDir, { warningSink })

          expect(warnings).toHaveLength(1)
          expect(warnings[0]).toContain('resolve to the same file')
          expect(warnings[0]).toContain(
            'apply through the custom-trust pass instead',
          )
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })

      test('alias success (top-level-only: `profiles`/`workflow_guard`, no agents/categories overlay) actually applies them, emits no false "ignored"/"not selectable" warning, and gives exactly one accurate alias notice', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            profile: 'personal',
            workflow_guard: { mode: 'protected', debug: true },
            profiles: {
              personal: {
                agents: { 'correctness-reviewer': { model: 'a/personal' } },
              },
            },
          }),
        )
        process.env.OPENCODE_CONFIG_DIR = projectConfigDir

        try {
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          // Real effect, not just "no blocked record": workflow_guard took
          // hold (project-trust would have stripped it to DEFAULT_CONFIG's
          // observe/false) and the project-selected `personal` profile's
          // overlay actually merged into the effective config.
          expect(result.config.workflow_guard).toEqual({
            mode: 'protected',
            debug: true,
          })
          expect(result.metadata.activeProfile).toBe('personal')
          expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
            'a/personal',
          )

          // Regression: `profiles` genuinely applied through the identical
          // custom-trust file, so its project-trust "ignored"/"not
          // selectable" warning must not fire -- even though this project
          // config has zero agents/categories security-overlay fields to
          // strip (the only case that used to feed the alias-notice buffer).
          expect(
            warnings.some((message) =>
              message.includes('is only valid in user config'),
            ),
          ).toBe(false)
          // Exactly one accurate alias notice takes its place.
          expect(
            warnings.filter((message) =>
              message.includes('resolve to the same file'),
            ),
          ).toHaveLength(1)
          expect(warnings).toHaveLength(1)
          expect(warnings[0]).toContain(
            'apply through the custom-trust pass instead',
          )

          // Both top-level protected fields applied through the custom-trust
          // pass of the identical file -- neither should be reported blocked.
          expect(result.metadata.protectedFields).toEqual([])

          // Consumer evidence: the capability snapshot the CLI ships (and
          // any other consumer of `metadata.protectedFields`) must not
          // surface a stale "blocked" record either -- assert the parsed,
          // structured fact list directly rather than string-matching the
          // serialized JSON.
          const snapshot = buildCapabilitySnapshot({
            argv: ['systematic', 'capabilities'],
            clock: () => Date.parse(OBSERVED_AT),
            config: result.metadata,
            package: { name: '@fro.bot/systematic', version: '1.2.3' },
            roots: [],
          })
          expect(
            snapshot.facts.filter(
              (fact) => fact.factId === 'config-protected-field',
            ),
          ).toEqual([])
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })

      test('alias success with `allow_project_profiles: true` in the aliased file: opt-in and `profiles` both apply through the custom-trust pass, one accurate alias notice, no "ignored" warnings', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            allow_project_profiles: true,
            profile: 'personal',
            workflow_guard: { mode: 'protected', debug: true },
            profiles: {
              personal: {
                agents: { 'correctness-reviewer': { model: 'a/personal' } },
              },
            },
          }),
        )
        process.env.OPENCODE_CONFIG_DIR = projectConfigDir

        try {
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          expect(result.config.workflow_guard).toEqual({
            mode: 'protected',
            debug: true,
          })
          expect(result.metadata.activeProfile).toBe('personal')
          expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
            'a/personal',
          )

          // Neither `profiles` nor `allow_project_profiles` produces an
          // "ignored"/"not selectable" warning -- the opt-in, resolved from
          // the custom-trust pass of this identical file BEFORE the project
          // pass ran, means the project pass never even blocked `profiles`
          // in the first place; `allow_project_profiles` itself is still
          // unconditionally blocked in the project pass but applies through
          // the custom-trust pass, same as `workflow_guard`.
          expect(
            warnings.some((message) =>
              message.includes('is only valid in user config'),
            ),
          ).toBe(false)
          expect(
            warnings.filter((message) =>
              message.includes('resolve to the same file'),
            ),
          ).toHaveLength(1)
          expect(warnings).toHaveLength(1)

          // Same alias-transparency guarantee as the pre-existing top-level
          // alias test: nothing shows up as "blocked" in the merged metadata.
          expect(result.metadata.protectedFields).toEqual([])
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })

      test('alias success (workflow_guard-only, no `profiles`/no overlay fields) still gets one truthful alias notice, not silence', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            workflow_guard: { mode: 'protected', debug: true },
          }),
        )
        process.env.OPENCODE_CONFIG_DIR = projectConfigDir

        try {
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          // workflow_guard has no dedicated "ignored" warning at all, so this
          // case previously produced zero buffered messages and emitAliasDiagnostics
          // stayed silent even though the field genuinely applied via custom trust.
          expect(result.config.workflow_guard).toEqual({
            mode: 'protected',
            debug: true,
          })
          expect(result.metadata.protectedFields).toEqual([])
          expect(warnings).toEqual([
            expect.stringContaining('resolve to the same file'),
          ])
          expect(warnings[0]).toContain(
            'apply through the custom-trust pass instead',
          )
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })

      test('alias + top-level-only invalid `workflow_guard` + report mode: the `profiles`-ignored warning is flushed verbatim (not silently dropped) and blocked-field metadata is retained', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            workflow_guard: { mode: 'bogus-mode' },
            profiles: {
              personal: {
                agents: { 'correctness-reviewer': { model: 'a/personal' } },
              },
            },
          }),
        )
        process.env.OPENCODE_CONFIG_DIR = projectConfigDir

        try {
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, {
            warningSink,
            invalidSource: 'report',
          })

          // The custom-trust pass of the aliased file failed (invalid mode
          // enum value), so `profiles` never actually applied -- its ignored
          // warning must still surface, not be silently swallowed the way
          // the successful-alias case swallows it.
          expect(
            warnings.some(
              (message) =>
                message.includes('`profiles`') &&
                message.includes('is only valid in user config'),
            ),
          ).toBe(true)
          // No false accurate-alias notice either -- it did not, in fact,
          // apply through custom trust.
          expect(
            warnings.some((message) =>
              message.includes('resolve to the same file'),
            ),
          ).toBe(false)
          expect(result.metadata.sources).toContainEqual(
            expect.objectContaining({ kind: 'custom', presence: 'invalid' }),
          )
          expect(result.metadata.protectedFields).toEqual([
            {
              fieldPath: 'profiles',
              outcome: 'blocked',
              sourceKind: 'project',
            },
            {
              fieldPath: 'workflow_guard',
              outcome: 'blocked',
              sourceKind: 'project',
            },
          ])
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })

      test('alias success with a mixed overlay + top-level protected payload (agents.model AND profiles) still emits exactly one accurate alias notice, not one per field', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'correctness-reviewer': { model: 'openai/aliased' } },
            profiles: {
              personal: {
                agents: { 'correctness-reviewer': { model: 'a/personal' } },
              },
            },
          }),
        )
        process.env.OPENCODE_CONFIG_DIR = projectConfigDir

        try {
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
            'openai/aliased',
          )
          expect(
            warnings.some((message) =>
              message.includes('is only valid in user config'),
            ),
          ).toBe(false)
          expect(warnings).toEqual([
            expect.stringContaining('resolve to the same file'),
          ])
          expect(warnings[0]).toContain(
            'apply through the custom-trust pass instead',
          )
          expect(result.metadata.protectedFields).toEqual([])
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })

      test('alias + profile-bundle validation failure: load throws and no alias-success notice is emitted', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            profiles: {
              p: {
                categories: {
                  'not-a-real-category': { model: 'openai/x' },
                },
              },
            },
          }),
        )
        process.env.OPENCODE_CONFIG_DIR = projectConfigDir

        try {
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          // Schema-valid at both project and custom-trust parse time; the
          // profile bundle's category key is only checked by
          // `assertAllProfileBundlesAreValid`, which runs AFTER the alias
          // success notice used to be emitted -- so the notice must not
          // fire for a load that never actually returns a config.
          expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
            'profiles.p.categories.not-a-real-category is not a bundled agent category',
          )
          expect(
            warnings.some((message) =>
              message.includes('apply through the custom-trust pass instead'),
            ),
          ).toBe(false)
          // The stable identifying half of the alias notice -- catches a
          // reworded success notice that dropped the exact phrase above but
          // still claims the alias applied.
          expect(
            warnings.some((message) =>
              message.includes('resolve to the same file'),
            ),
          ).toBe(false)
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })

      test('alias + routing-invariant failure (variant with no model): load throws and no alias-success notice is emitted', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'correctness-reviewer': { variant: 'high' } },
          }),
        )
        process.env.OPENCODE_CONFIG_DIR = projectConfigDir

        try {
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          // `variant` is a security-overlay field, stripped from the project
          // pass but present (unstripped) via the aliased custom-trust pass,
          // so both passes load successfully -- the throw only comes from
          // the post-merge routing-invariant check, which runs AFTER the
          // alias success notice used to be emitted.
          //
          // Match the distinctive `assertRoutingInvariants` diagnostic itself
          // (not just the agent name), so this proves the load failed for the
          // intended reason -- a qualifier resolving without a model -- and
          // not from some unrelated error that happens to mention the agent.
          expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
            /agents\.correctness-reviewer\.variant resolves to "high" on the opencode harness, but no model resolves for agents\.correctness-reviewer on opencode/,
          )
          expect(
            warnings.some((message) =>
              message.includes('apply through the custom-trust pass instead'),
            ),
          ).toBe(false)
          expect(
            warnings.some((message) =>
              message.includes('resolve to the same file'),
            ),
          ).toBe(false)
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
      })
    })

    describe('array merging', () => {
      test('merges arrays without duplicates', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_skills: ['ce:plan', 'ce:review', 'ce:plan'],
          }),
        )

        const result = loadConfig(testDir)
        const uniqueSkills = new Set(result.disabled_skills)
        expect(uniqueSkills.size).toBe(result.disabled_skills.length)
      })

      test('combines user and project disabled_skills arrays', () => {
        writeUserConfig({ disabled_skills: ['ce:plan'] })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_skills: ['ce:review'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toContain('ce:plan')
        expect(result.disabled_skills).toContain('ce:review')
      })

      test('combines user and project disabled_agents arrays', () => {
        writeUserConfig({ disabled_agents: ['correctness-reviewer'] })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_agents: ['security-reviewer'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_agents).toContain('correctness-reviewer')
        expect(result.disabled_agents).toContain('security-reviewer')
      })

      test('combines user and project disabled_commands arrays', () => {
        writeUserConfig({ disabled_commands: ['cmd-a'] })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_commands: ['cmd-b'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_commands).toContain('cmd-a')
        expect(result.disabled_commands).toContain('cmd-b')
      })
    })

    describe('object merging (bootstrap)', () => {
      test('spreads bootstrap properties from user config', () => {
        writeUserConfig({ bootstrap: { file: 'user-bootstrap.md' } })

        const result = loadConfig(testDir)
        expect(result.bootstrap.file).toBe('user-bootstrap.md')
        expect(result.bootstrap.enabled).toBe(true)
      })

      test('project bootstrap fields override user bootstrap fields via spread merge', () => {
        writeUserConfig({
          bootstrap: { enabled: true, file: 'user-bootstrap.md' },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            bootstrap: { enabled: false },
          }),
        )

        const result = loadConfig(testDir)
        expect(result.bootstrap.enabled).toBe(false)
        expect(result.bootstrap.file).toBe('user-bootstrap.md')
      })
    })

    describe('malformed configs', () => {
      test('fails fast when project config has invalid JSONC', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')
        fs.writeFileSync(projectConfigPath, '{invalid json')

        expect(() => loadConfig(testDir)).toThrow(projectConfigPath)
        expect(() => loadConfig(testDir)).toThrow(/parse error/i)
      })

      test('ignores project config if it does not exist', () => {
        const result = loadConfig(testDir)
        expect(result).toEqual(DEFAULT_CONFIG)
      })
    })

    describe('agent and category overlays', () => {
      test('loads a user agent overlay with source and key provenance', () => {
        const userConfigPath = writeUserConfig({
          agents: { 'correctness-reviewer': { model: 'openai/gpt-5' } },
        })

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents).toEqual({
          'correctness-reviewer': { model: 'openai/gpt-5' },
        })
        expect(result.overlays.agents['correctness-reviewer']).toEqual({
          value: { model: 'openai/gpt-5' },
          sourcePath: userConfigPath,
          keyPath: 'agents.correctness-reviewer',
        })
      })

      test('preserves unrelated user category and project agent overlays', () => {
        writeUserConfig({
          categories: { review: { temperature: 0.2 } },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'correctness-reviewer': { temperature: 0.4 } },
          }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.categories).toEqual({
          review: { temperature: 0.2 },
        })
        expect(result.config.agents).toEqual({
          'correctness-reviewer': { temperature: 0.4 },
        })
      })

      test('project same-key overlays cannot erase user model policy', () => {
        writeUserConfig({
          agents: {
            'correctness-reviewer': {
              model: 'openai/gpt-5',
              temperature: 0.1,
            },
          },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')
        fs.writeFileSync(
          projectConfigPath,
          JSON.stringify({
            agents: {
              'correctness-reviewer': { temperature: 0.4 },
            },
          }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents).toEqual({
          'correctness-reviewer': { temperature: 0.4, model: 'openai/gpt-5' },
        })
        expect(result.overlays.agents['correctness-reviewer']?.sourcePath).toBe(
          projectConfigPath,
        )
      })

      test('project overlays warn and strip model, permission, and managed skills (issue #992)', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')

        const cases: Array<{
          config: Record<string, unknown>
          warningField: string
          agents: Record<string, Record<string, unknown>>
          categories: Record<string, Record<string, unknown>>
        }> = [
          {
            config: {
              agents: {
                'correctness-reviewer': { model: 'openai/gpt-5' },
              },
            },
            warningField: 'agents.correctness-reviewer.model',
            // Protected-only entry: stripping empties it entirely, so it is
            // dropped rather than retained as `{}` (F3).
            agents: {},
            categories: {},
          },
          {
            config: { categories: { review: { model: 'openai/gpt-5' } } },
            warningField: 'categories.review.model',
            agents: {},
            categories: {},
          },
          {
            config: {
              agents: {
                'correctness-reviewer': { permission: { bash: 'allow' } },
              },
            },
            warningField: 'agents.correctness-reviewer.permission',
            agents: {},
            categories: {},
          },
          {
            config: { categories: { review: { skills: ['ce:review'] } } },
            warningField: 'categories.review.skills',
            agents: {},
            categories: {},
          },
        ]

        for (const testCase of cases) {
          fs.writeFileSync(projectConfigPath, JSON.stringify(testCase.config))
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          expect(warnings).toEqual([
            `[systematic] \`${testCase.warningField}\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
          ])
          expect(result.config.agents).toEqual(testCase.agents)
          expect(result.config.categories).toEqual(testCase.categories)
        }
      })

      test('project overlays warn and strip model: null as a security field (issue #992)', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')

        const cases: Array<{
          config: Record<string, unknown>
          warningField: string
          agents: Record<string, Record<string, unknown>>
          categories: Record<string, Record<string, unknown>>
        }> = [
          {
            config: { agents: { 'correctness-reviewer': { model: null } } },
            warningField: 'agents.correctness-reviewer.model',
            // Protected-only entry: dropped rather than retained as `{}` (F3).
            agents: {},
            categories: {},
          },
          {
            config: { categories: { review: { model: null } } },
            warningField: 'categories.review.model',
            agents: {},
            categories: {},
          },
        ]

        for (const testCase of cases) {
          fs.writeFileSync(projectConfigPath, JSON.stringify(testCase.config))
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          expect(warnings).toEqual([
            `[systematic] \`${testCase.warningField}\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
          ])
          expect(result.config.agents).toEqual(testCase.agents)
          expect(result.config.categories).toEqual(testCase.categories)
        }
      })

      test('user config model: null passes config loading', () => {
        writeUserConfig({
          agents: { 'correctness-reviewer': { model: null } },
        })

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents?.['correctness-reviewer']?.model).toBeNull()
      })

      test('project same-key overlays preserve user permission policy fields', () => {
        writeUserConfig({
          categories: {
            review: {
              permission: { bash: 'deny' },
              skills: ['ce:review'],
              temperature: 0.1,
            },
          },
          agents: {
            'correctness-reviewer': {
              model: 'openai/gpt-5',
              permission: { read: 'deny' },
              temperature: 0.1,
            },
          },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            categories: { review: { temperature: 0.4 } },
            agents: { 'correctness-reviewer': { hidden: true } },
          }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.categories?.review).toEqual({
          temperature: 0.4,
          permission: { bash: 'deny' },
          skills: ['ce:review'],
        })
        expect(result.config.agents?.['correctness-reviewer']).toEqual({
          hidden: true,
          permission: { read: 'deny' },
          model: 'openai/gpt-5',
        })
      })

      test('project overlays warn and strip variant in agents or categories (issue #992)', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')

        const cases: Array<{
          config: Record<string, unknown>
          warningFields: string[]
          agents: Record<string, Record<string, unknown>>
          categories: Record<string, Record<string, unknown>>
        }> = [
          {
            config: {
              agents: {
                'correctness-reviewer': {
                  model: 'openai/gpt-5',
                  variant: 'large-context',
                },
              },
            },
            warningFields: [
              'agents.correctness-reviewer.model',
              'agents.correctness-reviewer.variant',
            ],
            // Both fields present are protected: the entry is empty after
            // stripping and is dropped rather than retained as `{}` (F3).
            agents: {},
            categories: {},
          },
          {
            config: {
              categories: {
                review: { model: 'openai/gpt-5', variant: 'small' },
              },
            },
            warningFields: [
              'categories.review.model',
              'categories.review.variant',
            ],
            agents: {},
            categories: {},
          },
        ]

        for (const testCase of cases) {
          fs.writeFileSync(projectConfigPath, JSON.stringify(testCase.config))
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          expect(warnings).toEqual(
            testCase.warningFields.map(
              (field) =>
                `[systematic] \`${field}\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
            ),
          )
          expect(result.config.agents).toEqual(testCase.agents)
          expect(result.config.categories).toEqual(testCase.categories)
        }
      })

      // Issue #992 gap: SECURITY_OVERLAY_FIELDS stripping used to happen only
      // at merge time (`stripProjectSecurityOverlay` inside `mergeOverlayMap`),
      // AFTER `SystematicConfigSchema.safeParse`. A project-set protected field
      // with an INVALID value shape (e.g. `model: 42` instead of a string) never
      // reached the merge-time strip -- it failed schema validation first and
      // threw, even though a validly-typed protected field (e.g. `model:
      // 'openai/gpt-5'`, covered above) was always silently stripped and
      // warned instead of failing. The strip must happen on the raw parsed
      // JSONC BEFORE schema validation so both cases behave identically: the
      // field is dropped and warned about regardless of whether its value
      // would otherwise have passed the field's own schema.
      describe('invalid-shape project security fields are stripped before schema validation (issue #992 gap)', () => {
        test('project model: 42 is stripped with the exact strip warning; a permitted sibling field (temperature) survives and the load succeeds', () => {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const projectConfigPath = path.join(
            projectConfigDir,
            'systematic.json',
          )
          fs.writeFileSync(
            projectConfigPath,
            JSON.stringify({
              agents: {
                'correctness-reviewer': { model: 42, temperature: 0.5 },
              },
            }),
          )
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          expect(warnings).toEqual([
            `[systematic] \`agents.correctness-reviewer.model\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
          ])
          expect(result.config.agents).toEqual({
            'correctness-reviewer': { temperature: 0.5 },
          })
        })

        test('invalid-shape values for every SECURITY_OVERLAY_FIELDS member are stripped (not a load failure) in both agents and categories', () => {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const projectConfigPath = path.join(
            projectConfigDir,
            'systematic.json',
          )

          const invalidShapes: Record<string, unknown> = {
            model: 42,
            variant: ['not-a-string'],
            skills: 'not-an-array',
            permission: 'not-a-record',
            opencode: 'not-an-object',
            pi: 'not-an-object',
          }

          for (const [field, invalidValue] of Object.entries(invalidShapes)) {
            fs.writeFileSync(
              projectConfigPath,
              JSON.stringify({
                agents: { 'correctness-reviewer': { [field]: invalidValue } },
                categories: { review: { [field]: invalidValue } },
              }),
            )
            const warnings: string[] = []
            const warningSink = (message: string) => warnings.push(message)

            const result = loadConfigWithSources(testDir, { warningSink })

            expect(warnings).toEqual([
              `[systematic] \`agents.correctness-reviewer.${field}\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
              `[systematic] \`categories.review.${field}\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
            ])
            // Protected-only entry: stripping empties it entirely, so it
            // is dropped rather than retained as `{}` (F3).
            expect(result.config.agents).toEqual({})
            expect(result.config.categories).toEqual({})
          }
        })

        test('a malformed PERMITTED field (temperature: "high") still fails validation -- only SECURITY_OVERLAY_FIELDS are pre-stripped', () => {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const projectConfigPath = path.join(
            projectConfigDir,
            'systematic.json',
          )
          fs.writeFileSync(
            projectConfigPath,
            JSON.stringify({
              agents: { 'correctness-reviewer': { temperature: 'high' } },
            }),
          )

          expect(() => loadConfig(testDir)).toThrow(projectConfigPath)
          expect(() => loadConfig(testDir)).toThrow('temperature')
        })

        test('an invalid-shape protected field in USER or CUSTOM config still fails validation -- pre-schema stripping is project-trust only', () => {
          const userConfigFilePath = writeUserConfig({
            agents: { 'correctness-reviewer': { model: 42 } },
          })
          expect(() => loadConfig(testDir)).toThrow(userConfigFilePath)
          expect(() => loadConfig(testDir)).toThrow('model')

          fs.rmSync(userConfigFilePath)

          const customDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'systematic-custom-'),
          )
          process.env.OPENCODE_CONFIG_DIR = customDir
          try {
            const customConfigPath = path.join(customDir, 'systematic.json')
            fs.writeFileSync(
              customConfigPath,
              JSON.stringify({
                agents: {
                  'correctness-reviewer': { permission: 'not-a-record' },
                },
              }),
            )
            expect(() => loadConfig(testDir)).toThrow(customConfigPath)
            expect(() => loadConfig(testDir)).toThrow('permission')
          } finally {
            delete process.env.OPENCODE_CONFIG_DIR
          }
        })

        test('the warning sink receives exactly one warning per stripped field, with no raw value echoed', () => {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const projectConfigPath = path.join(
            projectConfigDir,
            'systematic.json',
          )
          const secretLikeValue = 'sk-do-not-leak-me-12345'
          fs.writeFileSync(
            projectConfigPath,
            JSON.stringify({
              agents: {
                'correctness-reviewer': {
                  model: secretLikeValue,
                  permission: { bash: 'allow' },
                },
              },
              categories: {
                review: { skills: ['ce:review'] },
              },
            }),
          )
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          loadConfigWithSources(testDir, { warningSink })

          expect(warnings).toHaveLength(3)
          expect(warnings).toEqual([
            `[systematic] \`agents.correctness-reviewer.model\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
            `[systematic] \`agents.correctness-reviewer.permission\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
            `[systematic] \`categories.review.skills\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
          ])
          for (const warning of warnings) {
            expect(warning).not.toContain(secretLikeValue)
            expect(warning).not.toContain('allow')
            expect(warning).not.toContain('ce:review')
          }
        })
      })

      // F3: an entry made empty SOLELY by stripping (it had content before,
      // all of which was project-protected) is dropped entirely rather than
      // retained as `{}`. Retaining `{}` still counts as a project-supplied
      // overlay fragment for that key, and the project same-key merge
      // (`preserveSecurityFields`) fully replaces a previous value's
      // non-security fields with the fragment's -- wiping trusted settings
      // the project config never even named. An explicit `{}` (nothing to
      // strip) is unaffected and keeps prior semantics.
      describe('a protected-only project entry that strips to empty is dropped, not retained as {} (F3)', () => {
        test('trusted model/permission/temperature/hidden/disable/steps all survive a project protected-only entry', () => {
          writeUserConfig({
            agents: {
              'correctness-reviewer': {
                model: 'openai/trusted-model',
                permission: { bash: 'deny' },
                temperature: 0.1,
                hidden: true,
                disable: false,
                steps: 5,
              },
            },
          })

          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          fs.writeFileSync(
            path.join(projectConfigDir, 'systematic.json'),
            JSON.stringify({
              agents: {
                'correctness-reviewer': {
                  model: 'openai/attacker-model',
                  permission: { bash: 'allow' },
                },
              },
            }),
          )

          const result = loadConfigWithSources(testDir)

          expect(result.config.agents?.['correctness-reviewer']).toEqual({
            model: 'openai/trusted-model',
            permission: { bash: 'deny' },
            temperature: 0.1,
            hidden: true,
            disable: false,
            steps: 5,
          })
        })

        test('an explicit project {} entry keeps prior semantics (non-security fields still replaced, not preserved)', () => {
          writeUserConfig({
            agents: {
              'correctness-reviewer': {
                model: 'openai/trusted-model',
                permission: { bash: 'deny' },
                temperature: 0.1,
                hidden: true,
              },
            },
          })

          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          fs.writeFileSync(
            path.join(projectConfigDir, 'systematic.json'),
            JSON.stringify({
              agents: { 'correctness-reviewer': {} },
            }),
          )

          const result = loadConfigWithSources(testDir)

          expect(result.config.agents?.['correctness-reviewer']).toEqual({
            model: 'openai/trusted-model',
            permission: { bash: 'deny' },
          })
        })

        test('a project entry mixing a protected field with a permitted field (temperature) keeps prior merge semantics', () => {
          writeUserConfig({
            agents: {
              'correctness-reviewer': {
                model: 'openai/trusted-model',
                permission: { bash: 'deny' },
                temperature: 0.1,
                hidden: true,
              },
            },
          })

          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          fs.writeFileSync(
            path.join(projectConfigDir, 'systematic.json'),
            JSON.stringify({
              agents: {
                'correctness-reviewer': {
                  model: 'openai/attacker-model',
                  temperature: 0.4,
                },
              },
            }),
          )

          const result = loadConfigWithSources(testDir)

          expect(result.config.agents?.['correctness-reviewer']).toEqual({
            model: 'openai/trusted-model',
            permission: { bash: 'deny' },
            temperature: 0.4,
          })
        })

        test('an unknown agent name with only protected fields is discarded with a warning, and the load succeeds', () => {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const projectConfigPath = path.join(
            projectConfigDir,
            'systematic.json',
          )
          fs.writeFileSync(
            projectConfigPath,
            JSON.stringify({
              agents: {
                'totally-not-a-real-agent': { model: 'openai/x' },
              },
            }),
          )
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          expect(warnings).toEqual([
            `[systematic] \`agents.totally-not-a-real-agent.model\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
          ])
          expect(result.config.agents).toEqual({})
        })

        test('a genuinely-removed agent/category name (from the real removed-name inventory) with only protected fields is stripped-to-empty before the removed-name drop path ever sees it', () => {
          // Real inventory entries, not invented strings: `agents` keys are
          // schema-rejected unless the entry is stripped to `{}` first (see
          // `AgentOverlaySchema`'s object description); `categories` keys
          // that are still present after merge get a *different* "no longer
          // a bundled name" warning via `warnDroppedNames`/`REMOVED_AGENT_CATEGORIES_SET`.
          // A removed name using only protected fields must take the first
          // path (discarded pre-validation) and never reach the second.
          const removedAgentName = REMOVED_BUNDLED_AGENT_NAMES[0]
          const removedCategoryName = REMOVED_BUNDLED_AGENT_CATEGORIES[0]
          if (
            removedAgentName === undefined ||
            removedCategoryName === undefined
          ) {
            throw new Error(
              'REMOVED_BUNDLED_AGENT_NAMES/REMOVED_BUNDLED_AGENT_CATEGORIES must be non-empty for this regression to be meaningful',
            )
          }

          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const projectConfigPath = path.join(
            projectConfigDir,
            'systematic.json',
          )
          fs.writeFileSync(
            projectConfigPath,
            JSON.stringify({
              agents: { [removedAgentName]: { model: 'openai/x' } },
              categories: { [removedCategoryName]: { model: 'openai/x' } },
            }),
          )
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          // Both entries were discarded by protected-field stripping before
          // validation, so the load succeeds and both maps end up empty.
          expect(result.config.agents).toEqual({})
          expect(result.config.categories).toEqual({})
          // Only the protected-field-strip warning fires for each -- never
          // the separate "no longer a bundled name" removed-name warning,
          // since the key never survives to reach that check.
          expect(warnings).toEqual([
            `[systematic] \`agents.${removedAgentName}.model\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
            `[systematic] \`categories.${removedCategoryName}.model\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
          ])
          expect(
            warnings.some((message) =>
              message.includes('no longer a bundled name'),
            ),
          ).toBe(false)
        })

        test('an unknown agent name still rejects when it has a permitted field or is an explicit {}', () => {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const projectConfigPath = path.join(
            projectConfigDir,
            'systematic.json',
          )

          fs.writeFileSync(
            projectConfigPath,
            JSON.stringify({
              agents: {
                'totally-not-a-real-agent': { temperature: 0.5 },
              },
            }),
          )
          expect(() => loadConfig(testDir)).toThrow(projectConfigPath)
          expect(() => loadConfig(testDir)).toThrow('totally-not-a-real-agent')

          fs.writeFileSync(
            projectConfigPath,
            JSON.stringify({
              agents: { 'totally-not-a-real-agent': {} },
            }),
          )
          expect(() => loadConfig(testDir)).toThrow(projectConfigPath)
          expect(() => loadConfig(testDir)).toThrow('totally-not-a-real-agent')
        })
      })

      describe('strip-warning diagnostics sanitize untrusted text and bound their own volume', () => {
        test('a category key and project path with control characters never leak a raw control character into a warning', () => {
          const weirdProjectDir = path.join(
            testDir,
            'proj\n\u001b[31mFAKE\u001b[0m',
          )
          fs.mkdirSync(path.join(weirdProjectDir, '.opencode'), {
            recursive: true,
          })
          fs.writeFileSync(
            path.join(weirdProjectDir, '.opencode/systematic.json'),
            JSON.stringify({
              categories: {
                'evil\ncategory\u001b[0m': { model: 'openai/x' },
              },
            }),
          )
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          loadConfigWithSources(weirdProjectDir, { warningSink })

          expect(warnings.length).toBeGreaterThan(0)
          for (const warning of warnings) {
            expect(warning).not.toContain('\n')
            expect(warning).not.toContain('\u001b')
          }
          expect(warnings.join('\n')).toContain('\\u000a')
          expect(warnings.join('\n')).toContain('\\u001b')
        })

        test('an overlong category key is bounded and ellipsized rather than rendered in full', () => {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const longKey = 'a'.repeat(500)
          fs.writeFileSync(
            path.join(projectConfigDir, 'systematic.json'),
            JSON.stringify({
              categories: { [longKey]: { model: 'openai/x' } },
            }),
          )
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          loadConfigWithSources(testDir, { warningSink })

          expect(warnings).toHaveLength(1)
          expect(warnings[0]).toContain('\u2026')
          expect(warnings[0]).not.toContain('a'.repeat(200))
        })

        test('40+ protected-field strips across many entries yield 20 detailed warnings plus one summary warning', () => {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const categories: Record<string, Record<string, unknown>> = {}
          for (let index = 0; index < 7; index++) {
            categories[`cat${index}`] = {
              model: 'openai/x',
              variant: 'v',
              skills: ['s'],
              permission: { bash: 'allow' },
              opencode: {},
              pi: {},
            }
          }
          fs.writeFileSync(
            path.join(projectConfigDir, 'systematic.json'),
            JSON.stringify({ categories }),
          )
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          loadConfigWithSources(testDir, { warningSink })

          const detailed = warnings.filter((message) =>
            message.includes('is only valid in user config'),
          )
          const summaries = warnings.filter((message) =>
            message.includes('were suppressed'),
          )
          expect(detailed).toHaveLength(20)
          expect(summaries).toHaveLength(1)
          expect(summaries[0]).toContain('22')
          expect(warnings).toHaveLength(21)
        })

        test('the top-level `profiles`-ignored warning shares the same 20-detail cap as overlay-field strips', () => {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const categories: Record<string, Record<string, unknown>> = {}
          for (let index = 0; index < 3; index++) {
            categories[`cat${index}`] = {
              model: 'openai/x',
              variant: 'v',
              skills: ['s'],
              permission: { bash: 'allow' },
              opencode: {},
              pi: {},
            }
          }
          // 18 fields above + 2 more here = exactly 20 -- the whole detail
          // budget, before `profiles` is even considered. Previously
          // `profiles` bypassed this cap entirely and would have been
          // emitted as a 21st detailed warning regardless.
          categories.cat3 = { model: 'openai/x', variant: 'v' }
          fs.writeFileSync(
            path.join(projectConfigDir, 'systematic.json'),
            JSON.stringify({
              categories,
              profiles: { p: { agents: {} } },
            }),
          )
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          loadConfigWithSources(testDir, {
            warningSink,
            invalidSource: 'report',
          })

          const detailed = warnings.filter((message) =>
            message.includes('is only valid in user config'),
          )
          const summaries = warnings.filter((message) =>
            message.includes('were suppressed'),
          )
          expect(detailed).toHaveLength(20)
          expect(
            detailed.some((message) => message.includes('`profiles`')),
          ).toBe(false)
          expect(summaries).toHaveLength(1)
          expect(summaries[0]).toContain('1')
          expect(warnings).toHaveLength(21)
        })

        test('an ordinary short key and path produce the exact prior warning text, unchanged', () => {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const projectConfigPath = path.join(
            projectConfigDir,
            'systematic.json',
          )
          fs.writeFileSync(
            projectConfigPath,
            JSON.stringify({
              agents: { 'correctness-reviewer': { model: 'openai/x' } },
            }),
          )
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          loadConfigWithSources(testDir, { warningSink })

          expect(warnings).toEqual([
            `[systematic] \`agents.correctness-reviewer.model\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
          ])
        })

        test('two independent loads each get their own 20-warning budget', () => {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const categories: Record<string, Record<string, unknown>> = {}
          for (let index = 0; index < 4; index++) {
            categories[`cat${index}`] = {
              model: 'openai/x',
              variant: 'v',
              skills: ['s'],
              permission: { bash: 'allow' },
              opencode: {},
              pi: {},
            }
          }
          fs.writeFileSync(
            path.join(projectConfigDir, 'systematic.json'),
            JSON.stringify({ categories }),
          )

          const firstWarnings: string[] = []
          loadConfigWithSources(testDir, {
            warningSink: (message) => firstWarnings.push(message),
          })
          const secondWarnings: string[] = []
          loadConfigWithSources(testDir, {
            warningSink: (message) => secondWarnings.push(message),
          })

          for (const warnings of [firstWarnings, secondWarnings]) {
            const detailed = warnings.filter((message) =>
              message.includes('is only valid in user config'),
            )
            const summaries = warnings.filter((message) =>
              message.includes('were suppressed'),
            )
            expect(detailed).toHaveLength(20)
            expect(summaries).toHaveLength(1)
          }
        })

        test('every protected field is stripped from the merged config even when its warning was suppressed', () => {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          const categories: Record<string, Record<string, unknown>> = {}
          for (let index = 0; index < 4; index++) {
            categories[`cat${index}`] = {
              model: 'openai/x',
              variant: 'v',
              skills: ['s'],
              permission: { bash: 'allow' },
              opencode: {},
              pi: {},
              temperature: index,
            }
          }
          fs.writeFileSync(
            path.join(projectConfigDir, 'systematic.json'),
            JSON.stringify({ categories }),
          )
          const warnings: string[] = []
          const warningSink = (message: string) => warnings.push(message)

          const result = loadConfigWithSources(testDir, { warningSink })

          const summaries = warnings.filter((message) =>
            message.includes('were suppressed'),
          )
          expect(summaries).toHaveLength(1)
          for (let index = 0; index < 4; index++) {
            expect(result.config.categories?.[`cat${index}`]).toEqual({
              temperature: index,
            })
          }
        })
      })

      test('project same-key overlay preserves variant from higher-trust config', () => {
        writeUserConfig({
          agents: {
            'correctness-reviewer': {
              variant: 'large-context',
              model: 'openai/gpt-5',
              temperature: 0.1,
            },
          },
          categories: {
            review: {
              model: 'openai/gpt-5',
              variant: 'small',
              temperature: 0.2,
            },
          },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'correctness-reviewer': { hidden: true } },
            categories: { review: { temperature: 0.5 } },
          }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents?.['correctness-reviewer']).toEqual({
          hidden: true,
          variant: 'large-context',
          model: 'openai/gpt-5',
        })
        expect(result.config.categories?.review).toEqual({
          temperature: 0.5,
          model: 'openai/gpt-5',
          variant: 'small',
        })
      })

      test('custom config category overlay replaces project same-key overlay', () => {
        const customDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'systematic-custom-'),
        )
        process.env.OPENCODE_CONFIG_DIR = customDir

        try {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          fs.writeFileSync(
            path.join(projectConfigDir, 'systematic.json'),
            JSON.stringify({
              categories: {
                review: { steps: 8, temperature: 0.1 },
              },
            }),
          )

          const customConfigPath = path.join(customDir, 'systematic.json')
          fs.writeFileSync(
            customConfigPath,
            JSON.stringify({ categories: { review: { temperature: 0.7 } } }),
          )

          const result = loadConfigWithSources(testDir)

          expect(result.config.categories).toEqual({
            review: { temperature: 0.7 },
          })
          expect(result.overlays.categories.review?.sourcePath).toBe(
            customConfigPath,
          )
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
          fs.rmSync(customDir, { recursive: true, force: true })
        }
      })

      test('absent and empty overlay maps are valid no-ops', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({ agents: {}, categories: {} }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents).toEqual({})
        expect(result.config.categories).toEqual({})
        expect(result.overlays.agents).toEqual({})
        expect(result.overlays.categories).toEqual({})
      })

      test.each([
        ['agents container', { agents: null }, 'agents'],
        ['categories container', { categories: [] }, 'categories'],
        [
          'agent entry',
          { agents: { 'correctness-reviewer': 'openai/gpt-5' } },
          'agents.correctness-reviewer',
        ],
        [
          'category entry',
          { categories: { review: null } },
          'categories.review',
        ],
      ])('rejects invalid %s overlay values', (_name, config, keyPath) => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')
        fs.writeFileSync(projectConfigPath, JSON.stringify(config))

        expect(() => loadConfigWithSources(testDir)).toThrow(projectConfigPath)
        expect(() => loadConfigWithSources(testDir)).toThrow(keyPath)
      })

      test('preserves multiple bundled agent overlays across source priorities', () => {
        writeUserConfig({
          agents: { 'correctness-reviewer': { temperature: 0.1 } },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'security-reviewer': { temperature: 0.2 } },
          }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents).toEqual({
          'correctness-reviewer': { temperature: 0.1 },
          'security-reviewer': { temperature: 0.2 },
        })
      })
    })
  })

  describe('getConfigPaths', () => {
    test('returns user config path in .config/opencode/systematic.json', () => {
      const result = getConfigPaths(testDir)
      expect(result.userConfig).toBe(
        path.join(os.homedir(), '.config/opencode/systematic.json'),
      )
    })

    test('returns project config path in <projectDir>/.opencode/systematic.json', () => {
      const result = getConfigPaths(testDir)
      expect(result.projectConfig).toBe(
        path.join(testDir, '.opencode/systematic.json'),
      )
    })

    test('returns user dir path in .config/opencode/systematic/', () => {
      const result = getConfigPaths(testDir)
      expect(result.userDir).toBe(
        path.join(os.homedir(), '.config/opencode/systematic'),
      )
    })

    test('returns project dir path in <projectDir>/.opencode/systematic/', () => {
      const result = getConfigPaths(testDir)
      expect(result.projectDir).toBe(path.join(testDir, '.opencode/systematic'))
    })

    test('paths reference correct directories relative to project', () => {
      const customProjectDir = path.join(testDir, 'custom/project')
      const result = getConfigPaths(customProjectDir)

      expect(result.projectConfig).toContain('custom/project')
      expect(result.projectDir).toContain('custom/project')
      expect(result.userConfig).toContain(os.homedir())
      expect(result.userDir).toContain(os.homedir())
    })
  })

  describe('DEFAULT_CONFIG', () => {
    test('has disabled_skills as empty array', () => {
      expect(DEFAULT_CONFIG.disabled_skills).toEqual([])
    })

    test('has disabled_agents as empty array', () => {
      expect(DEFAULT_CONFIG.disabled_agents).toEqual([])
    })

    test('has disabled_commands as empty array', () => {
      expect(DEFAULT_CONFIG.disabled_commands).toEqual([])
    })

    test('has bootstrap.enabled set to true', () => {
      expect(DEFAULT_CONFIG.bootstrap.enabled).toBe(true)
    })

    test('has bootstrap.file undefined by default', () => {
      expect(DEFAULT_CONFIG.bootstrap.file).toBeUndefined()
    })

    test('has workflow_guard observe mode and debug disabled by default', () => {
      expect(DEFAULT_CONFIG.workflow_guard).toEqual({
        mode: 'observe',
        debug: false,
      })
    })
  })

  describe('OPENCODE_CONFIG_DIR environment variable', () => {
    afterEach(() => {
      delete process.env.OPENCODE_CONFIG_DIR
    })

    test('custom config from OPENCODE_CONFIG_DIR has highest priority', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      fs.writeFileSync(
        path.join(customDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:work'] }),
      )

      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:compound'] }),
      )

      const config = loadConfig(testDir)

      expect(config.disabled_skills).toContain('ce:work')
      expect(config.disabled_skills).toContain('ce:compound')

      fs.rmSync(customDir, { recursive: true, force: true })
    })

    test('empty string OPENCODE_CONFIG_DIR is treated as unset', () => {
      process.env.OPENCODE_CONFIG_DIR = ''

      const paths = getConfigPaths(testDir)

      expect(paths.customConfig).toBeUndefined()
      expect(paths.customDir).toBeUndefined()
    })

    test('whitespace-only OPENCODE_CONFIG_DIR is treated as unset', () => {
      process.env.OPENCODE_CONFIG_DIR = '   '

      const paths = getConfigPaths(testDir)

      expect(paths.customConfig).toBeUndefined()
      expect(paths.customDir).toBeUndefined()
    })

    test('non-existent OPENCODE_CONFIG_DIR path is handled gracefully', () => {
      process.env.OPENCODE_CONFIG_DIR = '/nonexistent/path/that/does/not/exist'

      expect(() => loadConfig(testDir)).not.toThrow()

      const config = loadConfig(testDir)
      expect(config.disabled_skills).toEqual([])
    })

    test('getConfigPaths includes customConfig and customDir when env var is set', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      const paths = getConfigPaths(testDir)

      expect(paths.customConfig).toBe(path.join(customDir, 'systematic.json'))
      expect(paths.customDir).toBe(path.join(customDir, 'systematic'))
      expect(paths.userConfig).toBeTruthy()
      expect(paths.projectConfig).toBeTruthy()

      fs.rmSync(customDir, { recursive: true, force: true })
    })

    test('custom config bootstrap settings override project and user', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      fs.writeFileSync(
        path.join(customDir, 'systematic.json'),
        JSON.stringify({ bootstrap: { enabled: false } }),
      )

      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({
          bootstrap: { enabled: true, file: 'project.md' },
        }),
      )

      const config = loadConfig(testDir)

      expect(config.bootstrap.enabled).toBe(false)
      expect(config.bootstrap.file).toBe('project.md')

      fs.rmSync(customDir, { recursive: true, force: true })
    })

    test('custom disabled_skills merges with project and user config', () => {
      writeUserConfig({ disabled_skills: ['ce:brainstorm'] })

      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:compound'] }),
      )

      fs.writeFileSync(
        path.join(customDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:work'] }),
      )

      const config = loadConfig(testDir)

      expect(config.disabled_skills).toContain('ce:brainstorm')
      expect(config.disabled_skills).toContain('ce:compound')
      expect(config.disabled_skills).toContain('ce:work')

      fs.rmSync(customDir, { recursive: true, force: true })
    })

    test('custom config directory directory contents are loaded', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      const customDirContents = path.join(customDir, 'systematic')
      fs.mkdirSync(customDirContents, { recursive: true })

      const paths = getConfigPaths(testDir)

      expect(paths.customDir).toBe(customDirContents)

      fs.rmSync(customDir, { recursive: true, force: true })
    })
  })

  describe('schema validation', () => {
    function writeProjectConfig(config: Record<string, unknown>): string {
      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      const projectConfigPath = path.join(projectConfigDir, 'systematic.json')
      fs.writeFileSync(projectConfigPath, JSON.stringify(config))
      return projectConfigPath
    }

    test('valid config loads identically — happy path regression', () => {
      writeProjectConfig({
        disabled_skills: ['ce:plan'],
        disabled_agents: ['security-reviewer'],
        bootstrap: { enabled: false },
      })
      const result = loadConfig(testDir)
      expect(result.disabled_skills).toContain('ce:plan')
      expect(result.disabled_agents).toContain('security-reviewer')
      expect(result.bootstrap.enabled).toBe(false)
    })

    test('disabled_skills as string is rejected with field name and source path in error', () => {
      const configPath = writeProjectConfig({ disabled_skills: 'not-an-array' })
      expect(() => loadConfig(testDir)).toThrow(configPath)
      expect(() => loadConfig(testDir)).toThrow('disabled_skills')
    })

    test('unknown top-level field is rejected by strict-mode schema with field name in error', () => {
      const configPath = writeProjectConfig({ agnts: {} })
      expect(() => loadConfig(testDir)).toThrow(configPath)
      expect(() => loadConfig(testDir)).toThrow('agnts')
    })

    test('project workflow_guard is stripped by the trust boundary', () => {
      writeProjectConfig({
        workflow_guard: { mode: 'disabled', debug: true },
      })

      expect(() => loadConfig(testDir)).not.toThrow()
      expect(loadConfig(testDir).workflow_guard).toEqual(
        DEFAULT_CONFIG.workflow_guard,
      )
    })

    // `model` is a SECURITY_OVERLAY_FIELDS member: a project-trust source has
    // it stripped (with a warning) before schema validation regardless of
    // its shape (see the `agent and category overlays` describe block for
    // that behavior's dedicated coverage), so it can no longer stand in for
    // "any malformed nested agent field" here. `hidden` is not
    // trust-protected, so a malformed value for it still reaches schema
    // validation and rejects with a nested field path.
    test('malformed agents.<key>.hidden is rejected with nested field path in error', () => {
      const configPath = writeProjectConfig({
        agents: { 'correctness-reviewer': { hidden: 'not-a-boolean' } },
      })
      expect(() => loadConfig(testDir)).toThrow(configPath)
      expect(() => loadConfig(testDir)).toThrow(
        'agents.correctness-reviewer.hidden',
      )
    })

    test('bootstrap.enabled as string is rejected with field path in error', () => {
      const configPath = writeProjectConfig({ bootstrap: { enabled: 'yes' } })
      expect(() => loadConfig(testDir)).toThrow(configPath)
      expect(() => loadConfig(testDir)).toThrow('bootstrap.enabled')
    })

    test('empty config loads with all Zod defaults applied', () => {
      writeProjectConfig({})
      const result = loadConfig(testDir)
      expect(result.disabled_skills).toEqual([])
      expect(result.disabled_agents).toEqual([])
      expect(result.disabled_commands).toEqual([])
      expect(result.bootstrap.enabled).toBe(true)
    })

    test('configs accepted by old hand-rolled validators now reject unknown top-level fields', () => {
      // Before schema validation was wired into the loader, any JSON object was
      // accepted without field-level checking. Unknown top-level fields silently
      // became no-ops. This test captures the expected behavior change: strict Zod
      // validation now runs on every loaded config source, making unknown fields
      // a hard error rather than a silent no-op.
      const configPath = writeProjectConfig({
        disabled_skills: [],
        unknownField: true,
      })
      expect(() => loadConfig(testDir)).toThrow(configPath)
      expect(() => loadConfig(testDir)).toThrow('unknownField')
    })

    test('user config schema validation failure names the user config file in error', () => {
      const userConfigFilePath = writeUserConfig({ disabled_skills: 'wrong' })
      expect(() => loadConfig(testDir)).toThrow(userConfigFilePath)
      expect(() => loadConfig(testDir)).toThrow('disabled_skills')
    })

    test('typo on agents key produces a message pointing at the documentation URL', () => {
      const configPath = writeProjectConfig({
        agents: { 'security-reviwer': { temperature: 0.1 } },
      })
      let errorMessage = ''
      try {
        loadConfig(testDir)
      } catch (err) {
        errorMessage = (err as Error).message
      }
      expect(errorMessage).toContain(configPath)
      expect(errorMessage).toContain('security-reviwer')
      expect(errorMessage).toContain(
        'https://fro.bot/systematic/reference/configuration#typed-validation',
      )
    })

    test('typo on disabled_agents value produces a message pointing at the documentation URL', () => {
      const configPath = writeProjectConfig({
        disabled_agents: ['security-reviwer'],
      })
      let errorMessage = ''
      try {
        loadConfig(testDir)
      } catch (err) {
        errorMessage = (err as Error).message
      }
      expect(errorMessage).toContain(configPath)
      // disabled_agents is an enum array — Zod reports a value-level error, not unrecognized_keys.
      // The error should still name the file and the invalid field path.
      expect(errorMessage).toContain('disabled_agents')
    })

    describe('enrichUnrecognizedKeyIssues — verbose enum suppression and multi-key handling', () => {
      const DOCS_URL =
        'https://fro.bot/systematic/reference/configuration#typed-validation'

      // #385 — suppress verbose enum list in disabled_agents / disabled_skills errors

      test('typo in disabled_agents produces a short message with the bad value and docs URL, not the full enum list', () => {
        writeProjectConfig({ disabled_agents: ['security-reviwer'] })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        expect(errorMessage).toContain('security-reviwer')
        expect(errorMessage).toContain('disabled_agents')
        expect(errorMessage).toContain(DOCS_URL)
        expect(errorMessage.length).toBeLessThan(500)
        // Must NOT dump the full valid-name list inline
        expect(errorMessage).not.toContain('adversarial-reviewer')
        expect(errorMessage).not.toContain('architecture-strategist')
      })

      test('typo in disabled_skills produces a short message with the bad value and docs URL', () => {
        writeProjectConfig({ disabled_skills: ['typed-config-validatoin'] })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        expect(errorMessage).toContain('typed-config-validatoin')
        expect(errorMessage).toContain('disabled_skills')
        expect(errorMessage).toContain(DOCS_URL)
        expect(errorMessage.length).toBeLessThan(500)
        // Must NOT dump the full valid-name list inline
        expect(errorMessage).not.toContain('ce:plan')
        expect(errorMessage).not.toContain('ce:brainstorm')
      })

      test('valid disabled_agents entry passes through enrichment unchanged', () => {
        writeProjectConfig({ disabled_agents: ['correctness-reviewer'] })
        expect(() => loadConfig(testDir)).not.toThrow()
        const result = loadConfig(testDir)
        expect(result.disabled_agents).toContain('correctness-reviewer')
      })

      // #386 — surface every unknown key in unrecognized_keys hints

      test("multiple typo'd agent keys produce a hint listing all of them", () => {
        writeProjectConfig({ agents: { 'typo-a': {}, 'typo-b': {} } })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        expect(errorMessage).toContain('typo-a')
        expect(errorMessage).toContain('typo-b')
        expect(errorMessage).toContain('Unrecognized keys')
      })

      test("single typo'd agent key still produces singular form", () => {
        writeProjectConfig({ agents: { 'typo-a': {} } })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        expect(errorMessage).toContain('typo-a')
        expect(errorMessage).toMatch(/Unrecognized key '/)
        expect(errorMessage).not.toMatch(/Unrecognized keys '/)
      })

      test("three typo'd agent keys produce a comma-separated list", () => {
        writeProjectConfig({
          agents: { 'typo-a': {}, 'typo-b': {}, 'typo-c': {} },
        })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        expect(errorMessage).toContain('typo-a')
        expect(errorMessage).toContain('typo-b')
        expect(errorMessage).toContain('typo-c')
        expect(errorMessage).toContain('Unrecognized keys')
      })

      // Finding 2 — mixed issues regression
      test('mixed agents typo and disabled_agents typo each produce their own enriched hint', () => {
        // Both unrecognized_keys (agents) and invalid_value (disabled_agents) in one config
        writeProjectConfig({
          agents: { 'typo-a': {}, 'typo-b': {} },
          disabled_agents: ['security-reviwer'],
        })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        // Both issues are now surfaced in the message. We verify the message
        // contains the docs URL (confirming enrichment fired) and is not a raw
        // enum dump (which would be thousands of chars).
        expect(errorMessage).toContain(DOCS_URL)
        expect(errorMessage.length).toBeLessThan(1000)
        // Must not dump the full enum list
        expect(errorMessage).not.toContain('adversarial-reviewer')
      })

      // Finding 3 — non-string disabled_agents entry edge case
      test('non-string disabled_agents entry produces a short generic hint', () => {
        // null is not a valid string entry — exercises the fallback branch where
        // resolveValueAtPath returns a non-string value
        writeProjectConfig({ disabled_agents: [null] })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        expect(errorMessage).toContain('disabled_agents')
        expect(errorMessage).toContain(DOCS_URL)
        expect(errorMessage.length).toBeLessThan(500)
        // Must not dump the full valid-name list inline
        expect(errorMessage).not.toContain('oracle')
        expect(errorMessage).not.toContain('correctness-reviewer')
      })

      // #391 — surface every issue in the human-readable message

      test('surfaces every issue when multiple Zod issues are returned', () => {
        writeProjectConfig({
          agents: { 'typo-agent-name': { color: 'primary' } },
          disabled_agents: ['security-reviwer'],
        })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (e) {
          errorMessage = (e as Error).message
        }
        // Both issues must surface in the human-readable message.
        expect(errorMessage).toContain('typo-agent-name')
        expect(errorMessage).toContain('security-reviwer')
        // Multi-line format with bullet prefix when multiple issues exist.
        expect(errorMessage).toMatch(/\n {2}-/)
      })

      test('preserves single-line format when only one issue is returned', () => {
        writeProjectConfig({
          agents: { 'typo-agent-name': { color: 'primary' } },
        })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (e) {
          errorMessage = (e as Error).message
        }
        // No bullet prefix; backward-compat one-line format.
        expect(errorMessage).not.toMatch(/\n {2}-/)
        expect(errorMessage).toContain('typo-agent-name')
      })
    })
  })

  describe('merge precedence after schema validation', () => {
    function writeProjectConfig(config: Record<string, unknown>): void {
      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify(config),
      )
    }

    test('user bootstrap.enabled:false is preserved when project config is empty', () => {
      // Regression: when result.data (Zod-hydrated) is propagated to
      // ConfigSource.config, Zod's default for bootstrap.enabled is true, so an
      // empty project config {} produces { bootstrap: { enabled: true } }. The
      // spread `...projectConfig?.bootstrap (= { enabled: true })` then clobbers
      // the user's explicit enabled: false. The loader must propagate the raw
      // parsed JSONC instead so the merge sees `undefined` for unset fields.
      writeUserConfig({ bootstrap: { enabled: false } })
      writeProjectConfig({})

      const result = loadConfig(testDir)
      expect(result.bootstrap.enabled).toBe(false)
    })

    test('user disabled_skills are preserved when project config is empty', () => {
      // disabled_skills has a Zod default of []. An empty project config
      // produces result.data.disabled_skills = [] which then gets merged
      // into the union set — that is safe because mergeArraysUnique([], [])
      // stays empty. But the user's value was already in the merge chain,
      // so this test double-checks the array path remains correct.
      writeUserConfig({ disabled_skills: ['ce:ideate'] })
      writeProjectConfig({})

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toContain('ce:ideate')
    })

    test('3-source: user bootstrap.enabled:false preserved through project {} and custom {}', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      try {
        writeUserConfig({ bootstrap: { enabled: false } })
        writeProjectConfig({})
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          JSON.stringify({}),
        )

        const result = loadConfig(testDir)
        expect(result.bootstrap.enabled).toBe(false)
      } finally {
        delete process.env.OPENCODE_CONFIG_DIR
        fs.rmSync(customDir, { recursive: true, force: true })
      }
    })

    test('user workflow_guard values survive empty project and custom configs', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      try {
        writeUserConfig({
          workflow_guard: { mode: 'protected', debug: true },
        })
        writeProjectConfig({})
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          JSON.stringify({}),
        )

        const result = loadConfig(testDir)

        expect(result.workflow_guard).toEqual({
          mode: 'protected',
          debug: true,
        })
      } finally {
        delete process.env.OPENCODE_CONFIG_DIR
        fs.rmSync(customDir, { recursive: true, force: true })
      }
    })

    test('custom workflow_guard partially overrides only the specified fields', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      try {
        writeUserConfig({
          workflow_guard: { mode: 'protected', debug: true },
        })
        writeProjectConfig({})
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          JSON.stringify({ workflow_guard: { mode: 'disabled' } }),
        )

        const result = loadConfig(testDir)

        expect(result.workflow_guard).toEqual({
          mode: 'disabled',
          debug: true,
        })
      } finally {
        delete process.env.OPENCODE_CONFIG_DIR
        fs.rmSync(customDir, { recursive: true, force: true })
      }
    })

    test('high-priority explicit project override still wins over user setting', () => {
      // The fix must NOT over-correct: if the project explicitly sets
      // bootstrap.enabled:true, that should still override user's false.
      writeUserConfig({ bootstrap: { enabled: false } })
      writeProjectConfig({ bootstrap: { enabled: true } })

      const result = loadConfig(testDir)
      expect(result.bootstrap.enabled).toBe(true)
    })

    test('invalid user config type is rejected by schema validation', () => {
      // Schema validation must still run even though we propagate rawConfig.
      const userConfigFilePath = writeUserConfig({
        disabled_skills: 'not-an-array',
      })

      expect(() => loadConfig(testDir)).toThrow(userConfigFilePath)
      expect(() => loadConfig(testDir)).toThrow('disabled_skills')
    })
  })

  describe('removed bundled skill names (warn-and-ignore)', () => {
    function writeProjectConfig(config: Record<string, unknown>): void {
      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify(config),
      )
    }

    test('disabled_skills with "orchestrating-swarms" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_skills: ['orchestrating-swarms'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_skills).not.toContain('orchestrating-swarms')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "orchestrating-swarms" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_skills with "claude-permissions-optimizer" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_skills: ['claude-permissions-optimizer'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_skills).not.toContain(
        'claude-permissions-optimizer',
      )
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "claude-permissions-optimizer" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_skills with "writing-systematic-skills" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_skills: ['writing-systematic-skills'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_skills).not.toContain('writing-systematic-skills')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "writing-systematic-skills" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_skills with a genuinely-unknown name still throws the actionable schema error', () => {
      writeProjectConfig({ disabled_skills: ['never-existed-skill'] })

      expect(() => loadConfig(testDir)).toThrow('disabled_skills')
      expect(() => loadConfig(testDir)).toThrow('never-existed-skill')
    })

    test('mixed removed and valid disabled_skills: removed name dropped-with-warning, valid name retained', () => {
      writeProjectConfig({
        disabled_skills: ['orchestrating-swarms', 'ce:review'],
      })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      const result = loadConfig(testDir)

      expect(result.disabled_skills).not.toContain('orchestrating-swarms')
      expect(result.disabled_skills).toContain('ce:review')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "orchestrating-swarms" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_skills with "rclone" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_skills: ['rclone'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_skills).not.toContain('rclone')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "rclone" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('mixed valid and removed disabled_skills ("test-driven-development", "setup"): valid honored, removed warned', () => {
      writeProjectConfig({
        disabled_skills: ['test-driven-development', 'setup'],
      })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      const result = loadConfig(testDir)

      expect(result.disabled_skills).toContain('test-driven-development')
      expect(result.disabled_skills).not.toContain('setup')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "setup" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('"todos" is present in the bundled skill names (merged todo-create/todo-triage/todo-resolve)', () => {
      expect(BUNDLED_SKILL_NAMES).toContain('todos')
    })

    test('disabled_skills with "todo-create" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_skills: ['todo-create'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_skills).not.toContain('todo-create')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "todo-create" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_agents with "security-sentinel" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_agents: ['security-sentinel'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_agents).not.toContain('security-sentinel')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "security-sentinel" in `disabled_agents` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('mixed valid and removed disabled_agents ("correctness-reviewer", "performance-oracle"): valid honored, removed warned', () => {
      writeProjectConfig({
        disabled_agents: ['correctness-reviewer', 'performance-oracle'],
      })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      const result = loadConfig(testDir)

      expect(result.disabled_agents).toContain('correctness-reviewer')
      expect(result.disabled_agents).not.toContain('performance-oracle')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "performance-oracle" in `disabled_agents` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_agents with qualified removed agent "review/security-sentinel" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_agents: ['review/security-sentinel'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_agents).not.toContain('review/security-sentinel')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "review/security-sentinel" in `disabled_agents` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_agents with qualified removed agent "design/figma-design-sync" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_agents: ['design/figma-design-sync'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_agents).not.toContain('design/figma-design-sync')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "design/figma-design-sync" in `disabled_agents` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })
  })

  describe('removed bundled agent categories (warn-and-ignore)', () => {
    test('categories.docs is dropped and warns about its v3.0.0 removal', () => {
      writeUserConfig({ categories: { docs: { model: 'openai/gpt-4' } } })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      const result = loadConfig(testDir)

      expect(result.categories).not.toHaveProperty('docs')
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(
        /categories\.docs.*removed in v3\.0\.0.*https:\/\/fro\.bot\/systematic\/guides\/v3-migration\//,
      )
      warnSpy.mockRestore()
    })

    test('valid categories remain after removing categories.docs', () => {
      writeUserConfig({
        categories: {
          docs: { model: 'openai/gpt-4' },
          review: { model: 'anthropic/claude-sonnet-4' },
        },
      })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      const result = loadConfig(testDir)

      expect(result.categories).toEqual({
        review: { model: 'anthropic/claude-sonnet-4' },
      })
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe('JSONC precedence', () => {
    test('only systematic.json exists -- loads it (backward compat)', () => {
      writeUserConfig({ disabled_skills: ['ce:plan'] })

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toContain('ce:plan')
      expect(result.disabled_skills).toEqual(['ce:plan'])
    })

    test('only systematic.jsonc exists -- loads it correctly', () => {
      const filePath = userConfigPath().replace(/\.json$/, '.jsonc')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(
        filePath,
        '{\n  // This is a comment\n  "disabled_skills": ["ce:review"]\n}\n',
      )

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toContain('ce:review')
    })

    test('JSONC with comments and standard JSON structure parses correctly', () => {
      const filePath = userConfigPath().replace(/\.json$/, '.jsonc')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(
        filePath,
        '{\n  // Comment explaining why this skill is disabled\n  "disabled_skills": ["ce:plan"]\n}\n',
      )

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toEqual(['ce:plan'])
    })

    test('both jsonc and json exist -- .jsonc is loaded, .json is ignored', () => {
      const jsoncPath = userConfigPath().replace(/\.json$/, '.jsonc')
      const jsonPath = userConfigPath()
      fs.mkdirSync(path.dirname(jsoncPath), { recursive: true })

      fs.writeFileSync(
        jsonPath,
        JSON.stringify({ disabled_skills: ['ce:plan'] }),
      )
      fs.writeFileSync(jsoncPath, '{\n  "disabled_skills": ["ce:review"]\n}\n')

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toEqual(['ce:review'])
    })

    test('project jsonc takes precedence over project json', () => {
      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })

      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:plan'] }),
      )
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.jsonc'),
        JSON.stringify({ disabled_skills: ['ce:review'] }),
      )

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toEqual(['ce:review'])
    })

    test('custom config jsonc takes precedence over custom config json', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      try {
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          JSON.stringify({ disabled_skills: ['ce:plan'] }),
        )
        fs.writeFileSync(
          path.join(customDir, 'systematic.jsonc'),
          JSON.stringify({ disabled_skills: ['ce:review'] }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toEqual(['ce:review'])
      } finally {
        delete process.env.OPENCODE_CONFIG_DIR
        fs.rmSync(customDir, { recursive: true, force: true })
      }
    })

    test('getConfigPaths returns .jsonc path when .jsonc exists', () => {
      const jsoncPath = path.join(
        os.homedir(),
        '.config/opencode/systematic.jsonc',
      )
      fs.mkdirSync(path.dirname(jsoncPath), { recursive: true })
      fs.writeFileSync(jsoncPath, '{}')

      const paths = getConfigPaths(testDir)
      expect(paths.userConfig).toBe(jsoncPath)
    })

    test('getConfigPaths returns .json fallback when neither exists', () => {
      const paths = getConfigPaths(testDir)
      expect(paths.userConfig).toBe(
        path.join(os.homedir(), '.config/opencode/systematic.json'),
      )
    })

    test('malformed jsonc throws parse error with file path', () => {
      const filePath = userConfigPath().replace(/\.json$/, '.jsonc')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, '{invalid jsonc')

      expect(() => loadConfig(testDir)).toThrow(filePath)
      expect(() => loadConfig(testDir)).toThrow(/parse error/i)
    })

    test('accepts $schema field in JSONC config without raising configSchemaError', () => {
      const filePath = userConfigPath().replace(/\.json$/, '.jsonc')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(
        filePath,
        [
          '// Top-level user config',
          '{',
          '  "$schema": "https://fro.bot/systematic/schemas/v2/systematic-config.schema.json",',
          '  "disabled_skills": []',
          '}',
        ].join('\n'),
      )

      expect(() => loadConfig(testDir)).not.toThrow()
      const result = loadConfig(testDir)
      expect(result.disabled_skills).toEqual([])
    })
  })

  describe('removed-name drop and warn', () => {
    // These tests exercise the drop+warn helpers directly with synthetic inputs.
    // The production removed-names list is empty (the mechanism ships before any
    // name is actually removed), so the real load path cannot be exercised
    // end-to-end without injecting synthetic removed names. The helpers are
    // exported for exactly this purpose.

    test('computeDroppedNames returns names absent from the allowed set', () => {
      const allowed = new Set(['ce:plan', 'ce:review'])
      const result = computeDroppedNames(['ce:plan', 'gone-skill'], allowed)
      expect(result).toEqual(['gone-skill'])
    })

    test('computeDroppedNames returns empty array when all names are in the allowed set', () => {
      const allowed = new Set(['ce:plan', 'ce:review'])
      const result = computeDroppedNames(['ce:plan', 'ce:review'], allowed)
      expect(result).toEqual([])
    })

    test('computeDroppedNames returns empty array for empty input', () => {
      const allowed = new Set(['ce:plan'])
      const result = computeDroppedNames([], allowed)
      expect(result).toEqual([])
    })

    test('computeDroppedNames returns all names when allowed set is empty', () => {
      const allowed = new Set<string>()
      const result = computeDroppedNames(['gone-a', 'gone-b'], allowed)
      expect(result).toEqual(['gone-a', 'gone-b'])
    })

    test('warnDroppedNames emits a [systematic] warning naming each dropped entry', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        warnDroppedNames(['gone-skill'], 'disabled_skills', new Set())
        const calls = warnSpy.mock.calls as unknown[][]
        expect(calls).toHaveLength(1)
        const msg = (calls[0] as unknown[])[0] as string
        expect(msg).toContain('[systematic]')
        expect(msg).toContain('gone-skill')
        expect(msg).toContain('disabled_skills')
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('warnDroppedNames emits no warning when dropped list is empty', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        warnDroppedNames([], 'disabled_skills', new Set())
        expect(warnSpy.mock.calls).toHaveLength(0)
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('warnDroppedNames deduplicates within a single call via the provided warned set', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const warned = new Set<string>()
        // Two entries with the same name -- should warn only once
        warnDroppedNames(
          ['gone-skill', 'gone-skill'],
          'disabled_skills',
          warned,
        )
        expect(warnSpy.mock.calls).toHaveLength(1)
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('warnDroppedNames does not suppress a different entry across separate calls (no sticky global state)', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // First load invocation
        const warned1 = new Set<string>()
        warnDroppedNames(['gone-skill-a'], 'disabled_skills', warned1)

        // Second independent load invocation uses a fresh warned set
        const warned2 = new Set<string>()
        warnDroppedNames(['gone-skill-b'], 'disabled_skills', warned2)

        const calls = warnSpy.mock.calls as unknown[][]
        expect(calls).toHaveLength(2)
        expect((calls[0] as unknown[])[0] as string).toContain('gone-skill-a')
        expect((calls[1] as unknown[])[0] as string).toContain('gone-skill-b')
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('warnDroppedNames does not suppress the same entry in a second independent load (no cross-load suppression)', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // First load invocation
        const warned1 = new Set<string>()
        warnDroppedNames(['gone-skill'], 'disabled_skills', warned1)

        // Second independent load -- fresh warned set, same entry should warn again
        const warned2 = new Set<string>()
        warnDroppedNames(['gone-skill'], 'disabled_skills', warned2)

        expect(warnSpy.mock.calls).toHaveLength(2)
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('warnDroppedNames names each dropped entry individually when multiple are dropped', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const warned = new Set<string>()
        warnDroppedNames(['gone-a', 'gone-b'], 'disabled_agents', warned)
        const calls = warnSpy.mock.calls as unknown[][]
        const combined = calls
          .map((c) => (c as unknown[])[0] as string)
          .join('\n')
        expect(combined).toContain('gone-a')
        expect(combined).toContain('gone-b')
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('empty removed-name lists produce no stale-name warning and no behavior change (invariant)', () => {
      // With empty removed lists, the production schema behaves identically to before.
      // A valid config still loads; no stale-name warning is emitted.
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir, { recursive: true })
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({ disabled_skills: ['ce:plan'] }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toContain('ce:plan')

        const staleWarnings = (warnSpy.mock.calls as unknown[][]).filter(
          (args) =>
            typeof (args as unknown[])[0] === 'string' &&
            ((args as unknown[])[0] as string).includes(
              'no longer a bundled name',
            ),
        )
        expect(staleWarnings).toHaveLength(0)
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('unknown name still throws the actionable schema error (warning path does not swallow it)', () => {
      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['never-existed-skill'] }),
      )

      expect(() => loadConfig(testDir)).toThrow(/never-existed-skill/)
    })

    test('merge precedence is unchanged when a valid name is present alongside other config', () => {
      // Verifies that the drop+warn step does not disturb merge precedence for
      // other fields. Project bootstrap.enabled:true overrides user false.
      writeUserConfig({ bootstrap: { enabled: false } })

      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ bootstrap: { enabled: true } }),
      )

      const result = loadConfig(testDir)
      expect(result.bootstrap.enabled).toBe(true)
    })

    test('raw config object is not mutated by the drop step', () => {
      // loadConfigWithSources returns the raw config in overlays; the drop must
      // not mutate it. We verify by checking that the returned config reflects
      // the drop while the raw source config (accessible via a second load) is
      // still intact. Since we cannot directly inspect the raw config object
      // from outside, we verify the effective config is correct and that a
      // second load produces the same result (no mutation side-effect).
      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:plan'] }),
      )

      const result1 = loadConfig(testDir)
      const result2 = loadConfig(testDir)
      expect(result1.disabled_skills).toEqual(result2.disabled_skills)
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  // Unit 2 (plan 2026-09-04-002-feat-model-config-profiles): profile
  // selection and the four-entry merge chain (user base -> active profile
  // -> project -> custom).
  // ════════════════════════════════════════════════════════════════════════
  describe('profile selection', () => {
    let warnings: string[]
    let warningSink: (message: string) => void

    beforeEach(() => {
      warnings = []
      warningSink = (message: string) => warnings.push(message)
    })

    function writeProjectConfig(config: Record<string, unknown>): string {
      const dir = path.join(testDir, '.opencode')
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, 'systematic.json')
      fs.writeFileSync(filePath, JSON.stringify(config))
      return filePath
    }

    function withCustomConfig<T>(
      config: Record<string, unknown>,
      fn: (customDir: string) => T,
    ): T {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-profile-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir
      fs.writeFileSync(
        path.join(customDir, 'systematic.json'),
        JSON.stringify(config),
      )
      try {
        return fn(customDir)
      } finally {
        delete process.env.OPENCODE_CONFIG_DIR
        fs.rmSync(customDir, { recursive: true, force: true })
      }
    }

    function withEnvProfile<T>(value: string, fn: () => T): T {
      const previous = process.env.SYSTEMATIC_PROFILE
      process.env.SYSTEMATIC_PROFILE = value
      try {
        return fn()
      } finally {
        if (previous === undefined) delete process.env.SYSTEMATIC_PROFILE
        else process.env.SYSTEMATIC_PROFILE = previous
      }
    }

    // Case 1: no selector anywhere.
    test('case 1: no source sets profile → base configuration, no warning', () => {
      writeUserConfig({
        profiles: {
          personal: { agents: { 'correctness-reviewer': { model: 'a/a' } } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBeNull()
      expect(result.metadata.profileSelectorSource).toBeNull()
      expect(result.metadata.profileFallback).toBeNull()
      expect(warnings).toEqual([])
    })

    // A typo inside a profile bundle's `agents`/`categories` keys is a
    // config error, exactly like a typo at the top level -- not silently
    // ignored or merely warned about.
    test('a profile bundle agent key that is not a real bundled agent name throws a config error', () => {
      writeUserConfig({
        profile: 'p',
        profiles: {
          p: {
            agents: { 'totally-not-a-real-agent': { model: 'a/x' } },
          },
        },
      })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /profiles\.p\.agents\.totally-not-a-real-agent/,
      )
    })

    test('a profile bundle category key that is not a real bundled category throws a config error', () => {
      writeUserConfig({
        profile: 'p',
        profiles: {
          p: {
            categories: { 'not-a-real-category': { model: 'a/x' } },
          },
        },
      })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /profiles\.p\.categories\.not-a-real-category/,
      )
    })

    // Every profile bundle is validated at load, regardless of selection: a
    // typo in an unselected bundle must fail config load immediately, not
    // stay silent until some later repository selects it.
    test('a typo in an unselected profile bundle throws at load, with no selector set anywhere', () => {
      writeUserConfig({
        profiles: {
          work: {
            agents: { 'not-an-agent': { model: 'a/x' } },
          },
        },
      })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /profiles\.work\.agents\.not-an-agent/,
      )
    })

    test('a typo in a profile bundle throws the same error whether or not a project selects it', () => {
      writeUserConfig({
        profiles: {
          work: {
            agents: { 'not-an-agent': { model: 'a/x' } },
          },
        },
      })
      writeProjectConfig({ profile: 'work' })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /profiles\.work\.agents\.not-an-agent/,
      )
    })

    test('a valid profile bundle that is never selected still loads fine', () => {
      writeUserConfig({
        profiles: {
          work: {
            agents: { 'correctness-reviewer': { model: 'a/work' } },
          },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBeNull()
      expect(result.config.agents?.['correctness-reviewer']).toBeUndefined()
      expect(warnings).toEqual([])
    })

    test('a category/key qualified key in a profile bundle is accepted and resolves', () => {
      writeUserConfig({
        profile: 'work',
        profiles: {
          work: {
            agents: { 'review/correctness-reviewer': { model: 'a/qualified' } },
          },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBe('work')
      const target: RoutingTarget = {
        agentKey: 'correctness-reviewer',
        category: 'review',
      }
      const resolution = resolveRouting({
        overlays: result.overlays,
        piSubagentsOverlays: result.piSubagentsOverlays,
        target,
        harness: 'opencode',
      })
      expect(resolution.model).toBe('a/qualified')
    })

    // Case 2: user default only.
    test('case 2: user default profile only → that profile is active', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'anthropic/claude-a' } },
          },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBe('personal')
      expect(result.metadata.profileSelectorSource).toBe('user')
      expect(result.metadata.profileFallback).toBeNull()
      expect(result.config.agents?.['correctness-reviewer']).toEqual({
        model: 'anthropic/claude-a',
      })
      expect(warnings).toEqual([])
    })

    // Case 3: project selector over user default.
    test('case 3: project profile selector wins over user default', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
          work: { agents: { 'correctness-reviewer': { model: 'a/work' } } },
        },
      })
      writeProjectConfig({ profile: 'work' })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBe('work')
      expect(result.metadata.profileSelectorSource).toBe('project')
      expect(result.config.agents?.['correctness-reviewer']).toEqual({
        model: 'a/work',
      })
      expect(warnings).toEqual([])
    })

    // Case 4: custom over both.
    test('case 4: custom profile selector wins over project and user default', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
          work: { agents: { 'correctness-reviewer': { model: 'a/work' } } },
          ci: { agents: { 'correctness-reviewer': { model: 'a/ci' } } },
        },
      })
      writeProjectConfig({ profile: 'work' })

      withCustomConfig({ profile: 'ci' }, () => {
        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBe('ci')
        expect(result.metadata.profileSelectorSource).toBe('custom')
        expect(result.config.agents?.['correctness-reviewer']).toEqual({
          model: 'a/ci',
        })
        expect(warnings).toEqual([])
      })
    })

    test('SYSTEMATIC_PROFILE wins over a user-config profile selecting a different bundle', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
          work: { agents: { 'correctness-reviewer': { model: 'a/work' } } },
        },
      })

      withEnvProfile('work', () => {
        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBe('work')
        expect(result.metadata.profileSelectorSource).toBe('environment')
        expect(result.config.agents?.['correctness-reviewer']).toEqual({
          model: 'a/work',
        })
        expect(warnings).toEqual([])
      })
    })

    test('SYSTEMATIC_PROFILE wins over a project-set profile selector', () => {
      writeUserConfig({
        profiles: {
          work: { agents: { 'correctness-reviewer': { model: 'a/work' } } },
          ci: { agents: { 'correctness-reviewer': { model: 'a/ci' } } },
        },
      })
      writeProjectConfig({ profile: 'work' })

      withEnvProfile('ci', () => {
        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBe('ci')
        expect(result.metadata.profileSelectorSource).toBe('environment')
        expect(warnings).toEqual([])
      })
    })

    test('SYSTEMATIC_PROFILE wins over a custom-config profile selector, the otherwise-strongest source', () => {
      writeUserConfig({
        profiles: {
          work: { agents: { 'correctness-reviewer': { model: 'a/work' } } },
          ci: { agents: { 'correctness-reviewer': { model: 'a/ci' } } },
          env: { agents: { 'correctness-reviewer': { model: 'a/env' } } },
        },
      })
      writeProjectConfig({ profile: 'work' })

      withCustomConfig({ profile: 'ci' }, () => {
        withEnvProfile('env', () => {
          const result = loadConfigWithSources(testDir, { warningSink })

          expect(result.metadata.activeProfile).toBe('env')
          expect(result.metadata.profileSelectorSource).toBe('environment')
          expect(warnings).toEqual([])
        })
      })
    })

    test('SYSTEMATIC_PROFILE naming a nonexistent bundle falls back like a missing config selector, with a warning naming the environment', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })

      withEnvProfile('ghost', () => {
        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBe('personal')
        expect(result.metadata.profileSelectorSource).toBe('environment')
        expect(result.metadata.profileFallback).toEqual({
          requested: 'ghost',
          usedDefault: 'personal',
        })
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toBe(
          '[systematic] profile "ghost" (selected by SYSTEMATIC_PROFILE) is not defined in `profiles`; falling back to your default profile "personal". See https://fro.bot/systematic/reference/configuration#profiles for how to define a profile.',
        )
      })
    })

    test('SYSTEMATIC_PROFILE set to an empty or whitespace-only value is treated as unset', () => {
      writeUserConfig({
        profiles: {
          work: { agents: { 'correctness-reviewer': { model: 'a/work' } } },
        },
      })
      writeProjectConfig({ profile: 'work' })

      withEnvProfile('', () => {
        const result = loadConfigWithSources(testDir, { warningSink })
        expect(result.metadata.activeProfile).toBe('work')
        expect(result.metadata.profileSelectorSource).toBe('project')
      })

      withEnvProfile('   ', () => {
        const result = loadConfigWithSources(testDir, { warningSink })
        expect(result.metadata.activeProfile).toBe('work')
        expect(result.metadata.profileSelectorSource).toBe('project')
      })
    })

    // Project `profiles` is protected/stripped (PROJECT_PROTECTED_FIELDS) --
    // SYSTEMATIC_PROFILE naming a bundle that exists only there must not
    // reach it. This is the guard proving the env var can never select
    // content the project itself supplied.
    test('SYSTEMATIC_PROFILE naming a project-only profiles bundle cannot select it; normal fallback applies', () => {
      writeUserConfig({
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      const projectConfigPath = writeProjectConfig({
        profiles: {
          sneaky: {
            agents: { 'correctness-reviewer': { model: 'a/sneaky' } },
          },
        },
      })

      withEnvProfile('sneaky', () => {
        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBeNull()
        expect(result.metadata.profileSelectorSource).toBe('environment')
        expect(result.metadata.profileFallback).toEqual({
          requested: 'sneaky',
          usedDefault: null,
        })
        expect(result.config.agents?.['correctness-reviewer']).toBeUndefined()

        const profilesWarning = warnings.find((w) => w.includes('`profiles`'))
        expect(profilesWarning).toBeDefined()
        expect(profilesWarning).toContain(projectConfigPath)
        // One warning for the stripped project `profiles` map, one for the
        // missing-name fallback -- not more.
        expect(warnings).toHaveLength(2)
      })
    })

    // Case 5: project names an undefined profile, user default is defined and valid.
    test('case 5: project selects a missing profile, falls back to defined user default with one warning', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      writeProjectConfig({ profile: 'ghost' })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBe('personal')
      expect(result.metadata.profileSelectorSource).toBe('project')
      expect(result.metadata.profileFallback).toEqual({
        requested: 'ghost',
        usedDefault: 'personal',
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('ghost')
      expect(warnings[0]).toContain('personal')
    })

    // Case 6: project names undefined, user default is also a name that's undefined.
    test('case 6: project selects a missing profile and user default is also missing → base, one warning', () => {
      writeUserConfig({
        profile: 'also-ghost',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      writeProjectConfig({ profile: 'ghost' })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBeNull()
      expect(result.metadata.profileSelectorSource).toBe('project')
      expect(result.metadata.profileFallback).toEqual({
        requested: 'ghost',
        usedDefault: null,
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('ghost')
      expect(warnings[0]).toContain('also-ghost')
    })

    // Case 7: project names undefined, no user default at all.
    test('case 7: project selects a missing profile and the user has no default → base, one warning', () => {
      writeUserConfig({
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      writeProjectConfig({ profile: 'ghost' })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBeNull()
      expect(result.metadata.profileSelectorSource).toBe('project')
      expect(result.metadata.profileFallback).toEqual({
        requested: 'ghost',
        usedDefault: null,
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('ghost')
    })

    // The warning must name exactly the source that selected the missing
    // name and what was used instead -- never implying the fallback
    // default came from a source other than the one actually consulted.
    test('project-invalid missing-profile warning names project as the selector and states no default is configured', () => {
      writeUserConfig({
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      writeProjectConfig({ profile: 'ghost' })

      loadConfigWithSources(testDir, { warningSink })

      expect(warnings).toEqual([
        '[systematic] profile "ghost" (selected by project config) is not defined in `profiles`; using base configuration (no profile). No default profile is configured (`profile` in your user config). See https://fro.bot/systematic/reference/configuration#profiles for how to define a profile.',
      ])
    })

    test('custom-invalid missing-profile warning names custom as the selector, never claims a user default was used', () => {
      writeUserConfig({
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })

      withCustomConfig({ profile: 'ghost' }, () => {
        loadConfigWithSources(testDir, { warningSink })

        expect(warnings).toEqual([
          '[systematic] profile "ghost" (selected by custom config) is not defined in `profiles`; using base configuration (no profile). No default profile is configured (`profile` in your user config). See https://fro.bot/systematic/reference/configuration#profiles for how to define a profile.',
        ])
      })
    })

    test('a control-character profile selector cannot forge a line in the missing-profile warning', () => {
      writeProjectConfig({ profile: 'evil\ncat\u001b[31mFAKE\u001b[0m' })

      loadConfigWithSources(testDir, { warningSink })

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).not.toContain('\n')
      expect(warnings[0]).not.toContain('\u001b')
      expect(warnings[0]).toContain('\\u000a')
      expect(warnings[0]).toContain('\\u001b')
    })

    test('a control-character trusted default profile name cannot forge a line in the fallback warning', () => {
      writeUserConfig({
        profile: 'safe\ndefault',
        profiles: {
          'safe\ndefault': {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      writeProjectConfig({ profile: 'ghost' })

      loadConfigWithSources(testDir, { warningSink })

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).not.toContain('\n')
      expect(warnings[0]).toContain('\\u000a')
      expect(warnings[0]).toContain('falling back to your default profile')
    })

    // Case 8: custom names undefined, user default defined and valid.
    test('case 8: custom selects a missing profile, falls back to defined user default', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })

      withCustomConfig({ profile: 'ghost' }, () => {
        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBe('personal')
        expect(result.metadata.profileSelectorSource).toBe('custom')
        expect(result.metadata.profileFallback).toEqual({
          requested: 'ghost',
          usedDefault: 'personal',
        })
        expect(warnings).toHaveLength(1)
      })
    })

    // Case 9: custom names undefined, default undefined.
    test('case 9: custom selects a missing profile and default is missing → base', () => {
      writeUserConfig({
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })

      withCustomConfig({ profile: 'ghost' }, () => {
        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBeNull()
        expect(result.metadata.profileSelectorSource).toBe('custom')
        expect(result.metadata.profileFallback).toEqual({
          requested: 'ghost',
          usedDefault: null,
        })
        expect(warnings).toHaveLength(1)
      })
    })

    // Case 10: user default itself is undefined (no loop).
    test("case 10: user's own default names a missing profile → base, one warning, no loop", () => {
      writeUserConfig({
        profile: 'ghost',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBeNull()
      expect(result.metadata.profileSelectorSource).toBe('user')
      expect(result.metadata.profileFallback).toEqual({
        requested: 'ghost',
        usedDefault: null,
      })
      expect(warnings).toHaveLength(1)
    })

    // Case 11: explicit null wins outright, no warning.
    test('case 11a: project profile: null overrides user default → base, no warning', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      writeProjectConfig({ profile: null })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBeNull()
      expect(result.metadata.profileSelectorSource).toBe('project')
      expect(result.metadata.profileFallback).toBeNull()
      expect(warnings).toEqual([])
    })

    test('case 11b: custom profile: null overrides a project name → base, no warning', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      writeProjectConfig({ profile: 'personal' })

      withCustomConfig({ profile: null }, () => {
        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBeNull()
        expect(result.metadata.profileSelectorSource).toBe('custom')
        expect(result.metadata.profileFallback).toBeNull()
        expect(warnings).toEqual([])
      })
    })

    // Project `profiles` is protected: stripped, one warning, its bundles are
    // never selectable even if the project also sets `profile`.
    test('project-defined profiles map is stripped with one warning and is never selectable', () => {
      writeUserConfig({
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      const projectConfigPath = writeProjectConfig({
        profile: 'sneaky',
        profiles: {
          sneaky: { agents: { 'correctness-reviewer': { model: 'a/sneaky' } } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      // The project's own 'sneaky' bundle is not in the user's profiles map,
      // so selecting it is exactly the "missing name, no user default" path.
      expect(result.metadata.activeProfile).toBeNull()
      expect(result.metadata.profileFallback).toEqual({
        requested: 'sneaky',
        usedDefault: null,
      })
      expect(result.config.agents?.['correctness-reviewer']).toBeUndefined()

      const profilesWarning = warnings.find((w) => w.includes('`profiles`'))
      expect(profilesWarning).toBeDefined()
      expect(profilesWarning).toContain(projectConfigPath)
      // Exactly one warning about the stripped `profiles` map, plus exactly
      // one about the missing selector fallback -- not more.
      expect(warnings).toHaveLength(2)
    })

    describe('allow_project_profiles opt-in gates the strip', () => {
      test('opt-in ON via user config: project-defined `profiles` is not stripped and produces no "ignored" warning', () => {
        writeUserConfig({ allow_project_profiles: true })
        writeProjectConfig({
          profiles: {
            sneaky: {
              agents: { 'correctness-reviewer': { model: 'a/sneaky' } },
            },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })

        // No project-trust "ignored"/"not selectable" warning for `profiles`
        // at all -- with the opt-in on, `profiles` was never recorded as a
        // blocked field in the first place (see `collectProjectProtectedFields`).
        expect(warnings.some((message) => message.includes('`profiles`'))).toBe(
          false,
        )
        expect(
          result.metadata.protectedFields.some(
            (field) => field.fieldPath === 'profiles',
          ),
        ).toBe(false)
      })

      test('opt-in ON, malformed project `profiles`: rejected by normal schema validation, not silently dropped', () => {
        writeUserConfig({ allow_project_profiles: true })
        const projectConfigPath = writeProjectConfig({
          profiles: {
            sneaky: {
              // Unknown agent key -- rejected by the strict per-bundle schema.
              // If `profiles` had still been stripped pre-validation (the
              // opt-in-off behavior), this would never reach the schema and
              // would load silently instead of throwing.
              agents: { 'not-a-real-agent-name': { model: 'a/x' } },
            },
          },
        })

        expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
          projectConfigPath,
        )
        expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
          'not-a-real-agent-name',
        )
      })

      test('opt-in ON via custom config only, user config absent: project-defined `profiles` still survives (ordering regression)', () => {
        // No writeUserConfig call at all -- the opt-in exists ONLY in the
        // OPENCODE_CONFIG_DIR custom source. If the opt-in were resolved
        // from user config only, or resolved after the project source was
        // already parsed, this would fall back to the opt-in-off behavior
        // and the malformed `profiles` map below would be silently dropped
        // instead of rejected.
        const customDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'systematic-allow-project-profiles-custom-'),
        )
        process.env.OPENCODE_CONFIG_DIR = customDir
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          JSON.stringify({ allow_project_profiles: true }),
        )
        const projectConfigPath = writeProjectConfig({
          profiles: {
            sneaky: { agents: { 'not-a-real-agent-name': { model: 'a/x' } } },
          },
        })

        try {
          expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
            projectConfigPath,
          )
          expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
            'not-a-real-agent-name',
          )
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
          fs.rmSync(customDir, { recursive: true, force: true })
        }
      })

      test('opt-in ON via custom config only, user config explicitly false: custom still wins (ordering regression)', () => {
        writeUserConfig({ allow_project_profiles: false })
        const customDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'systematic-allow-project-profiles-custom-'),
        )
        process.env.OPENCODE_CONFIG_DIR = customDir
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          JSON.stringify({ allow_project_profiles: true }),
        )
        const projectConfigPath = writeProjectConfig({
          profiles: {
            sneaky: { agents: { 'not-a-real-agent-name': { model: 'a/x' } } },
          },
        })

        try {
          expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
            projectConfigPath,
          )
          expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
            'not-a-real-agent-name',
          )
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
          fs.rmSync(customDir, { recursive: true, force: true })
        }
      })

      test('opt-in ON, project defines no `profiles`: no warning, no change', () => {
        writeUserConfig({ allow_project_profiles: true })
        writeProjectConfig({ disabled_skills: ['ce:plan'] })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(warnings).toEqual([])
        expect(result.config.disabled_skills).toEqual(['ce:plan'])
      })
    })

    // A project bundle is findable by name (lookup + validation) and, as of
    // the advisory-merge slice, its routing-only fields DO apply -- but only
    // advisorily (never overriding user-owned config). See the dedicated
    // `allow_project_profiles opt-in: advisory merge` describe block below
    // for the merge-precedence guarantees; these tests cover lookup,
    // fallback, and validation only.
    describe('allow_project_profiles opt-in: project bundle lookup', () => {
      test('opt-in ON: project defines and selects a name that exists nowhere else → resolves and its routing applies advisorily (no user config to be silent over)', () => {
        writeUserConfig({ allow_project_profiles: true })
        writeProjectConfig({
          profile: 'proj-only',
          profiles: {
            'proj-only': {
              agents: { 'correctness-reviewer': { model: 'a/proj-only' } },
            },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBe('proj-only')
        expect(result.metadata.profileSelectorSource).toBe('project')
        expect(result.metadata.profileFallback).toBeNull()
        expect(warnings).toEqual([])
        // User config never mentions this agent, so the project bundle's
        // value applies -- the advisory-merge guarantee is "applies only
        // where user config is silent", not "never applies".
        expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
          'a/proj-only',
        )
      })

      test('opt-in ON, project selects a name that exists nowhere: the existing missing-name fallback applies unchanged', () => {
        writeUserConfig({ allow_project_profiles: true, profile: 'default' })
        writeProjectConfig({ profile: 'ghost' })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBeNull()
        expect(result.metadata.profileSelectorSource).toBe('project')
        expect(result.metadata.profileFallback).toEqual({
          requested: 'ghost',
          usedDefault: null,
        })
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('is not defined in `profiles`')
      })

      test('opt-in ON, a project bundle references an unknown agent key: rejected at schema parse time', () => {
        writeUserConfig({ allow_project_profiles: true })
        const projectConfigPath = writeProjectConfig({
          profiles: {
            sneaky: {
              agents: { 'not-a-real-agent-name': { model: 'a/x' } },
            },
          },
        })

        expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
          projectConfigPath,
        )
        expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
          'not-a-real-agent-name',
        )
      })

      test('opt-in ON, a project bundle names an unknown category: rejected by assertAllProfileBundlesAreValid', () => {
        writeUserConfig({ allow_project_profiles: true })
        writeProjectConfig({
          profiles: {
            sneaky: { categories: { 'not-a-real-category': { model: 'a/x' } } },
          },
        })

        expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
          'not-a-real-category',
        )
      })

      test('opt-in ON, an invalid project bundle that is NOT selected still fails the load (repository-wide bug, same as user/custom)', () => {
        writeUserConfig({ allow_project_profiles: true, profile: 'fine' })
        writeProjectConfig({
          // `fine` is selected; `broken` is never selected by anyone, but its
          // unknown category must still fail the whole load.
          profiles: {
            fine: { agents: { 'correctness-reviewer': { model: 'a/fine' } } },
            broken: { categories: { 'not-a-real-category': {} } },
          },
        })

        expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
          'not-a-real-category',
        )
      })
    })

    // `bundleSource` attribution is now observable through the public
    // surface: `result.overlays.<map>.<key>.sourcePath` reflects whichever
    // file's step in the merge chain last touched that key (see
    // `mergeOverlayMap`) -- for a key only the winning bundle sets, that IS
    // the bundle's defining file. No direct `resolveActiveProfile` access
    // is needed anymore (see the exports note at this file's top-level
    // import list).
    describe('bundleSource attribution (anti-shadowing order), asserted through the public surface', () => {
      test('opt-in ON, name exists only in project: resolves, and the merged overlay attributes to the project config file', () => {
        writeUserConfig({ allow_project_profiles: true })
        const projectConfigPath = writeProjectConfig({
          profile: 'proj-only',
          profiles: {
            'proj-only': {
              agents: { 'correctness-reviewer': { model: 'a/proj-only' } },
            },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBe('proj-only')
        expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
          'a/proj-only',
        )
        expect(result.overlays.agents['correctness-reviewer']?.sourcePath).toBe(
          projectConfigPath,
        )
      })

      test('opt-in ON, same name in both user and project: the user bundle wins, and the merged overlay attributes to the user config file', () => {
        const userConfigPath = writeUserConfig({
          allow_project_profiles: true,
          profiles: {
            shared: {
              agents: { 'correctness-reviewer': { model: 'a/user' } },
            },
          },
        })
        writeProjectConfig({
          profile: 'shared',
          profiles: {
            shared: {
              agents: { 'correctness-reviewer': { model: 'a/project' } },
            },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBe('shared')
        expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
          'a/user',
        )
        expect(result.overlays.agents['correctness-reviewer']?.sourcePath).toBe(
          userConfigPath,
        )
      })

      test('opt-in ON, same name in both custom and project: custom wins', () => {
        writeUserConfig({ allow_project_profiles: true })
        writeProjectConfig({
          profile: 'shared',
          profiles: {
            shared: {
              agents: { 'correctness-reviewer': { model: 'a/project' } },
            },
          },
        })

        withCustomConfig(
          {
            profiles: {
              shared: {
                agents: { 'correctness-reviewer': { model: 'a/custom' } },
              },
            },
          },
          (customDir) => {
            const customConfigPath = path.join(customDir, 'systematic.json')
            const result = loadConfigWithSources(testDir, { warningSink })

            expect(result.metadata.activeProfile).toBe('shared')
            expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
              'a/custom',
            )
            expect(
              result.overlays.agents['correctness-reviewer']?.sourcePath,
            ).toBe(customConfigPath)
          },
        )
      })
    })

    describe('allow_project_profiles opt-in: advisory merge', () => {
      test('project bundle routes an agent the user config never mentions: the project value applies', () => {
        writeUserConfig({ allow_project_profiles: true })
        writeProjectConfig({
          profile: 'proj',
          profiles: {
            proj: {
              agents: { 'correctness-reviewer': { model: 'a/project' } },
            },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
          'a/project',
        )
      })

      test('user config sets model on an agent the project bundle also sets: the user value survives and the project value appears nowhere', () => {
        writeUserConfig({
          allow_project_profiles: true,
          agents: { 'correctness-reviewer': { model: 'a/user-direct' } },
        })
        writeProjectConfig({
          profile: 'proj',
          profiles: {
            proj: {
              agents: { 'correctness-reviewer': { model: 'a/project' } },
            },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
          'a/user-direct',
        )
        expect(
          JSON.stringify(result.config.agents?.['correctness-reviewer']),
        ).not.toContain('a/project')
      })

      // The trap case: whole-entry replacement of the accumulated value by
      // the user's own overlay would erase the project's `opencode.model`
      // (the user only restates `variant`), leaving a qualifier with no
      // model -- `assertRoutingInvariants` would then throw, breaking the
      // whole config load because the user customised one unrelated field.
      // Verified red-then-green: this test fails under whole-entry
      // replacement (confirmed by temporarily reverting the
      // `source.trust === 'user'` branch in `resolveOverlayEntryValue`
      // before implementing it) and passes with the field-additive merge.
      test('the trap case: user sets only opencode.variant; project bundle sets opencode.model AND pi.model; all three survive and routing invariants pass', () => {
        writeUserConfig({
          allow_project_profiles: true,
          agents: {
            'correctness-reviewer': { opencode: { variant: 'high' } },
          },
        })
        writeProjectConfig({
          profile: 'proj',
          profiles: {
            proj: {
              agents: {
                'correctness-reviewer': {
                  opencode: { model: 'a/project-opencode' },
                  pi: { model: 'a/project-pi' },
                },
              },
            },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(
          result.config.agents?.['correctness-reviewer']?.opencode,
        ).toEqual({ model: 'a/project-opencode', variant: 'high' })
        expect(result.config.agents?.['correctness-reviewer']?.pi).toEqual({
          model: 'a/project-pi',
        })
      })

      test('full absorption: every target the project bundle sets is already set by user config → the merged result is identical to loading with no project bundle at all', () => {
        writeUserConfig({
          allow_project_profiles: true,
          agents: {
            'correctness-reviewer': {
              model: 'a/user',
              opencode: { model: 'a/user-opencode', variant: 'high' },
              pi: { model: 'a/user-pi' },
            },
          },
        })
        writeProjectConfig({
          profile: 'proj',
          profiles: {
            proj: {
              agents: {
                'correctness-reviewer': {
                  model: 'a/project',
                  opencode: { model: 'a/project-opencode', variant: 'low' },
                  pi: { model: 'a/project-pi' },
                },
              },
            },
          },
        })

        const withBundle = loadConfigWithSources(testDir, { warningSink })

        // Same user config, but a project config that never selects a
        // profile at all.
        writeProjectConfig({})
        const withoutBundle = loadConfigWithSources(testDir, { warningSink })

        expect(withBundle.config.agents?.['correctness-reviewer']).toEqual(
          withoutBundle.config.agents?.['correctness-reviewer'],
        )
        expect(withBundle.config.agents?.['correctness-reviewer']?.model).toBe(
          'a/user',
        )
      })

      test('a user-sourced profile is active while an opted-in project bundle also exists: the user profile retains its override semantics over user base, unchanged from today', () => {
        writeUserConfig({
          allow_project_profiles: true,
          profile: 'personal',
          agents: { 'correctness-reviewer': { model: 'a/user-base' } },
          profiles: {
            personal: {
              agents: { 'correctness-reviewer': { model: 'a/user-profile' } },
            },
          },
        })
        // A project bundle exists and the opt-in is on, but the user's own
        // `profile` selector wins the selection outright -- the project
        // bundle's content must never even be consulted.
        writeProjectConfig({
          profiles: {
            other: {
              agents: { 'correctness-reviewer': { model: 'a/project' } },
            },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBe('personal')
        expect(result.metadata.profileSelectorSource).toBe('user')
        expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
          'a/user-profile',
        )
      })

      test('project bundle sets a category-level value where user set an agent-level value, and the reverse: normal agent-over-category layering is unaffected by advisory merge', () => {
        writeUserConfig({
          allow_project_profiles: true,
          agents: { 'correctness-reviewer': { model: 'a/user-agent-level' } },
          categories: { review: { model: 'a/user-category-level' } },
        })
        writeProjectConfig({
          profile: 'proj',
          profiles: {
            proj: {
              categories: { review: { model: 'a/project-category-level' } },
            },
          },
        })

        const forward = loadConfigWithSources(testDir, { warningSink })
        const forwardTarget: RoutingTarget = {
          agentKey: 'correctness-reviewer',
          category: 'review',
        }
        const forwardResolution = resolveRouting({
          overlays: forward.overlays,
          piSubagentsOverlays: forward.piSubagentsOverlays,
          target: forwardTarget,
          harness: 'opencode',
        })
        // User's agent-level value wins over the project's category-level
        // value -- ordinary agent-over-category layering, unrelated to trust.
        expect(forwardResolution.model).toBe('a/user-agent-level')

        // Reverse: user sets only a category-level value; the project bundle
        // sets an agent-level value for the SAME agent. The project's
        // agent-level entry fills a layer the user never touched, so it
        // applies -- the advisory guarantee is per overlay key
        // (agents.<key> vs categories.<key>), not "any value anywhere for
        // this agent blocks the project bundle".
        writeUserConfig({
          allow_project_profiles: true,
          categories: { review: { model: 'a/user-category-level' } },
        })
        writeProjectConfig({
          profile: 'proj',
          profiles: {
            proj: {
              agents: {
                'correctness-reviewer': { model: 'a/project-agent-level' },
              },
            },
          },
        })

        const reverse = loadConfigWithSources(testDir, { warningSink })
        const reverseResolution = resolveRouting({
          overlays: reverse.overlays,
          piSubagentsOverlays: reverse.piSubagentsOverlays,
          target: forwardTarget,
          harness: 'opencode',
        })
        expect(reverseResolution.model).toBe('a/project-agent-level')
      })

      test('project bundle sets a qualifier with no model resolvable anywhere: assertRoutingInvariants still throws', () => {
        writeUserConfig({ allow_project_profiles: true })
        writeProjectConfig({
          profile: 'proj',
          profiles: {
            proj: {
              agents: {
                'correctness-reviewer': { opencode: { variant: 'high' } },
              },
            },
          },
        })

        expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
          /correctness-reviewer/,
        )
        expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
          /opencode/,
        )
      })

      test('routing resolved through resolveRouting reflects the advisory outcome, not just the raw overlay map', () => {
        writeUserConfig({
          allow_project_profiles: true,
          agents: {
            'correctness-reviewer': { opencode: { variant: 'high' } },
          },
        })
        writeProjectConfig({
          profile: 'proj',
          profiles: {
            proj: {
              agents: {
                'correctness-reviewer': {
                  opencode: { model: 'a/project-opencode' },
                },
              },
            },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })
        const target: RoutingTarget = {
          agentKey: 'correctness-reviewer',
          category: 'review',
        }
        const resolution = resolveRouting({
          overlays: result.overlays,
          piSubagentsOverlays: result.piSubagentsOverlays,
          target,
          harness: 'opencode',
        })

        expect(resolution.model).toBe('a/project-opencode')
        expect(resolution.qualifier).toBe('high')
      })
    })

    test('a control-character project path cannot forge a line in the `profiles`-ignored warning', () => {
      writeUserConfig({
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      const weirdProjectDir = path.join(
        testDir,
        'proj\n\u001b[31mFAKE\u001b[0m',
      )
      fs.mkdirSync(path.join(weirdProjectDir, '.opencode'), {
        recursive: true,
      })
      fs.writeFileSync(
        path.join(weirdProjectDir, '.opencode/systematic.json'),
        JSON.stringify({
          profile: 'personal',
          profiles: {
            personal: {
              agents: { 'correctness-reviewer': { model: 'a/sneaky' } },
            },
          },
        }),
      )

      loadConfigWithSources(weirdProjectDir, { warningSink })

      const profilesWarning = warnings.find((w) => w.includes('`profiles`'))
      expect(profilesWarning).toBeDefined()
      expect(profilesWarning).not.toContain('\n')
      expect(profilesWarning).not.toContain('\u001b')
      expect(profilesWarning).toContain('\\u000a')
      expect(profilesWarning).toContain('\\u001b')
    })

    // `profiles` defined in custom (OPENCODE_CONFIG_DIR) config is honoured:
    // custom is the strongest trust level, so its `profiles` map is checked
    // alongside the user source's.
    test('custom-defined profiles map is honoured: custom selects its own bundle, no warning', () => {
      writeUserConfig({})

      withCustomConfig(
        {
          profile: 'work',
          profiles: {
            work: { agents: { 'correctness-reviewer': { model: 'a/work' } } },
          },
        },
        () => {
          const result = loadConfigWithSources(testDir, { warningSink })

          expect(result.metadata.activeProfile).toBe('work')
          expect(result.metadata.profileSelectorSource).toBe('custom')
          expect(result.metadata.profileFallback).toBeNull()
          expect(result.config.agents?.['correctness-reviewer']).toEqual({
            model: 'a/work',
          })
          expect(warnings).toEqual([])
        },
      )
    })

    // A profile defined and selected entirely from custom config, with NO
    // user config file at all (not even an empty one) -- `profileEntry`
    // must attribute the bundle to the custom source, not silently drop it
    // for lack of a user file to attribute it to.
    test('custom defines and selects its own profile with NO user config file at all → active and the overlay is applied', () => {
      expect(fs.existsSync(userConfigPath())).toBe(false)

      withCustomConfig(
        {
          profile: 'work',
          profiles: {
            work: { agents: { 'correctness-reviewer': { model: 'a/work' } } },
          },
        },
        () => {
          const result = loadConfigWithSources(testDir, { warningSink })

          expect(result.metadata.activeProfile).toBe('work')
          expect(result.metadata.profileSelectorSource).toBe('custom')
          expect(result.metadata.profileFallback).toBeNull()
          expect(result.config.agents?.['correctness-reviewer']).toEqual({
            model: 'a/work',
          })
          expect(warnings).toEqual([])
        },
      )
    })

    test('project selects a name that ONLY exists in the custom profiles map → active, no warning', () => {
      writeUserConfig({})
      writeProjectConfig({ profile: 'work' })

      withCustomConfig(
        {
          profiles: {
            work: { agents: { 'correctness-reviewer': { model: 'a/work' } } },
          },
        },
        () => {
          const result = loadConfigWithSources(testDir, { warningSink })

          expect(result.metadata.activeProfile).toBe('work')
          expect(result.metadata.profileSelectorSource).toBe('project')
          expect(result.metadata.profileFallback).toBeNull()
          expect(result.config.agents?.['correctness-reviewer']).toEqual({
            model: 'a/work',
          })
          expect(warnings).toEqual([])
        },
      )
    })

    // Project selects a name that exists nowhere; the USER's own default
    // name resolves to a bundle that lives in CUSTOM's `profiles` map (not
    // user's) -- proving the fallback bundle lookup also checks custom, not
    // just the initial requested-name lookup.
    test('project selects a missing name; falls back to the user default, whose bundle is defined in custom → custom bundle used', () => {
      writeUserConfig({ profile: 'shared-default' })
      writeProjectConfig({ profile: 'missing-everywhere' })

      withCustomConfig(
        {
          profiles: {
            'shared-default': {
              agents: { 'correctness-reviewer': { model: 'a/shared' } },
            },
          },
        },
        () => {
          const result = loadConfigWithSources(testDir, { warningSink })

          expect(result.metadata.activeProfile).toBe('shared-default')
          expect(result.metadata.profileSelectorSource).toBe('project')
          expect(result.metadata.profileFallback).toEqual({
            requested: 'missing-everywhere',
            usedDefault: 'shared-default',
          })
          expect(result.config.agents?.['correctness-reviewer']).toEqual({
            model: 'a/shared',
          })
          expect(warnings).toHaveLength(1)
        },
      )
    })

    // Merge order: base -> profile -> project -> custom, verifying the
    // four-entry chain composes additively for disjoint fields and later
    // wins for the same field -- EXCEPT that custom is a plain file-trust
    // source, so its same-key overlay fully REPLACES the accumulated value
    // wholesale, dropping project's `temperature` here since custom doesn't
    // repeat it. This is deliberately unlike the profile-bundle layer
    // (`mergeProfileOverlayValue`), which merges field-by-field.
    test('merge order: base model A, profile model B, project temperature 0.2, custom model C → custom wholesale-replaces (temperature dropped)', () => {
      writeUserConfig({
        profile: 'p',
        agents: { 'correctness-reviewer': { model: 'a/A' } },
        profiles: {
          p: { agents: { 'correctness-reviewer': { model: 'a/B' } } },
        },
      })
      writeProjectConfig({
        agents: { 'correctness-reviewer': { temperature: 0.2 } },
      })

      withCustomConfig(
        { agents: { 'correctness-reviewer': { model: 'a/C' } } },
        () => {
          const result = loadConfigWithSources(testDir, { warningSink })

          expect(result.config.agents?.['correctness-reviewer']).toEqual({
            model: 'a/C',
          })
        },
      )
    })

    test('merge order without custom: base model A, profile model B, project temperature 0.2 → effective model B + temperature 0.2', () => {
      writeUserConfig({
        profile: 'p',
        agents: { 'correctness-reviewer': { model: 'a/A' } },
        profiles: {
          p: { agents: { 'correctness-reviewer': { model: 'a/B' } } },
        },
      })
      writeProjectConfig({
        agents: { 'correctness-reviewer': { temperature: 0.2 } },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.agents?.['correctness-reviewer']).toEqual({
        model: 'a/B',
        temperature: 0.2,
      })
    })

    // Regression: a profile bundle can only ever carry routing fields
    // (ProfileOverlaySchema forbids mode/color/steps/hidden/disable), so
    // switching which profile is active must never change an agent's
    // visibility, permissions, mode, or existence (R7/R10).
    test('profile switch preserves non-routing fields the profile cannot itself carry (disable/hidden/mode/steps)', () => {
      writeUserConfig({
        profile: 'p',
        agents: {
          'correctness-reviewer': {
            disable: true,
            hidden: true,
            mode: 'subagent',
            steps: 3,
            model: 'a/x',
          },
        },
        profiles: {
          p: { agents: { 'correctness-reviewer': { model: 'b/y' } } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.agents?.['correctness-reviewer']).toEqual({
        disable: true,
        hidden: true,
        mode: 'subagent',
        steps: 3,
        model: 'b/y',
      })
    })

    // Regression: a profile setting only `pi.thinking` must not wipe a base
    // `pi.model` -- R3b requires a profile to be able to set a qualifier
    // alone when the model resolves from a lower layer, including when that
    // lower layer is itself a harness block.
    test('profile pi block merges one level deep: base pi.model survives a profile pi.thinking-only fragment', () => {
      writeUserConfig({
        profile: 'p',
        agents: {
          'correctness-reviewer': { pi: { model: 'p/m' } },
        },
        profiles: {
          p: {
            agents: { 'correctness-reviewer': { pi: { thinking: 'high' } } },
          },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.agents?.['correctness-reviewer']?.pi).toEqual({
        model: 'p/m',
        thinking: 'high',
      })
    })

    // Regression: a profile's explicit opencode.model: null must win (opt
    // out of the block's model) while the base block's variant survives.
    test('profile opencode block merges one level deep: explicit model: null wins, base variant survives', () => {
      writeUserConfig({
        profile: 'p',
        agents: {
          'correctness-reviewer': {
            opencode: { model: 'o/m', variant: 'high' },
          },
        },
        profiles: {
          p: {
            agents: {
              'correctness-reviewer': { opencode: { model: null } },
            },
          },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.agents?.['correctness-reviewer']?.opencode).toEqual({
        model: null,
        variant: 'high',
      })
    })

    // Regression: same field-additive guarantee for categories, using a
    // non-routing field (color) the profile schema cannot carry at all.
    test('profile switch preserves a category color field the profile cannot itself carry', () => {
      writeUserConfig({
        profile: 'p',
        categories: { review: { color: 'primary', model: 'a/review-old' } },
        profiles: {
          p: { categories: { review: { model: 'a/review-new' } } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.categories?.review).toEqual({
        color: 'primary',
        model: 'a/review-new',
      })
    })

    // A user->custom same-key override is a wholesale replace: a custom
    // `mode` overlay must fully replace a user `model` overlay for the same
    // agent, dropping the model entirely.
    test('user model overlay + custom mode overlay for the SAME agent → custom wholesale-replaces (model dropped)', () => {
      writeUserConfig({
        agents: { 'correctness-reviewer': { model: 'openai/gpt-5' } },
      })

      withCustomConfig(
        { agents: { 'correctness-reviewer': { mode: 'subagent' } } },
        () => {
          const result = loadConfigWithSources(testDir, { warningSink })
          expect(result.config.agents?.['correctness-reviewer']).toEqual({
            mode: 'subagent',
          })
        },
      )
    })

    test('non-regression: custom config category overlay still replaces project same-key overlay (steps dropped)', () => {
      writeProjectConfig({
        categories: { review: { steps: 8, temperature: 0.1 } },
      })

      withCustomConfig({ categories: { review: { temperature: 0.7 } } }, () => {
        const result = loadConfigWithSources(testDir, { warningSink })
        expect(result.config.categories?.review).toEqual({
          temperature: 0.7,
        })
      })
    })

    test('active profile categories overlay merges into the effective config', () => {
      writeUserConfig({
        profile: 'p',
        profiles: {
          p: { categories: { review: { model: 'a/review-model' } } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.categories?.review).toEqual({
        model: 'a/review-model',
      })
    })

    test('overlays.agents sourcePath for a profile-sourced value points at the user config file', () => {
      const userConfigPath = writeUserConfig({
        profile: 'p',
        profiles: {
          p: { agents: { 'correctness-reviewer': { model: 'a/B' } } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.overlays.agents['correctness-reviewer']?.sourcePath).toBe(
        userConfigPath,
      )
    })

    // ConfigSource is a discriminated union
    // (FileConfigSource | ProfileBundleConfigSource) instead of a
    // `trust: 'user'` file source plus an `isProfileBundle` boolean flag.
    // This test pins the metadata-facing guarantee that change protects:
    // the profile pseudo-source must never be double-counted as a fourth
    // 'user' entry in `sources`/`authorities`, regardless of how many
    // fields the active profile sets.
    test('an active profile never appears as its own entry in metadata sources or authorities', () => {
      writeUserConfig({
        profile: 'p',
        profiles: {
          p: {
            agents: { 'correctness-reviewer': { model: 'a/B', variant: 'v2' } },
            categories: { review: { model: 'a/C', temperature: 0.5 } },
          },
        },
        bootstrap: { enabled: true },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBe('p')
      // Exactly the three file-backed sources -- never a fourth entry for
      // the profile bundle, and never a 'profile' kind leaking into the
      // metadata-facing ConfigSourceKind-only shape.
      expect(result.metadata.sources).toEqual([
        { kind: 'custom', presence: 'absent' },
        { kind: 'project', presence: 'absent' },
        { kind: 'user', presence: 'present' },
      ])
      expect(result.metadata.sources).toHaveLength(3)
      for (const source of result.metadata.sources) {
        expect(source.kind).not.toBe('profile')
      }
      // The one authority this config sets (bootstrap.enabled) is correctly
      // attributed to 'user' -- not fabricated as a 'profile' sourceKind,
      // which ConfigSourceKind doesn't even have as a valid value.
      expect(result.metadata.authorities).toContainEqual({
        fieldPath: 'bootstrap.enabled',
        sourceKind: 'user',
      })
      for (const authority of result.metadata.authorities) {
        expect(authority.sourceKind).not.toBe('profile')
      }
    })

    test('the pre-existing three-entry pi_subagents merge and metadata sources are unaffected by an active profile', () => {
      writeUserConfig({
        profile: 'p',
        profiles: {
          p: { agents: { 'correctness-reviewer': { model: 'a/B' } } },
        },
        pi_subagents: { agents: { x: { thinking: 'high' } } },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.pi_subagents?.agents?.x).toEqual({
        thinking: 'high',
      })
      expect(result.metadata.sources).toEqual([
        { kind: 'custom', presence: 'absent' },
        { kind: 'project', presence: 'absent' },
        { kind: 'user', presence: 'present' },
      ])
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  // Unit 3 (plan 2026-09-04-002-feat-model-config-profiles): the loader's
  // post-merge qualifier-requires-model check, backed by
  // src/lib/routing-resolver.ts. Uses real bundled review-category agents
  // ('correctness-reviewer', 'security-reviewer') since the check only
  // walks targets that resolve to a real bundled agent.
  // ════════════════════════════════════════════════════════════════════════
  describe('routing invariants (post-merge qualifier check)', () => {
    let warnings: string[]
    let warningSink: (message: string) => void

    beforeEach(() => {
      warnings = []
      warningSink = (message: string) => warnings.push(message)
    })

    test('agents.x.variant with no model at any layer throws, naming the agent and opencode', () => {
      writeUserConfig({
        agents: { 'correctness-reviewer': { variant: 'high' } },
      })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /correctness-reviewer/,
      )
      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /opencode/,
      )
    })

    // A legacy `pi_subagents.<key>.thinking` value with an unrelated flat
    // `temperature` overlay and no model anywhere must load fine on both
    // the agent and category legacy forms, exactly like a `pi.thinking`
    // block does.
    test('legacy pi_subagents.agents.<key>.thinking with unrelated temperature overlay, no model anywhere → loads fine', () => {
      writeUserConfig({
        agents: { 'correctness-reviewer': { temperature: 0.2 } },
        pi_subagents: {
          agents: { 'correctness-reviewer': { thinking: 'high' } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.agents?.['correctness-reviewer']).toEqual({
        temperature: 0.2,
      })
      expect(
        result.config.pi_subagents?.agents?.['correctness-reviewer'],
      ).toEqual({ thinking: 'high' })
    })

    test('legacy pi_subagents.categories.<name>.thinking with unrelated temperature overlay, no model anywhere → loads fine (category form)', () => {
      writeUserConfig({
        categories: { review: { temperature: 0.2 } },
        pi_subagents: {
          categories: { review: { thinking: 'high' } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.categories?.review).toEqual({ temperature: 0.2 })
      expect(result.config.pi_subagents?.categories?.review).toEqual({
        thinking: 'high',
      })
    })

    // Pi's `thinking` is independent of `model` -- it applies to whatever
    // model the delegate ends up running, including one inherited from the
    // parent session, so this must load successfully, not throw. Only the
    // `opencode` variant-without-model case (the test immediately above)
    // remains a config-load error.
    test('agents.x.pi.thinking with no model at any layer loads fine (thinking is model-independent, unlike opencode variant)', () => {
      writeUserConfig({
        agents: {
          'correctness-reviewer': { pi: { thinking: 'high' } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.agents?.['correctness-reviewer']).toEqual({
        pi: { thinking: 'high' },
      })
    })

    test('a qualifier with an explicit model: null still throws (null is a model, but this agent has variant with no model at all)', () => {
      // Sanity check the error path is reachable at all through the full
      // loader (not just directly in the resolver): a category-level
      // variant with no model anywhere for this specific agent.
      writeUserConfig({
        categories: { review: { variant: 'high' } },
      })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /opencode/,
      )
    })

    // The 'workflow' category has exactly four bundled agents
    // (bug-reproduction-validator, pr-comment-resolver, spec-flow-analyzer,
    // systematic-implementer) -- small enough to give every member an
    // explicit model in the "valid" case, unlike 'review' (~18 agents).
    test('category variant with no category model is fine when every agent in that category resolves its own model', () => {
      writeUserConfig({
        categories: { workflow: { variant: 'high' } },
        agents: {
          'bug-reproduction-validator': { model: 'a/a' },
          'pr-comment-resolver': { model: 'a/b' },
          'spec-flow-analyzer': { model: 'a/c' },
          'systematic-implementer': { model: 'a/d' },
        },
      })

      expect(() =>
        loadConfigWithSources(testDir, { warningSink }),
      ).not.toThrow()
    })

    test('category variant with no category model errors for the one agent in that category with no model anywhere', () => {
      writeUserConfig({
        categories: { workflow: { variant: 'high' } },
        agents: {
          'bug-reproduction-validator': { model: 'a/a' },
          'pr-comment-resolver': { model: 'a/b' },
          'spec-flow-analyzer': { model: 'a/c' },
          // 'systematic-implementer' is in 'workflow' too but sets no model
          // anywhere -- it inherits the category's variant with nothing to
          // attach it to.
        },
      })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /systematic-implementer/,
      )
    })

    // A disabled agent must never block config load on a
    // missing model -- it is never emitted to OpenCode at all, so a
    // category-level qualifier with nothing for it to attach to is moot.
    test('a disabled agent (via disabled_agents) with no model anywhere does not block load', () => {
      writeUserConfig({
        categories: { workflow: { variant: 'high' } },
        disabled_agents: ['systematic-implementer'],
        agents: {
          'bug-reproduction-validator': { model: 'a/a' },
          'pr-comment-resolver': { model: 'a/b' },
          'spec-flow-analyzer': { model: 'a/c' },
          // 'systematic-implementer' is disabled and sets no model anywhere.
        },
      })

      expect(() =>
        loadConfigWithSources(testDir, { warningSink }),
      ).not.toThrow()
    })

    test('a disabled agent (via agents.<key>.disable) with no model anywhere does not block load', () => {
      writeUserConfig({
        categories: { workflow: { variant: 'high' } },
        agents: {
          'bug-reproduction-validator': { model: 'a/a' },
          'pr-comment-resolver': { model: 'a/b' },
          'spec-flow-analyzer': { model: 'a/c' },
          'systematic-implementer': { disable: true },
        },
      })

      expect(() =>
        loadConfigWithSources(testDir, { warningSink }),
      ).not.toThrow()
    })

    test('an enabled agent in the same category without a model still errors', () => {
      writeUserConfig({
        categories: { workflow: { variant: 'high' } },
        disabled_agents: ['systematic-implementer'],
        agents: {
          'bug-reproduction-validator': { model: 'a/a' },
          'pr-comment-resolver': { model: 'a/b' },
          // 'spec-flow-analyzer' is enabled and sets no model -- must still error.
        },
      })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /spec-flow-analyzer/,
      )
    })

    describe('R5: legacy pi_subagents.thinking deprecation warning', () => {
      test('legacy thinking present, no pi block → resolves, one warning', () => {
        writeUserConfig({
          agents: { 'correctness-reviewer': { model: 'a/m' } },
          pi_subagents: {
            agents: { 'correctness-reviewer': { thinking: 'low' } },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
          'a/m',
        )
        const legacyWarnings = warnings.filter((w) =>
          w.includes('correctness-reviewer'),
        )
        expect(legacyWarnings).toHaveLength(1)
        expect(legacyWarnings[0]).toContain(
          'agents.correctness-reviewer.pi.thinking',
        )
      })

      // The ONLY Pi customization is the legacy field -- no
      // `agents`/`categories` overlay at all for this agent, so it would
      // never appear in `collectRoutingTargets`'s walk alone (that walk
      // only enumerates agents that already have an ordinary overlay
      // entry). The warning must still fire.
      test('legacy thinking is the ONLY overlay set for this agent (no agents/categories overlay at all) → warning still fires', () => {
        writeUserConfig({
          pi_subagents: {
            agents: { 'correctness-reviewer': { thinking: 'low' } },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.config.agents?.['correctness-reviewer']).toBeUndefined()
        const legacyWarnings = warnings.filter((w) =>
          w.includes('correctness-reviewer'),
        )
        expect(legacyWarnings).toHaveLength(1)
      })

      test('legacy thinking is the ONLY overlay set, via the category form \u2192 exactly one warning naming the written category path', () => {
        writeUserConfig({
          pi_subagents: {
            categories: { review: { thinking: 'low' } },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.config.categories?.review).toBeUndefined()
        const legacyWarnings = warnings.filter((w) =>
          w.includes('pi_subagents'),
        )
        expect(legacyWarnings).toEqual([
          '[systematic] pi_subagents.categories.review.thinking is deprecated; set categories.review.pi.thinking instead. The legacy value is honoured only when the new location is unset, and support for it will be removed in a future release.',
        ])
      })

      // Dedup by the WRITTEN legacy path, not by every agent the field
      // happens to resolve for: a category-level write is ONE field the
      // user wrote, so it must produce exactly ONE warning naming exactly
      // that field -- never N warnings (one per bundled agent in the
      // category) each naming an agent-level path the user never wrote.
      test('category-level legacy thinking fires exactly one warning naming the category, never one per agent', () => {
        const reviewAgentCount = BUNDLED_AGENT_QUALIFIED_IDS.filter((id) =>
          id.startsWith('review/'),
        ).length
        expect(reviewAgentCount).toBeGreaterThan(1)

        writeUserConfig({
          pi_subagents: {
            categories: { review: { thinking: 'low' } },
          },
        })

        loadConfigWithSources(testDir, { warningSink })

        const legacyWarnings = warnings.filter((w) =>
          w.includes('pi_subagents'),
        )
        expect(legacyWarnings).toHaveLength(1)
        expect(legacyWarnings[0]).toContain(
          'pi_subagents.categories.review.thinking',
        )
        expect(legacyWarnings[0]).toContain('categories.review.pi.thinking')
        expect(legacyWarnings[0]).not.toContain('correctness-reviewer')
      })

      test('both legacy and pi block set and disagreeing → pi block wins, warning still emitted once', () => {
        writeUserConfig({
          agents: {
            'correctness-reviewer': {
              model: 'a/m',
              pi: { thinking: 'high' },
            },
          },
          pi_subagents: {
            agents: { 'correctness-reviewer': { thinking: 'low' } },
          },
        })

        loadConfigWithSources(testDir, { warningSink })

        const legacyWarnings = warnings.filter((w) =>
          w.includes('correctness-reviewer'),
        )
        expect(legacyWarnings).toHaveLength(1)
      })

      test('two targets with legacy thinking → two warnings, one each', () => {
        writeUserConfig({
          agents: {
            'correctness-reviewer': { model: 'a/m' },
            'security-reviewer': { model: 'a/n' },
          },
          pi_subagents: {
            agents: {
              'correctness-reviewer': { thinking: 'low' },
              'security-reviewer': { thinking: 'medium' },
            },
          },
        })

        loadConfigWithSources(testDir, { warningSink })

        const legacyWarnings = warnings.filter((w) =>
          w.includes('pi_subagents'),
        )
        expect(legacyWarnings).toHaveLength(2)
        expect(
          legacyWarnings.some((w) => w.includes('correctness-reviewer')),
        ).toBe(true)
        expect(
          legacyWarnings.some((w) => w.includes('security-reviewer')),
        ).toBe(true)
      })

      test('the same target is only walked once per load → still exactly one warning', () => {
        // The target is reachable via BOTH the agent-key walk AND the
        // category-driven walk (its category also has an overlay), which
        // could in principle produce duplicate entries if collectRoutingTargets
        // didn't dedupe by category/key.
        writeUserConfig({
          agents: { 'correctness-reviewer': { model: 'a/m' } },
          categories: { review: { temperature: 0.2 } },
          pi_subagents: {
            agents: { 'correctness-reviewer': { thinking: 'low' } },
          },
        })

        loadConfigWithSources(testDir, { warningSink })

        const legacyWarnings = warnings.filter((w) =>
          w.includes('correctness-reviewer'),
        )
        expect(legacyWarnings).toHaveLength(1)
      })

      test('no legacy thinking anywhere → no deprecation warning', () => {
        writeUserConfig({
          agents: {
            'correctness-reviewer': { model: 'a/m', pi: { thinking: 'high' } },
          },
        })

        loadConfigWithSources(testDir, { warningSink })

        expect(warnings.filter((w) => w.includes('pi_subagents'))).toHaveLength(
          0,
        )
      })
    })
  })
})

describe('allow_project_profiles', () => {
  let testDir: string
  let originalOsHomedir: (() => string) | undefined

  beforeEach(() => {
    testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-allow-project-profiles-test-'),
    )
    originalOsHomedir = os.homedir
    os.homedir = () => path.join(testDir, 'home')
  })

  afterEach(() => {
    if (originalOsHomedir) os.homedir = originalOsHomedir
    fs.rmSync(testDir, { recursive: true, force: true })
    delete process.env.OPENCODE_CONFIG_DIR
  })

  function userConfigPath(): string {
    return path.join(os.homedir(), '.config', 'opencode', 'systematic.json')
  }

  function writeUserConfig(config: Record<string, unknown>): string {
    const filePath = userConfigPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(config))
    return filePath
  }

  function writeProjectConfig(config: Record<string, unknown>): string {
    const projectConfigDir = path.join(testDir, '.opencode')
    fs.mkdirSync(projectConfigDir, { recursive: true })
    const filePath = path.join(projectConfigDir, 'systematic.json')
    fs.writeFileSync(filePath, JSON.stringify(config))
    return filePath
  }

  function withCustomConfig<T>(
    config: Record<string, unknown>,
    fn: (customDir: string) => T,
  ): T {
    const customDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-allow-project-profiles-custom-'),
    )
    process.env.OPENCODE_CONFIG_DIR = customDir
    fs.writeFileSync(
      path.join(customDir, 'systematic.json'),
      JSON.stringify(config),
    )
    try {
      return fn(customDir)
    } finally {
      delete process.env.OPENCODE_CONFIG_DIR
      fs.rmSync(customDir, { recursive: true, force: true })
    }
  }

  test('user config sets allow_project_profiles true → loaded config reports true', () => {
    writeUserConfig({ allow_project_profiles: true })

    const result = loadConfig(testDir)

    expect(result.allow_project_profiles).toBe(true)
  })

  test('OPENCODE_CONFIG_DIR (custom) config sets it true while user config sets false → custom wins', () => {
    writeUserConfig({ allow_project_profiles: false })

    withCustomConfig({ allow_project_profiles: true }, () => {
      const result = loadConfig(testDir)
      expect(result.allow_project_profiles).toBe(true)
    })
  })

  test('neither source sets it → effective value is false', () => {
    writeUserConfig({})

    const result = loadConfig(testDir)

    expect(result.allow_project_profiles).toBe(false)
    expect(result.allow_project_profiles).toBe(
      DEFAULT_CONFIG.allow_project_profiles,
    )
  })

  test('project config sets it true → stripped, effective value stays false, and a protected-field warning names it', () => {
    const projectConfigPath = writeProjectConfig({
      allow_project_profiles: true,
    })
    const warnings: string[] = []
    const warningSink = (message: string) => warnings.push(message)

    const result = loadConfigWithSources(testDir, { warningSink })

    expect(result.config.allow_project_profiles).toBe(false)
    expect(warnings).toContainEqual(
      `[systematic] \`allow_project_profiles\` in project config (${projectConfigPath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
    )
    expect(result.metadata.protectedFields).toContainEqual({
      fieldPath: 'allow_project_profiles',
      outcome: 'blocked',
      sourceKind: 'project',
    })
  })

  test('self-authorization: project sets allow_project_profiles: true AND defines profiles in the same file → both stripped, both warned, bundle never selectable', () => {
    const projectConfigPath = writeProjectConfig({
      allow_project_profiles: true,
      profile: 'sneaky',
      profiles: {
        sneaky: {
          agents: { 'correctness-reviewer': { model: 'a/sneaky' } },
        },
      },
    })
    const warnings: string[] = []
    const warningSink = (message: string) => warnings.push(message)

    const result = loadConfigWithSources(testDir, { warningSink })

    // The opt-in a project grants itself never takes effect.
    expect(result.config.allow_project_profiles).toBe(false)

    // Because the opt-in never took effect, `profiles` was stripped exactly
    // as if `allow_project_profiles` had never been mentioned in this file.
    const allowProjectProfilesWarning = warnings.find((message) =>
      message.includes('`allow_project_profiles`'),
    )
    const profilesWarning = warnings.find(
      (message) =>
        message.includes('`profiles`') &&
        message.includes('is only valid in user config'),
    )
    expect(allowProjectProfilesWarning).toBeDefined()
    expect(allowProjectProfilesWarning).toContain(projectConfigPath)
    expect(profilesWarning).toBeDefined()
    expect(profilesWarning).toContain(projectConfigPath)

    expect(result.metadata.protectedFields).toContainEqual({
      fieldPath: 'allow_project_profiles',
      outcome: 'blocked',
      sourceKind: 'project',
    })
    expect(result.metadata.protectedFields).toContainEqual({
      fieldPath: 'profiles',
      outcome: 'blocked',
      sourceKind: 'project',
    })

    // No bundle from the project's own map is resolvable -- the selector
    // falls back exactly like the missing-name case (no other source
    // defines `sneaky`).
    expect(result.metadata.activeProfile).toBeNull()
    expect(result.metadata.profileFallback).toEqual({
      requested: 'sneaky',
      usedDefault: null,
    })
    expect(result.config.agents?.['correctness-reviewer']).toBeUndefined()
  })
})

describe('pi_subagents merge and trust', () => {
  let testDir: string
  let originalOsHomedir: (() => string) | undefined

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-pisub-test-'))
    originalOsHomedir = os.homedir
    os.homedir = () => path.join(testDir, 'home')
  })

  afterEach(() => {
    if (originalOsHomedir) os.homedir = originalOsHomedir
    fs.rmSync(testDir, { recursive: true, force: true })
    delete process.env.OPENCODE_CONFIG_DIR
  })

  function userConfigPath(): string {
    return path.join(os.homedir(), '.config', 'opencode', 'systematic.json')
  }

  function writeUserConfig(config: Record<string, unknown>): string {
    const filePath = userConfigPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(config))
    return filePath
  }

  function writeProjectConfig(config: Record<string, unknown>): string {
    const projectConfigDir = path.join(testDir, '.opencode')
    fs.mkdirSync(projectConfigDir, { recursive: true })
    const filePath = path.join(projectConfigDir, 'systematic.json')
    fs.writeFileSync(filePath, JSON.stringify(config))
    return filePath
  }

  test('user config pi_subagents.categories/agents merge into effective config', () => {
    writeUserConfig({
      pi_subagents: {
        categories: { research: { thinking: 'high' } },
        agents: { 'repo-research-analyst': { max_turns: 10 } },
      },
    })

    const result = loadConfigWithSources(testDir)
    expect(result.config.pi_subagents).toEqual({
      categories: { research: { thinking: 'high' } },
      agents: { 'repo-research-analyst': { max_turns: 10 } },
    })
  })

  test('defaults to empty categories/agents maps with no config files', () => {
    const result = loadConfig(testDir)
    expect(result.pi_subagents).toEqual({ categories: {}, agents: {} })
  })

  test('project-sourced thinking/tools/skills are stripped from merged pi_subagents', () => {
    writeProjectConfig({
      pi_subagents: {
        agents: {
          'repo-research-analyst': {
            thinking: 'high',
            tools: '*',
            skills: true,
            max_turns: 5,
          },
        },
      },
    })

    const result = loadConfigWithSources(testDir)
    expect(
      result.config.pi_subagents?.agents?.['repo-research-analyst'],
    ).toEqual({ max_turns: 5 })
  })

  test('project-sourced category thinking/tools/skills are stripped; max_turns retained', () => {
    writeProjectConfig({
      pi_subagents: {
        categories: {
          research: {
            thinking: 'medium',
            tools: 'read',
            skills: 'ce:plan',
            max_turns: 5,
          },
        },
      },
    })

    const result = loadConfigWithSources(testDir)
    expect(result.config.pi_subagents?.categories?.research).toEqual({
      max_turns: 5,
    })
  })

  test('project cannot resurrect a stripped field by omission when user set it', () => {
    // Project same-key overlay should not erase a higher-trust protected field.
    writeUserConfig({
      pi_subagents: {
        agents: { 'repo-research-analyst': { thinking: 'high', max_turns: 1 } },
      },
    })
    writeProjectConfig({
      pi_subagents: {
        agents: { 'repo-research-analyst': { max_turns: 20 } },
      },
    })

    const result = loadConfigWithSources(testDir)
    expect(
      result.config.pi_subagents?.agents?.['repo-research-analyst'],
    ).toEqual({ thinking: 'high', max_turns: 20 })
  })

  test('project config setting only protected fields is stripped down to an empty overlay (no throw)', () => {
    writeProjectConfig({
      pi_subagents: { agents: { x: { thinking: 'low' } } },
    })

    expect(() => loadConfigWithSources(testDir)).not.toThrow()
    const result = loadConfigWithSources(testDir)
    expect(result.config.pi_subagents?.agents?.x).toEqual({})
  })

  test('user/custom config directory may set thinking/tools/skills freely', () => {
    const customDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-pisub-custom-'),
    )
    process.env.OPENCODE_CONFIG_DIR = customDir
    fs.writeFileSync(
      path.join(customDir, 'systematic.json'),
      JSON.stringify({
        pi_subagents: {
          agents: { x: { thinking: 'high', tools: '*', skills: true } },
        },
      }),
    )

    const result = loadConfigWithSources(testDir)
    expect(result.config.pi_subagents?.agents?.x).toEqual({
      thinking: 'high',
      tools: '*',
      skills: true,
    })

    fs.rmSync(customDir, { recursive: true, force: true })
  })

  test('per-agent pi_subagents value overrides category value at merge time (both present in effective config)', () => {
    writeUserConfig({
      pi_subagents: {
        categories: { research: { thinking: 'low', max_turns: 3 } },
        agents: { 'repo-research-analyst': { thinking: 'high' } },
      },
    })

    const result = loadConfigWithSources(testDir)
    expect(result.config.pi_subagents?.categories?.research).toEqual({
      thinking: 'low',
      max_turns: 3,
    })
    expect(
      result.config.pi_subagents?.agents?.['repo-research-analyst'],
    ).toEqual({ thinking: 'high' })
  })

  test('invalid pi_subagents shape fails validation before merge', () => {
    const projectConfigPath = writeProjectConfig({
      pi_subagents: { agents: { x: { thinking: 'turbo' } } },
    })

    expect(() => loadConfigWithSources(testDir)).toThrow(projectConfigPath)
  })

  test('unknown pi_subagents field fails validation under strict schema', () => {
    const projectConfigPath = writeProjectConfig({
      pi_subagents: { agents: { x: { bogus: true } } },
    })

    expect(() => loadConfigWithSources(testDir)).toThrow(projectConfigPath)
  })

  describe('scope-aware config chain (includeProject option)', () => {
    test('default (no options) includes project config', () => {
      writeProjectConfig({
        pi_subagents: { agents: { x: { max_turns: 7 } } },
      })

      const result = loadConfigWithSources(testDir)
      expect(result.config.pi_subagents?.agents?.x).toEqual({ max_turns: 7 })
    })

    test('includeProject: false ignores project config entirely, even when cwd has one', () => {
      writeUserConfig({
        pi_subagents: { agents: { x: { thinking: 'high' } } },
      })
      writeProjectConfig({
        pi_subagents: { agents: { x: { max_turns: 99 } } },
        disabled_skills: ['ce:plan'],
      })

      const result = loadConfigWithSources(testDir, { includeProject: false })
      // project-sourced max_turns must be entirely absent — not merged, not stripped-to-empty
      expect(result.config.pi_subagents?.agents?.x).toEqual({
        thinking: 'high',
      })
      expect(result.config.disabled_skills).not.toContain('ce:plan')
    })

    test('includeProject: false still loads user and custom config', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-pisub-scope-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir
      writeUserConfig({ disabled_skills: ['ce:brainstorm'] })
      fs.writeFileSync(
        path.join(customDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:work'] }),
      )
      writeProjectConfig({ disabled_skills: ['ce:plan'] })

      const result = loadConfigWithSources(testDir, { includeProject: false })
      expect(result.config.disabled_skills).toContain('ce:brainstorm')
      expect(result.config.disabled_skills).toContain('ce:work')
      expect(result.config.disabled_skills).not.toContain('ce:plan')

      fs.rmSync(customDir, { recursive: true, force: true })
    })
  })
})

// The TYPED_VALIDATION_DOCS_URL constant in src/lib/config.ts is surfaced
// directly to end users in validation error messages. These tests catch two
// classes of drift on that URL: the host and base-path (correct DNS target)
// and the fragment (a heading that actually exists in the rendered docs).

describe('TYPED_VALIDATION_DOCS_URL', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const CONFIG_TS = path.resolve(__dirname, '../../src/lib/config.ts')
  const CONFIG_MDX = path.resolve(
    __dirname,
    '../../docs/src/content/docs/reference/configuration.mdx',
  )

  /**
   * Extract the literal URL string assigned to TYPED_VALIDATION_DOCS_URL
   * from the source file. Reading the source avoids coupling the test to
   * the module export shape and matches how other constants in this file
   * are validated.
   */
  function readTypedValidationDocsUrl(): string {
    const source = fs.readFileSync(CONFIG_TS, 'utf-8')
    const match = source.match(
      /TYPED_VALIDATION_DOCS_URL\s*=\s*\n?\s*'([^']+)'/,
    )
    if (!match) {
      throw new Error('Could not locate TYPED_VALIDATION_DOCS_URL in config.ts')
    }
    const [, url] = match
    if (url === undefined) {
      throw new Error('Could not locate TYPED_VALIDATION_DOCS_URL in config.ts')
    }
    return url
  }

  test('URL points at fro.bot/systematic (host drift regression)', () => {
    // The subdomain form `systematic.fro.bot` does not resolve in DNS.
    // The production site is served from `https://fro.bot/systematic/`
    // (matches `site` + `base` in docs/astro.config.mjs).
    const url = readTypedValidationDocsUrl()
    expect(url).toMatch(/^https:\/\/fro\.bot\/systematic\//)
    expect(url).toContain('#typed-validation')
  })

  /**
   * Derive heading slugs from MDX content using Starlight's conservative
   * slugify rules: lowercase, spaces → hyphens, strip non-alphanumeric-or-hyphen.
   */
  function slugify(heading: string): string {
    return heading
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
  }

  function extractHeadingSlugs(mdx: string): Set<string> {
    const slugs = new Set<string>()
    for (const line of mdx.split('\n')) {
      const m = line.match(/^#{1,6}\s+(.+)$/)
      if (m) {
        const [, heading] = m
        if (heading !== undefined) slugs.add(slugify(heading.trim()))
      }
    }
    return slugs
  }

  test('configuration.mdx contains a heading that slugifies to "typed-validation"', () => {
    expect(fs.existsSync(CONFIG_MDX)).toBe(true)
    const mdx = fs.readFileSync(CONFIG_MDX, 'utf-8')
    const slugs = extractHeadingSlugs(mdx)
    expect(slugs.has('typed-validation')).toBe(true)
  })
})
