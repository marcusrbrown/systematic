import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type OpencodeAvailabilityClassification,
  probeOpencodeAvailability,
  requireOpencodeAvailable,
  resolveBunInstallCacheDir,
} from '../../scripts/lib/opencode-availability.ts'

// This suite's fixture literals below ("9999.0.0", "9999.0.1") are
// deliberately unpinnable sentinel versions, not real OpenCode releases.
// probeOpencodeAvailability and resolveBunInstallCacheDir (and the
// classification logic inside them) all take `pin` as a parameter, so these
// fixtures never needed a real version -- but a realistic-looking literal
// (e.g. an old "1.18.x" value) collides with tests/unit/opencode-pin.test.ts's
// R1 guard the moment a Renovate bump reaches that exact version, since R1
// forbids the real pin literal appearing anywhere under scripts/ or tests/.
// "9999.0.0" can never be a real published opencode-ai version, so it is
// structurally incapable of ever re-triggering that false positive. Keep
// using sentinel versions here instead of a real-looking version number.
// tests/unit/opencode-pin.test.ts's "R2" guard machine-enforces this: it
// fails if any OpenCode-shaped version literal in this file falls outside
// the 9999.x sentinel range, so a future edit can't silently reintroduce a
// realistic literal.

/** The sentinel pin used by most cases in this suite. */
const SENTINEL_PIN = '9999.0.0'
/** A second, distinct sentinel used wherever a case needs a deliberate mismatch against {@link SENTINEL_PIN}. */
const SENTINEL_MISMATCH_PIN = '9999.0.1'

const ORIGINAL_REQUIRE_FLAG = process.env.SYSTEMATIC_REQUIRE_OPENCODE

afterEach(() => {
  if (ORIGINAL_REQUIRE_FLAG === undefined) {
    delete process.env.SYSTEMATIC_REQUIRE_OPENCODE
  } else {
    process.env.SYSTEMATIC_REQUIRE_OPENCODE = ORIGINAL_REQUIRE_FLAG
  }
})

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-availability-test-'))
}

function writeFakeLauncher(dir: string, script: string): string {
  const scriptPath = path.join(dir, 'fake-opencode-launcher')
  fs.writeFileSync(scriptPath, script, { mode: 0o755 })
  fs.chmodSync(scriptPath, 0o755)
  return scriptPath
}

function fakeStats(overrides: {
  isSymbolicLink: boolean
  isDirectory: boolean
  uid: number
  mode: number
}): fs.Stats {
  return {
    isSymbolicLink: () => overrides.isSymbolicLink,
    isDirectory: () => overrides.isDirectory,
    uid: overrides.uid,
    mode: overrides.mode,
  } as unknown as fs.Stats
}

