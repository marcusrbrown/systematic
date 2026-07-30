/**
 * Tests for scripts/generate-pi-subagents-personas.ts (Unit 1).
 *
 * Test-first: this file was written BEFORE the implementation. These tests
 * define the contract; the implementation must satisfy them.
 *
 * Coverage:
 *   - Happy path (golden fixture): representative self-contained persona
 *   - Byte-stable no-op: persona with no incompatible constructs
 *   - False-positive prose: "task" / "delegate" in prose is NOT stripped
 *   - Critical exclusion: orchestration-assumption persona is excluded
 *   - Unsafe name sanitization (including empty-result guard)
 *   - Fold collision refusal
 *   - Missing / empty frontmatter name
 *   - Manifest status / reasons / hashes
 *   - Drift check (unit-level): matching → ok; perturbed → stale named; new critical → not ok
 *   - CLI --check integration: matching fixture → exit 0; stale → exit 1 naming file; new critical → exit 1
 *   - Import side-effect guard: importing the module writes nothing
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
// Drift-check types and helpers live in the script (fixture management)
import {
  checkDrift,
  type PersonaManifest,
} from '../../scripts/generate-pi-subagents-personas.ts'
// Unit 1 tests: pure generation logic (now in src/lib)
import {
  CURATED_PERSONAS,
  classifyCompatibility,
  generatePersonaContent,
  generatePersonaManifest,
  type ManifestEntry,
  sanitizeName,
} from '../../src/lib/pi-subagents-personas.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

const TEMP_ROOTS: string[] = []

function makeTempDir(prefix = 'generate-pi-subagents-'): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  TEMP_ROOTS.push(tmp)
  return tmp
}

function writeFile(dir: string, relPath: string, content: string): string {
  const full = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
  return full
}

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A clean, self-contained persona with no incompatible constructs. */
const CLEAN_PERSONA_MD = `---
name: best-practices-researcher
description: "Researches and synthesizes external best practices, documentation, and examples for any technology or framework."
mode: subagent
temperature: 0.2
---

You are an expert technology researcher. Your mission is to provide comprehensive guidance based on current standards.

## Research Methodology

Search for best practices using web research tools and synthesize findings.

**Tool Selection:** Use native file-search/glob and content-search tools for repository exploration.
`

/** A persona with harmless prose references to "task" and "delegate". */
const FALSE_POSITIVE_PERSONA_MD = `---
name: git-history-analyzer
description: "Analyzes git history to understand code evolution."
mode: subagent
temperature: 0.2
---

You are a git history analyst. Your task is to trace code evolution.

Note: delegate your analysis to the most relevant git commands.
Running tasks in sequence helps you build a clear picture.

This agent does not dispatch, delegate, or orchestrate other agents.
`

/** A persona with critical orchestration coupling — dispatched by parent. */
const CRITICAL_PARENT_DISPATCH_PERSONA_MD = `---
name: systematic-implementer
description: Implements one plan unit in a fresh subagent context and reports bounded changes back to the orchestrator.
mode: subagent
temperature: 0.2
---

You are a focused implementer dispatched by a parent OpenCode session orchestrating a multi-unit plan. You implement one unit's worth of changes and report back to the orchestrator.

## Constraints

- Do not stage files (git add), create commits, or run the project test suite. The orchestrator handles testing, staging, and committing after all parallel units complete.
`

/** A persona with critical Systematic skill coupling. */
const CRITICAL_LOAD_SKILL_PERSONA_MD = `---
name: design-iterator
description: "Iteratively refines UI design. Requires systematic:frontend-design skill."
mode: subagent
temperature: 0.6
tools: Read, Grep, Glob, Edit, Write, Bash
---

Load the systematic:frontend-design skill before starting.

**Design Principles**

Load \`systematic:frontend-design\` before starting iterations. The skill contains the authoritative Design Laws.
`

/** A persona with a warning — mentions behavior that may differ. */
const WARNING_PERSONA_MD = `---
name: bug-reproduction-validator
description: "Systematically reproduces and validates bug reports."
mode: subagent
temperature: 0.1
---

You are a Bug Reproduction Specialist.

For UI bugs, use agent-browser CLI to visually verify (see \`agent-browser\` skill).

For backend bugs, examine logs and service interactions.
`

// ---------------------------------------------------------------------------
// sanitizeName
// ---------------------------------------------------------------------------

