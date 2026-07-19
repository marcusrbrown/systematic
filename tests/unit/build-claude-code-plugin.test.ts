import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildHookFacts,
  buildHooksJson,
  buildOutputStyleContent,
  buildPluginManifest,
  buildSourceInventory,
  checkGeneratedNamespace,
  collectSkillFiles,
  flattenAgents,
  generatePluginFiles,
  HOOK_PAYLOAD_CAP,
  translateIdentifiers,
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

  test('output-style contains using-systematic body + CC profile content, with force-for-plugin: true, no catalog', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.')

    const content = buildOutputStyleContent(root)

    expect(content).toContain('force-for-plugin: true')
    expect(content).toContain('Using-systematic body content.')
    expect(content).toContain('Profile body content.')
    expect(content).not.toContain('<SYSTEMATIC_WORKFLOWS>')
    expect(content).not.toContain('<available_skills>')
    expect(content).not.toContain('<skill>')
  })

  test('output-style contains no <location> tag (absolute machine paths must not leak into the bundle)', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.')

    const content = buildOutputStyleContent(root)

    expect(content).not.toContain('<location>')
  })

  test('output-style contains no dangling repo-internal HARNESSES.md link', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.')

    const content = buildOutputStyleContent(root)

    expect(content).not.toContain('HARNESSES.md')
    expect(content).not.toContain('../../../')
  })

  test('output-style contains no harness-specific skill-loading tool phrasing', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.')

    const content = buildOutputStyleContent(root)

    expect(content).not.toContain('Invoke `systematic_skill` tool')
    expect(content).not.toContain('systematic_skill tool to load')
  })

  test('output-style is byte-identical regardless of the absolute rootDir path', () => {
    const rootA = makeFixtureRepo()
    writeUsingSystematicAndProfile(rootA)
    writeSkill(rootA, 'foo', 'Foo skill.')

    const rootB = makeFixtureRepo()
    writeUsingSystematicAndProfile(rootB)
    writeSkill(rootB, 'foo', 'Foo skill.')

    expect(rootA).not.toBe(rootB)

    const contentA = buildOutputStyleContent(rootA)
    const contentB = buildOutputStyleContent(rootB)

    expect(contentA).toBe(contentB)
    expect(contentA).not.toContain('/Users/')
    expect(contentA).not.toContain('file://')
  })

  test('plugin manifest has required name field, no version, and author object', () => {
    const root = makeFixtureRepo()
    const manifest = buildPluginManifest(root)
    expect(manifest.name).toBe('systematic')
    expect(manifest).not.toHaveProperty('version')
    expect(manifest.author).toEqual({
      name: 'Marcus R. Brown',
      email: 'human@fro.bot',
    })
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

describe('flattenAgents — hardened collision detection (frontmatter name, fold, fail-closed)', () => {
  test('two agents with distinct stems but colliding frontmatter name fail the build', () => {
    const root = makeFixtureRepo()
    writeFile(
      root,
      'agents/review/alpha.md',
      '---\nname: shared-dispatch\ndescription: Alpha agent.\nmode: subagent\ntemperature: 0.1\n---\nAgent body.\n',
    )
    writeFile(
      root,
      'agents/workflow/beta.md',
      '---\nname: shared-dispatch\ndescription: Beta agent.\nmode: subagent\ntemperature: 0.1\n---\nAgent body.\n',
    )

    expect(() => flattenAgents(root)).toThrow(/frontmatter "name" collision/i)
  })

  test('two agent stems differing only by case fail the build (case-fold collision)', () => {
    const root = makeFixtureRepo()
    writeAgent(root, 'review', 'Reviewer', 'Reviewer agent.')
    writeAgent(root, 'workflow', 'reviewer', 'reviewer agent (lowercase).')

    expect(() => flattenAgents(root)).toThrow(/stem collision/i)
  })

  test('two agent stems differing only by Unicode normalization form fail the build (NFC-fold collision)', () => {
    const root = makeFixtureRepo()
    // "café" as precomposed NFC (é = U+00E9) vs decomposed NFD (e + combining acute U+0301).
    const nfc = 'caf\u00e9'
    const nfd = 'cafe\u0301'
    expect(nfc).not.toBe(nfd)
    expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC'))

    writeAgent(root, 'review', nfc, 'NFC agent.')
    writeAgent(root, 'workflow', nfd, 'NFD agent.')

    expect(() => flattenAgents(root)).toThrow(/stem collision/i)
  })

  test('missing frontmatter name fails the build closed', () => {
    const root = makeFixtureRepo()
    writeFile(
      root,
      'agents/review/no-name.md',
      '---\ndescription: No name agent.\nmode: subagent\ntemperature: 0.1\n---\nAgent body.\n',
    )

    expect(() => flattenAgents(root)).toThrow(
      /missing a non-empty frontmatter "name"/i,
    )
  })

  test('empty frontmatter name fails the build closed', () => {
    const root = makeFixtureRepo()
    writeFile(
      root,
      'agents/review/blank-name.md',
      '---\nname: "  "\ndescription: Blank name agent.\nmode: subagent\ntemperature: 0.1\n---\nAgent body.\n',
    )

    expect(() => flattenAgents(root)).toThrow(
      /missing a non-empty frontmatter "name"/i,
    )
  })

  test('two agents with distinct stems and distinct names still flatten cleanly (no false positive)', () => {
    const root = makeFixtureRepo()
    writeAgent(root, 'review', 'bar', 'Bar agent.')
    writeAgent(root, 'workflow', 'baz', 'Baz agent.')

    const flattened = flattenAgents(root)
    expect(flattened.map((a) => a.stem).sort()).toEqual(['bar', 'baz'])
  })

  test('a numeric frontmatter name fails the build fail-closed with a wrong-type message (not "missing")', () => {
    const root = makeFixtureRepo()
    writeFile(
      root,
      'agents/review/numeric-name.md',
      '---\nname: 123\ndescription: Numeric name agent.\nmode: subagent\ntemperature: 0.1\n---\nAgent body.\n',
    )

    expect(() => flattenAgents(root)).toThrow(
      /frontmatter "name" of type number/i,
    )
    expect(() => flattenAgents(root)).not.toThrow(/missing a non-empty/i)
  })

  test('a boolean frontmatter name fails the build fail-closed with a wrong-type message (not "missing")', () => {
    const root = makeFixtureRepo()
    writeFile(
      root,
      'agents/review/boolean-name.md',
      '---\nname: true\ndescription: Boolean name agent.\nmode: subagent\ntemperature: 0.1\n---\nAgent body.\n',
    )

    expect(() => flattenAgents(root)).toThrow(
      /frontmatter "name" of type boolean/i,
    )
    expect(() => flattenAgents(root)).not.toThrow(/missing a non-empty/i)
  })
})

describe('buildHooksJson — SessionStart matcher omission', () => {
  test('the SessionStart entry has no "matcher" field (matches all sources: startup, resume, clear, compact)', () => {
    const root = makeFixtureRepo()
    const hooksJson = buildHooksJson(root)

    const [sessionStartEntry] = hooksJson.hooks.SessionStart
    expect(sessionStartEntry).toBeDefined()
    expect(sessionStartEntry).not.toHaveProperty('matcher')
    expect(Object.keys(sessionStartEntry ?? {})).toEqual(['hooks'])
  })

  test('the SessionStart command hook array is unchanged in shape', () => {
    const root = makeFixtureRepo()
    const hooksJson = buildHooksJson(root)

    const [sessionStartEntry] = hooksJson.hooks.SessionStart
    expect(sessionStartEntry?.hooks).toHaveLength(1)
    expect(sessionStartEntry?.hooks[0]?.type).toBe('command')
    expect(sessionStartEntry?.hooks[0]?.command).toContain('printf')
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

  test('facts contain no version and no enumerated skill/agent names', () => {
    const facts = buildHookFacts(REPO_ROOT)
    expect(facts).not.toContain('v0.0.1')
    expect(facts.toLowerCase()).not.toContain('version')
    expect(facts).toContain('native Skill and subagent tools')
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
// Identifier translation

describe('translateIdentifiers — inventory-driven rewrite', () => {
  test('ce:<x> rewrites to systematic:ce-<x> when skills/ce-<x>/ exists', () => {
    const inventory = {
      skillDirs: new Set(['ce-brainstorm']),
      agentStems: new Set<string>(),
    }
    expect(translateIdentifiers('Use ce:brainstorm now.', inventory)).toBe(
      'Use systematic:ce-brainstorm now.',
    )
  })

  test('a leading-slash invocation form is translated, preserving the slash', () => {
    const inventory = {
      skillDirs: new Set(['ce-plan']),
      agentStems: new Set<string>(),
    }
    expect(translateIdentifiers('Run /ce:plan to start.', inventory)).toBe(
      'Run /systematic:ce-plan to start.',
    )
  })

  test('qualified systematic:<category>:<name> rewrites to systematic:<name>', () => {
    const inventory = {
      skillDirs: new Set<string>(),
      agentStems: new Set(['correctness-reviewer']),
    }
    expect(
      translateIdentifiers(
        'Dispatch systematic:review:correctness-reviewer.',
        inventory,
      ),
    ).toBe('Dispatch systematic:correctness-reviewer.')
  })

  test('bare systematic:<name> that resolves to a bundled skill is left unchanged', () => {
    const inventory = {
      skillDirs: new Set(['frontend-design']),
      agentStems: new Set<string>(),
    }
    expect(
      translateIdentifiers('Load systematic:frontend-design.', inventory),
    ).toBe('Load systematic:frontend-design.')
  })

  test('a reference inside a fenced code block is still translated (no fence exemption)', () => {
    const inventory = {
      skillDirs: new Set(['ce-brainstorm']),
      agentStems: new Set<string>(),
    }
    const content = '```\nce:brainstorm\n```\n'
    expect(translateIdentifiers(content, inventory)).toBe(
      '```\nsystematic:ce-brainstorm\n```\n',
    )
  })

  test('an unknown ce:<name> with no matching skill dir is left untouched (not fabricated)', () => {
    const inventory = {
      skillDirs: new Set(['ce-brainstorm']),
      agentStems: new Set<string>(),
    }
    expect(translateIdentifiers('See ce:nonexistent.', inventory)).toBe(
      'See ce:nonexistent.',
    )
  })
})

describe('buildSourceInventory', () => {
  test('collects skill dir names and agent stems from a fixture repo', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'foo', 'Foo skill.')
    writeAgent(root, 'review', 'bar', 'Bar agent.')

    const inventory = buildSourceInventory(root)
    expect(inventory.skillDirs.has('foo')).toBe(true)
    expect(inventory.agentStems.has('bar')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Generated-namespace integrity gate

describe('checkGeneratedNamespace — integrity gate', () => {
  test('passes on a clean, fully-translated bundle', () => {
    const inventory = {
      skillDirs: new Set(['foo']),
      agentStems: new Set(['bar']),
    }
    const files = new Map<string, Buffer>([
      [
        'skills/foo/SKILL.md',
        Buffer.from('---\nname: foo\n---\nDispatch systematic:bar.\n'),
      ],
      ['agents/bar.md', Buffer.from('Agent body referencing systematic:foo.')],
    ])
    expect(() => checkGeneratedNamespace(files, inventory)).not.toThrow()
  })

  test('fails when a leftover qualified systematic:<category>:<name> ref remains', () => {
    const inventory = {
      skillDirs: new Set(['foo']),
      agentStems: new Set(['bar']),
    }
    const files = new Map<string, Buffer>([
      [
        'skills/foo/SKILL.md',
        Buffer.from('---\nname: foo\n---\nDispatch systematic:review:bar.\n'),
      ],
    ])
    expect(() => checkGeneratedNamespace(files, inventory)).toThrow(
      /untranslated qualified identifier/,
    )
  })

  test('fails when a leftover source ce:<name> form remains', () => {
    const inventory = {
      skillDirs: new Set(['ce-brainstorm']),
      agentStems: new Set<string>(),
    }
    const files = new Map<string, Buffer>([
      [
        'skills/ce-brainstorm/SKILL.md',
        Buffer.from('---\nname: ce-brainstorm\n---\nSee ce:brainstorm.\n'),
      ],
    ])
    expect(() => checkGeneratedNamespace(files, inventory)).toThrow(
      /untranslated source identifier/,
    )
  })

  test('fails when a bare systematic:<name> does not resolve to any bundled skill or agent', () => {
    const inventory = {
      skillDirs: new Set(['foo']),
      agentStems: new Set<string>(),
    }
    const files = new Map<string, Buffer>([
      [
        'skills/foo/SKILL.md',
        Buffer.from('---\nname: foo\n---\nSee systematic:nonexistent.\n'),
      ],
    ])
    expect(() => checkGeneratedNamespace(files, inventory)).toThrow(
      /does not resolve to any bundled skill or agent/,
    )
  })

  test('generatePluginFiles throws when a fixture body contains an unresolvable ce:<name> ref', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill referencing ce:nonexistent for context.')
    writeAgent(root, 'review', 'bar', 'Bar agent.')

    expect(() => generatePluginFiles(root)).toThrow(
      /untranslated source identifier/,
    )
  })
})

// ---------------------------------------------------------------------------
// Real repo build (temp dir — the bundle is never committed)

describe('writePluginFiles — atomic staging write', () => {
  test('produces the full expected tree in outDir on success', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.')
    writeAgent(root, 'review', 'bar', 'Bar agent.')

    const outDir = path.join(root, 'out')
    const files = generatePluginFiles(root)
    writePluginFiles(files, outDir)

    expect(fs.existsSync(path.join(outDir, '.claude-plugin/plugin.json'))).toBe(
      true,
    )
    expect(fs.existsSync(path.join(outDir, 'agents/bar.md'))).toBe(true)
  })

  test('leaves no stray staging temp dir or backup dir behind after a successful write', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.')

    const outDir = path.join(root, 'out')
    const files = generatePluginFiles(root)
    writePluginFiles(files, outDir)

    const siblingEntries = fs.readdirSync(root)
    const strayDirs = siblingEntries.filter(
      (name) =>
        name.startsWith('.out-staging-') || name.startsWith('.out-old-'),
    )
    expect(strayDirs).toEqual([])
  })

  test('leaves no stray staging or backup dir after a second successful write over a prior bundle', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill.')

    const outDir = path.join(root, 'out')
    const files = generatePluginFiles(root)
    writePluginFiles(files, outDir) // first write (outDir does not yet exist)
    writePluginFiles(files, outDir) // second write (outDir exists — exercises rename-aside)

    expect(fs.existsSync(path.join(outDir, '.claude-plugin/plugin.json'))).toBe(
      true,
    )
    const siblingEntries = fs.readdirSync(root)
    const strayDirs = siblingEntries.filter(
      (name) =>
        name.startsWith('.out-staging-') || name.startsWith('.out-old-'),
    )
    expect(strayDirs).toEqual([])
  })

  test('a pre-swap failure (simulated by an unwritable temp path) leaves the prior outDir untouched and cleans up the temp dir', () => {
    const root = makeFixtureRepo()
    const outDir = path.join(root, 'out')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'sentinel.txt'), 'prior bundle\n')

    // Force a write failure by including a file path with a bad relative
    // path outside a plausible bundle shape is hard to trigger generically,
    // so instead we assert the ordering contract directly: a thrown error
    // during the write loop must not have already removed outDir, and must
    // not leave a temp staging dir behind.
    const badFiles = new Map<string, Buffer>([
      // A relPath that collides with a directory-vs-file conflict forces
      // fs.writeFileSync to throw after mkdirSync succeeds for the first
      // entry, simulating a mid-build failure.
      ['a', Buffer.from('first')],
      ['a/b.md', Buffer.from('second')],
    ])

    expect(() => writePluginFiles(badFiles, outDir)).toThrow()

    // outDir (the prior bundle) must still exist and be untouched — the
    // rename never happened because the write loop failed first (before
    // outDir was ever renamed aside).
    expect(fs.existsSync(path.join(outDir, 'sentinel.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(outDir, 'sentinel.txt'), 'utf8')).toBe(
      'prior bundle\n',
    )

    // No leftover staging temp dir or aside backup.
    const siblingEntries = fs.readdirSync(root)
    const strayDirs = siblingEntries.filter(
      (name) =>
        name.startsWith('.out-staging-') || name.startsWith('.out-old-'),
    )
    expect(strayDirs).toEqual([])
  })

  test('a swap-rename failure (renameSync(tempDir, outDir) throws) restores the prior bundle and leaves no stray dirs', () => {
    const root = makeFixtureRepo()
    const outDir = path.join(root, 'out')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'sentinel.txt'), 'prior bundle\n')

    const files = new Map<string, Buffer>([
      ['agents/new.md', Buffer.from('new bundle content\n')],
    ])

    const originalRenameSync = fs.renameSync.bind(fs)
    let swapAttempts = 0
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(
      (src: fs.PathLike, dest: fs.PathLike) => {
        // Let the aside-rename (outDir -> backup) succeed. Fail only the
        // FIRST swap-rename (tempDir -> outDir) to simulate a crash
        // mid-swap; the subsequent restore-rename (backup -> outDir) must
        // still succeed so the prior bundle actually comes back.
        if (String(dest) === outDir) {
          swapAttempts += 1
          if (swapAttempts === 1) {
            throw new Error('simulated swap-rename failure')
          }
        }
        return originalRenameSync(src, dest)
      },
    )

    try {
      expect(() => writePluginFiles(files, outDir)).toThrow(
        /simulated swap-rename failure/,
      )
    } finally {
      renameSpy.mockRestore()
    }

    // The prior bundle must be restored intact at outDir.
    expect(fs.existsSync(path.join(outDir, 'sentinel.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(outDir, 'sentinel.txt'), 'utf8')).toBe(
      'prior bundle\n',
    )
    expect(fs.existsSync(path.join(outDir, 'agents/new.md'))).toBe(false)

    // No leftover staging temp dir or aside backup dir.
    const siblingEntries = fs.readdirSync(root)
    const strayDirs = siblingEntries.filter(
      (name) =>
        name.startsWith('.out-staging-') || name.startsWith('.out-old-'),
    )
    expect(strayDirs).toEqual([])
  })

  test('checkGeneratedNamespace gate failure prevents any claude-code/ output (gate runs before swap)', () => {
    const root = makeFixtureRepo()
    writeUsingSystematicAndProfile(root)
    writeSkill(root, 'foo', 'Foo skill referencing ce:nonexistent for context.')
    writeAgent(root, 'review', 'bar', 'Bar agent.')

    const outDir = path.join(root, 'claude-code')

    expect(() => generatePluginFiles(root)).toThrow(
      /untranslated source identifier/,
    )
    // generatePluginFiles throws before writePluginFiles is ever called in
    // the real main() flow — assert the outDir was never created.
    expect(fs.existsSync(outDir)).toBe(false)
  })
})

describe('build — real repo, temp dir', () => {
  test('building the real repo into a temp dir succeeds and passes the integrity gate', () => {
    const tempOut = fs.mkdtempSync(
      path.join(os.tmpdir(), 'claude-code-real-build-'),
    )
    try {
      const files = generatePluginFiles(REPO_ROOT)
      writePluginFiles(files, tempOut)
      expect(
        fs.existsSync(path.join(tempOut, '.claude-plugin/plugin.json')),
      ).toBe(true)
    } finally {
      fs.rmSync(tempOut, { recursive: true, force: true })
    }
  })
})
