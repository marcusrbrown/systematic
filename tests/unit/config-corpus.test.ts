/**
 * Back-compat corpus (R13): every entry under
 * tests/fixtures/config-corpus/ pins the canonical serialization of the
 * OpenCode agent config the config hook emits for a pre-change-style user
 * config. Asserts byte-identity of the canonical JSON, not deep equality,
 * so key-order and undefined-vs-absent drift fails the test.
 *
 * See tests/fixtures/config-corpus/README.md for how entries were built and
 * how the pre-change/post-change parity was proven (Unit 6, plan
 * 2026-09-04-002-feat-model-config-profiles).
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '@opencode-ai/sdk'
import { createConfigHandler } from '../../src/lib/config-handler.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const CORPUS_DIR = path.join(REPO_ROOT, 'tests/fixtures/config-corpus')

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry === undefined) continue
      result[key] = canonicalize(entry)
    }
    return result
  }
  return value
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}

async function runCorpusEntry(inputContent: string): Promise<string> {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-corpus-run-'))
  const homeDir = path.join(testDir, 'home')
  const projectDir = path.join(testDir, 'project')
  const commandsDir = path.join(testDir, 'commands')
  const originalHomedir = os.homedir
  const originalCustomDir = process.env.OPENCODE_CONFIG_DIR
  os.homedir = () => homeDir
  delete process.env.OPENCODE_CONFIG_DIR

  try {
    fs.mkdirSync(path.join(homeDir, '.config/opencode'), { recursive: true })
    fs.mkdirSync(projectDir, { recursive: true })
    fs.mkdirSync(commandsDir, { recursive: true })
    fs.writeFileSync(
      path.join(homeDir, '.config/opencode/systematic.jsonc'),
      inputContent,
    )

    const handler = createConfigHandler({
      directory: projectDir,
      bundledSkillsDir: path.join(REPO_ROOT, 'skills'),
      bundledAgentsDir: path.join(REPO_ROOT, 'agents'),
      bundledCommandsDir: commandsDir,
    })

    const config: Config = {}
    await handler(config)

    return canonicalJson(config.agent ?? {})
  } finally {
    os.homedir = originalHomedir
    if (originalCustomDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalCustomDir
    }
    fs.rmSync(testDir, { recursive: true, force: true })
  }
}

const entries = fs
  .readdirSync(CORPUS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

describe('config-corpus (back-compat, R13)', () => {
  test('corpus is non-empty', () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  for (const entryName of entries) {
    test(`${entryName} round-trips to its stored canonical serialization`, async () => {
      const entryDir = path.join(CORPUS_DIR, entryName)
      const inputContent = fs.readFileSync(
        path.join(entryDir, 'input.jsonc'),
        'utf8',
      )
      const expected = fs.readFileSync(
        path.join(entryDir, 'expected.opencode.json'),
        'utf8',
      )

      const actual = await runCorpusEntry(inputContent)

      expect(actual).toBe(expected)
    })
  }
})
