/**
 * Regression pins for the shipped connections-researcher definition on each host.
 *
 * These tests read the definition and the loaders; they never run a host. They
 * pin the shape that the real-host proofs in the integration files exercise,
 * so a change that would silently drop a deny entry fails here first. They are
 * not evidence that a host enforces the entries: only an observed deny on a
 * real host is.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { flattenAgents } from '../../scripts/build-claude-code-plugin.js'
import { extractAgentFrontmatter } from '../../src/lib/agents.js'
import { parseFrontmatter } from '../../src/lib/frontmatter.js'
import {
  permissionMapToTriples,
  translatePermissionRules,
} from '../../src/lib/opencode-v2-permissions.js'
import {
  parseDenyBlock,
  readShippedDefinition,
} from '../helpers/connect-delegated-proof.js'

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-connect-iso-'))
  tempDirs.push(dir)
  return dir
}

const definition = readShippedDefinition()

describe('OpenCode loaders', () => {
  const parsed = extractAgentFrontmatter(definition)

  test('the permission mapping reaches the agent config with every deny entry', () => {
    expect(parsed.permission).toEqual({
      bash: 'deny',
      edit: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      task: 'deny',
      external_directory: 'allow',
    })
    expect(parseDenyBlock(definition).sort()).toEqual(
      ['bash', 'edit', 'task', 'webfetch', 'websearch'].sort(),
    )
  })

  test('a string tools line is dropped by the converter, so the denies are the only OpenCode restriction', () => {
    expect(parsed.tools).toBeUndefined()
  })

  test('v2 translation turns bash into a shell deny and task into a subagent deny, and drops no deny', () => {
    const rules = translatePermissionRules(
      permissionMapToTriples(parsed.permission),
    )

    expect(rules).toContainEqual({
      action: 'shell',
      resource: '*',
      effect: 'deny',
    })
    expect(rules).toContainEqual({
      action: 'subagent',
      resource: '*',
      effect: 'deny',
    })
    for (const action of ['edit', 'webfetch', 'websearch']) {
      expect(rules).toContainEqual({ action, resource: '*', effect: 'deny' })
    }
    expect(rules.map((rule) => rule.action)).not.toContain('bash')
    // Reading other projects' checkouts is the researcher's job, so the one
    // allow is the path boundary; everything else is a deny.
    expect(rules.filter((rule) => rule.effect !== 'deny')).toEqual([
      { action: 'external_directory', resource: '*', effect: 'allow' },
    ])
  })

  test('a v2 rule keyed shell: in frontmatter is dropped before it becomes a rule', () => {
    // The v1 name is `bash`. A definition that spelled the v2 name would lose
    // the deny without any error, so the definition must use `bash`.
    const spelledForV2 = definition.replace('  bash: deny', '  shell: deny')
    expect(spelledForV2).not.toBe(definition)

    const permission = extractAgentFrontmatter(spelledForV2).permission

    expect(permission).not.toHaveProperty('shell')
    expect(permission).not.toHaveProperty('bash')
  })
})

describe('Pi and Claude Code tool lines', () => {
  const { data } = parseFrontmatter<Record<string, unknown>>(definition)

  test('the positive allowlist is the capitalized Read, Grep, Glob line', () => {
    expect(data.tools).toBe('Read, Grep, Glob')
  })

  test('a second layer names the shell, write and web tools for Claude Code', () => {
    expect(data.disallowedTools).toBe(
      'Bash, Edit, Write, WebFetch, WebSearch, NotebookEdit',
    )
  })
})

describe('Claude Code definition', () => {
  const claude = Bun.which('claude')

  test('the build moves the definition across unchanged', () => {
    const root = makeTempDir()
    fs.mkdirSync(path.join(root, 'agents/research'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'agents/research/connections-researcher.md'),
      definition,
    )

    const flattened = flattenAgents(root)

    expect(flattened.map((agent) => agent.stem)).toEqual([
      'connections-researcher',
    ])
    expect(flattened[0]?.content.toString('utf8')).toBe(definition)
  })

  // `claude plugin validate` needs no login and never starts a model run. It
  // is a parse check: an agent whose frontmatter fails to parse does not load
  // at all, so tools and disallowedTools would never apply.
  test.skipIf(claude === null)(
    'claude plugin validate accepts the definition and rejects one that does not parse',
    () => {
      const run = (agentsDir: string) =>
        spawnSync(
          claude ?? 'claude',
          ['plugin', 'validate', agentsDir, '--json', '--strict'],
          { encoding: 'utf8' },
        )
      // The validator checks a directory of agents only when it is named
      // `agents`; any other name is read as a plugin root.
      const good = path.join(makeTempDir(), 'agents')
      fs.mkdirSync(good)
      fs.writeFileSync(path.join(good, 'connections-researcher.md'), definition)
      const bad = path.join(makeTempDir(), 'agents')
      fs.mkdirSync(bad)
      fs.writeFileSync(
        path.join(bad, 'connections-researcher.md'),
        '---\nname: [broken\n  : : :\n---\nbody\n',
      )

      expect(run(good).status).toBe(0)
      expect(run(bad).status).not.toBe(0)
    },
    60_000,
  )
})
