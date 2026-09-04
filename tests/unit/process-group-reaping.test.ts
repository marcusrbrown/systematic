import { describe, expect, it } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'

import { stopProcessGroup } from '../integration/fixtures/process-group.js'

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
})
