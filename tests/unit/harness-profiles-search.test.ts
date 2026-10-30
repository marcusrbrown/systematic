import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const REFERENCES = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'skills/using-systematic/references',
)

function readProfile(name: string): string {
  return fs.readFileSync(path.join(REFERENCES, `${name}-profile.md`), 'utf8')
}

function capabilityRow(profile: string, capability: string): string {
  const row = profile
    .split('\n')
    .find((line) => line.startsWith(`| ${capability} |`))
  if (row === undefined) throw new Error(`no ${capability} row`)
  return row
}

describe('harness profiles list durable-output search', () => {
  it.each(['opencode', 'opencode-v2', 'pi'])(
    '%s names the systematic_search tool and a grep fallback',
    (name) => {
      const row = capabilityRow(readProfile(name), 'Durable-output search')
      expect(row).toContain('`systematic_search`')
      expect(row).toContain('docs/solutions/')
      expect(row).toContain('Grep `docs/solutions/`')
    },
  )

  it('pi says the built-in delegates get the tool', () => {
    expect(capabilityRow(readProfile('pi'), 'Durable-output search')).toContain(
      'delegates included',
    )
  })

  it('claude-code names the bin and its probe, and still ships no systematic_skill tool', () => {
    const profile = readProfile('claude-code')
    const search = capabilityRow(profile, 'Durable-output search')
    expect(search).toContain('`systematic-search`')
    expect(search).toContain('command -v systematic-search')
    expect(search).not.toContain('systematic_search')
    expect(capabilityRow(profile, 'Skill loading')).toContain(
      'Systematic ships no `systematic_skill` tool on Claude Code',
    )
  })
})
