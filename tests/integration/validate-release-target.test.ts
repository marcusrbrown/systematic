import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Executes scripts/validate-release-target.sh against stub `gh` and `npm`
 * binaries (first on PATH) and checks each row of its contract:
 *
 * | Check                      | Release event          | Dispatch |
 * | Author mismatch            | proceed=false, exit 0  | exit 1   |
 * | Bad tag shape              | exit 1                 | exit 1   |
 * | Missing/draft/prerelease   | n/a                    | exit 1   |
 * | npm version missing        | exit 1                 | exit 1   |
 * | Not latest (REQUIRE_LATEST)| proceed=false, exit 0  | exit 1   |
 *
 * The stubs answer with what the script's `--jq` filters would print, and log
 * every invocation so tests can assert which lookups were (not) made.
 */

const SCRIPT_PATH = path.resolve(
  process.cwd(),
  'scripts/validate-release-target.sh',
)

const GH_STUB = `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
# \`gh release view <tag> ...\` is a release lookup; with no tag it asks for Latest.
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "view" ]; then
  if [[ "\${3:-}" == --* ]]; then
    [ -n "\${STUB_LATEST:-}" ] || exit 1
    printf '%s\\n' "$STUB_LATEST"
    exit 0
  fi
  [ -n "\${STUB_RELEASE_INFO:-}" ] || exit 1
  printf '%s\\n' "$STUB_RELEASE_INFO"
  exit 0
fi
exit 99
`

const NPM_STUB = `#!/usr/bin/env bash
echo "npm $*" >> "$STUB_LOG"
[ "\${STUB_NPM_OK:-1}" = "1" ] || exit 1
echo "\${2:-}"
`

const BOT = 'mrbro-bot[bot]'

interface Run {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly outputs: Readonly<Record<string, string>>
  readonly calls: readonly string[]
}

let workdir: string

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-release-target-'))
  const bin = path.join(workdir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'npm'), NPM_STUB, { mode: 0o755 })
})

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true })
})

