/**
 * Contract tests for the pinned diff scope in `ce:review`.
 *
 * The parent pins the checkout path, base SHA, head and a manifest once. Every
 * reviewer, CE agent and Stage 5b validator reads one path's diff against
 * those values instead of receiving an inline diff or recomputing the range.
 * Skill text is not code, so the text tests pin the facts a run depends on.
 * The shell tests run the documented capture commands in a real temp
 * repository, because the capture is the only executable part of the handoff.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Slice from a heading to the next heading of the same or shallower level.
 * Lines inside a code fence are never headings, so a shell comment cannot end
 * the slice early.
 */
function section(text: string, heading: string): string {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.trim() === heading)
  if (index < 0) return ''
  const level = (lines[index]?.match(/^#+/) ?? [''])[0]?.length ?? 0
  const out: string[] = []
  let inFence = false
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim().startsWith('```')) inFence = !inFence
    const next = inFence ? null : line.match(/^(#+)\s/)
    if (next && (next[1]?.length ?? 0) <= level) break
    out.push(line)
  }
  return out.join('\n')
}

/** The first fenced code block in a slice of markdown. */
function firstFence(text: string): string {
  const match = text.match(/```[a-z]*\n([\s\S]*?)\n```/)
  return match?.[1] ?? ''
}

const SKILL = read('skills/ce-review/SKILL.md')
const REVIEWER_TEMPLATE = read(
  'skills/ce-review/references/subagent-template.md',
)
const VALIDATOR_TEMPLATE = read(
  'skills/ce-review/references/validator-template.md',
)
const DIFF_SCOPE = read('skills/ce-review/references/diff-scope.md')

const STAGE_1_RAW = section(SKILL, '### Stage 1: Determine scope')
const STAGE_1 = normalize(STAGE_1_RAW)
const PIN_RAW = section(SKILL, '#### Pin the scope')
const PIN = normalize(PIN_RAW)
const STAGE_4 = normalize(section(SKILL, '### Stage 4: Spawn sub-agents'))
const STAGE_5B = normalize(section(SKILL, '### Stage 5b: Validation pass'))
const STAGE_6_RAW = section(SKILL, '### Stage 6: Synthesize and present')
const STAGE_6 = normalize(STAGE_6_RAW)
const REPORT_ONLY_RULES = normalize(
  section(SKILL, '### Report-only mode rules'),
)
const GATES = normalize(section(SKILL, '### Verification gates'))
const REVIEWER = normalize(REVIEWER_TEMPLATE)
const VALIDATOR = normalize(VALIDATOR_TEMPLATE)
const REVIEWER_CONTEXT = normalize(
  REVIEWER_TEMPLATE.slice(REVIEWER_TEMPLATE.indexOf('<review-context>')),
)
const VALIDATOR_CONTEXT = normalize(
  VALIDATOR_TEMPLATE.slice(VALIDATOR_TEMPLATE.indexOf('<review-context>')),
)
const SCOPE_RULES = normalize(DIFF_SCOPE)

const NO_RECOMPUTE = /do not recompute the supplied review scope/i

describe('ce:review pinned scope: what Stage 1 pins', () => {
  test('pins the checkout path, base SHA, head and a manifest once', () => {
    expect(PIN).toMatch(/pin(?:s|ned)? the scope once/i)
    for (const value of [
      /checkout path/i,
      /base SHA/i,
      /\bhead\b/i,
      /\bmanifest\b/i,
    ]) {
      expect(PIN, value.source).toMatch(value)
    }
  })

  test('the head is the checked-out commit, or "working tree" when the checkout is dirty', () => {
    expect(PIN).toMatch(/the checked-out commit/i)
    expect(PIN).toMatch(/"working tree"/)
    expect(PIN).toMatch(/staged or unstaged changes/i)
  })

  test('each manifest entry has a path, a status, a rename source and added and deleted counts', () => {
    expect(PIN).toMatch(/path, (?:its )?status/i)
    expect(PIN).toMatch(/rename source/i)
    expect(PIN).toMatch(/added and deleted line counts/i)
    for (const status of ['`A`', '`M`', '`D`', '`R`', '`T`']) {
      expect(PIN, status).toContain(status)
    }
  })

  test('untracked files stay scope notes, not manifest entries', () => {
    expect(PIN).toMatch(/`UNTRACKED:`/)
    expect(STAGE_1).toMatch(/Untracked file handling/)
  })

  test('every Stage 1 path pins the scope and none prints an inline diff', () => {
    expect(STAGE_1).not.toMatch(/git diff -U10/)
    expect(STAGE_1).not.toMatch(/echo "DIFF:"/)
    const pinReferences = STAGE_1.match(/Pin the scope/g) ?? []
    // The base: fast path, the PR path, the branch path and the standalone path.
    expect(pinReferences.length).toBeGreaterThanOrEqual(4)
  })

  test('the skill writes no diff file, and says so for report-only', () => {
    expect(PIN).toMatch(/writes? no diff file/i)
    expect(REPORT_ONLY_RULES).toMatch(/writes? no diff file/i)
  })
})

describe('ce:review pinned scope: an unpinnable scope ends the run before dispatch', () => {
  test('an unresolvable base, head or manifest ends visibly incomplete with nothing dispatched', () => {
    expect(PIN).toMatch(/base[^.]*head[^.]*manifest[^.]*cannot/i)
    expect(PIN).toMatch(/Review failed\. Reason: scope could not be pinned/)
    expect(PIN).toMatch(
      /Review failed \(headless mode\)\. Reason: scope could not be pinned/,
    )
    expect(PIN).toMatch(/before (?:any )?dispatch/i)
    expect(PIN).toMatch(/never claims? full coverage/i)
  })
})

describe('ce:review pinned scope: what children receive', () => {
  test('the reviewer template carries the pinned values and no inline diff', () => {
    expect(REVIEWER_CONTEXT).toContain('{checkout_path}')
    expect(REVIEWER_CONTEXT).toContain('{base_sha}')
    expect(REVIEWER_CONTEXT).toContain('{head}')
    expect(REVIEWER_CONTEXT).toContain('{manifest}')
    expect(REVIEWER).not.toContain('{diff}')
    expect(REVIEWER).not.toContain('{file_list}')
    expect(REVIEWER).toMatch(NO_RECOMPUTE)
  })

  test('the validator template carries the same pinned values and no inline diff', () => {
    expect(VALIDATOR_CONTEXT).toContain('{checkout_path}')
    expect(VALIDATOR_CONTEXT).toContain('{base_sha}')
    expect(VALIDATOR_CONTEXT).toContain('{head}')
    expect(VALIDATOR_CONTEXT).toContain('{manifest}')
    expect(VALIDATOR).not.toContain('{diff}')
    expect(VALIDATOR).not.toContain('{file_list}')
    expect(VALIDATOR).toMatch(NO_RECOMPUTE)
  })

  test('both variable references document the pinned values and drop the inline diff', () => {
    for (const template of [REVIEWER_TEMPLATE, VALIDATOR_TEMPLATE]) {
      const reference = template.slice(
        template.indexOf('## Variable Reference'),
      )
      expect(reference).toContain('`{checkout_path}`')
      expect(reference).toContain('`{base_sha}`')
      expect(reference).toContain('`{head}`')
      expect(reference).toContain('`{manifest}`')
      expect(reference).not.toContain('`{diff}`')
      expect(reference).not.toContain('`{file_list}`')
    }
  })

  test('Stage 4 hands reviewers the pinned scope, not a diff', () => {
    expect(STAGE_4).toMatch(/checkout path, base SHA, head, and manifest/i)
    expect(STAGE_4).not.toMatch(/intent summary, file list, diff/i)
    expect(STAGE_4).not.toMatch(/file list, diff, and `UNTRACKED:`/i)
  })

  test('CE agents get the same pinned scope', () => {
    const ceAgents = normalize(
      STAGE_4.slice(STAGE_4.indexOf('**CE conditional agents**')),
    )
    expect(ceAgents).toMatch(/checkout path, base SHA, head, and manifest/i)
    expect(ceAgents).toMatch(/same review context bundle/i)
  })

  test('Stage 5b validators receive the reviewers’ scope', () => {
    expect(STAGE_5B).toMatch(/checkout path, base SHA, head, and manifest/i)
    expect(STAGE_5B).toMatch(/same (?:pinned )?scope[^.]*reviewers/i)
    expect(STAGE_5B).not.toMatch(/full diff/i)
    expect(VALIDATOR).toMatch(/same (?:pinned )?scope[^.]*reviewers/i)
  })
})

describe('ce:review pinned scope: how a child reads it', () => {
  test('a base-to-head per-path diff is the read for a commit head', () => {
    expect(SCOPE_RULES).toMatch(
      /git -C <checkout_path> diff -U10 <base_sha> <head> -- <path>/,
    )
    expect(VALIDATOR).toMatch(
      /git -C <checkout_path> diff -U10 <base_sha> <head> -- <path>/,
    )
  })

  test('a working-tree head is read against the working tree', () => {
    expect(SCOPE_RULES).toMatch(
      /head is "working tree"[^.]*git -C <checkout_path> diff -U10 <base_sha> -- <path>/i,
    )
    expect(VALIDATOR).toMatch(
      /head is "working tree"[^.]*git -C <checkout_path> diff -U10 <base_sha> -- <path>/i,
    )
  })

  test('a rename reads the rename source and the path together', () => {
    expect(SCOPE_RULES).toMatch(/rename source/i)
    expect(VALIDATOR).toMatch(/rename source/i)
  })

  test('old source, including a deleted file, comes from the base commit', () => {
    expect(SCOPE_RULES).toMatch(/git -C <checkout_path> show <base_sha>:<path>/)
    expect(SCOPE_RULES).toMatch(/deleted/i)
    expect(VALIDATOR).toMatch(/git -C <checkout_path> show <base_sha>:<path>/)
    expect(VALIDATOR).toMatch(/deleted/i)
  })

  test('a range-wide diff or log to rebuild or widen the scope is not permitted', () => {
    for (const rules of [SCOPE_RULES, REVIEWER, VALIDATOR]) {
      expect(rules).toMatch(NO_RECOMPUTE)
    }
    expect(SCOPE_RULES).toMatch(/range-wide diff or log[^.]*(?:rebuild|widen)/i)
    expect(VALIDATOR).toMatch(/range-wide diff or log[^.]*(?:rebuild|widen)/i)
    expect(SCOPE_RULES).not.toMatch(/need not run git commands/i)
  })

  test('the read-only sentence no longer invites a range-wide diff or log', () => {
    const readOnly = normalize(
      STAGE_4.slice(STAGE_4.indexOf('Read-only here means')),
    )
    const sentence = readOnly.slice(
      0,
      readOnly.indexOf('Reviewer sub-agents also never'),
    )
    expect(sentence).toMatch(/one pinned path/i)
    expect(sentence).not.toMatch(/`git diff`,/)
    expect(sentence).not.toMatch(/`git log`,/)
    expect(normalize(REVIEWER_TEMPLATE)).not.toMatch(/`git diff`, `git log`/)
    expect(VALIDATOR).not.toMatch(/git log, git diff/)
  })

  test('every git command a child runs targets the pinned checkout', () => {
    expect(SCOPE_RULES).toMatch(/git -C <checkout_path>/)
    expect(SCOPE_RULES).toMatch(/pinned checkout/i)
  })
})

/**
 * The parent model writes each reviewer prompt itself, so the
 * `{diff_scope_rules}` slot is not a guarantee: the rules can be dropped or
 * summarized on the way. The per-path rule therefore lives literally in the
 * template body and the review context, and every pin below reads those, never
 * the diff-scope reference.
 */
const BOUNDED = normalize(
  REVIEWER_TEMPLATE.slice(
    REVIEWER_TEMPLATE.indexOf('<bounded-investigation>'),
    REVIEWER_TEMPLATE.indexOf('</bounded-investigation>'),
  ),
)
const REVIEWER_VARIABLES = normalize(
  REVIEWER_TEMPLATE.slice(REVIEWER_TEMPLATE.indexOf('## Variable Reference')),
)
const SPAWNING = normalize(section(SKILL, '#### Spawning'))
const CE_AGENTS = normalize(
  STAGE_4.slice(
    STAGE_4.indexOf('**CE conditional agents**'),
    STAGE_4.indexOf('**CE agent gate boundary.**'),
  ),
)

/**
 * The validator template names the same per-path read as the reviewer template
 * and bans the same range-wide forms, in its own `<pinned-scope>` block, so a
 * validator that never sees the diff-scope reference still gets the bans.
 */
const VALIDATOR_PINNED_SCOPE = normalize(
  VALIDATOR_TEMPLATE.slice(
    VALIDATOR_TEMPLATE.indexOf('<pinned-scope>'),
    VALIDATOR_TEMPLATE.indexOf('</pinned-scope>'),
  ),
)

describe('ce:review pinned scope: the validator template bans range-wide git reads', () => {
  const VALIDATOR_BAN_PINS: readonly (readonly [string, RegExp])[] = [
    ['one path per call', /read one path's diff per call/i],
    ['the not-permitted list opens', /not permitted:/i],
    ['a diff or log with no path', /a diff or log with no path/i],
    ['git diff --stat', /`git diff --stat`/],
    ['git diff --name-only', /`git diff --name-only`/],
    ['git log <base>..', /`git log <base_sha>\.\.`/],
    ['several paths in one call', /one call that lists several paths/i],
    [
      'the rename source and path are the one multi-path exception',
      /rename's source and path together[^.]*exception/i,
    ],
    [
      'the manifest is the complete file list',
      /the manifest in the review context is the complete file list/i,
    ],
    ['never rebuild the file list with git', /never rebuild it with git/i],
  ]
  test('the pinned-scope block exists', () => {
    expect(VALIDATOR_PINNED_SCOPE.length).toBeGreaterThan(0)
  })
  for (const [name, pattern] of VALIDATOR_BAN_PINS) {
    test(`the validator pinned scope states: ${name}`, () => {
      expect(VALIDATOR_PINNED_SCOPE).toMatch(pattern)
    })
  }
})

describe('ce:review pinned scope: the per-path rule survives the parent’s prompt assembly', () => {
  test('the rule stays in the template body when the scope-rules slot is dropped', () => {
    expect(BOUNDED.length).toBeGreaterThan(0)
    const withoutSlot = REVIEWER_TEMPLATE.replace('{diff_scope_rules}', '')
    expect(normalize(withoutSlot)).toContain(BOUNDED)
  })

  const BODY_PINS: readonly (readonly [string, RegExp])[] = [
    ['one path per call', /read one path's diff per call/i],
    ['the not-permitted list opens', /not permitted:/i],
    ['a diff or log with no path', /a diff or log with no path/i],
    ['git diff --stat', /`git diff --stat`/],
    ['git diff --name-only', /`git diff --name-only`/],
    ['git log <base>..', /`git log <base_sha>\.\.`/],
    ['several paths in one call', /one call that lists several paths/i],
    [
      'the rename source and path are the one multi-path exception',
      /rename's source and path together[^.]*exception/i,
    ],
    [
      'the manifest is the complete file list',
      /the manifest in the review context is the complete file list/i,
    ],
    ['never rebuild the file list with git', /never rebuild it with git/i],
  ]
  for (const [name, pattern] of BODY_PINS) {
    test(`the template body states: ${name}`, () => {
      expect(BOUNDED).toMatch(pattern)
    })
  }

  const CONTEXT_PINS: readonly (readonly [string, RegExp])[] = [
    [
      'the filled-in one-path diff command',
      /Read one path's diff with this command[^.]*: \{path_diff_command\}/,
    ],
    [
      'the base-side form for old source and deleted files',
      /git -C \{checkout_path\} show \{base_sha\}:<path>/,
    ],
    [
      'the manifest is the complete file list',
      /The Manifest below is the complete file list; never rebuild it with git/,
    ],
  ]
  for (const [name, pattern] of CONTEXT_PINS) {
    test(`the review context carries: ${name}`, () => {
      expect(REVIEWER_CONTEXT).toMatch(pattern)
    })
  }

  test('the command is a documented variable with a form for each head kind', () => {
    expect(REVIEWER_VARIABLES).toMatch(/`\{path_diff_command\}`/)
    expect(REVIEWER_VARIABLES).toMatch(
      /`git -C <checkout_path> diff -U10 <base_sha> <head> -- <path>`/,
    )
    expect(REVIEWER_VARIABLES).toMatch(
      /"working tree"[^|]*`git -C <checkout_path> diff -U10 <base_sha> -- <path>`/,
    )
  })

  test('the documented commands run for real against the pinned scope', () => {
    const row = REVIEWER_TEMPLATE.split('\n').find((line) =>
      line.startsWith('| `{path_diff_command}`'),
    )
    const forms = [...(row ?? '').matchAll(/`(git -C [^`]+)`/g)].map(
      (match) => match[1] as string,
    )
    expect(forms.length).toBe(2)
    // A space in the checkout path fails the commands unless they quote it.
    const repo = makeRepo('ce-review pin-')
    try {
      // Values reach the shell as quoted variables, never spliced into the script.
      const fill = (command: string) =>
        command
          .replace('<checkout_path>', '"$CHECKOUT_PATH"')
          .replace('<base_sha>', '"$BASE_SHA"')
          .replace('<head>', '"$HEAD_SHA"')
          .replace('<path>', 'src/keep.ts')
      const headCommit = git(repo.root, 'rev-parse', 'HEAD')
      const vars = {
        CHECKOUT_PATH: repo.root,
        BASE_SHA: repo.base,
        HEAD_SHA: headCommit,
      }
      const committed = runShell(repo.root, fill(forms[0] as string), vars)
      expect(committed.status).toBe(0)
      expect(committed.stdout).toContain('+export const keep = 2')
      writeFile(repo.root, 'src/keep.ts', 'export const keep = 9\n')
      const dirty = runShell(repo.root, fill(forms[1] as string), vars)
      expect(dirty.status).toBe(0)
      expect(dirty.stdout).toContain('+export const keep = 9')
      expect(dirty.stdout).not.toContain('+export const keep = 2')
      const oldSource = runShell(
        repo.root,
        'git -C "$CHECKOUT_PATH" show "$BASE_SHA":src/gone.ts',
        vars,
      )
      expect(oldSource.stdout).toContain('export const gone = 1')
    } finally {
      repo.cleanup()
    }
  })

  const CE_PINS: readonly (readonly [string, RegExp])[] = [
    ['one path per call', /one path's diff per call/i],
    ['the filled-in command', /filled-in path diff command/i],
    [
      'the banned forms',
      /no path, `git diff --stat`, `git diff --name-only`, or several paths in one call/i,
    ],
    ['the manifest is the file list', /manifest as the complete file list/i],
  ]
  for (const [name, pattern] of CE_PINS) {
    test(`the CE agent bundle carries: ${name}`, () => {
      expect(CE_AGENTS).toMatch(pattern)
    })
  }

  test('the deployment agent bundle carries the same rule and command', () => {
    const deployment = normalize(
      STAGE_4.slice(
        STAGE_4.indexOf('**CE conditional agents** (deployment-verification'),
        STAGE_4.indexOf('**CE agent gate boundary.**'),
      ),
    )
    expect(deployment).toMatch(/one-path diff rule and command/i)
  })

  test('the parent pastes the scope rules verbatim and never summarizes them', () => {
    expect(SPAWNING).toMatch(/verbatim/i)
    expect(SPAWNING).toMatch(/never summarize or paraphrase/i)
    expect(SPAWNING).toMatch(/exact one-path diff command/i)
  })
})

describe('ce:review pinned scope: the head is re-resolved before the report', () => {
  test('the re-check runs before the first finalize call', () => {
    expect(STAGE_6).toMatch(/re-resolve the head/i)
    expect(STAGE_6).toMatch(/before `finalize`/i)
    const recheckAt = STAGE_6_RAW.indexOf('**Re-resolve the head.**')
    const finalizeAt = STAGE_6_RAW.indexOf('call `finalize` with')
    expect(recheckAt).toBeGreaterThanOrEqual(0)
    expect(finalizeAt).toBeGreaterThan(recheckAt)
  })

  test('a moved head makes the result stale with no clean verdict', () => {
    expect(STAGE_6).toMatch(/moved[^.]*(?:stale|is stale)/i)
    expect(STAGE_6).toMatch(/no clean verdict/i)
    expect(STAGE_6).toMatch(/Review stale\. Reason:/)
  })

  test('the fingerprint, not the line counts, detects a working tree that changed', () => {
    expect(PIN).toMatch(/`FINGERPRINT:`/)
    expect(PIN).toMatch(/content, binary, and mode changes/i)
    expect(STAGE_6).toMatch(/`FINGERPRINT:`/)
    expect(STAGE_6).toMatch(
      /working tree[^.]*edited during the review[^.]*stale[^.]*even when[^.]*line counts did not change/i,
    )
  })

  test('an unresolvable head or a failed re-check counts as moved', () => {
    expect(STAGE_6).toMatch(/unresolvable head[^.]*failed re-check[^.]*moved/i)
  })
})

/** The stale terminal path: the paragraph that opens with its label. */
const STALE_PATH = normalize(
  STAGE_6_RAW.slice(
    STAGE_6_RAW.indexOf('**A moved head is one terminal path.**'),
  ),
).split('**Plan assessment.**')[0] as string

describe('ce:review pinned scope: a stale run is one terminal path', () => {
  test('the terminal path exists and sits before synthesis in Stage 6', () => {
    expect(STALE_PATH.length).toBeGreaterThan(0)
    const pathAt = STAGE_6_RAW.indexOf('**A moved head is one terminal path.**')
    expect(pathAt).toBeGreaterThan(
      STAGE_6_RAW.indexOf('**Re-resolve the head.**'),
    )
    expect(pathAt).toBeLessThan(STAGE_6_RAW.indexOf('call `finalize` with'))
  })

  test('a stale run makes no finalize call and applies no fixes', () => {
    expect(STALE_PATH).toMatch(/does not call `finalize`/i)
    expect(STALE_PATH).toMatch(/applies no fixes/i)
    expect(STALE_PATH).toMatch(/spawns no fixer/i)
  })

  test('a stale run writes no artifact and creates no todos', () => {
    expect(STALE_PATH).toMatch(/writes no `review-summary\.json`/i)
    expect(STALE_PATH).toMatch(/creates no todo files/i)
  })

  test('a stale run renders no findings tables, queues or verdict', () => {
    expect(STALE_PATH).toMatch(/renders no findings tables/i)
    expect(STALE_PATH).toMatch(/no verdict/i)
    expect(STALE_PATH).not.toMatch(/observations about the pinned scope/i)
    expect(STAGE_6).not.toMatch(/observations about the pinned scope/i)
  })

  test('the output is the stale reason with both heads, the re-run request, and what was withheld', () => {
    expect(STALE_PATH).toMatch(
      /Review stale\. Reason: the head moved from <pinned head> to <current head> during the review, so no verdict is issued\. Re-run the review\./,
    )
    expect(STALE_PATH).toMatch(/Coverage[^.]*withheld/i)
  })

  test('the headless envelope is the stale line with no Artifact line, then Review complete', () => {
    expect(STALE_PATH).toMatch(
      /Code review stale \(headless mode\)\. Reason: the head moved from <pinned head> to <current head> during the review, so no verdict is issued\. Re-run the review\./,
    )
    expect(STALE_PATH).toMatch(/no `Artifact:` line/i)
    expect(STALE_PATH).toMatch(/ends? with "Review complete"/)
  })

  test('every later rule that would write, apply or override carries the stale exception', () => {
    const lines = SKILL.split('\n')
    const needles = [
      /write a run artifact/i,
      /review-summary\.json` unconditionally/i,
      /do not recompute or override it/i,
      /call `finalize` with `applied_fixes: \[\]` \(see \[Stage 6\]/i,
    ]
    for (const needle of needles) {
      const hits = lines.filter(
        (line) =>
          (line.startsWith('- ') || !line.startsWith('|')) &&
          needle.test(line.trim()),
      )
      expect(hits.length, needle.source).toBeGreaterThan(0)
      for (const line of hits) {
        expect(line, needle.source).toMatch(/stale/i)
      }
    }
    const finalizeLine = lines.find((line) =>
      line.startsWith('Call `finalize` with `applied_fixes: []` to synthesize'),
    )
    expect(finalizeLine).toBeUndefined()
    expect(STAGE_6).toMatch(
      /when the head has not moved, call `finalize` with `applied_fixes: \[\]`/i,
    )
  })

  test('the post-review flow is skipped for a stale run', () => {
    const flow = normalize(section(SKILL, '### Mode-Driven Post-Review Flow'))
    expect(flow).toMatch(
      /stale run[^.]*skips this whole flow[^.]*no fixer, no artifact, no todos/i,
    )
  })

  test('the mode table says a stale run writes no artifact in any mode', () => {
    const modes = normalize(section(SKILL, '## Mode Detection'))
    expect(modes).toMatch(/stale[^.]*writes no artifact in any mode/i)
  })
})

describe('ce:review pinned scope: the pinned surfaces agree', () => {
  test('the gates table names the pinned scope, not a supplied diff', () => {
    expect(GATES).not.toMatch(/supplied diff and files/i)
    expect(GATES).toMatch(/reads against the pinned scope/i)
  })

  test('the bounded-investigation phrases survive and the inline diff is gone', () => {
    for (const phrase of [
      /read each unresolved surrounding range or symbol once/i,
      /re-read only when a concrete ambiguity remains or the file changed/i,
      /stop and return a finding or verdict once the evidence is sufficient/i,
      /within this bounded pass[^.]*explicit blocker or residual risk/i,
    ]) {
      expect(REVIEWER, phrase.source).toMatch(phrase)
    }
    expect(REVIEWER).toMatch(
      /per-path diff of the pinned scope is the primary source of truth/i,
    )
    expect(REVIEWER).not.toMatch(/supplied diff is the primary source/i)
  })
})

interface ShellResult {
  status: number | null
  stdout: string
  stderr: string
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Review Test',
      '-c',
      'user.email=review@example.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

// Fixture shells get an explicit environment, not the parent's.
const SYSTEM_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'

function runShell(
  cwd: string,
  script: string,
  env: Record<string, string>,
): ShellResult {
  const result = spawnSync('/bin/bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: { PATH: SYSTEM_PATH, HOME: cwd, ...env },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function writeFile(root: string, relativePath: string, text: string): void {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
}

interface Pinned {
  checkout: string
  base: string
  head: string
  headCommit: string
  fingerprint: string
  status: string[]
  counts: string[]
  untracked: string[]
}

type Scalar = 'checkout' | 'base' | 'headCommit' | 'head' | 'fingerprint'
type Rows = 'status' | 'counts' | 'untracked'

// HEAD_COMMIT: precedes HEAD: so the longer prefix wins.
const SCALAR_PREFIXES: readonly (readonly [string, Scalar])[] = [
  ['CHECKOUT:', 'checkout'],
  ['BASE:', 'base'],
  ['HEAD_COMMIT:', 'headCommit'],
  ['HEAD:', 'head'],
  ['FINGERPRINT:', 'fingerprint'],
]
const ROW_MARKERS: Readonly<Record<string, Rows>> = {
  'STATUS:': 'status',
  'COUNTS:': 'counts',
  'UNTRACKED:': 'untracked',
}

function parsePinned(stdout: string): Pinned {
  const pinned: Pinned = {
    checkout: '',
    base: '',
    head: '',
    headCommit: '',
    fingerprint: '',
    status: [],
    counts: [],
    untracked: [],
  }
  let current: Rows | null = null
  for (const line of stdout.split('\n')) {
    const marker = ROW_MARKERS[line]
    const scalar = SCALAR_PREFIXES.find(([prefix]) => line.startsWith(prefix))
    if (marker) current = marker
    else if (scalar) pinned[scalar[1]] = line.slice(scalar[0].length)
    else if (line.length > 0 && current) pinned[current].push(line)
  }
  return pinned
}

function makeRepo(prefix = 'ce-review-pin-'): {
  root: string
  base: string
  cleanup: () => void
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  git(root, 'init', '-q', '-b', 'main')
  writeFile(root, 'src/keep.ts', 'export const keep = 1\n')
  writeFile(
    root,
    'src/policy.ts',
    'export const allow = false\nexport const tail = 1\n',
  )
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'assets/blob.bin'),
    Buffer.from([0, 1, 2, 3, 4, 5]),
  )
  writeFile(root, 'src/gone.ts', 'export const gone = 1\nexport const g2 = 2\n')
  writeFile(
    root,
    'src/old-name.ts',
    'export const moved = 1\nexport const m2 = 2\nexport const m3 = 3\n',
  )
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  const base = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-q', '-b', 'topic')
  fs.rmSync(path.join(root, 'src/gone.ts'))
  git(root, 'mv', 'src/old-name.ts', 'src/new-name.ts')
  writeFile(root, 'src/keep.ts', 'export const keep = 2\nexport const k2 = 3\n')
  writeFile(root, 'src/added.ts', 'export const added = 1\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'topic')
  return {
    root,
    base,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

const PIN_SCRIPT = firstFence(PIN_RAW)
const RECHECK_SCRIPT = firstFence(
  STAGE_6_RAW.slice(STAGE_6_RAW.indexOf('**Re-resolve the head.**')),
)

describe('ce:review pinned scope: the documented capture, run for real', () => {
  test('the skill documents a pin command and a re-check command', () => {
    expect(PIN_SCRIPT.length).toBeGreaterThan(0)
    expect(RECHECK_SCRIPT.length).toBeGreaterThan(0)
  })

  test('a clean checkout pins the head commit and a manifest with every status', () => {
    const repo = makeRepo()
    try {
      const run = runShell(repo.root, PIN_SCRIPT, { BASE: repo.base })
      expect(run.status).toBe(0)
      const pinned = parsePinned(run.stdout)
      expect(pinned.checkout).toBe(repo.root)
      expect(pinned.base).toBe(repo.base)
      expect(pinned.head).toBe(git(repo.root, 'rev-parse', 'HEAD'))
      expect(pinned.headCommit).toBe(pinned.head)
      const byStatus = new Map(
        pinned.status.map((row) => [row.split('\t')[0]?.[0], row]),
      )
      expect(byStatus.get('A')).toBe('A\tsrc/added.ts')
      expect(byStatus.get('M')).toBe('M\tsrc/keep.ts')
      expect(byStatus.get('D')).toBe('D\tsrc/gone.ts')
      expect(byStatus.get('R')).toMatch(
        /^R\d+\tsrc\/old-name\.ts\tsrc\/new-name\.ts$/,
      )
      expect(pinned.counts).toContain('1\t0\tsrc/added.ts')
      expect(pinned.counts).toContain('0\t2\tsrc/gone.ts')
      expect(pinned.counts.some((row) => row.includes('=>'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  test('a user config that turns rename detection off does not change the manifest', () => {
    const repo = makeRepo()
    try {
      const run = runShell(repo.root, PIN_SCRIPT, {
        BASE: repo.base,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'diff.renames',
        GIT_CONFIG_VALUE_0: 'false',
      })
      expect(run.status).toBe(0)
      const pinned = parsePinned(run.stdout)
      expect(pinned.status.some((row) => /^R\d+\t/.test(row))).toBe(true)
      expect(pinned.status.some((row) => row === 'D\tsrc/old-name.ts')).toBe(
        false,
      )
    } finally {
      repo.cleanup()
    }
  })

  test('a dirty checkout pins the head as the working tree and keeps the head commit', () => {
    const repo = makeRepo()
    try {
      writeFile(repo.root, 'src/keep.ts', 'export const keep = 9\n')
      writeFile(repo.root, 'src/untracked.ts', 'export const u = 1\n')
      const run = runShell(repo.root, PIN_SCRIPT, { BASE: repo.base })
      expect(run.status).toBe(0)
      const pinned = parsePinned(run.stdout)
      expect(pinned.head).toBe('working tree')
      expect(pinned.headCommit).toBe(git(repo.root, 'rev-parse', 'HEAD'))
      expect(pinned.untracked).toEqual(['src/untracked.ts'])
      expect(pinned.status.map((row) => row.split('\t')[1])).toContain(
        'src/keep.ts',
      )
    } finally {
      repo.cleanup()
    }
  })

  test('a per-path read matches the pinned head, and a deleted file reads from the base', () => {
    const repo = makeRepo()
    try {
      const committed = git(
        repo.root,
        'diff',
        '-U10',
        repo.base,
        'HEAD',
        '--',
        'src/keep.ts',
      )
      writeFile(repo.root, 'src/keep.ts', 'export const keep = 9\n')
      const workingTree = git(
        repo.root,
        'diff',
        '-U10',
        repo.base,
        '--',
        'src/keep.ts',
      )
      expect(committed).toContain('+export const keep = 2')
      expect(workingTree).toContain('+export const keep = 9')
      expect(workingTree).not.toContain('+export const keep = 2')
      expect(git(repo.root, 'show', `${repo.base}:src/gone.ts`)).toContain(
        'export const gone = 1',
      )
      expect(git(repo.root, 'show', `${repo.base}:src/old-name.ts`)).toContain(
        'export const moved = 1',
      )
    } finally {
      repo.cleanup()
    }
  })

  test('an unresolvable base stops before any manifest is printed', () => {
    const repo = makeRepo()
    try {
      const run = runShell(repo.root, PIN_SCRIPT, { BASE: 'no-such-ref' })
      expect(run.status).not.toBe(0)
      expect(run.stdout).toMatch(/^ERROR:/m)
      expect(run.stdout).not.toMatch(/^STATUS:/m)
    } finally {
      repo.cleanup()
    }
  })

  test('an unresolvable head stops before any manifest is printed', () => {
    const repo = makeRepo()
    try {
      // An orphan branch has no commit, so the base resolves and the head does not.
      git(repo.root, 'checkout', '-q', '--orphan', 'unborn')
      const run = runShell(repo.root, PIN_SCRIPT, { BASE: repo.base })
      expect(run.status).not.toBe(0)
      expect(run.stdout).toMatch(/^ERROR: head/m)
      expect(run.stdout).not.toMatch(/^STATUS:/m)
    } finally {
      repo.cleanup()
    }
  })

  function recheck(root: string, base: string): Pinned {
    const run = runShell(root, RECHECK_SCRIPT, { BASE_SHA: base })
    expect(run.status).toBe(0)
    return parsePinned(run.stdout)
  }

  function pin(repo: { root: string; base: string }): Pinned {
    const run = runShell(repo.root, PIN_SCRIPT, { BASE: repo.base })
    expect(run.status).toBe(0)
    return parsePinned(run.stdout)
  }

  /** The comparison the skill tells the parent to make. */
  function moved(pinned: Pinned, again: Pinned): boolean {
    return (
      pinned.head !== again.head ||
      pinned.headCommit !== again.headCommit ||
      pinned.fingerprint !== again.fingerprint
    )
  }

  function numstat(root: string, base: string): string {
    return git(root, 'diff', '--numstat', '-M', base)
  }

  test('the pin prints a fingerprint of the tracked review state', () => {
    const repo = makeRepo()
    try {
      expect(pin(repo).fingerprint).toMatch(/^[0-9a-f]{40,64}$/)
    } finally {
      repo.cleanup()
    }
  })

  test('an untouched checkout re-resolves to exactly the pinned state', () => {
    const repo = makeRepo()
    try {
      const pinned = pin(repo)
      expect(moved(pinned, recheck(repo.root, pinned.base))).toBe(false)
      writeFile(repo.root, 'src/keep.ts', 'export const keep = 9\n')
      const dirty = pin(repo)
      expect(moved(dirty, recheck(repo.root, dirty.base))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  test('a new commit moves the head', () => {
    const repo = makeRepo()
    try {
      const pinned = pin(repo)
      writeFile(repo.root, 'src/keep.ts', 'export const keep = 10\n')
      git(repo.root, 'commit', '-q', '-am', 'later')
      const again = recheck(repo.root, pinned.base)
      expect(again.headCommit).not.toBe(pinned.headCommit)
      expect(moved(pinned, again)).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  test('a working tree edit that changes the line counts is detected', () => {
    const repo = makeRepo()
    try {
      writeFile(repo.root, 'src/keep.ts', 'export const keep = 9\n')
      const pinned = pin(repo)
      expect(pinned.head).toBe('working tree')
      writeFile(
        repo.root,
        'src/keep.ts',
        'export const keep = 9\nexport const more = 1\nexport const extra = 2\n',
      )
      expect(moved(pinned, recheck(repo.root, pinned.base))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  test('a same-count edit to an already-edited line is detected', () => {
    const repo = makeRepo()
    try {
      writeFile(
        repo.root,
        'src/policy.ts',
        'export const allow = false // edited\nexport const tail = 1\n',
      )
      const pinned = pin(repo)
      const countsBefore = numstat(repo.root, pinned.base)
      writeFile(
        repo.root,
        'src/policy.ts',
        'export const allow = true // edited\nexport const tail = 1\n',
      )
      const again = recheck(repo.root, pinned.base)
      // HEAD, the dirty state and the line counts are all unchanged.
      expect(again.head).toBe(pinned.head)
      expect(again.headCommit).toBe(pinned.headCommit)
      expect(numstat(repo.root, pinned.base)).toBe(countsBefore)
      expect(moved(pinned, again)).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  test('replacing a binary file with other bytes of the same size is detected', () => {
    const repo = makeRepo()
    try {
      fs.writeFileSync(
        path.join(repo.root, 'assets/blob.bin'),
        Buffer.from([0, 9, 9, 9, 9, 9]),
      )
      const pinned = pin(repo)
      const countsBefore = numstat(repo.root, pinned.base)
      fs.writeFileSync(
        path.join(repo.root, 'assets/blob.bin'),
        Buffer.from([0, 7, 7, 7, 7, 7]),
      )
      const again = recheck(repo.root, pinned.base)
      expect(numstat(repo.root, pinned.base)).toBe(countsBefore)
      expect(again.head).toBe(pinned.head)
      expect(moved(pinned, again)).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  test('a mode change to a tracked file is detected', () => {
    const repo = makeRepo()
    try {
      writeFile(repo.root, 'src/keep.ts', 'export const keep = 9\n')
      const pinned = pin(repo)
      const countsBefore = numstat(repo.root, pinned.base)
      fs.chmodSync(path.join(repo.root, 'src/keep.ts'), 0o755)
      const again = recheck(repo.root, pinned.base)
      expect(numstat(repo.root, pinned.base)).toBe(countsBefore)
      expect(again.head).toBe(pinned.head)
      expect(moved(pinned, again)).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  test('a commit head that becomes dirty no longer re-resolves to the pinned head', () => {
    const repo = makeRepo()
    try {
      const pinned = pin(repo)
      writeFile(repo.root, 'src/keep.ts', 'export const keep = 11\n')
      const again = recheck(repo.root, pinned.base)
      expect(again.head).toBe('working tree')
      expect(moved(pinned, again)).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  test('an unmerged path is an unsupported manifest status and ends the pin before any manifest', () => {
    const repo = makeRepo()
    try {
      git(repo.root, 'checkout', '-q', '-b', 'other', repo.base)
      writeFile(repo.root, 'src/keep.ts', 'export const keep = 99\n')
      git(repo.root, 'commit', '-q', '-am', 'other')
      const merge = spawnSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          'merge',
          '--no-ff',
          '--no-edit',
          'topic',
        ],
        { cwd: repo.root, encoding: 'utf8' },
      )
      expect(merge.status).not.toBe(0)
      // The scenario is real: git itself reports the path as unmerged.
      expect(git(repo.root, 'ls-files', '--unmerged')).toContain('src/keep.ts')
      const run = runShell(repo.root, PIN_SCRIPT, { BASE: repo.base })
      expect(run.status).not.toBe(0)
      expect(run.stdout).toMatch(/^ERROR: manifest status unsupported/m)
      expect(run.stdout).not.toMatch(/^STATUS:/m)
      expect(run.stdout).not.toMatch(/^FINGERPRINT:/m)
    } finally {
      repo.cleanup()
    }
  })

  test('a manifest status outside A, M, D, R and T ends the pin before any manifest', () => {
    const repo = makeRepo()
    const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-shim-'))
    try {
      const realGit = SYSTEM_PATH.split(':')
        .map((dir) => path.join(dir, 'git'))
        .find((candidate) => fs.existsSync(candidate))
      expect(realGit).toBeDefined()
      // A shim stands in for git only where the manifest is listed.
      fs.writeFileSync(
        path.join(shim, 'git'),
        `#!/bin/bash\nif [ "$1" = diff ] && [[ " $* " == *" --name-status "* ]]; then printf 'X\\tsrc/x.ts\\n'; exit 0; fi\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 },
      )
      const run = runShell(repo.root, PIN_SCRIPT, {
        BASE: repo.base,
        PATH: `${shim}:${SYSTEM_PATH}`,
      })
      expect(run.status).not.toBe(0)
      expect(run.stdout).toMatch(/^ERROR: manifest status unsupported/m)
      expect(run.stdout).not.toMatch(/^STATUS:/m)
      // The same shim without the bad status pins normally, so the shim is not the cause.
      const ok = runShell(repo.root, PIN_SCRIPT, { BASE: repo.base })
      expect(ok.status).toBe(0)
    } finally {
      fs.rmSync(shim, { recursive: true, force: true })
      repo.cleanup()
    }
  })

  test('a re-check against an unresolvable base fails instead of printing a fingerprint', () => {
    const repo = makeRepo()
    try {
      const run = runShell(repo.root, RECHECK_SCRIPT, {
        BASE_SHA: 'no-such-ref',
      })
      expect(run.status).not.toBe(0)
      expect(run.stdout).toMatch(/^ERROR:/m)
      expect(run.stdout).not.toMatch(/^FINGERPRINT:/m)
    } finally {
      repo.cleanup()
    }
  })

  test('a re-check with an unresolvable head fails', () => {
    const repo = makeRepo()
    try {
      git(repo.root, 'checkout', '-q', '--orphan', 'unborn')
      const run = runShell(repo.root, RECHECK_SCRIPT, { BASE_SHA: repo.base })
      expect(run.status).not.toBe(0)
      expect(run.stdout).toMatch(/^ERROR: head/m)
      expect(run.stdout).not.toMatch(/^FINGERPRINT:/m)
    } finally {
      repo.cleanup()
    }
  })
})