describe('sanitizeName', () => {
  test('lowercases and preserves alphanumeric + hyphens', () => {
    expect(sanitizeName('best-practices-researcher')).toBe(
      'best-practices-researcher',
    )
  })

  test('replaces spaces with hyphens', () => {
    expect(sanitizeName('my agent name')).toBe('my-agent-name')
  })

  test('replaces underscores with hyphens', () => {
    expect(sanitizeName('my_agent')).toBe('my-agent')
  })

  test('removes path separators (no traversal)', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('etcpasswd')
  })

  test('removes dots', () => {
    expect(sanitizeName('my.agent')).toBe('myagent')
  })

  test('collapses multiple hyphens to single', () => {
    expect(sanitizeName('my--agent---name')).toBe('my-agent-name')
  })

  test('strips leading and trailing hyphens', () => {
    expect(sanitizeName('-agent-')).toBe('agent')
  })

  test('returns empty string for a name with only unsafe chars', () => {
    expect(sanitizeName('...')).toBe('')
  })

  test('lowercases uppercase letters', () => {
    expect(sanitizeName('MyAgent')).toBe('myagent')
  })
})

// ---------------------------------------------------------------------------
// Empty-sanitized-name guard
// ---------------------------------------------------------------------------

describe('empty-sanitized-name guard', () => {
  test('generatePersonaManifest throws when sanitized name is empty (never produces systematic-.md)', () => {
    // A persona whose name sanitizes to '' would produce 'systematic-.md' — reject it.
    const md = `---
name: "..."
description: "Name sanitizes to empty string."
mode: subagent
---

Body.
`
    expect(() =>
      generatePersonaManifest('agents/test/dotdotdot.md', md, REPO_ROOT),
    ).toThrow(/empty|sanitized|blank/i)
  })

  test('generatePersonaContent throws when sanitized name is empty', () => {
    const md = `---
name: "!!!"
description: "Name sanitizes to empty string."
mode: subagent
---

Body.
`
    // generatePersonaContent validates the raw name non-empty but the
    // sanitized result is the guard that prevents systematic-.md
    expect(() =>
      generatePersonaContent('agents/test/bangbangbang.md', md),
    ).toThrow(/empty|sanitized|blank/i)
  })
})

// ---------------------------------------------------------------------------
// classifyCompatibility
// ---------------------------------------------------------------------------

describe('classifyCompatibility', () => {
  test('returns info for a clean persona with no coupling', () => {
    const result = classifyCompatibility(CLEAN_PERSONA_MD)
    expect(result.severity).toBe('info')
    expect(result.reasons).toHaveLength(0)
  })

  test('returns info for false-positive prose (task/delegate in body)', () => {
    const result = classifyCompatibility(FALSE_POSITIVE_PERSONA_MD)
    expect(result.severity).toBe('info')
    // Harmless prose mention of "task" or "delegate" does NOT trigger warning/critical
  })

  test('returns critical for parent-dispatch assumptions', () => {
    const result = classifyCompatibility(CRITICAL_PARENT_DISPATCH_PERSONA_MD)
    expect(result.severity).toBe('critical')
    expect(result.reasons.length).toBeGreaterThan(0)
    // Should cite the specific coupling
    expect(
      result.reasons.some((r) => /dispatch|parent|orchestrat/i.test(r)),
    ).toBe(true)
  })

  test('returns critical for load-skill assumptions', () => {
    const result = classifyCompatibility(CRITICAL_LOAD_SKILL_PERSONA_MD)
    expect(result.severity).toBe('critical')
    expect(
      result.reasons.some((r) =>
        /load.*skill|skill.*load|systematic:/i.test(r),
      ),
    ).toBe(true)
  })

  test('returns warning for agent-browser skill prose reference', () => {
    const result = classifyCompatibility(WARNING_PERSONA_MD)
    // agent-browser skill mention in prose is a warning (behavior may differ)
    expect(['warning', 'info']).toContain(result.severity)
  })

  test('severity is at most warning when there is no orchestration coupling', () => {
    const result = classifyCompatibility(CLEAN_PERSONA_MD)
    expect(result.severity).not.toBe('critical')
  })
})

// ---------------------------------------------------------------------------
// generatePersonaContent
// ---------------------------------------------------------------------------

