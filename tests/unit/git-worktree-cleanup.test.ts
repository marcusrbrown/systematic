import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  cleanupTempDirs,
  create,
  createRepo,
  git,
  rows,
  run,
} from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

function stateOf(stdout: string, name: string): Record<string, string> {
  return rows(stdout).find((row) => row.name === name) ?? {}
}

describe('cleanup report', () => {
  it('reports one line per worktree and changes nothing', () => {
    const repo = createRepo({ files: { '.gitignore': '.env*\n' } })
    fs.writeFileSync(path.join(repo.work, '.env'), 'secret\n')
    const clean = create(repo.work, 'feat/clean')
    const dirty = create(repo.work, 'feat/dirty')
    fs.writeFileSync(path.join(dirty, 'README.md'), 'edited\n')
    fs.writeFileSync(path.join(dirty, 'new.txt'), 'new\n')

    const result = run(['cleanup'], { cwd: repo.work })

    expect(result.status).toBe(0)
    expect(rows(result.stdout)).toHaveLength(2)
    expect(stateOf(result.stdout, 'feat/clean')).toMatchObject({
      path: clean,
      branch: 'feat/clean',
      state: 'clean',
      modified: '0',
      untracked: '0',
      ignored: '1',
    })
    expect(stateOf(result.stdout, 'feat/dirty')).toMatchObject({
      state: 'dirty',
      modified: '1',
      untracked: '1',
    })
    expect(fs.existsSync(clean)).toBe(true)
    expect(fs.existsSync(dirty)).toBe(true)
  })

  it('reports prunable when the directory is gone', () => {
    const repo = createRepo()
    const wt = create(repo.work, 'feat/gone')
    fs.rmSync(wt, { recursive: true })

    const result = run(['cleanup'], { cwd: repo.work })

    expect(stateOf(result.stdout, 'feat/gone').state).toBe('prunable')
  })
})

describe('cleanup --remove', () => {
  it('removes only the named clean worktrees and never deletes branches', () => {
    const repo = createRepo()
    const a = create(repo.work, 'feat/a')
    const b = create(repo.work, 'feat/b')
    const result = run(['cleanup', '--remove', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(0)
    expect(rows(result.stdout)[0]).toMatchObject({
      result: 'removed',
      name: 'feat/a',
      path: a,
    })
    expect(fs.existsSync(a)).toBe(false)
    expect(fs.existsSync(b)).toBe(true)
    expect(git(repo.work, ['branch', '--list', 'feat/a'])).toContain('feat/a')
    expect(fs.existsSync(path.join(repo.work, '.worktrees'))).toBe(true)
  })

  it('removes a clean worktree that holds ignored files', () => {
    const repo = createRepo({ files: { '.gitignore': 'node_modules\n' } })
    const wt = create(repo.work, 'feat/a')
    fs.mkdirSync(path.join(wt, 'node_modules'))
    fs.writeFileSync(path.join(wt, 'node_modules/x.js'), 'x\n')

    expect(
      run(['cleanup', '--remove', 'feat/a'], { cwd: repo.work }).status,
    ).toBe(0)
    expect(fs.existsSync(wt)).toBe(false)
  })

  it('refuses a dirty worktree with exit 3 and a reason, and removes the clean one', () => {
    const repo = createRepo()
    const dirty = create(repo.work, 'feat/dirty')
    const clean = create(repo.work, 'feat/clean')
    fs.writeFileSync(path.join(dirty, 'new.txt'), 'new\n')

    const result = run(['cleanup', '--remove', 'feat/dirty', 'feat/clean'], {
      cwd: repo.work,
    })

    expect(result.status).toBe(3)
    expect(rows(result.stdout)).toEqual([
      expect.objectContaining({
        result: 'refused',
        name: 'feat/dirty',
        state: 'dirty',
        reason: expect.any(String),
      }),
      expect.objectContaining({ result: 'removed', name: 'feat/clean' }),
    ])
    expect(fs.existsSync(dirty)).toBe(true)
    expect(fs.existsSync(clean)).toBe(false)
  })

  it('refuses the current worktree', () => {
    const repo = createRepo()
    const wt = create(repo.work, 'feat/a')
    const result = run(['cleanup', '--remove', 'feat/a'], { cwd: wt })

    expect(result.status).toBe(3)
    expect(rows(result.stdout)[0]).toMatchObject({
      result: 'refused',
      state: 'current',
    })
    expect(fs.existsSync(wt)).toBe(true)
  })

  it('refuses a locked worktree', () => {
    const repo = createRepo()
    const wt = create(repo.work, 'feat/a')
    git(repo.work, ['worktree', 'lock', wt])
    const result = run(['cleanup', '--remove', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(3)
    expect(rows(result.stdout)[0]).toMatchObject({
      result: 'refused',
      state: 'locked',
    })
    expect(fs.existsSync(wt)).toBe(true)
  })

  it('refuses a detached worktree', () => {
    const repo = createRepo()
    create(repo.work, 'feat/a')
    const wt = path.join(repo.work, '.worktrees/detached')
    git(repo.work, ['worktree', 'add', '-q', '--detach', wt, 'main'])
    const result = run(['cleanup', '--remove', 'detached'], { cwd: repo.work })

    expect(result.status).toBe(3)
    expect(rows(result.stdout)[0]).toMatchObject({
      result: 'refused',
      state: 'detached',
    })
    expect(fs.existsSync(wt)).toBe(true)
  })

  it('refuses a worktree that contains another worktree', () => {
    const repo = createRepo()
    const outer = create(repo.work, 'outer')
    const inner = path.join(outer, 'inner')
    git(repo.work, ['worktree', 'add', '-q', '-b', 'inner', inner, 'main'])
    const result = run(['cleanup', '--remove', 'outer'], { cwd: repo.work })

    expect(result.status).toBe(3)
    expect(rows(result.stdout)[0]).toMatchObject({
      result: 'refused',
      state: 'contains-worktree',
    })
    expect(fs.existsSync(inner)).toBe(true)
  })

  it('refuses a prunable worktree', () => {
    const repo = createRepo()
    const wt = create(repo.work, 'feat/a')
    fs.rmSync(wt, { recursive: true })
    const result = run(['cleanup', '--remove', 'feat/a'], { cwd: repo.work })

    expect(result.status).toBe(3)
    expect(rows(result.stdout)[0]).toMatchObject({
      result: 'refused',
      state: 'prunable',
    })
  })

  it('exits 2 for an unknown name and removes nothing', () => {
    const repo = createRepo()
    const wt = create(repo.work, 'feat/a')
    const result = run(['cleanup', '--remove', 'feat/a', 'nope'], {
      cwd: repo.work,
    })

    expect(result.status).toBe(2)
    expect(fs.existsSync(wt)).toBe(true)
  })

  it('exits 2 when --remove names nothing', () => {
    const repo = createRepo()

    expect(run(['cleanup', '--remove'], { cwd: repo.work }).status).toBe(2)
  })
})
