/**
 * Contract tests for how orchestrating skills treat a dispatch result.
 *
 * Where a host returns a launch handle instead of the child's answer, a skill
 * that waits for, collects or resumes a child has to follow the active harness
 * profile's "Dispatch results and continuation" section. The profiles own the
 * call names and states; the skills own only the behavior: a child has returned
 * when its final report arrives, waiting is not a failure, and a follow-up goes
 * through the continuation call the profile names, using the id recorded at
 * dispatch. These tests pin that behavior and the citation, and keep harness
 * syntax out of the skills.
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const PROFILE_SECTION = 'Dispatch results and continuation'
const HARNESS_SYNTAX =
  /sessionID|task_id|SendMessage|systematic_delegate|run_in_background|<subagent/

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Every skill file that dispatches, waits for, collects or resumes a child. */
const DISPATCHING_FILES: string[] = [
  'skills/orchestrating-subagents/SKILL.md',
  'skills/ce-work/SKILL.md',
  'skills/slfg/SKILL.md',
  'skills/ce-plan/SKILL.md',
  'skills/ce-plan/references/deepening-workflow.md',
  'skills/document-review/SKILL.md',
  'skills/deepen-plan/SKILL.md',
  'skills/ce-compound/SKILL.md',
  'skills/ce-compound-refresh/SKILL.md',
  'skills/resolve-pr-feedback/SKILL.md',
  'skills/ce-ideate/SKILL.md',
  'skills/ce-brainstorm/SKILL.md',
  'skills/ce-connect/SKILL.md',
  'skills/todos/SKILL.md',
  'skills/agent-native-audit/SKILL.md',
]

describe('dispatching skills cite the profile section', () => {
  test.each(DISPATCHING_FILES)(
    '%s names the profile section and the final-report rule',
    (file) => {
      const text = normalize(read(file))
      expect(text).toContain(PROFILE_SECTION)
      expect(text).toMatch(/final report/)
    },
  )

  test.each(DISPATCHING_FILES)('%s keeps harness syntax out', (file) => {
    expect(read(file)).not.toMatch(HARNESS_SYNTAX)
  })
})

describe('orchestrating-subagents is the general reference', () => {
  const text = normalize(read('skills/orchestrating-subagents/SKILL.md'))

  test('no longer claims every foreground dispatch blocks', () => {
    expect(text).not.toMatch(/A foreground dispatch blocks until/)
    expect(text).not.toMatch(/results are pushed back to the parent/)
  })

  test('treats a launch handle as not yet a result', () => {
    expect(text).toMatch(/launch handle/)
    expect(text).toMatch(/final report arrives/)
    expect(text).toMatch(/not final/)
  })

  test('bans polling, sleeping, re-dispatch and ending the turn while reports are owed', () => {
    expect(text).toMatch(
      /never poll, sleep or dispatch the same work again while a report is owed/i,
    )
    expect(text).toMatch(/Waiting is not a failure/)
    expect(text).toMatch(
      /does not end the turn while reports are owed unless the profile says reports wake it/,
    )
  })

  test('resumes through the profile-named call with the id recorded at dispatch', () => {
    expect(text).toMatch(/Record the child id at dispatch/)
    expect(text).toMatch(/continuation call (?:the|named by the) active/)
    expect(text).not.toMatch(/where the harness supports session reuse/)
  })

  test('falls back to a fresh dispatch only without a call or a recorded id', () => {
    expect(text).toMatch(
      /only when the profile names no continuation call or no id was recorded/,
    )
  })

  test('names the profile wait path and falls back to a blocking dispatch without one', () => {
    expect(text).toMatch(/Every profile names a wait path/)
    expect(text).toMatch(/a dispatch that blocks/)
    expect(text).toMatch(/end the turn and let the next report start/)
    expect(text).toMatch(
      /names no wake-up for a mode, dispatch in the blocking mode/,
    )
  })

  test('treats a refused continuation as a failed follow-up, not as license for a new child', () => {
    expect(text).toMatch(/runtime refuses a continuation call/)
    expect(text).toMatch(/failed follow-up/)
    expect(text).toMatch(/earlier result stands/)
    expect(text).toMatch(/do not retry the call/i)
    expect(text).toMatch(
      /only where the calling workflow's own rules allow a fresh dispatch/,
    )
    expect(text).toMatch(/guard text[^.]*does not override/i)
  })

  test('marks a failed or cancelled child as final, not as a waiting state', () => {
    expect(text).toMatch(/failed or was cancelled is final/)
  })
})

describe('skill-specific collect behavior', () => {
  test('ce-ideate no longer demands a foreground mode', () => {
    const text = normalize(read('skills/ce-ideate/SKILL.md'))
    expect(text).not.toMatch(/in the \*\*foreground\*\*/)
    expect(text).toMatch(/wait for every final report before (?:you )?proceed/i)
  })

  test('ce-compound waits for final reports, not a background launch', () => {
    const text = normalize(read('skills/ce-compound/SKILL.md'))
    expect(text).not.toMatch(/in parallel \(background\)/)
    expect(text).toMatch(
      /WAIT for all Phase 1 subagents to complete before proceeding/,
    )
  })

  test('ce-connect treats a launch handle as no reply', () => {
    const text = normalize(read('skills/ce-connect/SKILL.md'))
    expect(text).toMatch(/launch handle or a state that is not final is not/)
  })

  test('document-review counts a failure only on a final failure report', () => {
    const text = normalize(read('skills/document-review/SKILL.md'))
    expect(text).toMatch(/waiting for a report is not a failure/)
  })

  test('slfg waits for the final reports of both parallel agents', () => {
    const text = normalize(read('skills/slfg/SKILL.md'))
    expect(text).toMatch(/Wait for both final reports before continuing/)
  })
})
