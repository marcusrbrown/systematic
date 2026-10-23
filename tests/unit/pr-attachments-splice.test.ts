import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const SCRIPT_PATH = path.join(
  ROOT_DIR,
  'skills/pr-attachments/scripts/pr-attachments.mjs',
)

const CANARY = 'SECRET-CANARY-5e1c7d02'
const HEAD_REPO = 'octo/repo'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

const EOLS = { lf: '\n', crlf: '\r\n', cr: '\r' } as const

// ── Fixture builders ───────────────────────────────────────────────────────

function withEol(text: string, eol: string): string {
  return text.replaceAll('\n', eol)
}

interface UrlOptions {
  readonly slug?: string
  readonly repo?: string
}

function rawUrl(sha: string, name: string, options: UrlOptions = {}): string {
  const { slug = 'topic', repo = HEAD_REPO } = options
  return `https://raw.githubusercontent.com/${repo}/${sha}/docs/evidence/${slug}/${name}`
}

function blobUrl(sha: string, name: string, options: UrlOptions = {}): string {
  const { slug = 'topic', repo = HEAD_REPO } = options
  return `https://github.com/${repo}/blob/${sha}/docs/evidence/${slug}/${name}?raw=true`
}

function demoSection(sha = SHA_A, name = 'login.png'): string {
  return `## Demo\n\n![login](${rawUrl(sha, name)})\n`
}

const DEMO = demoSection()

// ── Process and filesystem harness ─────────────────────────────────────────

