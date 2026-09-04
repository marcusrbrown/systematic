import type { ChildProcess } from 'node:child_process'

const DEFAULT_STOP_TIMEOUT_MS = 5_000

// Signal 0 sends nothing; it only probes whether a process group with this
// pgid currently has any live member. A pgid cannot be recycled while its
// group has members, so this is a safe leadership/ownership check -- and
// unlike `process.getpgid` (unimplemented on Bun, and only answers whether
// the literal leader pid is still alive, not whether its group survives it)
// it also stays correct once the original leader has exited but a
// detached grandchild keeps the group alive.
function processGroupIsPopulated(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined || !processGroupIsPopulated(pid)) {
    try {
      child.kill(signal)
    } catch {
      // Cleanup is best effort; the process may already be gone.
    }
    return
  }

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
  if (child.exitCode !== null || child.signalCode !== null) {
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
