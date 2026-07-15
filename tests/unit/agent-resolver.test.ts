import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildAgentCatalog,
  DEFAULT_READONLY_TOOLS,
  renderAgentCatalogCompact,
  resolveAgent,
  resolveToolAllowlist,
} from '../../src/lib/agent-resolver.js'

function makeTempAgentsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-resolver-test-'))
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return dir
}

describe('buildAgentCatalog', () => {
  test('flattens categorized agents into a category-free catalog', () => {
    const dir = makeTempAgentsDir({
      'research/git-analyzer.md': `---
name: git-analyzer
description: Analyzes git history
---
Be a git historian.`,
      'review/security-reviewer.md': `---
name: security-reviewer
description: Reviews for security issues
tools: Read, Grep, Glob, Bash
---
Be a security reviewer.`,
    })

    const catalog = buildAgentCatalog(dir)
    expect(catalog.map((e) => e.name).sort()).toEqual([
      'git-analyzer',
      'security-reviewer',
    ])
    const security = resolveAgent(catalog, 'security-reviewer')
    expect(security?.description).toBe('Reviews for security issues')
    expect(security?.body.trim()).toBe('Be a security reviewer.')
    expect(security?.toolsSource).toBe('Read, Grep, Glob, Bash')

    const git = resolveAgent(catalog, 'git-analyzer')
    expect(git?.toolsSource).toBeUndefined()
  })

  test('a body line beginning "tools:" is never mistaken for a frontmatter declaration', () => {
    const dir = makeTempAgentsDir({
      'a/persona.md': `---
name: persona
description: Has a body line that looks like a tools declaration
---
Some instructions here.

tools: this is body prose, not frontmatter, and must not be read as a policy.`,
    })

    const catalog = buildAgentCatalog(dir)
    const entry = resolveAgent(catalog, 'persona')
    expect(entry?.toolsSource).toBeUndefined()
  })

  test('is deterministically sorted by name', () => {
    const dir = makeTempAgentsDir({
      'a/zeta.md': '---\nname: zeta\ndescription: Z\n---\nZ body',
      'b/alpha.md': '---\nname: alpha\ndescription: A\n---\nA body',
    })

    const catalog = buildAgentCatalog(dir)
    expect(catalog.map((e) => e.name)).toEqual(['alpha', 'zeta'])
  })

  test('fails closed on duplicate persona names across categories', () => {
    const dir = makeTempAgentsDir({
      'research/dup.md': '---\nname: dup\ndescription: One\n---\nBody one',
      'review/dup.md': '---\nname: dup\ndescription: Two\n---\nBody two',
    })

    expect(() => buildAgentCatalog(dir)).toThrow(/Duplicate persona name/)
  })

  test('resolveAgent returns undefined for unknown persona', () => {
    const dir = makeTempAgentsDir({
      'a/known.md': '---\nname: known\ndescription: K\n---\nBody',
    })
    const catalog = buildAgentCatalog(dir)
    expect(resolveAgent(catalog, 'unknown')).toBeUndefined()
  })

  test('fails closed on malformed YAML frontmatter, naming the source file', () => {
    const dir = makeTempAgentsDir({
      'a/broken.md': '---\nname: [unterminated\n---\nBody',
    })
    expect(() => buildAgentCatalog(dir)).toThrow(/broken\.md/)
  })

  test('fails closed on missing name', () => {
    const dir = makeTempAgentsDir({
      'a/noname.md': '---\ndescription: Has no name\n---\nBody',
    })
    expect(() => buildAgentCatalog(dir)).toThrow(/noname\.md.*name/s)
  })

  test('fails closed on empty name', () => {
    const dir = makeTempAgentsDir({
      'a/emptyname.md': '---\nname: ""\ndescription: D\n---\nBody',
    })
    expect(() => buildAgentCatalog(dir)).toThrow(/emptyname\.md.*name/s)
  })

  test('fails closed on missing description', () => {
    const dir = makeTempAgentsDir({
      'a/nodesc.md': '---\nname: nodesc\n---\nBody',
    })
    expect(() => buildAgentCatalog(dir)).toThrow(/nodesc\.md.*description/s)
  })

  test('fails closed on empty description', () => {
    const dir = makeTempAgentsDir({
      'a/emptydesc.md': '---\nname: emptydesc\ndescription: "  "\n---\nBody',
    })
    expect(() => buildAgentCatalog(dir)).toThrow(/emptydesc\.md.*description/s)
  })

  test('fails closed on empty prompt body', () => {
    const dir = makeTempAgentsDir({
      'a/emptybody.md': '---\nname: emptybody\ndescription: D\n---\n   \n',
    })
    expect(() => buildAgentCatalog(dir)).toThrow(/emptybody\.md.*body/s)
  })

  test('fails closed on an unknown declared tool, naming the source file', () => {
    const dir = makeTempAgentsDir({
      'a/bad-tool.md':
        '---\nname: bad-tool\ndescription: D\ntools: Read, Frobnicate\n---\nBody',
    })
    expect(() => buildAgentCatalog(dir)).toThrow(/bad-tool\.md/)
    expect(() => buildAgentCatalog(dir)).toThrow(/Frobnicate/)
  })

  test('fails closed on a Task declaration, naming the source file', () => {
    const dir = makeTempAgentsDir({
      'a/self-delegating.md':
        '---\nname: self-delegating\ndescription: D\ntools: Read, Task\n---\nBody',
    })
    expect(() => buildAgentCatalog(dir)).toThrow(/self-delegating\.md/)
    expect(() => buildAgentCatalog(dir)).toThrow(/Task/)
  })

  test('fails closed on an unsupported tools YAML shape (map), naming the source file', () => {
    const dir = makeTempAgentsDir({
      'a/map-tools.md':
        '---\nname: map-tools\ndescription: D\ntools:\n  Read: true\n---\nBody',
    })
    expect(() => buildAgentCatalog(dir)).toThrow(/map-tools\.md/)
  })

  test('fails closed on an unsupported tools YAML shape (array), naming the source file', () => {
    const dir = makeTempAgentsDir({
      'a/array-tools.md':
        '---\nname: array-tools\ndescription: D\ntools:\n  - Read\n  - Grep\n---\nBody',
    })
    expect(() => buildAgentCatalog(dir)).toThrow(/array-tools\.md/)
  })

  test('fails closed on an empty tools declaration, naming the source file', () => {
    const dir = makeTempAgentsDir({
      'a/empty-tools.md':
        '---\nname: empty-tools\ndescription: D\ntools: ""\n---\nBody',
    })
    expect(() => buildAgentCatalog(dir)).toThrow(/empty-tools\.md/)
  })
})