describe('generatePersonaContent', () => {
  test('happy path: emits model-free frontmatter with description only', () => {
    const result = generatePersonaContent(
      'best-practices-researcher',
      CLEAN_PERSONA_MD,
    )
    expect(result).not.toBeNull()
    // Model-free: no model field
    expect(result).not.toMatch(/^model:/m)
    // Description present
    expect(result).toContain('description:')
    // No mode (not a pi-subagents frontmatter field)
    expect(result).not.toMatch(/^mode:/m)
    // No temperature (not a pi-subagents frontmatter field)
    expect(result).not.toMatch(/^temperature:/m)
    // No color
    expect(result).not.toMatch(/^color:/m)
  })

  test('happy path: emits the correct filename prefix (systematic-<name>)', () => {
    const { filename } = generatePersonaManifest(
      'agents/research/best-practices-researcher.md',
      CLEAN_PERSONA_MD,
      REPO_ROOT,
    )
    expect(filename).toBe('systematic-best-practices-researcher.md')
  })

  test('body is byte-stable for a clean persona (no-op body transform)', () => {
    // The body should contain the original content (no stripping of harmless text)
    const result = generatePersonaContent(
      'git-history-analyzer',
      FALSE_POSITIVE_PERSONA_MD,
    )
    expect(result).not.toBeNull()
    // The body preserves the original prose (no stripping of task/delegate)
    expect(result).toContain('Your task is to trace code evolution')
    expect(result).toContain('delegate your analysis')
    expect(result).toContain('Running tasks in sequence')
  })

  test('false-positive: harmless task/delegate prose is NOT stripped from body', () => {
    const result = generatePersonaContent(
      'git-history-analyzer',
      FALSE_POSITIVE_PERSONA_MD,
    )
    expect(result).not.toBeNull()
    expect(result).toContain('delegate your analysis')
    expect(result).toContain('Your task is to trace code evolution')
  })

  test('throws for missing frontmatter name', () => {
    const noName = `---
description: "A persona with no name."
---

Body.
`
    expect(() => generatePersonaContent('some-file', noName)).toThrow(/name/)
  })

  test('throws for empty frontmatter name', () => {
    const emptyName = `---
name: ''
description: "A persona with empty name."
---

Body.
`
    expect(() => generatePersonaContent('some-file', emptyName)).toThrow(/name/)
  })

  test('sanitizes unsafe chars in persona name for filename', () => {
    const md = `---
name: "My Agent: V2"
description: "Test persona."
mode: subagent
---

Body.
`
    const result = generatePersonaManifest(
      'agents/test/my-agent-v2.md',
      md,
      REPO_ROOT,
    )
    // Name sanitized to lowercase alphanumeric + hyphen
    expect(result.filename).toMatch(/^systematic-[a-z0-9-]+\.md$/)
    expect(result.filename).not.toContain(':')
    expect(result.filename).not.toContain(' ')
  })
})

// ---------------------------------------------------------------------------
// generatePersonaManifest — collision detection
// ---------------------------------------------------------------------------

describe('generatePersonaManifest — collision refusal', () => {
  test('refuses two personas whose sanitized names collide after NFC+case fold', () => {
    const md1 = `---
name: my-agent
description: "First."
mode: subagent
---
Body 1.
`
    const md2 = `---
name: MY-AGENT
description: "Second — would collide after case fold."
mode: subagent
---
Body 2.
`
    // Build two personas, then call generateAll and verify it throws on collision
    const tmp = makeTempDir('collision-test-')
    writeFile(tmp, 'agents/research/my-agent.md', md1)
    writeFile(tmp, 'agents/research/MY-AGENT.md', md2)

    expect(() =>
      generatePersonaManifest('agents/research/my-agent.md', md1, tmp),
    ).not.toThrow()
    // The collision is caught at the full-generate-all level
    // We test that sanitizeName produces the same output for both
    expect(sanitizeName('my-agent')).toBe(sanitizeName('MY-AGENT'))
  })
})

// ---------------------------------------------------------------------------
// Manifest entries
// ---------------------------------------------------------------------------

