// Unit 5b (packaged execution): proves the pr-attachments skill and its
// builtin-only Node helper (`skills/pr-attachments/scripts/pr-attachments.mjs`)
// are registered in the OCX registry and actually run -- not just exist --
// from every distributed shape a consumer can reach them through: an OCX
// file selection, a real `npm pack` archive, and the generated Claude Code
// plugin bundle. Also pins that nothing under `docs/evidence/` ships.
//
// The helper is invoked as `node "$SKILL_DIR/scripts/pr-attachments.mjs"`
// (see SKILL.md), so the file mode bit is not part of the contract; the
// shebang and the "no relative imports" rule are. The executed operation is
// `urls`, a pure stdin->stdout parse that never touches git or the network.
//
// Ownership boundary: exercises existing generator and helper behavior only.
// It adds no production code. Negative controls corrupt a temp COPY, never
// real source.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import {
  generatePluginFiles,
  writePluginFiles,
} from '../../scripts/build-claude-code-plugin.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const REGISTRY_PATH = path.join(REPO_ROOT, 'registry/registry.jsonc')

const SKILL_NAME = 'pr-attachments'
const SKILL_MD_REL = 'skills/pr-attachments/SKILL.md'
const HELPER_REL = 'skills/pr-attachments/scripts/pr-attachments.mjs'
const HELPER_SRC = path.join(REPO_ROOT, HELPER_REL)

// ── Real Node binary, resolved before any environment mutation ─────────────
//
// `process.execPath` under `bun test` is the Bun binary, so it must never
// launch these subprocesses.

const nodeProbe = spawnSync('node', ['-p', 'process.execPath'], {
  encoding: 'utf8',
})
if (nodeProbe.status !== 0 || !nodeProbe.stdout.trim()) {
  throw new Error(
    'fixture setup failed: `node -p process.execPath` did not resolve a Node binary',
  )
}
const NODE_BIN = nodeProbe.stdout.trim()

const bunCheck = spawnSync(NODE_BIN, ['-p', "typeof Bun === 'undefined'"], {
  encoding: 'utf8',
})
if (bunCheck.status !== 0 || bunCheck.stdout.trim() !== 'true') {
  throw new Error(
    'resolved Node binary appears to be Bun, not a real Node runtime -- refusing to run packaging checks against it',
  )
}

// ── Shared fixture plumbing ─────────────────────────────────────────────

