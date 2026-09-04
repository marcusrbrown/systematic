import { describe, expect, it } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'

import { stopProcessGroup } from '../../scripts/lib/process-group.js'

function processGroupHasMembers(pgid: number): boolean {
  return (
    spawnSync('pgrep', ['-g', String(pgid)], { stdio: 'ignore' }).status === 0
  )
}

async function waitForEmptyProcessGroup(
  pgid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processGroupHasMembers(pgid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !processGroupHasMembers(pgid)
}

describe('process-group reaping', () => {
  it('terminates detached process groups including grandchildren', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 & sleep 30 & wait'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = child.pid
    if (pid === undefined)
      throw new Error('test child did not expose a process id')

    try {
      expect(processGroupHasMembers(pid)).toBe(true)
      await stopProcessGroup(child, 1_000)
      expect(await waitForEmptyProcessGroup(pid, 2_000)).toBe(true)
    } finally {
      await stopProcessGroup(child, 1_000)
    }
  })

  it('reaps grandchildren after the detached launcher has already exited', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 & exit 0'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = child.pid
    if (pid === undefined)
      throw new Error('test child did not expose a process id')

    await once(child, 'exit')
    try {
      await stopProcessGroup(child, 1_000)
      expect(await waitForEmptyProcessGroup(pid, 2_000)).toBe(true)
    } finally {
      await stopProcessGroup(child, 1_000)
    }
  })

  it('returns quickly when the direct child already died from a signal', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 & sleep 30 & wait'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = child.pid
    if (pid === undefined)
      throw new Error('test child did not expose a process id')

    child.kill('SIGTERM')
    await once(child, 'exit')
    expect(child.signalCode).not.toBeNull()

    try {
      const started = performance.now()
      await stopProcessGroup(child, 1_000)
      expect(performance.now() - started).toBeLessThan(200)
      expect(await waitForEmptyProcessGroup(pid, 2_000)).toBe(true)
    } finally {
      await stopProcessGroup(child, 1_000)
    }
  })

  it('stops a non-detached child via the direct-kill fallback without signalling an unrelated group', async () => {
    const child = spawn('sh', ['-c', 'sleep 30'], {
      stdio: 'ignore',
    })
    const pid = child.pid
    if (pid === undefined)
      throw new Error('test child did not expose a process id')

    await stopProcessGroup(child, 1_000)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('keeps a registry-style probe positive while the group is populated and negative once reaped', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 & exit 0'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = child.pid
    if (pid === undefined)
      throw new Error('test child did not expose a process id')

    await once(child, 'exit')
    try {
      expect(() => process.kill(-pid, 0)).not.toThrow()

      await stopProcessGroup(child, 1_000)
      await waitForEmptyProcessGroup(pid, 2_000)

      expect(() => process.kill(-pid, 0)).toThrow()
    } finally {
      await stopProcessGroup(child, 1_000)
    }
  })
})
