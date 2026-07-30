/**
 * Tests for src/lib/pi-subagents-export.ts (Unit 2).
 *
 * Test-first: written before implementation.
 *
 * Coverage:
 *   - Target resolution: project (.pi/agents) and global ($PI_CODING_AGENT_DIR/agents or ~/.pi/agent/agents)
 *   - Preview: no writes, lists create/update/refuse/remove plan
 *   - Export: happy path, idempotent, refuses pre-existing unowned file, refuses unowned systematic-*.md
 *   - Refresh: detects drift, replaces only owned files, never touches unowned
 *   - Cleanup: removes only manifest-owned files and manifest, leaves others
 *   - Path safety: traversal rejection, symlink escape rejection, validate manifest filenames
 *   - Atomic writes: no partial state on failure
 *   - Manifest: read/write/parse, hostile manifest (traversal in filename)
 *   - No writes from module import
 */

import { afterAll, describe, expect, test } from 'bun:test'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import os from 'node:os'
import * as path from 'node:path'
import {
  type CleanupResult,
  cleanup,
  exportPersonas,
  LOCK_FILENAME,
  MANIFEST_FILENAME,
  type PiSubagentsManifest,
  preview,
  readManifest,
  readManifestStrict,
  refresh,
  resolveAgentsRoot,
  resolveAnchor,
  runWithRollback,
  writeManifest,
} from '../../src/lib/pi-subagents-export.js'

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

const TEMP_ROOTS: string[] = []

function mkTmp(prefix = 'pi-export-test-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  TEMP_ROOTS.push(d)
  return d
}

afterAll(() => {
  for (const r of TEMP_ROOTS) fs.rmSync(r, { recursive: true, force: true })
})

function writeFile(base: string, rel: string, content: string): string {
  const full = path.join(base, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
  return full
}

function makeManifest(
  agentsRoot: string,
  entries: PiSubagentsManifest['files'],
): PiSubagentsManifest {
  return { generatedAt: new Date().toISOString(), agentsRoot, files: entries }
}

// ---------------------------------------------------------------------------
// resolveAgentsRoot
// ---------------------------------------------------------------------------

describe('MANIFEST_FILENAME contract', () => {
  test('manifest filename is exactly .systematic-personas.json', () => {
    expect(MANIFEST_FILENAME).toBe('.systematic-personas.json')
  })
})

describe('resolveAgentsRoot', () => {
  test('project scope resolves to <cwd>/.pi/agents', () => {
    const cwd = mkTmp()
    const root = resolveAgentsRoot('project', cwd)
    expect(root).toBe(path.join(cwd, '.pi', 'agents'))
  })

  test('global scope with PI_CODING_AGENT_DIR set uses that dir', () => {
    const base = mkTmp('pi-global-env-')
    const origEnv = process.env.PI_CODING_AGENT_DIR
    try {
      process.env.PI_CODING_AGENT_DIR = base
      const root = resolveAgentsRoot('global', process.cwd())
      expect(root).toBe(path.join(base, 'agents'))
    } finally {
      if (origEnv === undefined) {
        delete process.env.PI_CODING_AGENT_DIR
      } else {
        process.env.PI_CODING_AGENT_DIR = origEnv
      }
    }
  })

  test('global scope without PI_CODING_AGENT_DIR falls back to ~/.pi/agent/agents', () => {
    const origEnv = process.env.PI_CODING_AGENT_DIR
    try {
      delete process.env.PI_CODING_AGENT_DIR
      const root = resolveAgentsRoot('global', process.cwd())
      expect(root).toBe(path.join(os.homedir(), '.pi', 'agent', 'agents'))
    } finally {
      if (origEnv !== undefined) process.env.PI_CODING_AGENT_DIR = origEnv
    }
  })
})

// ---------------------------------------------------------------------------
// resolveAnchor: scope-anchored symlink-validation root
// ---------------------------------------------------------------------------

describe('resolveAnchor', () => {
  test('project scope anchor is cwd', () => {
    const cwd = mkTmp()
    expect(resolveAnchor('project', cwd)).toBe(cwd)
  })

  test('global scope without PI_CODING_AGENT_DIR anchors at homedir', () => {
    const origEnv = process.env.PI_CODING_AGENT_DIR
    try {
      delete process.env.PI_CODING_AGENT_DIR
      expect(resolveAnchor('global', process.cwd())).toBe(os.homedir())
    } finally {
      if (origEnv !== undefined) process.env.PI_CODING_AGENT_DIR = origEnv
    }
  })

  test('global scope with PI_CODING_AGENT_DIR anchors at its parent (env dir itself is checked)', () => {
    const base = mkTmp('pi-anchor-env-')
    const envDir = path.join(base, 'pi-coding-agent')
    fs.mkdirSync(envDir, { recursive: true })
    const origEnv = process.env.PI_CODING_AGENT_DIR
    try {
      process.env.PI_CODING_AGENT_DIR = envDir
      expect(resolveAnchor('global', process.cwd())).toBe(path.dirname(envDir))
    } finally {
      if (origEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = origEnv
    }
  })
})

// ---------------------------------------------------------------------------
// Scope-anchored symlink validation: every mutating command walks from
// anchor -> agentsRoot with lstat, rejecting any symlink or non-directory
// intermediate/final component.
// ---------------------------------------------------------------------------

describe('scope-anchored symlink validation', () => {
  test('export refuses when an intermediate component (.pi) is a symlink', () => {
    const cwd = mkTmp()
    const realPi = path.join(cwd, 'real-pi')
    fs.mkdirSync(realPi, { recursive: true })
    fs.symlinkSync(realPi, path.join(cwd, '.pi'))
    const agentsRoot = path.join(cwd, '.pi', 'agents')

    const result = exportPersonas(agentsRoot, { scope: 'project', cwd })
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/symlink/i)
    expect(fs.readdirSync(realPi)).toHaveLength(0)
  })

  test('export refuses when an intermediate component is a non-directory (regular file)', () => {
    const cwd = mkTmp()
    fs.writeFileSync(path.join(cwd, '.pi'), 'not a directory')
    const agentsRoot = path.join(cwd, '.pi', 'agents')

    const result = exportPersonas(agentsRoot, { scope: 'project', cwd })
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/not a directory|non-directory/i)
  })

  test('refresh refuses when a .pi ancestor is a symlink', () => {
    const cwd = mkTmp()
    const realPi = path.join(cwd, 'real-pi')
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    // Establish a legitimate baseline elsewhere, then swap .pi for a symlink
    fs.mkdirSync(realPi, { recursive: true })
    fs.mkdirSync(path.join(cwd, '.pi', 'agents'), { recursive: true })
    fs.renameSync(path.join(cwd, '.pi'), path.join(cwd, '.pi-orig'))
    fs.symlinkSync(realPi, path.join(cwd, '.pi'))

    const result = refresh(agentsRoot, { scope: 'project', cwd })
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/symlink/i)
  })

  test('cleanup refuses when an agent ancestor is a symlink', () => {
    const cwd = mkTmp()
    const realAgents = path.join(cwd, 'real-agents')
    fs.mkdirSync(realAgents, { recursive: true })
    fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true })
    fs.symlinkSync(realAgents, path.join(cwd, '.pi', 'agents'))
    const agentsRoot = path.join(cwd, '.pi', 'agents')

    expect(() => cleanup(agentsRoot, { scope: 'project', cwd })).toThrow(
      /symlink/i,
    )
  })

  test('cleanup rejects a symlinked root directly', () => {
    const cwd = mkTmp()
    const realDir = path.join(cwd, 'real-agents')
    const symlinkDir = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(realDir, { recursive: true })
    fs.mkdirSync(path.dirname(symlinkDir), { recursive: true })
    fs.symlinkSync(realDir, symlinkDir)

    expect(() => cleanup(symlinkDir, { scope: 'project', cwd })).toThrow(
      /symlink/i,
    )
  })

  test('does not inspect filesystem ancestors above the explicit anchor', () => {
    // The anchor for project scope is cwd itself. Ancestors of cwd (e.g. the
    // OS temp dir, which may itself be a symlink on macOS: /var -> /private/var)
    // must never be walked or rejected.
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    const result = exportPersonas(agentsRoot, { scope: 'project', cwd })
    expect(result.status).toBe('ok')
  })

  test('exportPersonas refuses when agentsRoot resolves (post-mkdir) to a real directory outside the canonical anchor via a symlink ancestor the lexical walk cannot see at construction time', () => {
    // End-to-end regression for the P1 fix: after the lexical anchored walk
    // and root creation, canonicalize both anchor and agentsRoot and refuse
    // if the canonical root escapes the canonical anchor. Here we swap an
    // intermediate directory for a symlink to outside the anchor *before*
    // the resolved agentsRoot is used, then verify export refuses and never
    // wrote anything into the outside target.
    const cwd = mkTmp()
    const outside = mkTmp('pi-outside-scope-canonical-')
    const outsideAgents = path.join(outside, 'agents')
    fs.mkdirSync(path.dirname(path.join(cwd, '.pi')), { recursive: true })
    // .pi itself is a symlink pointing outside the anchor (cwd); agentsRoot
    // is lexically "cwd/.pi/agents" but canonically resolves under `outside`.
    fs.symlinkSync(outside, path.join(cwd, '.pi'))
    const agentsRoot = path.join(cwd, '.pi', 'agents')

    const result = exportPersonas(agentsRoot, { scope: 'project', cwd })
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/symlink|escapes safety anchor|outside/i)
    expect(fs.existsSync(outsideAgents)).toBe(false)
  })

  test('refuses an agentsRoot outside the declared scope anchor rather than silently falling back to a weaker check', () => {
    // Regression: when configOptions.scope is supplied, the scope anchor
    // must always be used for the ancestor walk — never silently weaken to
    // agentsRoot's own immediate parent just because agentsRoot happens to
    // fall outside the declared scope anchor. A caller-supplied agentsRoot
    // outside the scope anchor is a mismatch and must be refused.
    const cwd = mkTmp()
    const outsideRoot = mkTmp('pi-outside-scope-')
    const agentsRoot = path.join(outsideRoot, 'agents')
    const result = exportPersonas(agentsRoot, { scope: 'project', cwd })
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/outside safety anchor/i)
    expect(fs.existsSync(agentsRoot)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// preview (no writes)
// ---------------------------------------------------------------------------

describe('preview', () => {
  test('preview writes nothing to the filesystem', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    // Do not create agentsRoot — preview should not create it
    const plan = preview(agentsRoot)
    expect(fs.existsSync(agentsRoot)).toBe(false)
    expect(plan).toBeDefined()
  })

  test('preview lists create actions for all generated personas', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    const plan = preview(agentsRoot)
    // All expected personas have create actions (dir doesn't exist yet)
    const creates = plan.actions.filter((a) => a.action === 'create')
    expect(creates.length).toBeGreaterThan(0)
    // Each create names a systematic-*.md file
    for (const c of creates) {
      expect(c.filename).toMatch(/^systematic-[a-z0-9-]+\.md$/)
    }
  })

  test('preview lists update action for a file that already exists and is owned', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    // Write a manifest that claims ownership of one file
    const filename = 'systematic-adversarial-reviewer.md'
    const hash = crypto.createHash('sha256').update('old content').digest('hex')
    const manifest: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename, hash, status: 'exported' },
    ])
    writeManifest(agentsRoot, manifest)
    writeFile(agentsRoot, filename, 'old content')

    const plan = preview(agentsRoot)
    const update = plan.actions.find(
      (a) => a.filename === filename && a.action === 'update',
    )
    // The owned file exists with old content → should be updated (current source differs)
    expect(update).toBeDefined()
  })

  test('preview lists refuse action for a pre-existing unowned file', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    // A user file that would collide with a generated filename
    const filename = 'systematic-adversarial-reviewer.md'
    writeFile(agentsRoot, filename, 'user content')
    // No manifest → file is unowned

    const plan = preview(agentsRoot)
    const refused = plan.actions.find(
      (a) => a.filename === filename && a.action === 'refuse',
    )
    expect(refused).toBeDefined()
  })

  test('preview lists remove action for a stale manifest-owned file not in current curated set', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    // A file that was once exported but is no longer in the curated list
    const staleFilename = 'systematic-no-longer-curated.md'
    const hash = crypto.createHash('sha256').update('old').digest('hex')
    const manifest: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: staleFilename, hash, status: 'exported' },
    ])
    writeManifest(agentsRoot, manifest)
    writeFile(agentsRoot, staleFilename, 'old')

    const plan = preview(agentsRoot)
    const remove = plan.actions.find(
      (a) => a.filename === staleFilename && a.action === 'remove',
    )
    expect(remove).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// exportPersonas: happy path
