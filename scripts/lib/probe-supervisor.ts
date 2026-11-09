import { spawn } from 'node:child_process'

import { stopProcessGroup } from './process-group.js'

/**
 * The exit code the supervisor uses when it had to stop the launcher for
 * running past its timeout. It follows the `timeout(1)` convention, so a
 * launcher that happens to exit 124 itself is also reported as a timeout;
 * either way the probe is `unavailable`.
 */
export const SUPERVISOR_TIMEOUT_EXIT_CODE = 124

/** Exit code when the launcher could not be started at all (as in a shell). */
const SPAWN_FAILURE_EXIT_CODE = 127

/** How long the launcher's group gets after SIGTERM before SIGKILL. */
const TERM_GRACE_MS = 2_000

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already empty.
  }
}

/**
 * Runs `command` in its own process group, forwards its stdout and stderr,
 * and enforces `timeoutMs` itself. On expiry it stops the whole group (SIGTERM,
 * then SIGKILL), so a launcher such as `bunx` cannot leave a descendant
 * writing into a shared cache after the probe has given up. When the launcher
 * exits on its own, anything it left in the group is killed too. Resolves to
 * the code to exit with, or the signal that ended the launcher.
 */
export async function superviseLauncher(
  timeoutMs: number,
  command: string,
  args: readonly string[],
): Promise<number | NodeJS.Signals> {
  const child = spawn(command, [...args], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  // The outer `spawnSync` backstop signals only this process, so take the
  // launcher's group down with it.
  const onTerminate = (signal: NodeJS.Signals): void => {
    killGroup(child.pid, 'SIGKILL')
    process.kill(process.pid, signal)
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, onTerminate)
  }

  return new Promise<number | NodeJS.Signals>((resolve) => {
    let settled = false
    let timedOut = false
    const settle = (outcome: number | NodeJS.Signals): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killGroup(child.pid, 'SIGKILL')
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      timedOut = true
      process.stderr.write(
        `[probe-supervisor] launcher timed out after ${timeoutMs}ms; stopping its process group\n`,
      )
      void stopProcessGroup(child, TERM_GRACE_MS).then(() => {
        settle(SUPERVISOR_TIMEOUT_EXIT_CODE)
      })
    }, timeoutMs)

    child.once('error', (error) => {
      process.stderr.write(`${String(error)}\n`)
      settle(SPAWN_FAILURE_EXIT_CODE)
    })
    child.once('exit', (code, signal) => {
      // A timeout is settled below, once the whole group has been stopped.
      if (timedOut) return
      settle(signal ?? code ?? 1)
    })
  })
}

async function main(argv: readonly string[]): Promise<void> {
  const [timeout, command, ...args] = argv
  const timeoutMs = Number(timeout)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || command === undefined) {
    process.stderr.write(
      'usage: probe-supervisor <timeoutMs> <command> [args...]\n',
    )
    process.exit(2)
  }
  const outcome = await superviseLauncher(timeoutMs, command, args)
  if (typeof outcome === 'number') process.exit(outcome)
  // Re-raise so the caller sees the launcher's own signal.
  process.kill(process.pid, outcome)
}

if (import.meta.main) await main(process.argv.slice(2))
