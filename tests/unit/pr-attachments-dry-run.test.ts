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

/** The blob SHA classify reports for a source: the raw bytes, no filters. */
function classifiedBlob(pr: Pr, source = 'shot.png'): string {
  const classified = runHelper(pr, 'classify', {
    paths: [source],
    branch: 'feat/x',
  })
  expect(classified.report.result).toBe('accepted')
  return (classified.report as unknown as { entries: [{ blob_sha: string }] })
    .entries[0].blob_sha
}

function copyEvidence(pr: Pr, blobSha = classifiedBlob(pr)): ShellResult {
  return runBlock(pr, 'cp -- "$SRC" "$DEST"', {
    vars: { SRC: 'shot.png', DEST, BLOB_SHA: blobSha },
  })
}

const GUARD_MARKER = 'git check-attr text eol filter'
const STAGE_MARKER = 'git add -- "$@"'
const STAGED_CHECK_MARKER = 'blob-mismatch staged'
const COMMIT_MARKER = 'add screenshots for'
const COMMITTED_CHECK_MARKER = 'blob-mismatch committed'

/** What the staged and committed blob checks read: a destination and its classified blob. */
function blobItems(blob: string): readonly string[] {
  return [`${DEST} ${blob}`]
}

function stageEvidence(pr: Pr): ShellResult {
  return runBlock(pr, STAGE_MARKER, { set: [DEST] })
}

function checkStaged(pr: Pr, blob = classifiedBlob(pr)): ShellResult {
  return runBlock(pr, STAGED_CHECK_MARKER, { set: blobItems(blob) })
}

function commitStaged(pr: Pr): ShellResult {
  return runBlock(pr, COMMIT_MARKER, {
    vars: { TOPIC: 'feat-x' },
    set: [DEST],
  })
}

function checkCommitted(pr: Pr, blob = classifiedBlob(pr)): ShellResult {
  return runBlock(pr, COMMITTED_CHECK_MARKER, { set: blobItems(blob) })
}

/** Stage, then commit by pathspec, as Step 6 does when nothing goes wrong. */
function stageAndCommit(pr: Pr): ShellResult {
  const staged = stageEvidence(pr)
  expect(staged.status, staged.stderr).toBe(0)
  return commitStaged(pr)
}

const SELECT_MARKER = '"select"'

/**
 * Runs the pin selection block for one destination, with the blob classify
 * reports for the fixture screenshot unless another is given.
 */
function selectPins(
  pr: Pr,
  demoFile: string,
  form: 'raw' | 'blob',
  ownerRepo: string,
  blob = classifiedBlob(pr),
): ShellResult {
  return runBlock(pr, SELECT_MARKER, {
    vars: { SKILL_DIR },
    tokens: {
      ', {"path": "<destination 2>", "blob_sha": "<blob_sha 2>"}': '',
      '<destination 1>': DEST,
      '<blob_sha 1>': blob,
      '<owner/repo of the head repository>': ownerRepo,
      '<raw or blob>': form,
      '<demo file>': demoFile,
    },
  })
}

