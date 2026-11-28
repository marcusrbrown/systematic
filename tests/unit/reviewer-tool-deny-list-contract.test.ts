/**
 * Contract tests for the tool deny list the review agents ship.
 *
 * Each file under `agents/review/` carries the same ordered `permission:`
 * block: thirteen tool names, each `deny`. It names no `'*'` key and sets
 * nothing for `read`, `bash` or `external_directory`, so a user's own rules
 * for those still apply. These tests parse the shipped YAML through the real
 * frontmatter parsers, so a misspelt setting, a reordered key or an allow
 * fails here and names the file. The `tools:` line stays for Pi and Claude
 * Code.
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { extractAgentFrontmatter } from '../../src/lib/agents.js'
import { parseFrontmatter } from '../../src/lib/frontmatter.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const REVIEW_DIR = path.join(REPO_ROOT, 'agents/review')
const DOCUMENT_REVIEW_DIR = path.join(REPO_ROOT, 'agents/document-review')
const CONNECTIONS_RESEARCHER = path.join(
  REPO_ROOT,
  'agents/research/connections-researcher.md',
)

const DENIED_TOOLS = [
  'edit',
  'task',
  'skill',
  'systematic_skill',
  'websearch',
  'question',
  'todowrite',
  'generate_image',
  'generate_video',
  'session_list',
  'session_info',
  'session_search',
  'session_read',
] as const

/** Keys a reviewer block must never carry: the user's rules decide these. */
const UNSET_KEYS = [
  '*',
  'read',
  'grep',
  'glob',
  'bash',
  'webfetch',
  'systematic_search',
  'execute',
  'external_directory',
] as const

const REVIEW_TOOLS_LINE = 'Read, Grep, Glob, Bash'

interface ShippedAgent {
  file: string
  parseError: boolean
  rawKeys: string[]
  rawTools: unknown
  permission: [string, unknown][] | undefined
}

function agentFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort()
}

function readAgent(dir: string, name: string): ShippedAgent {
  const content = fs.readFileSync(path.join(dir, name), 'utf8')
  const raw = parseFrontmatter(content)
  const { permission } = extractAgentFrontmatter(content)
  return {
    file: `${path.basename(dir)}/${name}`,
    parseError: raw.parseError,
    rawKeys: Object.keys(raw.data),
    rawTools: raw.data.tools,
    permission:
      permission === undefined ? undefined : Object.entries(permission),
  }
}

const reviewers = agentFiles(REVIEW_DIR).map((name) =>
  readAgent(REVIEW_DIR, name),
)

describe('review agent tool deny list', () => {
  test('there are exactly 18 review agents', () => {
    expect(reviewers.map((r) => r.file)).toHaveLength(18)
  })

  for (const agent of reviewers) {
    describe(agent.file, () => {
      test('frontmatter parses', () => {
        expect(
          agent.parseError,
          `${agent.file}: frontmatter failed to parse`,
        ).toBe(false)
      })

      test('carries exactly the thirteen denied tools, in order', () => {
        expect(
          agent.permission?.map(([key]) => key),
          `${agent.file}: permission keys differ from the decided list`,
        ).toEqual([...DENIED_TOOLS])
      })

      test('every value is deny', () => {
        for (const [key, value] of agent.permission ?? []) {
          expect(value, `${agent.file}: ${key}`).toBe('deny')
        }
      })

      test('sets nothing for the tools and directories the user decides', () => {
        const keys = (agent.permission ?? []).map(([key]) => key)
        for (const key of UNSET_KEYS) {
          expect(keys, `${agent.file}: carries a ${key} key`).not.toContain(key)
        }
        const values = (agent.permission ?? []).map(([, value]) => value)
        expect(values, `${agent.file}: carries an allow`).not.toContain('allow')
        expect(values, `${agent.file}: carries an ask`).not.toContain('ask')
      })

      test('keeps the tools line for Pi and Claude Code, directly before permission', () => {
        expect(agent.rawTools, `${agent.file}: tools line`).toBe(
          REVIEW_TOOLS_LINE,
        )
        expect(
          agent.rawKeys.indexOf('permission'),
          `${agent.file}: permission position`,
        ).toBe(agent.rawKeys.indexOf('tools') + 1)
      })
    })
  }

  test('all 18 blocks are equal', () => {
    const [first, ...rest] = reviewers
    expect(first?.permission).toBeDefined()
    for (const agent of rest) {
      expect(
        agent.permission,
        `${agent.file}: differs from ${first?.file}`,
      ).toEqual(first?.permission)
    }
  })
})

describe('agents outside the review deny list', () => {
  const documentReviewers = agentFiles(DOCUMENT_REVIEW_DIR).map((name) =>
    readAgent(DOCUMENT_REVIEW_DIR, name),
  )

  test('there are exactly 7 document-review agents', () => {
    expect(documentReviewers).toHaveLength(7)
  })

  for (const agent of documentReviewers) {
    test(`${agent.file} has no permission block`, () => {
      expect(
        agent.rawKeys,
        `${agent.file}: carries a permission key`,
      ).not.toContain('permission')
      expect(agent.permission, `${agent.file}: permission`).toBeUndefined()
    })
  }

  test('connections-researcher keeps its existing block', () => {
    const agent = readAgent(
      path.dirname(CONNECTIONS_RESEARCHER),
      path.basename(CONNECTIONS_RESEARCHER),
    )
    expect(agent.permission, `${agent.file}: permission`).toEqual([
      ['bash', 'deny'],
      ['edit', 'deny'],
      ['webfetch', 'deny'],
      ['websearch', 'deny'],
      ['task', 'deny'],
      ['external_directory', 'allow'],
    ])
  })
})
