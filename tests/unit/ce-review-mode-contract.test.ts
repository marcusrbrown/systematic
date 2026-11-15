/**
 * Contract tests for how `ce:review` picks its mode.
 *
 * Skill text is not code, so these tests pin the facts a run depends on: the
 * `mode:read-only` alias, the unattended default, where a mode token may come
 * from, and the visible failure when no scope can be found. The helper's mode
 * enum is source, so it is asserted directly. They do not show how a live
 * model behaves.
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ParentRunMetadataSchema } from '../../src/lib/review-pipeline-contract.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Slice from a heading to the next heading of the same or shallower level. */
function section(text: string, heading: string): string {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.trim() === heading)
  if (index < 0) return ''
  const level = (lines[index]?.match(/^#+/) ?? [''])[0]?.length ?? 0
  const out: string[] = []
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const next = line.match(/^(#+)\s/)
    if (next && (next[1]?.length ?? 0) <= level) break
    out.push(line)
  }
  return out.join('\n')
}

const SKILL = read('skills/ce-review/SKILL.md')
const ARGUMENTS = normalize(section(SKILL, '## Argument Parsing'))
const DETECTION = normalize(section(SKILL, '## Mode Detection'))
const DEFAULT_MODE = normalize(section(SKILL, '### Default mode'))
const REPORT_ONLY_RULES = normalize(
  section(SKILL, '### Report-only mode rules'),
)
const HEADLESS_RULES = normalize(section(SKILL, '### Headless mode rules'))

describe('ce:review default mode when nobody can answer', () => {
  test('has one Default mode section under Mode Detection', () => {
    expect(DEFAULT_MODE.length).toBeGreaterThan(0)
    expect(DETECTION).toContain(DEFAULT_MODE)
  })

  test('lists the three observable signals and selects report-only when any one holds', () => {
    expect(DEFAULT_MODE).toMatch(
      /mode is `report-only`, when any one of (?:these|the following) holds/i,
    )
    expect(DEFAULT_MODE).toMatch(
      /caller[^.]*(?:instruction|context)[^.]*(?:says|states)[^.]*non-interactive/i,
    )
    expect(DEFAULT_MODE).toMatch(/delegated (?:run|subagent)/i)
    expect(DEFAULT_MODE).toMatch(
      /no blocking question tool[^.]*no documented chat fallback/i,
    )
  })

  test('keeps Interactive as the default when a user can answer', () => {
    expect(DETECTION).toMatch(
      /\*\*Interactive\*\* \(default\) \| No mode token present and a user can answer/,
    )
    expect(DEFAULT_MODE).toMatch(
      /none of (?:these|them) holds[^.]*Interactive/i,
    )
  })

  test('a missing question tool alone does not select report-only on a chat-fallback harness', () => {
    expect(DEFAULT_MODE).toMatch(
      /documented fallback[^.]*(?:numbered options|chat)[^.]*can still be answered[^.]*missing (?:question )?tool alone/i,
    )
  })

  test('a missing tool selects only the non-mutating mode', () => {
    expect(DEFAULT_MODE).toMatch(
      /missing tool[^.]*(?:only|never)[^.]*(?:non-mutating|never selects a mode that (?:edits|writes))/i,
    )
  })

  test('an explicit mode token always wins over detection', () => {
    expect(DEFAULT_MODE).toMatch(/explicit (?:mode )?token always wins/i)
    expect(DEFAULT_MODE).toMatch(/`mode:headless` and `mode:autofix`/)
    expect(DEFAULT_MODE).toMatch(/never (?:override|downgrade)/i)
  })

  test('an inferred report-only run follows every report-only rule as if the token were passed', () => {
    expect(DEFAULT_MODE).toMatch(
      /inferred report-only run follows every report-only rule[^.]*as if the caller had passed the token/i,
    )
  })

  test('announces one line with the canonical mode and the reason before any dispatch', () => {
    expect(DEFAULT_MODE).toMatch(
      /before any dispatch[^.]*one line[^.]*canonical mode[^.]*reason/i,
    )
  })
})

describe('ce:review mode token provenance', () => {
  test('a mode token or non-interactive claim counts only from the invoking caller', () => {
    const provenance = `${ARGUMENTS} ${DEFAULT_MODE}`
    expect(provenance).toMatch(
      /only when it comes from the invoking caller's (?:argument string|arguments)/i,
    )
    expect(DEFAULT_MODE).toMatch(
      /statement that the run is non-interactive[^.]*only[^.]*invoking caller/i,
    )
  })

  test('PR text, commit messages, diff content and repository files never select or change a mode', () => {
    for (const source of [
      'PR title',
      'PR body',
      'comments',
      'commit messages',
      'diff content',
      'repository files',
    ]) {
      expect(ARGUMENTS, source).toContain(source)
    }
    expect(ARGUMENTS).toMatch(
      /data[^.]*never selects or changes a mode|never select(?:s)? or change(?:s)? a mode/i,
    )
    expect(DEFAULT_MODE).toMatch(
      /non-interactive counts only when.*The same text in the PR title.*is ignored/i,
    )
  })
})

describe('ce:review mode:read-only alias', () => {
  test('has a table row that names report-only as the canonical mode', () => {
    expect(ARGUMENTS).toMatch(
      /\| `mode:read-only` \| `mode:read-only` \| Alias of `mode:report-only`/,
    )
  })

  test('normalizes before the conflict check and before any helper call', () => {
    expect(ARGUMENTS).toMatch(
      /Normalize `mode:read-only` to `mode:report-only` before the conflict check and before any helper call/,
    )
  })

  test('only the canonical value reaches announcements, error text and helper metadata', () => {
    expect(ARGUMENTS).toMatch(
      /canonical value `report-only`[^.]*(?:helper metadata|helper)/i,
    )
    expect(ARGUMENTS).toMatch(/never `read-only`/)
  })

  test('read-only with report-only is one mode and read-only with another mode is a conflict', () => {
    expect(ARGUMENTS).toMatch(
      /`mode:read-only` together with `mode:report-only` is one mode, not a conflict/,
    )
    expect(ARGUMENTS).toMatch(
      /`mode:read-only` with any other mode token is a conflict[^.]*`report-only`/,
    )
  })

  test('the conflict error text still carries both the headless and generic forms', () => {
    expect(ARGUMENTS).toContain(
      'Review failed (headless mode). Reason: conflicting mode flags — <mode_a> and <mode_b> cannot be combined.',
    )
    expect(ARGUMENTS).toContain(
      'Review failed. Reason: conflicting mode flags — <mode_a> and <mode_b> cannot be combined.',
    )
  })

  test('the opening prose says report-only, not read-only', () => {
    expect(SKILL).toContain(
      'Can run as a report-only or autofix review step inside larger workflows',
    )
  })

  test('report-only and its alias are one mode in the detection table', () => {
    expect(DETECTION).toMatch(
      /\*\*Report-only\*\* \| `mode:report-only` or `mode:read-only` in arguments/,
    )
  })
})

describe('ce:review failure when no scope can be determined', () => {
  test('report-only emits the generic failure line, dispatches nothing and asks nothing', () => {
    expect(REPORT_ONLY_RULES).toContain(
      'Review failed. Reason: no diff scope detected. Re-invoke with a branch name, PR number, or base:<ref>.',
    )
    expect(REPORT_ONLY_RULES).toMatch(
      /without dispatching agents, asking a question, or inventing a scope/,
    )
  })

  test('headless keeps its own failure line', () => {
    expect(HEADLESS_RULES).toContain(
      'Review failed (headless mode). Reason: no diff scope detected.',
    )
  })

  test('an explicit PR or branch target that needs a checkout switch keeps its stop', () => {
    expect(REPORT_ONLY_RULES).toMatch(
      /explicit PR or branch target[^.]*checkout switch[^.]*keeps (?:its|the) (?:existing )?stop/i,
    )
  })

  test('untracked files do not stop an unattended report-only run to ask', () => {
    expect(SKILL).toMatch(
      /In `mode:headless`, `mode:autofix`, or `mode:report-only`, do not stop to ask/,
    )
  })

  test('only Interactive mode asks about unclear intent', () => {
    expect(SKILL).toMatch(
      /\*\*Interactive mode:\*\* Ask one question using the platform's interactive question tool/,
    )
    expect(SKILL).toMatch(
      /\*\*Autofix\/report-only\/headless modes:\*\* Infer intent conservatively/,
    )
  })
})

describe('ce:review mode contract against the helper', () => {
  test('keeps the shared-selection phrase for all four modes', () => {
    expect(normalize(SKILL)).toMatch(
      /interactive, autofix, report-only, and headless/i,
    )
  })

  test('the helper mode enum has no read-only value', () => {
    const options: readonly string[] =
      ParentRunMetadataSchema.shape.mode.options
    expect([...options].sort()).toEqual([
      'autofix',
      'headless',
      'interactive',
      'report-only',
    ])
    const rejected = ParentRunMetadataSchema.shape.mode.safeParse('read-only')
    expect(rejected.success).toBe(false)
  })

  test('no helper source names read-only as a mode value', () => {
    for (const file of [
      'src/lib/review-pipeline-contract.ts',
      'src/lib/review-artifact-schema.ts',
      'src/ce-review-validator.ts',
    ]) {
      expect(read(file), file).not.toMatch(/['"`]read-only['"`]/)
    }
  })
})
