import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { GENERATED_SURFACES } from '../../scripts/lib/generated-surfaces.ts'
import {
  OPENCODE_CLI_PACKAGES,
  readOpencodeHostPins,
} from '../../scripts/lib/opencode-pin.ts'
import {
  findLockProblems,
  HOST_LOCKS,
  type HostLock,
  syncHostLock,
} from '../../scripts/sync-host-locks.ts'

/**
 * OpenSSF Scorecard's Pinned-Dependencies check flags `npm install <pkg>@<ver>`
 * in a workflow, because an exact version is not a hash. It accepts `npm ci`,
 * which installs only what a committed lockfile records, integrity hash
 * included. The v2 host CLI is therefore installed from a committed lock under
 * `scripts/host-locks/`, and the lock must name the version in
 * `scripts/opencode-host-pins.json`. Renovate bumps only the pin file; the
 * `host-locks` generated surface (run by `postupgrade`) regenerates the lock
 * in the same PR. These tests keep
 * the three in agreement.
 *
 * The v1 CLI jobs launch through `bunx`, which Scorecard does not parse, and
 * install nothing through npm, so they need no lock.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..')
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github/workflows')

const pins = readOpencodeHostPins()

/** `describe.each` and `test.each` take a mutable array. */
const LOCKS: HostLock[] = [...HOST_LOCKS]

function pinFor(lock: HostLock): string {
  return pins[lock.pinKey]
}

function copyLockDir(lock: HostLock): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-locks-'))
  const target = path.join(dir, lock.dir)
  fs.mkdirSync(target, { recursive: true })
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(
      path.join(REPO_ROOT, lock.dir, file),
      path.join(target, file),
    )
  }
  return dir
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

describe('host lock table', () => {
  test('names a lock for every host CLI that a workflow installs through npm', () => {
    expect(HOST_LOCKS.map((lock) => lock.pinKey)).toEqual(['v2'])
    for (const lock of HOST_LOCKS) {
      expect(lock.packageName).toBe(OPENCODE_CLI_PACKAGES[lock.pinKey])
      expect(fs.existsSync(path.join(REPO_ROOT, lock.dir))).toBe(true)
    }
  })
})

