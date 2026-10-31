import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from '../../src/lib/frontmatter.js'

// A plan that fails to parse is invisible to search. These tests pin the one
// rule that keeps new plans parseable: the title is written as a quoted string.

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const SKILL = read('skills/ce-plan/SKILL.md')
const SECTIONS = read('skills/ce-plan/references/plan-sections.md')

function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  if (start === -1) throw new Error(`heading not found: ${heading}`)
  const rest = text.slice(start + heading.length)
  const next = rest.search(/^#{1,4} /m)
  return next === -1 ? rest : rest.slice(0, next)
}

function templateFrontmatter(): string {
  const body = section(SKILL, '#### 4.2 Core Plan Template')
  const match = body.match(/```markdown\n(---\n[\s\S]*?\n---)\n/)
  if (!match?.[1]) throw new Error('Core Plan Template frontmatter not found')
  return match[1]
}

describe('ce-plan template quotes the title', () => {
  test('the Core Plan Template title value begins with a double quote', () => {
    const titleLine = templateFrontmatter()
      .split('\n')
      .find((line) => line.startsWith('title:'))

    expect(titleLine).toBeDefined()
    expect(titleLine?.slice('title:'.length).trim().startsWith('"')).toBe(true)
  })

  test('a conventional-commit title substituted into the template parses back unchanged', () => {
    const filled =
      `${templateFrontmatter().replace('[Plan Title]', 'feat: Add x')}\n`
        .replace('[feat|fix|refactor]', 'feat')
        .replace('YYYY-MM-DD', '2026-01-01')

    const parsed = parseFrontmatter(filled)

    expect(parsed.parseError).toBe(false)
    expect(parsed.data.title).toBe('feat: Add x')
  })

  test('Phase 3.1 tells the planner to quote the title', () => {
    const phase = section(SKILL, '#### 3.1 Title and File Naming')

    expect(phase).toMatch(/quote the title/i)
  })

  test('the frontmatter reference describes the title as quoted', () => {
    const bullet = section(SECTIONS, '- **`title`**').split('\n- **')[0] ?? ''

    expect(bullet).toMatch(/quoted|quote it/i)
  })
})
