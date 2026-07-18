import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildHookFacts,
  buildOutputStyleContent,
  buildPluginManifest,
  checkDrift,
  collectSkillFiles,
  flattenAgents,
  generatePluginFiles,
  HOOK_PAYLOAD_CAP,
  writePluginFiles,
} from '../../scripts/build-claude-code-plugin.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')

const TEMP_ROOTS: string[] = []

function makeFixtureRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cc-plugin-'))
  TEMP_ROOTS.push(tmp)
  fs.mkdirSync(path.join(tmp, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true })
  return tmp
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function writeSkill(
  root: string,
  dirName: string,
  description: string,
  extraFiles: Record<string, string> = {},
): void {
  writeFile(
    root,
    `skills/${dirName}/SKILL.md`,
    `---\nname: ${dirName}\ndescription: ${description}\n---\n# ${dirName}\n`,
  )
  for (const [relPath, content] of Object.entries(extraFiles)) {
    writeFile(root, `skills/${dirName}/${relPath}`, content)
  }
}

function writeAgent(
  root: string,
  category: string,
  name: string,
  description: string,
): void {
  writeFile(
    root,
    `agents/${category}/${name}.md`,
    `---\nname: ${name}\ndescription: ${description}\nmode: subagent\ntemperature: 0.1\n---\nAgent body.\n`,
  )
}

function writeUsingSystematicAndProfile(root: string): void {
  writeFile(
    root,
    'skills/using-systematic/SKILL.md',
    '---\nname: using-systematic\ndescription: test\n---\n\nUsing-systematic body content.\n',
  )
  writeFile(
    root,
    'skills/using-systematic/references/claude-code-profile.md',
    '# Claude Code Capability Profile\n\nProfile body content.\n',
  )
}

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Happy path

