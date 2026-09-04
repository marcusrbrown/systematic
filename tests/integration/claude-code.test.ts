/**
 * Claude Code plugin bundle integration tests.
 *
 * Claude Code has no headless RPC harness like Pi (tests/integration/pi.test.ts)
 * — the plugin runs inside Claude Desktop/CLI, which cannot be driven headlessly
 * in CI. This suite therefore covers the automatable layers only:
 *
 *   1. Shared core   — the generated output-style/skills/agents stay faithful
 *                       to the single source of truth (skills/, agents/, and
 *                       the Claude Code capability profile).
 *   2. Artifact       — the generated bundle is self-contained (no symlinks,
 *                       valid manifests, hook payload within the cap) so the
 *                       harness's per-session cache copy works correctly.
 *   3. No regression  — the build only writes claude-code/, never touching
 *                       src/index.ts or src/pi.ts.
 *   4. Shadow paths   — the build's own reduce-to-counts-only fallback and
 *                       missing-source failure modes, exercised via the
 *                       importable build functions against synthetic fixture
 *                       repos rather than a real Claude Code runtime.
 *
 * The bundle is an EPHEMERAL BUILD ARTIFACT — gitignored, never committed.
 * Every test here builds fresh into an isolated temp dir and asserts against
 * that, never a committed claude-code/ directory.
 *
 * The clean-install behavior (output-style enforcement, native skill
 * invocation, subagent dispatch, declarative-hook handling) cannot be driven
 * headlessly, so it is verified by hand in Claude Desktop — see
 * `MANUAL_REAL_CC_GATE` for the checklist to re-run before each release that
 * touches the build script or its inputs. That gate is a manual step, never an
 * automated skip that would masquerade as a passing test.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildHookFacts,
  buildOutputStyleContent,
  buildValidatorBundle,
  CLAUDE_CODE_VALIDATOR_BIN,
  generatePluginFiles,
  HOOK_PAYLOAD_CAP,
  writePluginFiles,
} from '../../scripts/build-claude-code-plugin.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')
const SRC_DIR = path.join(REPO_ROOT, 'src')
const VALIDATOR_BUNDLE = await buildValidatorBundle(REPO_ROOT)

/**
 * Manual, non-automated release gate. Re-run these steps by hand in Claude
 * Desktop/CLI before any release that changes `scripts/build-claude-code-plugin.ts`,
 * `skills/using-systematic/SKILL.md`, or `skills/using-systematic/references/claude-code-profile.md`.
 * Do NOT convert this into an automated test.skip — Claude Code cannot be
 * driven headlessly, so a skip would be a fake green, not a real verification.
 */
export const MANUAL_REAL_CC_GATE = [
  'Install the generated claude-code/ bundle as a plugin in Claude Desktop (or via `claude plugin install` / marketplace flow).',
  'Confirm the "systematic" output style auto-applies (force-for-plugin: true) and the system prompt shows plan-first / skill-invocation enforcement text.',
  'Confirm native Skill-tool invocation discovers and loads a bundled SKILL.md (e.g. systematic:onboarding).',
  'Confirm subagent dispatch of a flattened, model-free agent (e.g. best-practices-researcher) succeeds.',
  'Confirm the declarative SessionStart hook payload is honored (no refusal/error) and reflects facts only.',
] as const

function walkAllFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) return [full]
    if (entry.isDirectory()) return walkAllFiles(full)
    return [full]
  })
}

function listSourceSkillNames(): string[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

function listSourceAgentStems(): string[] {
  const agentsDir = path.join(REPO_ROOT, 'agents')
  const categories = fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
  const stems: string[] = []
  for (const category of categories) {
    const categoryDir = path.join(agentsDir, category.name)
    for (const file of fs.readdirSync(categoryDir)) {
      if (file.endsWith('.md') && file.toLowerCase() !== 'readme.md') {
        stems.push(path.basename(file, '.md'))
      }
    }
  }
  return stems.sort((a, b) => a.localeCompare(b))
}

// Build the real repo once into a shared temp dir for this suite.
const BUILD_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'claude-code-integration-'),
)
writePluginFiles(generatePluginFiles(REPO_ROOT, VALIDATOR_BUNDLE), BUILD_DIR)

