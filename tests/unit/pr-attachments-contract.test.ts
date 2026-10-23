import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SKILL_PATH = path.join(REPO_ROOT, 'skills/pr-attachments/SKILL.md')
const HELPER_PATH = path.join(
  REPO_ROOT,
  'skills/pr-attachments/scripts/pr-attachments.mjs',
)

const ANCHOR = 'SKILL_DIR="<skill directory stated when this skill loads>";'
const INVOKE = 'node "$SKILL_DIR/scripts/pr-attachments.mjs"'

// Frozen here, then registered once by the registration unit: changing it
// changes the generated registry entry.
const FROZEN_DESCRIPTION =
  'Use when attaching local screenshots or other images to a pull request, publishing evidence images as commit-pinned embeds in a managed Demo section of the PR description, re-pinning those embeds after a rebase or force-push, or cleaning up evidence images once the PR is done.'

const SUBCOMMANDS = [
  'classify',
  'splice',
  'extract',
  'urls',
  'pins',
  'repin-rewrite',
  'cleanup-set',
  'verify',
] as const

// Every result code the helper returns that the skill acts on. `extracted` and
// `absent` belong to `extract`, which carry mode calls.
const ROUTED_RESULT_CODES = [
  'accepted',
  'rejected',
  'needs-input',
  'spliced',
  'extracted',
  'absent',
  'repinned',
  'urls',
  'already-valid',
  'repin-needed',
  'partial',
  'unresolved',
  'head-not-found',
  'set',
  'empty',
  'removed',
  'digest-mismatch',
  'head-not-checked-out',
  'base-not-found',
  'no-merge-base',
  'git-failed',
  'git-timeout',
  'verified',
  'failed',
  'write-failed',
  'usage-error',
  'internal-error',
] as const

// Reasons and questions the skill routes inside a result.
const ROUTED_DETAIL_CODES = [
  'empty-topic',
  'empty-name',
  'duplicate-destination',
  'destination-conflict',
  'multiple-demo-sections',
  'unterminated-region',
  'line-ending-conflict',
  'blob-url',
  'unchanged',
] as const

interface FencedBlock {
  readonly startLine: number
  readonly body: string
}

function readSkill(): string {
  return fs.existsSync(SKILL_PATH) ? fs.readFileSync(SKILL_PATH, 'utf8') : ''
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function fencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = []
  let startLine = 0
  let buffer: string[] | undefined
  for (const [index, line] of markdown.split('\n').entries()) {
    if (!line.startsWith('```')) {
      buffer?.push(line)
      continue
    }
    if (buffer === undefined) {
      startLine = index + 1
      buffer = []
    } else {
      blocks.push({ startLine, body: buffer.join('\n') })
      buffer = undefined
    }
  }
  return blocks
}

function proseOnly(markdown: string): string {
  const kept: string[] = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence
    } else if (!inFence) {
      kept.push(line)
    }
  }
  return kept.join('\n')
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
    if (line.startsWith('```')) {
      inFence = !inFence
    } else if (!inFence && stop.test(line)) {
      break
    }
    kept.push(line)
  }
  return `${kept.join('\n')}\n`
}

function frontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/)
  const fields: Record<string, string> = {}
  for (const line of match?.[1]?.split('\n') ?? []) {
    const pair = line.match(/^([a-z-]+):\s*(.*)$/)
    if (pair?.[1] !== undefined && pair[2] !== undefined) {
      fields[pair[1]] = pair[2].replace(/^"(.*)"$/, '$1')
    }
  }
  return fields
}

const skill = readSkill()
const prose = proseOnly(skill)
const flat = normalize(skill)
const blocks = fencedBlocks(skill)

describe('pr-attachments skill contract -- identity and modes', () => {
  test('SKILL.md exists with the frozen name, description and argument-hint', () => {
    expect(skill, `expected ${SKILL_PATH} to exist`).not.toBe('')
    const fields = frontmatter(skill)
    expect(fields.name).toBe('pr-attachments')
    expect(fields.description).toBe(FROZEN_DESCRIPTION)
    expect(fields['argument-hint']).toContain('mode:embed')
    expect(fields['argument-hint']).toContain('mode:carry')
    expect(fields['argument-hint']).toMatch(/image/i)
    expect(fields['argument-hint']).toMatch(/pr:/)
  })

  test('names all five modes', () => {
    for (const mode of [
      'PR mode',
      'Embed mode',
      'Carry mode',
      'Re-pin mode',
      'Cleanup',
    ]) {
      expect(skill, mode).toContain(mode)
    }
    expect(skill).toContain('\n## Carry mode\n')
    expect(skill).toContain('## Re-pin mode')
    expect(skill).toContain('\n## Cleanup\n')
  })

  test('uses no harness-specific skill-directory variable and no banned literal', () => {
    expect(skill).not.toMatch(/\$\{?(?:CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT)\}?/)
    for (const literal of ['Claude Code', 'CLAUDE.md', '.claude/']) {
      expect(skill).not.toContain(literal)
    }
  })
})