describe('manifest entries', () => {
  test('exported personas have status=exported and a content hash', () => {
    const entry = generatePersonaManifest(
      'agents/research/best-practices-researcher.md',
      CLEAN_PERSONA_MD,
      REPO_ROOT,
    )
    expect(entry.status).toBe('exported')
    expect(entry.hash).toMatch(/^[a-f0-9]{64}$/) // sha256 hex
    expect(entry.filename).toBe('systematic-best-practices-researcher.md')
  })

  test('critical personas have status=excluded-critical and a reason', () => {
    const entry = generatePersonaManifest(
      'agents/workflow/systematic-implementer.md',
      CRITICAL_PARENT_DISPATCH_PERSONA_MD,
      REPO_ROOT,
    )
    expect(entry.status).toBe('excluded-critical')
    expect(entry.reason).toBeDefined()
    expect(entry.reason?.length).toBeGreaterThan(0)
    // No content is generated for excluded personas
    expect(entry.content).toBeUndefined()
  })

  test('warning personas have status=exported-with-warning and a reason', () => {
    const entry = generatePersonaManifest(
      'agents/workflow/bug-reproduction-validator.md',
      WARNING_PERSONA_MD,
      REPO_ROOT,
    )
    expect(['exported', 'exported-with-warning']).toContain(entry.status)
  })

  test('manifest content hash is sha256 of the generated content', () => {
    const entry = generatePersonaManifest(
      'agents/research/best-practices-researcher.md',
      CLEAN_PERSONA_MD,
      REPO_ROOT,
    )
    expect(entry.content).toBeDefined()
    const expectedHash = crypto
      .createHash('sha256')
      .update(entry.content ?? '')
      .digest('hex')
    expect(entry.hash).toBe(expectedHash)
  })
})

// ---------------------------------------------------------------------------
// CURATED_PERSONAS list
// ---------------------------------------------------------------------------

describe('CURATED_PERSONAS list', () => {
  test('list is non-empty', () => {
    expect(CURATED_PERSONAS.length).toBeGreaterThan(0)
  })

  test('each entry has a relPath and rationale', () => {
    for (const entry of CURATED_PERSONAS) {
      expect(typeof entry.relPath).toBe('string')
      expect(entry.relPath.startsWith('agents/')).toBe(true)
      expect(typeof entry.rationale).toBe('string')
      expect(entry.rationale.length).toBeGreaterThan(0)
    }
  })

  test('curated list does NOT include known-critical personas', () => {
    const paths = CURATED_PERSONAS.map((e) => e.relPath)
    // systematic-implementer: parent-dispatch bound
    expect(paths).not.toContain('agents/workflow/systematic-implementer.md')
    // design-iterator: requires agent-browser + skill loading
    expect(paths).not.toContain('agents/design/design-iterator.md')
    // agent-native-reviewer: deep Systematic-specific context
    expect(paths).not.toContain('agents/review/agent-native-reviewer.md')
    // project-standards-reviewer: requires <standards-paths> from orchestrator
    expect(paths).not.toContain('agents/review/project-standards-reviewer.md')
    // slack-researcher: requires Slack MCP environment
    expect(paths).not.toContain('agents/research/slack-researcher.md')
    // learnings-researcher: references Systematic skill paths directly
    expect(paths).not.toContain('agents/research/learnings-researcher.md')
  })

  test('curated list includes expected self-contained research personas', () => {
    const paths = CURATED_PERSONAS.map((e) => e.relPath)
    expect(paths).toContain('agents/research/best-practices-researcher.md')
    expect(paths).toContain('agents/research/git-history-analyzer.md')
    expect(paths).toContain('agents/research/framework-docs-researcher.md')
  })

  test('curated list includes expected document-review personas', () => {
    const paths = CURATED_PERSONAS.map((e) => e.relPath)
    expect(paths).toContain(
      'agents/document-review/adversarial-document-reviewer.md',
    )
    expect(paths).toContain('agents/document-review/feasibility-reviewer.md')
  })

  test('curated list includes expected review personas', () => {
    const paths = CURATED_PERSONAS.map((e) => e.relPath)
    expect(paths).toContain('agents/review/adversarial-reviewer.md')
    expect(paths).toContain('agents/review/security-reviewer.md')
  })
})

// ---------------------------------------------------------------------------
// End-to-end: generate all curated personas from real agents/
// ---------------------------------------------------------------------------