describe('probeOpencodeAvailability', () => {
  test('a fake launcher printing the pin classifies as available', () => {
    const dir = tempDir()
    try {
      const launcher = writeFakeLauncher(
        dir,
        `#!/usr/bin/env bash\necho "${SENTINEL_PIN}"\n`,
      )
      const classification = probeOpencodeAvailability({
        pin: SENTINEL_PIN,
        env: { PATH: process.env.PATH ?? '' },
        command: launcher,
        args: [],
      })
      expect(classification.status).toBe('available')
      expect(classification.reportedVersion).toBe(SENTINEL_PIN)
      expect(classification.expectedVersion).toBe(SENTINEL_PIN)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a fake launcher printing a different version classifies as mismatch naming both versions', () => {
    const dir = tempDir()
    try {
      const launcher = writeFakeLauncher(
        dir,
        `#!/usr/bin/env bash\necho "${SENTINEL_MISMATCH_PIN}"\n`,
      )
      const classification = probeOpencodeAvailability({
        pin: SENTINEL_PIN,
        env: { PATH: process.env.PATH ?? '' },
        command: launcher,
        args: [],
      })
      expect(classification.status).toBe('mismatch')
      expect(classification.reportedVersion).toBe(SENTINEL_MISMATCH_PIN)
      expect(classification.reason).toContain(SENTINEL_PIN)
      expect(classification.reason).toContain(SENTINEL_MISMATCH_PIN)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a fake launcher exiting non-zero with stderr classifies as unavailable with a stderr excerpt', () => {
    const dir = tempDir()
    try {
      const launcher = writeFakeLauncher(
        dir,
        '#!/usr/bin/env bash\necho "boom from fake launcher" >&2\nexit 1\n',
      )
      const classification = probeOpencodeAvailability({
        pin: SENTINEL_PIN,
        env: { PATH: process.env.PATH ?? '' },
        command: launcher,
        args: [],
      })
      expect(classification.status).toBe('unavailable')
      expect(classification.reportedVersion).toBeUndefined()
      expect(classification.reason).toContain('boom from fake launcher')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a fake launcher hanging past the timeout classifies as unavailable with a timeout reason', () => {
    const dir = tempDir()
    try {
      const launcher = writeFakeLauncher(
        dir,
        `#!/usr/bin/env bash\nsleep 5\necho "${SENTINEL_PIN}"\n`,
      )
      const classification = probeOpencodeAvailability({
        pin: SENTINEL_PIN,
        env: { PATH: process.env.PATH ?? '' },
        command: launcher,
        args: [],
        timeoutMs: 100,
      })
      expect(classification.status).toBe('unavailable')
      expect(classification.reason).toContain('failed')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a fake launcher exiting 0 with unparseable stdout classifies as unavailable', () => {
    const dir = tempDir()
    try {
      const launcher = writeFakeLauncher(
        dir,
        '#!/usr/bin/env bash\necho "no version here"\n',
      )
      const classification = probeOpencodeAvailability({
        pin: SENTINEL_PIN,
        env: { PATH: process.env.PATH ?? '' },
        command: launcher,
        args: [],
      })
      expect(classification.status).toBe('unavailable')
      expect(classification.reportedVersion).toBeUndefined()
      expect(classification.reason).toContain('no parseable version')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a trailing update-notice line after the real version does not get misparsed as the reported version', () => {
    const dir = tempDir()
    try {
      // Old regex-anywhere-in-buffer parsing would have picked the mismatch
      // sentinel out of the notice line and reported a false mismatch
      // against the pin. The new last-line-exact-semver contract instead
      // treats a non-semver last line as unparseable, which is the safe
      // outcome here.
      const launcher = writeFakeLauncher(
        dir,
        `#!/usr/bin/env bash\necho "${SENTINEL_PIN}"\necho "update available ${SENTINEL_MISMATCH_PIN}"\n`,
      )
      const classification = probeOpencodeAvailability({
        pin: SENTINEL_PIN,
        env: { PATH: process.env.PATH ?? '' },
        command: launcher,
        args: [],
      })
      expect(classification.status).toBe('unavailable')
      expect(classification.reportedVersion).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('probeOpencodeAvailability diagnostic logging', () => {
  test('logs a diagnostic before the real bunx probe unless quiet is set', () => {
    // Every other case in this suite passes a `command` override, which
    // means `options.command === undefined` -- the branch that gates the
    // diagnostic -- is never exercised. Aliasing a fake launcher as `bunx`
    // on a PATH scoped to the child's env lets this test drive the real
    // default-command path without touching the network-reaching real
    // launcher.
    const dir = tempDir()
    try {
      const bunxPath = path.join(dir, 'bunx')
      fs.writeFileSync(
        bunxPath,
        `#!/usr/bin/env bash\necho "${SENTINEL_PIN}"\n`,
        {
          mode: 0o755,
        },
      )
      fs.chmodSync(bunxPath, 0o755)
      const env = { PATH: `${dir}:${process.env.PATH ?? ''}` }
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const loud = probeOpencodeAvailability({ pin: SENTINEL_PIN, env })
        expect(loud.status).toBe('available')
        expect(warnSpy).toHaveBeenCalledTimes(1)
        expect(warnSpy.mock.calls[0]?.[0]).toContain(
          `probing bunx opencode-ai@${SENTINEL_PIN}`,
        )

        warnSpy.mockClear()

        const quiet = probeOpencodeAvailability({
          pin: SENTINEL_PIN,
          env,
          quiet: true,
        })
        expect(quiet.status).toBe('available')
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('requireOpencodeAvailable', () => {
  test('an available classification never throws, flag set or not', () => {
    const available: OpencodeAvailabilityClassification = {
      status: 'available',
      expectedVersion: SENTINEL_PIN,
      reportedVersion: SENTINEL_PIN,
      reason: `opencode-ai@${SENTINEL_PIN} is available`,
    }
    delete process.env.SYSTEMATIC_REQUIRE_OPENCODE
    expect(() => requireOpencodeAvailable(available)).not.toThrow()
    process.env.SYSTEMATIC_REQUIRE_OPENCODE = '1'
    expect(() => requireOpencodeAvailable(available)).not.toThrow()
  })

  test('a non-available classification throws only under SYSTEMATIC_REQUIRE_OPENCODE=1', () => {
    const unavailable: OpencodeAvailabilityClassification = {
      status: 'unavailable',
      expectedVersion: SENTINEL_PIN,
      reason: 'launcher unavailable: boom',
    }
    delete process.env.SYSTEMATIC_REQUIRE_OPENCODE
    expect(() => requireOpencodeAvailable(unavailable)).not.toThrow()
    process.env.SYSTEMATIC_REQUIRE_OPENCODE = '1'
    expect(() => requireOpencodeAvailable(unavailable)).toThrow(
      'launcher unavailable: boom',
    )
  })

  test('a mismatch classification throws only under SYSTEMATIC_REQUIRE_OPENCODE=1', () => {
    const mismatch: OpencodeAvailabilityClassification = {
      status: 'mismatch',
      expectedVersion: SENTINEL_PIN,
      reportedVersion: SENTINEL_MISMATCH_PIN,
      reason: `expected opencode-ai@${SENTINEL_PIN} but bunx resolved opencode-ai@${SENTINEL_MISMATCH_PIN}`,
    }
    delete process.env.SYSTEMATIC_REQUIRE_OPENCODE
    expect(() => requireOpencodeAvailable(mismatch)).not.toThrow()
    process.env.SYSTEMATIC_REQUIRE_OPENCODE = '1'
    expect(() => requireOpencodeAvailable(mismatch)).toThrow(
      new RegExp(
        `${SENTINEL_PIN.replaceAll('.', '\\.')}.*${SENTINEL_MISMATCH_PIN.replaceAll('.', '\\.')}`,
      ),
    )
  })
})

describe('resolveBunInstallCacheDir', () => {
  test('creates a fresh temp root with mode 0700', () => {
    const tmpRoot = tempDir()
    try {
      const dir = resolveBunInstallCacheDir({ pin: SENTINEL_PIN, tmpRoot })
      const stats = fs.lstatSync(dir)
      expect(stats.isDirectory()).toBe(true)
      expect(stats.mode & 0o777).toBe(0o700)
      expect(path.basename(dir)).toContain(SENTINEL_PIN)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('tightens a reused directory left at 0755 back to 0700', () => {
    const tmpRoot = tempDir()
    try {
      const first = resolveBunInstallCacheDir({ pin: SENTINEL_PIN, tmpRoot })
      fs.chmodSync(first, 0o755)
      expect(fs.lstatSync(first).mode & 0o777).toBe(0o755)

      const second = resolveBunInstallCacheDir({ pin: SENTINEL_PIN, tmpRoot })
      expect(second).toBe(first)
      expect(fs.lstatSync(second).mode & 0o777).toBe(0o700)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('refuses a real symlink pointing at another directory', () => {
    const tmpRoot = tempDir()
    try {
      // Create the directory for real first, then swap it for a real
      // symlink at the exact same path, so lstatSync sees a genuine
      // symlink rather than a stubbed one.
      const dirPath = resolveBunInstallCacheDir({
        pin: SENTINEL_PIN,
        tmpRoot,
      })
      fs.rmSync(dirPath, { recursive: true, force: true })
      const target = path.join(tmpRoot, 'symlink-target')
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      fs.symlinkSync(target, dirPath, 'dir')

      expect(() =>
        resolveBunInstallCacheDir({ pin: SENTINEL_PIN, tmpRoot }),
      ).toThrow(/symlink/)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('does not memoize across calls in one process (real symlink swap, no stubbing)', () => {
    const tmpRoot = tempDir()
    try {
      const dirPath = resolveBunInstallCacheDir({
        pin: SENTINEL_PIN,
        tmpRoot,
      })

      // Swap the real directory for a real symlink: the very next call must
      // still throw, proving nothing was cached from the prior successful call.
      fs.rmSync(dirPath, { recursive: true, force: true })
      const target = path.join(tmpRoot, 'memoize-swap-target')
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      fs.symlinkSync(target, dirPath, 'dir')
      expect(() =>
        resolveBunInstallCacheDir({ pin: SENTINEL_PIN, tmpRoot }),
      ).toThrow(/symlink/)

      // Swap back to a real directory: the call after that must succeed
      // again, proving the prior throw wasn't cached either.
      fs.rmSync(dirPath, { force: true })
      fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
      expect(() =>
        resolveBunInstallCacheDir({ pin: SENTINEL_PIN, tmpRoot }),
      ).not.toThrow()
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('refuses a directory owned by a foreign uid (stubbed lstatSync; unavoidable rootless)', () => {
    // Unlike the symlink case above, a genuinely foreign-owned directory
    // cannot be created without root (or a second real user account), so
    // this one case stays stubbed — every other resolver behavior in this
    // suite exercises the real filesystem.
    const tmpRoot = tempDir()
    const uid = process.getuid?.() ?? 0
    const spy = spyOn(fs, 'lstatSync').mockReturnValue(
      fakeStats({
        isSymbolicLink: false,
        isDirectory: true,
        uid: uid + 1,
        mode: 0o700,
      }),
    )
    try {
      expect(() =>
        resolveBunInstallCacheDir({ pin: SENTINEL_PIN, tmpRoot }),
      ).toThrow(/owned by uid/)
    } finally {
      spy.mockRestore()
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