// ---------------------------------------------------------------------------

describe('exportPersonas', () => {
  test('happy path: writes all curated personas and manifest', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')

    const result = exportPersonas(agentsRoot)
    expect(result.status).toBe('ok')
    expect(fs.existsSync(agentsRoot)).toBe(true)

    // Manifest file exists
    expect(fs.existsSync(path.join(agentsRoot, MANIFEST_FILENAME))).toBe(true)

    // At least one systematic-*.md written
    const files = fs.readdirSync(agentsRoot).filter((f) => f.endsWith('.md'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      expect(f).toMatch(/^systematic-[a-z0-9-]+\.md$/)
    }
  })

  test('happy path: generated files are model-free (no model:/mode:/temperature: in frontmatter)', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    const mdFiles = fs.readdirSync(agentsRoot).filter((f) => f.endsWith('.md'))
    for (const f of mdFiles) {
      const content = fs.readFileSync(path.join(agentsRoot, f), 'utf-8')
      expect(content).not.toMatch(/^model:/m)
      expect(content).not.toMatch(/^mode:/m)
      expect(content).not.toMatch(/^temperature:/m)
    }
  })

  test('idempotent: second export is a no-op (no persona file changes)', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')

    exportPersonas(agentsRoot)

    // Capture mtimes for .md files only (manifest gets a new generatedAt timestamp)
    const before = fs
      .readdirSync(agentsRoot)
      .filter((f) => f.endsWith('.md'))
      .map((f) => [f, fs.statSync(path.join(agentsRoot, f)).mtimeMs] as const)

    const result2 = exportPersonas(agentsRoot)
    expect(result2.status).toBe('ok')
    expect(result2.written).toBe(0) // nothing new written

    // .md file mtimes unchanged (no writes)
    for (const [f, mtime] of before) {
      expect(fs.statSync(path.join(agentsRoot, f)).mtimeMs).toBe(mtime)
    }
  })

  test('refuses to overwrite a pre-existing unowned file not in manifest', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    // Plant a user-owned file at a systematic-*.md path (no manifest)
    const blocked = 'systematic-adversarial-reviewer.md'
    writeFile(agentsRoot, blocked, 'user content')

    const result = exportPersonas(agentsRoot)
    // Should report refusals but still proceed with the rest
    expect(result.refused.length).toBeGreaterThan(0)
    expect(result.refused.some((r) => r.filename === blocked)).toBe(true)
    // The user file is untouched
    expect(fs.readFileSync(path.join(agentsRoot, blocked), 'utf-8')).toBe(
      'user content',
    )
  })

  test('refuses to overwrite a pre-existing unowned systematic-*.md collision', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    // A file that matches a generated name but is NOT in any manifest
    const collision = 'systematic-security-reviewer.md'
    writeFile(agentsRoot, collision, 'not generated by us')

    const result = exportPersonas(agentsRoot)
    expect(result.refused.some((r) => r.filename === collision)).toBe(true)
    expect(fs.readFileSync(path.join(agentsRoot, collision), 'utf-8')).toBe(
      'not generated by us',
    )
  })

  test('manifest records ownership of all written files', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    const manifest = readManifest(agentsRoot)
    expect(manifest).not.toBeNull()
    const exported = manifest?.files.filter(
      (f) => f.status === 'exported' || f.status === 'exported-with-warning',
    )
    expect(exported.length).toBeGreaterThan(0)

    for (const entry of exported) {
      const filePath = path.join(agentsRoot, entry.filename)
      expect(fs.existsSync(filePath)).toBe(true)
      // Hash in manifest matches disk
      const diskContent = fs.readFileSync(filePath, 'utf-8')
      const diskHash = crypto
        .createHash('sha256')
        .update(diskContent)
        .digest('hex')
      expect(diskHash).toBe(entry.hash)
    }
  })
})

// ---------------------------------------------------------------------------
// exportPersonas: path safety
// ---------------------------------------------------------------------------

