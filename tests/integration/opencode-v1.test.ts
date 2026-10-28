// The OpenCode v1 behaviors that have no v2 counterpart, run by the two v1
// host jobs only:
//   - the packaged plugin's catalog is read from the v1 `tool.definition`
//     hook, and a rejected config is read from v1's `debug config` command.
//     The v2 equivalents (the catalog the model is offered, and a config that
//     fails the plugin load) live in opencode-v2.test.ts.
//   - the mixed-version test loads a published release next to the local
//     source, and that release only loads on v1.
// Nothing here may skip on a v2 host; the profile lists keep this file off it.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { requireOpencodeAvailable } from '../../scripts/lib/opencode-availability.js'
import {
  assertMixedVersionProbeEvents,
  assertOk,
  assertProbeCapturedEvents,
  buildIsolatedOpencodeEnv,
  cleanupPackedTarball,
  createIsolatedFixture,
  createProbePlugin,
  destroyIsolatedFixture,
  EXACT_OPENCODE_VERSION,
  extractPackagedPlugin,
  getOpencodeAvailability,
  type IsolatedFixture,
  isOpencodeAvailable,
  isProbeToolEvent,
  MAX_RETRIES,
  type OpencodeResult,
  opencodeAvailabilityReason,
  packTarballOnce,
  REPO_ROOT,
  runOpencode,
  spawnOpencodeChild,
  TIMEOUT_MS,
} from './fixtures/opencode-host.js'

// This call lives here rather than in the fixture module, so importing the
// fixture never spawns the launcher at module scope (see
// tests/unit/opencode-host-no-spawn.test.ts).
requireOpencodeAvailable(getOpencodeAvailability())
if (!isOpencodeAvailable()) {
  console.warn(
    `[systematic] skipping OpenCode-dependent tests in opencode-v1.test.ts: ${opencodeAvailabilityReason()}`,
  )
}

// The host's own tool-invocation log line, produced only if OpenCode actually
// dispatched the scripted `systematic_skill` call with the expected skill name.
function expectSetupSkillLoaded(result: OpencodeResult): void {
  assertOk(result)
  expect(result.stderr).toMatch(
    /(?:Skill\s+"?git-clean-gone-branches"?|systematic_skill\s*\{"name":"(?:systematic:)?git-clean-gone-branches"\})/i,
  )
}

/**
 * Model-free `opencode debug config` invocation, isolated the same way as
 * `runOpencode`. Routed through `spawnOpencodeChild` (not `Bun.spawnSync`)
 * for the same reason `runOpencode` is: `Bun.spawnSync` signals only the
 * direct `bunx` process on timeout, leaving a `opencode-ai` grandchild
 * orphaned; `spawnOpencodeChild` reaps the whole process group instead.
 */
async function runOpencodeDebugConfig(
  fixture: IsolatedFixture,
  configContent: string,
): Promise<OpencodeResult> {
  const childEnv = buildIsolatedOpencodeEnv(fixture, configContent)
  return spawnOpencodeChild(
    [
      'bunx',
      `opencode-ai@${EXACT_OPENCODE_VERSION}`,
      'debug',
      'config',
      '--print-logs',
      '--log-level',
      'ERROR',
    ],
    { cwd: fixture.projectDir, env: childEnv, timeoutMs: TIMEOUT_MS },
  )
}

