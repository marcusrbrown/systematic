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
        '#!/usr/bin/env bash\necho "1.18.28"\n',
      )
      const classification = probeOpencodeAvailability({
        pin: '1.18.28',
        env: { PATH: process.env.PATH ?? '' },
        command: launcher,
        args: [],
      })
      expect(classification.status).toBe('available')
      expect(classification.reportedVersion).toBe('1.18.28')
      expect(classification.expectedVersion).toBe('1.18.28')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a fake launcher printing a different version classifies as mismatch naming both versions', () => {
    const dir = tempDir()
    try {
      const launcher = writeFakeLauncher(
        dir,
        '#!/usr/bin/env bash\necho "1.18.99"\n',
      )
      const classification = probeOpencodeAvailability({
        pin: '1.18.28',
        env: { PATH: process.env.PATH ?? '' },
        command: launcher,
        args: [],
      })
      expect(classification.status).toBe('mismatch')
      expect(classification.reportedVersion).toBe('1.18.99')
      expect(classification.reason).toContain('1.18.28')
      expect(classification.reason).toContain('1.18.99')
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
        pin: '1.18.28',
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
        '#!/usr/bin/env bash\nsleep 5\necho "1.18.28"\n',
      )
      const classification = probeOpencodeAvailability({
        pin: '1.18.28',
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
})

describe('requireOpencodeAvailable', () => {
  test('an available classification never throws, flag set or not', () => {
    const available: OpencodeAvailabilityClassification = {
      status: 'available',
      expectedVersion: '1.18.28',
      reportedVersion: '1.18.28',
      reason: 'opencode-ai@1.18.28 is available',
    }
    delete process.env.SYSTEMATIC_REQUIRE_OPENCODE
    expect(() => requireOpencodeAvailable(available)).not.toThrow()
    process.env.SYSTEMATIC_REQUIRE_OPENCODE = '1'
    expect(() => requireOpencodeAvailable(available)).not.toThrow()
  })

  test('a non-available classification throws only under SYSTEMATIC_REQUIRE_OPENCODE=1', () => {
    const unavailable: OpencodeAvailabilityClassification = {
      status: 'unavailable',
      expectedVersion: '1.18.28',
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
      expectedVersion: '1.18.28',
      reportedVersion: '1.18.99',
      reason:
        'expected opencode-ai@1.18.28 but bunx resolved opencode-ai@1.18.99',
    }
    delete process.env.SYSTEMATIC_REQUIRE_OPENCODE
    expect(() => requireOpencodeAvailable(mismatch)).not.toThrow()
    process.env.SYSTEMATIC_REQUIRE_OPENCODE = '1'
    expect(() => requireOpencodeAvailable(mismatch)).toThrow(
      /1\.18\.28.*1\.18\.99/,
    )
  })
})

describe('resolveBunInstallCacheDir', () => {
  test('creates a fresh temp root with mode 0700', () => {
    const tmpRoot = tempDir()
    try {
      const dir = resolveBunInstallCacheDir({ pin: '1.18.28', tmpRoot })
      const stats = fs.lstatSync(dir)
      expect(stats.isDirectory()).toBe(true)
      expect(stats.mode & 0o777).toBe(0o700)
      expect(path.basename(dir)).toContain('1.18.28')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('tightens a reused directory left at 0755 back to 0700', () => {
    const tmpRoot = tempDir()
    try {
      const first = resolveBunInstallCacheDir({ pin: '1.18.28', tmpRoot })
      fs.chmodSync(first, 0o755)
      expect(fs.lstatSync(first).mode & 0o777).toBe(0o755)

      const second = resolveBunInstallCacheDir({ pin: '1.18.28', tmpRoot })
      expect(second).toBe(first)
      expect(fs.lstatSync(second).mode & 0o777).toBe(0o700)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('refuses a directory owned by a foreign uid (stubbed lstatSync)', () => {
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
        resolveBunInstallCacheDir({ pin: '1.18.28', tmpRoot }),
      ).toThrow(/owned by uid/)
    } finally {
      spy.mockRestore()
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('refuses a symlink (stubbed lstatSync)', () => {
    const tmpRoot = tempDir()
    const uid = process.getuid?.() ?? 0
    const spy = spyOn(fs, 'lstatSync').mockReturnValue(
      fakeStats({
        isSymbolicLink: true,
        isDirectory: false,
        uid,
        mode: 0o700,
      }),
    )
    try {
      expect(() =>
        resolveBunInstallCacheDir({ pin: '1.18.28', tmpRoot }),
      ).toThrow(/symlink/)
    } finally {
      spy.mockRestore()
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('does not memoize across calls in one process', () => {
    const tmpRoot = tempDir()
    const uid = process.getuid?.() ?? 0
    try {
      // Real call succeeds and creates the directory for real.
      resolveBunInstallCacheDir({ pin: '1.18.28', tmpRoot })

      // Stub a foreign-uid owner: the very next call must still throw,
      // proving nothing was cached from the prior successful call.
      const spy = spyOn(fs, 'lstatSync').mockReturnValue(
        fakeStats({
          isSymbolicLink: false,
          isDirectory: true,
          uid: uid + 1,
          mode: 0o700,
        }),
      )
      expect(() =>
        resolveBunInstallCacheDir({ pin: '1.18.28', tmpRoot }),
      ).toThrow()
      spy.mockRestore()

      // And the call after that, once the stub is gone, must succeed again.
      expect(() =>
        resolveBunInstallCacheDir({ pin: '1.18.28', tmpRoot }),
      ).not.toThrow()
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