describe('renderAgentCatalogCompact', () => {
  test('renders deterministic bullet list', () => {
    const dir = makeTempAgentsDir({
      'a/one.md': '---\nname: one\ndescription: First persona\n---\nBody',
      'b/two.md': '---\nname: two\ndescription: Second persona\n---\nBody',
    })
    const catalog = buildAgentCatalog(dir)
    expect(renderAgentCatalogCompact(catalog)).toBe(
      '- one: First persona\n- two: Second persona',
    )
  })

  test('renders explicit empty-catalog message', () => {
    expect(renderAgentCatalogCompact([])).toBe(
      'No Systematic personas are currently available.',
    )
  })
})

describe('resolveToolAllowlist', () => {
  test('undeclared tools defaults to the read-only allowlist', () => {
    expect(resolveToolAllowlist(undefined)).toEqual({
      tools: [...DEFAULT_READONLY_TOOLS],
    })
  })

  test('maps known declared OpenCode tool names to Pi built-ins', () => {
    expect(resolveToolAllowlist('Read, Grep, Glob, Edit, Write, Bash')).toEqual(
      {
        tools: ['read', 'grep', 'find', 'edit', 'write', 'bash'],
      },
    )
  })

  test('maps Edit and Write defensively when declared', () => {
    expect(resolveToolAllowlist('Read, Edit, Write')).toEqual({
      tools: ['read', 'edit', 'write'],
    })
  })

  test('fails closed on an unknown declared tool name', () => {
    expect(() => resolveToolAllowlist('Read, Frobnicate')).toThrow(
      /Unknown declared tool "Frobnicate"/,
    )
    try {
      resolveToolAllowlist('Read, Frobnicate')
      throw new Error('expected resolveToolAllowlist to throw')
    } catch (error) {
      expect(error instanceof Error).toBe(true)
      expect((error as Error).name).toBe('UnknownDeclaredToolError')
    }
  })

  test('fails closed on Task; delegation must never map into the child', () => {
    expect(() => resolveToolAllowlist('Read, Task')).toThrow(
      /Unknown declared tool "Task"/,
    )
  })
})

describe('real bundled agents catalog', () => {
  test('builds without throwing and every persona name is unique', () => {
    const agentsDir = path.resolve(import.meta.dirname, '../../agents')
    const catalog = buildAgentCatalog(agentsDir)
    expect(catalog.length).toBeGreaterThan(0)
    const names = catalog.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('every real declared tools source resolves to a known allowlist', () => {
    const agentsDir = path.resolve(import.meta.dirname, '../../agents')
    const catalog = buildAgentCatalog(agentsDir)
    for (const entry of catalog) {
      expect(() => resolveToolAllowlist(entry.toolsSource)).not.toThrow()
    }
  })

  test('real write personas resolve Edit/Write-capable allowlists and undeclared personas stay read-only', () => {
    const agentsDir = path.resolve(import.meta.dirname, '../../agents')
    const catalog = buildAgentCatalog(agentsDir)

    expect(
      resolveToolAllowlist(
        resolveAgent(catalog, 'systematic-implementer')?.toolsSource,
      ),
    ).toEqual({
      tools: ['read', 'grep', 'find', 'edit', 'write', 'bash'],
    })
    expect(
      resolveToolAllowlist(
        resolveAgent(catalog, 'design-iterator')?.toolsSource,
      ),
    ).toEqual({
      tools: ['read', 'grep', 'find', 'edit', 'write', 'bash'],
    })
    expect(
      resolveToolAllowlist(
        resolveAgent(catalog, 'git-history-analyzer')?.toolsSource,
      ),
    ).toEqual({
      tools: [...DEFAULT_READONLY_TOOLS],
    })
  })
})