describe.each(LOCKS)('host lock $dir', (lock) => {
  test('agrees with the pin file and records an integrity hash for every package', () => {
    expect(findLockProblems(REPO_ROOT, lock, pinFor(lock))).toEqual([])
  })

  test('the manifest declares the CLI at the exact pin and nothing else', () => {
    const manifest = readJson(path.join(REPO_ROOT, lock.dir, 'package.json'))

    expect(manifest.private).toBe(true)
    expect(manifest.dependencies).toEqual({ [lock.packageName]: pinFor(lock) })
  })

  test('is reported when the pin file moves and the lock does not', () => {
    const problems = findLockProblems(REPO_ROOT, lock, '9999.2.1')

    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join('\n')).toContain('9999.2.1')
  })

  test('is reported when the lock is missing', () => {
    const dir = copyLockDir(lock)
    try {
      fs.rmSync(path.join(dir, lock.dir, 'package-lock.json'))

      expect(findLockProblems(dir, lock, pinFor(lock)).join('\n')).toContain(
        'package-lock.json',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('is reported when a package loses its integrity hash', () => {
    const dir = copyLockDir(lock)
    try {
      const lockPath = path.join(dir, lock.dir, 'package-lock.json')
      const content = readJson(lockPath) as {
        packages: Record<string, { integrity?: string }>
      }
      const entry = content.packages[`node_modules/${lock.packageName}`]
      if (entry === undefined) throw new Error('lock has no entry for the CLI')
      delete entry.integrity
      fs.writeFileSync(lockPath, JSON.stringify(content, null, 2))

      expect(findLockProblems(dir, lock, pinFor(lock)).join('\n')).toContain(
        'integrity',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('is reported when the manifest drifts from the pin', () => {
    const dir = copyLockDir(lock)
    try {
      const manifestPath = path.join(dir, lock.dir, 'package.json')
      const manifest = readJson(manifestPath)
      manifest.dependencies = { [lock.packageName]: '9999.2.1' }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

      expect(findLockProblems(dir, lock, pinFor(lock)).join('\n')).toContain(
        'package.json',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('requires the platform package the host-contract runner installs', () => {
    expect(lock.platformPackages).toContain('@opencode/cli-linux-x64')
  })

  test('is reported when only the runner platform entry is missing from the lock', () => {
    const dir = copyLockDir(lock)
    try {
      const lockPath = path.join(dir, lock.dir, 'package-lock.json')
      const content = readJson(lockPath) as {
        packages: Record<string, unknown>
      }
      delete content.packages['node_modules/@opencode/cli-linux-x64']
      fs.writeFileSync(lockPath, `${JSON.stringify(content, null, 2)}\n`)

      // The manifest and the CLI entry still match the pin: only the platform
      // entry is gone, and the offline check must say so by name.
      const problems = findLockProblems(dir, lock, pinFor(lock))
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('node_modules/@opencode/cli-linux-x64')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  const platformKey = 'node_modules/@opencode/cli-linux-x64'
  const digest = (bytes: number) =>
    `sha512-${Buffer.alloc(bytes, 7).toString('base64')}`

  test.each([
    ['a digest of 32 bytes', { integrity: digest(32) }],
    ['a digest of 65 bytes', { integrity: digest(65) }],
    [
      'a sha1 digest',
      { integrity: `sha1-${Buffer.alloc(20).toString('base64')}` },
    ],
    ['a digest that is not base64', { integrity: `sha512-${'!'.repeat(88)}` }],
    ['a digest with trailing text', { integrity: `${digest(64)}x` }],
    ['no integrity', { integrity: undefined }],
    ['no resolved URL', { resolved: undefined }],
    [
      'a resolved URL outside the registry',
      { resolved: 'https://example.com/x.tgz' },
    ],
    ['no version', { version: undefined }],
    ['another version', { version: '9999.2.1' }],
    ['a string instead of an object', 'oops'],
    ['null', null],
  ])('rejects a platform entry with %s', (_label, change) => {
    const dir = copyLockDir(lock)
    try {
      const lockPath = path.join(dir, lock.dir, 'package-lock.json')
      const content = readJson(lockPath) as {
        packages: Record<string, unknown>
      }
      const entry = content.packages[platformKey]
      content.packages[platformKey] =
        typeof change === 'object' && change !== null
          ? { ...(entry as object), ...change }
          : change
      fs.writeFileSync(lockPath, `${JSON.stringify(content, null, 2)}\n`)

      const problems = findLockProblems(dir, lock, pinFor(lock))
      expect(problems.length).toBeGreaterThan(0)
      expect(problems.join('\n')).toContain(platformKey)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('regeneration', () => {
    let savedPath: string | undefined

    function withFakeNpm(script: string): { dir: string; binDir: string } {
      const dir = copyLockDir(lock)
      const binDir = path.join(dir, 'fake-bin')
      fs.mkdirSync(binDir)
      fs.writeFileSync(path.join(binDir, 'npm'), script, { mode: 0o755 })
      savedPath = process.env.PATH
      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
      return { dir, binDir }
    }

    function snapshot(dir: string): Record<string, string> {
      const target = path.join(dir, lock.dir)
      return Object.fromEntries(
        fs
          .readdirSync(target)
          .sort()
          .map((name) => [
            name,
            fs.readFileSync(path.join(target, name), 'utf8'),
          ]),
      )
    }

    afterEach(() => {
      if (savedPath !== undefined) process.env.PATH = savedPath
      savedPath = undefined
    })

    test('leaves the existing lock untouched when npm fails', () => {
      const { dir } = withFakeNpm('#!/bin/bash\necho boom >&2\nexit 1\n')
      try {
        const before = snapshot(dir)

        expect(() => syncHostLock(dir, lock, '9999.2.1')).toThrow()
        expect(snapshot(dir)).toEqual(before)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    test('leaves the existing lock untouched when npm writes a lock without the platform entry', () => {
      // A lock that resolves the CLI but lacks the runner's platform package is
      // the incomplete result `npm ci` would turn into a launcher fallback.
      const { dir } = withFakeNpm(
        [
          '#!/bin/bash',
          'cat > package-lock.json <<EOF',
          '{"lockfileVersion":3,"packages":{',
          '"":{"dependencies":{"@opencode/cli":"9999.2.1"}},',
          `"node_modules/@opencode/cli":{"version":"9999.2.1","resolved":"https://registry.npmjs.org/x.tgz","integrity":"${digest(64)}"}`,
          '}}',
          'EOF',
        ].join('\n'),
      )
      try {
        const before = snapshot(dir)

        expect(() => syncHostLock(dir, lock, '9999.2.1')).toThrow(
          /cli-linux-x64/,
        )
        expect(snapshot(dir)).toEqual(before)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    test('does not call npm or write anything when the lock already agrees', () => {
      const { dir } = withFakeNpm('#!/bin/bash\necho called >&2\nexit 1\n')
      try {
        const before = snapshot(dir)

        expect(() => syncHostLock(dir, lock, pinFor(lock))).not.toThrow()
        expect(snapshot(dir)).toEqual(before)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

interface WorkflowStep {
  name: string
  file: string
  run: string
}

function workflowRunSteps(): WorkflowStep[] {
  const { JSON_SCHEMA } = yaml
  const steps: WorkflowStep[] = []
  for (const file of fs.readdirSync(WORKFLOWS_DIR)) {
    if (!/\.ya?ml$/.test(file)) continue
    const workflow = yaml.load(
      fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'),
      { schema: JSON_SCHEMA },
    ) as { jobs?: Record<string, { steps?: unknown[] }> }
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        const record = step as { name?: string; run?: string }
        if (typeof record.run === 'string') {
          steps.push({ name: record.name ?? '', file, run: record.run })
        }
      }
    }
  }
  return steps
}

describe('workflow installs of the host CLI', () => {
  const steps = workflowRunSteps()

  test('the workflow reader finds the host-contract install step', () => {
    expect(
      steps.some(
        (step) =>
          step.file === 'main.yaml' && /npm (ci|install)/.test(step.run),
      ),
    ).toBe(true)
  })

  test('no workflow step runs an npm install of an OpenCode CLI package', () => {
    const packages = Object.values(OPENCODE_CLI_PACKAGES)
    const offenders = steps.filter(
      (step) =>
        /\bnpm\s+(install|i|add|update)\b/.test(step.run) &&
        packages.some((name) => step.run.includes(name)),
    )

    expect(offenders.map((step) => `${step.file}: ${step.name}`)).toEqual([])
  })

  test('main.yaml runs no `npm install` at all, so no host install escapes the lock', () => {
    const offenders = steps.filter(
      (step) =>
        step.file === 'main.yaml' && /\bnpm\s+(install|i|add)\b/.test(step.run),
    )

    expect(offenders.map((step) => step.name)).toEqual([])
  })

  test.each(LOCKS)(
    'installs the $pinKey CLI with `npm ci --prefix` on its lock directory, naming no package spec',
    (lock) => {
      const installs = steps.filter(
        (step) => step.file === 'main.yaml' && step.run.includes(lock.dir),
      )

      expect(installs).toHaveLength(1)
      const run = installs[0]?.run ?? ''
      expect(run).toContain(`npm ci --prefix "${lock.dir}"`)
      expect(run).not.toContain(`${lock.packageName}@`)
      expect(run).toContain('--ignore-scripts')
      expect(run).not.toContain('--dangerously-allow-all-scripts')
    },
  )
})

describe('the runner platform package', () => {
  test.each(LOCKS)(
    'every host-contract job runs on ubuntu-latest, and the install step maps it to a package that $dir locks',
    (lock) => {
      const { JSON_SCHEMA } = yaml
      const workflow = yaml.load(
        fs.readFileSync(path.join(WORKFLOWS_DIR, 'main.yaml'), 'utf8'),
        { schema: JSON_SCHEMA },
      ) as { jobs: Record<string, { 'runs-on'?: string; steps?: unknown[] }> }
      const hostJobs = Object.entries(workflow.jobs).filter(([id]) =>
        id.startsWith('host-contract'),
      )

      expect(hostJobs.length).toBeGreaterThan(0)
      for (const [, job] of hostJobs)
        expect(job['runs-on']).toBe('ubuntu-latest')

      const install = workflowRunSteps().find((step) =>
        step.run.includes(lock.dir),
      )
      // `Linux-x86_64` is what `uname` prints on an ubuntu-latest runner.
      expect(install?.run).toContain('Linux-x86_64) platform="linux-x64"')
      expect(lock.platformPackages).toContain('@opencode/cli-linux-x64')
    },
  )
})

describe('Renovate keeps the locks in step with the pin file', () => {
  const config = Bun.JSON5.parse(
    fs.readFileSync(path.join(REPO_ROOT, '.github/renovate.json5'), 'utf8'),
  ) as { ignorePaths: string[] }

  test.each(LOCKS)(
    'Renovate does not track the manifest in $dir as a second source for the pin',
    (lock) => {
      const manifest = `${lock.dir}/package.json`

      expect(
        config.ignorePaths.some((pattern) =>
          new Bun.Glob(pattern).match(manifest),
        ),
      ).toBe(true)
    },
  )

  test('the locks are a generated surface, so the postupgrade regeneration and the CI drift gate cover them', () => {
    const scripts = readJson(path.join(REPO_ROOT, 'package.json')).scripts as
      | Record<string, string>
      | undefined
    const surface = GENERATED_SURFACES.find(({ name }) => name === 'host-locks')

    expect(surface?.regenScript).toBe('host-locks:sync')
    expect(surface?.checkScript).toBe('host-locks:check')
    for (const lock of HOST_LOCKS) {
      expect(surface?.outputs).toContain(`${lock.dir}/package.json`)
      expect(surface?.outputs).toContain(`${lock.dir}/package-lock.json`)
    }
    expect(scripts?.postupgrade).toContain('bun run surfaces:regen')
    expect(scripts?.['host-locks:sync']).toBe('bun scripts/sync-host-locks.ts')
    expect(scripts?.['host-locks:check']).toBe(
      'bun scripts/sync-host-locks.ts --check',
    )
  })
})