/** The pushed evidence flow, up to and including the refspec push. */
function publishEvidence(pr: Pr): void {
  expect(runBlock(pr, GUARD_MARKER, { set: [DEST] }).stdout).toBe('')
  expect(copyEvidence(pr).status).toBe(0)
  const staged = stageEvidence(pr)
  expect(staged.status, staged.stderr).toBe(0)
  const stagedCheck = checkStaged(pr)
  expect(stagedCheck.status, stagedCheck.stdout + stagedCheck.stderr).toBe(0)
  const commit = commitStaged(pr)
  expect(commit.status, commit.stderr).toBe(0)
  const committedCheck = checkCommitted(pr)
  expect(committedCheck.status, committedCheck.stdout).toBe(0)
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
    expect(runBlock(pr, GUARD_MARKER, { set: [DEST] }).stdout).toBe('')

    fs.writeFileSync(path.join(pr.work, '.gitignore'), 'docs/evidence/\n')
    expect(runBlock(pr, GUARD_MARKER, { set: [DEST] }).stdout).toContain(DEST)

    fs.writeFileSync(path.join(pr.work, '.gitignore'), '')
    fs.writeFileSync(
      path.join(pr.work, '.gitattributes'),
      'docs/evidence/** filter=lfs\n',
    )
    expect(runBlock(pr, GUARD_MARKER, { set: [DEST] }).stdout).toContain('lfs')

    fs.writeFileSync(path.join(pr.work, '.gitattributes'), '')
    fs.mkdirSync(path.join(pr.work, 'docs/evidence/feat-x'), {
      recursive: true,
    })
    fs.writeFileSync(path.join(pr.work, DEST), 'a file already here')
    expect(runBlock(pr, GUARD_MARKER, { set: [DEST] }).stdout).toContain(DEST)
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
    expect(copyEvidence(pr).status).toBe(0)
    expect(stageAndCommit(pr).status).toBe(0)
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
    const demo = selectPins(pr, demoFile, 'raw', 'octo/widgets')
    expect(demo.status, demo.stderr).toBe(0)
    expect(JSON.parse(demo.stdout)).toMatchObject({
      result: 'selected',
      evidence_sha: head,
    })
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

// ── Carry mode ─────────────────────────────────────────────────────────────

const SHA = 'a'.repeat(40)
const EMBED = `![shot](https://raw.githubusercontent.com/octo/widgets/${SHA}/${DEST})`
const OLD_DEMO = `## Demo\n\n${EMBED}\n`

interface CarryRun {
  readonly dir: string
  readonly oldFile: string
  readonly newFile: string
  readonly demoFile: string
  readonly home: string
}

/** The two body files and an empty demo file, in a directory with a space. */
function carryFiles(oldBody: string, newBody: string): CarryRun {
  const dir = path.join(makeDir(), 'my bodies')
  fs.mkdirSync(dir)
  const run = {
    dir,
    oldFile: path.join(dir, 'old body.md'),
    newFile: path.join(dir, 'new body.md'),
    demoFile: path.join(dir, 'demo.md'),
    home: makeDir(),
  }
  fs.writeFileSync(run.oldFile, oldBody)
  fs.writeFileSync(run.newFile, newBody)
  fs.writeFileSync(run.demoFile, '')
  return run
}

function runCarryBlock(
  run: CarryRun,
  marker: string,
  vars: Record<string, string>,
): ShellResult {
  return runShell(fill(blockWith(marker), { vars }), run.dir, run.home)
}

function carryExtract(run: CarryRun): ShellResult {
  return runCarryBlock(run, 'pr-attachments.mjs" extract', {
    SKILL_DIR,
    OLD_BODY: run.oldFile,
    DEMO_FILE: run.demoFile,
  })
}

function carrySplice(run: CarryRun): ShellResult {
  return runCarryBlock(run, 'demo_file: process.argv[2]', {
    SKILL_DIR,
    NEW_BODY: run.newFile,
    DEMO_FILE: run.demoFile,
  })
}

/** The body with its `## Demo` section cut out: the heading through the next H2. */
function outsideDemo(body: string): string {
  return body.replace(/^## Demo\n[\s\S]*?(?=^## |(?![\s\S]))/m, '')
}

describe('pr-attachments dry run -- carry mode over the real helper', () => {
  test('the temp-file block makes an empty 0600 file and prints its path', () => {
    const run = carryFiles('', '')
    const made = runShell(blockWith("printf 'demo %s"), run.dir, run.home)
    expect(made.status, made.stderr).toBe(0)
    const printed = made.stdout.trim().replace(/^demo /, '')
    expect(fs.statSync(printed).size).toBe(0)
    expect(fs.statSync(printed).mode & 0o777).toBe(0o600)
    fs.rmSync(printed)
  })

  test('copies the old Demo into a regenerated body and keeps every other byte of the new body', () => {
    const oldBody = `# T\n\nOld story.\n\n${OLD_DEMO}\n## Notes\n\nold notes\n`
    const newBody =
      '# T\n\nNew story with  odd   spacing.\r\n\n## Notes\n\nnew notes\n'
    const run = carryFiles(oldBody, newBody)

    const extracted = carryExtract(run)
    expect(extracted.status, extracted.stderr).toBe(0)
    expect(JSON.parse(extracted.stdout).result).toBe('extracted')
    expect(fs.readFileSync(run.demoFile, 'utf8')).toBe(OLD_DEMO)

    const spliced = carrySplice(run)
    expect(spliced.status, spliced.stderr).toBe(0)
    const report = JSON.parse(spliced.stdout)
    expect(report.result).toBe('spliced')
    expect(report.action).toBe('appended')

    const result = fs.readFileSync(run.newFile, 'utf8')
    expect(result.startsWith(newBody)).toBe(true)
    expect(result.slice(newBody.length)).toBe(`\n${OLD_DEMO}`)
  })

  test('replaces a stale Demo in the new body and leaves the bytes outside it identical', () => {
    const stale =
      '![stale](https://raw.githubusercontent.com/octo/widgets/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/docs/evidence/topic/stale.png)'
    const newBody = `# T\n\nNew story.\n\n## Demo\n\n${stale}\n\n## Notes\n\nnew notes\n`
    const run = carryFiles(`# T\n\n${OLD_DEMO}`, newBody)
    expect(carryExtract(run).status).toBe(0)
    const spliced = carrySplice(run)
    expect(spliced.status, spliced.stderr).toBe(0)
    expect(JSON.parse(spliced.stdout).action).toBe('replaced')

    const result = fs.readFileSync(run.newFile, 'utf8')
    expect(result).toContain(EMBED)
    expect(result).not.toContain(stale)
    expect(outsideDemo(result)).toBe(outsideDemo(newBody))
  })

  test('an old body with no Demo reports absent and the new file keeps its exact bytes', () => {
    const newBody = '# T\n\nNew story.\n\n## Notes\n\nnew notes\n'
    const run = carryFiles('# T\n\nOld story, no evidence.\n', newBody)
    const extracted = carryExtract(run)
    expect(extracted.status, extracted.stderr).toBe(0)
    expect(JSON.parse(extracted.stdout).result).toBe('absent')
    expect(fs.readFileSync(run.newFile, 'utf8')).toBe(newBody)
    expect(fs.readFileSync(run.demoFile, 'utf8')).toBe('')
  })

  test('two Demo sections in the old body stop at extract and write nothing', () => {
    const run = carryFiles(`${OLD_DEMO}\n## Demo\n\nsecond\n`, 'new\n')
    const extracted = carryExtract(run)
    expect(extracted.status).toBe(1)
    const report = JSON.parse(extracted.stdout)
    expect(report.result).toBe('needs-input')
    expect(report.asks[0].code).toBe('multiple-demo-sections')
    expect(fs.readFileSync(run.demoFile, 'utf8')).toBe('')
    expect(fs.readFileSync(run.newFile, 'utf8')).toBe('new\n')
  })

  test('an unterminated fence in the new body stops the splice and leaves the file as it was', () => {
    const newBody = '# T\n\n```\nopen fence\n'
    const run = carryFiles(`${OLD_DEMO}`, newBody)
    expect(carryExtract(run).status).toBe(0)
    const spliced = carrySplice(run)
    expect(spliced.status).toBe(1)
    const report = JSON.parse(spliced.stdout)
    expect(report.result).toBe('needs-input')
    expect(report.asks[0].code).toBe('unterminated-region')
    expect(fs.readFileSync(run.newFile, 'utf8')).toBe(newBody)
  })

  test('a --!> inside a comment of the old body stops at extract and copies nothing', () => {
    const oldBody = `<!-- archived\n--!>\n${OLD_DEMO}## Notes\n-->\n`
    const run = carryFiles(oldBody, 'new\n')

    const extracted = carryExtract(run)

    expect(extracted.status).toBe(1)
    const report = JSON.parse(extracted.stdout)
    expect(report.result).toBe('needs-input')
    expect(report.asks).toEqual([
      { code: 'unterminated-region', kind: 'comment' },
    ])
    expect(fs.readFileSync(run.demoFile, 'utf8')).toBe('')
    expect(fs.readFileSync(run.newFile, 'utf8')).toBe('new\n')
  })

  test('a --!> inside a comment of the new body stops the splice and leaves the file as it was', () => {
    const newBody = '# T\n\n<!-- x --!> y -->\n\n## Demo\n'
    const run = carryFiles(OLD_DEMO, newBody)
    expect(carryExtract(run).status).toBe(0)

    const spliced = carrySplice(run)

    expect(spliced.status).toBe(1)
    const report = JSON.parse(spliced.stdout)
    expect(report.result).toBe('needs-input')
    expect(report.asks).toEqual([
      { code: 'unterminated-region', kind: 'comment' },
    ])
    expect(fs.readFileSync(run.newFile, 'utf8')).toBe(newBody)
  })

  test('an unreadable old body is a usage error from the helper, not a hand-written result', () => {
    const run = carryFiles('', 'new\n')
    fs.rmSync(run.oldFile)
    const extracted = carryExtract(run)
    expect(extracted.status).toBe(2)
    expect(JSON.parse(extracted.stdout).result).toBe('usage-error')
  })

  test('the removal block deletes the demo file', () => {
    const run = carryFiles('', '')
    const removed = runCarryBlock(run, 'rm -f "$DEMO_FILE"', {
      DEMO_FILE: run.demoFile,
    })
    expect(removed.status, removed.stderr).toBe(0)
    expect(fs.existsSync(run.demoFile)).toBe(false)
  })
})

// ── Private repositories: the blob form ────────────────────────────────────
//
// The `gh api` check cannot reach GitHub offline. A stand-in `gh` answers the
// one call the block makes from the local repository, so the block's own
// shell (parsing, retries, exit code) is what runs.

const BLOB_LIST_MARKER = 'grep -o -E'
const BLOB_CHECK_MARKER = 'contents/$DEST?ref=$PIN'
const NO_WAIT = { 'sleep 5': 'sleep 0' }

/** A `gh` that answers `gh api repos/<o>/<r>/contents/<path>?ref=<sha> --jq .sha` from git. */
function installFakeGh(pr: Pr, failFirst = 0): string {
  const bin = path.join(makeDir(), 'bin')
  fs.mkdirSync(bin)
  const counter = path.join(pr.home, 'gh-calls')
  fs.writeFileSync(counter, '0')
  fs.writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/bin/sh',
      '[ "$1" = api ] || exit 2',
      '[ "$3" = --jq ] && [ "$4" = .sha ] || exit 2',
      `COUNT="$(( $(cat "${counter}") + 1 ))"; echo "$COUNT" > "${counter}"`,
      `[ "$COUNT" -le ${failFirst} ] && { echo "gh: simulated outage (HTTP 503)" >&2; echo "second stderr line" >&2; exit 1; }`,
      `REST="\${2#repos/*/*/contents/}"`,
      `git rev-parse "\${REST##*\\?ref=}:\${REST%%\\?ref=*}"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return bin
}

function runWithGh(pr: Pr, bin: string, script: string): ShellResult {
  return runShell(`PATH="${bin}:$PATH"\n${script}`, pr.work, pr.home)
}

const OWNER_REPO = 'octo/widgets'

function blobUrl(sha: string): string {
  return `https://github.com/${OWNER_REPO}/blob/${sha}/${DEST}?raw=true`
}

/** Publishes the evidence, then builds the blob-form Demo file with the skill's block. */
function privateDemo(pr: Pr): { head: string; demoFile: string } {
  publishEvidence(pr)
  const head = isolatedGit(pr.work, ['rev-parse', 'HEAD'])
  const demoFile = path.join(pr.home, 'demo.md')
  fs.writeFileSync(demoFile, '')
  const built = selectPins(pr, demoFile, 'blob', OWNER_REPO)
  expect(built.status, built.stderr).toBe(0)
  expect(JSON.parse(built.stdout).evidence_sha).toBe(head)
  return { head, demoFile }
}

function checkBlobs(
  pr: Pr,
  bin: string,
  items: readonly string[],
): ShellResult {
  const script = fill(blockWith(BLOB_CHECK_MARKER), {
    vars: { OWNER_REPO },
    set: items,
    tokens: NO_WAIT,
  })
  return runWithGh(pr, bin, script)
}

describe('pr-attachments dry run -- private repositories over the real helper', () => {
  test('the Demo text carries the pin git reports in the blob form, and the helper reads it back as blob', () => {
    const pr = createPr()
    const { head, demoFile } = privateDemo(pr)
    expect(fs.readFileSync(demoFile, 'utf8')).toBe(
      `## Demo\n\n![shot](${blobUrl(head)})\n`,
    )

    const listed = runBlock(pr, BLOB_LIST_MARKER, {
      vars: { FILE: demoFile, OWNER_REPO },
    })
    expect(listed.stdout.trim()).toBe(blobUrl(head))

    const urls = runHelper(pr, 'urls', {
      body: fs.readFileSync(demoFile, 'utf8'),
      head_repo: OWNER_REPO,
    })
    expect(urls.report.urls?.[0]).toMatchObject({
      sha: head,
      path: DEST,
      form: 'blob',
    })
  })

  test('the gh check passes when GitHub reports the blob SHA that classify reported', () => {
    const pr = createPr()
    const { head } = privateDemo(pr)
    const blob = isolatedGit(pr.work, ['rev-parse', `${head}:${DEST}`])
    const result = checkBlobs(pr, installFakeGh(pr), [
      `${blobUrl(head)} ${blob}`,
    ])
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  test('the gh check reads the expected blob from git when re-pin mode passes local', () => {
    const pr = createPr()
    const { head } = privateDemo(pr)
    const result = checkBlobs(pr, installFakeGh(pr), [`${blobUrl(head)} local`])
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  test('the gh check fails when the blob SHA differs from the classified one', () => {
    const pr = createPr()
    const { head } = privateDemo(pr)
    const result = checkBlobs(pr, installFakeGh(pr), [
      `${blobUrl(head)} ${'0'.repeat(40)}`,
    ])
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain(`mismatch ${DEST}`)
  })

  test('the gh check fails when the file is absent at the pinned commit', () => {
    const pr = createPr()
    const { head } = privateDemo(pr)
    const blob = isolatedGit(pr.work, ['rev-parse', `${head}:${DEST}`])
    const absent = `https://github.com/${OWNER_REPO}/blob/${head}/docs/evidence/feat-x/gone.png?raw=true`
    const result = checkBlobs(pr, installFakeGh(pr), [`${absent} ${blob}`])
    expect(result.status).not.toBe(0)
    // GitHub answers 404 for a missing file, which is an API error and not a
    // content mismatch.
    expect(result.stdout).toContain('api-error docs/evidence/feat-x/gone.png')
    expect(result.stdout).not.toContain('mismatch')
  })

  test('the gh check rejects an expected value that is not a git blob SHA', () => {
    const pr = createPr()
    const { head } = privateDemo(pr)
    const result = checkBlobs(pr, installFakeGh(pr), [`${blobUrl(head)} nope`])
    expect(result.status).not.toBe(0)
  })

  test('the gh check retries for propagation and passes once GitHub catches up', () => {
    const pr = createPr()
    const { head } = privateDemo(pr)
    const blob = isolatedGit(pr.work, ['rev-parse', `${head}:${DEST}`])
    const result = checkBlobs(pr, installFakeGh(pr, 3), [
      `${blobUrl(head)} ${blob}`,
    ])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(fs.readFileSync(path.join(pr.home, 'gh-calls'), 'utf8').trim()).toBe(
      '4',
    )
  })

  test('an API failure is reported as an api-error with the first stderr line, not as a mismatch', () => {
    const pr = createPr()
    const { head } = privateDemo(pr)
    const blob = isolatedGit(pr.work, ['rev-parse', `${head}:${DEST}`])
    const result = checkBlobs(pr, installFakeGh(pr, 99), [
      `${blobUrl(head)} ${blob}`,
    ])

    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain(
      `api-error ${DEST} gh: simulated outage (HTTP 503)`,
    )
    expect(result.stdout).not.toContain('second stderr line')
    expect(result.stdout).not.toContain('mismatch')
  })

  test('a SHA that differs after a successful call is still a mismatch, not an api-error', () => {
    const pr = createPr()
    const { head } = privateDemo(pr)
    const result = checkBlobs(pr, installFakeGh(pr), [
      `${blobUrl(head)} ${'0'.repeat(40)}`,
    ])

    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain(`mismatch ${DEST}`)
    expect(result.stdout).not.toContain('api-error')
  })

  test('the temp file that holds stderr is removed', () => {
    const pr = createPr()
    const { head } = privateDemo(pr)
    const blob = isolatedGit(pr.work, ['rev-parse', `${head}:${DEST}`])
    const tmp = makeDir()
    const result = runWithGh(
      pr,
      installFakeGh(pr, 99),
      `export TMPDIR="${tmp}"\n${fill(blockWith(BLOB_CHECK_MARKER), {
        vars: { OWNER_REPO },
        set: [`${blobUrl(head)} ${blob}`],
        tokens: NO_WAIT,
      })}`,
    )

    expect(result.status).not.toBe(0)
    expect(fs.readdirSync(tmp)).toEqual([])
  })

  test('the gh check is bounded at four attempts per file', () => {
    const pr = createPr()
    const { head } = privateDemo(pr)
    const blob = isolatedGit(pr.work, ['rev-parse', `${head}:${DEST}`])
    const result = checkBlobs(pr, installFakeGh(pr, 99), [
      `${blobUrl(head)} ${blob}`,
    ])
    expect(result.status).not.toBe(0)
    expect(fs.readFileSync(path.join(pr.home, 'gh-calls'), 'utf8').trim()).toBe(
      '4',
    )
  })

  test('re-pin mode rewrites a stale blob-form pin through the helper: urls, pins, repin-rewrite', () => {
    const pr = createPr()
    const { head } = privateDemo(pr)
    const stale = 'a'.repeat(40)
    const body = `Intro\n\n## Demo\n\n![shot](${blobUrl(stale)})\n`

    const urls = runHelper(pr, 'urls', { body, head_repo: OWNER_REPO })
    expect(urls.report.urls?.[0]).toMatchObject({ form: 'blob', sha: stale })

    const pins = runHelper(pr, 'pins', {
      head_ref_oid: head,
      urls: urls.report.urls,
    })
    expect(pins.report).toMatchObject({
      result: 'repin-needed',
      pins: { [DEST]: head },
    })

    const outFile = path.join(pr.home, 'repinned.md')
    const rewritten = runHelper(pr, 'repin-rewrite', {
      body,
      head_repo: OWNER_REPO,
      pins: { [DEST]: head },
      out_file: outFile,
    })
    expect(rewritten.report.result).toBe('repinned')
    expect(fs.readFileSync(outFile, 'utf8')).toBe(
      `Intro\n\n## Demo\n\n![shot](${blobUrl(head)})\n`,
    )
  })
})

// ── The source file between classify and the copy ──────────────────────────

describe('pr-attachments dry run -- the source must still be the file classify saw', () => {
  test('a source that changed after classify stops the copy and copies nothing', () => {
    const pr = createPr()
    const classified = classifiedBlob(pr)
    fs.writeFileSync(path.join(pr.work, 'shot.png'), pngWith('swapped'))

    const copied = copyEvidence(pr, classified)

    expect(copied.status).not.toBe(0)
    expect(copied.stdout + copied.stderr).toContain('source-changed')
    expect(fs.existsSync(path.join(pr.work, DEST))).toBe(false)
  })

  test('an unchanged source is copied byte for byte', () => {
    const pr = createPr()
    const copied = copyEvidence(pr)

    expect(copied.status, copied.stderr).toBe(0)
    expect(fs.readFileSync(path.join(pr.work, DEST))).toEqual(
      fs.readFileSync(path.join(pr.work, 'shot.png')),
    )
  })

  test('the comparison reads raw bytes, as the helper does, even where a text filter applies', () => {
    const pr = createPr()
    fs.writeFileSync(
      path.join(pr.work, '.gitattributes'),
      '*.png text eol=crlf\n',
    )
    const classified = classifiedBlob(pr)
    const withFilters = isolatedGit(pr.work, ['hash-object', '--', 'shot.png'])
    // The fixture really is one the filters would change.
    expect(withFilters).not.toBe(classified)

    const copied = copyEvidence(pr, classified)

    expect(copied.status, copied.stdout + copied.stderr).toBe(0)
  })
})

// ── A failed commit leaves nothing staged ──────────────────────────────────

function failingHook(pr: Pr): void {
  const hooks = path.join(pr.work, '.git/hooks')
  fs.mkdirSync(hooks, { recursive: true })
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', {
    mode: 0o755,
  })
}

describe('pr-attachments dry run -- a failed commit is unstaged again', () => {
  test('a hook that rejects the evidence commit leaves the paths staged, and the recovery block clears them', () => {
    const pr = createPr()
    expect(copyEvidence(pr).status).toBe(0)
    failingHook(pr)

    const commit = stageAndCommit(pr)
    expect(commit.status).not.toBe(0)
    expect(
      isolatedGit(pr.work, ['diff', '--cached', '--name-only']).split('\n'),
    ).toContain(DEST)

    const recovery = runBlock(pr, 'git restore --staged', { set: [DEST] })

    expect(recovery.status, recovery.stderr).toBe(0)
    expect(
      isolatedGit(pr.work, ['diff', '--cached', '--name-only', '--', DEST]),
    ).toBe('')
    // Other staged work is untouched, and the copied file stays on disk.
    expect(isolatedGit(pr.work, ['diff', '--cached', '--name-only'])).toBe(
      'notes.txt',
    )
    expect(fs.existsSync(path.join(pr.work, DEST))).toBe(true)
  })

  test('a hook that rejects the cleanup commit leaves the removals staged, and the same block clears them', () => {
    const pr = createPr()
    publishEvidence(pr)
    isolatedGit(pr.work, ['rm', '-q', '--', DEST])
    failingHook(pr)

    const commit = runBlock(pr, 'remove screenshots for', {
      vars: { TOPIC: 'feat-x' },
      set: [DEST],
    })
    expect(commit.status).not.toBe(0)
    expect(
      isolatedGit(pr.work, ['diff', '--cached', '--name-only']).split('\n'),
    ).toContain(DEST)

    const recovery = runBlock(pr, 'git restore --staged', { set: [DEST] })

    expect(recovery.status, recovery.stderr).toBe(0)
    expect(
      isolatedGit(pr.work, ['diff', '--cached', '--name-only', '--', DEST]),
    ).toBe('')
    expect(isolatedGit(pr.work, ['diff', '--cached', '--name-only'])).toBe(
      'notes.txt',
    )
  })
})

// ── What the remote holds after a push ─────────────────────────────────────

describe('pr-attachments dry run -- the push, and what the remote holds afterwards', () => {
  const PUSH_MARKER = 'git push'
  const CHECK_MARKER = 'git ls-remote'

  test('the push runs with prompts off and still lands on the remote', () => {
    // A credential helper that asked for input would hang the run.
    expect(blockWith(PUSH_MARKER)).toContain('GIT_TERMINAL_PROMPT=0')
    const pr = createPr()
    publishEvidence(pr)
    const check = runBlock(pr, CHECK_MARKER, {
      vars: { REMOTE: 'origin', BRANCH: 'feat/x' },
    })

    expect(check.status, check.stderr).toBe(0)
    expect(check.stdout.trim()).toBe('landed')
  })

  test('a rejected push leaves the evidence commit local, and the check says so', () => {
    const pr = createPr()
    const other = path.join(pr.root, 'other')
    isolatedGit(pr.root, ['clone', '-q', pr.origin, other])
    isolatedGit(other, ['checkout', '-q', 'feat/x'])
    commitFile(other, 'theirs.txt', 'someone else\n')
    isolatedGit(other, ['push', '-q', 'origin', 'feat/x'])
    expect(copyEvidence(pr).status).toBe(0)
    expect(stageAndCommit(pr).status).toBe(0)
    const push = runBlock(pr, PUSH_MARKER, {
      vars: { REMOTE: 'origin', BRANCH: 'feat/x' },
    })
    expect(push.status).not.toBe(0)

    const check = runBlock(pr, CHECK_MARKER, {
      vars: { REMOTE: 'origin', BRANCH: 'feat/x' },
    })

    expect(check.stdout.trim()).toBe('local')
  })

  test('a branch the remote does not have counts as local', () => {
    const pr = createPr()
    const check = runBlock(pr, CHECK_MARKER, {
      vars: { REMOTE: 'origin', BRANCH: 'feat/never-pushed' },
    })

    expect(check.stdout.trim()).toBe('local')
  })

  test('a remote that cannot be reached is reported as unchecked, not as landed', () => {
    const pr = createPr()
    const check = runBlock(pr, CHECK_MARKER, {
      vars: {
        REMOTE: path.join(pr.root, 'no-such-remote.git'),
        BRANCH: 'feat/x',
      },
    })

    expect(check.stdout.trim()).toBe('unchecked')
  })
})

// ── The write guard, end to end, with a stand-in gh ────────────────────────
//
// The stand-in keeps one PR body in a file. It answers `gh pr view N --json
// body [--jq EXPR]` and `gh pr edit N --body-file F`, and logs every edit.
// EXPR is the object or `.body` selector the skill sends; the stand-in
// evaluates it with `.body` bound to the stored text.

interface FakePr {
  readonly bin: string
  readonly store: string
  readonly log: string
}

function installFakePr(pr: Pr, body: string): FakePr {
  const bin = path.join(makeDir(), 'bin')
  fs.mkdirSync(bin)
  const store = path.join(pr.home, 'pr-body.txt')
  const log = path.join(pr.home, 'gh-edits.log')
  fs.writeFileSync(store, body)
  fs.writeFileSync(log, '')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const store = ${JSON.stringify(store)}
const log = ${JSON.stringify(log)}
if (args[0] === 'pr' && args[1] === 'view') {
  const body = fs.readFileSync(store, 'utf8')
  const at = args.indexOf('--jq')
  if (at === -1) {
    process.stdout.write(JSON.stringify({ body }))
  } else {
    const expr = args[at + 1].replaceAll('.body', '__body')
    const value = new Function('__body', 'return (' + expr + ')')(body)
    process.stdout.write(typeof value === 'string' ? value + '\\n' : JSON.stringify(value))
  }
} else if (args[0] === 'pr' && args[1] === 'edit') {
  const file = args[args.indexOf('--body-file') + 1]
  fs.appendFileSync(log, 'edit ' + args[2] + ' ' + file + '\\n')
  fs.copyFileSync(file, store)
} else {
  process.exit(2)
}
`
  fs.writeFileSync(path.join(bin, 'gh'), script, { mode: 0o755 })
  return { bin, store, log }
}

function edits(fake: FakePr): string[] {
  return fs.readFileSync(fake.log, 'utf8').split('\n').filter(Boolean)
}

const STALE = 'a'.repeat(40)
const staleEmbed = `![shot](https://raw.githubusercontent.com/octo/widgets/${STALE}/${DEST})`

describe('pr-attachments dry run -- the write guard writes when nothing changed (stand-in gh)', () => {
  function jsonList(items: unknown): string {
    return JSON.stringify(items).slice(1, -1)
  }

  test('re-pin mode reads, rewrites, passes the guard and writes the new body', () => {
    const pr = createPr()
    publishEvidence(pr)
    const head = isolatedGit(pr.work, ['rev-parse', 'HEAD'])
    const original = `Intro\n\n## Demo\n\n${staleEmbed}\n`
    const fake = installFakePr(pr, original)
    const backup = path.join(pr.home, 'backup.json')
    const newBody = path.join(pr.home, 'new-body.md')
    const run = (marker: string, values: Fill, without?: string) =>
      runWithGh(pr, fake.bin, fill(blockWith(marker, without), values))

    const listed = run('" urls <', {
      vars: { SKILL_DIR, PR: '7', BACKUP: backup },
      tokens: { '<owner/repo>': 'octo/widgets' },
    })
    expect(listed.status, listed.stderr).toBe(0)
    const urls = JSON.parse(listed.stdout).urls

    const picked = run(
      'scripts/pr-attachments.mjs" pins',
      {
        vars: { SKILL_DIR },
        tokens: {
          '<headRefOid>': head,
          '<the urls array from the previous report>': jsonList(urls),
        },
      },
      SELECT_MARKER,
    )
    const pins = JSON.parse(picked.stdout).pins
    expect(pins).toEqual({ [DEST]: head })

    const rewritten = run('repin-rewrite', {
      vars: { SKILL_DIR, PR: '7', BACKUP: backup },
      tokens: {
        '<owner/repo>': 'octo/widgets',
        '<the pins map from the previous report>': `"${DEST}": "${head}"`,
        '<new body file>': newBody,
      },
    })
    expect(rewritten.status, rewritten.stdout + rewritten.stderr).toBe(0)
    expect(JSON.parse(rewritten.stdout).result).toBe('repinned')

    const guarded = run('RECHECK=', {
      vars: { PR: '7', BACKUP: backup, NEW_BODY: newBody },
    })

    expect(guarded.status, guarded.stdout + guarded.stderr).toBe(0)
    expect(edits(fake)).toEqual([`edit 7 ${newBody}`])
    expect(fs.readFileSync(fake.store, 'utf8')).toBe(
      fs.readFileSync(newBody, 'utf8'),
    )
    expect(fs.readFileSync(fake.store, 'utf8')).toContain(
      `/octo/widgets/${head}/${DEST}`,
    )
  })

  test('PR mode splices, passes the guard and writes the new body', () => {
    const pr = createPr()
    const fake = installFakePr(pr, 'Intro\n')
    const backup = path.join(pr.home, 'backup.json')
    const newBody = path.join(pr.home, 'new-body.md')
    const demoFile = path.join(pr.home, 'demo.md')
    fs.writeFileSync(demoFile, `## Demo\n\n${staleEmbed}\n`)

    const spliced = runWithGh(
      pr,
      fake.bin,
      fill(blockWith('splice < "$BACKUP"'), {
        vars: { SKILL_DIR, PR: '7', BACKUP: backup },
        tokens: { '<demo file>': demoFile, '<new body file>': newBody },
      }),
    )
    expect(spliced.status, spliced.stdout + spliced.stderr).toBe(0)

    const guarded = runWithGh(
      pr,
      fake.bin,
      fill(blockWith('RECHECK='), {
        vars: { PR: '7', BACKUP: backup, NEW_BODY: newBody },
        // Filled when the block asks for them, as a model would in PR mode.
        tokens: { '<demo file>': demoFile, '<new body file>': newBody },
      }),
    )

    expect(guarded.status, guarded.stdout + guarded.stderr).toBe(0)
    expect(edits(fake)).toEqual([`edit 7 ${newBody}`])
    expect(fs.readFileSync(fake.store, 'utf8')).toBe(
      `Intro\n\n## Demo\n\n${staleEmbed}\n`,
    )
  })

  test('a description edited since the backup is not overwritten', () => {
    const pr = createPr()
    const fake = installFakePr(pr, 'Intro\n')
    const backup = path.join(pr.home, 'backup.json')
    const newBody = path.join(pr.home, 'new-body.md')
    const demoFile = path.join(pr.home, 'demo.md')
    fs.writeFileSync(demoFile, `## Demo\n\n${staleEmbed}\n`)
    const spliced = runWithGh(
      pr,
      fake.bin,
      fill(blockWith('splice < "$BACKUP"'), {
        vars: { SKILL_DIR, PR: '7', BACKUP: backup },
        tokens: { '<demo file>': demoFile, '<new body file>': newBody },
      }),
    )
    expect(spliced.status, spliced.stdout + spliced.stderr).toBe(0)
    fs.writeFileSync(fake.store, 'Intro, edited by someone else\n')

    const guarded = runWithGh(
      pr,
      fake.bin,
      fill(blockWith('RECHECK='), {
        vars: { PR: '7', BACKUP: backup, NEW_BODY: newBody },
        // Filled when the block asks for them, as a model would in PR mode.
        tokens: { '<demo file>': demoFile, '<new body file>': newBody },
      }),
    )

    expect(guarded.status).not.toBe(0)
    expect(edits(fake)).toEqual([])
    expect(fs.readFileSync(fake.store, 'utf8')).toBe(
      'Intro, edited by someone else\n',
    )
  })

  test('the read-back block passes once the body on the PR equals the body file', () => {
    const pr = createPr()
    const fake = installFakePr(pr, 'Intro\n')
    const newBody = path.join(pr.home, 'new-body.md')
    fs.writeFileSync(newBody, 'Intro\n\nMore')
    fs.writeFileSync(fake.store, 'Intro\n\nMore')

    const reread = runWithGh(
      pr,
      fake.bin,
      fill(blockWith('POST='), { vars: { PR: '7', NEW_BODY: newBody } }),
    )

    expect(reread.status, reread.stdout + reread.stderr).toBe(0)
  })
})

// ── Pins after a merge resolution ──────────────────────────────────────────

describe('pr-attachments dry run -- the pin comes from the helper, whatever the history looks like', () => {
  /** A PR head whose evidence image was resolved by a merge to bytes neither parent held. */
  function mergeResolved(pr: Pr): { merge: string; parent: string } {
    commitFile(pr.work, DEST, 'first')
    isolatedGit(pr.work, ['checkout', '-q', '-b', 'side'])
    commitFile(pr.work, DEST, 'side')
    isolatedGit(pr.work, ['checkout', '-q', 'feat/x'])
    const parent = commitFile(pr.work, DEST, 'feat')
    isolatedGit(pr.work, [
      'merge',
      '-q',
      '-s',
      'ours',
      '--no-commit',
      '--no-ff',
      'side',
    ])
    fs.writeFileSync(path.join(pr.work, DEST), pngWith('resolved'))
    isolatedGit(pr.work, ['add', '--', DEST])
    isolatedGit(pr.work, ['commit', '-q', '-m', 'merge side', '--no-verify'])
    return { merge: isolatedGit(pr.work, ['rev-parse', 'HEAD']), parent }
  }

  test('a merge that resolved the image is the pin, not the parent a plain git log finds', () => {
    const pr = createPr()
    const { merge, parent } = mergeResolved(pr)
    const resolved = isolatedGit(pr.work, ['rev-parse', `HEAD:${DEST}`])
    const plain = isolatedGit(pr.work, [
      'log',
      '-n',
      '1',
      '--no-renames',
      '--diff-filter=AM',
      '--format=%H',
      'HEAD',
      '--',
      DEST,
    ])
    expect(plain).toBe(parent)
    const demoFile = path.join(pr.home, 'demo.md')
    fs.writeFileSync(demoFile, '')

    const built = selectPins(pr, demoFile, 'raw', OWNER_REPO, resolved)

    expect(built.status, built.stdout + built.stderr).toBe(0)
    expect(JSON.parse(built.stdout).evidence_sha).toBe(merge)
    const text = fs.readFileSync(demoFile, 'utf8')
    expect(text).toContain(`/${merge}/${DEST}`)
    expect(text).not.toContain(parent)
  })

  test('a pin whose blob is not the classified one stops the run and writes no Demo file', () => {
    const pr = createPr()
    mergeResolved(pr)
    const demoFile = path.join(pr.home, 'demo.md')

    const built = selectPins(pr, demoFile, 'raw', OWNER_REPO, '0'.repeat(40))

    expect(built.status).toBe(1)
    expect(JSON.parse(built.stdout).result).toBe('pin-mismatch')
    expect(fs.existsSync(demoFile)).toBe(false)
  })
})

// ── Git attributes between the copy and the push ───────────────────────────

describe('pr-attachments dry run -- git cannot change an approved image on its way to the remote', () => {
  /** The png signature holds a CRLF, which a text conversion rewrites. */
  const CRLF_SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])
  /**
   * A png by its signature only. It has no NUL byte and enough printable
   * text, so git reads it as text where a real image would read as binary.
   */
  const TEXTUAL_PNG = Buffer.concat([
    CRLF_SIGNATURE,
    Buffer.from('line of text\r\n'.repeat(20)),
  ])

  function remoteHead(pr: Pr): string {
    return isolatedGit(pr.origin, ['rev-parse', 'refs/heads/feat/x'])
  }

  function useAttributes(pr: Pr, attributes: string): void {
    fs.writeFileSync(path.join(pr.work, '.gitattributes'), attributes)
    isolatedGit(pr.work, ['add', '--', '.gitattributes'])
    isolatedGit(pr.work, ['commit', '-q', '-m', 'attrs', '--no-verify'])
    isolatedGit(pr.work, ['push', '-q', 'origin', 'feat/x'])
  }

  test('text and eol on docs/evidence stop the run at the guard, before anything is staged or pushed', () => {
    const pr = createPr()
    useAttributes(pr, 'docs/evidence/** text eol=lf\n')
    const pushed = remoteHead(pr)
    const before = isolatedGit(pr.work, ['rev-parse', 'HEAD'])

    const guard = runBlock(pr, GUARD_MARKER, { set: [DEST] })

    // Output stops the run: Step 6 sends no later block.
    expect(guard.stdout).toContain(`${DEST}: text: set`)
    expect(guard.stdout).toContain(`${DEST}: eol: lf`)
    expect(isolatedGit(pr.work, ['rev-parse', 'HEAD'])).toBe(before)
    expect(remoteHead(pr)).toBe(pushed)
    expect(fs.existsSync(path.join(pr.work, DEST))).toBe(false)
  })

  test('without the guard, the staged check still stops a text conversion, and nothing is pushed', () => {
    const pr = createPr()
    useAttributes(pr, 'docs/evidence/** text eol=lf\n')
    const pushed = remoteHead(pr)
    const before = isolatedGit(pr.work, ['rev-parse', 'HEAD'])
    expect(copyEvidence(pr).status).toBe(0)
    expect(stageEvidence(pr).status).toBe(0)
    // git rewrote the signature's CRLF while staging.
    expect(isolatedGit(pr.work, ['rev-parse', `:${DEST}`])).not.toBe(
      classifiedBlob(pr),
    )

    const staged = checkStaged(pr)

    expect(staged.status).not.toBe(0)
    expect(staged.stdout).toContain(`blob-mismatch staged ${DEST}`)
    const recovery = runBlock(pr, 'git restore --staged', { set: [DEST] })
    expect(recovery.status, recovery.stderr).toBe(0)
    expect(isolatedGit(pr.work, ['diff', '--cached', '--name-only'])).toBe('')
    expect(isolatedGit(pr.work, ['rev-parse', 'HEAD'])).toBe(before)
    expect(remoteHead(pr)).toBe(pushed)
  })

  test('core.autocrlf passes the guard and is caught by the staged check, which unstages', () => {
    const pr = createPr()
    fs.writeFileSync(path.join(pr.work, 'shot.png'), TEXTUAL_PNG)
    isolatedGit(pr.work, ['config', 'core.autocrlf', 'true'])
    const pushed = remoteHead(pr)
    expect(runBlock(pr, GUARD_MARKER, { set: [DEST] }).stdout).toBe('')
    expect(copyEvidence(pr).status).toBe(0)
    expect(stageEvidence(pr).status).toBe(0)

    const staged = checkStaged(pr)

    expect(staged.status).not.toBe(0)
    expect(staged.stdout).toContain(`blob-mismatch staged ${DEST}`)
    expect(runBlock(pr, 'git restore --staged', { set: [DEST] }).status).toBe(0)
    expect(isolatedGit(pr.work, ['diff', '--cached', '--name-only'])).toBe(
      'notes.txt',
    )
    expect(remoteHead(pr)).toBe(pushed)
  })

  test('text=auto and an unset text pass the guard, and the image is staged and committed byte for byte', () => {
    for (const attributes of [
      '* text=auto\n',
      'docs/evidence/** -text\n',
      'docs/evidence/** binary\n',
    ]) {
      const pr = createPr()
      useAttributes(pr, attributes)
      fs.writeFileSync(path.join(pr.work, 'shot.png'), pngWith('crlf\r\n'))
      const blob = classifiedBlob(pr)

      expect(runBlock(pr, GUARD_MARKER, { set: [DEST] }).stdout).toBe('')
      expect(copyEvidence(pr, blob).status).toBe(0)
      expect(stageEvidence(pr).status).toBe(0)
      expect(checkStaged(pr, blob).status).toBe(0)
      expect(commitStaged(pr).status).toBe(0)
      expect(checkCommitted(pr, blob).status).toBe(0)
      expect(isolatedGit(pr.work, ['rev-parse', `HEAD:${DEST}`])).toBe(blob)
    }
  })

  test('a hook that rewrites the image during the commit is caught by the committed check, and the push never runs', () => {
    const pr = createPr()
    const pushed = remoteHead(pr)
    const hooks = path.join(pr.work, '.git/hooks')
    fs.mkdirSync(hooks, { recursive: true })
    fs.writeFileSync(
      path.join(hooks, 'pre-commit'),
      `#!/bin/sh\nprintf 'x' >> "${DEST}"\ngit add -- "${DEST}"\n`,
      { mode: 0o755 },
    )
    expect(copyEvidence(pr).status).toBe(0)
    expect(stageEvidence(pr).status).toBe(0)
    expect(checkStaged(pr).status).toBe(0)
    expect(commitStaged(pr).status).toBe(0)

    const committed = checkCommitted(pr)

    expect(committed.status).not.toBe(0)
    expect(committed.stdout).toContain(`blob-mismatch committed ${DEST}`)
    // The flow stops here with a local commit; no push block is sent.
    expect(remoteHead(pr)).toBe(pushed)
  })
})

// ── Re-pin mode: already-valid is verified before cleanup ──────────────────

describe('pr-attachments dry run -- an already-valid re-run checks what the remote serves', () => {
  /** Publishes, then backs up a description that holds the current embed, as the skill's block does. */
  function validBackup(pr: Pr): { head: string; backup: string; fake: FakePr } {
    publishEvidence(pr)
    const head = isolatedGit(pr.work, ['rev-parse', 'HEAD'])
    const embed = `![shot](${blobUrl(head)})`
    const fake = installFakePr(pr, `Intro\n\n## Demo\n\n${embed}\n`)
    const backup = path.join(pr.home, 'backup.json')
    const read = runWithGh(
      pr,
      fake.bin,
      fill(blockWith('" urls <'), {
        vars: { SKILL_DIR, PR: '7', BACKUP: backup },
        tokens: { '<owner/repo>': OWNER_REPO },
      }),
    )
    expect(read.status, read.stderr).toBe(0)
    return { head, backup, fake }
  }

  test('the URL listing reads the managed embeds out of the backup file', () => {
    const pr = createPr()
    const { head, backup } = validBackup(pr)

    const listed = runBlock(pr, BLOB_LIST_MARKER, {
      vars: { FILE: backup, OWNER_REPO },
    })

    expect(listed.status, listed.stderr).toBe(0)
    expect(listed.stdout.trim()).toBe(blobUrl(head))
  })

  test('the pins call says already-valid on local git alone, so the remote check is what can still fail', () => {
    const pr = createPr()
    const { head, backup } = validBackup(pr)
    const urls = runHelper(pr, 'urls', {
      body: JSON.parse(fs.readFileSync(backup, 'utf8')).body,
      head_repo: OWNER_REPO,
    })
    const pins = runHelper(pr, 'pins', {
      head_ref_oid: head,
      urls: urls.report.urls,
    })
    expect(pins.report.result).toBe('already-valid')

    // GitHub serving other bytes than git holds for the pin: the blob check
    // the skill sends next fails, and no cleanup is offered.
    const blob = isolatedGit(pr.work, ['rev-parse', `${head}:${DEST}`])
    const served = checkBlobs(pr, installFakeGh(pr), [`${blobUrl(head)} local`])
    expect(served.status, served.stdout + served.stderr).toBe(0)
    const refused = checkBlobs(pr, installFakeGh(pr), [
      `${blobUrl(head)} ${'0'.repeat(40)}`,
    ])
    expect(refused.status).not.toBe(0)
    expect(refused.stdout).toContain(`mismatch ${DEST}`)
    expect(blob).toMatch(/^[0-9a-f]{40}$/)
  })
})