function run(env: Record<string, string>): Run {
  const outputFile = path.join(workdir, 'github-output')
  const logFile = path.join(workdir, 'stub.log')
  fs.writeFileSync(outputFile, '')
  fs.writeFileSync(logFile, '')

  const result = spawnSync('bash', [SCRIPT_PATH], {
    encoding: 'utf8',
    env: {
      PATH: `${path.join(workdir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: workdir,
      GITHUB_OUTPUT: outputFile,
      GITHUB_REPOSITORY: 'marcusrbrown/systematic',
      GH_TOKEN: 'test-token',
      STUB_LOG: logFile,
      EXPECTED_AUTHOR: BOT,
      REQUIRE_LATEST: 'false',
      ...env,
    },
  })

  const outputs: Record<string, string> = {}
  for (const line of fs.readFileSync(outputFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1)
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs,
    calls: fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean),
  }
}

const releaseEvent = (overrides: Record<string, string> = {}) => ({
  EVENT_NAME: 'release',
  RELEASE_TAG: 'v1.2.3',
  RELEASE_AUTHOR: BOT,
  ...overrides,
})

const dispatchEvent = (overrides: Record<string, string> = {}) => ({
  EVENT_NAME: 'workflow_dispatch',
  INPUT_TAG: 'v1.2.3',
  STUB_RELEASE_INFO: `false false ${BOT}`,
  ...overrides,
})

const combined = (r: Run) => `${r.stdout}${r.stderr}`

describe('validate-release-target.sh: release events', () => {
  test('a valid release ends with proceed=true and the tag and version', () => {
    const r = run(releaseEvent())

    expect(r.status).toBe(0)
    expect(r.outputs).toEqual({
      proceed: 'true',
      tag: 'v1.2.3',
      version: '1.2.3',
    })
    expect(r.calls).toEqual(['npm view @fro.bot/systematic@1.2.3 version'])
  })

  test('an author mismatch ends cleanly with proceed=false and a notice', () => {
    const r = run(releaseEvent({ RELEASE_AUTHOR: 'someone-else' }))

    expect(r.status).toBe(0)
    expect(r.outputs).toEqual({ proceed: 'false' })
    expect(combined(r)).toContain('::notice::')
    expect(combined(r)).toContain('someone-else')
    // Nothing else is consulted for an untrusted author.
    expect(r.calls).toEqual([])
  })

  test('the expected author comes from EXPECTED_AUTHOR', () => {
    const r = run(
      releaseEvent({
        RELEASE_AUTHOR: 'custom-bot',
        EXPECTED_AUTHOR: 'custom-bot',
      }),
    )

    expect(r.status).toBe(0)
    expect(r.outputs.proceed).toBe('true')
  })

  test.each([
    'v1.2',
    '1.2.3',
    'v1.2.3-beta.1',
    'v1.2.3.4',
    'vx.y.z',
    'v1.2.3\nv9.9.9',
    '',
  ])('a bad tag shape (%j) exits 1', (tag) => {
    const r = run(releaseEvent({ RELEASE_TAG: tag }))

    expect(r.status).toBe(1)
    expect(combined(r)).toContain('::error::')
    expect(r.outputs).toEqual({})
    expect(r.calls).toEqual([])
  })

  test('a missing npm version exits 1', () => {
    const r = run(releaseEvent({ STUB_NPM_OK: '0' }))

    expect(r.status).toBe(1)
    expect(combined(r)).toContain('::error::')
    expect(combined(r)).toContain('1.2.3')
    expect(r.outputs).toEqual({})
  })

  test('a release event needs no release lookup when the latest is not required', () => {
    const r = run(releaseEvent())

    expect(r.calls.some((c) => c.startsWith('gh '))).toBe(false)
  })

  test('REQUIRE_LATEST=true: a non-latest tag ends cleanly with proceed=false', () => {
    const r = run(
      releaseEvent({ REQUIRE_LATEST: 'true', STUB_LATEST: 'v2.0.0' }),
    )

    expect(r.status).toBe(0)
    expect(r.outputs).toEqual({ proceed: 'false' })
    expect(combined(r)).toContain('::notice::')
    expect(combined(r)).toContain('v2.0.0')
    // No npm lookup for a release we are not going to build.
    expect(r.calls.some((c) => c.startsWith('npm '))).toBe(false)
  })

  test('REQUIRE_LATEST=true: the latest tag proceeds', () => {
    const r = run(
      releaseEvent({ REQUIRE_LATEST: 'true', STUB_LATEST: 'v1.2.3' }),
    )

    expect(r.status).toBe(0)
    expect(r.outputs).toEqual({
      proceed: 'true',
      tag: 'v1.2.3',
      version: '1.2.3',
    })
    expect(r.calls).toContain(
      'gh release view --repo marcusrbrown/systematic --json tagName --jq .tagName',
    )
  })

  test('REQUIRE_LATEST=true: failing to resolve the latest release exits 1', () => {
    const r = run(releaseEvent({ REQUIRE_LATEST: 'true' }))

    expect(r.status).toBe(1)
    expect(combined(r)).toContain('::error::')
    expect(r.outputs).toEqual({})
  })
})

describe('validate-release-target.sh: workflow_dispatch', () => {
  test('a valid published release ends with proceed=true and the tag and version', () => {
    const r = run(dispatchEvent())

    expect(r.status).toBe(0)
    expect(r.outputs).toEqual({
      proceed: 'true',
      tag: 'v1.2.3',
      version: '1.2.3',
    })
  })

  test('the release is looked up in the current repo and its author is requested', () => {
    const r = run(dispatchEvent())

    const lookup = r.calls.find((c) => c.startsWith('gh release view v1.2.3'))
    expect(lookup).toBeDefined()
    expect(lookup).toContain('--repo marcusrbrown/systematic')
    expect(lookup).toMatch(/--json [^ ]*\bauthor\b/)
    expect(lookup).toMatch(/--json [^ ]*\bisDraft\b/)
    expect(lookup).toMatch(/--json [^ ]*\bisPrerelease\b/)
  })

  test('an author mismatch fails with ::error:: (never a silent skip)', () => {
    const r = run(dispatchEvent({ STUB_RELEASE_INFO: 'false false intruder' }))

    expect(r.status).toBe(1)
    expect(combined(r)).toContain('::error::')
    expect(combined(r)).toContain('intruder')
    expect(r.outputs).toEqual({})
  })

  test('the dispatch author is taken from the release, not from RELEASE_AUTHOR', () => {
    const r = run(
      dispatchEvent({
        RELEASE_AUTHOR: BOT,
        STUB_RELEASE_INFO: 'false false intruder',
      }),
    )

    expect(r.status).toBe(1)
  })

  test.each(['v1.2', '1.2.3', 'v1.2.3-rc.1', ''])(
    'a bad tag shape (%j) exits 1 before any lookup',
    (tag) => {
      const r = run(dispatchEvent({ INPUT_TAG: tag }))

      expect(r.status).toBe(1)
      expect(combined(r)).toContain('::error::')
      expect(r.calls).toEqual([])
    },
  )

  test('a missing release exits 1', () => {
    const r = run(dispatchEvent({ STUB_RELEASE_INFO: '' }))

    expect(r.status).toBe(1)
    expect(combined(r)).toContain('::error::')
    expect(combined(r)).toContain('v1.2.3')
  })

  test('a draft release exits 1', () => {
    const r = run(dispatchEvent({ STUB_RELEASE_INFO: `true false ${BOT}` }))

    expect(r.status).toBe(1)
    expect(combined(r)).toContain('::error::')
  })

  test('a prerelease exits 1', () => {
    const r = run(dispatchEvent({ STUB_RELEASE_INFO: `false true ${BOT}` }))

    expect(r.status).toBe(1)
    expect(combined(r)).toContain('::error::')
  })

  test('a missing npm version exits 1', () => {
    const r = run(dispatchEvent({ STUB_NPM_OK: '0' }))

    expect(r.status).toBe(1)
    expect(combined(r)).toContain('::error::')
    expect(r.outputs).toEqual({})
  })

  test('REQUIRE_LATEST=true: a non-latest tag fails with ::error::', () => {
    const r = run(
      dispatchEvent({ REQUIRE_LATEST: 'true', STUB_LATEST: 'v2.0.0' }),
    )

    expect(r.status).toBe(1)
    expect(combined(r)).toContain('::error::')
    expect(combined(r)).toContain('v2.0.0')
    expect(r.outputs).toEqual({})
  })

  test('REQUIRE_LATEST=true: the latest tag proceeds', () => {
    const r = run(
      dispatchEvent({ REQUIRE_LATEST: 'true', STUB_LATEST: 'v1.2.3' }),
    )

    expect(r.status).toBe(0)
    expect(r.outputs).toEqual({
      proceed: 'true',
      tag: 'v1.2.3',
      version: '1.2.3',
    })
  })

  test('REQUIRE_LATEST=false: a non-latest tag is allowed and the latest is never resolved', () => {
    const r = run(
      dispatchEvent({ REQUIRE_LATEST: 'false', STUB_LATEST: 'v2.0.0' }),
    )

    expect(r.status).toBe(0)
    expect(r.outputs.proceed).toBe('true')
    expect(r.calls.some((c) => c.includes('--json tagName'))).toBe(false)
  })
})

describe('validate-release-target.sh: fails closed on bad configuration', () => {
  test('an unknown event name exits 1', () => {
    const r = run(releaseEvent({ EVENT_NAME: 'push' }))

    expect(r.status).toBe(1)
    expect(combined(r)).toContain('::error::')
    expect(r.outputs).toEqual({})
  })

  test.each(['', 'yes', 'TRUE'])('REQUIRE_LATEST=%j exits 1', (value) => {
    const r = run(releaseEvent({ REQUIRE_LATEST: value }))

    expect(r.status).toBe(1)
    expect(combined(r)).toContain('::error::')
  })

  test('an empty EXPECTED_AUTHOR exits 1 rather than matching an empty author', () => {
    const r = run(releaseEvent({ EXPECTED_AUTHOR: '', RELEASE_AUTHOR: '' }))

    expect(r.status).toBe(1)
    expect(r.outputs).toEqual({})
  })
})