interface RawRun {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

function runHelper(
  args: readonly string[],
  stdin: string,
  cwd?: string,
): RawRun {
  const result = spawnSync('node', [SCRIPT_PATH, ...args], {
    input: stdin,
    encoding: 'utf8',
    ...(cwd === undefined ? {} : { cwd }),
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

const tempDirs: string[] = []

function makeDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pr-attachments-splice-')),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReport(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout)
  if (!isRecord(parsed)) {
    throw new Error('expected a JSON object on stdout')
  }
  return parsed
}

function listField(
  report: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const value = report[key]
  if (!Array.isArray(value)) {
    throw new Error(`expected array field ${key}`)
  }
  return value.map((item: unknown) => {
    if (!isRecord(item)) {
      throw new Error(`expected object items in ${key}`)
    }
    return item
  })
}

interface Run extends RawRun {
  readonly report: Record<string, unknown>
  readonly dir: string
  readonly outFile: string
  /** The bytes of the output file, or null when it does not exist. */
  readonly out: Buffer | null
}

interface RunOptions {
  readonly preCreate?: boolean
  readonly cwd?: string
}

function finish(raw: RawRun, dir: string, outFile: string): Run {
  return {
    ...raw,
    report: parseReport(raw.stdout),
    dir,
    outFile,
    out: fs.existsSync(outFile) ? fs.readFileSync(outFile) : null,
  }
}

function prepare(options: RunOptions): { dir: string; outFile: string } {
  const dir = makeDir()
  const outFile = path.join(dir, 'out.md')
  if (options.preCreate === true) {
    fs.writeFileSync(outFile, 'SENTINEL', { mode: 0o600 })
  }
  return { dir, outFile }
}

function runSplice(
  body: string,
  demo: string | Buffer,
  options: RunOptions = {},
): Run {
  const { dir, outFile } = prepare(options)
  const demoFile = path.join(dir, 'demo.md')
  fs.writeFileSync(demoFile, demo)
  const raw = runHelper(
    ['splice'],
    JSON.stringify({ body, demo_file: demoFile, out_file: outFile }),
    options.cwd ?? dir,
  )
  return finish(raw, dir, outFile)
}

function runExtract(body: string, options: RunOptions = {}): Run {
  const { dir, outFile } = prepare(options)
  const raw = runHelper(
    ['extract'],
    JSON.stringify({ body, out_file: outFile }),
    options.cwd ?? dir,
  )
  return finish(raw, dir, outFile)
}

function runUrls(body: string, headRepo: string = HEAD_REPO): Run {
  const { dir, outFile } = prepare({})
  const raw = runHelper(
    ['urls'],
    JSON.stringify({ body, head_repo: headRepo }),
    dir,
  )
  return finish(raw, dir, outFile)
}

function runRepin(
  body: string,
  pins: Record<string, string>,
  headRepo: string = HEAD_REPO,
  options: RunOptions = {},
): Run {
  const { dir, outFile } = prepare(options)
  const raw = runHelper(
    ['repin-rewrite'],
    JSON.stringify({
      body,
      head_repo: headRepo,
      pins,
      out_file: outFile,
    }),
    options.cwd ?? dir,
  )
  return finish(raw, dir, outFile)
}

function outText(run: Run): string {
  if (run.out === null) {
    throw new Error('the output file was not written')
  }
  return run.out.toString('utf8')
}

interface Parts {
  readonly before: string
  readonly middle: string
  readonly after: string
}

/**
 * The prefix and suffix oracle: bytes outside the replaced region must be
 * identical in input and output, and the output is exactly the three parts.
 */
function expectSplice(run: Run, parts: Parts): void {
  expect(run.status).toBe(0)
  expect(run.report.result).toBe('spliced')
  const out = run.out
  if (out === null) {
    throw new Error('the output file was not written')
  }
  const before = Buffer.from(parts.before)
  const after = Buffer.from(parts.after)
  expect(out.subarray(0, before.length).equals(before)).toBe(true)
  expect(out.subarray(out.length - after.length).equals(after)).toBe(true)
  expect(
    out.equals(Buffer.from(parts.before + parts.middle + parts.after)),
  ).toBe(true)
}

function countDemoHeadings(text: string): number {
  return (text.match(/^ {0,3}## +Demo/gm) ?? []).length
}

// ── splice: appending ──────────────────────────────────────────────────────

describe('splice: appending to a body with no Demo section', () => {
  for (const [name, eol] of Object.entries(EOLS)) {
    it(`keeps every earlier byte and leaves one blank line (${name})`, () => {
      const body = withEol('Summary\n\nWhat changed.\n', eol)
      const demo = withEol(DEMO, eol)

      const run = runSplice(body, demo)

      expectSplice(run, {
        before: body,
        middle: withEol('\n', eol) + demo,
        after: '',
      })
      expect(run.report.action).toBe('appended')
      expect(run.report.demo_count).toBe(0)
      expect(run.report.screenshots_present).toBe(false)
    })

    it(`ends an unterminated last line, then leaves a blank line (${name})`, () => {
      const body = withEol('Summary\n\nWhat changed.', eol)
      const demo = withEol(DEMO, eol)

      const run = runSplice(body, demo)

      // The body has one terminator style, so the separator follows it.
      expectSplice(run, { before: body, middle: eol + eol + demo, after: '' })
    })
  }

  it('adds nothing when the body already ends with a blank line', () => {
    for (const body of ['x\n\n', 'x\n\n\n\n', 'x\r\n\r\n', 'x\n  \n']) {
      const run = runSplice(body, DEMO)

      expectSplice(run, { before: body, middle: DEMO, after: '' })
    }
  })

  it('turns an empty body into exactly the section', () => {
    const run = runSplice('', DEMO)

    expectSplice(run, { before: '', middle: DEMO, after: '' })
    expect(run.report.action).toBe('appended')
  })

  it('keeps a whitespace-only body and appends the section after it', () => {
    for (const body of ['  \n\t\n', '\n', '\r\n\r\n']) {
      const run = runSplice(body, DEMO)

      expectSplice(run, { before: body, middle: DEMO, after: '' })
    }
    // An unterminated whitespace line is ended, and serves as the blank line.
    expectSplice(runSplice('   ', DEMO), {
      before: '   ',
      middle: `\n${DEMO}`,
      after: '',
    })
  })

  it('uses the body EOL for separators and keeps the Demo bytes verbatim', () => {
    const body = 'one\r\ntwo'

    const run = runSplice(body, DEMO)

    expectSplice(run, {
      before: body,
      middle: `\r\n\r\n${DEMO}`,
      after: '',
    })
    // The inserted separators are CRLF; the section itself is untouched LF.
    expect(outText(run).endsWith(DEMO)).toBe(true)
  })

  it('appends a Demo text that has no final newline as it is', () => {
    const demo = DEMO.slice(0, -1)

    const run = runSplice('x\n', demo)

    expectSplice(run, { before: 'x\n', middle: `\n${demo}`, after: '' })
  })

  it('treats trailing blank lines on the Demo text as no part of it', () => {
    const run = runSplice('x\n', `${DEMO}\n\n  \n`)

    expectSplice(run, { before: 'x\n', middle: `\n${DEMO}`, after: '' })
  })

  it('appends a Demo text with its own hash-closed heading verbatim', () => {
    const demo = '## Demo ##\n\nbody\n'

    const run = runSplice('x\n', demo)

    expectSplice(run, { before: 'x\n', middle: `\n${demo}`, after: '' })
  })
})

// ── splice: replacing ──────────────────────────────────────────────────────

describe('splice: replacing an existing Demo section', () => {
  const before = '## Summary\n\nDid things.\n\n'
  const oldDemo =
    '## Demo\n\n![old](https://example.com/old.png)\n\nHand caption.\n'
  const tail = '\n## Testing\n\nRan bun test.\n'

  for (const [name, eol] of Object.entries(EOLS)) {
    it(`leaves ## Testing and everything else byte-identical (${name})`, () => {
      const body = withEol(before + oldDemo + tail, eol)
      const demo = withEol(DEMO, eol)

      const run = runSplice(body, demo)

      expectSplice(run, {
        before: withEol(`${before}## Demo\n`, eol),
        middle: withEol(DEMO.slice('## Demo\n'.length), eol),
        after: withEol(tail, eol),
      })
      expect(run.report.action).toBe('replaced')
      expect(run.report.demo_count).toBe(1)
      expect(countDemoHeadings(outText(run))).toBe(1)
    })
  }

  it('keeps the existing heading line bytes, whatever their style', () => {
    for (const heading of [
      '## Demo ##',
      '   ## Demo   ',
      '##\tDemo',
      '## Demo #',
      '  ##  Demo',
    ]) {
      const body = `Intro\n\n${heading}\nold\n${tail}`

      const run = runSplice(body, DEMO)

      expectSplice(run, {
        before: `Intro\n\n${heading}\n`,
        middle: DEMO.slice('## Demo\n'.length),
        after: tail,
      })
    }
  })

  it('ends the section only at an H1 or H2, not at deeper headings', () => {
    const old =
      '## Demo\n\nold\n\n### Three\n\n#### Four\n\nmore\n\n#hashtag text\n\n---\n\nlast\n'
    for (const next of ['## Testing\n', '# Title\n', '##\n']) {
      const body = `${before}${old}\n${next}rest\n`

      const run = runSplice(body, DEMO)

      expectSplice(run, {
        before: `${before}## Demo\n`,
        middle: DEMO.slice('## Demo\n'.length),
        after: `\n${next}rest\n`,
      })
      expect(outText(run)).not.toContain('#### Four')
    }
  })

  it('ends the section at a setext heading', () => {
    for (const underlined of ['Testing\n-------\n', 'Notes\n=====\n']) {
      const body = `${before}${oldDemo}\n${underlined}\ntext\n`

      const run = runSplice(body, DEMO)

      expectSplice(run, {
        before: `${before}## Demo\n`,
        middle: DEMO.slice('## Demo\n'.length),
        after: `\n${underlined}\ntext\n`,
      })
    }
  })

  it('takes a whole paragraph as a setext heading, as CommonMark does', () => {
    const body = '## Demo\n\nfirst line\nsecond line\n---\nafter\n'

    const run = runSplice(body, DEMO)

    // The paragraph starts the new heading, so the old section is blank.
    expectSplice(run, {
      before: '## Demo\n',
      middle: DEMO.slice('## Demo\n'.length),
      after: '\nfirst line\nsecond line\n---\nafter\n',
    })
  })

  it('does not end the section at a thematic break', () => {
    const body = '## Demo\n\nold\n\n---\n\n***\n\nmore\n'

    const run = runSplice(body, DEMO)

    expectSplice(run, {
      before: '## Demo\n',
      middle: DEMO.slice('## Demo\n'.length),
      after: '',
    })
  })

  it('does not look inside fences, comments or quotes for the section end', () => {
    const old =
      '## Demo\n\n```md\n## Fake\n```\n\n<!--\n## Hidden\n-->\n\n> ## Quoted\n\nend\n'
    const body = `${old}\n## Testing\n`

    const run = runSplice(body, DEMO)

    expectSplice(run, {
      before: '## Demo\n',
      middle: DEMO.slice('## Demo\n'.length),
      after: '\n## Testing\n',
    })
  })

  it('keeps a trailing gap of blank lines outside the section', () => {
    const body = '## Demo\nold\n\n\n\n## Testing\n'

    const run = runSplice(body, DEMO)

    expectSplice(run, {
      before: '## Demo\n',
      middle: DEMO.slice('## Demo\n'.length),
      after: '\n\n\n## Testing\n',
    })
  })

  it('ends an unterminated last line of the new section before a heading', () => {
    const demo = DEMO.slice(0, -1)

    const run = runSplice('## Demo\nold\n## Testing\n', demo)

    expectSplice(run, {
      before: '## Demo\n',
      middle: `${demo.slice('## Demo\n'.length)}\n`,
      after: '## Testing\n',
    })
  })

  it('handles a Demo section that is last, with and without a final newline', () => {
    for (const oldEnd of ['old\n', 'old']) {
      for (const newEnd of ['new\n', 'new']) {
        const body = `x\n\n## Demo\n${oldEnd}`

        const run = runSplice(body, `## Demo\n${newEnd}`)

        expectSplice(run, {
          before: 'x\n\n## Demo\n',
          middle: newEnd,
          after: '',
        })
      }
    }
  })

  it('ends a heading-only last line before it adds content', () => {
    const run = runSplice('x\n\n## Demo', DEMO)

    expectSplice(run, {
      before: 'x\n\n## Demo',
      middle: `\n${DEMO.slice('## Demo\n'.length)}`,
      after: '',
    })
  })

  it('replaces an empty Demo section that is followed by a heading', () => {
    const run = runSplice('## Demo\n## Testing\n', DEMO)

    expectSplice(run, {
      before: '## Demo\n',
      middle: DEMO.slice('## Demo\n'.length),
      after: '## Testing\n',
    })
  })

  it('reports unchanged and writes identical bytes when nothing differs', () => {
    const body = `intro\n\n${DEMO}\n## Testing\n`

    const run = runSplice(body, DEMO)

    expect(run.status).toBe(0)
    expect(run.report.action).toBe('unchanged')
    expect(run.out?.equals(Buffer.from(body))).toBe(true)
  })

  it('reports unchanged when only the heading style differs', () => {
    const body = `intro\n\n## Demo ##\n${DEMO.slice('## Demo\n'.length)}`

    const run = runSplice(body, DEMO)

    expect(run.report.action).toBe('unchanged')
    expect(run.out?.equals(Buffer.from(body))).toBe(true)
  })

  it('keeps a later section that holds an unclosed fence untouched', () => {
    const notes = '## Notes\n\n```\ncode that never closes\n## Demo\n'
    const body = `## Demo\nold\n\n${notes}`

    const run = runSplice(body, DEMO)

    expectSplice(run, {
      before: '## Demo\n',
      middle: DEMO.slice('## Demo\n'.length),
      after: `\n${notes}`,
    })
    expect(run.report.demo_count).toBe(1)
  })
})

// ── splice: the fixed point ────────────────────────────────────────────────

describe('splice: fixed point', () => {
  const bodies: Record<string, string> = {
    'no Demo': 'Summary\n\nText.\n',
    'no Demo, no trailing newline': 'Summary',
    'empty body': '',
    'whitespace-only body': '  \n',
    'an existing Demo in the middle': `a\n\n${DEMO}\n## Testing\n\nx\n`,
    'an existing Demo, last, no newline': 'a\n\n## Demo\nold',
    'a Demo with a gap of blank lines': '## Demo\nold\n\n\n## Testing\n',
    CRLF: 'a\r\n\r\n## Demo\r\nold\r\n\r\n## Testing\r\nx\r\n',
  }

  for (const [name, body] of Object.entries(bodies)) {
    it(`splicing the same Demo twice gives identical bytes (${name})`, () => {
      const first = runSplice(body, DEMO)
      expect(first.status).toBe(0)

      const second = runSplice(outText(first), DEMO)

      expect(second.status).toBe(0)
      expect(second.report.action).toBe('unchanged')
      expect(second.out?.equals(first.out ?? Buffer.alloc(0))).toBe(true)
    })
  }

  it('holds for a CR-only body with a CR-only Demo text', () => {
    const demo = withEol(DEMO, '\r')
    const first = runSplice('a\r\r## Demo\rold\r\r## Testing\rx\r', demo)

    const second = runSplice(outText(first), demo)

    expect(second.report.action).toBe('unchanged')
    expect(second.out?.equals(first.out ?? Buffer.alloc(0))).toBe(true)
  })

  it('holds for a Demo text with trailing blank lines', () => {
    const demo = `${DEMO}\n\n\n`
    const first = runSplice('a\n\n## Testing\n', demo)

    const second = runSplice(outText(first), demo)

    expect(second.report.action).toBe('unchanged')
    expect(second.out?.equals(first.out ?? Buffer.alloc(0))).toBe(true)
  })
})

// ── splice: regions that hide a heading ────────────────────────────────────

describe('splice: a Demo heading the parser must not see', () => {
  function expectAppendedAround(body: string): void {
    const run = runSplice(body, DEMO)

    expectSplice(run, {
      before: body,
      middle: body.endsWith('\n\n') ? DEMO : `\n${DEMO}`,
      after: '',
    })
    expect(run.report.action).toBe('appended')
    expect(run.report.demo_count).toBe(0)
  }

  it('ignores a heading in a backtick fence earlier in the body', () => {
    expectAppendedAround(
      'Template:\n\n```markdown\n## Demo\n\n![x](y)\n```\n\nEnd.\n',
    )
  })

  it('ignores a heading in a tilde fence', () => {
    expectAppendedAround('~~~\n## Demo\n~~~\n')
  })

  it('does not close a fence with a shorter or different run', () => {
    expectAppendedAround('````\n```\n## Demo\n```\n~~~~\n````\n')
  })

  it('does not take a backtick line with a backtick info string for a fence', () => {
    // `inline` code on its own line is not a fence, so the heading is real.
    const body = '```not a fence```\n\n## Demo\nold\n'

    const run = runSplice(body, DEMO)

    expect(run.report.action).toBe('replaced')
    expect(run.report.demo_count).toBe(1)
  })

  it('ignores a heading in a multi-line HTML comment', () => {
    expectAppendedAround('<!--\nTemplate\n## Demo\n-->\n')
  })

  it('ignores a heading in a one-line HTML comment', () => {
    expectAppendedAround('<!-- ## Demo -->\n')
  })

  it('finds the real heading after a comment closes', () => {
    const body = '<!--\n## Demo\n-->\n\n## Demo\nold\n'

    const run = runSplice(body, DEMO)

    expectSplice(run, {
      before: '<!--\n## Demo\n-->\n\n## Demo\n',
      middle: DEMO.slice('## Demo\n'.length),
      after: '',
    })
    expect(run.report.demo_count).toBe(1)
  })

  it('does not let a fence marker inside a comment open a fence', () => {
    const body = '<!--\n```\n-->\n\n## Demo\nold\n'

    expect(runSplice(body, DEMO).report.demo_count).toBe(1)
  })

  it('does not let a comment marker inside a fence open a comment', () => {
    const body = '```\n<!--\n```\n\n## Demo\nold\n'

    expect(runSplice(body, DEMO).report.demo_count).toBe(1)
  })

  it('ignores a heading in a blockquote', () => {
    expectAppendedAround('> ## Demo\n> old\n')
  })

  it('ends a quoted fence with the quote, as CommonMark does', () => {
    const body = '> ```\n\n## Demo\nold\n'

    expect(runSplice(body, DEMO).report.demo_count).toBe(1)
  })

  it('ignores indented code', () => {
    expectAppendedAround('Text\n\n    ## Demo\n\n\t## Demo\n')
  })

  it('does not take near misses for the heading', () => {
    for (const heading of [
      '## Demos',
      '## Demonstration',
      '### Demo',
      '#### Demo',
      '# Demo',
      '## Demo notes',
      '##Demo',
      '## demo',
      '## Demo#',
      '    ## Demo',
    ]) {
      const body = `Intro\n\n${heading}\n\ntext\n`

      const run = runSplice(body, DEMO)

      expect(run.report.action).toBe('appended')
      expect(run.report.demo_count).toBe(0)
      expect(outText(run).startsWith(body)).toBe(true)
    }
  })

  it('does not take a hash-closed heading with a trailing # run for another word', () => {
    const run = runSplice('## Demo ##\nold\n', DEMO)

    expect(run.report.demo_count).toBe(1)
  })
})

// ── splice: Screenshots ────────────────────────────────────────────────────

describe('splice: an existing ## Screenshots section', () => {
  it('leaves Screenshots alone, appends Demo and reports it', () => {
    const body = '## Summary\n\n## Screenshots\n\n![x](https://e.com/x.png)\n'

    const run = runSplice(body, DEMO)

    expectSplice(run, { before: body, middle: `\n${DEMO}`, after: '' })
    expect(run.report.screenshots_present).toBe(true)
    expect(run.report.demo_count).toBe(0)
  })

  it('reports Screenshots for a hash-closed heading', () => {
    const run = runSplice('## Screenshots ##\n\nx\n', DEMO)

    expect(run.report.screenshots_present).toBe(true)
  })

  it('does not report a Screenshots heading hidden in a fence', () => {
    const run = runSplice('```\n## Screenshots\n```\n', DEMO)

    expect(run.report.screenshots_present).toBe(false)
  })

  it('reports Screenshots next to a replaced Demo', () => {
    const body = '## Screenshots\n\nx\n\n## Demo\nold\n'

    const run = runSplice(body, DEMO)

    expect(run.report.action).toBe('replaced')
    expect(run.report.screenshots_present).toBe(true)
  })
})

// ── splice: conflicts and unterminated regions ─────────────────────────────

describe('splice: stops and asks', () => {
  it('reports a conflict and writes no body for two Demo sections', () => {
    const body = `${DEMO}\n## Middle\n\n${DEMO}`

    const run = runSplice(body, DEMO)

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('needs-input')
    expect(run.report.demo_count).toBe(2)
    expect(listField(run.report, 'asks')).toEqual([
      { code: 'multiple-demo-sections', count: 2 },
    ])
    expect(run.out).toBeNull()
  })

  it('leaves an existing output file untouched on a conflict', () => {
    const run = runSplice(`${DEMO}\n${DEMO}`, DEMO, { preCreate: true })

    expect(run.status).toBe(1)
    expect(run.out?.toString('utf8')).toBe('SENTINEL')
  })

  it('counts only Demo headings outside hidden regions', () => {
    const body = `${DEMO}\n\`\`\`\n## Demo\n\`\`\`\n`

    const run = runSplice(body, DEMO)

    expect(run.status).toBe(0)
    expect(run.report.demo_count).toBe(1)
  })

  it('stops when a CR would fuse with an LF at a seam', () => {
    // A CR-ended heading followed by an LF-ended Demo text would read as one
    // CRLF and drop a line, and the next run would not reproduce the output.
    for (const body of ['a\r\r## Demo\rold\r', 'a\nb\nc\nd\r']) {
      const run = runSplice(body, DEMO)

      expect(run.status).toBe(1)
      expect(run.report.result).toBe('needs-input')
      expect(listField(run.report, 'asks')).toEqual([
        { code: 'line-ending-conflict' },
      ])
      expect(run.out).toBeNull()
    }
  })

  it('refuses to append after an unclosed fence', () => {
    // Anything appended would land inside the fence and never render, and
    // the next run would append again.
    const body = 'Intro\n\n```\n## Demo\nnever closed\n'

    const run = runSplice(body, DEMO)

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('needs-input')
    expect(run.report.demo_count).toBe(0)
    expect(listField(run.report, 'asks')).toEqual([
      { code: 'unterminated-region', kind: 'fence' },
    ])
    expect(run.out).toBeNull()
  })

  it('refuses to append after an unclosed HTML comment', () => {
    const run = runSplice('Intro\n\n<!--\nnever closed\n', DEMO)

    expect(run.status).toBe(1)
    expect(listField(run.report, 'asks')).toEqual([
      { code: 'unterminated-region', kind: 'comment' },
    ])
    expect(run.out).toBeNull()
  })
})

// ── splice: bytes and encodings ────────────────────────────────────────────

describe('splice: bytes', () => {
  it('writes the body as exact UTF-8, including a BOM and non-BMP text', () => {
    const body = '\uFEFFcafé — “quoted” 🚀 \u2028 line\n'

    const run = runSplice(body, DEMO)

    expectSplice(run, { before: body, middle: `\n${DEMO}`, after: '' })
  })

  it('decodes the JSON body once and never unescapes its text', () => {
    // Backslash sequences in the body are text, not escapes.
    const body = 'path C:\\new\\table and \\u00e9 and \\\\ and \\n\n'

    const run = runSplice(body, DEMO)

    expectSplice(run, { before: body, middle: `\n${DEMO}`, after: '' })
  })

  it('keeps a BOM inside the Demo text and does not strip it', () => {
    const demo = '## Demo\n\n\uFEFFcaption\n'

    const run = runSplice('x\n', Buffer.from(demo, 'utf8'))

    expectSplice(run, { before: 'x\n', middle: `\n${demo}`, after: '' })
  })

  it('does not accept a BOM before the Demo heading', () => {
    const run = runSplice('x\n', Buffer.from(`\uFEFF${DEMO}`, 'utf8'))

    expect(run.status).toBe(2)
    expect(run.report.operation).toBe('splice')
  })

  it('exits 2 for a body that is not well-formed Unicode', () => {
    const { dir, outFile } = prepare({})
    const demoFile = path.join(dir, 'demo.md')
    fs.writeFileSync(demoFile, DEMO)
    const stdin = `{"body":"lone \\ud800 surrogate","demo_file":${JSON.stringify(
      demoFile,
    )},"out_file":${JSON.stringify(outFile)}}`

    const run = runHelper(['splice'], stdin, dir)

    expect(run.status).toBe(2)
    expect(parseReport(run.stdout).operation).toBe('splice')
    expect(fs.existsSync(outFile)).toBe(false)
  })

  it('exits 2 for a Demo file that is not valid UTF-8', () => {
    const run = runSplice('x\n', Buffer.from([0x23, 0x23, 0x20, 0xff, 0xfe]))

    expect(run.status).toBe(2)
    expect(run.report.operation).toBe('splice')
    expect(run.out).toBeNull()
  })
})

// ── splice: files and echo ─────────────────────────────────────────────────

describe('splice: what it writes and prints', () => {
  it('writes only the named output path', () => {
    const cwd = makeDir()
    fs.writeFileSync(path.join(cwd, 'decoy.txt'), 'decoy')
    const run = runSplice(`x\n${CANARY}\n`, DEMO, { cwd })

    expect(run.status).toBe(0)
    expect(fs.readdirSync(cwd)).toEqual(['decoy.txt'])
    expect(fs.readFileSync(path.join(cwd, 'decoy.txt'), 'utf8')).toBe('decoy')
    expect(fs.readdirSync(run.dir).sort()).toEqual(['demo.md', 'out.md'])
    expect(fs.readFileSync(path.join(run.dir, 'demo.md'), 'utf8')).toBe(DEMO)
  })

  it('keeps the body bytes off stdout and stderr', () => {
    const ok = runSplice(`x ${CANARY}\n`, DEMO)
    const conflict = runSplice(`${DEMO}${CANARY}\n${DEMO}`, DEMO)

    expect(ok.status).toBe(0)
    expect(conflict.status).toBe(1)
    for (const run of [ok, conflict]) {
      expect(run.stdout).not.toContain(CANARY)
      expect(run.stderr).not.toContain(CANARY)
      expect(run.stdout.trim().split('\n')).toHaveLength(1)
    }
    expect(ok.report.operation).toBe('splice')
    expect(ok.report.out_file).toBe(ok.outFile)
    expect(ok.report.bytes).toBe(ok.out?.length)
  })

  it('creates a missing output file with mode 0600', () => {
    const run = runSplice('x\n', DEMO)

    expect(fs.statSync(run.outFile).mode & 0o777).toBe(0o600)
  })

  it('keeps the mode of an output file that already exists', () => {
    const { dir, outFile } = prepare({ preCreate: true })
    fs.chmodSync(outFile, 0o600)
    const demoFile = path.join(dir, 'demo.md')
    fs.writeFileSync(demoFile, DEMO)

    const raw = runHelper(
      ['splice'],
      JSON.stringify({ body: 'x\n', demo_file: demoFile, out_file: outFile }),
      dir,
    )

    expect(raw.status).toBe(0)
    // One descriptor for both reads, so the mode and the bytes describe the
    // same file even if the path is replaced in between.
    const fd = fs.openSync(outFile, 'r')
    try {
      expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(fd, 'utf8')).toBe(`x\n\n${DEMO}`)
    } finally {
      fs.closeSync(fd)
    }
  })

  it('exits 1 with a fixed code when the output path cannot be written', () => {
    const { dir } = prepare({})
    const demoFile = path.join(dir, 'demo.md')
    fs.writeFileSync(demoFile, DEMO)
    const missingDir = path.join(dir, 'no-such-dir', 'out.md')

    const raw = runHelper(
      ['splice'],
      JSON.stringify({
        body: 'x\n',
        demo_file: demoFile,
        out_file: missingDir,
      }),
      dir,
    )

    expect(raw.status).toBe(1)
    expect(parseReport(raw.stdout).result).toBe('write-failed')
    expect(fs.existsSync(path.join(dir, 'no-such-dir'))).toBe(false)
  })
})

// ── splice: invalid input ──────────────────────────────────────────────────

describe('splice: usage errors', () => {
  function expectUsageError(raw: RawRun): void {
    expect(raw.status).toBe(2)
    const report = parseReport(raw.stdout)
    expect(report.operation).toBe('splice')
    expect(report.result).toBe('usage-error')
    expect(typeof report.error).toBe('string')
  }

  function spliceRaw(input: unknown): RawRun {
    return runHelper(['splice'], JSON.stringify(input), makeDir())
  }

  it('exits 2 for missing or mistyped fields', () => {
    const dir = makeDir()
    const demoFile = path.join(dir, 'demo.md')
    fs.writeFileSync(demoFile, DEMO)
    const good = {
      body: 'x',
      demo_file: demoFile,
      out_file: path.join(dir, 'out.md'),
    }

    for (const key of Object.keys(good)) {
      const missing: Record<string, unknown> = { ...good }
      delete missing[key]
      expectUsageError(spliceRaw(missing))
      expectUsageError(spliceRaw({ ...good, [key]: 7 }))
    }
    expectUsageError(spliceRaw({ ...good, demo_file: '' }))
    expectUsageError(spliceRaw({ ...good, out_file: 'bad\0path' }))
    expectUsageError(spliceRaw([]))
    expect(fs.existsSync(good.out_file)).toBe(false)
  })

  it('exits 2 for a missing, unreadable or non-file Demo path', () => {
    const dir = makeDir()
    const outFile = path.join(dir, 'out.md')

    for (const demoFile of [path.join(dir, 'absent.md'), dir]) {
      expectUsageError(
        spliceRaw({ body: 'x', demo_file: demoFile, out_file: outFile }),
      )
    }
    expect(fs.existsSync(outFile)).toBe(false)
  })

  it('exits 2 for a Demo text that is not exactly one Demo section', () => {
    const cases = [
      '',
      'no heading here\n',
      '# Not demo\n',
      `text first\n${DEMO}`,
      `${DEMO}\n## Second\n\nmore\n`,
      `${DEMO}\n${DEMO}`,
      '## Demo\n\n```\nnever closed\n',
      '## Demo\n\n<!-- never closed\n',
    ]
    for (const demo of cases) {
      const run = runSplice('x\n', demo)

      expect(run.status).toBe(2)
      expect(run.report.operation).toBe('splice')
      expect(run.report.result).toBe('usage-error')
      expect(run.out).toBeNull()
    }
  })

  it('exits 2 for malformed JSON without echoing it', () => {
    const raw = runHelper(['splice'], `{"body": "${CANARY}"`)

    expectUsageError(raw)
    expect(raw.stdout).not.toContain(CANARY)
    expect(raw.stderr).not.toContain(CANARY)
  })
})

// ── extract ────────────────────────────────────────────────────────────────

describe('extract', () => {
  const section =
    '## Demo ##\n\n![a](https://example.com/a.png)\n\n#### Notes\n\nHand written: café — “quoted” \n'

  for (const [name, eol] of Object.entries(EOLS)) {
    it(`returns the section bytes verbatim, heading to section end (${name})`, () => {
      const wrapped = withEol(section, eol)
      const body =
        withEol(`# T\n\ntext\n\n`, eol) +
        wrapped +
        withEol('\n\n## Testing\n\nx\n', eol)

      const run = runExtract(body)

      expect(run.status).toBe(0)
      expect(run.report.result).toBe('extracted')
      expect(run.report.demo_count).toBe(1)
      expect(run.out?.equals(Buffer.from(wrapped))).toBe(true)
      expect(run.report.bytes).toBe(Buffer.byteLength(wrapped))
    })
  }

  it('keeps fenced text that looks like headings, including a fake Demo', () => {
    const inner = '## Demo\n\n```md\n# not a heading\n## Demo\n```\n\ntail\n'

    const run = runExtract(`a\n\n${inner}\n## Testing\n`)

    expect(run.report.demo_count).toBe(1)
    expect(outText(run)).toBe(inner)
  })

  it('returns a last section with and without a final newline', () => {
    expect(outText(runExtract('a\n\n## Demo\nold\n'))).toBe('## Demo\nold\n')
    expect(outText(runExtract('a\n\n## Demo\nold'))).toBe('## Demo\nold')
    expect(outText(runExtract('## Demo'))).toBe('## Demo')
  })

  it('leaves trailing blank lines out of the section', () => {
    expect(outText(runExtract('## Demo\nold\n\n\n## Testing\n'))).toBe(
      '## Demo\nold\n',
    )
  })

  it('reports absent, exits 0 and writes nothing when there is no Demo', () => {
    for (const body of [
      '',
      'Summary\n',
      '## Screenshots\n',
      '```\n## Demo\n```\n',
      '```\n## Demo\nnever closed\n',
      '<!-- ## Demo -->\n',
      '> ## Demo\n',
    ]) {
      const run = runExtract(body)

      expect(run.status).toBe(0)
      expect(run.report.result).toBe('absent')
      expect(run.report.demo_count).toBe(0)
      expect(run.out).toBeNull()
    }
  })

  it('leaves an existing output file alone when the Demo is absent', () => {
    const run = runExtract('Summary\n', { preCreate: true })

    expect(run.report.result).toBe('absent')
    expect(run.out?.toString('utf8')).toBe('SENTINEL')
  })

  it('reports a conflict and writes nothing for two Demo sections', () => {
    const run = runExtract(`${DEMO}\n## Mid\n\n${DEMO}`, { preCreate: true })

    expect(run.status).toBe(1)
    expect(run.report.result).toBe('needs-input')
    expect(listField(run.report, 'asks')).toEqual([
      { code: 'multiple-demo-sections', count: 2 },
    ])
    expect(run.out?.toString('utf8')).toBe('SENTINEL')
  })

  it('writes only the named path and keeps the body off stdout', () => {
    const cwd = makeDir()
    const run = runExtract(`x ${CANARY}\n\n${DEMO}`, { cwd })

    expect(run.status).toBe(0)
    expect(fs.readdirSync(cwd)).toEqual([])
    expect(fs.readdirSync(run.dir)).toEqual(['out.md'])
    expect(run.stdout).not.toContain(CANARY)
    expect(run.stdout).not.toContain('login')
    expect(run.stderr).toBe('')
  })

  it('exits 2 for missing or mistyped fields', () => {
    const dir = makeDir()
    const outFile = path.join(dir, 'out.md')
    for (const input of [
      {},
      { body: 'x' },
      { out_file: outFile },
      { body: 1, out_file: outFile },
      { body: 'x', out_file: '' },
      { body: 'x', out_file: 2 },
    ]) {
      const raw = runHelper(['extract'], JSON.stringify(input), dir)

      expect(raw.status).toBe(2)
      expect(parseReport(raw.stdout).operation).toBe('extract')
      expect(parseReport(raw.stdout).result).toBe('usage-error')
    }
  })
})

describe('step 7 round trip: extract, then splice into a regenerated body', () => {
  const oldSection = `## Demo\n\n![login](${rawUrl(SHA_A, 'login.png')})\n\nCaption I edited by hand.\n\n#### Detail\n\n![dash](${blobUrl(SHA_A, 'dash.png')})\n`

  for (const [name, eol] of Object.entries(EOLS)) {
    it(`keeps the Demo section byte-identical (${name})`, () => {
      const section = withEol(oldSection, eol)
      const oldBody =
        withEol('## Summary\n\nOld text.\n\n', eol) +
        section +
        withEol('\n## Testing\n\nold\n', eol)
      const extracted = runExtract(oldBody)
      expect(extracted.out?.equals(Buffer.from(section))).toBe(true)
      const regenerated = '## Summary\n\nFresh text.\n\n## Testing\n\nnew\n'

      const spliced = runSplice(regenerated, extracted.out ?? Buffer.alloc(0))

      expectSplice(spliced, {
        before: regenerated,
        middle: (regenerated.endsWith('\n\n') ? '' : '\n') + section,
        after: '',
      })
      const again = runExtract(outText(spliced))
      expect(again.out?.equals(Buffer.from(section))).toBe(true)
    })
  }

  it('also holds when the regenerated body already has a Demo section', () => {
    const regenerated = `## Summary\n\nFresh.\n\n${demoSection(SHA_C, 'other.png')}\n## Testing\n`
    const extracted = runExtract(`x\n\n${oldSection}\n## Testing\n`)

    const spliced = runSplice(regenerated, extracted.out ?? Buffer.alloc(0))

    expect(spliced.report.action).toBe('replaced')
    const final = runExtract(outText(spliced))
    expect(final.out?.equals(extracted.out ?? Buffer.alloc(1))).toBe(true)
    expect(outText(spliced).endsWith('\n## Testing\n')).toBe(true)
  })
})

// ── urls ───────────────────────────────────────────────────────────────────

describe('urls', () => {
  it('extracts managed raw and blob embeds in order', () => {
    const body = [
      `![a](${rawUrl(SHA_A, 'a.png')})`,
      `<img src="${blobUrl(SHA_B, 'b-two.jpg', { slug: 'topic-two' })}">`,
      `[link](${rawUrl(SHA_C, 'c.gif')}) and <${rawUrl(SHA_C, 'd.webp')}>`,
      '',
    ].join('\n')

    const run = runUrls(body)

    expect(run.status).toBe(0)
    expect(run.report.result).toBe('urls')
    expect(listField(run.report, 'urls')).toEqual([
      {
        owner: 'octo',
        repo: 'repo',
        sha: SHA_A,
        path: 'docs/evidence/topic/a.png',
        form: 'raw',
      },
      {
        owner: 'octo',
        repo: 'repo',
        sha: SHA_B,
        path: 'docs/evidence/topic-two/b-two.jpg',
        form: 'blob',
      },
      {
        owner: 'octo',
        repo: 'repo',
        sha: SHA_C,
        path: 'docs/evidence/topic/c.gif',
        form: 'raw',
      },
      {
        owner: 'octo',
        repo: 'repo',
        sha: SHA_C,
        path: 'docs/evidence/topic/d.webp',
        form: 'raw',
      },
    ])
    expect(run.report.ignored).toBe(0)
  })

  it('compares the head repo without regard to case', () => {
    const run = runUrls(
      `![a](${rawUrl(SHA_A, 'a.png', { repo: 'Octo/Repo' })})`,
    )

    expect(listField(run.report, 'urls')).toHaveLength(1)
  })

  it('manages a URL that is followed by sentence punctuation', () => {
    const run = runUrls(`See ${rawUrl(SHA_A, 'a.png')}.\n`)

    expect(listField(run.report, 'urls')).toHaveLength(1)
  })

  const unmanaged: Record<string, string> = {
    'another host': `https://example.com/${HEAD_REPO}/${SHA_A}/docs/evidence/topic/a.png`,
    'another owner (raw)': rawUrl(SHA_A, 'a.png', { repo: 'someone/repo' }),
    'another repo (raw)': rawUrl(SHA_A, 'a.png', { repo: 'octo/other' }),
    'another owner (blob)': blobUrl(SHA_A, 'a.png', { repo: 'someone/repo' }),
    'another repo (blob)': blobUrl(SHA_A, 'a.png', { repo: 'octo/other' }),
    'a path outside docs/evidence': `https://raw.githubusercontent.com/${HEAD_REPO}/${SHA_A}/docs/screens/topic/a.png`,
    'a file straight under docs/evidence': `https://raw.githubusercontent.com/${HEAD_REPO}/${SHA_A}/docs/evidence/a.png`,
    'a nested path under the slug': `https://raw.githubusercontent.com/${HEAD_REPO}/${SHA_A}/docs/evidence/topic/sub/a.png`,
    'docs/evidence below another directory': `https://raw.githubusercontent.com/${HEAD_REPO}/${SHA_A}/src/docs/evidence/topic/a.png`,
    'an upper-case name': rawUrl(SHA_A, 'A.png'),
    'a percent-encoded name': rawUrl(SHA_A, 'a%20b.png'),
    'a name with a double dot': rawUrl(SHA_A, 'a..b.png'),
    'a dot-leading name': rawUrl(SHA_A, '.hidden.png'),
    'an unsupported extension': rawUrl(SHA_A, 'a.svg'),
    'a name with no extension': rawUrl(SHA_A, 'a'),
    'an upper-case slug': rawUrl(SHA_A, 'a.png', { slug: 'Topic' }),
    'a dot-dot slug': rawUrl(SHA_A, 'a.png', { slug: '..' }),
    'an over-long slug': rawUrl(SHA_A, 'a.png', { slug: 'a'.repeat(61) }),
    'a 39-hex ref': rawUrl('a'.repeat(39), 'a.png'),
    'a 41-hex ref': rawUrl('a'.repeat(41), 'a.png'),
    'a branch name instead of a SHA': rawUrl('main', 'a.png'),
    'a non-hex 40-char ref': rawUrl('g'.repeat(40), 'a.png'),
    'plain http': rawUrl(SHA_A, 'a.png').replace('https:', 'http:'),
    'a raw query other than ?raw=true': `${rawUrl(SHA_A, 'a.png')}?token=abc`,
    'a blob tree link': `https://github.com/${HEAD_REPO}/tree/${SHA_A}/docs/evidence/topic/a.png`,
  }

  for (const [label, url] of Object.entries(unmanaged)) {
    it(`ignores and counts ${label}`, () => {
      const run = runUrls(`![x](${url})\n`)

      expect(run.status).toBe(0)
      expect(listField(run.report, 'urls')).toEqual([])
      expect(run.report.ignored).toBe(1)
    })
  }

  it('counts every ignored URL and still lists the managed ones', () => {
    const body = [
      `![a](${rawUrl(SHA_A, 'a.png')})`,
      '[docs](https://example.com/docs)',
      `![b](${rawUrl(SHA_A, 'b.png', { repo: 'x/y' })})`,
      '<a href="https://github.com/octo/repo/pull/5">PR</a>',
      '',
    ].join('\n')

    const run = runUrls(body)

    expect(listField(run.report, 'urls')).toHaveLength(1)
    expect(run.report.ignored).toBe(3)
  })

  it('skips URLs in fences and comments, managed or not', () => {
    const body = [
      '```',
      rawUrl(SHA_A, 'a.png'),
      'https://example.com/x',
      '```',
      '<!--',
      rawUrl(SHA_B, 'b.png'),
      '-->',
      '',
    ].join('\n')

    const run = runUrls(body)

    expect(listField(run.report, 'urls')).toEqual([])
    expect(run.report.ignored).toBe(0)
  })

  it('reports the same URL twice when it appears twice', () => {
    const url = rawUrl(SHA_A, 'a.png')

    const run = runUrls(`![1](${url})\n![2](${url})\n`)

    expect(listField(run.report, 'urls')).toHaveLength(2)
  })

  it('returns empty lists for a body with no URLs', () => {
    const run = runUrls('')

    expect(run.status).toBe(0)
    expect(listField(run.report, 'urls')).toEqual([])
    expect(run.report.ignored).toBe(0)
  })

  it('exits 2 for a bad head repo or body', () => {
    for (const input of [
      {},
      { body: 'x' },
      { head_repo: HEAD_REPO },
      { body: 1, head_repo: HEAD_REPO },
      { body: 'x', head_repo: 'no-slash' },
      { body: 'x', head_repo: 'a/b/c' },
      { body: 'x', head_repo: 'a/ b' },
      { body: 'x', head_repo: '' },
    ]) {
      const raw = runHelper(['urls'], JSON.stringify(input))

      expect(raw.status).toBe(2)
      expect(parseReport(raw.stdout).operation).toBe('urls')
      expect(parseReport(raw.stdout).result).toBe('usage-error')
    }
  })

  it('keeps the body off stdout', () => {
    const run = runUrls(`${CANARY}\n![a](${rawUrl(SHA_A, 'a.png')})`)

    expect(run.status).toBe(0)
    expect(run.report.result).toBe('urls')
    expect(run.stdout).not.toContain(CANARY)
    expect(run.stderr).toBe('')
  })
})

// ── repin-rewrite ──────────────────────────────────────────────────────────

describe('repin-rewrite', () => {
  const loginPath = 'docs/evidence/topic/login.png'
  const dashPath = 'docs/evidence/topic/dash.png'
  const loginUrl = rawUrl(SHA_A, 'login.png')
  const dashUrl = blobUrl(SHA_A, 'dash.png')
  const body = `## Summary\n\nText.\n\n## Demo\n\n![login](${loginUrl})\n\nMy hand-edited caption — keep ${SHA_A.slice(0, 7)}.\n\n![dash](${dashUrl})\n\n## Testing\n`

  /** The index range over which two equal-length strings differ. */
  function diffSpan(left: string, right: string): [number, number] | null {
    let first = -1
    let last = -1
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) {
        first = first === -1 ? i : first
        last = i
      }
    }
    return first === -1 ? null : [first, last]
  }

  it('rewrites only the 40-hex segment of the mapped URL', () => {
    const run = runRepin(body, { [loginPath]: SHA_B })

    expect(run.status).toBe(0)
    expect(run.report.result).toBe('repinned')
    expect(run.report.action).toBe('rewritten')
    expect(run.report.rewritten).toBe(1)
    expect(run.report.unmapped_paths).toEqual([dashPath])
    const out = outText(run)
    expect(out).toBe(body.replace(loginUrl, rawUrl(SHA_B, 'login.png')))
    const span = diffSpan(body, out)
    expect(out.length).toBe(body.length)
    expect(span).not.toBeNull()
    if (span !== null) {
      expect(span[1] - span[0] + 1).toBeLessThanOrEqual(40)
    }
  })

  it('leaves a hand-edited caption, even one that mentions the old SHA', () => {
    const run = runRepin(body, { [loginPath]: SHA_B, [dashPath]: SHA_C })

    const out = outText(run)
    expect(out).toContain(`My hand-edited caption — keep ${SHA_A.slice(0, 7)}.`)
    expect(out).toContain(`![dash](${blobUrl(SHA_C, 'dash.png')})`)
    expect(run.report.rewritten).toBe(2)
    expect(run.report.unmapped_paths).toEqual([])
  })

  it('rewrites every embed of the same path', () => {
    const doubled = `${body}\n![again](${loginUrl})\n`

    const run = runRepin(doubled, { [loginPath]: SHA_C })

    expect(run.report.rewritten).toBe(2)
    expect(outText(run).includes(SHA_A)).toBe(true) // dash and the caption
    expect(outText(run).split(SHA_C)).toHaveLength(3)
  })

  it('reports unchanged and writes identical bytes when the pin is current', () => {
    const run = runRepin(body, { [loginPath]: SHA_A, [dashPath]: SHA_A })

    expect(run.status).toBe(0)
    expect(run.report.action).toBe('unchanged')
    expect(run.report.rewritten).toBe(0)
    expect(run.out?.equals(Buffer.from(body))).toBe(true)
  })

  it('reports unchanged for an empty pin map', () => {
    const run = runRepin(body, {})

    expect(run.report.action).toBe('unchanged')
    expect(run.report.unmapped_paths).toEqual([dashPath, loginPath])
    expect(run.out?.equals(Buffer.from(body))).toBe(true)
  })

  it('does not touch a URL for another repo or a path outside docs/evidence', () => {
    const other = rawUrl(SHA_A, 'login.png', { repo: 'someone/else' })
    const outside = `https://raw.githubusercontent.com/${HEAD_REPO}/${SHA_A}/docs/other/topic/login.png`
    const mixed = `${body}\n![o](${other})\n![p](${outside})\n`

    const run = runRepin(mixed, { [loginPath]: SHA_B })

    const out = outText(run)
    expect(out).toContain(other)
    expect(out).toContain(outside)
    expect(run.report.rewritten).toBe(1)
    expect(run.report.ignored).toBe(2)
  })

  it('does not rewrite a URL inside a fence or a comment', () => {
    const hidden = `\`\`\`\n${loginUrl}\n\`\`\`\n\n<!--\n${loginUrl}\n-->\n`
    const mixed = `${hidden}\n![l](${loginUrl})\n`

    const run = runRepin(mixed, { [loginPath]: SHA_B })

    expect(outText(run)).toBe(
      `${hidden}\n![l](${rawUrl(SHA_B, 'login.png')})\n`,
    )
    expect(run.report.rewritten).toBe(1)
  })

  it('keeps line endings and every other byte', () => {
    for (const [, eol] of Object.entries(EOLS)) {
      const crBody = withEol(body, eol)

      const run = runRepin(crBody, { [loginPath]: SHA_B })

      expect(outText(run)).toBe(
        crBody.replace(loginUrl, rawUrl(SHA_B, 'login.png')),
      )
    }
  })

  it('keeps the ?raw=true suffix of a blob URL', () => {
    const run = runRepin(`![d](${dashUrl})`, { [dashPath]: SHA_B })

    expect(outText(run)).toBe(`![d](${blobUrl(SHA_B, 'dash.png')})`)
  })

  it('writes only the named path and keeps the body off stdout', () => {
    const cwd = makeDir()
    const run = runRepin(
      `${CANARY}\n${body}`,
      { [loginPath]: SHA_B },
      HEAD_REPO,
      {
        cwd,
      },
    )

    expect(fs.readdirSync(cwd)).toEqual([])
    expect(fs.readdirSync(run.dir)).toEqual(['out.md'])
    expect(run.stdout).not.toContain(CANARY)
    expect(run.stdout).not.toContain('hand-edited')
    expect(run.stderr).toBe('')
  })

  it('exits 2 for pins that are not managed paths or 40 lower-case hex', () => {
    const bad: Record<string, unknown>[] = [
      { 'docs/other/topic/login.png': SHA_B },
      { 'docs/evidence/topic/sub/login.png': SHA_B },
      { 'docs/evidence/Topic/login.png': SHA_B },
      { [loginPath]: 'b'.repeat(39) },
      { [loginPath]: 'B'.repeat(40) },
      { [loginPath]: 'main' },
      { [loginPath]: 7 },
    ]
    for (const pins of bad) {
      const raw = runHelper(
        ['repin-rewrite'],
        JSON.stringify({
          body,
          head_repo: HEAD_REPO,
          pins,
          out_file: path.join(makeDir(), 'out.md'),
        }),
      )

      expect(raw.status).toBe(2)
      expect(parseReport(raw.stdout).operation).toBe('repin-rewrite')
      expect(parseReport(raw.stdout).result).toBe('usage-error')
    }
  })

  it('exits 2 for missing or mistyped fields and writes nothing', () => {
    const dir = makeDir()
    const outFile = path.join(dir, 'out.md')
    const good = {
      body,
      head_repo: HEAD_REPO,
      pins: { [loginPath]: SHA_B },
      out_file: outFile,
    }
    for (const key of Object.keys(good)) {
      const missing: Record<string, unknown> = { ...good }
      delete missing[key]
      const raw = runHelper(['repin-rewrite'], JSON.stringify(missing))
      expect(raw.status).toBe(2)
      expect(parseReport(raw.stdout).operation).toBe('repin-rewrite')
    }
    for (const pins of [[], 'x', null, 3]) {
      expect(
        runHelper(['repin-rewrite'], JSON.stringify({ ...good, pins })).status,
      ).toBe(2)
    }
    expect(fs.existsSync(outFile)).toBe(false)
  })
})

// ── shared CLI conventions ─────────────────────────────────────────────────

describe('helper CLI conventions across the new subcommands', () => {
  it('exits 2 for malformed JSON on every subcommand without echoing it', () => {
    for (const op of ['splice', 'extract', 'urls', 'repin-rewrite']) {
      const raw = runHelper([op], `{"body": "${CANARY}"`)

      expect(raw.status).toBe(2)
      expect(raw.stdout).not.toContain(CANARY)
      expect(raw.stderr).not.toContain(CANARY)
      expect(parseReport(raw.stdout).operation).toBe(op)
    }
  })

  it('still exits 2 for an unknown subcommand without echoing it', () => {
    const raw = runHelper([CANARY], '{}')

    expect(raw.status).toBe(2)
    expect(raw.stdout).not.toContain(CANARY)
  })

  it('answers with one JSON line and schema_version 1', () => {
    const run = runSplice('x\n', DEMO)

    expect(run.status).toBe(0)
    expect(run.stdout.endsWith('\n')).toBe(true)
    expect(run.stdout.trim().split('\n')).toHaveLength(1)
    expect(run.report.schema_version).toBe(1)
  })

  it('does not echo the paths of files it never wrote', () => {
    const run = runSplice(`x ${CANARY}\n`, DEMO)

    expect(run.status).toBe(0)
    expect(run.stdout).not.toContain(path.join(run.dir, 'demo.md'))
  })
})
