import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { walkDir } from '../../src/lib/walk-dir.js'

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../skills')

interface SkillDoc {
  readonly file: string
  readonly text: string
}

interface FencedBlock {
  readonly file: string
  readonly startLine: number
  readonly body: string
}

function collectSkillMarkdown(): SkillDoc[] {
  return walkDir(SKILLS_DIR, {
    maxDepth: 20,
    filter: (entry) => !entry.isDirectory && entry.path.endsWith('.md'),
  }).map((entry) => ({
    file: path.relative(SKILLS_DIR, entry.path),
    text: fs.readFileSync(entry.path, 'utf8'),
  }))
}

function blocksIn(doc: SkillDoc): FencedBlock[] {
  const blocks: FencedBlock[] = []
  let startLine = 0
  let buffer: string[] | undefined

  for (const [index, line] of doc.text.split('\n').entries()) {
    if (!line.startsWith('```')) {
      buffer?.push(line)
      continue
    }
    if (buffer === undefined) {
      startLine = index + 1
      buffer = []
    } else {
      blocks.push({ file: doc.file, startLine, body: buffer.join('\n') })
      buffer = undefined
    }
  }
  return blocks
}

function linesMatching(pattern: RegExp): string[] {
  const hits: string[] = []
  for (const doc of collectSkillMarkdown()) {
    for (const [index, line] of doc.text.split('\n').entries()) {
      if (pattern.test(line))
        hits.push(`${doc.file}:${index + 1}: ${line.trim()}`)
    }
  }
  return hits
}

describe('bundled skill script invocation', () => {
  // A shell resolves a bare relative path against the agent's working directory,
  // which is the consumer's project -- never the directory the skill installed
  // into. `bash references/resolve-base.sh` failed everywhere, including in this
  // repository, because no `references/` exists at any project root.
  test('no skill invokes a bundled script through a bare relative path', () => {
    expect(
      linesMatching(
        /(?:^|\s)(?:bash|sh|node|python3?)\s+(?:references|scripts)\//,
      ),
    ).toEqual([])
  })

  // Shell state does not persist between separate Bash tool calls, and each
  // fenced block is copied and run on its own. A block that reads $SKILL_DIR
  // without setting it expands the variable to empty and rebuilds the same
  // broken path in a new shape: `/scripts/foo` instead of `scripts/foo`.
  test('every block reading SKILL_DIR also assigns it', () => {
    const offenders = collectSkillMarkdown()
      .flatMap(blocksIn)
      .filter(
        (b) =>
          /\$\{?SKILL_DIR\}?\//.test(b.body) && !b.body.includes('SKILL_DIR='),
      )
      .map((b) => `${b.file}:${b.startLine}`)
    expect(offenders).toEqual([])
  })

  // Some hosts flatten a fenced block into a single line, turning newlines into
  // spaces. Without a terminating `;` the assignment becomes the env-var-prefix
  // form `SKILL_DIR="..." bash "$SKILL_DIR/x"`, where the shell expands
  // $SKILL_DIR from the *outer* scope before the assignment takes effect, and
  // the path collapses to `/x`.
  test('every SKILL_DIR assignment terminates with a semicolon', () => {
    expect(linesMatching(/SKILL_DIR=(?!"[^"]*";)/)).toEqual([])
  })

  // The anchor is deliberately model-filled rather than ${CLAUDE_SKILL_DIR}:
  // that substitution is Claude-Code-only and expands to nothing on every other
  // harness, so a guarded call silently never fires off-Claude. Systematic ships
  // to three harnesses, so a Claude-only mechanism would be a silent skip on two.
  test('no skill depends on a harness-specific skill-directory variable', () => {
    expect(
      linesMatching(/\$\{?(?:CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT)\}?/),
    ).toEqual([])
  })
})
