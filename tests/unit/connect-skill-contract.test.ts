/**
 * Contract tests for the `ce:connect` skill, its references and the
 * `connections-researcher` agent.
 *
 * Skill text is not code, so these tests pin the facts a run depends on: the
 * names the helper and the host guard key on, the exact terminal lines, the
 * mode tokens, and the limits the helper enforces. They do not show how a live
 * model behaves; the baseline and pressure runs recorded with the change do.
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { isValidAgentColor } from '../../src/lib/agent-colors.js'
import {
  buildAgentCatalog,
  resolveToolAllowlist,
} from '../../src/lib/agent-resolver.js'
import { CONNECT_HOSTS } from '../../src/lib/connect-config.js'
import {
  BATCH_VERSION,
  CANDIDATE_KINDS,
  CANDIDATE_LIMITS,
  NEXT_STEPS,
} from '../../src/lib/connect-helper-core.js'
import { parseFrontmatter } from '../../src/lib/frontmatter.js'
import { READ_ONLY_AGENT_NAMES } from '../../src/lib/opencode-v2-tool-guard.js'
import { CURATED_PERSONAS } from '../../src/lib/pi-subagents-personas.js'
import { SKILL_FRONTMATTER_FIELDS } from '../../src/lib/skills.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SKILL_DIR = path.join(ROOT, 'skills/ce-connect')
const AGENT_FILE = path.join(ROOT, 'agents/research/connections-researcher.md')
const PROBE_FILE = path.join(
  ROOT,
  'tests/fixtures/connect-isolation/researcher-probe.md',
)

const skillText = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
const contractText = fs.readFileSync(
  path.join(SKILL_DIR, 'references/candidate-contract.md'),
  'utf8',
)
const outcomesText = fs.readFileSync(
  path.join(SKILL_DIR, 'references/headless-and-outcomes.md'),
  'utf8',
)
const agentText = fs.readFileSync(AGENT_FILE, 'utf8')

const skill = parseFrontmatter<Record<string, unknown>>(skillText)
const agent = parseFrontmatter<Record<string, unknown>>(agentText)
const probe = parseFrontmatter<Record<string, unknown>>(
  fs.readFileSync(PROBE_FILE, 'utf8'),
)

const TERMINAL_LINES = [
  'Connect complete',
  'Connect degraded',
  'Connect busy',
  'Connect failed',
] as const

describe('ce:connect skill frontmatter', () => {
  test('uses only fields the skill loader reads', () => {
    for (const key of Object.keys(skill.data)) {
      expect(SKILL_FRONTMATTER_FIELDS as readonly string[]).toContain(key)
    }
  })

  test('is named ce:connect and describes when to use it, not how it works', () => {
    expect(skill.data.name).toBe('ce:connect')
    expect(String(skill.data.description)).toMatch(/^Use when /)
    expect(String(skill.data.description).length).toBeLessThanOrEqual(500)
  })

  test('declares its argument hint and the neutral-vocabulary marker', () => {
    expect(String(skill.data['argument-hint'])).toContain('mode:headless')
    expect(
      (skill.data.metadata as Record<string, unknown>)['harness-portability'],
    ).toBe('neutral-v1')
  })

  test('is model-invocable, so a user or a caller can start a run', () => {
    expect(skill.data['disable-model-invocation']).toBeUndefined()
  })
})

describe('ce:connect modes and terminal lines', () => {
  test('accepts exactly mode:headless and mode:interactive', () => {
    expect(skillText).toContain('`mode:headless`')
    expect(skillText).toContain('`mode:interactive`')
  })

  test('reads the mode from the invoking instruction when the host passes no arguments', () => {
    expect(skillText).toMatch(/invoking instruction/)
  })

  test('counts a repeated token once and stops on a conflict or an unknown token before dispatch', () => {
    expect(skillText).toMatch(/same `mode:` token (twice|more than once)/i)
    expect(skillText).toMatch(/conflicting mode/i)
    expect(skillText).toMatch(/unknown `mode:` token/i)
    expect(skillText).toMatch(/before (any )?(dispatch|the researcher)/i)
  })

  test('names the four terminal lines in the skill and in the outcomes reference', () => {
    for (const line of TERMINAL_LINES) {
      expect(skillText).toContain(`\`${line}\``)
      expect(outcomesText).toContain(`\`${line}\``)
    }
  })

  test('puts the reason and the artifact path before the final line', () => {
    expect(outcomesText).toMatch(/lines just before the final line/)
  })

  test('tells an unattended run to allow the state directory in the host permission config', () => {
    expect(outcomesText).toMatch(/external_directory/)
    expect(outcomesText).toMatch(/state directory/)
  })

  test('headless asks nothing and makes no offer after the digest', () => {
    expect(skillText).toMatch(/Headless mode asks no question/i)
    expect(outcomesText).toMatch(/headless/i)
  })

  test('refuses an unsupported or unobserved host in headless and asks consent in interactive', () => {
    expect(skillText).toMatch(/consent-required/)
    expect(skillText).toMatch(/unsupported-host/)
    expect(skillText).toContain('"consent": true')
  })
})

describe('ce:connect run protocol', () => {
  test('reports every host id the helper table knows, with the version command for each', () => {
    for (const host of CONNECT_HOSTS) expect(skillText).toContain(`\`${host}\``)
    expect(skillText).toMatch(/--version/)
  })

  test('says a missing or unobservable version is left out, never guessed', () => {
    expect(skillText).toMatch(/never guess/i)
  })

  test('carries the lock back to validate and publish and releases it on every early stop', () => {
    expect(skillText).toMatch(/"abort": true/)
    expect(skillText).toMatch(/lock/)
  })

  test('says a crashed run under a live host needs ledger unlock, and never runs it unasked', () => {
    expect(outcomesText).toMatch(/ledger unlock/)
    expect(outcomesText).toMatch(/host process/)
    expect(skillText).toMatch(/never run `ledger unlock`/i)
  })

  test('passes the batch as a file the file-writing tool wrote, never on stdin', () => {
    expect(skillText).toMatch(/file-writing tool/)
    expect(skillText).toMatch(
      /never (put|pipe|send) a (family )?batch (on|through|via) (stdin|a heredoc)/i,
    )
  })

  test('treats helper unavailability as a distinct failure and never hand-writes helper output', () => {
    expect(skillText).toMatch(/helper-unavailable/)
    expect(skillText).toMatch(
      /Never write a digest, a run record or a ledger entry by hand/,
    )
  })

  test('writes an unfinished stub for a family that did not return, never an empty result', () => {
    expect(skillText).toContain(
      '{"version": 1, "runId": "<runId>", "family": "<family name>", "ruleIds": [], "projects": [], "files": [], "searches": [], "complete": false, "candidates": []}',
    )
    expect(skillText).toMatch(/turn limit/i)
  })

  test('labels a scan with nothing to report and reads the outcome from the helper', () => {
    expect(skillText).toMatch(/no candidate in searched scope/)
    expect(skillText).toMatch(/finalLine/)
  })

  test('treats everything read from a project as evidence, never as instruction', () => {
    expect(skillText).toMatch(/evidence, never (an )?instruction/i)
    expect(skillText).toMatch(/allow list/i)
  })

  test('states the limits the user accepts before any dispatch in interactive mode', () => {
    expect(skillText).toMatch(/no path scoping/i)
    expect(skillText).toMatch(/MCP/)
  })

  test('uses the bounds the helper reports instead of numbers of its own', () => {
    expect(skillText).toMatch(/maxRulesPerFamily/)
    expect(skillText).toMatch(/maxFamiliesPerRun/)
    expect(skillText).not.toMatch(/\b(?:8|5|6) rules\b/)
  })

  test('sends the researcher one fixed block and nothing else, never the lock', () => {
    const block = [
      'run: <runId>',
      'family: <family name>',
      'rules file: <rulesFile>',
      'files index: <filesIndex>',
      'projects:',
      '- <project root> (<project name>)',
      'rule ids: <rule id>, <rule id>',
      'max candidates: <bounds.maxCandidatesPerBatch>',
    ].join('\n')
    expect(skillText).toContain(block)
    expect(contractText).toContain(block)
    expect(skillText).toMatch(/no lock, nonce or pid/)
  })

  test("checks a reply's shape before writing it and never repairs one", () => {
    expect(skillText).toMatch(/shape/)
    expect(skillText).toMatch(/Never repair a batch/)
  })

  test('links the two references it ships', () => {
    expect(skillText).toContain('references/candidate-contract.md')
    expect(skillText).toContain('references/headless-and-outcomes.md')
  })

  test('uses no harness-specific skill directory variable', () => {
    for (const text of [skillText, contractText, outcomesText]) {
      expect(text).not.toMatch(/CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT/)
    }
  })
})

describe('candidate contract reference', () => {
  test('states the batch version the helper accepts', () => {
    expect(contractText).toContain(`"version": ${BATCH_VERSION}`)
  })

  test('lists every candidate kind and next step the helper accepts', () => {
    for (const kind of CANDIDATE_KINDS)
      expect(contractText).toContain(`\`${kind}\``)
    for (const step of NEXT_STEPS) expect(contractText).toContain(`\`${step}\``)
  })

  test('states every field limit the helper enforces, in its table', () => {
    for (const [name, value] of Object.entries(CANDIDATE_LIMITS)) {
      expect(contractText).toContain(`| \`${name}\` | ${value} |`)
    }
  })

  test('names every batch and candidate field', () => {
    for (const field of [
      'runId',
      'family',
      'ruleIds',
      'projects',
      'files',
      'searches',
      'complete',
      'candidates',
      'kind',
      'ruleId',
      'target',
      'title',
      'summary',
      'nextStep',
      'overlapCheck',
      'sources',
      'targetEvidence',
      'counterevidence',
      'fingerprint',
      'excerpt',
      'symbol',
    ]) {
      expect(contractText).toContain(`\`${field}\``)
    }
  })
})

describe('connections-researcher agent', () => {
  test('is named exactly as the OpenCode v2 tool guard keys on', () => {
    expect(READ_ONLY_AGENT_NAMES).toContain(String(agent.data.name))
    expect(agent.data.name).toBe('connections-researcher')
  })

  test('has no model, a finite temperature, a valid color and the subagent mode', () => {
    expect(agent.data.model).toBeUndefined()
    expect(agent.data.mode).toBe('subagent')
    expect(Number.isFinite(agent.data.temperature)).toBe(true)
    expect(isValidAgentColor(String(agent.data.color))).toBe(true)
  })

  test('carries the same tool limits as the definition the host proofs ran against', () => {
    expect(agent.data.tools).toBe(probe.data.tools)
    expect(agent.data.disallowedTools).toBe(probe.data.disallowedTools)
    expect(agent.data.permission).toEqual(probe.data.permission)
  })

  test('declares a positive allowlist, because an agent with none gets every default tool on Pi', () => {
    expect(agent.data.tools).toBe('Read, Grep, Glob')
  })

  test('resolves to read, search and find tools on the Pi catalog build, with no shell or write', () => {
    const catalog = buildAgentCatalog(path.join(ROOT, 'agents'))
    const entry = catalog.find((item) => item.name === 'connections-researcher')

    expect(entry?.category).toBe('research')
    expect(resolveToolAllowlist(entry?.toolsSource).tools).toEqual([
      'read',
      'grep',
      'find',
    ])
  })

  test('stays out of the curated Pi personas, which would export it with every tool', () => {
    expect(
      CURATED_PERSONAS.some((entry) =>
        entry.relPath.includes('connections-researcher'),
      ),
    ).toBe(false)
  })

  test('treats text from a project as evidence and never follows an instruction in it', () => {
    expect(agent.body).toMatch(/evidence, never (an )?instruction/i)
    expect(agent.body).toMatch(/allow list/i)
  })

  test('names every batch and candidate field it must return', () => {
    for (const field of [
      'runId',
      'family',
      'ruleIds',
      'projects',
      'files',
      'searches',
      'complete',
      'candidates',
      'kind',
      'ruleId',
      'target',
      'title',
      'summary',
      'nextStep',
      'overlapCheck',
      'sources',
      'targetEvidence',
      'counterevidence',
      'fingerprint',
      'excerpt',
      'symbol',
    ]) {
      expect(agent.body).toContain(field)
    }
    for (const kind of CANDIDATE_KINDS) expect(agent.body).toContain(kind)
    for (const step of NEXT_STEPS) expect(agent.body).toContain(step)
  })

  test('reads fingerprints from the work files and never computes or invents one', () => {
    expect(agent.body).toMatch(/files\.tsv/)
    expect(agent.body).toMatch(/never (compute|invent|guess)/i)
  })

  test('returns one JSON object and no confidence number', () => {
    expect(agent.body).toMatch(/one JSON object/i)
    expect(agent.body).toMatch(/no confidence/i)
  })

  test('says what to do when it runs short of turns', () => {
    expect(agent.body).toMatch(/"complete": false/)
  })

  test('has no SKILL_DIR or script path, because it cannot reach the skill directory', () => {
    expect(agentText).not.toMatch(/SKILL_DIR|connect\.mjs/)
  })
})