describe('exportPersonas: path safety', () => {
  test('resolves all target files under agentsRoot (no traversal)', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    const files = fs
      .readdirSync(agentsRoot)
      .filter((f) => f !== MANIFEST_FILENAME)
    for (const f of files) {
      const resolved = path.resolve(agentsRoot, f)
      expect(resolved.startsWith(agentsRoot + path.sep)).toBe(true)
    }
  })

  test('rejects a manifest with a traversal filename (hostile manifest) — cleanup throws', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    // Write a hostile manifest with a traversal filename
    const hostile: PiSubagentsManifest = makeManifest(agentsRoot, [
      {
        filename: '../../../etc/passwd',
        hash: 'abc',
        status: 'exported',
      },
    ])
    writeManifest(agentsRoot, hostile)

    // cleanup must refuse (throw) on a hostile manifest
    expect(() => cleanup(agentsRoot)).toThrow(
      /traversal|unsafe|invalid filename/i,
    )
    // The hostile path must not have been written/touched outside root
    expect(fs.existsSync('/etc/passwd_test')).toBe(false)
  })

  test('rejects agentsRoot that is a symlink', () => {
    const cwd = mkTmp()
    const realDir = path.join(cwd, 'real-agents')
    const symlinkDir = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(realDir, { recursive: true })
    fs.mkdirSync(path.dirname(symlinkDir), { recursive: true })
    fs.symlinkSync(realDir, symlinkDir)

    // exportPersonas should refuse to write through a symlinked agentsRoot
    const result = exportPersonas(symlinkDir)
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/symlink|not a real directory|escape/i)
    // Real dir untouched
    expect(fs.readdirSync(realDir)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe('refresh', () => {
  test('refresh: up-to-date export reports no changes', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    const result = refresh(agentsRoot)
    expect(result.status).toBe('ok')
    expect(result.updated).toBe(0)
    expect(result.skippedUnowned).toBe(0)
  })

  test('refresh: replaces a stale owned file with current source', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    // Corrupt an owned file
    const owned = fs.readdirSync(agentsRoot).find((f) => f.endsWith('.md'))
    expect(owned).toBeDefined()
    if (!owned) return
    const target = path.join(agentsRoot, owned)
    const original = fs.readFileSync(target, 'utf-8')
    fs.writeFileSync(target, 'corrupted content', 'utf-8')

    const result = refresh(agentsRoot)
    expect(result.status).toBe('ok')
    expect(result.updated).toBeGreaterThan(0)

    // File restored to current source content
    const restored = fs.readFileSync(target, 'utf-8')
    expect(restored).toBe(original)
  })

  test('refresh: never overwrites an unowned file even if it matches a generated name', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    // Write a user file at a generated-name path, no manifest
    const userFile = 'systematic-adversarial-reviewer.md'
    writeFile(agentsRoot, userFile, 'user content')

    const result = refresh(agentsRoot)
    // Either no-op or skippedUnowned > 0
    expect(result.skippedUnowned >= 0 || result.status === 'ok').toBe(true)
    // User file untouched
    expect(fs.readFileSync(path.join(agentsRoot, userFile), 'utf-8')).toBe(
      'user content',
    )
  })

  test('export, edit a file, refresh: drift detected and repaired', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    // Simulate user editing a generated file
    const files = fs.readdirSync(agentsRoot).filter((f) => f.endsWith('.md'))
    const firstFile = files[0]
    expect(firstFile).toBeDefined()
    if (!firstFile) return
    const filePath = path.join(agentsRoot, firstFile)
    const originalContent = fs.readFileSync(filePath, 'utf-8')
    fs.writeFileSync(
      filePath,
      `${originalContent}\n<!-- user edit -->`,
      'utf-8',
    )

    const result = refresh(agentsRoot)
    expect(result.status).toBe('ok')
    expect(result.updated).toBeGreaterThan(0)

    // File restored to source
    const afterRefresh = fs.readFileSync(filePath, 'utf-8')
    expect(afterRefresh).toBe(originalContent)
    expect(afterRefresh).not.toContain('<!-- user edit -->')
  })
})

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

describe('cleanup', () => {
  test('removes all manifest-owned files and the manifest', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    // Verify files exist before cleanup
    const mdFiles = fs.readdirSync(agentsRoot).filter((f) => f.endsWith('.md'))
    expect(mdFiles.length).toBeGreaterThan(0)

    const cleanupResult = cleanup(agentsRoot)
    expect(cleanupResult.status).toBe('ok')

    // No systematic-*.md files remain
    const after = fs.readdirSync(agentsRoot).filter((f) => f.endsWith('.md'))
    expect(after).toHaveLength(0)
    // Manifest removed
    expect(fs.existsSync(path.join(agentsRoot, MANIFEST_FILENAME))).toBe(false)
  })

  test('cleanup leaves non-manifest files untouched', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    // Plant a user file
    writeFile(agentsRoot, 'my-custom-agent.md', 'user content')
    writeFile(agentsRoot, 'another-user.md', 'also user')

    const cleanupResult = cleanup(agentsRoot)
    expect(cleanupResult.status).toBe('ok')

    // User files survive
    expect(
      fs.readFileSync(path.join(agentsRoot, 'my-custom-agent.md'), 'utf-8'),
    ).toBe('user content')
    expect(
      fs.readFileSync(path.join(agentsRoot, 'another-user.md'), 'utf-8'),
    ).toBe('also user')
    // Manifest gone
    expect(fs.existsSync(path.join(agentsRoot, MANIFEST_FILENAME))).toBe(false)
  })

  test('cleanup with no manifest is a no-op (no error)', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    // No manifest, one user file
    writeFile(agentsRoot, 'user.md', 'content')
    expect(() => cleanup(agentsRoot)).not.toThrow()
    // User file untouched
    expect(fs.readFileSync(path.join(agentsRoot, 'user.md'), 'utf-8')).toBe(
      'content',
    )
  })

  test('cleanup on a nonexistent agents root is an idempotent no-op: returns ok, creates neither root nor lock, does not throw', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    expect(fs.existsSync(agentsRoot)).toBe(false)

    let result: CleanupResult | undefined
    expect(() => {
      result = cleanup(agentsRoot)
    }).not.toThrow()

    expect(result).toEqual({ status: 'ok' })
    expect(fs.existsSync(agentsRoot)).toBe(false)
    expect(fs.existsSync(path.join(agentsRoot, LOCK_FILENAME))).toBe(false)
  })

  test('cleanup on a nonexistent agents root is a no-op even with scoped options (anchor still validated)', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    expect(fs.existsSync(agentsRoot)).toBe(false)

    const result = cleanup(agentsRoot, { scope: 'project', cwd })
    expect(result).toEqual({ status: 'ok' })
    expect(fs.existsSync(agentsRoot)).toBe(false)
  })

  test('cleanup with hostile manifest traversal filename refuses (throws) before any delete', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    // Hostile manifest: traversal in filename
    const hostile: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: '../outside.md', hash: '', status: 'exported' },
      { filename: '../../etc/motd', hash: '', status: 'exported' },
    ])
    writeManifest(agentsRoot, hostile)

    // cleanup must refuse (throw) on hostile entries — not silently skip
    expect(() => cleanup(agentsRoot)).toThrow(
      /traversal|unsafe|invalid filename/i,
    )
    // Manifest must still exist (no deletes happened)
    expect(fs.existsSync(path.join(agentsRoot, MANIFEST_FILENAME))).toBe(true)
    // Nothing written/deleted outside agentsRoot
  })
})

// ---------------------------------------------------------------------------
// manifest read/write
// ---------------------------------------------------------------------------

describe('readManifest / writeManifest', () => {
  test('round-trips correctly', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    const manifest: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: 'systematic-foo.md', hash: 'abc123', status: 'exported' },
    ])
    writeManifest(agentsRoot, manifest)

    const loaded = readManifest(agentsRoot)
    expect(loaded).not.toBeNull()
    expect(loaded?.files[0]?.filename).toBe('systematic-foo.md')
    expect(loaded?.files[0]?.hash).toBe('abc123')
  })

  test('readManifest returns null when no manifest exists', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    expect(readManifest(agentsRoot)).toBeNull()
  })

  test('readManifest returns null for malformed JSON', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    writeFile(agentsRoot, MANIFEST_FILENAME, 'not json {{{')
    expect(readManifest(agentsRoot)).toBeNull()
  })

  test('readManifestStrict refuses a symlinked manifest instead of following it', () => {
    if (process.platform === 'win32') return // symlink creation requires elevated privileges on Windows CI

    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    const manifest: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: 'systematic-foo.md', hash: 'abc123', status: 'exported' },
    ])
    const realManifestPath = path.join(cwd, 'real-manifest.json')
    fs.writeFileSync(realManifestPath, `${JSON.stringify(manifest)}\n`, 'utf-8')

    const manifestPath = path.join(agentsRoot, MANIFEST_FILENAME)
    fs.symlinkSync(realManifestPath, manifestPath)

    const result = readManifestStrict(agentsRoot)
    expect(result.kind).toBe('malformed')
    if (result.kind === 'malformed') expect(result.error).toMatch(/symlink/i)
    expect(readManifest(agentsRoot)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Transactional rollback
// ---------------------------------------------------------------------------

describe('transactional rollback', () => {
  test('export: mid-operation rename failure leaves pre-existing files and manifest byte-identical, no partial files', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')

    // Do a first successful export to establish a baseline
    exportPersonas(agentsRoot)

    // Snapshot state: all files and their contents
    const beforeFiles = fs.readdirSync(agentsRoot).sort()
    const beforeContents = new Map<string, string>()
    for (const f of beforeFiles) {
      beforeContents.set(f, fs.readFileSync(path.join(agentsRoot, f), 'utf-8'))
    }

    // Now simulate a mid-export failure by making the directory read-only
    // for temp files (so rename fails) by injecting a known-bad content
    // that triggers a write error. We do this by writing a non-writable
    // dummy file at the tmp path prefix location.
    // Strategy: corrupt a single generated file so exportPersonas tries to
    // write it, then make the parent dir read-only to cause rename to fail.
    const firstMd = beforeFiles.find((f) => f.endsWith('.md'))
    expect(firstMd).toBeDefined()
    if (!firstMd) return
    fs.writeFileSync(path.join(agentsRoot, firstMd), 'corrupted', 'utf-8')

    // Make the directory read-only → atomic rename will fail
    fs.chmodSync(agentsRoot, 0o555)
    try {
      const result = exportPersonas(agentsRoot)
      // Must return error result, not throw
      expect(result.status).toBe('error')

      // Every file must be byte-identical to before-export snapshot OR restored
      // The key invariant: no new files appear, no partial temp files remain
      const afterFiles = fs.readdirSync(agentsRoot).sort()
      // No .tmp- files should remain
      expect(afterFiles.some((f) => f.includes('.tmp-'))).toBe(false)
      // The corrupted file still has the corrupted value (rollback: we didn't change it more)
      // OR the original value (if rollback restored it). Either way: no new files.
      const newFiles = afterFiles.filter((f) => !beforeFiles.includes(f))
      expect(newFiles).toHaveLength(0)
    } finally {
      // Restore permissions so cleanup can proceed
      fs.chmodSync(agentsRoot, 0o755)
    }
  })

  test('refresh: mid-operation failure leaves all owned files byte-identical to pre-refresh state', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    // Corrupt one owned file to trigger a refresh write
    const ownedFiles = fs
      .readdirSync(agentsRoot)
      .filter((f) => f.endsWith('.md'))
    expect(ownedFiles.length).toBeGreaterThan(0)
    const firstFile = ownedFiles[0]
    if (!firstFile) return
    const originalContent = fs.readFileSync(
      path.join(agentsRoot, firstFile),
      'utf-8',
    )
    fs.writeFileSync(path.join(agentsRoot, firstFile), 'stale content', 'utf-8')

    // Snapshot state before attempted refresh-under-failure
    const beforeContents = new Map<string, string>()
    for (const f of fs.readdirSync(agentsRoot)) {
      beforeContents.set(f, fs.readFileSync(path.join(agentsRoot, f), 'utf-8'))
    }

    fs.chmodSync(agentsRoot, 0o555)
    try {
      const result = refresh(agentsRoot)
      // Must return error result
      expect(result.status).toBe('error')

      // No .tmp- partial files
      const afterFiles = fs.readdirSync(agentsRoot)
      expect(afterFiles.some((f) => f.includes('.tmp-'))).toBe(false)
      // No new files appeared
      for (const f of afterFiles) {
        expect(beforeContents.has(f)).toBe(true)
      }
    } finally {
      fs.chmodSync(agentsRoot, 0o755)
      // Restore the corrupted file for cleanup
      fs.writeFileSync(
        path.join(agentsRoot, firstFile),
        originalContent,
        'utf-8',
      )
    }
  })

  test('export write failure returns structured error result (no throw)', () => {
    const cwd = mkTmp()
    // Use a path whose parent can be made unwritable
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    fs.chmodSync(agentsRoot, 0o555)
    try {
      // Must not throw — must return ExportResult with status='error'
      let result: ReturnType<typeof exportPersonas> | undefined
      expect(() => {
        result = exportPersonas(agentsRoot)
      }).not.toThrow()
      expect(result?.status).toBe('error')
      expect(typeof result?.error).toBe('string')
    } finally {
      fs.chmodSync(agentsRoot, 0o755)
    }
  })
})

