import type { ChildProcess } from 'node:child_process'

const DEFAULT_STOP_TIMEOUT_MS = 5_000

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return

  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Cleanup is best effort; the process may already be gone.
    }
  }
}

export async function stopProcessGroup(
  child: ChildProcess,
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  if (child.exitCode !== null) {
    signalProcessGroup(child, 'SIGKILL')
    return
  }

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve()
    }
    const timeout = setTimeout(() => {
      signalProcessGroup(child, 'SIGKILL')
      finish()
    }, timeoutMs)

    child.once('exit', finish)
    signalProcessGroup(child, 'SIGTERM')
  })
}