describe('pr-attachments skill contract -- arguments and dispatch', () => {
  test('reads tokens from the skill arguments or the invoking instruction, with no positional placeholders', () => {
    expect(flat).toContain(
      'from the skill arguments, or from the invoking instruction when none are shown',
    )
    expect(prose).not.toMatch(/\$(?:\d|ARGUMENTS)\b/)
    expect(skill).not.toMatch(/\$(?:[1-9]|ARGUMENTS)\b/)
  })

  test('states a quoting rule for paths with spaces', () => {
    expect(flat).toMatch(/path[^.]*spaces[^.]*double quotes/i)
  })

  test('mode:embed and mode:carry are the only mode tokens; any other mode: token stops', () => {
    expect(flat).toMatch(/any other `mode:` token[^.]*stop/i)
    expect(flat).toMatch(/`mode:embed` selects embed mode/)
    expect(flat).toMatch(/`mode:carry` selects carry mode/)
  })

  test('the same mode: token twice counts once; different mode: values still stop', () => {
    const step = normalize(section(skill, '## Step 1: Read the arguments'))
    expect(step).toMatch(
      /same `mode:` token[^.]*twice[^.]*(?:counts once|one token)/i,
    )
    expect(step).toMatch(/different `mode:` (?:values|tokens)[^.]*stop/i)
  })

  test('old= and new= outside carry mode stop the run and name the token; they are never image paths', () => {
    const step = normalize(section(skill, '## Step 1: Read the arguments'))
    expect(step).toMatch(
      /`old=`[^.]*`new=`[^.]*outside carry mode[^.]*stops? the run[^.]*names the token/i,
    )
    expect(step).toMatch(/never[^.]*(?:read|treated)[^.]*image path/i)
  })

  test('tokens come from one channel: no text relies on both the arguments and the instruction', () => {
    expect(flat).not.toMatch(/pass(?:ed)? them as skill arguments/i)
    expect(flat).not.toMatch(/where the host supports them/i)
  })

  test('classify existing map: only destinations whose line printed a 40-hex SHA, never the absent ones', () => {
    const step = normalize(section(skill, '## Step 2: Classify the images'))
    expect(step).toMatch(
      /only destinations whose line printed a 40-hex SHA[^.]*omit the `absent` ones/i,
    )
  })

  test('the dispatch rule fires when no mode token is seen', () => {
    const step = normalize(
      section(skill, '## Step 3: Resolve the target and pick the mode'),
    )
    expect(step).toContain(
      'open the PR first, or run through git-commit-push-pr',
    )
    expect(step).toMatch(
      /no `mode:` token and finds no open PR[^.]*stops[^.]*never guesses/i,
    )
    expect(step).toMatch(/`mode:embed`[^.]*no paths[^.]*stop/i)
  })

  test('embed mode resolves the head from the upstream of the current branch', () => {
    const step = section(
      skill,
      '## Step 3: Resolve the target and pick the mode',
    )
    expect(step).toContain('git rev-parse --abbrev-ref "@{u}"')
    expect(step).toContain('git remote -v')
    expect(step).toContain('gh repo view')
    expect(normalize(step)).toMatch(/no upstream[^.]*stop/i)
  })

  test('PR mode asks for the head to be checked out and level, and says push first', () => {
    const step = normalize(
      section(skill, '## Step 3: Resolve the target and pick the mode'),
    )
    expect(step).toContain('headRefOid')
    expect(step).toContain('push first')
    expect(step).toMatch(/null `headRepository`[^.]*(refuse|stop)/i)
  })
})

