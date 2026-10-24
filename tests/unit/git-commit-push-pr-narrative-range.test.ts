import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Behavioural check for the narrative range in git-commit-push-pr. The skill
// tells the model to list the PR's commits with a fenced `git log` command.
// This test pulls that exact command out of SKILL.md, fills in the two base
// placeholders, and runs it against a real temp repository. The command has to
// list every feature commit and leave out evidence-only commits, whether or not
// pr-attachments made a new evidence commit.

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SKILL_PATH = path.join(REPO_ROOT, 'skills/git-commit-push-pr/SKILL.md')

function narrativeLogCommand(): string {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8')
  const start = skill.indexOf('**Narrative range after publishing.**')
  expect(start, 'narrative range paragraph').toBeGreaterThan(-1)
  const rest = skill.slice(start)
  const open = rest.indexOf('```bash\n')
  expect(open, 'fenced block in the narrative paragraph').toBeGreaterThan(-1)
  const body = rest.slice(open + '```bash\n'.length)
  const block = body.slice(0, body.indexOf('```'))
  const lines = block.split('\n').filter((line) => line.startsWith('git log '))
  expect(lines, 'exactly one git log line').toHaveLength(1)
  return (lines[0] ?? '')
    .replaceAll('<base-remote>', 'origin')
    .replaceAll('<base-branch>', 'main')
}

function withoutGitEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith('GIT_') && entry[1] !== undefined,
    ),
  )
}

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

function makeDir(prefix: string): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)),
  )
  tempDirs.push(dir)
  return dir
}

// No inherited `GIT_*` variables, no global or system config, a temp HOME, and
// identity from `-c`, so nothing reads or writes the developer's git setup.
function isolatedEnv(home: string): Record<string, string> {
  return {
    ...withoutGitEnv(),
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
}

function git(cwd: string, home: string, args: readonly string[]): string {
  const result = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=test',
      '-c',
      'user.email=t@t.test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, env: isolatedEnv(home) },
  )
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().replace(/\n$/, '')
}

interface Fixture {
  readonly dir: string
  readonly home: string
}

/** A repository whose `origin/main` ref points at a base commit. */
function makeRepo(): Fixture {
  const dir = makeDir('narrative-range')
  const home = makeDir('narrative-range-home')
  git(dir, home, ['init', '-q', '-b', 'feature'])
  commit({ dir, home }, 'src/base.ts', 'chore: base', 'export const base = 1\n')
  git(dir, home, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  return { dir, home }
}

function commit(
  fixture: Fixture,
  file: string,
  subject: string,
  content: string,
): void {
  const full = path.join(fixture.dir, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  git(fixture.dir, fixture.home, ['add', '--', file])
  git(fixture.dir, fixture.home, ['commit', '-q', '-m', subject, '--', file])
}

function runNarrativeLog(fixture: Fixture): { code: number; subjects: string } {
  const result = Bun.spawnSync(['sh', '-c', narrativeLogCommand()], {
    cwd: fixture.dir,
    env: isolatedEnv(fixture.home),
  })
  return {
    code: result.exitCode,
    subjects: result.stdout.toString(),
  }
}

describe('git-commit-push-pr narrative range -- behaviour of the fenced git log', () => {
  test('lists both feature commits and not the evidence-only commit between them', () => {
    const fixture = makeRepo()
    commit(fixture, 'src/f1.ts', 'feat: first', 'export const f1 = 1\n')
    commit(
      fixture,
      'docs/evidence/x/a.png',
      'chore(evidence): publish a.png',
      'png-bytes',
    )
    commit(fixture, 'src/f2.ts', 'feat: second', 'export const f2 = 2\n')

    const { code, subjects } = runNarrativeLog(fixture)

    expect(code).toBe(0)
    expect(subjects).toContain('feat: first')
    expect(subjects).toContain('feat: second')
    expect(subjects).not.toContain('publish a.png')
    expect(subjects).not.toContain('chore: base')
  })

  test('lists both feature commits when every image was reused and no evidence commit exists', () => {
    const fixture = makeRepo()
    commit(fixture, 'src/f1.ts', 'feat: first', 'export const f1 = 1\n')
    commit(fixture, 'src/f2.ts', 'feat: second', 'export const f2 = 2\n')

    const { code, subjects } = runNarrativeLog(fixture)

    expect(code).toBe(0)
    expect(subjects).toContain('feat: first')
    expect(subjects).toContain('feat: second')
  })

  test('drops an evidence-only commit even when its subject does not say chore(evidence):', () => {
    const fixture = makeRepo()
    commit(fixture, 'src/f1.ts', 'feat: first', 'export const f1 = 1\n')
    commit(fixture, 'docs/evidence/x/a.png', 'add screenshots', 'png-bytes')

    const { code, subjects } = runNarrativeLog(fixture)

    expect(code).toBe(0)
    expect(subjects).toContain('feat: first')
    expect(subjects).not.toContain('add screenshots')
  })
})
