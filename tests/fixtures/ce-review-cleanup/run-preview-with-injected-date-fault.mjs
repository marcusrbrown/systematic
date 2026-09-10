// Test-only fixture: verifies cleanup.mjs's runMain() error boundary against
// a real, deterministic exception. Not a generic framework and not part of
// the shipped package -- invoked directly by
// tests/unit/ce-review-cleanup-preview.test.ts via spawnSync with CLI args.
//
// Patches Date.prototype.toISOString to throw, then shapes process.argv so
// cleanup.mjs's own isDirectInvocation check is true before dynamically
// importing it -- runMain() then executes exactly as it would from a normal
// `node cleanup.mjs preview ...` invocation.

import { fileURLToPath } from 'node:url'

Date.prototype.toISOString = function toISOString() {
  throw new Error('injected-fault: verifies runMain() error boundary')
}

const cleanupScriptPath = fileURLToPath(
  new URL(
    '../../../skills/ce-review-cleanup/scripts/cleanup.mjs',
    import.meta.url,
  ),
)

process.argv = [process.argv[0], cleanupScriptPath, ...process.argv.slice(2)]

await import(cleanupScriptPath)