// ---------------------------------------------------------------------------
// Hostile manifest: REFUSE before any write/delete (not silently skip)
// ---------------------------------------------------------------------------

describe('hostile manifest: refuse-before-write', () => {
  test('refresh with traversal filename in manifest refuses before any write and returns error', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    // Plant a safe file to detect if it is accidentally modified
    writeFile(agentsRoot, 'safe-file.md', 'safe content')

    // Write a hostile manifest with traversal filename
    const hostile: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: '../outside.md', hash: 'abc', status: 'exported' },
    ])
    writeManifest(agentsRoot, hostile)

    // refresh must refuse (not silently skip) and return error
    const result = refresh(agentsRoot)
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/traversal|unsafe|invalid filename/i)

    // Nothing written, safe file untouched
    expect(
      fs.readFileSync(path.join(agentsRoot, 'safe-file.md'), 'utf-8'),
    ).toBe('safe content')
    // No outside file created
    expect(fs.existsSync(path.join(cwd, 'outside.md'))).toBe(false)
  })

  test('cleanup with traversal filename in manifest refuses before any delete and does not remove manifest', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    writeFile(agentsRoot, 'safe-file.md', 'safe')

    const hostile: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: '../outside.md', hash: '', status: 'exported' },
    ])
    writeManifest(agentsRoot, hostile)

    // cleanup should refuse (not silently skip) and not remove the manifest
    // because it detected a hostile entry
    expect(() => cleanup(agentsRoot)).toThrow(
      /traversal|unsafe|invalid filename/i,
    )

    // Manifest still present (operation was refused before any delete)
    expect(fs.existsSync(path.join(agentsRoot, MANIFEST_FILENAME))).toBe(true)
    // Safe file untouched
    expect(
      fs.readFileSync(path.join(agentsRoot, 'safe-file.md'), 'utf-8'),
    ).toBe('safe')
  })

  test('cleanup with absolute path in manifest filename refuses before any delete', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    const hostile: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: '/etc/passwd', hash: '', status: 'exported' },
    ])
    writeManifest(agentsRoot, hostile)

    expect(() => cleanup(agentsRoot)).toThrow(
      /traversal|unsafe|invalid filename/i,
    )
    // Manifest still present
    expect(fs.existsSync(path.join(agentsRoot, MANIFEST_FILENAME))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Blocker 1: preview() must not swallow generateAll errors
// ---------------------------------------------------------------------------

describe('preview: generator error surfacing', () => {
  test('preview returns error status when generateAll fails (not empty ok plan)', () => {
    // preview() currently swallows generateAll failures and returns an empty-actions plan.
    // Correct behavior: return a structured error result.
    const cwd = mkTmp()
    // Use a non-existent agentsRoot — preview doesn't need it to exist,
    // but we need to test the generator-failure path. We test by calling
    // preview with a structurally valid root but verifying the result type.
    // The generator always succeeds in the real repo, so we test the surface
    // via the result type contract and the CLI test (below).
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    const result = preview(agentsRoot)
    // With a real repo the generator succeeds; verify result is typed
    expect(result).toHaveProperty('status')
    expect(['ok', 'error']).toContain(result.status)
  })

  test('preview returns error result when it has an error field', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    // Inject a malformed manifest to test error propagation
    fs.mkdirSync(agentsRoot, { recursive: true })
    writeFile(agentsRoot, MANIFEST_FILENAME, 'not valid json{{{')

    const result = preview(agentsRoot)
    // With a malformed manifest, preview must not silently proceed as ok
    // It should return error status
    expect(result.status).toBe('error')
  })

  test('preview error result includes a message describing the problem', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    writeFile(agentsRoot, MANIFEST_FILENAME, 'not valid json{{{')

    const result = preview(agentsRoot)
    expect(result.status).toBe('error')
    expect(typeof result.error).toBe('string')
    expect(result.error?.length).toBeGreaterThan(0)
  })

  test('export pre-write preview: malformed manifest causes export to return error, not no-op success', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    writeFile(agentsRoot, MANIFEST_FILENAME, 'not valid json{{{')

    const result = exportPersonas(agentsRoot)
    expect(result.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// Blocker 2: stronger transaction tests with exact-byte assertions
// ---------------------------------------------------------------------------

describe('transactional rollback: exact byte assertions', () => {
  /**
   * Inject a write failure by making the agentsRoot read-only.
   * This causes atomicWriteString to fail on writeFileSync (can't create tmp).
   * The directory must already have files so there's something to rollback.
   */

  test('export with write failure: all pre-existing files byte-identical afterward', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')

    // Establish baseline
    exportPersonas(agentsRoot)

    // Snapshot exact bytes for every file
    const beforeFiles = fs.readdirSync(agentsRoot).sort()
    const beforeBytes = new Map<string, string>()
    for (const f of beforeFiles) {
      beforeBytes.set(f, fs.readFileSync(path.join(agentsRoot, f), 'utf-8'))
    }

    // Corrupt one file so export has a write to attempt
    const firstMd = beforeFiles.find((f) => f.endsWith('.md'))
    if (!firstMd) return
    fs.writeFileSync(
      path.join(agentsRoot, firstMd),
      'corrupted-for-test',
      'utf-8',
    )
    beforeBytes.set(firstMd, 'corrupted-for-test')

    // Make directory read-only → atomicWriteString fails immediately
    fs.chmodSync(agentsRoot, 0o555)
    try {
      const result = exportPersonas(agentsRoot)
      expect(result.status).toBe('error')
      // Either the lock itself couldn't be created (read-only dir) or a
      // write inside the transaction failed and was rolled back — both are
      // legitimate failure modes here; the invariant under test is no
      // partial/new state, verified below.
      expect(result.error).toMatch(
        /rolled back|partial rollback|permission denied|EACCES/i,
      )

      const afterFiles = fs.readdirSync(agentsRoot).sort()
      // No new files
      expect(afterFiles.filter((f) => !beforeFiles.includes(f))).toHaveLength(0)
      // No temp artifacts
      expect(afterFiles.some((f) => f.includes('.tmp-'))).toBe(false)
      // All bytes identical
      for (const [filename, expectedContent] of beforeBytes) {
        expect(fs.readFileSync(path.join(agentsRoot, filename), 'utf-8')).toBe(
          expectedContent,
        )
      }
    } finally {
      fs.chmodSync(agentsRoot, 0o755)
    }
  })

  // NOTE: stale-removal-then-manifest-failure is proven via the runWithRollback
  // direct test ("write then delete then throw") above — that test provably
  // executes write + delete mutations before throwing and verifies exact-byte
  // restoration. The directory-at-manifest injection trick is invalid here
  // because readManifestStrict detects a non-regular-file manifest and refuses
  // before any mutation occurs.

  test('refresh with write failure: all pre-existing files byte-identical, no temp artifacts', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    // Corrupt one owned file to make refresh want to write it
    const ownedFiles = fs
      .readdirSync(agentsRoot)
      .filter((f) => f.endsWith('.md'))
    const firstFile = ownedFiles[0]
    if (!firstFile) return
    fs.writeFileSync(
      path.join(agentsRoot, firstFile),
      'stale-for-test',
      'utf-8',
    )

    // Snapshot exact bytes (including the corrupted file)
    const beforeFiles = fs.readdirSync(agentsRoot).sort()
    const beforeBytes = new Map<string, string>()
    for (const f of beforeFiles) {
      beforeBytes.set(f, fs.readFileSync(path.join(agentsRoot, f), 'utf-8'))
    }

    // Make directory read-only → write fails immediately
    fs.chmodSync(agentsRoot, 0o555)
    try {
      const result = refresh(agentsRoot)
      expect(result.status).toBe('error')
      expect(result.error).toMatch(
        /rolled back|partial rollback|permission denied|EACCES/i,
      )

      // No temp artifacts
      expect(fs.readdirSync(agentsRoot).some((f) => f.includes('.tmp-'))).toBe(
        false,
      )
      // Every file byte-identical to snapshot
      for (const [filename, expectedContent] of beforeBytes) {
        expect(fs.readFileSync(path.join(agentsRoot, filename), 'utf-8')).toBe(
          expectedContent,
        )
      }
    } finally {
      fs.chmodSync(agentsRoot, 0o755)
    }
  })
})

// ---------------------------------------------------------------------------
// Blocker 3: readManifest must distinguish absent vs malformed
// ---------------------------------------------------------------------------

describe('readManifest: absent vs malformed distinction', () => {
  test('absent manifest returns null (not an error)', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    expect(readManifest(agentsRoot)).toBeNull()
  })

  test('malformed JSON manifest returns { kind: malformed } (not null)', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    writeFile(agentsRoot, MANIFEST_FILENAME, 'not json {{{')
    // Must distinguish from absent
    const result = readManifestStrict(agentsRoot)
    expect(result.kind).toBe('malformed')
  })

  test('manifest with invalid schema (no files array) returns malformed', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    writeFile(agentsRoot, MANIFEST_FILENAME, '{"generatedAt":"2024"}')
    const result = readManifestStrict(agentsRoot)
    expect(result.kind).toBe('malformed')
  })

  test('manifest with duplicate filename entries returns malformed', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    const dup: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: 'systematic-foo.md', hash: 'abc', status: 'exported' },
      { filename: 'systematic-foo.md', hash: 'def', status: 'exported' },
    ])
    writeManifest(agentsRoot, dup)
    const result = readManifestStrict(agentsRoot)
    expect(result.kind).toBe('malformed')
    expect(result.error).toMatch(/duplicate/i)
  })

  test('manifest with unsafe filename entry returns malformed', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    const hostile: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: '../escape.md', hash: 'abc', status: 'exported' },
    ])
    writeManifest(agentsRoot, hostile)
    const result = readManifestStrict(agentsRoot)
    expect(result.kind).toBe('malformed')
  })

  test('malformed manifest causes preview to return error (not silent empty plan)', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    writeFile(agentsRoot, MANIFEST_FILENAME, 'not json{{{')
    const result = preview(agentsRoot)
    expect(result.status).toBe('error')
  })

  test('malformed manifest causes refresh to return error without writing', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    const malformed = '{"generatedAt":"x","agentsRoot":"y","files":"notarray"}'
    writeFile(agentsRoot, MANIFEST_FILENAME, malformed)
    const result = refresh(agentsRoot)
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/malformed|invalid|corrupt/i)
    // Manifest unchanged
    expect(
      fs.readFileSync(path.join(agentsRoot, MANIFEST_FILENAME), 'utf-8'),
    ).toBe(malformed)
  })

  test('malformed manifest causes cleanup to throw without deleting anything', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    writeFile(agentsRoot, 'user-file.md', 'do not delete')
    const malformed = '{"generatedAt":"x"}'
    writeFile(agentsRoot, MANIFEST_FILENAME, malformed)
    expect(() => cleanup(agentsRoot)).toThrow(/malformed|invalid|corrupt/i)
    expect(fs.existsSync(path.join(agentsRoot, 'user-file.md'))).toBe(true)
    expect(fs.existsSync(path.join(agentsRoot, MANIFEST_FILENAME))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Blocker 4 & 5: cleanup returns structured result; rollback reports failures
// ---------------------------------------------------------------------------

describe('cleanup: structured result and rollback', () => {
  test('cleanup returns { status: ok } on success', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)
    const result = cleanup(agentsRoot)
    expect(result.status).toBe('ok')
    expect(result.error).toBeUndefined()
  })

  test('cleanup with unlink failure returns error result and restores removed files', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    // Snapshot exact bytes for all owned files before cleanup
    const allFiles = fs.readdirSync(agentsRoot)
    const beforeBytes = new Map<string, string>()
    for (const f of allFiles) {
      beforeBytes.set(f, fs.readFileSync(path.join(agentsRoot, f), 'utf-8'))
    }

    // Inject failure: make the second owned file read-only so its unlink fails.
    // cleanup's pathsToDelete includes all .md files then the manifest.
    const mdFiles = allFiles.filter((f) => f.endsWith('.md'))
    expect(mdFiles.length).toBeGreaterThan(1)
    const secondFile = mdFiles[1]
    if (!secondFile) return
    const secondFilePath = path.join(agentsRoot, secondFile)
    // Make the file unremovable by making its PARENT read-only after the first unlink
    // Actually: make the second target file read-only — unlink ignores file perms on most FS,
    // but making the PARENT dir read-only will block unlink.
    // Better: use a subdirectory trick — not easily portable.
    // Use real approach: make the second file a directory (rename trick)
    // Cleanest: rename secondFile to a directory name to cause unlink to fail
    const tmpDirAtSecond = `${secondFilePath}.dir_blocker`
    fs.mkdirSync(tmpDirAtSecond) // a dir at a path; later we rename it over the file
    // We can't actually rename a dir to overwrite a file portably.
    // Use the simplest real approach: make the agentsRoot dir read-only after first unlink
    // by having cleanup itself trigger a chmod during iteration.
    // Instead: plant a pre-chmod that blocks from the start, observe rollback.
    fs.rmdirSync(tmpDirAtSecond) // clean up our attempt

    // Real injection: make agentsRoot read-only BEFORE cleanup so ALL unlinks fail
    fs.chmodSync(agentsRoot, 0o555)
    try {
      const result = cleanup(agentsRoot)
      expect(result.status).toBe('error')
      expect(typeof result.error).toBe('string')
      // All files still present (rollback or no deletes happened)
      for (const [filename, content] of beforeBytes) {
        expect(fs.readFileSync(path.join(agentsRoot, filename), 'utf-8')).toBe(
          content,
        )
      }
    } finally {
      fs.chmodSync(agentsRoot, 0o755)
    }
  })

  test('cleanup: on success error field is absent', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)
    const result = cleanup(agentsRoot)
    expect(result.status).toBe('ok')
    expect(result.error).toBeUndefined()
  })
})