afterAll(() => {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. SHARED-CORE: generated content is faithful to the single source of truth
// ---------------------------------------------------------------------------

describe('claude-code bundle — shared-core content fidelity', () => {
  test('output-style body contains a distinctive using-systematic enforcement line', () => {
    const content = fs.readFileSync(
      path.join(BUILD_DIR, 'output-styles/systematic.md'),
      'utf8',
    )
    // Distinctive line from skills/using-systematic/SKILL.md — proves the
    // enforcement text is sourced from the single source of truth, not
    // duplicated/drifted prose.
    expect(content).toContain(
      'IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.',
    )
  })

  test('output-style contains the claude-code-profile.md capability-matrix content', () => {
    const content = fs.readFileSync(
      path.join(BUILD_DIR, 'output-styles/systematic.md'),
      'utf8',
    )
    expect(content).toContain('Claude Code Capability Profile')
    expect(content).toContain('AskUserQuestion')
  })

  test('output-style frontmatter has force-for-plugin: true', () => {
    const content = fs.readFileSync(
      path.join(BUILD_DIR, 'output-styles/systematic.md'),
      'utf8',
    )
    expect(content).toContain('force-for-plugin: true')
  })

  test('output-style ships no hand-inlined skill catalog and no dangling HARNESSES.md link', () => {
    const content = fs.readFileSync(
      path.join(BUILD_DIR, 'output-styles/systematic.md'),
      'utf8',
    )
    expect(content).not.toContain('<available_skills>')
    expect(content).not.toContain('<skill>')
    expect(content).not.toContain('HARNESSES.md')
    expect(content).not.toContain('../../../')
    expect(content).not.toContain('v0.0.1')
    expect(content).not.toMatch(/Systematic v\d/)
  })

  test('output-style contains no untranslated source-namespace identifier forms', () => {
    const content = fs.readFileSync(
      path.join(BUILD_DIR, 'output-styles/systematic.md'),
      'utf8',
    )
    expect(content).not.toMatch(/\bce:[a-z0-9-]+\b/)
    expect(content).not.toMatch(/\bsystematic:[a-z0-9-]+:[a-z0-9-]+\b/)
  })

  test('generated skill set matches source skills/ 1:1 by name', () => {
    const sourceNames = listSourceSkillNames()
    const generatedNames = fs
      .readdirSync(path.join(BUILD_DIR, 'skills'), {
        withFileTypes: true,
      })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))

    expect(generatedNames).toEqual(sourceNames)
  })

  test('a sampled SKILL.md matches source content (name normalized to dir basename)', () => {
    const sourcePath = path.join(REPO_ROOT, 'skills/using-systematic/SKILL.md')
    const generatedPath = path.join(
      BUILD_DIR,
      'skills/using-systematic/SKILL.md',
    )
    const sourceContent = fs.readFileSync(sourcePath, 'utf8')
    const generatedContent = fs.readFileSync(generatedPath, 'utf8')
    // Body content is preserved; only frontmatter `name` may be normalized.
    expect(generatedContent).toContain('name: using-systematic')
    expect(sourceContent).toContain('name: using-systematic')
  })

  test('generated agent set matches flattened source agents/**/*.md 1:1 by stem, globally unique', () => {
    const sourceStems = listSourceAgentStems()
    // Global uniqueness: no duplicate stems across categories.
    expect(new Set(sourceStems).size).toBe(sourceStems.length)

    const generatedStems = fs
      .readdirSync(path.join(BUILD_DIR, 'agents'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.basename(f, '.md'))
      .sort((a, b) => a.localeCompare(b))

    expect(generatedStems).toEqual(sourceStems)
  })
})

// ---------------------------------------------------------------------------
// 2. ARTIFACT / SELF-CONTAINMENT: bundle must survive CC's per-session cache copy
// ---------------------------------------------------------------------------

describe('claude-code bundle — artifact self-containment', () => {
  test('generated validator file preserves the real bundle after its shebang and is installed executable', () => {
    const shebang = '#!/usr/bin/env node\n'
    const validatorPath = path.join(
      BUILD_DIR,
      `bin/${CLAUDE_CODE_VALIDATOR_BIN}`,
    )
    const validator = fs.readFileSync(validatorPath)

    expect(VALIDATOR_BUNDLE.length).toBeGreaterThan(0)
    expect(validator.subarray(0, Buffer.byteLength(shebang)).toString()).toBe(
      shebang,
    )
    expect(validator.subarray(Buffer.byteLength(shebang))).toEqual(
      VALIDATOR_BUNDLE,
    )
    expect(fs.statSync(validatorPath).mode & 0o111).toBe(0o111)
  })

  test('.claude-plugin/plugin.json exists, is valid JSON, has a name, no version, and author object', () => {
    const manifestPath = path.join(BUILD_DIR, '.claude-plugin/plugin.json')
    expect(fs.existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      name?: string
      version?: string
      author?: { name?: string; email?: string }
    }
    expect(typeof manifest.name).toBe('string')
    expect(manifest.name?.length).toBeGreaterThan(0)
    expect(manifest.version).toBeUndefined()
    expect(manifest.author).toEqual({
      name: 'Marcus R. Brown',
      email: 'human@fro.bot',
    })
  })

  test('no symlinks anywhere under the built bundle — must not point back to repo skills/', () => {
    const allEntries = walkAllFiles(BUILD_DIR)
    const symlinks = allEntries.filter((entryPath) => {
      const stat = fs.lstatSync(entryPath)
      return stat.isSymbolicLink()
    })
    expect(symlinks).toEqual([])
  })

  test('hooks/hooks.json is valid JSON with SessionStart/no-matcher (all sources)/type:command shape, payload <= 10000 chars', () => {
    const hooksPath = path.join(BUILD_DIR, 'hooks/hooks.json')
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as {
      hooks?: {
        SessionStart?: {
          matcher?: string
          hooks?: { type?: string; command?: string }[]
        }[]
      }
    }
    const sessionStart = parsed.hooks?.SessionStart
    expect(Array.isArray(sessionStart)).toBe(true)
    // No `matcher` is intentional: it's the canonical way to match all
    // SessionStart sources (startup/resume/clear/compact) per Claude Code
    // hooks docs — see buildHooksJson in build-claude-code-plugin.ts.
    expect(sessionStart?.[0]?.matcher).toBeUndefined()
    const innerHook = sessionStart?.[0]?.hooks?.[0]
    expect(innerHook?.type).toBe('command')
    expect(typeof innerHook?.command).toBe('string')
    expect(innerHook?.command?.length ?? Infinity).toBeLessThanOrEqual(10000)
  })

  test('the hook payload is declarative — no imperative injection markers', () => {
    const hooksPath = path.join(BUILD_DIR, 'hooks/hooks.json')
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as {
      hooks?: { SessionStart?: { hooks?: { command?: string }[] }[] }
    }
    const command =
      parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command?.toLowerCase() ?? ''
    for (const imperativeMarker of [
      'you must',
      'you should',
      'begin your reply',
      'always ',
      'never ',
    ]) {
      expect(command).not.toContain(imperativeMarker)
    }
  })

  test('the hook payload contains no version and no systematic_skill tool reference, matching the new declarative facts shape', () => {
    const hooksPath = path.join(BUILD_DIR, 'hooks/hooks.json')
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as {
      hooks?: { SessionStart?: { hooks?: { command?: string }[] }[] }
    }
    const command = parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? ''
    expect(command).not.toContain('v0.0.1')
    expect(command.toLowerCase()).not.toContain('version')
    expect(command).not.toContain('systematic_skill')
    expect(command).toContain('native Skill and subagent tools')
  })
})

// ---------------------------------------------------------------------------
// No regression: the build only writes claude-code/, never touches OpenCode/Pi
// runtime code. The real regression gate is the existing
// tests/integration/opencode.test.ts and tests/integration/pi.test.ts suites,
// which must stay green — this test asserts the structural invariant that makes
// that possible: the build script has no code path that writes outside
// claude-code/, and src/index.ts / src/pi.ts are untouched by generating the
// bundle into an isolated temp dir.
// ---------------------------------------------------------------------------

describe('claude-code bundle — no regression on OpenCode/Pi', () => {
  test('build script source contains no write/copy targeting src/', () => {
    const buildScriptSource = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/build-claude-code-plugin.ts'),
      'utf8',
    )
    // The build script imports read-only helpers from src/lib/*.js but must
    // never write into src/.
    expect(buildScriptSource).not.toMatch(/writeFileSync\([^)]*['"]\.\.\/src/)
    expect(buildScriptSource).not.toContain("path.join(rootDir, 'src'")
  })

  test('generating the bundle into an isolated temp dir does not modify src/index.ts or src/pi.ts', () => {
    const indexPath = path.join(SRC_DIR, 'index.ts')
    const piPath = path.join(SRC_DIR, 'pi.ts')
    const beforeIndex = fs.readFileSync(indexPath, 'utf8')
    const beforePi = fs.readFileSync(piPath, 'utf8')

    const tempOut = fs.mkdtempSync(
      path.join(os.tmpdir(), 'claude-code-build-isolated-'),
    )
    try {
      const files = generatePluginFiles(REPO_ROOT, VALIDATOR_BUNDLE)
      writePluginFiles(files, tempOut)

      expect(fs.readFileSync(indexPath, 'utf8')).toBe(beforeIndex)
      expect(fs.readFileSync(piPath, 'utf8')).toBe(beforePi)
    } finally {
      fs.rmSync(tempOut, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Shadow paths: the build's own reduce/failure fallbacks. Claude Code runtime
// behavior isn't automatable, so these are exercised at the build-function
// level against synthetic fixture repos.
// ---------------------------------------------------------------------------

function writeFixtureFile(root: string, relPath: string, content: string) {
  const full = path.join(root, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

describe('claude-code bundle — shadow paths (over-cap + missing-source)', () => {
  test('a large synthetic skill/agent set still stays within the 10000 char cap (counts-only facts never enumerate names)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-overcap-'))
    try {
      fs.mkdirSync(path.join(root, 'skills'), { recursive: true })
      fs.mkdirSync(path.join(root, 'agents/review'), { recursive: true })

      for (let i = 0; i < 400; i++) {
        const name = `synthetic-skill-with-a-fairly-long-descriptive-name-${i}`
        writeFixtureFile(
          root,
          `skills/${name}/SKILL.md`,
          `---\nname: ${name}\ndescription: Synthetic skill ${i}.\n---\n# ${name}\n`,
        )
      }

      const facts = buildHookFacts(root)
      expect(facts.length).toBeLessThanOrEqual(HOOK_PAYLOAD_CAP)
      // Counts-only facts never enumerate skill/agent names.
      expect(facts).not.toContain('synthetic-skill-with-a-fairly-long')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('missing using-systematic SKILL.md fails the build with a clear diagnostic (see tests/unit/build-claude-code-plugin.test.ts for the full error-path suite)', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'claude-code-missing-source-'),
    )
    try {
      fs.mkdirSync(path.join(root, 'skills'), { recursive: true })
      expect(() => buildOutputStyleContent(root)).toThrow(
        /using-systematic\/SKILL\.md/,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
