import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

// Contract for how git-commit-push-pr hands evidence to pr-attachments. The
// skill is prose that a model follows, so these tests pin the instruction
// text: the tokens the load instruction states, the status lines it parses,
// the fallback, and the rewrite path.

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SKILL_PATH = path.join(REPO_ROOT, 'skills/git-commit-push-pr/SKILL.md')

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * The text from a heading to the next heading at the same or a higher level.
 * A `#` line inside a fenced block is a shell comment, not a heading.
 */
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
    const fence = line.trimStart().startsWith('```')
    if (fence) {
      inFence = !inFence
    } else if (!inFence && stop.test(line)) {
      break
    }
    kept.push(line)
  }
  return `${kept.join('\n')}\n`
}

/** Text between two markers, or '' when either is missing. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  const end = text.indexOf(to, start + from.length)
  return start === -1 || end === -1 ? '' : text.slice(start, end)
}

function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let buffer: string[] | undefined
  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('```')) {
      buffer?.push(line)
    } else if (buffer === undefined) {
      buffer = []
    } else {
      blocks.push(buffer.join('\n'))
      buffer = undefined
    }
  }
  return blocks
}

const skill = fs.existsSync(SKILL_PATH)
  ? fs.readFileSync(SKILL_PATH, 'utf8')
  : ''
const flat = normalize(skill)

const stepFour = section(skill, '### Step 4: Branch, stage, and commit')
const stepSix = section(skill, '### Step 6: Generate the PR title and body')
const stepSeven = section(skill, '### Step 7: Create or update the PR')
const stepEight = section(skill, '### Step 8: Report')
const duThree = section(
  skill,
  '### DU-3: Write and apply the updated description',
)

const evidenceDecision = between(
  stepSix,
  '**Evidence decision',
  '**Generate title and body',
)
const loadInstruction = normalize(
  between(evidenceDecision, '- **Publish local images**', '- **Skip**'),
)
const fallback = normalize(
  between(`${evidenceDecision}\n\n`, '**Fallback.**', '\n\n'),
)
const carryBlock = normalize(
  between(stepSeven, '**Carry the Demo section.**', '**Apply'),
)

function optionLabels(text: string): string[] {
  return [...text.matchAll(/^- \*\*([^*]+)\*\*/gm)].map((match) =>
    (match[1] ?? '').trim(),
  )
}

describe('git-commit-push-pr evidence contract -- the publish option', () => {
  test('the evidence decision lists the existing options and "Publish local images"', () => {
    expect(evidenceDecision, 'evidence decision paragraph').not.toBe('')
    expect(optionLabels(evidenceDecision)).toEqual([
      'Use existing evidence',
      'Publish local images',
      'Skip',
    ])
  })

  test('"Publish local images" loads systematic:pr-attachments in embed mode', () => {
    expect(loadInstruction).toContain('`systematic:pr-attachments`')
    expect(loadInstruction).toContain('`mode:embed')
  })

  test('the load instruction states mode:embed and the paths in its own text, and passes them as arguments too', () => {
    expect(loadInstruction).toContain(
      '`mode:embed shots/a.png "shots/b c.png"`',
    )
    expect(loadInstruction).toMatch(
      /instruction text[^.]*skill arguments|skill arguments[^.]*instruction text/i,
    )
    expect(loadInstruction).toMatch(/pass no (?:skill )?arguments/i)
    expect(loadInstruction).toMatch(/spaces[^.]*double quotes/i)
  })

  test('parses both status lines and handles each outcome', () => {
    expect(evidenceDecision).toContain(
      'pr-attachments: status=ok evidence_sha=<40-hex> demo_file=<path> images=<count>',
    )
    expect(evidenceDecision).toContain(
      'pr-attachments: status=failed evidence=<pushed|none> reason=<reason>',
    )
    const text = normalize(evidenceDecision)
    expect(text).toMatch(
      /`evidence=pushed`[^.]*evidence files are pushed but unreferenced/i,
    )
    expect(text).toMatch(/`evidence=none`[^.]*nothing was published/i)
    expect(text).toMatch(/continue without evidence/i)
  })

  test('a request to publish never stages the images in the feature commit', () => {
    expect(normalize(stepFour)).toMatch(/evidence, not part of the change/i)
  })
})