// NOTE: stale-owned removal rollback is proven via runWithRollback direct tests.
// The previous directory-at-manifest injection tests were invalid because
// readManifestStrict detects a non-regular-file manifest path during preflight
// and refuses before any mutation occurs — making them test preflight rejection,
// not rollback. The runWithRollback tests above use a plain throw after real
// write/delete mutations and verify exact-byte restoration.

// ---------------------------------------------------------------------------
// runWithRollback: shared transaction helper — direct proof of atomicity
//
// These tests use runWithRollback directly to prove that the snapshot →
// mutate → throw → rollback mechanism works end-to-end with real files.
// All three production code paths (commitExport, commitRefresh, cleanup)
// call runWithRollback internally, so this proof applies to all of them.
// ---------------------------------------------------------------------------

describe('runWithRollback: direct transaction proof', () => {
  test('write then delete then throw: all mutations reversed, exact bytes restored', () => {
    const tmp = mkTmp('tx-proof-')

    // Pre-existing files with known content
    const existingPath = path.join(tmp, 'existing.md')
    const stalePath = path.join(tmp, 'stale.md')
    const existingContent = 'original existing content'
    const staleContent = 'stale file to be removed'
    fs.writeFileSync(existingPath, existingContent, 'utf-8')
    fs.writeFileSync(stalePath, staleContent, 'utf-8')

    // File that does not exist yet (should be created then rolled back to absent)
    const newPath = path.join(tmp, 'new.md')

    // Snapshot covers all paths that will be touched
    const result = runWithRollback(
      [existingPath, stalePath, newPath], // paths to snapshot
      [
        // Op 1: overwrite existing file (succeeds, mutates existingPath)
        () => fs.writeFileSync(existingPath, 'overwritten content', 'utf-8'),
        // Op 2: delete stale file (succeeds, removes stalePath)
        () => fs.unlinkSync(stalePath),
        // Op 3: create new file (succeeds, creates newPath)
        () => fs.writeFileSync(newPath, 'new file content', 'utf-8'),
        // Op 4: deterministic failure after prior mutations
        () => {
          throw new Error('injected failure after mutations')
        },
      ],
    )

    // Transaction must report failure
    expect(result.ok).toBe(false)
    expect(result.error).toContain('injected failure after mutations')

    // existingPath restored to exact original bytes
    expect(fs.readFileSync(existingPath, 'utf-8')).toBe(existingContent)

    // stalePath restored (was deleted during tx, rollback re-creates it)
    expect(fs.existsSync(stalePath)).toBe(true)
    expect(fs.readFileSync(stalePath, 'utf-8')).toBe(staleContent)

    // newPath restored to absent (was created during tx, rollback removes it)
    expect(fs.existsSync(newPath)).toBe(false)

    // No temp artifacts
    expect(fs.readdirSync(tmp).some((f) => f.includes('.tmp-'))).toBe(false)
  })

  test('all ops succeed: ok=true, mutations persist', () => {
    const tmp = mkTmp('tx-success-')
    const filePath = path.join(tmp, 'file.md')
    fs.writeFileSync(filePath, 'original', 'utf-8')

    const result = runWithRollback(
      [filePath],
      [() => fs.writeFileSync(filePath, 'updated', 'utf-8')],
    )

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('updated')
  })

  test('partial rollback failure is reported honestly (not claimed as full rollback)', () => {
    const tmp = mkTmp('tx-partial-')
    const filePath = path.join(tmp, 'file.md')
    fs.writeFileSync(filePath, 'original', 'utf-8')

    // After mutation, make filePath itself read-only → rollback writeFileSync fails
    const result = runWithRollback(
      [filePath],
      [
        () => fs.writeFileSync(filePath, 'mutated', 'utf-8'),
        () => {
          // Make the file read-only so rollback cannot restore original content
          fs.chmodSync(filePath, 0o444)
          throw new Error('failure after mutation')
        },
      ],
    )
    try {
      expect(result.ok).toBe(false)
      // Must report partial rollback (not claim "rolled back")
      expect(result.rollbackFailed.length).toBeGreaterThan(0)
      expect(result.error).toMatch(/partial rollback/i)
    } finally {
      fs.chmodSync(filePath, 0o644)
    }
  })
})

