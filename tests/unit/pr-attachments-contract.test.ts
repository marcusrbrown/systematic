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
  'urls',
  'pins',
  'repin-rewrite',
  'cleanup-set',
  'verify',
] as const

// Every result code the helper returns that the skill acts on. `extracted` and
// `absent` belong to `extract`, which this skill never calls.
const ROUTED_RESULT_CODES = [
  'accepted',
  'rejected',
  'needs-input',
  'spliced',
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
    expect(fields['argument-hint']).toMatch(/image/i)
    expect(fields['argument-hint']).toMatch(/pr:/)
  })

  test('names all four modes', () => {
    for (const mode of ['PR mode', 'Embed mode', 'Re-pin mode', 'Cleanup']) {
      expect(skill, mode).toContain(mode)
    }
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

  test('mode:embed is the only mode token; any other mode: token stops', () => {
    expect(flat).toMatch(/any other `mode:` token[^.]*stop/i)
  })

  test('the dispatch rule fires when no mode token is seen', () => {
    const step = normalize(
      section(skill, '## Step 3: Resolve the target and pick the mode'),
    )
    expect(step).toContain(
      'open the PR first, or run through git-commit-push-pr',
    )
    expect(step).toMatch(
      /no `mode:embed` token and finds no open PR[^.]*stops[^.]*never guesses/i,
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
      /pr-attachments: status=failed evidence=<pushed\|none> reason=\S+/,
    )
  })

  test('failure reasons are a fixed vocabulary, including the node-missing one', () => {
    for (const reason of [
      'node-unavailable',
      'declined',
      'not-public',
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

describe('pr-attachments skill contract -- private repositories and messages', () => {
  test('private and unknown visibility are skip-only', () => {
    const step = normalize(section(skill, '## Step 4: Check visibility'))
    expect(step).toMatch(/private|unknown/i)
    expect(step).toMatch(/skip only/i)
    expect(step).toContain('`PUBLIC`')
    expect(step).not.toMatch(/blob\/|\?raw=true|gh api/)
  })

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