// Requires real `tar` and symlink semantics for artifact extraction; POSIX only.
describe.skipIf(!isOpencodeAvailable() || process.platform === 'win32')(
  'packaged-plugin runtime validation',
  () => {
    let fixture: IsolatedFixture

    beforeAll(() => {
      packTarballOnce()
    }, 200_000)

    afterAll(() => {
      cleanupPackedTarball()
    })

    beforeEach(() => {
      fixture = createIsolatedFixture()
    })

    afterEach(() => {
      destroyIsolatedFixture(fixture)
    })

    // Runs against `runOpencode`'s scripted local provider (no network,
    // no hosted-model dependency); see fixtures/opencode-host.ts.
    test(
      'packaged plugin loads, warns on a removed disabled_skills name, and exposes a compliant catalog',
      async () => {
        const probe = createProbePlugin(fixture)
        const { pluginUrl } = extractPackagedPlugin(fixture)
        fs.mkdirSync(path.join(fixture.projectDir, '.opencode'), {
          recursive: true,
        })
        fs.writeFileSync(
          path.join(fixture.projectDir, '.opencode/systematic.json'),
          JSON.stringify({ disabled_skills: ['orchestrating-swarms'] }),
        )
        const configContent = JSON.stringify({
          plugin: [pluginUrl, probe.url],
        })

        const result = await runOpencode(
          'Use the systematic_skill tool to load systematic:git-clean-gone-branches',
          { fixture, configContent },
        )

        // Tool actually being invoked and its output surfacing proves the
        // packaged plugin's hooks registered and ran startup successfully.
        expectSetupSkillLoaded(result)
        expect(result.stderr).toContain(
          '[systematic] "orchestrating-swarms" in `disabled_skills` is no longer a bundled name and will be ignored.',
        )

        const events = assertProbeCapturedEvents(probe)
        const toolEvents = events.filter(isProbeToolEvent)
        expect(toolEvents.length).toBeGreaterThan(0)
        for (const event of toolEvents) {
          expect(event.description).toContain(
            'systematic:orchestrating-subagents',
          )
          expect(event.description).not.toContain(
            'systematic:orchestrating-swarms',
          )
          expect(event.description).not.toContain(
            'systematic:claude-permissions-optimizer',
          )
        }
      },
      TIMEOUT_MS * MAX_RETRIES,
    )

    test(
      'packaged plugin rejects an unrecognized disabled_skills name, model-free',
      async () => {
        const { pluginUrl } = extractPackagedPlugin(fixture)
        fs.mkdirSync(path.join(fixture.projectDir, '.opencode'), {
          recursive: true,
        })
        fs.writeFileSync(
          path.join(fixture.projectDir, '.opencode/systematic.json'),
          JSON.stringify({ disabled_skills: ['never-existed-skill'] }),
        )
        const configContent = JSON.stringify({ plugin: [pluginUrl] })

        const result = await runOpencodeDebugConfig(fixture, configContent)

        // OpenCode 1.17.18 host contract: plugin-factory rejections are
        // caught and logged, hooks omitted, host exits 0
        // (.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/plugin/index.ts:219-235).
        // Asserting exitCode === 0 (not just log content) prevents a hang
        // or crash from silently passing.
        expect(result.exitCode).toBe(0)
        expect(result.stderr).toContain('failed to load plugin')
        expect(result.stderr).toContain('Invalid Systematic config in')
      },
      TIMEOUT_MS,
    )
  },
)

const MIXED_VERSION_ENABLED = process.env.SYSTEMATIC_MIXED_VERSION_TEST === '1'

function buildMixedVersionConfig(probePluginUrl: string): string {
  // Pin the published package to a known-good OpenCode integration surface;
  // bump this only when intentionally revalidating a newer release here.
  const pinnedPackage = '@fro.bot/systematic@2.14.1'
  const localSource = `file://${path.join(REPO_ROOT, 'src/index.ts')}`
  return JSON.stringify({
    plugin: [pinnedPackage, localSource, probePluginUrl],
  })
}

describe.skipIf(!isOpencodeAvailable())(
  'opencode mixed-version integration',
  () => {
    let fixture: IsolatedFixture

    beforeEach(() => {
      fixture = createIsolatedFixture()
    })

    afterEach(() => {
      destroyIsolatedFixture(fixture)
    })

    test.skipIf(!MIXED_VERSION_ENABLED)(
      'pinned package plus local source keep systematic_skill deterministic and converge bootstrap',
      async () => {
        const probe = createProbePlugin(fixture)
        const result = await runOpencode(
          'Use the systematic_skill tool to load ce:review',
          {
            fixture,
            configContent: buildMixedVersionConfig(probe.url),
            extraEnv: {
              npm_config_cache: path.join(fixture.tempRoot, 'npm-cache'),
              npm_config_prefix: path.join(fixture.tempRoot, 'npm-prefix'),
            },
          },
        )

        assertOk(result)
        expect(result.stderr).toMatch(/systematic_skill/)
        expect(result.stdout).toMatch(/ce:review/i)

        const events = assertProbeCapturedEvents(probe)

        assertMixedVersionProbeEvents(events)

        const toolEvents = events.filter(isProbeToolEvent)
        expect(toolEvents.length).toBeGreaterThanOrEqual(2)
        expect(new Set(toolEvents.map((event) => event.description)).size).toBe(
          1,
        )
        expect(
          new Set(toolEvents.map((event) => JSON.stringify(event.parameters)))
            .size,
        ).toBe(1)
        for (const event of toolEvents) {
          expect(event.description).toContain('## Available Systematic Skills')
          expect(event.description).toMatch(
            /ce:brainstorm|systematic:git-clean-gone-branches/,
          )
          expect(event.description).not.toContain('<available_skills>')
          expect(event.description).not.toContain('<location>')
        }
      },
      TIMEOUT_MS * MAX_RETRIES,
    )
  },
)