describe('generatePluginFiles — happy path', () => {
  test('emits all expected files: manifest, output-style, hooks, skills, agents', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.')
    writeAgent(root, 'review', 'bar', 'Bar agent.')

    const files = generatePluginFiles(root)

    expect(files.has('.claude-plugin/plugin.json')).toBe(true)
    expect(files.has('output-styles/systematic.md')).toBe(true)
    expect(files.has('hooks/hooks.json')).toBe(true)
    expect(files.has('skills/foo/SKILL.md')).toBe(true)
    expect(files.has('skills/using-systematic/SKILL.md')).toBe(true)
    expect(files.has('agents/bar.md')).toBe(true)
  })

  test('a sample skill is byte-identical to source', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.', {
      'references/notes.md': '# Notes\nSome content.\n',
    })

    const files = collectSkillFiles(root)
    const sourceContent = fs.readFileSync(
      path.join(root, 'skills/foo/SKILL.md'),
    )
    const refContent = fs.readFileSync(
      path.join(root, 'skills/foo/references/notes.md'),
    )

    expect(files.get('skills/foo/SKILL.md')?.equals(sourceContent)).toBe(true)
    expect(
      files.get('skills/foo/references/notes.md')?.equals(refContent),
    ).toBe(true)
  })

  test('agents are flattened with unique stems', () => {
    const root = makeFixtureRepo()
    writeAgent(root, 'review', 'bar', 'Bar agent.')
    writeAgent(root, 'workflow', 'baz', 'Baz agent.')

    const flattened = flattenAgents(root)
    const stems = flattened.map((a) => a.stem).sort()

    expect(stems).toEqual(['bar', 'baz'])
  })

  test('output-style contains using-systematic body + CC profile content + catalog, with force-for-plugin: true', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.')

    const content = buildOutputStyleContent(root)

    expect(content).toContain('force-for-plugin: true')
    expect(content).toContain('Using-systematic body content.')
    expect(content).toContain('Profile body content.')
    expect(content).toContain('foo') // catalog entry for the fixture skill
    expect(content).not.toContain('<SYSTEMATIC_WORKFLOWS>')
  })

  test('plugin manifest has required name field', () => {
    const root = makeFixtureRepo()
    const manifest = buildPluginManifest(root)
    expect(manifest.name).toBe('systematic')
    expect(typeof manifest.version).toBe('string')
  })

  test('writePluginFiles produces the file tree on disk deterministically (run twice, no diff)', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.')
    writeAgent(root, 'review', 'bar', 'Bar agent.')

    const outDir = path.join(root, 'out')
    const first = generatePluginFiles(root)
    writePluginFiles(first, outDir)
    const firstSnapshot = fs.readFileSync(
      path.join(outDir, 'output-styles/systematic.md'),
    )

    const second = generatePluginFiles(root)
    writePluginFiles(second, outDir)
    const secondSnapshot = fs.readFileSync(
      path.join(outDir, 'output-styles/systematic.md'),
    )

    expect(firstSnapshot.equals(secondSnapshot)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Edge cases

describe('flattenAgents — stem-uniqueness edge case', () => {
  test('two agents across categories sharing a stem cause a build error', () => {
    const root = makeFixtureRepo()
    writeAgent(root, 'review', 'collide', 'Review collider.')
    writeAgent(root, 'workflow', 'collide', 'Workflow collider.')

    expect(() => flattenAgents(root)).toThrow(/stem collision/i)
  })
})

describe('buildHookFacts — payload cap edge case', () => {
  test('declarative hook payload is within the 10000 char cap for the real repo', () => {
    const facts = buildHookFacts(REPO_ROOT)
    expect(facts.length).toBeLessThanOrEqual(HOOK_PAYLOAD_CAP)
  })

  test('facts are declarative (contain no imperative directive markers)', () => {
    const facts = buildHookFacts(REPO_ROOT)
    expect(facts.toLowerCase()).not.toContain('you must')
    expect(facts.toLowerCase()).not.toContain('you should')
  })
})

// ---------------------------------------------------------------------------
// Error paths

describe('buildOutputStyleContent — error paths', () => {
  test('missing using-systematic/SKILL.md fails the build with a clear diagnostic', () => {
    const root = makeFixtureRepo()
    // No using-systematic SKILL.md written.
    expect(() => buildOutputStyleContent(root)).toThrow(
      /using-systematic\/SKILL\.md/,
    )
  })

  test('missing claude-code-profile.md fails the build with a clear diagnostic', () => {
    const root = makeFixtureRepo()
    writeFile(
      root,
      'skills/using-systematic/SKILL.md',
      '---\nname: using-systematic\ndescription: test\n---\n\nBody.\n',
    )
    // No claude-code-profile.md written.
    expect(() => buildOutputStyleContent(root)).toThrow(
      /claude-code-profile\.md/,
    )
  })
})

// ---------------------------------------------------------------------------
// Integration: drift check

describe('checkDrift — integration', () => {
  test('passes when claude-code/ is in sync with source', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.')
    writeAgent(root, 'review', 'bar', 'Bar agent.')

    const claudeCodeDir = path.join(root, 'claude-code')
    writePluginFiles(generatePluginFiles(root), claudeCodeDir)

    const result = checkDrift(root, claudeCodeDir)
    expect(result.inSync).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
    expect(result.differing).toEqual([])
  })

  test('fails when a source file changed without rebuild', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.')
    writeAgent(root, 'review', 'bar', 'Bar agent.')

    const claudeCodeDir = path.join(root, 'claude-code')
    writePluginFiles(generatePluginFiles(root), claudeCodeDir)

    // Mutate source after the build without regenerating claude-code/.
    writeFile(
      root,
      'skills/foo/SKILL.md',
      '---\nname: foo\ndescription: Foo skill (changed).\n---\n# foo changed\n',
    )

    const result = checkDrift(root, claudeCodeDir)
    expect(result.inSync).toBe(false)
    expect(result.differing).toContain('skills/foo/SKILL.md')
  })

  test('--check passes against the real repo committed claude-code/', () => {
    const result = Bun.spawnSync(
      [
        'bun',
        path.join(REPO_ROOT, 'scripts/build-claude-code-plugin.ts'),
        '--check',
      ],
      { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('up to date')
  })
})
