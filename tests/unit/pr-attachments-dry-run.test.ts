import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Offline dry run of the skill's own commands. The fenced blocks are read out
// of SKILL.md and run against a temp repository with a local bare remote, with
// the real helper and no `gh`, no network and no shared git config. The
// placeholders the model fills in are filled here with fixture values.

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const SKILL_DIR = path.join(ROOT_DIR, 'skills/pr-attachments')
const SKILL_PATH = path.join(SKILL_DIR, 'SKILL.md')
const HELPER_PATH = path.join(SKILL_DIR, 'scripts/pr-attachments.mjs')

// ── Process harness ────────────────────────────────────────────────────────

function withoutGitEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith('GIT_') && entry[1] !== undefined,
    ),
  )
}

const tempDirs: string[] = []

function makeDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pr-attachments-dry-')),
  )
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

// Fixture git runs with no inherited `GIT_*` variables and no global or system
// config. Identity and signing come from `-c`, so nothing is written anywhere.
function isolatedGit(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=test',
      '-c',
      'user.email=t@t.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    {
      cwd,
      env: {
        ...withoutGitEnv(),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    },
  )
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().replace(/\n$/, '')
}

interface ShellResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

// The skill's blocks call plain `git`, so identity and signing come from the
// config-environment variables rather than from a file.
function runShell(script: string, cwd: string, home: string): ShellResult {
  const result = Bun.spawnSync(['bash', '-c', script], {
    cwd,
    env: {
      ...withoutGitEnv(),
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'test',
      GIT_CONFIG_KEY_1: 'user.email',
      GIT_CONFIG_VALUE_1: 't@t.test',
      GIT_CONFIG_KEY_2: 'commit.gpgsign',
      GIT_CONFIG_VALUE_2: 'false',
      GIT_CONFIG_KEY_3: 'protocol.file.allow',
      GIT_CONFIG_VALUE_3: 'always',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

// ── Reading blocks out of SKILL.md ─────────────────────────────────────────

const skill = fs.existsSync(SKILL_PATH)
  ? fs.readFileSync(SKILL_PATH, 'utf8')
  : ''

function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let buffer: string[] | undefined
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('```')) {
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

/**
 * The one fenced block that holds `marker` and not `without`; anything else is
 * a contract break.
 */
function blockWith(marker: string, without?: string): string {
  const matches = fencedBlocks(skill).filter(
    (block) =>
      block.includes(marker) &&
      (without === undefined || !block.includes(without)),
  )
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one fenced block with ${JSON.stringify(marker)}, found ${matches.length}`,
    )
  }
  return matches[0] as string
}

interface Fill {
  /** Values for `NAME="<placeholder>"` lines. */
  readonly vars?: Record<string, string>
  /** Values for the `set -- ...` line. */
  readonly set?: readonly string[]
  /** Literal placeholder text to replace, such as the tokens inside JSON. */
  readonly tokens?: Record<string, string>
}

const ASSIGNMENT = /^(\s*)([A-Z_]+)="<[^"]*>"(;?)\s*$/

function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function fill(block: string, values: Fill): string {
  const lines = block.split('\n').map((line) => {
    if (line.trimStart().startsWith('#')) {
      return line
    }
    const assignment = ASSIGNMENT.exec(line)
    if (assignment !== null) {
      const [, indent, name, end] = assignment
      const value = values.vars?.[name as string]
      if (value === undefined) {
        throw new Error(`no value for ${name}`)
      }
      return `${indent}${name}=${quoted(value)}${end}`
    }
    if (line.startsWith('set -- ')) {
      if (values.set === undefined) {
        throw new Error('no value for the set -- line')
      }
      return `set -- ${values.set.map(quoted).join(' ')}`
    }
    return line
  })
  let script = lines.join('\n')
  for (const [token, value] of Object.entries(values.tokens ?? {})) {
    script = script.replaceAll(token, value)
  }
  return script
}

// ── Fixtures ───────────────────────────────────────────────────────────────

function pngWith(marker: string): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    return Buffer.concat([
      length,
      Buffer.from(type, 'latin1'),
      data,
      Buffer.alloc(4),
    ])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.alloc(13)),
    chunk('tEXt', Buffer.from(`marker\0${marker}`, 'latin1')),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

interface Pr {
  readonly root: string
  readonly work: string
  readonly origin: string
  readonly home: string
}

function commitFile(work: string, rel: string, content: string): string {
  fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true })
  fs.writeFileSync(path.join(work, rel), content)
  isolatedGit(work, ['add', '--', rel])
  isolatedGit(work, ['commit', '-q', '-m', `add ${rel}`, '--no-verify'])
  return isolatedGit(work, ['rev-parse', 'HEAD'])
}

/**
 * A working clone on `feat/x` (the PR head) pushed to a local bare remote,
 * with an unrelated file staged and one untracked screenshot in the root.
 */
function createPr(): Pr {
  const root = makeDir()
  const origin = path.join(root, 'origin.git')
  const work = path.join(root, 'work')
  isolatedGit(root, ['init', '-q', '--bare', '-b', 'main', origin])
  fs.mkdirSync(work)
  isolatedGit(work, ['init', '-q', '-b', 'main'])
  isolatedGit(work, ['remote', 'add', 'origin', origin])
  commitFile(work, 'README.md', 'base\n')
  isolatedGit(work, ['push', '-q', 'origin', 'main'])
  isolatedGit(work, ['checkout', '-q', '-b', 'feat/x'])
  commitFile(work, 'src/feature.txt', 'feature\n')
  isolatedGit(work, ['push', '-q', '-u', 'origin', 'feat/x'])
  fs.writeFileSync(path.join(work, 'notes.txt'), 'staged but unrelated\n')
  isolatedGit(work, ['add', '--', 'notes.txt'])
  fs.writeFileSync(path.join(work, 'shot.png'), pngWith('one'))
  return { root, work, origin, home: makeDir() }
}

interface HelperReport {
  readonly result: string
  readonly action?: string
  readonly urls?: ReadonlyArray<{ sha: string; path: string }>
}

function runHelper(
  pr: Pr,
  operation: string,
  input: unknown,
): { status: number | null; report: HelperReport } {
  const result = Bun.spawnSync(['node', HELPER_PATH, operation], {
    cwd: pr.work,
    stdin: Buffer.from(JSON.stringify(input)),
    env: {
      ...withoutGitEnv(),
      HOME: pr.home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
  return {
    status: result.exitCode,
    report: JSON.parse(result.stdout.toString()),
  }
}

/** Runs a block from SKILL.md, filled with fixture values. */
function runBlock(
  pr: Pr,
  marker: string,
  values: Fill,
  without?: string,
): ShellResult {
  return runShell(fill(blockWith(marker, without), values), pr.work, pr.home)
}

const DEST = 'docs/evidence/feat-x/shot.png'

/** The pushed evidence flow, up to and including the refspec push. */
function publishEvidence(pr: Pr): void {
  expect(runBlock(pr, 'git check-attr filter', { set: [DEST] }).stdout).toBe('')
  expect(
    runBlock(pr, 'cp -- "$SRC" "$DEST"', {
      vars: { SRC: 'shot.png', DEST },
    }).status,
  ).toBe(0)
  const commit = runBlock(pr, 'add screenshots for', {
    vars: { TOPIC: 'feat-x' },
    set: [DEST],
  })
  expect(commit.status, commit.stderr).toBe(0)
  expect(runBlock(pr, 'git diff-tree', { set: [DEST] }).status).toBe(0)
  const push = runBlock(pr, 'git push', {
    vars: { REMOTE: 'origin', BRANCH: 'feat/x' },
  })
  expect(push.status, push.stderr).toBe(0)
}

// ── Dry run ────────────────────────────────────────────────────────────────

describe('pr-attachments dry run -- the skill commands against a local bare remote', () => {
  test('classify through the pinned invocation accepts the screenshot', () => {
    const pr = createPr()
    const result = runBlock(pr, 'classify <<', {
      vars: { SKILL_DIR },
      tokens: { '<image path>': 'shot.png', '<current branch>': 'feat/x' },
    })
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.result).toBe('accepted')
    expect(report.entries[0].destination).toBe(DEST)
    expect(report.entries[0].status).toBe('new')
  })

  test('the pathspec commit holds only the evidence file and leaves other staged work alone', () => {
    const pr = createPr()
    publishEvidence(pr)
    expect(
      isolatedGit(pr.work, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        'HEAD',
      ]),
    ).toBe(DEST)
    expect(isolatedGit(pr.work, ['log', '-1', '--format=%s'])).toBe(
      'chore(evidence): add screenshots for feat-x',
    )
    expect(isolatedGit(pr.work, ['diff', '--cached', '--name-only'])).toBe(
      'notes.txt',
    )
  })

  test('the refspec push moves the head branch on the remote and nothing else', () => {
    const pr = createPr()
    const mainBefore = isolatedGit(pr.origin, ['rev-parse', 'refs/heads/main'])
    publishEvidence(pr)
    expect(isolatedGit(pr.origin, ['rev-parse', 'refs/heads/feat/x'])).toBe(
      isolatedGit(pr.work, ['rev-parse', 'HEAD']),
    )
    expect(isolatedGit(pr.origin, ['rev-parse', 'refs/heads/main'])).toBe(
      mainBefore,
    )
  })

  test('the file-set assertion fails when the commit holds a file outside the list', () => {
    const pr = createPr()
    fs.mkdirSync(path.join(pr.work, 'docs/evidence/feat-x'), {
      recursive: true,
    })
    fs.copyFileSync(path.join(pr.work, 'shot.png'), path.join(pr.work, DEST))
    isolatedGit(pr.work, ['add', '--', DEST, 'notes.txt'])
    isolatedGit(pr.work, ['commit', '-q', '-m', 'wrong commit', '--no-verify'])
    const assertion = runBlock(pr, 'git diff-tree', { set: [DEST] })
    expect(assertion.status).not.toBe(0)
  })

  test('the destination guards print nothing for a clean path and speak up for a bad one', () => {
    const pr = createPr()
    expect(runBlock(pr, 'git check-attr filter', { set: [DEST] }).stdout).toBe(
      '',
    )

    fs.writeFileSync(path.join(pr.work, '.gitignore'), 'docs/evidence/\n')
    expect(
      runBlock(pr, 'git check-attr filter', { set: [DEST] }).stdout,
    ).toContain(DEST)

    fs.writeFileSync(path.join(pr.work, '.gitignore'), '')
    fs.writeFileSync(
      path.join(pr.work, '.gitattributes'),
      'docs/evidence/** filter=lfs\n',
    )
    expect(
      runBlock(pr, 'git check-attr filter', { set: [DEST] }).stdout,
    ).toContain('lfs')

    fs.writeFileSync(path.join(pr.work, '.gitattributes'), '')
    fs.mkdirSync(path.join(pr.work, 'docs/evidence/feat-x'), {
      recursive: true,
    })
    fs.writeFileSync(path.join(pr.work, DEST), 'a file already here')
    expect(
      runBlock(pr, 'git check-attr filter', { set: [DEST] }).stdout,
    ).toContain(DEST)
  })

  test('a forced non-fast-forward rejection stops the run and leaves the remote unchanged', () => {
    const pr = createPr()
    // Someone else pushes to the PR head first.
    const other = path.join(pr.root, 'other')
    isolatedGit(pr.root, ['clone', '-q', pr.origin, other])
    isolatedGit(other, ['checkout', '-q', 'feat/x'])
    const theirs = commitFile(other, 'theirs.txt', 'someone else\n')
    isolatedGit(other, ['push', '-q', 'origin', 'feat/x'])
    expect(isolatedGit(pr.origin, ['rev-parse', 'refs/heads/feat/x'])).toBe(
      theirs,
    )

    // Our evidence commit is now on a diverged branch.
    expect(
      runBlock(pr, 'cp -- "$SRC" "$DEST"', { vars: { SRC: 'shot.png', DEST } })
        .status,
    ).toBe(0)
    expect(
      runBlock(pr, 'add screenshots for', {
        vars: { TOPIC: 'feat-x' },
        set: [DEST],
      }).status,
    ).toBe(0)
    const push = runBlock(pr, 'git push', {
      vars: { REMOTE: 'origin', BRANCH: 'feat/x' },
    })
    expect(push.status).not.toBe(0)
    expect(push.stderr).toMatch(/rejected|non-fast-forward/i)
    expect(isolatedGit(pr.origin, ['rev-parse', 'refs/heads/feat/x'])).toBe(
      theirs,
    )
  })

  test('the Demo text carries the pin git reports, and the helper splices and reads it back', () => {
    const pr = createPr()
    publishEvidence(pr)
    const head = isolatedGit(pr.work, ['rev-parse', 'HEAD'])
    const demoFile = path.join(pr.home, 'demo.md')
    fs.writeFileSync(demoFile, '')
    const demo = runBlock(pr, 'raw.githubusercontent.com', {
      vars: { DEMO_FILE: demoFile, OWNER_REPO: 'octo/widgets' },
      set: [DEST],
    })
    expect(demo.status, demo.stderr).toBe(0)
    expect(demo.stdout.trim()).toBe(head)
    const url = `https://raw.githubusercontent.com/octo/widgets/${head}/${DEST}`
    expect(fs.readFileSync(demoFile, 'utf8')).toBe(
      `## Demo\n\n![shot](${url})\n`,
    )

    const outFile = path.join(pr.home, 'body.md')
    const spliced = runHelper(pr, 'splice', {
      body: 'Intro\n',
      demo_file: demoFile,
      out_file: outFile,
    })
    expect(spliced.status).toBe(0)
    expect(spliced.report.result).toBe('spliced')
    expect(spliced.report.action).toBe('appended')
    expect(fs.readFileSync(outFile, 'utf8')).toBe(
      `Intro\n\n## Demo\n\n![shot](${url})\n`,
    )

    const listed = runBlock(pr, 'grep -Eo', {
      vars: { FILE: outFile, OWNER_REPO: 'octo/widgets' },
    })
    expect(listed.stdout.trim()).toBe(url)

    const urls = runHelper(pr, 'urls', {
      body: fs.readFileSync(outFile, 'utf8'),
      head_repo: 'octo/widgets',
    })
    expect(urls.report.result).toBe('urls')
    expect(urls.report.urls?.[0]).toMatchObject({ sha: head, path: DEST })
  })

  test('cleanup removes exactly the added evidence through the helper, then commits by pathspec and pushes', () => {
    const pr = createPr()
    publishEvidence(pr)
    const head = isolatedGit(pr.work, ['rev-parse', 'HEAD'])

    const fetched = runBlock(pr, '+refs/heads/$BASE_BRANCH', {
      vars: { BASE_REMOTE: 'origin', BASE_BRANCH: 'main' },
    })
    expect(fetched.status, fetched.stderr).toBe(0)

    const tokens = {
      '<headRefOid>': head,
      '<baseRefName>': 'main',
      '<base remote>': 'origin',
    }
    const listed = runBlock(
      pr,
      'cleanup-set <<',
      { vars: { SKILL_DIR }, tokens },
      'remove_digest',
    )
    const set = JSON.parse(listed.stdout)
    expect(set.result).toBe('set')
    expect(set.paths).toEqual([DEST])

    const removed = runBlock(pr, 'remove_digest', {
      vars: { SKILL_DIR },
      tokens: { ...tokens, '<digest>': set.digest },
    })
    expect(JSON.parse(removed.stdout).result).toBe('removed')

    const commit = runBlock(pr, 'remove screenshots for', {
      vars: { TOPIC: 'feat-x' },
      set: [DEST],
    })
    expect(commit.status, commit.stderr).toBe(0)
    expect(runBlock(pr, 'git diff-tree', { set: [DEST] }).status).toBe(0)
    const push = runBlock(pr, 'git push', {
      vars: { REMOTE: 'origin', BRANCH: 'feat/x' },
    })
    expect(push.status, push.stderr).toBe(0)
    expect(
      isolatedGit(pr.origin, [
        'ls-tree',
        '-r',
        '--name-only',
        'refs/heads/feat/x',
      ]),
    ).not.toContain('docs/evidence')
    expect(isolatedGit(pr.work, ['diff', '--cached', '--name-only'])).toBe(
      'notes.txt',
    )
  })
})
