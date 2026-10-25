import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Key terms only. These pin the safety and routing rules an agent must keep
// reading from the skill, not its wording.

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const SKILL = read('skills/git-worktree/SKILL.md')
const SCRIPT = path.join(
  ROOT,
  'skills/git-worktree/scripts/worktree-manager.sh',
)

function fencedBlocks(text: string): string[] {
  const blocks: string[] = []
  let buffer: string[] | undefined
  for (const line of text.split('\n')) {
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

describe('git-worktree SKILL.md', () => {
  test('keeps its name and a trigger-only description', () => {
    expect(SKILL).toMatch(/^name: git-worktree$/m)
    expect(SKILL).toMatch(/^description: Use when /m)
  })

  test('a named location or tool wins, and the project instructions are read first', () => {
    expect(SKILL).toMatch(/named location or tool wins/i)
    expect(SKILL).toContain('AGENTS.md')
  })

  test('raw git worktree add is banned except with the user approval', () => {
    expect(SKILL).toMatch(/never use raw `git worktree add`/i)
    expect(SKILL).toMatch(
      /raw `git worktree add` only with the user's approval/,
    )
  })

  test('never forces a removal or deletes a worktree by hand', () => {
    expect(SKILL).toMatch(/never[^\n]*`--force`[^\n]*`rm -rf`/i)
  })

  test('removal needs a confirmation that deleting ignored files is accepted, and "nuke them all" does not waive it', () => {
    expect(SKILL).toMatch(/deletes a worktree's ignored files/)
    expect(SKILL).toContain('ignored=')
    expect(SKILL).toMatch(/nuke them all/)
    expect(SKILL).toMatch(/does not waive/)
  })

  test('stops after the report when no user is reachable', () => {
    expect(SKILL).toMatch(/subagent or headless[^\n]*stop here/)
  })

  test('never assumes main for an unresolved base', () => {
    expect(SKILL).toMatch(/`base-unresolved`[^\n]*never assume `main`/i)
  })

  test('every block that calls the script anchors it with SKILL_DIR', () => {
    const calling = fencedBlocks(SKILL).filter((block) =>
      block.includes('worktree-manager.sh'),
    )
    expect(calling.length).toBeGreaterThan(0)
    for (const block of calling) {
      expect(block).toMatch(/SKILL_DIR="[^"]*";/)
      expect(block).toContain('"$SKILL_DIR/scripts/worktree-manager.sh"')
    }
  })

  test('documents every command and flag the script help lists', () => {
    const help = spawnSync('bash', [SCRIPT, 'help'], { encoding: 'utf8' })
    expect(help.status).toBe(0)
    for (const token of [
      'create',
      'list',
      'switch',
      'copy-env',
      'cleanup',
      '--base',
      '--remove',
    ]) {
      expect(help.stdout).toContain(token)
      expect(SKILL).toContain(token)
    }
  })
})

describe('worktree pointers in other skills', () => {
  test.each([
    'skills/ce-review/SKILL.md',
    'skills/orchestrating-subagents/SKILL.md',
    'skills/git-clean-gone-branches/SKILL.md',
  ])('%s points at the git-worktree skill and its location', (file) => {
    const text = read(file)
    expect(text).toContain('`git-worktree` skill')
    expect(text).toContain('.worktrees/<branch>')
  })

  test('git-clean-gone-branches never forces a worktree removal', () => {
    expect(read('skills/git-clean-gone-branches/SKILL.md')).not.toContain(
      '--force',
    )
  })
})
