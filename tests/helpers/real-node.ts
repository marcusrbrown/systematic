import { spawnSync } from 'node:child_process'

/**
 * The path of a real Node binary, resolved once. `process.execPath` under
 * `bun test` is the Bun binary, so it must never launch a Node-only check.
 * Throws at import time when `node` is missing or turns out to be Bun, so a
 * packaging test cannot pass against the wrong runtime.
 */
function resolveRealNode(): string {
  const probe = spawnSync('node', ['-p', 'process.execPath'], {
    encoding: 'utf8',
  })
  if (probe.status !== 0 || !probe.stdout.trim()) {
    throw new Error(
      'fixture setup failed: `node -p process.execPath` did not resolve a Node binary',
    )
  }
  const bin = probe.stdout.trim()
  const check = spawnSync(bin, ['-p', "typeof Bun === 'undefined'"], {
    encoding: 'utf8',
  })
  if (check.status !== 0 || check.stdout.trim() !== 'true') {
    throw new Error(
      'resolved Node binary appears to be Bun, not a real Node runtime -- refusing to run Node checks against it',
    )
  }
  return bin
}

export const NODE_BIN = resolveRealNode()
