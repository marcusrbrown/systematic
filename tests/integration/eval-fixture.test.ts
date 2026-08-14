import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createOpencodeProbe,
  startScriptedModelServer,
} from '../../scripts/eval-cases/opencode.ts'
import {
  assertEvalPathContained,
  buildEvalChildEnv,
  capturePrimaryCheckout,
  cleanupEvalFixture,
  createEvalFixture,
  type EvalFixture,
} from '../../scripts/run-evals.ts'

function fixtureOptions(parentDir: string, runId: string) {
  return {
    caseId: 'bootstrap-loading' as const,
    mode: 'source' as const,
    runId,
    parentDir,
  }
}

function controlledPaths(fixture: EvalFixture): string[] {
  return [
    fixture.runRoot,
    fixture.caseRoot,
    fixture.modeRoot,
    fixture.projectRoot,
    fixture.homeRoot,
    fixture.xdgConfigRoot,
    fixture.xdgDataRoot,
    fixture.xdgCacheRoot,
    fixture.xdgStateRoot,
    fixture.opencodeConfigRoot,
    fixture.probeRoot,
    fixture.npmCacheRoot,
    fixture.packageRoot,
    fixture.provenanceRoot,
    fixture.tmpRoot,
  ]
}

describe('eval fixture isolation', () => {
  test('creates unique roots and keeps every controlled canonical path inside its run root', () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'eval-fixture-test-'),
    )
    const first = createEvalFixture(fixtureOptions(parentDir, 'fixture-a'))
    const second = createEvalFixture(fixtureOptions(parentDir, 'fixture-b'))

    try {
      expect(first.runRoot).not.toBe(second.runRoot)
      expect(first.caseRoot).not.toBe(second.caseRoot)
      for (const fixture of [first, second]) {
        for (const controlledPath of controlledPaths(fixture)) {
          expect(() =>
            assertEvalPathContained(fixture.runRoot, controlledPath),
          ).not.toThrow()
        }
      }
    } finally {
      cleanupEvalFixture(first)
      cleanupEvalFixture(second)
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('builds an explicit child env without seeded parent auth or config values', () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-env-test-'))
    const fixture = createEvalFixture(fixtureOptions(parentDir, 'env'))
    const parentHome = path.join(parentDir, 'parent-home')
    const parentConfig = path.join(parentDir, 'parent-config')
    fs.mkdirSync(path.join(parentHome, '.ssh'), { recursive: true })
    fs.mkdirSync(parentConfig, { recursive: true })
    fs.writeFileSync(path.join(parentHome, '.npmrc'), 'fake npm auth file')
    fs.writeFileSync(
      path.join(parentHome, '.ssh', 'agent.sock'),
      'fake ssh socket placeholder',
    )
    fs.writeFileSync(path.join(parentConfig, 'auth.json'), 'fake opencode auth')

    const fakeValue = 'fake-gh-token-value'
    const parentEnv: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      GH_TOKEN: fakeValue,
      GITHUB_TOKEN: fakeValue,
      NPM_TOKEN: fakeValue,
      npm_config_userconfig: path.join(parentHome, '.npmrc'),
      OPENAI_API_KEY: fakeValue,
      AWS_SECRET_ACCESS_KEY: fakeValue,
      SSH_AUTH_SOCK: path.join(parentHome, '.ssh', 'agent.sock'),
      GIT_ASKPASS: 'fake-git-askpass',
      OPENCODE_AUTH_TOKEN: fakeValue,
      HOME: parentHome,
      XDG_CONFIG_HOME: parentConfig,
      XDG_DATA_HOME: path.join(parentDir, 'parent-data'),
      XDG_CACHE_HOME: path.join(parentDir, 'parent-cache'),
      XDG_STATE_HOME: path.join(parentDir, 'parent-state'),
    }

    try {
      const childEnv = buildEvalChildEnv({
        fixture,
        configContent: '{}',
        modelBaseUrl: 'http://127.0.0.1:1/v1',
        parentEnv,
      })

      for (const key of [
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'NPM_TOKEN',
        'npm_config_userconfig',
        'OPENAI_API_KEY',
        'AWS_SECRET_ACCESS_KEY',
        'SSH_AUTH_SOCK',
        'GIT_ASKPASS',
        'OPENCODE_AUTH_TOKEN',
      ]) {
        expect(childEnv[key]).toBeUndefined()
      }
      expect(childEnv.HOME).toBe(fixture.homeRoot)
      expect(childEnv.XDG_CONFIG_HOME).toBe(fixture.xdgConfigRoot)
      expect(childEnv.XDG_DATA_HOME).toBe(fixture.xdgDataRoot)
      expect(childEnv.XDG_CACHE_HOME).toBe(fixture.xdgCacheRoot)
      expect(childEnv.XDG_STATE_HOME).toBe(fixture.xdgStateRoot)
      expect(childEnv.NPM_CONFIG_CACHE).toBe(fixture.npmCacheRoot)
      expect(childEnv.OPENCODE_CONFIG_DIR).toBe(fixture.opencodeConfigRoot)
      expect(childEnv.EVAL_MODEL_BASE_URL).toBe('http://127.0.0.1:1/v1')

      const inspection = spawnSync(
        process.execPath,
        [
          '-e',
          `const forbidden = ${JSON.stringify([
            'GH_TOKEN',
            'GITHUB_TOKEN',
            'NPM_TOKEN',
            'OPENAI_API_KEY',
            'AWS_SECRET_ACCESS_KEY',
            'SSH_AUTH_SOCK',
            'GIT_ASKPASS',
            'OPENCODE_AUTH_TOKEN',
          ])}; const names = Object.keys(process.env); console.log(JSON.stringify({ forbiddenNames: forbidden.filter((key) => names.includes(key)), fakeValue: Object.values(process.env).includes(${JSON.stringify(fakeValue)}), home: process.env.HOME }));`,
        ],
        { cwd: fixture.projectRoot, env: childEnv, encoding: 'utf8' },
      )
      expect(inspection.status).toBe(0)
      const observed = JSON.parse(inspection.stdout) as {
        forbiddenNames: string[]
        fakeValue: boolean
        home: string
      }
      expect(observed).toEqual({
        forbiddenNames: [],
        fakeValue: false,
        home: fixture.homeRoot,
      })
    } finally {
      cleanupEvalFixture(fixture)
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('fails closed on canonical symlink/path escape attempts', () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-path-test-'))
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-outside-'))
    const fixture = createEvalFixture(fixtureOptions(parentDir, 'path'))
    const escapeLink = path.join(fixture.runRoot, 'escape-link')
    fs.symlinkSync(outsideDir, escapeLink, 'dir')

    try {
      expect(() =>
        assertEvalPathContained(fixture.runRoot, escapeLink),
      ).toThrow('eval-path:path_escape')
      expect(() =>
        assertEvalPathContained(fixture.runRoot, path.join(escapeLink, 'file')),
      ).toThrow('eval-path:path_escape')
    } finally {
      cleanupEvalFixture(fixture)
      fs.rmSync(outsideDir, { recursive: true, force: true })
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('always permits explicit cleanup of probe, model, and fixture resources', async () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'eval-cleanup-test-'),
    )
    const fixture = createEvalFixture(fixtureOptions(parentDir, 'cleanup'))
    const probe = createOpencodeProbe(fixture)
    const model = startScriptedModelServer([])

    expect(fs.existsSync(fixture.runRoot)).toBe(true)
    expect(fs.existsSync(probe.capturePath)).toBe(false)
    await model.stop()
    cleanupEvalFixture(fixture)

    expect(fs.existsSync(fixture.runRoot)).toBe(false)
    expect(fs.existsSync(probe.capturePath)).toBe(false)
    fs.rmSync(parentDir, { recursive: true, force: true })
  })

  test('primary checkout identity is unchanged by fixture setup and cleanup', () => {
    const before = capturePrimaryCheckout()
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-git-test-'))
    const fixture = createEvalFixture(fixtureOptions(parentDir, 'git'))

    try {
      expect(capturePrimaryCheckout()).toEqual(before)
    } finally {
      cleanupEvalFixture(fixture)
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
    expect(capturePrimaryCheckout()).toEqual(before)
  })
})