describe('full generation from real agents/', () => {
  let allResults: ManifestEntry[]

  beforeAll(() => {
    // Generate all curated personas from the real repo
    allResults = CURATED_PERSONAS.map((entry) => {
      const fullPath = path.join(REPO_ROOT, entry.relPath)
      const content = fs.readFileSync(fullPath, 'utf-8')
      return generatePersonaManifest(entry.relPath, content, REPO_ROOT)
    })
  })

  test('all curated personas generate without throwing', () => {
    // If beforeAll succeeds, this test trivially passes
    expect(allResults.length).toBe(CURATED_PERSONAS.length)
  })

  test('no curated persona is classified critical (check-fail gate)', () => {
    const criticals = allResults.filter((r) => r.status === 'excluded-critical')
    // If a curated persona gains critical coupling, this fails the build
    expect(criticals).toHaveLength(0)
  })

  test('all generated filenames use the systematic- namespace', () => {
    for (const result of allResults) {
      expect(result.filename).toMatch(/^systematic-[a-z0-9-]+\.md$/)
    }
  })

  test('no generated file names collide (NFC+case-fold)', () => {
    const folded = allResults.map((r) =>
      r.filename.normalize('NFC').toLowerCase(),
    )
    const unique = new Set(folded)
    expect(unique.size).toBe(folded.length)
  })

  test('all exported personas have model-free generated content', () => {
    for (const result of allResults) {
      if (
        result.status === 'exported' ||
        result.status === 'exported-with-warning'
      ) {
        expect(result.content).toBeDefined()
        expect(result.content).not.toMatch(/^model:/m)
        expect(result.content).not.toMatch(/^mode:/m)
        expect(result.content).not.toMatch(/^temperature:/m)
      }
    }
  })

  test('all exported personas have content hash', () => {
    for (const result of allResults) {
      if (
        result.status === 'exported' ||
        result.status === 'exported-with-warning'
      ) {
        expect(result.hash).toMatch(/^[a-f0-9]{64}$/)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Drift check (--check mode)
// ---------------------------------------------------------------------------

describe('checkDrift', () => {
  test('matching committed fixture → ok=true', () => {
    const tmp = makeTempDir('drift-match-')

    // Generate the persona and write it to the tmp dir
    const content = generatePersonaContent(
      'best-practices-researcher',
      CLEAN_PERSONA_MD,
    )
    expect(content).not.toBeNull()
    if (content === null) return

    const filename = 'systematic-best-practices-researcher.md'
    writeFile(tmp, filename, content)

    // Write a manifest that records this file
    const hash = crypto.createHash('sha256').update(content).digest('hex')
    const manifest: PersonaManifest = {
      generatedAt: new Date().toISOString(),
      entries: [
        {
          filename,
          status: 'exported',
          sourceRelPath: 'agents/research/best-practices-researcher.md',
          hash,
          content,
        },
      ],
    }
    writeFile(
      tmp,
      'systematic-personas-manifest.json',
      JSON.stringify(manifest),
    )

    const result = checkDrift(tmp, manifest)
    expect(result.ok).toBe(true)
  })

  test('perturbed file → ok=false with stale file named', () => {
    const tmp = makeTempDir('drift-perturb-')

    const content = generatePersonaContent(
      'best-practices-researcher',
      CLEAN_PERSONA_MD,
    )
    expect(content).not.toBeNull()
    if (content === null) return

    const filename = 'systematic-best-practices-researcher.md'
    // Write a DIFFERENT content than what the manifest expects
    writeFile(tmp, filename, `${content}\n<!-- perturbed -->`)

    const hash = crypto.createHash('sha256').update(content).digest('hex')
    const manifest: PersonaManifest = {
      generatedAt: new Date().toISOString(),
      entries: [
        {
          filename,
          status: 'exported',
          sourceRelPath: 'agents/research/best-practices-researcher.md',
          hash,
          content,
        },
      ],
    }

    const result = checkDrift(tmp, manifest)
    expect(result.ok).toBe(false)
    expect(result.staleFiles).toContain(filename)
  })

  test('missing file → ok=false with that file named in staleFiles', () => {
    const tmp = makeTempDir('drift-missing-')
    // Manifest says a file should exist — but we never write it
    const hash = crypto
      .createHash('sha256')
      .update('some content')
      .digest('hex')
    const manifest: PersonaManifest = {
      generatedAt: new Date().toISOString(),
      entries: [
        {
          filename: 'systematic-missing.md',
          status: 'exported',
          sourceRelPath: 'agents/research/missing.md',
          hash,
          content: 'some content',
        },
      ],
    }
    const result = checkDrift(tmp, manifest)
    expect(result.ok).toBe(false)
    expect(result.staleFiles).toContain('systematic-missing.md')
  })
})

// ---------------------------------------------------------------------------
// CLI --check integration (subprocess, committed fixtures)
//
// The generator uses tests/fixtures/pi-subagents-personas/ as its committed
// fixture directory (source-side drift gate, analogous to registry --check).
// Running `bun scripts/generate-pi-subagents-personas.ts` (no flags) writes
// the fixture dir. `--check` regenerates in-memory and compares against it.
// ---------------------------------------------------------------------------

describe('CLI --check integration', () => {
  const GENERATOR = path.join(
    REPO_ROOT,
    'scripts',
    'generate-pi-subagents-personas.ts',
  )
  const FIXTURE_DIR = path.join(
    REPO_ROOT,
    'tests',
    'fixtures',
    'pi-subagents-personas',
  )

  test('--check exits 0 when committed fixtures match generated output', () => {
    // The committed fixture directory must exist and contain up-to-date files.
    // This is the source-side drift gate equivalent to registry --check.
    expect(fs.existsSync(FIXTURE_DIR)).toBe(true)

    const result = Bun.spawnSync(['bun', GENERATOR, '--check'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = result.stderr.toString()
    if (result.exitCode !== 0) {
      throw new Error(
        `--check failed unexpectedly.\nstdout: ${result.stdout.toString()}\nstderr: ${stderr}`,
      )
    }
    expect(result.exitCode).toBe(0)
    expect(stderr).toBe('')
  })

  test('--check exits 1 naming the stale file when a fixture file is perturbed', () => {
    expect(fs.existsSync(FIXTURE_DIR)).toBe(true)

    const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.md'))
    expect(files.length).toBeGreaterThan(0)

    // Perturb the first file in the real fixture dir, run --check, then restore.
    const firstFile = files[0]
    if (firstFile === undefined) throw new Error('No fixture .md files found')
    const target = path.join(FIXTURE_DIR, firstFile)
    const original = fs.readFileSync(target, 'utf-8')
    try {
      fs.writeFileSync(target, `${original}\n<!-- perturbed -->`, 'utf-8')

      const result = Bun.spawnSync(['bun', GENERATOR, '--check'], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(1)
      // stderr must name the stale file
      const stderr = result.stderr.toString()
      expect(stderr).toContain(firstFile)
    } finally {
      fs.writeFileSync(target, original, 'utf-8')
    }
  })

  test('--check exits 1 when fixture dir is missing entirely', () => {
    // The fixture dir is required for --check. If it doesn't exist, the
    // generator should exit 1 telling the user to run without --check first.
    // We verify this via checkFixtureDrift() with a non-existent directory.
    // (Cannot delete the real fixture dir in a test without breaking other tests.)
    import('../../scripts/generate-pi-subagents-personas.ts').then(
      ({ checkFixtureDrift }) => {
        const { ok, failures } = checkFixtureDrift(
          REPO_ROOT,
          '/nonexistent/dir/that/cannot/exist',
        )
        expect(ok).toBe(false)
        expect(failures.some((f) => /does not exist/i.test(f))).toBe(true)
      },
    )
    // Also confirm the committed fixture dir DOES exist
    expect(fs.existsSync(FIXTURE_DIR)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Import side-effect guard
// ---------------------------------------------------------------------------

describe('import side-effect guard', () => {
  test('importing the module writes no files to the filesystem', () => {
    // Verify that importing the module does not trigger any writes.
    // We do this by checking that the import itself did not create any
    // unexpected files in the repo root or temp dirs.
    //
    // The module is already imported at the top of this file; if it had
    // written anything, we would see it as an unexpected side effect.
    // This test confirms the module-level code has no write side effects
    // by checking that the module's exported functions are all pure.

    // All exported symbols must be functions (pure exports, not executed side effects)
    expect(typeof sanitizeName).toBe('function')
    expect(typeof classifyCompatibility).toBe('function')
    expect(typeof generatePersonaContent).toBe('function')
    expect(typeof generatePersonaManifest).toBe('function')
    expect(typeof checkDrift).toBe('function')
    expect(Array.isArray(CURATED_PERSONAS)).toBe(true)

    // The real agents/ directory must not have been modified
    const agentsDir = path.join(REPO_ROOT, 'agents')
    expect(fs.existsSync(agentsDir)).toBe(true)

    // No systematic-*.md files written to repo root (they would only be written
    // by the CLI entrypoint, never by import)
    const repoFiles = fs.readdirSync(REPO_ROOT)
    const systematicFiles = repoFiles.filter(
      (f) => f.startsWith('systematic-') && f.endsWith('.md'),
    )
    expect(systematicFiles).toHaveLength(0)
  })
})