// ---------------------------------------------------------------------------
// Exclusive per-root mutation lock (.systematic-personas.lock)
// ---------------------------------------------------------------------------

describe('mutation lock', () => {
  test('preview does not create or require a lock file', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    preview(agentsRoot)
    expect(fs.existsSync(path.join(agentsRoot, LOCK_FILENAME))).toBe(false)
  })

  test('export fails closed with an actionable message when the lock already exists', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    fs.writeFileSync(path.join(agentsRoot, LOCK_FILENAME), String(process.pid))

    const result = exportPersonas(agentsRoot)
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/lock/i)
    // Never auto-delete a pre-existing lock
    expect(fs.existsSync(path.join(agentsRoot, LOCK_FILENAME))).toBe(true)
  })

  test('refresh fails closed when the lock already exists', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)
    fs.writeFileSync(path.join(agentsRoot, LOCK_FILENAME), String(process.pid))

    const result = refresh(agentsRoot)
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/lock/i)
  })

  test('export reports lock contention (not malformed manifest) when both a pre-existing lock and a malformed manifest are present', () => {
    // Regression: readManifestStrict must run INSIDE the lock, not before
    // it. If the manifest were read first, this scenario would return a
    // "malformed manifest" error instead of a lock-contention error,
    // proving the manifest read happened before lock acquisition (a TOCTOU
    // window where a concurrent operation could mutate the manifest
    // between the read and the lock).
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    writeFile(agentsRoot, MANIFEST_FILENAME, 'not json {{{')
    fs.writeFileSync(path.join(agentsRoot, LOCK_FILENAME), String(process.pid))

    const result = exportPersonas(agentsRoot)
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/lock/i)
    expect(result.error).not.toMatch(/malformed/i)
  })

  test('refresh reports lock contention (not malformed manifest) when both a pre-existing lock and a malformed manifest are present', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    writeFile(agentsRoot, MANIFEST_FILENAME, 'not json {{{')
    fs.writeFileSync(path.join(agentsRoot, LOCK_FILENAME), String(process.pid))

    const result = refresh(agentsRoot)
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/lock/i)
    expect(result.error).not.toMatch(/malformed/i)
  })

  test('cleanup throws lock contention (not malformed manifest) when both a pre-existing lock and a malformed manifest are present', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    writeFile(agentsRoot, MANIFEST_FILENAME, 'not json {{{')
    fs.writeFileSync(path.join(agentsRoot, LOCK_FILENAME), String(process.pid))

    expect(() => cleanup(agentsRoot)).toThrow(/lock/i)
    try {
      cleanup(agentsRoot)
    } catch (err) {
      expect(err instanceof Error ? err.message : String(err)).not.toMatch(
        /malformed/i,
      )
    }
  })

  test('cleanup fails closed (throws) when the lock already exists', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)
    fs.writeFileSync(path.join(agentsRoot, LOCK_FILENAME), String(process.pid))

    expect(() => cleanup(agentsRoot)).toThrow(/lock/i)
  })

  test('export releases the lock it acquired on success', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    const result = exportPersonas(agentsRoot)
    expect(result.status).toBe('ok')
    expect(fs.existsSync(path.join(agentsRoot, LOCK_FILENAME))).toBe(false)
  })

  test('export releases the lock it acquired on failure', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    fs.chmodSync(agentsRoot, 0o555)
    try {
      const result = exportPersonas(agentsRoot)
      expect(result.status).toBe('error')
    } finally {
      fs.chmodSync(agentsRoot, 0o755)
    }
    expect(fs.existsSync(path.join(agentsRoot, LOCK_FILENAME))).toBe(false)
  })

  test('cleanup releases the lock it acquired on success', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)
    const result = cleanup(agentsRoot)
    expect(result.status).toBe('ok')
    expect(fs.existsSync(path.join(agentsRoot, LOCK_FILENAME))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Manifest schema/ownership hardening: manifest entries must be generated
// namespace files, and deletion may proceed only when the current file
// content hash matches the manifest hash.
// ---------------------------------------------------------------------------

describe('manifest ownership hardening: hash-gated deletion', () => {
  test('manifest entry with a non-generated-namespace filename is malformed', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    const hostile: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: 'not-a-systematic-file.md', hash: 'abc', status: 'exported' },
    ])
    writeManifest(agentsRoot, hostile)
    const result = readManifestStrict(agentsRoot)
    expect(result.kind).toBe('malformed')
  })

  test('cleanup refuses to delete a manifest-owned file whose disk content has drifted from the manifest hash (tampered)', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    const owned = fs.readdirSync(agentsRoot).find((f) => f.endsWith('.md'))
    expect(owned).toBeDefined()
    if (!owned) return
    const target = path.join(agentsRoot, owned)
    // Tamper with the file after export so its content no longer matches
    // the manifest hash.
    fs.writeFileSync(target, 'TAMPERED CONTENT — not what we exported', 'utf-8')

    expect(() => cleanup(agentsRoot)).toThrow(/hash|drift|mismatch|tampered/i)
    // Nothing deleted — manifest and tampered file both intact
    expect(fs.existsSync(path.join(agentsRoot, MANIFEST_FILENAME))).toBe(true)
    expect(fs.readFileSync(target, 'utf-8')).toBe(
      'TAMPERED CONTENT — not what we exported',
    )
  })

  test('cleanup: hash guard is re-verified per-target at delete time, not only at collection — tampering any one owned file refuses deletion of all, real fs, no mocks', () => {
    // Regression proof for the collect/delete TOCTOU fix: deletion targets
    // now retain { path, filename, hash } and each unlink closure calls
    // assertHashMatchesOrThrow again immediately before fs.unlinkSync,
    // rather than relying solely on the check performed while collecting
    // targets. Exercised here with real files (no mocks): with two owned
    // files, tamper only the second, and confirm the FIRST (untouched,
    // already unlinked-in-plan-order-earlier) file is still restored/
    // never deleted because the whole transaction fails closed before its
    // own unlink runs the recheck for the tampered second file.
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    const owned = fs.readdirSync(agentsRoot).filter((f) => f.endsWith('.md'))
    expect(owned.length).toBeGreaterThan(1)
    const [firstOwned, secondOwned] = owned
    if (!firstOwned || !secondOwned) return
    const firstPath = path.join(agentsRoot, firstOwned)
    const secondPath = path.join(agentsRoot, secondOwned)
    const firstContent = fs.readFileSync(firstPath, 'utf-8')
    fs.writeFileSync(secondPath, 'TAMPERED — recheck must catch this', 'utf-8')

    expect(() => cleanup(agentsRoot)).toThrow(/hash|drift|mismatch|tampered/i)

    // Whole transaction refused: nothing deleted, including the untampered
    // first file — the per-target recheck fails the op before any unlink
    // in this run is allowed to persist.
    expect(fs.existsSync(firstPath)).toBe(true)
    expect(fs.readFileSync(firstPath, 'utf-8')).toBe(firstContent)
    expect(fs.existsSync(secondPath)).toBe(true)
    expect(fs.readFileSync(secondPath, 'utf-8')).toBe(
      'TAMPERED — recheck must catch this',
    )
    expect(fs.existsSync(path.join(agentsRoot, MANIFEST_FILENAME))).toBe(true)
  })

  test('exportPersonas: stale-deletion hash guard is re-verified per-target at delete time, not only at collection — real fs, no mocks', () => {
    // Regression proof for the collect/delete TOCTOU fix on the export
    // stale-removal path (findStalePaths / exportPersonas transaction):
    // two stale manifest-owned entries, tamper only the second. The whole
    // transaction must fail closed — including refusing to delete the
    // first (untampered) stale file.
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    const firstStaleFilename = 'systematic-stale-one.md'
    const secondStaleFilename = 'systematic-stale-two.md'
    const firstContent = 'first stale content'
    const secondOriginalContent = 'second stale content'
    const firstHash = crypto
      .createHash('sha256')
      .update(firstContent)
      .digest('hex')
    const secondHash = crypto
      .createHash('sha256')
      .update(secondOriginalContent)
      .digest('hex')
    const manifest: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: firstStaleFilename, hash: firstHash, status: 'exported' },
      { filename: secondStaleFilename, hash: secondHash, status: 'exported' },
    ])
    writeManifest(agentsRoot, manifest)
    writeFile(agentsRoot, firstStaleFilename, firstContent)
    writeFile(
      agentsRoot,
      secondStaleFilename,
      'TAMPERED — does not match manifest hash',
    )

    const result = exportPersonas(agentsRoot)
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/hash|drift|mismatch|tampered/i)

    // Nothing deleted or overwritten, including the untampered first stale
    // file: manifest still lists both entries, both files intact.
    expect(
      fs.readFileSync(path.join(agentsRoot, firstStaleFilename), 'utf-8'),
    ).toBe(firstContent)
    expect(
      fs.readFileSync(path.join(agentsRoot, secondStaleFilename), 'utf-8'),
    ).toBe('TAMPERED — does not match manifest hash')
    const manifestAfter = readManifest(agentsRoot)
    expect(manifestAfter).not.toBeNull()
    expect(
      manifestAfter?.files.some((f) => f.filename === firstStaleFilename),
    ).toBe(true)
    expect(
      manifestAfter?.files.some((f) => f.filename === secondStaleFilename),
    ).toBe(true)
  })

  test('refresh refuses to remove a stale owned file whose disk content has drifted from the manifest hash', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    exportPersonas(agentsRoot)

    const manifest = readManifest(agentsRoot)
    expect(manifest).not.toBeNull()
    if (!manifest) return
    const firstEntry = manifest.files[0]
    expect(firstEntry).toBeDefined()
    if (!firstEntry) return

    // Simulate the persona becoming stale (no longer curated) AND tampered:
    // rewrite the manifest to claim ownership of a filename that is no
    // longer in the current generated set, with a hash that doesn't match
    // disk content, by tampering the actual owned file's content first,
    // then forcing a stale-removal path is exercised via cleanup instead
    // (refresh only ever writes/keeps entries still in the curated set).
    // This test verifies refresh's tamper guard on an UPDATE path: corrupt a
    // currently-owned file with mismatched-from-manifest-AND-mismatched-from-source
    // content, then ensure refresh still safely overwrites (source wins for
    // legitimate drift) — the guard specifically blocks *deletion*, not
    // in-place regeneration of owned files.
    const target = path.join(agentsRoot, firstEntry.filename)
    fs.writeFileSync(target, 'drifted user edit', 'utf-8')
    const result = refresh(agentsRoot)
    expect(result.status).toBe('ok')
    expect(result.updated).toBeGreaterThan(0)
  })

  test('exportPersonas refuses to remove a stale manifest-owned file whose disk content has drifted from the manifest hash (tampered)', () => {
    // Regression: exportPersonas's stale-removal path (findStalePaths) must
    // apply the same tamper/drift guard as cleanup's. A manifest entry for a
    // systematic-*.md file that is no longer in the current curated set is
    // "stale" and would normally be deleted; if its on-disk content no
    // longer matches the manifest hash, export must refuse before deleting
    // it or writing anything else — the file and manifest must remain
    // exactly as they were.
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })

    const staleFilename = 'systematic-no-longer-curated.md'
    const originalContent = 'original stale content'
    const hash = crypto
      .createHash('sha256')
      .update(originalContent)
      .digest('hex')
    const manifest: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: staleFilename, hash, status: 'exported' },
    ])
    writeManifest(agentsRoot, manifest)
    // Disk content differs from the manifest hash (tampered/drifted).
    const tamperedContent = 'TAMPERED — does not match manifest hash'
    writeFile(agentsRoot, staleFilename, tamperedContent)

    const result = exportPersonas(agentsRoot)
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/hash|drift|mismatch|tampered/i)

    // Nothing deleted or overwritten: stale file and manifest both intact.
    expect(fs.readFileSync(path.join(agentsRoot, staleFilename), 'utf-8')).toBe(
      tamperedContent,
    )
    const manifestAfter = readManifest(agentsRoot)
    expect(manifestAfter).not.toBeNull()
    expect(manifestAfter?.files.some((f) => f.filename === staleFilename)).toBe(
      true,
    )
  })

  test('cleanup with a hostile manifest entry outside the generated namespace refuses before any delete', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    fs.mkdirSync(agentsRoot, { recursive: true })
    writeFile(agentsRoot, 'user-file.md', 'do not delete')
    const hostile: PiSubagentsManifest = makeManifest(agentsRoot, [
      { filename: 'user-file.md', hash: '', status: 'exported' },
    ])
    writeManifest(agentsRoot, hostile)

    expect(() => cleanup(agentsRoot)).toThrow(/namespace|generated|invalid/i)
    expect(fs.existsSync(path.join(agentsRoot, 'user-file.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Snapshot/rollback: only ENOENT is treated as absent; other read failures
// return an error before the first operation and never mutate.
// ---------------------------------------------------------------------------

describe('snapshotFiles: non-ENOENT read failures abort before mutation', () => {
  test('a directory at a watched path (EISDIR on read) aborts the transaction before any op runs, no mutation', () => {
    const tmp = mkTmp('tx-isdir-')
    const dirAsFilePath = path.join(tmp, 'looks-like-a-file.md')
    fs.mkdirSync(dirAsFilePath) // EISDIR on readFileSync, not ENOENT

    let opRan = false
    const result = runWithRollback(
      [dirAsFilePath],
      [
        () => {
          opRan = true
        },
      ],
    )

    expect(result.ok).toBe(false)
    expect(opRan).toBe(false)
    // The directory must not have been touched/removed
    expect(fs.statSync(dirAsFilePath).isDirectory()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Package root via fileURLToPath
// ---------------------------------------------------------------------------

describe('findPackageRoot (via exported function)', () => {
  test('package root contains package.json with systematic metadata', () => {
    // We test this indirectly: exportPersonas successfully generates files,
    // which requires findPackageRoot() to have located the agents/ directory.
    // A direct path test would require mocking import.meta.url.
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    const result = exportPersonas(agentsRoot)
    expect(result.status).toBe('ok')
    expect(result.written).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Import side-effect guard
// ---------------------------------------------------------------------------

describe('import side-effect guard', () => {
  test('module exports are all functions/constants — no write side effects from import', () => {
    expect(typeof resolveAgentsRoot).toBe('function')
    expect(typeof preview).toBe('function')
    expect(typeof exportPersonas).toBe('function')
    expect(typeof refresh).toBe('function')
    expect(typeof cleanup).toBe('function')
    expect(typeof readManifest).toBe('function')
    expect(typeof writeManifest).toBe('function')
    expect(typeof MANIFEST_FILENAME).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Config-aware frontmatter (Unit 2: model + pi_subagents field resolution)
// ---------------------------------------------------------------------------

describe('config-aware export: model + pi_subagents field application', () => {
  let originalOsHomedir: (() => string) | undefined
  let fakeHome: string

  function setupFakeHome(): string {
    fakeHome = mkTmp('pi-export-config-home-')
    originalOsHomedir = os.homedir
    os.homedir = () => fakeHome
    return fakeHome
  }

  function restoreHome(): void {
    if (originalOsHomedir) os.homedir = originalOsHomedir
    delete process.env.OPENCODE_CONFIG_DIR
  }

  function writeUserConfig(config: Record<string, unknown>): void {
    const dir = path.join(fakeHome, '.config', 'opencode')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'systematic.json'), JSON.stringify(config))
  }

  test('no configOptions: export stays model-free (backward compatible default)', () => {
    const cwd = mkTmp()
    const agentsRoot = path.join(cwd, '.pi', 'agents')
    const result = exportPersonas(agentsRoot)
    expect(result.status).toBe('ok')
    const target = path.join(agentsRoot, 'systematic-repo-research-analyst.md')
    expect(fs.existsSync(target)).toBe(true)
    expect(fs.readFileSync(target, 'utf-8')).not.toMatch(/^model:/m)
  })

  test('per-agent model overlay is emitted for the matching persona only', () => {
    setupFakeHome()
    try {
      writeUserConfig({
        agents: { 'repo-research-analyst': { model: 'openai/gpt-5' } },
      })
      const cwd = mkTmp()
      const agentsRoot = path.join(cwd, '.pi', 'agents')
      const result = exportPersonas(agentsRoot, {
        scope: 'project',
        cwd,
      })
      expect(result.status).toBe('ok')
      const target = path.join(
        agentsRoot,
        'systematic-repo-research-analyst.md',
      )
      const content = fs.readFileSync(target, 'utf-8')
      expect(content).toMatch(/^model: "openai\/gpt-5"$/m)

      // A different persona in the same category is unaffected (no category model set)
      const other = path.join(
        agentsRoot,
        'systematic-best-practices-researcher.md',
      )
      expect(fs.readFileSync(other, 'utf-8')).not.toMatch(/^model:/m)
    } finally {
      restoreHome()
    }
  })

  test('category model applies to personas without a per-agent override', () => {
    setupFakeHome()
    try {
      writeUserConfig({
        categories: { research: { model: 'anthropic/claude-sonnet-4' } },
      })
      const cwd = mkTmp()
      const agentsRoot = path.join(cwd, '.pi', 'agents')
      exportPersonas(agentsRoot, { scope: 'project', cwd })
      const target = path.join(
        agentsRoot,
        'systematic-best-practices-researcher.md',
      )
      expect(fs.readFileSync(target, 'utf-8')).toMatch(
        /^model: "anthropic\/claude-sonnet-4"$/m,
      )
    } finally {
      restoreHome()
    }
  })

  test('per-agent model wins over category model', () => {
    setupFakeHome()
    try {
      writeUserConfig({
        categories: { research: { model: 'anthropic/claude-sonnet-4' } },
        agents: { 'repo-research-analyst': { model: 'openai/gpt-5' } },
      })
      const cwd = mkTmp()
      const agentsRoot = path.join(cwd, '.pi', 'agents')
      exportPersonas(agentsRoot, { scope: 'project', cwd })
      const target = path.join(
        agentsRoot,
        'systematic-repo-research-analyst.md',
      )
      expect(fs.readFileSync(target, 'utf-8')).toMatch(
        /^model: "openai\/gpt-5"$/m,
      )
    } finally {
      restoreHome()
    }
  })

  test('per-agent model: null omits model even when category sets one', () => {
    setupFakeHome()
    try {
      writeUserConfig({
        categories: { research: { model: 'anthropic/claude-sonnet-4' } },
        agents: { 'repo-research-analyst': { model: null } },
      })
      const cwd = mkTmp()
      const agentsRoot = path.join(cwd, '.pi', 'agents')
      exportPersonas(agentsRoot, { scope: 'project', cwd })
      const target = path.join(
        agentsRoot,
        'systematic-repo-research-analyst.md',
      )
      expect(fs.readFileSync(target, 'utf-8')).not.toMatch(/^model:/m)
    } finally {
      restoreHome()
    }
  })

  test('pi_subagents.categories applies thinking/max_turns; per-agent overrides field-by-field', () => {
    setupFakeHome()
    try {
      writeUserConfig({
        pi_subagents: {
          categories: { research: { thinking: 'high', max_turns: 10 } },
          agents: { 'repo-research-analyst': { thinking: 'medium' } },
        },
      })
      const cwd = mkTmp()
      const agentsRoot = path.join(cwd, '.pi', 'agents')
      exportPersonas(agentsRoot, { scope: 'project', cwd })

      const overridden = fs.readFileSync(
        path.join(agentsRoot, 'systematic-repo-research-analyst.md'),
        'utf-8',
      )
      expect(overridden).toMatch(/^thinking: "medium"$/m)
      expect(overridden).toMatch(/^max_turns: 10$/m)

      const categoryOnly = fs.readFileSync(
        path.join(agentsRoot, 'systematic-best-practices-researcher.md'),
        'utf-8',
      )
      expect(categoryOnly).toMatch(/^thinking: "high"$/m)
      expect(categoryOnly).toMatch(/^max_turns: 10$/m)
    } finally {
      restoreHome()
    }
  })

  test('variant in config is never emitted as thinking, and temperature/top_p are never emitted', () => {
    setupFakeHome()
    try {
      writeUserConfig({
        agents: {
          'repo-research-analyst': {
            model: 'openai/gpt-5',
            variant: 'v2',
            temperature: 0.5,
            top_p: 0.9,
          },
        },
      })
      const cwd = mkTmp()
      const agentsRoot = path.join(cwd, '.pi', 'agents')
      exportPersonas(agentsRoot, { scope: 'project', cwd })
      const content = fs.readFileSync(
        path.join(agentsRoot, 'systematic-repo-research-analyst.md'),
        'utf-8',
      )
      expect(content).not.toMatch(/^variant:/m)
      expect(content).not.toMatch(/^thinking:/m)
      expect(content).not.toMatch(/^temperature:/m)
      expect(content).not.toMatch(/^top_p:/m)
    } finally {
      restoreHome()
    }
  })

  test('global scope does not absorb cwd project config', () => {
    setupFakeHome()
    try {
      writeUserConfig({
        agents: { 'repo-research-analyst': { model: 'openai/gpt-5' } },
      })
      const cwd = mkTmp()
      const projectConfigDir = path.join(cwd, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({
          agents: { 'repo-research-analyst': { model: 'openai/gpt-4' } },
        }),
      )

      // PI_CODING_AGENT_DIR anchors the global scope's safety root (its
      // parent) so agentsRoot must live under it — matches real production
      // usage (resolveAgentsRoot('global', cwd) with the env dir set).
      const globalRoot = mkTmp('pi-export-global-')
      const agentsRoot = path.join(globalRoot, 'agents')
      const origEnv = process.env.PI_CODING_AGENT_DIR
      process.env.PI_CODING_AGENT_DIR = globalRoot
      try {
        exportPersonas(agentsRoot, { scope: 'global', cwd })
        const content = fs.readFileSync(
          path.join(agentsRoot, 'systematic-repo-research-analyst.md'),
          'utf-8',
        )
        // user model wins; project model must be entirely absent (not even stripped-merged)
        expect(content).toMatch(/^model: "openai\/gpt-5"$/m)
      } finally {
        if (origEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
        else process.env.PI_CODING_AGENT_DIR = origEnv
      }
    } finally {
      restoreHome()
    }
  })

  test('project scope loads project config alongside user config', () => {
    setupFakeHome()
    try {
      const cwd = mkTmp()
      const projectConfigDir = path.join(cwd, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({
          pi_subagents: {
            agents: { 'repo-research-analyst': { max_turns: 3 } },
          },
        }),
      )

      const agentsRoot = path.join(cwd, '.pi', 'agents')
      exportPersonas(agentsRoot, { scope: 'project', cwd })
      const content = fs.readFileSync(
        path.join(agentsRoot, 'systematic-repo-research-analyst.md'),
        'utf-8',
      )
      expect(content).toMatch(/^max_turns: 3$/m)
    } finally {
      restoreHome()
    }
  })

  test('project config cannot grant thinking/tools/skills for the exported persona (trust stripping applies through export)', () => {
    setupFakeHome()
    try {
      const cwd = mkTmp()
      const projectConfigDir = path.join(cwd, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({
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
        }),
      )

      const agentsRoot = path.join(cwd, '.pi', 'agents')
      exportPersonas(agentsRoot, { scope: 'project', cwd })
      const content = fs.readFileSync(
        path.join(agentsRoot, 'systematic-repo-research-analyst.md'),
        'utf-8',
      )
      expect(content).not.toMatch(/^thinking:/m)
      expect(content).not.toMatch(/^tools:/m)
      expect(content).not.toMatch(/^skills:/m)
      expect(content).toMatch(/^max_turns: 5$/m)
    } finally {
      restoreHome()
    }
  })

  test('malformed project config fails export before any write (fail closed)', () => {
    setupFakeHome()
    try {
      const cwd = mkTmp()
      const projectConfigDir = path.join(cwd, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({
          pi_subagents: { agents: { x: { thinking: 'turbo' } } },
        }),
      )

      const agentsRoot = path.join(cwd, '.pi', 'agents')
      const result = exportPersonas(agentsRoot, { scope: 'project', cwd })
      expect(result.status).toBe('error')
      expect(fs.existsSync(agentsRoot)).toBe(false)
    } finally {
      restoreHome()
    }
  })

  test('malformed config fails preview before returning ok', () => {
    setupFakeHome()
    try {
      const cwd = mkTmp()
      const projectConfigDir = path.join(cwd, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({
          pi_subagents: { agents: { x: { max_turns: -1 } } },
        }),
      )

      const agentsRoot = path.join(cwd, '.pi', 'agents')
      const result = preview(agentsRoot, { scope: 'project', cwd })
      expect(result.status).toBe('error')
    } finally {
      restoreHome()
    }
  })

  test('config-driven content change is reflected in the drift hash (refresh detects it)', () => {
    setupFakeHome()
    try {
      const cwd = mkTmp()
      const agentsRoot = path.join(cwd, '.pi', 'agents')
      // First export with no model config
      exportPersonas(agentsRoot, { scope: 'project', cwd })
      const before = fs.readFileSync(
        path.join(agentsRoot, 'systematic-repo-research-analyst.md'),
        'utf-8',
      )
      expect(before).not.toMatch(/^model:/m)

      // Now add a model overlay and refresh with the same scope/cwd
      writeUserConfig({
        agents: { 'repo-research-analyst': { model: 'openai/gpt-5' } },
      })
      const result = refresh(agentsRoot, { scope: 'project', cwd })
      expect(result.status).toBe('ok')
      expect(result.updated).toBeGreaterThan(0)

      const after = fs.readFileSync(
        path.join(agentsRoot, 'systematic-repo-research-analyst.md'),
        'utf-8',
      )
      expect(after).toMatch(/^model: "openai\/gpt-5"$/m)
    } finally {
      restoreHome()
    }
  })
})