describe('git-commit-push-pr evidence contract -- staging', () => {
  test('Step 4 forbids staging untracked images without asking', () => {
    const text = normalize(stepFour)
    expect(text).toMatch(
      /never stage an untracked image file[^.]*without asking/i,
    )
    expect(text).toMatch(/\.png/)
  })

  test('Step 4 asks the evidence-source question first when untracked images exist', () => {
    const text = normalize(stepFour)
    expect(text).toMatch(
      /untracked images exist[^.]*ask the evidence-source question[^.]*first/i,
    )
    expect(text).toMatch(/without asking again|do not ask again/i)
  })
})

describe('git-commit-push-pr evidence contract -- narrative and splice', () => {
  test('the narrative commands run to HEAD and exclude docs/evidence/** by path on both git log and git diff', () => {
    const narrative = between(
      stepSix,
      '**Narrative range after publishing.**',
      'If the branch diff is empty',
    )
    expect(narrative, 'narrative range paragraph').not.toBe('')
    const commands = fencedBlocks(narrative)
      .join('\n')
      .split('\n')
      .filter((line) => /^git (?:log|diff) /.test(line))
    expect(commands).toHaveLength(2)
    const [log, diff] = commands
    expect(log).toMatch(
      /^git log --oneline <base-remote>\/<base-branch>\.\.HEAD /,
    )
    expect(diff).toMatch(/^git diff <base-remote>\/<base-branch>\.\.\.HEAD /)
    for (const command of commands) {
      expect(command).toContain("-- . ':(exclude)docs/evidence/**'")
    }
  })

  test('the narrative does not depend on evidence_sha or an evidence commit subject', () => {
    expect(skill).not.toContain('<evidence-sha>^')
    expect(skill).not.toContain('chore(evidence):')
    expect(normalize(evidenceDecision)).not.toMatch(
      /keep both values for the narrative range/i,
    )
  })

  test('no shell variable carries a value between calls', () => {
    expect(skill).not.toMatch(/\bPRE\b/)
    expect(skill).not.toMatch(/\bEVIDENCE_SHA=/)
    expect(normalize(stepSix)).toMatch(/no shell variable carries values/i)
  })

  test('splices the returned demo file with the shell, then deletes it', () => {
    const blocks = fencedBlocks(stepSix).join('\n')
    expect(blocks).toContain('cat "<demo_file>" >> "<body_file>"')
    expect(blocks).toContain('rm -f "<demo_file>"')
    expect(blocks.indexOf('cat "<demo_file>"')).toBeLessThan(
      blocks.indexOf('rm -f "<demo_file>"'),
    )
    expect(normalize(stepSix)).toMatch(/no (?:SHA|sha) is retyped/i)
  })
})

describe('git-commit-push-pr evidence contract -- fallback', () => {
  test('covers a skill that fails to load and a skill that loads but sees no mode token', () => {
    expect(fallback, 'fallback paragraph').not.toBe('')
    expect(fallback).toMatch(/loading `systematic:pr-attachments` fails/i)
    expect(fallback).toMatch(/loads but sees no `mode:` token/i)
  })

  test('offers only the two existing options', () => {
    expect(fallback).toMatch(/offer only/i)
    expect(optionLabelsInline(fallback)).toEqual([
      'Use existing evidence',
      'Skip',
    ])
    expect(fallback).not.toContain('Publish local images')
  })
})

/** Bold labels inside one paragraph. */
function optionLabelsInline(text: string): string[] {
  return [...text.matchAll(/\*\*([^*]+)\*\*/g)]
    .map((match) => (match[1] ?? '').trim())
    .filter((label) => label !== 'Fallback.')
}