const TEMP_DIRS: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  TEMP_DIRS.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value)) {
    throw new Error(`expected JSON object output, got: ${raw}`)
  }
  return value
}

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs the helper with a JSON body on stdin, in an isolated temp cwd. */
function runHelper(
  helperPath: string,
  operation: string,
  stdin: string,
): RunResult {
  const result = spawnSync(NODE_BIN, [helperPath, operation], {
    cwd: makeTempDir('pr-attachments-packaging-cwd-'),
    encoding: 'utf8',
    input: stdin,
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

/** One non-managed image URL: `urls` reports it as ignored, touching nothing. */
const URLS_INPUT = JSON.stringify({
  body: 'Hello\n![a](https://example.com/x.png)\n',
  head_repo: 'octo/repo',
})

function expectUrlsOperationRuns(helperPath: string): void {
  expect(fs.existsSync(helperPath)).toBe(true)
  const run = runHelper(helperPath, 'urls', URLS_INPUT)
  expect(run.exitCode).toBe(0)
  const response = parseJsonRecord(run.stdout)
  expect(response.operation).toBe('urls')
  expect(response.result).toBe('urls')
  expect(response.urls).toEqual([])
  expect(response.ignored).toBe(1)
}

// ── Registry (OCX) component reading -- no `as` casts, runtime-narrowed ────

interface RegistryComponent {
  readonly name: string
  readonly type: string
  readonly files?: readonly string[]
}

function toRegistryComponent(value: unknown): RegistryComponent | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.name !== 'string' || typeof value.type !== 'string') {
    return undefined
  }
  const files = isStringArray(value.files) ? value.files : undefined
  return { files, name: value.name, type: value.type }
}

function readRegistryComponents(): RegistryComponent[] {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8')
  const parsed: unknown = parseJsonc(raw)
  if (!isRecord(parsed) || !Array.isArray(parsed.components)) {
    throw new Error(
      'registry.jsonc did not parse into the expected { components: [] } shape',
    )
  }
  const components: RegistryComponent[] = []
  for (const entry of parsed.components) {
    const component = toRegistryComponent(entry)
    if (component) components.push(component)
  }
  return components
}

function findComponent(name: string): RegistryComponent {
  const component = readRegistryComponents().find((c) => c.name === name)
  if (!component) {
    throw new Error(`registry component "${name}" not found`)
  }
  return component
}

function copyDeclaredFiles(destRoot: string, files: readonly string[]): void {
  for (const relPath of files) {
    const dest = path.join(destRoot, relPath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(REPO_ROOT, relPath), dest)
  }
}

function walkFiles(root: string, relDir = ''): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, relDir), {
    withFileTypes: true,
  })) {
    const rel = path.posix.join(relDir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(root, rel))
    else out.push(rel)
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════
// Precondition: real source shape (grounds the negative controls -- if the
// real helper already had a relative import, "introducing" one in a copy
// would prove nothing).
// ═══════════════════════════════════════════════════════════════════════

describe('helper source shape (precondition for negative controls)', () => {
  test('has a preserved shebang and no relative, require, or TypeScript-source imports', () => {
    const src = fs.readFileSync(HELPER_SRC, 'utf8')
    expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(src).not.toMatch(/from\s+['"]\.\.?\//)
    expect(src).not.toMatch(/\bimport\s*\(\s*['"]\.\.?\//)
    expect(src).not.toMatch(/require\(/)
    expect(src).not.toMatch(/from\s+['"][^'"]*\.ts['"]/)
  })

  test('every static import is a node: builtin', () => {
    const src = fs.readFileSync(HELPER_SRC, 'utf8')
    const specifiers = [...src.matchAll(/^\s*}?\s*from\s+['"]([^'"]+)['"]/gm)]
    const importLines = [...src.matchAll(/^import\s+['"]([^'"]+)['"]/gm)]
    const all = [...specifiers, ...importLines].map((m) => m[1] ?? '')
    expect(all.length).toBeGreaterThan(0)
    for (const specifier of all) {
      expect(specifier).toMatch(/^node:/)
    }
  })

  test('SKILL.md invokes the helper through node, so the file mode bit is not part of the contract', () => {
    const skill = fs.readFileSync(path.join(REPO_ROOT, SKILL_MD_REL), 'utf8')
    expect(skill).toContain('node "$SKILL_DIR/scripts/pr-attachments.mjs"')
    expect(skill).not.toMatch(
      /^\s*"?\$SKILL_DIR\/scripts\/pr-attachments\.mjs/m,
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Channel 1: OCX file selection (pr-attachments component)
// ═══════════════════════════════════════════════════════════════════════

describe('OCX file selection (pr-attachments component)', () => {
  test('registry lists the skill and its helper, and nothing under docs/evidence', () => {
    const component = findComponent(SKILL_NAME)
    expect(component.type).toBe('skill')
    expect(component.files ?? []).toContain(SKILL_MD_REL)
    expect(component.files ?? []).toContain(HELPER_REL)
    for (const file of component.files ?? []) {
      expect(file).not.toMatch(/(^|\/)docs\/evidence(\/|$)/)
    }
  })

  test('copying only the manifest-declared files runs the helper for real', () => {
    const component = findComponent(SKILL_NAME)
    if (!component.files) throw new Error('pr-attachments declares no files')
    const consumerRoot = makeTempDir('ocx-pr-attachments-')
    copyDeclaredFiles(consumerRoot, component.files)
    expectUrlsOperationRuns(path.join(consumerRoot, HELPER_REL))
  })

  test('negative control: a registry entry missing the helper loses it from the copied tree, and invoking the missing path fails loudly', () => {
    const component = findComponent(SKILL_NAME)
    if (!component.files) throw new Error('pr-attachments declares no files')
    const driftedFiles = component.files.filter((f) => f !== HELPER_REL)
    expect(driftedFiles.length).toBeLessThan(component.files.length)

    const consumerRoot = makeTempDir('ocx-pr-attachments-drifted-')
    copyDeclaredFiles(consumerRoot, driftedFiles)
    const missingHelperPath = path.join(consumerRoot, HELPER_REL)
    expect(fs.existsSync(missingHelperPath)).toBe(false)

    const run = runHelper(missingHelperPath, 'urls', URLS_INPUT)
    expect(run.exitCode).not.toBe(0)
    expect(run.stderr).toMatch(/Cannot find module|ENOENT/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Channel 2: real `npm pack` archive, extracted once and reused
// ═══════════════════════════════════════════════════════════════════════

describe('npm-packed archive: real execution from an extracted, isolated copy', () => {
  let extractDir: string

  beforeAll(() => {
    const packDestDir = makeTempDir('pr-attachments-packaging-npmpack-')
    const pack = spawnSync(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--pack-destination',
        packDestDir,
        '--silent',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 },
    )
    if (pack.status !== 0) {
      throw new Error(`npm pack failed (exit ${pack.status})\n${pack.stderr}`)
    }
    const tarballName = pack.stdout.trim().split('\n').at(-1)
    if (!tarballName) {
      throw new Error('npm pack produced no tarball filename')
    }

    extractDir = makeTempDir('pr-attachments-packaging-npmextract-')
    const extract = spawnSync(
      'tar',
      ['xzf', path.join(packDestDir, tarballName), '-C', extractDir],
      { timeout: 30_000 },
    )
    if (extract.status !== 0) {
      throw new Error(
        `tar extraction failed: ${extract.stderr?.toString() ?? ''}`,
      )
    }
  }, 120_000)

  test('package.json `files` ships the skills tree and not docs', () => {
    const pkg = parseJsonRecord(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    )
    if (!isStringArray(pkg.files)) {
      throw new Error('expected package.json files to be a string array')
    }
    expect(pkg.files).toContain('skills')
    for (const entry of pkg.files) {
      expect(entry).not.toMatch(/^\.?\/?docs(\/|$)/)
    }
  })

  test('tarball contains the skill and its helper at their shipped relative paths', () => {
    expect(fs.existsSync(path.join(extractDir, 'package', SKILL_MD_REL))).toBe(
      true,
    )
    const shipped = fs.readFileSync(
      path.join(extractDir, 'package', HELPER_REL),
    )
    expect(shipped.equals(fs.readFileSync(HELPER_SRC))).toBe(true)
  })

  test('nothing under docs/evidence ships in the tarball', () => {
    const shipped = walkFiles(path.join(extractDir, 'package'))
    expect(shipped.length).toBeGreaterThan(0)
    expect(shipped.filter((f) => /(^|\/)docs\/evidence(\/|$)/.test(f))).toEqual(
      [],
    )
  })

  test('packaged helper runs from the extracted archive', () => {
    expectUrlsOperationRuns(path.join(extractDir, 'package', HELPER_REL))
  })

  test('Pi skill-relative discovery resolves the helper from the same extracted tarball (does not claim a real Pi host was exercised)', () => {
    const pkg = parseJsonRecord(
      fs.readFileSync(path.join(extractDir, 'package/package.json'), 'utf8'),
    )
    if (!isRecord(pkg.pi)) {
      throw new Error('expected package.json pi manifest object')
    }
    expect(isStringArray(pkg.pi.skills) ? pkg.pi.skills : []).toContain(
      './skills',
    )
    // Same anchor the SKILL.md uses: "$SKILL_DIR/scripts/pr-attachments.mjs".
    const viaAnchor = path.join(
      extractDir,
      'package/skills/pr-attachments',
      'scripts/pr-attachments.mjs',
    )
    expectUrlsOperationRuns(viaAnchor)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Channel 3: Claude Code generated bundle -- generated exactly once
// ═══════════════════════════════════════════════════════════════════════

describe('Claude Code packaged bytes and execution (single generated fixture)', () => {
  let outDir: string

  beforeAll(() => {
    const placeholderValidatorBundle = Buffer.from(
      'placeholder validator bundle',
    )
    const files = generatePluginFiles(REPO_ROOT, placeholderValidatorBundle)
    outDir = makeTempDir('pr-attachments-packaging-cc-')
    writePluginFiles(files, outDir)
  }, 60_000)

  test('the bundle contains the skill, whose name resolves under the systematic plugin namespace', () => {
    const skillPath = path.join(outDir, SKILL_MD_REL)
    expect(fs.existsSync(skillPath)).toBe(true)
    const frontmatter = fs
      .readFileSync(skillPath, 'utf8')
      .match(/^---\n([\s\S]*?)\n---\n/)
    expect(frontmatter?.[1]).toMatch(/^name: pr-attachments$/m)

    // Claude Code namespaces a plugin skill as `<plugin name>:<skill name>`.
    const manifest = parseJsonRecord(
      fs.readFileSync(path.join(outDir, '.claude-plugin/plugin.json'), 'utf8'),
    )
    expect(`${manifest.name}:${SKILL_NAME}`).toBe('systematic:pr-attachments')
  })

  test('the helper is byte-identical to source (namespace translation never touches .mjs)', () => {
    const generated = fs.readFileSync(path.join(outDir, HELPER_REL))
    expect(generated.equals(fs.readFileSync(HELPER_SRC))).toBe(true)
  })

  test('the generated bundle executes the helper for real from the written output tree', () => {
    expectUrlsOperationRuns(path.join(outDir, HELPER_REL))
  })

  test('nothing under docs/evidence is in the bundle', () => {
    const shipped = walkFiles(outDir)
    expect(shipped.length).toBeGreaterThan(0)
    expect(shipped.filter((f) => /(^|\/)docs\/evidence(\/|$)/.test(f))).toEqual(
      [],
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Negative controls: corrupt a distributed COPY only, never real source.
// ═══════════════════════════════════════════════════════════════════════

describe('negative controls: distributed-copy corruption (never mutates real source)', () => {
  test('removing the helper from a distributed copy makes invocation fail loudly, not silently pass', () => {
    const component = findComponent(SKILL_NAME)
    if (!component.files) throw new Error('pr-attachments declares no files')
    const consumerRoot = makeTempDir('negative-pr-attachments-removed-')
    copyDeclaredFiles(consumerRoot, component.files)
    const helperPath = path.join(consumerRoot, HELPER_REL)
    // Control: runnable before removal.
    expectUrlsOperationRuns(helperPath)

    fs.rmSync(helperPath)
    const after = runHelper(helperPath, 'urls', URLS_INPUT)
    expect(after.exitCode).not.toBe(0)
    expect(after.stderr).toMatch(/Cannot find module|ENOENT/)
  })

  test('an injected missing relative import after the shebang fails at module resolution, not at parse time', () => {
    const consumerRoot = makeTempDir('negative-pr-attachments-import-')
    const original = fs.readFileSync(HELPER_SRC, 'utf8')
    const shebangEnd = original.indexOf('\n') + 1
    const corrupted = `${original.slice(0, shebangEnd)}import { nothingHere } from './does-not-exist-negative-control.mjs'\n${original.slice(shebangEnd)}`
    const corruptedPath = path.join(consumerRoot, 'helper-corrupted.mjs')
    fs.writeFileSync(corruptedPath, corrupted)

    const corruptedRun = runHelper(corruptedPath, 'urls', URLS_INPUT)
    expect(corruptedRun.exitCode).not.toBe(0)
    expect(corruptedRun.stderr).toMatch(
      /ERR_MODULE_NOT_FOUND|Cannot find module/,
    )
    expect(corruptedRun.stderr).not.toMatch(/SyntaxError/)

    // Control: an unmodified copy parses and runs from the same directory.
    const cleanCopyPath = path.join(consumerRoot, 'helper-clean.mjs')
    fs.writeFileSync(cleanCopyPath, original)
    expectUrlsOperationRuns(cleanCopyPath)
  })
})
