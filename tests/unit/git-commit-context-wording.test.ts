import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

// Contract for how git-commit and git-commit-push-pr gather git context.
// Each skill keeps its shell-expansion blocks (a line that is an exclamation
// mark plus a backticked command). Some hosts run those blocks and some leave
// them inert, so the prose must not name a host. It tells the model to run
// the fallback command when the sections are empty or still show raw command
// lines, and otherwise to use the data without re-running anything.

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** The text from a heading to the next heading at the same or a higher level. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`)
  if (start === -1) {
    return ''
  }
  const level = heading.match(/^#+/)?.[0].length ?? 1
  const stop = new RegExp(`^#{1,${level}} `)
  const lines = markdown.slice(start + heading.length + 2).split('\n')
  const kept: string[] = []
  let inFence = false
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
    } else if (!inFence && stop.test(line)) {
      break
    }
    kept.push(line)
  }
  return `${kept.join('\n')}\n`
}

/** Lines that a shell-expanding host would run: `!` then a backticked command. */
function expansionBlocks(markdown: string): string[] {
  return markdown.split('\n').filter((line) => /^!`[^`]+`$/.test(line))
}

interface SkillCase {
  name: string
  blocks: string[]
  /** Heading of the step that reads the gathered context. */
  gatherHeading: string
}

const SKILLS: SkillCase[] = [
  {
    name: 'git-commit',
    gatherHeading: '### Step 1: Gather context',
    blocks: [
      '!`git status`',
      '!`git diff HEAD`',
      '!`git branch --show-current`',
      '!`git log --oneline -10`',
      "!`git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo '__DEFAULT_BRANCH_UNRESOLVED__'`",
    ],
  },
  {
    name: 'git-commit-push-pr',
    gatherHeading: '### Step 1: Gather context',
    blocks: [
      '!`git status`',
      '!`git diff HEAD`',
      '!`git branch --show-current`',
      '!`git log --oneline -10`',
      "!`git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo 'DEFAULT_BRANCH_UNRESOLVED'`",
      "!`gh pr view --json url,title,state 2>/dev/null || echo 'NO_OPEN_PR'`",
    ],
  },
]

describe.each(SKILLS)(
  '$name context wording',
  ({ name, blocks, gatherHeading }) => {
    const skill = fs.readFileSync(
      path.join(REPO_ROOT, `skills/${name}/SKILL.md`),
      'utf8',
    )
    // The Context section minus its "Context fallback" subsection.
    const context = normalize(
      section(skill, '## Context').split('### Context fallback')[0] ?? '',
    )
    const fallback = normalize(section(skill, '### Context fallback'))
    const gather = normalize(section(skill, gatherHeading))

    test('keeps every expansion block, byte for byte and in order', () => {
      expect(expansionBlocks(skill)).toEqual(blocks)
    })

    test('mentions no expansion marker in prose, where a host would run it', () => {
      // A shell-expanding host runs every exclamation-mark-plus-backtick match,
      // not only the whole-line ones. The blocks must be the only matches.
      const matches = [...skill.matchAll(/!`[^`]+`/g)].map((match) => match[0])
      expect(matches).toEqual(blocks)
    })

    test('has no host gate around the context sections', () => {
      expect(skill).not.toMatch(/If you are (?:not )?OpenCode/i)
      expect(context).not.toMatch(/pre-populated/i)
      expect(fallback).not.toMatch(/skip this section/i)
      expect(fallback).not.toMatch(/already available/i)
    })

    test('the Context section runs the fallback when the sections are empty or show raw command lines', () => {
      expect(context).toMatch(/empty/i)
      expect(context).toMatch(/raw command lines?/i)
      expect(context).toMatch(
        /run the command in the "Context fallback" section/i,
      )
    })

    test('the Context section otherwise uses the data and does not re-run', () => {
      expect(context).toMatch(
        /otherwise[^.]*use (?:the data|them)[^.]*do not re-run/i,
      )
    })

    test('the fallback lead-in says when to run it, and runs one command', () => {
      expect(fallback).toMatch(/empty|raw command lines/i)
      expect(fallback).toMatch(/single command/i)
      expect(fallback).toMatch(/gather all context/i)
    })

    test('the gather step never forbids a re-run unconditionally', () => {
      expect(gather, 'gather step').not.toBe('')
      expect(gather).toMatch(/fallback/i)
      expect(gather).not.toMatch(/already available -- do not re-run/i)
    })

    test('no later step points at context that may be empty without the fallback', () => {
      expect(skill).not.toMatch(/all data needed[^.]*already available/i)
    })
  },
)