describe('git-commit-push-pr evidence contract -- rewrites', () => {
  test('Step 7 carries the Demo section through mode:carry, with the tokens in the instruction text', () => {
    expect(stepSeven).toContain('**Carry the Demo section.**')
    expect(carryBlock).toContain('`systematic:pr-attachments`')
    expect(carryBlock).toContain(
      '`mode:carry old=<old body file> new=<new body file>`',
    )
    expect(carryBlock).toMatch(/instruction text/i)
    expect(carryBlock).toMatch(/spaces[^.]*double quotes/i)
  })

  test('Step 7 writes both bodies to mktemp files', () => {
    const blocks = fencedBlocks(stepSeven).join('\n')
    expect(blocks).toMatch(/OLD_BODY_FILE=\$\(mktemp\)/)
    expect(blocks).toContain('> "$OLD_BODY_FILE"')
    expect(blocks).toContain('rm -f "$OLD_BODY_FILE"')
    expect(carryBlock).toMatch(/new body file/i)
  })

  test('Step 7 makes its temp file with a portable bare mktemp, never an X template with a suffix', () => {
    // macOS mktemp creates a literal file when the template has a suffix after
    // the X run, and GNU mktemp rejects it. Both break the carry silently.
    const mktemps = fencedBlocks(stepSeven)
      .join('\n')
      .split('\n')
      .filter((line) => line.includes('mktemp'))
    expect(mktemps.length).toBeGreaterThan(0)
    for (const line of mktemps) {
      expect(line).not.toMatch(/mktemp\s[^)\n]*X{3,}[^X)\s]/)
    }
  })

  test('Step 7 stops the carry and never applies the new body when the temp file or the gh read fails', () => {
    const blocks = fencedBlocks(stepSeven).join('\n')
    expect(blocks).toContain('> "$OLD_BODY_FILE" && echo saved')
    expect(carryBlock).toMatch(/does not print `saved`/i)
    expect(carryBlock).toMatch(
      /temp file could not be created or the `gh` read failed/i,
    )
    expect(carryBlock).toMatch(/stop the carry[^.]*do not apply the new body/i)
  })

  test('Step 7 applies the new file on ok or absent, and falls back to prose-only preservation on failed', () => {
    expect(carryBlock).toMatch(/`status=ok`[^.]*`status=absent`[^.]*apply/i)
    expect(carryBlock).toMatch(/`status=failed`[^.]*prose-only preservation/i)
    expect(carryBlock).toMatch(/fails to load[^.]*prose-only preservation/i)
  })

  test('Step 7 skips the carry when this run already spliced new evidence', () => {
    expect(carryBlock).toMatch(/already holds a `## Demo` section/i)
  })

  test('DU-3 carries the Demo section the same way and makes no publish offer', () => {
    expect(duThree, 'DU-3 section').not.toBe('')
    expect(duThree).toContain('mode:carry')
    expect(duThree).not.toContain('Publish local images')
    expect(duThree).not.toContain('mode:embed')
    expect(normalize(duThree)).toMatch(/do not offer to publish/i)
  })

  test('DU-3 skips the carry when the user asks to refresh or remove evidence', () => {
    expect(normalize(duThree)).toMatch(
      /refresh or remove evidence, honor that intent and skip the carry/i,
    )
  })

  test('DU-3 routes a request to attach images to PR mode', () => {
    const text = normalize(duThree)
    expect(text).toMatch(
      /attach[^.]*route[^.]*`systematic:pr-attachments`[^.]*PR mode/i,
    )
  })

  test('the --body apply sites are not touched by this change', () => {
    const sites = skill.match(/--body "\$\(/g) ?? []
    expect(sites.length).toBeLessThanOrEqual(3)
  })
})

describe('git-commit-push-pr evidence contract -- after the PR is created', () => {
  test('prints the zero-path re-run command, marked recommended before merge', () => {
    const text = normalize(stepEight)
    expect(text).toMatch(/recommended before merge/i)
    expect(text).toContain('`systematic:pr-attachments`')
    expect(text).toMatch(/with no tokens/i)
    expect(text).toContain('`pr:<N>`')
  })

  test('prints it only when this run published evidence', () => {
    const text = normalize(stepEight)
    expect(text).toMatch(/published evidence images/i)
    expect(text).toContain('`evidence=pushed`')
  })
})

describe('git-commit-push-pr evidence contract -- prose hygiene', () => {
  test('the skill carries no internal planning vocabulary', () => {
    expect(flat).not.toMatch(/\bUnit \d/)
    expect(flat).not.toMatch(/\bplan(?:s|ning)?\b/i)
    expect(flat).not.toMatch(/\bO[1-4]\b/)
    expect(flat).not.toMatch(/\bpersonas?\b/i)
  })

  test('references only a skill that ships in this package', () => {
    const referenced = new Set(
      [...skill.matchAll(/`systematic:([a-z0-9-]+)`/g)].map((m) => m[1]),
    )
    expect([...referenced]).toEqual(['pr-attachments'])
    expect(
      fs.existsSync(path.join(REPO_ROOT, 'skills/pr-attachments/SKILL.md')),
    ).toBe(true)
  })
})