describe('pr-attachments skill contract -- helper invocation', () => {
  test('needs node 18+ on PATH, and states it as a precondition', () => {
    expect(flat).toContain('needs node 18+ on PATH')
    expect(skill.indexOf('needs node 18+ on PATH')).toBeLessThan(
      skill.indexOf('## Step 1:'),
    )
  })

  test('never-bypass paragraph: a helper failure is never permission to hand-write its output', () => {
    const text = normalize(section(skill, '## Never bypass the helper'))
    expect(text).toMatch(
      /helper failure[^.]*is never permission to hand-(write|synthesize)/i,
    )
    expect(text).toMatch(/node is missing[^.]*stop/i)
    expect(text).toMatch(/never run `git rm` by hand/i)
  })

  test('pins the helper invocation and reuses the anchor verbatim in every fenced block', () => {
    expect(skill).toContain(ANCHOR)
    expect(skill).toContain(INVOKE)
    const callers = blocks.filter((block) =>
      block.body.includes('pr-attachments.mjs'),
    )
    expect(callers.length).toBeGreaterThanOrEqual(SUBCOMMANDS.length)
    for (const block of callers) {
      expect(block.body, `block at line ${block.startLine}`).toContain(ANCHOR)
    }
  })

  test('every mention of the helper is a pinned node invocation', () => {
    const offenders = skill
      .split('\n')
      .filter((line) => line.includes('pr-attachments.mjs'))
      .filter((line) => !line.includes(INVOKE))
    expect(offenders).toEqual([])
  })

  test('calls every helper subcommand the modes need', () => {
    for (const subcommand of SUBCOMMANDS) {
      expect(skill, subcommand).toContain(`${INVOKE} ${subcommand}`)
    }
  })

  test('SKILL_DIR assignments end with a semicolon and no block reads it unset', () => {
    expect(skill).not.toMatch(/SKILL_DIR=(?!"[^"]*";)/)
    for (const block of blocks) {
      if (/\$\{?SKILL_DIR\}?\//.test(block.body)) {
        expect(block.body).toContain('SKILL_DIR=')
      }
    }
  })
})

describe('pr-attachments skill contract -- publishing order', () => {
  test('classify < visibility < scrub confirmation < copy < commit < file-set assertion < push < verify < body write < cleanup offer', () => {
    const markers = [
      '## Step 2: Classify the images',
      '## Step 4: Check visibility',
      '## Step 5: List the set and confirm the scrub',
      '### Copy into place',
      '### Commit by pathspec',
      '### Assert the committed file set',
      '### Push with an explicit refspec',
      '## Step 7: Verify the embeds',
      '## Step 8: Write the description or return the Demo file',
      '\n## Cleanup\n',
    ]
    const positions = markers.map((marker) => skill.indexOf(marker))
    for (const [index, position] of positions.entries()) {
      expect(position, markers[index]).toBeGreaterThan(-1)
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  test('classify runs before any network step of the publishing flow', () => {
    const classifyAt = skill.indexOf(`${INVOKE} classify`)
    expect(classifyAt).toBeGreaterThan(-1)
    for (const network of ['gh pr view', 'gh repo view', 'git fetch']) {
      expect(skill.indexOf(network), network).toBeGreaterThan(-1)
      expect(classifyAt, network).toBeLessThan(skill.indexOf(network))
    }
    expect(classifyAt).toBeLessThan(skill.indexOf(`${INVOKE} verify`))
  })

  test('verifies before it writes, and never writes or returns text when verification fails (O1)', () => {
    const verifyStep = normalize(section(skill, '## Step 7: Verify the embeds'))
    expect(verifyStep).toMatch(
      /never write the description, and never return the Demo file, when verification fails/i,
    )
    expect(skill.indexOf(`${INVOKE} verify`)).toBeLessThan(
      skill.indexOf('gh pr edit'),
    )
    expect(verifyStep).toMatch(/waited_s/)
    expect(verifyStep).toMatch(/retryable/)
  })

  test('the scrub gate covers visible content only and strips nothing', () => {
    const step = normalize(
      section(skill, '## Step 5: List the set and confirm the scrub'),
    )
    expect(step).toMatch(/scrub confirmation/i)
    expect(step).toContain('visible content')
    expect(step).toMatch(/metadata[^.]*(not stripped|published as is)/i)
    expect(step).toMatch(/explicit yes|explicit confirmation/i)
    expect(step).toMatch(/no default|never assume/i)
  })

  test('the commit is by pathspec with the evidence subject, and the push is an explicit refspec', () => {
    expect(skill).toContain('chore(evidence): add screenshots for')
    const commit = section(skill, '### Commit by pathspec')
    expect(commit).toContain('git add -- "$@"')
    expect(commit).toMatch(/git commit -m "[^"]*" -- "\$@"/)
    const push = section(skill, '### Push with an explicit refspec')
    expect(push).toContain('git push "$REMOTE" "HEAD:refs/heads/$BRANCH"')
  })

  test('a rejected push stops and reports, and never force-pushes', () => {
    const push = normalize(section(skill, '### Push with an explicit refspec'))
    expect(push).toMatch(/rejected[^.]*stop and report/i)
    expect(push).toMatch(/never force-push/i)
  })

  test('the file-set assertion compares the commit to the expected set and stops on a mismatch', () => {
    const assertion = normalize(
      section(skill, '### Assert the committed file set'),
    )
    expect(assertion).toContain(
      'git diff-tree --no-commit-id --name-only -r --no-renames HEAD',
    )
    expect(assertion).toMatch(/mismatch[^.]*(stop|do not push)/i)
  })

  test('stops on a gitignored destination, an LFS filter and a dirty destination, without forcing', () => {
    const copy = section(skill, '### Copy into place')
    expect(copy).toContain('git check-ignore')
    expect(copy).toContain('git check-attr filter')
    expect(copy).toContain('git status --porcelain')
    expect(normalize(copy)).toMatch(/gitignored[^.]*stop/i)
  })
})

describe('pr-attachments skill contract -- bans', () => {
  const commandText = blocks.map((block) => block.body).join('\n')

  test('no push uses a force flag or a plus refspec', () => {
    const pushes = commandText
      .split('\n')
      .filter((line) => /\bgit push\b/.test(line))
    expect(pushes.length).toBeGreaterThan(0)
    for (const line of pushes) {
      expect(line).not.toMatch(/--force|--force-with-lease|\s-f\b|\s\+/)
    }
  })

  test('no blanket staging, forced staging or inline body', () => {
    expect(commandText).not.toMatch(/git add (?:-A|--all|\.)(?:\s|$)/)
    expect(commandText).not.toMatch(/git add (?:-f|--force)\b/)
    expect(skill).not.toContain('--body "$(')
    expect(commandText).not.toMatch(/--body\s/)
  })

  test('no fenced block runs git rm; cleanup has no hand-run fallback', () => {
    expect(commandText).not.toMatch(/\bgit rm\b/)
    expect(commandText).not.toMatch(/\brm -[a-z]*r/)
    const cleanup = normalize(section(skill, '## Cleanup'))
    expect(cleanup).toMatch(/never run `git rm` by hand/i)
    expect(cleanup).toMatch(/no hand-run fallback|never[^.]*fall back/i)
  })

  test('bodies go through mktemp files and --body-file, never inline', () => {
    expect(commandText).toContain('mktemp')
    expect(commandText).toContain('--body-file')
    expect(commandText).toMatch(/gh pr edit "\$PR" --body-file "\$NEW_BODY"/)
  })
})

describe('pr-attachments skill contract -- PR mode body write', () => {
  const step = section(
    skill,
    '## Step 8: Write the description or return the Demo file',
  )
  const text = normalize(step)

  test('backs up the body, re-reads it immediately before writing, and compares after', () => {
    expect(text).toMatch(/back(s)? up/i)
    expect(text).toMatch(/re-read[^.]*immediately before writing/i)
    expect(text).toMatch(/re-read[^.]*after(wards)?/i)
    expect(text.indexOf('immediately before writing')).toBeLessThan(
      text.indexOf('gh pr edit'),
    )
  })

  test('a mismatch warns, prints the backup path, and never auto-restores', () => {
    expect(text).toMatch(/warn/i)
    expect(text).toMatch(/print the backup path/i)
    expect(text).toMatch(/never auto-restore/i)
    expect(text).toMatch(/keep the backup until the re-read passes/i)
  })

  test('leaves ## Screenshots alone and warns about it', () => {
    expect(flat).toContain('## Screenshots')
    expect(flat).toContain('screenshots_present')
    expect(flat).toMatch(/Screenshots[^.]*left (unchanged|alone)/i)
  })

  test('routes every splice result', () => {
    for (const code of [
      'spliced',
      'unchanged',
      'multiple-demo-sections',
      'unterminated-region',
      'line-ending-conflict',
      'write-failed',
    ]) {
      expect(text, code).toContain(`\`${code}\``)
    }
  })
})

describe('pr-attachments skill contract -- embed mode', () => {
  const step = section(
    skill,
    '## Step 8: Write the description or return the Demo file',
  )
  const text = normalize(step)

  test('returns a mktemp Demo file path and a status line, and never edits the pull request', () => {
    expect(text).toMatch(/embed mode[^.]*never edit(s)? the pull request/i)
    expect(text).toMatch(/embed mode[^.]*mktemp/i)
    expect(skill).toMatch(
      /pr-attachments: status=ok evidence_sha=\S+ demo_file=\S+ images=\S+/,
    )
    expect(skill).toMatch(
      /pr-attachments: status=failed evidence=<pushed\|local\|none> reason=\S+/,
    )
  })

  test('failure reasons are a fixed vocabulary, including the node-missing one', () => {
    for (const reason of [
      'node-unavailable',
      'declined',
      'push-rejected',
      'verify-failed',
    ]) {
      expect(flat, reason).toContain(`\`${reason}\``)
    }
  })

  test('embed mode stops at the status line, with no cleanup offer', () => {
    expect(text).toMatch(/embed mode[^.]*(no cleanup offer|ends here)/i)
  })

  test('builds the Demo text from git pins, so no SHA is retyped', () => {
    expect(skill).toContain('git log -n 1 --no-renames --diff-filter=AM')
    expect(skill).toContain('raw.githubusercontent.com')
    expect(flat).toMatch(/never (re-?type|transcribe)[^.]*SHA/i)
  })
})

describe('pr-attachments skill contract -- carry mode', () => {
  const step = section(skill, '## Carry mode')
  const text = normalize(step)
  const carryBlocks = fencedBlocks(step).map((block) => block.body)

  test('takes old= and new= files, with no image paths and no pr: token', () => {
    expect(text).toContain(
      '`mode:carry old=<old body file> new=<new body file>`',
    )
    expect(text).toMatch(/both `old=` and `new=`/i)
    expect(text).toMatch(/no image paths[^.]*no `pr:` token/i)
    expect(text).toMatch(/`bad-arguments`/)
  })

  test('states the quoting rule for values with spaces', () => {
    expect(flat).toMatch(/`old="[^"]* [^"]*"`/)
    expect(flat).toMatch(/value[^.]*spaces[^.]*double quotes/i)
  })

  test('never commits, pushes, calls gh or touches the network', () => {
    expect(text).toMatch(
      /never commits[^.]*never pushes[^.]*never calls `gh`[^.]*never touches the network/i,
    )
    for (const block of carryBlocks) {
      expect(block).not.toMatch(/\b(?:git|gh|curl|wget|ssh)\b/)
    }
  })

  test('extracts from the old body, then splices into the new body, both through the pinned helper', () => {
    const extractAt = step.indexOf(`${INVOKE} extract`)
    const spliceAt = step.indexOf(`${INVOKE} splice`)
    expect(extractAt).toBeGreaterThan(-1)
    expect(spliceAt).toBeGreaterThan(extractAt)
    for (const block of carryBlocks.filter((entry) =>
      entry.includes('pr-attachments.mjs'),
    )) {
      expect(block).toContain(ANCHOR)
    }
  })

  test('absent is a success: it leaves the new file untouched and is not a failure', () => {
    expect(text).toMatch(/`absent`[^.]*leave the new file untouched/i)
    expect(text).toContain('`status=absent`')
    expect(text).toMatch(/`absent`[^.]*not a failure/i)
  })

  test('routes every extract and splice result', () => {
    for (const code of [
      'extracted',
      'absent',
      'spliced',
      'needs-input',
      'multiple-demo-sections',
      'unterminated-region',
      'line-ending-conflict',
      'write-failed',
      'usage-error',
      'internal-error',
    ]) {
      expect(text, code).toContain(`\`${code}\``)
    }
  })

  test('returns exactly one status line with a fixed reason vocabulary', () => {
    expect(step).toContain(
      'pr-attachments: status=<ok|absent|failed> [reason=<reason>]',
    )
    expect(text).toMatch(/exactly one status line/i)
    expect(text).toMatch(/`reason` appears only with `failed`/i)
    for (const reason of [
      'node-unavailable',
      'bad-arguments',
      'helper-failed',
      'multiple-demo-sections',
      'unterminated-region',
      'line-ending-conflict',
      'write-failed',
    ]) {
      expect(text, reason).toContain(`\`${reason}\``)
    }
  })

  test('removes the extracted-section file and offers no cleanup', () => {
    expect(carryBlocks.join('\n')).toContain('rm -f "$DEMO_FILE"')
    expect(text).toMatch(/carry mode[^.]*(no cleanup offer|ends here)/i)
  })

  test('is listed in the mode table and the dispatch table, and skips the publishing steps', () => {
    const head = skill.slice(0, skill.indexOf('## Preconditions'))
    expect(head).toMatch(/\| Carry mode \| `mode:carry`[^|]*\| No\./)
    const dispatch = normalize(
      section(skill, '## Step 3: Resolve the target and pick the mode'),
    )
    expect(dispatch).toContain('`mode:carry`')
    expect(dispatch).toMatch(/Carry mode/)
    const read = normalize(section(skill, '## Step 1: Read the arguments'))
    expect(read).toMatch(/`mode:carry` selects carry mode[^.]*skip/i)
  })

  test('node is the only precondition, and a helper failure still never permits a hand-written result', () => {
    expect(normalize(section(skill, '## Preconditions'))).toMatch(
      /carry mode needs only node/i,
    )
    expect(normalize(section(skill, '## Never bypass the helper'))).toMatch(
      /carry mode[^.]*failed status line/i,
    )
  })
})

describe('pr-attachments skill contract -- re-pin mode', () => {
  const text = normalize(section(skill, '## Re-pin mode'))

  test('runs urls, then pins, then repin-rewrite, then verify, then the write', () => {
    const urls = skill.indexOf(`${INVOKE} urls`)
    const pins = skill.indexOf(`${INVOKE} pins`)
    const rewrite = skill.indexOf(`${INVOKE} repin-rewrite`)
    expect(urls).toBeGreaterThan(-1)
    expect(pins).toBeGreaterThan(urls)
    expect(rewrite).toBeGreaterThan(pins)
    expect(rewrite).toBeGreaterThan(skill.indexOf('\n## Re-pin mode\n'))
    const repin = section(skill, '## Re-pin mode')
    const verifyAt = repin.search(/verify[^.\n]*Step 7/i)
    expect(verifyAt).toBeGreaterThan(repin.indexOf(`${INVOKE} repin-rewrite`))
    expect(repin.indexOf('write step of Step 8')).toBeGreaterThan(verifyAt)
  })

  test('routes every pins result', () => {
    for (const code of [
      'already-valid',
      'repin-needed',
      'partial',
      'unresolved',
      'head-not-found',
      'git-failed',
      'git-timeout',
    ]) {
      expect(text, code).toContain(`\`${code}\``)
    }
    expect(text).toMatch(/already valid/i)
    expect(text).toMatch(/point(s)? to PR mode/i)
    expect(text).toMatch(/ignored/i)
  })

  test('ignores every URL that is not managed, and reports how many', () => {
    expect(text).toMatch(/ignored[^.]*report/i)
  })

  test('tells the user to re-run after a rebase or force-push', () => {
    expect(flat).toMatch(/rebase or force-push[^.]*re-run/i)
  })
})

describe('pr-attachments skill contract -- cleanup', () => {
  const cleanup = section(skill, '## Cleanup')
  const text = normalize(cleanup)

  test('lists the set, waits for an explicit yes, then removes with the digest, commits and pushes', () => {
    const listAt = cleanup.indexOf(`${INVOKE} cleanup-set`)
    const yesAt = cleanup.indexOf('explicit yes')
    const removeAt = cleanup.indexOf('remove_digest')
    const commitAt = cleanup.indexOf('remove screenshots for')
    const assertAt = cleanup.indexOf('Assert the committed file set')
    const pushAt = cleanup.indexOf('Push with an explicit refspec')
    const positions = [listAt, yesAt, removeAt, commitAt, assertAt, pushAt]
    for (const position of positions) {
      expect(position).toBeGreaterThan(-1)
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  test('is offered only once a PR exists, only when the set is not empty, and before merge', () => {
    expect(text).toMatch(/only once a PR exists/i)
    expect(text).toMatch(/recommended before merge/i)
    expect(text).toMatch(/cleanup already done/i)
  })

  test('fetches the base before computing the set', () => {
    expect(cleanup.indexOf('git fetch')).toBeGreaterThan(-1)
    expect(cleanup.indexOf('git fetch')).toBeLessThan(
      cleanup.indexOf(`${INVOKE} cleanup-set`),
    )
  })

  test('routes every cleanup-set result', () => {
    for (const code of [
      'set',
      'empty',
      'removed',
      'digest-mismatch',
      'head-not-checked-out',
      'head-not-found',
      'base-not-found',
      'no-merge-base',
      'git-failed',
      'git-timeout',
    ]) {
      expect(text, code).toContain(`\`${code}\``)
    }
    expect(text).toMatch(/digest-mismatch[^.]*(new set|ask again)/i)
  })

  test('discloses that cleanup does not revoke access, verbatim', () => {
    expect(flat).toContain(
      'Cleanup does not revoke access, so any published secret must be rotated.',
    )
  })

  test('adds the merge-method line when non-squash merges are allowed', () => {
    expect(text).toContain('squashMergeAllowed')
    expect(text).toMatch(
      /default-branch history unless the PR is squash-merged/,
    )
  })
})

describe('pr-attachments skill contract -- private repositories: the explicit-answer gate', () => {
  const step = normalize(section(skill, '## Step 4: Check visibility'))

  test('a public repository proceeds on the raw form, and the check still reads PUBLIC', () => {
    expect(step).toContain('`PUBLIC`')
    expect(step).toMatch(/public[^.]*raw form/i)
  })

  test('private, internal and unknown visibility ask for an explicit answer before anything is published', () => {
    expect(step).toMatch(/private/i)
    expect(step).toMatch(/internal/i)
    expect(step).toMatch(/unknown/i)
    expect(step).toMatch(/explicit answer/i)
    expect(step).toMatch(/before anything is published/i)
    expect(step).toMatch(/never infer[^.]*(consent|answer)/i)
    expect(step).toMatch(/no default/i)
  })

  test('the prompt says the images stay in the repository history', () => {
    expect(step).toMatch(/stay in the repository's (git )?history/i)
  })

  test('the prompt says the images become public if the repository is later made public or forked', () => {
    expect(step).toMatch(/later made public, or is forked[^.]*become public/i)
  })

  test('the prompt says cleanup removes the images from the branch but not from history', () => {
    expect(step).toMatch(
      /cleanup removes them from the branch[^.]*not from (the repository's )?(git )?history/i,
    )
  })

  test('the gate runs before the copy, the commit and the push', () => {
    expect(skill.indexOf('explicit answer')).toBeGreaterThan(-1)
    expect(skill.indexOf('explicit answer')).toBeLessThan(
      skill.indexOf('### Copy into place'),
    )
  })

  test('a decline publishes nothing and ends embed mode with the fixed failed line', () => {
    expect(step).toMatch(/declines?[^.]*nothing is published/i)
    expect(step).toContain(
      'pr-attachments: status=failed evidence=none reason=declined',
    )
  })

  test('a decline reuses the declined reason, and the retired not-public reason and skip-only text are gone', () => {
    expect(flat).toContain('`declined`')
    expect(flat).not.toContain('not-public')
    expect(flat).not.toMatch(/skip only|public repositories only/i)
  })

  test('says why private repositories use the blob form', () => {
    // The wording is free; the terms are not.
    expect(step).toMatch(/private[^.]*blob form[^.]*signed-in members/i)
    expect(step).toMatch(/raw links? (?:do|does) not render/i)
  })

  test('proceeding emits the blob form for every embed and only the blob form', () => {
    expect(step).toMatch(/blob form[^.]*every embed[^.]*only the blob form/i)
  })

  test('the viewer permission and github.com checks still apply to every repository', () => {
    expect(step).toMatch(/`ADMIN`, `MAINTAIN` or `WRITE`/)
    expect(step).toContain('https://github.com/')
  })

  test('re-pin mode asks nothing, because it publishes nothing', () => {
    expect(step).toMatch(/re-pin mode[^.]*(asks nothing|no question)/i)
  })

  test('the scrub prompt does not call a private repository public', () => {
    const scrub = normalize(
      section(skill, '## Step 5: List the set and confirm the scrub'),
    )
    expect(scrub).toMatch(/private[^.]*instead of[^.]*public/i)
  })
})

describe('pr-attachments skill contract -- private repositories and messages', () => {
  test('relays the SVG message as is', () => {
    expect(flat).toContain('SVG is not supported by this skill')
  })

  test('classify results are routed, including whole-batch rejection', () => {
    const step = normalize(section(skill, '## Step 2: Classify the images'))
    for (const code of ['accepted', 'rejected', 'needs-input', 'usage-error']) {
      expect(step, code).toContain(`\`${code}\``)
    }
    expect(step).toMatch(/whole batch/i)
  })

  test('the size rule is the live 10 MiB cutoff, stated once and never softened', () => {
    const step = normalize(section(skill, '## Step 2: Classify the images'))
    expect(step).toMatch(
      /over 10 MiB[^.]*rejected[^.]*before anything is published/i,
    )
    expect(step).toMatch(/does not serve larger files as images/i)
    expect(flat).not.toContain('large-file')
    expect(flat).not.toMatch(/100\s*(MiB|MB)/i)
    expect(flat).not.toMatch(/\b10 MB\b/)
    expect(flat).not.toMatch(/may not render/i)
  })

  test('verify results are routed', () => {
    const step = normalize(section(skill, '## Step 7: Verify the embeds'))
    for (const code of ['verified', 'failed', 'blob-url', 'usage-error']) {
      expect(step, code).toContain(`\`${code}\``)
    }
    expect(step).toMatch(/never print or paste a response body/i)
  })
})

describe('pr-attachments skill contract -- helper result codes', () => {
  test('every helper result code is routed somewhere in the prose', () => {
    const missing = [...ROUTED_RESULT_CODES, ...ROUTED_DETAIL_CODES].filter(
      (code) => !flat.includes(`\`${code}\``),
    )
    expect(missing).toEqual([])
  })

  test('every routed code is a real helper code, so the list cannot drift', () => {
    const helper = fs.readFileSync(HELPER_PATH, 'utf8')
    const unknown = [...ROUTED_RESULT_CODES, ...ROUTED_DETAIL_CODES].filter(
      (code) => !helper.includes(`'${code}'`) && !helper.includes(` ${code}`),
    )
    expect(unknown).toEqual([])
  })

  test('internal and usage errors are stops in every mode', () => {
    expect(flat).toMatch(/`usage-error`[^.]*stop/i)
    expect(flat).toMatch(/`internal-error`[^.]*stop/i)
  })
})

describe('pr-attachments skill contract -- private repositories: the blob form', () => {
  const step7 = section(skill, '## Step 7: Verify the embeds')
  const publicPath = section(skill, '### Public repositories: the raw form')
  const privatePath = section(skill, '### Private repositories: the blob form')
  const privateText = normalize(privatePath)
  const privateCommands = fencedBlocks(privatePath)
    .map((block) => block.body)
    .join('\n')

  test('Step 7 has one subsection per link form', () => {
    expect(publicPath).not.toBe('')
    expect(privatePath).not.toBe('')
    expect(step7.indexOf('### Public repositories')).toBeLessThan(
      step7.indexOf('### Private repositories'),
    )
  })

  test('public repositories are unchanged: the raw form and the anonymous verify call', () => {
    expect(publicPath).toContain('https://raw.githubusercontent.com/%s/%s/%s')
    expect(publicPath).toContain(`${INVOKE} verify`)
    expect(publicPath).not.toContain('blob/')
    expect(publicPath).not.toContain('gh api')
    expect(normalize(publicPath)).toMatch(/`blob-url`[^.]*stop/i)
  })

  test('the Demo text for a private repository is built from git pins in the blob form', () => {
    expect(privateCommands).toContain(
      'https://github.com/%s/blob/%s/%s?raw=true',
    )
    expect(privateCommands).toContain(
      'git log -n 1 --no-renames --diff-filter=AM --format=%H HEAD',
    )
    expect(privateCommands).not.toContain('raw.githubusercontent.com')
  })

  test('verification goes through gh api contents with --jq .sha, at the pinned commit', () => {
    expect(privateCommands).toContain(
      'gh api "repos/$OWNER_REPO/contents/$DEST?ref=$PIN" --jq .sha',
    )
  })

  test('the git blob SHA from gh is compared to the blob_sha that classify reported', () => {
    expect(privateText).toMatch(/`blob_sha`[^.]*classify/i)
    expect(privateCommands).toMatch(/\[ "\$ACTUAL" = "\$EXPECTED" \]/)
    expect(privateText).toMatch(/byte-identical/i)
  })

  test('the private path never calls the helper verify subcommand and never downloads bytes', () => {
    expect(privatePath).not.toContain(`${INVOKE} verify`)
    expect(privatePath).not.toContain('pr-attachments.mjs')
    expect(privateCommands).not.toMatch(/\b(?:curl|wget)\b/)
    expect(privateText).toMatch(/never through the helper's `verify`/i)
  })

  test('the check is bounded: a few retries for propagation, then it stops with state', () => {
    expect(privateCommands).toMatch(/for ATTEMPT in 1 2 3 4/)
    expect(privateCommands).toMatch(/sleep \d+/)
    expect(privateText).toMatch(/stop with the state reached/i)
  })

  test('a failed check never writes the description and never returns the Demo file', () => {
    expect(privateText).toMatch(
      /never write the description, and never return the Demo file/i,
    )
    expect(privateText).toContain('`verify-failed`')
    expect(privateText).toMatch(/pushed and unreferenced/i)
  })

  test('the gh check runs before the description is written', () => {
    expect(skill.indexOf('gh api "repos/')).toBeGreaterThan(-1)
    expect(skill.indexOf('gh api "repos/')).toBeLessThan(
      skill.indexOf('gh pr edit'),
    )
  })

  test('re-pin mode handles the blob form: urls, pins, repin-rewrite, the gh check, then the write', () => {
    const repin = section(skill, '## Re-pin mode')
    const text = normalize(repin)
    expect(text).not.toMatch(/which this skill does not handle/i)
    expect(text).toMatch(/`form`/)
    expect(text).toMatch(/`blob`/)
    expect(text).toMatch(/`raw`/)
    expect(text).toMatch(/form must match the repository[^.]*or the run stops/i)
    const positions = [
      repin.indexOf(`${INVOKE} urls`),
      repin.indexOf(`${INVOKE} pins`),
      repin.indexOf(`${INVOKE} repin-rewrite`),
      repin.indexOf('Private repositories: the blob form'),
      repin.indexOf('write step of Step 8'),
    ]
    for (const position of positions) {
      expect(position).toBeGreaterThan(-1)
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  test('re-pin mode takes the expected blob from git, because it has no classify result', () => {
    expect(privateText).toMatch(/re-pin mode has no classify result/i)
    expect(privateCommands).toContain('git rev-parse "$PIN:$DEST"')
  })

  test('cleanup is the same for private repositories and repeats the history disclosure', () => {
    const cleanup = normalize(section(skill, '## Cleanup'))
    expect(cleanup).toMatch(
      /private[^.]*stay in the repository's history[^.]*public/i,
    )
    expect(cleanup).toContain(
      'Cleanup does not revoke access, so any published secret must be rotated.',
    )
  })

  test('the disclosures say blob links need access to the repository', () => {
    const disclosures = normalize(section(skill, '## Disclosures'))
    expect(disclosures).toMatch(/private[^.]*(signed-in|access)/i)
    expect(disclosures).toMatch(/forked/i)
  })

  test('uses no internal planning vocabulary and no dates', () => {
    expect(skill).not.toMatch(/\bprobe\b|\bO[1-4]\b|\bUnit \d|\bthe plan\b/i)
    expect(skill).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
  })
})

describe('pr-attachments skill contract -- source, commit and push safety', () => {
  const scrub = normalize(
    section(skill, '## Step 5: List the set and confirm the scrub'),
  )
  const copy = section(skill, '### Copy into place')
  const commit = section(skill, '### Commit by pathspec')
  const push = section(skill, '### Push with an explicit refspec')
  const pushText = normalize(push)

  test('the scrub list shows each file blob_sha', () => {
    expect(scrub).toMatch(/blob_sha/)
  })

  test('each copy first recomputes the raw-bytes blob SHA of the source and stops when it differs', () => {
    const block = fencedBlocks(copy)
      .map((entry) => entry.body)
      .find((body) => body.includes('cp -- "$SRC" "$DEST"'))
    expect(block).toContain('git hash-object --no-filters -- "$SRC"')
    expect(block?.indexOf('git hash-object')).toBeLessThan(
      block?.indexOf('cp -- "$SRC"') ?? -1,
    )
    const text = normalize(copy)
    expect(text).toMatch(/`blob_sha` that classify reported/i)
    expect(text).toMatch(/differs[^.]*stop/i)
    expect(text).toMatch(/raw bytes/i)
    expect(text).toContain('`source-changed`')
  })

  test('a failed evidence commit is unstaged again, and the unstaging is checked', () => {
    const blocksText = fencedBlocks(commit)
      .map((entry) => entry.body)
      .join('\n')
    expect(blocksText).toContain('git restore --staged -- "$@"')
    expect(blocksText).toContain('git diff --cached --name-only -- "$@"')
    expect(normalize(commit)).toMatch(
      /commit fails[^.]*git restore --staged[^.]*(?:same paths|these paths)/i,
    )
    expect(normalize(commit)).toMatch(/stop with the state reached/i)
  })

  test('a failed cleanup commit uses the same recovery', () => {
    const cleanup = normalize(section(skill, '## Cleanup'))
    expect(cleanup).toMatch(
      /commit fails[^.]*git restore --staged[^.]*(?:same|these) paths/i,
    )
  })

  test('the push turns prompts off', () => {
    const pushBlock = fencedBlocks(push)
      .map((entry) => entry.body)
      .find((body) => body.includes('git push "$REMOTE"'))
    expect(pushBlock).toContain(
      'GIT_TERMINAL_PROMPT=0 git push "$REMOTE" "HEAD:refs/heads/$BRANCH"',
    )
  })

  test('a non-zero push is checked against the remote branch before anything is reported', () => {
    const blocksText = fencedBlocks(push)
      .map((entry) => entry.body)
      .join('\n')
    expect(blocksText).toContain('git ls-remote "$REMOTE" "refs/heads/$BRANCH"')
    expect(pushText).toMatch(
      /exits? non-zero[^.]*ls-remote|ls-remote[^.]*non-zero/i,
    )
    expect(pushText).toMatch(/remote SHA equals `HEAD`[^.]*landed[^.]*pushed/i)
    expect(pushText).toMatch(/only locally|local and unpushed/i)
    expect(pushText).toContain('`evidence=local`')
  })

  test('the push adds no timeout wrapper, because no pattern in the skill uses one', () => {
    const commands = blocks.map((block) => block.body).join('\n')
    expect(commands).not.toMatch(/(?:^|\s)timeout\s+\d/m)
    expect(commands).not.toMatch(/\bgtimeout\b/)
  })
})

describe('pr-attachments skill contract -- the default branch is never a push target', () => {
  const visibility = normalize(section(skill, '## Step 4: Check visibility'))

  test('the visibility call also reads the default branch', () => {
    expect(visibility).toContain('defaultBranchRef')
  })

  test('embed mode and PR mode refuse a push target equal to the default branch, and say how to fix it', () => {
    expect(visibility).toMatch(
      /push target[^.]*default branch[^.]*(?:refuse|stop)/i,
    )
    expect(visibility).toMatch(/embed mode/i)
    expect(visibility).toMatch(/PR mode/)
    expect(visibility).toMatch(/create a feature branch[^.]*set its upstream/i)
    expect(visibility).toContain('`default-branch`')
  })

  test('cleanup applies the same refusal before its push', () => {
    const cleanup = normalize(section(skill, '## Cleanup'))
    expect(cleanup).toMatch(/default branch/i)
  })
})

describe('pr-attachments skill contract -- the body write guard compares like with like', () => {
  const step = section(
    skill,
    '## Step 8: Write the description or return the Demo file',
  )
  const text = normalize(step)
  const guard = fencedBlocks(step)
    .map((entry) => entry.body)
    .find((body) => body.includes('RECHECK='))

  test('the recheck compares only the body field on both sides', () => {
    expect(guard).toBeDefined()
    expect(guard).not.toMatch(/cmp -s "\$BACKUP" "\$RECHECK"/)
    expect(guard).toContain('.body')
    expect(guard).toContain('"$BACKUP"')
    expect(guard).toContain('"$RECHECK"')
    expect(guard).toMatch(/gh pr edit "\$PR" --body-file "\$NEW_BODY"/)
    expect(text).toMatch(/compare only the `body`/i)
    expect(text).toMatch(/every mode that writes/i)
  })

  test('the recheck does not rebuild a demo_file-shaped template', () => {
    expect(guard).not.toContain('demo_file')
    expect(guard).not.toContain('out_file')
  })
})

describe('pr-attachments skill contract -- verify and the private check', () => {
  const verify = normalize(section(skill, '## Step 7: Verify the embeds'))
  const privatePath = section(skill, '### Private repositories: the blob form')
  const privateText = normalize(privatePath)
  const privateCommands = fencedBlocks(privatePath)
    .map((entry) => entry.body)
    .join('\n')

  test('the caller passes the latest waited_s on unchanged and sums nothing', () => {
    expect(verify).toMatch(
      /`waited_s` (?:of|from) the latest report[^.]*unchanged/i,
    )
    expect(verify).not.toMatch(/sum of|add(?:ed)? up|sum the/i)
  })

  test('gh stderr goes to a temp file, and an API failure is not reported as a mismatch', () => {
    expect(privateCommands).toMatch(/2>"\$ERR_FILE"/)
    expect(privateCommands).toMatch(/ERR_FILE="\$\(mktemp\)"/)
    expect(privateCommands).toContain('api-error')
    expect(privateCommands).toContain('mismatch')
    expect(privateCommands).toMatch(/head -n 1 "\$ERR_FILE"/)
    expect(privateCommands).toContain('rm -f "$ERR_FILE"')
    expect(privateText).toMatch(/`api-error`[^.]*first line of stderr/i)
    expect(privateText).toMatch(/`mismatch`/)
    expect(privateCommands).toMatch(/for ATTEMPT in 1 2 3 4/)
  })
})

describe('pr-attachments skill contract -- re-pin partial', () => {
  const text = normalize(section(skill, '## Re-pin mode'))

  test('after reporting partial it offers the next actions', () => {
    expect(text).toMatch(/`partial`[\s\S]*offer/i)
    expect(text).toMatch(
      /re-pin the resolved paths[^.]*only the resolved ones[^.]*(?:write guard|guard)/i,
    )
    expect(text).toMatch(/re-add the missing images in PR mode/i)
  })
})

describe('pr-attachments skill contract -- embed-mode stop reasons', () => {
  const step8 = section(
    skill,
    '## Step 8: Write the description or return the Demo file',
  )
  const tableRows = step8
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4 && /^`[a-z-]+`$/.test(cells[2] ?? ''))
    .map((cells) => ({
      stop: cells[1] ?? '',
      reason: (cells[2] ?? '').slice(1, -1),
    }))
  const tableReasons = new Set(tableRows.map((row) => row.reason))

  // The prose outside the table, outside carry mode (which has its own
  // vocabulary), is where stops name their reason.
  const withoutCarry = skill.replace(section(skill, '## Carry mode'), '')
  const embedProse = withoutCarry
    .split('\n')
    .filter((line) => !line.startsWith('|'))
    .join('\n')
  const named = new Set([
    ...[
      ...embedProse.matchAll(/\breason (?:is |of )?`([a-z]+(?:-[a-z]+)*)`/gi),
    ].map((match) => match[1] as string),
    ...[...embedProse.matchAll(/\breason=([a-z]+(?:-[a-z]+)*)/g)].map(
      (match) => match[1] as string,
    ),
  ])

  test('one table maps stops to reasons', () => {
    expect(tableRows.length).toBeGreaterThanOrEqual(14)
    for (const row of tableRows) {
      expect(row.stop, row.reason).not.toBe('')
    }
  })

  test('every reason named in the prose is in the table', () => {
    expect([...named].filter((reason) => !tableReasons.has(reason))).toEqual([])
  })

  test('every table reason is named by a stop in the prose', () => {
    expect([...tableReasons].filter((reason) => !named.has(reason))).toEqual([])
  })

  test.each([
    ['rejected', /classify[^|]*`rejected`/i, 'rejected-images'],
    ['needs-input', /classify[^|]*`needs-input`/i, 'needs-input'],
    ['usage-error', /`usage-error`/, 'helper-failed'],
    ['internal-error', /`internal-error`/, 'helper-failed'],
    ['gitignored', /gitignored/i, 'destination-blocked'],
    ['LFS', /LFS|filter/, 'destination-blocked'],
    ['dirty destination', /uncommitted/i, 'destination-blocked'],
    ['hook or commit', /hook[^|]*commit|commit[^|]*hook/i, 'commit-failed'],
    [
      'file-set mismatch',
      /file set[^|]*(?:mismatch|differ|outside)/i,
      'file-set-mismatch',
    ],
    ['default branch', /default branch/i, 'default-branch'],
    ['source changed', /source[^|]*(?:changed|differs)/i, 'source-changed'],
  ] as const)('the table covers %s', (_name, stop, reason) => {
    const row = tableRows.find((entry) => stop.test(entry.stop))
    expect(row, `a row for ${_name}`).toBeDefined()
    expect(row?.reason).toBe(reason)
  })

  test('the existing reasons stay', () => {
    for (const reason of [
      'node-unavailable',
      'helper-failed',
      'rejected-images',
      'declined',
      'no-target',
      'git-failed',
      'push-rejected',
      'verify-failed',
    ]) {
      expect(tableReasons.has(reason), reason).toBe(true)
    }
  })

  test('evidence local means the evidence commit exists only on this machine', () => {
    const text = normalize(step8)
    expect(text).toMatch(
      /`evidence` is `pushed` once the push landed[^.]*`local`[^.]*evidence commit[^.]*(?:only on this machine|not pushed)[^.]*`none`/i,
    )
    expect(text).toContain('evidence=<pushed|local|none>')
  })
})
