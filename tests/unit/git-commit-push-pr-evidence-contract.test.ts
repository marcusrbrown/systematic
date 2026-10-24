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
const carryRules = normalize(section(skill, '## Carrying the Demo section'))

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

  test('the load instruction states mode:embed and the paths in its own text only', () => {
    expect(loadInstruction).toContain(
      '`mode:embed shots/a.png "shots/b c.png"`',
    )
    expect(loadInstruction).toMatch(/instruction text/i)
    expect(loadInstruction).toMatch(/pass no (?:skill )?arguments/i)
    expect(loadInstruction).toMatch(/spaces[^.]*double quotes/i)
    expect(loadInstruction).not.toMatch(/pass them as skill arguments/i)
    expect(loadInstruction).not.toMatch(/where the host supports them/i)
  })

  test('parses all three status lines and handles each outcome', () => {
    expect(evidenceDecision).toContain(
      'pr-attachments: status=ok evidence_sha=<40-hex> demo_file=<path> images=<count>',
    )
    expect(evidenceDecision).toContain(
      'pr-attachments: status=failed evidence=<pushed|local|none> reason=<reason>',
    )
    const text = normalize(evidenceDecision)
    expect(text).toMatch(
      /`evidence=pushed`[^.]*evidence files are pushed but unreferenced/i,
    )
    expect(text).toMatch(/`evidence=none`[^.]*nothing was published/i)
    expect(text).toMatch(/continue without evidence/i)
  })

  test('evidence=local tells the user the evidence commit is local and unpushed', () => {
    const text = normalize(evidenceDecision)
    expect(text).toMatch(
      /`evidence=local`[^.]*evidence commit[^.]*local and (?:is )?unpushed/i,
    )
    expect(text).toMatch(/`evidence=local`[\s\S]*continue without evidence/i)
  })

  test('a blob-mismatch failure is never answered with a push, in the evidence decision or the report', () => {
    const decision = normalize(evidenceDecision)
    expect(decision).toMatch(
      /`reason=blob-mismatch`[^.]*exception[^.]*push advice/i,
    )
    expect(decision).toMatch(/must not be pushed as it is/i)
    expect(normalize(stepEight)).toMatch(
      /`reason=blob-mismatch`[^.]*altered image[^.]*must not be pushed/i,
    )
  })

  test('git-commit-push-pr chooses no pin itself: the pins come from pr-attachments', () => {
    const commands = fencedBlocks(skill).join('\n')
    expect(commands).not.toMatch(/git log\b[^\n]*(?:\s-n\s*1\b|--format=%H)/)
    expect(skill).not.toMatch(
      /raw\.githubusercontent\.com|\/blob\/[^\s]*\?raw=true/,
    )
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
  test('Step 7 carries the Demo section through mode:carry, with the tokens in the instruction text only', () => {
    expect(stepSeven).toContain('**Carry the Demo section.**')
    expect(carryRules).toContain('`systematic:pr-attachments`')
    expect(carryRules).toContain(
      '`mode:carry old=<old body file> new=<new body file>`',
    )
    expect(carryRules).toMatch(/instruction text/i)
    expect(carryRules).toMatch(/spaces[^.]*double quotes/i)
    expect(carryRules).not.toMatch(/pass them as skill arguments/i)
    expect(carryRules).not.toMatch(/where the host supports them/i)
  })

  test('Step 7 writes both bodies to mktemp files', () => {
    const blocks = fencedBlocks(stepSeven).join('\n')
    expect(blocks).toMatch(/OLD_BODY_FILE=\$\(mktemp\)/)
    expect(blocks).toContain('> "$OLD_BODY_FILE"')
    expect(blocks).toContain('rm -f "$OLD_BODY_FILE"')
    expect(carryBlock).toMatch(/new body file/i)
  })

  test('every mktemp call in the skill is a portable bare call, never an X template with a suffix', () => {
    // macOS mktemp creates a literal file when the template has a suffix after
    // the X run, so every run shares one path. GNU mktemp may reject it. The
    // skill makes four temp files: two old body files and two new body files.
    const mktemps = fencedBlocks(skill)
      .join('\n')
      .split('\n')
      .filter((line) => line.includes('mktemp'))
    expect(mktemps.length).toBeGreaterThanOrEqual(4)
    for (const line of mktemps) {
      expect(line).not.toMatch(/mktemp\b[^)\n]*X{3,}[^X)\s'"]/)
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

  test('the carry always runs: there is no Demo-heading gate, and absent is a success', () => {
    expect(skill).not.toMatch(/grep -q '\^## Demo'/)
    expect(skill).not.toContain('has-demo')
    expect(carryBlock).toMatch(/always/i)
    expect(carryRules).toMatch(/`status=absent`[^.]*(?:success|apply)/i)
  })

  test('carry applies the new file on ok or absent only', () => {
    expect(carryRules).toMatch(/`status=ok`[^.]*`status=absent`[^.]*apply/i)
  })

  test('a failed carry never applies the body and never writes a Demo section by hand', () => {
    expect(carryRules).not.toMatch(/prose-only preservation/i)
    expect(carryRules).not.toMatch(
      /keep the old `## Demo` section in it by hand/i,
    )
    expect(carryRules).toMatch(/do not write a `## Demo` section by hand/i)
    expect(carryRules).toMatch(/do not apply the (?:rewritten|new) body/i)
    expect(carryRules).toMatch(/description stays as it is/i)
  })

  test.each([
    ['status=failed', /`status=failed`/],
    ['no status line', /prints no status line/i],
    ['a setup that stops', /setup stops/i],
  ])('a carry that ends in %s takes the same stop', (_name, trigger) => {
    expect(carryRules).toMatch(trigger)
  })

  test('a failed carry reports the reason and offers exactly three options', () => {
    expect(carryRules).toMatch(/report the reason/i)
    expect(carryRules).toMatch(/ask the user how to proceed/i)
    const offered = carryRules.match(/offer only[\s\S]*?(?:\.|$)/i)?.[0] ?? ''
    expect(offered).toMatch(/retry/i)
    expect(offered).toMatch(
      /apply the (?:rewritten |new )?body without a Demo section after an explicit yes/i,
    )
    expect(offered).toMatch(/keep the current description/i)
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

  test('DU-3 makes the old body file itself and does not point at a Step 7 procedure it never reaches', () => {
    const blocks = fencedBlocks(duThree).join('\n')
    expect(blocks).toMatch(/OLD_BODY_FILE=\$\(mktemp\)/)
    expect(blocks).toContain('> "$OLD_BODY_FILE"')
    expect(blocks).toContain('echo saved')
    expect(blocks).toContain('rm -f "$OLD_BODY_FILE"')
    expect(normalize(duThree)).not.toMatch(/carry procedure in Step 7/i)
    expect(normalize(duThree)).not.toMatch(/\bStep 7\b/)
    expect(normalize(duThree)).toMatch(/does not print `saved`/i)
    expect(normalize(duThree)).toContain('Carrying the Demo section')
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
})

describe('git-commit-push-pr body hand-off', () => {
  const commands = fencedBlocks(skill).join('\n').split('\n')
  const applyCommands = commands.filter((line) =>
    /\bgh pr (?:create|edit)\b/.test(line),
  )

  test('no apply command passes the body through command substitution', () => {
    // Command substitution strips every trailing newline and runs the body
    // through the shell. --body-file hands gh the file byte for byte.
    expect(skill.match(/--body "\$\(/g) ?? []).toHaveLength(0)
    expect(skill).not.toMatch(/--body\s+"?\$\(cat\b/)
  })

  test('gh pr create and both gh pr edit apply sites use --body-file', () => {
    expect(applyCommands).toHaveLength(3)
    expect(
      applyCommands.filter((line) => line.includes('gh pr create')),
    ).toHaveLength(1)
    expect(
      applyCommands.filter((line) => line.includes('gh pr edit')),
    ).toHaveLength(2)
    for (const command of applyCommands) {
      expect(command).toMatch(/--body-file "<[^>"]*body_file>"/)
      expect(command).not.toMatch(/--body(?!-file)\b/)
    }
  })

  test('the apply sites sit in DU-3 and Step 7', () => {
    const inDuThree = fencedBlocks(duThree).join('\n')
    const inStepSeven = fencedBlocks(stepSeven).join('\n')
    expect(inDuThree).toMatch(/gh pr edit .*--body-file/)
    expect(inStepSeven).toMatch(/gh pr create .*--body-file/)
    expect(inStepSeven).toMatch(/gh pr edit .*--body-file/)
  })

  test('both body files come from a bare mktemp chained to the write, so a failed mktemp stops the step', () => {
    const creations = commands.filter((line) =>
      /(?<![A-Z_])BODY_FILE=\$\(mktemp/.test(line),
    )
    expect(creations).toHaveLength(2)
    for (const line of creations) {
      expect(line).toMatch(
        /BODY_FILE=\$\(mktemp\) && cat > "\$BODY_FILE" << 'EOF' && echo "saved \$BODY_FILE"/,
      )
    }
  })

  test.each([
    ['DU-3', duThree],
    ['Step 6', stepSix],
  ])('%s stops when the body file was not created', (_name, text) => {
    expect(normalize(text)).toMatch(
      /does not print `saved` and the path[^.]*could not be created or written\. Stop/i,
    )
  })
})

describe('git-commit-push-pr evidence contract -- after the PR is created', () => {
  test('prints the zero-path re-run command, marked recommended before merge, after a successful publish', () => {
    const text = normalize(stepEight)
    expect(text).toMatch(/recommended before merge/i)
    expect(text).toContain('`systematic:pr-attachments`')
    expect(text).toMatch(/with no tokens/i)
    expect(text).toContain('`pr:<N>`')
    expect(text).toMatch(/only after a successful publish|`status=ok`/i)
  })

  test('prints the zero-path command only when this run published evidence successfully', () => {
    const text = normalize(stepEight)
    expect(text).toMatch(/published evidence images/i)
    expect(text).toMatch(/`status=ok`[^.]*zero-path|zero-path[^.]*`status=ok`/i)
    expect(text).not.toMatch(
      /`status=ok`, or `status=failed` with `evidence=pushed`/,
    )
  })

  test('after a pushed but unwritten publish it prints a re-run with the same image paths and pr:<N>', () => {
    const text = normalize(stepEight)
    expect(text).toMatch(/`evidence=pushed`/)
    expect(text).toMatch(/`reason=verify-failed`|`verify-failed`/)
    expect(text).toMatch(/same image paths[^.]*`pr:<N>`/i)
    expect(text).toMatch(/reuses the pushed commit/i)
    expect(text).toMatch(/not (?:print|before)[^.]*zero-path|no zero-path/i)
  })

  test('after a local, unpushed evidence commit it says to push first and prints no re-pin command', () => {
    const text = normalize(stepEight)
    expect(text).toMatch(/`evidence=local`[^.]*push/i)
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
