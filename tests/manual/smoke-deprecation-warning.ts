#!/usr/bin/env bun

/**
 * Manual smoke test for the v2.19.0 skill-deprecation warning surface.
 *
 * Run via: bun tests/manual/smoke-deprecation-warning.ts
 *
 * Proves the full integration path: load built plugin -> initialize ->
 * register systematic_skill tool -> invoke execute() for a deprecated
 * skill -> capture console.warn -> assert message format + dedup.
 *
 * Uses the built dist/index.js (not the .ts source) so this is genuine
 * end-to-end verification of what ships to npm.
 *
 * No external dependencies; no OpenCode TUI; no persistent session.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

// Import the BUILT plugin, not the source.
const builtPluginPath = path.join(projectRoot, 'dist', 'index.js')
const pluginModule = (await import(builtPluginPath)) as {
  default: (input: unknown) => Promise<{ tool?: Record<string, unknown> }>
}

// Minimal PluginInput shape — the plugin only reads the client field for
// availability checks, which we can skip by passing undefined and letting
// the source-default resolution fall through to the unknown bucket.
const pluginInput = {
  app: {
    path: {
      cwd: projectRoot,
      root: projectRoot,
      data: projectRoot,
      state: projectRoot,
      config: projectRoot,
    },
  },
  client: undefined,
  $: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
  directory: projectRoot,
}

const hooks = await pluginModule.default(pluginInput)
if (!hooks.tool || typeof hooks.tool !== 'object') {
  throw new Error('Plugin did not register a tool surface')
}

const toolMap = hooks.tool as Record<
  string,
  { execute: (args: unknown, context: unknown) => Promise<string> }
>
const skillTool = toolMap.systematic_skill
if (!skillTool) {
  throw new Error('Plugin did not register systematic_skill tool')
}

// Capture console.warn calls.
const warnings: string[] = []
const originalWarn = console.warn
console.warn = (...args: unknown[]) => {
  warnings.push(args.map((a) => String(a)).join(' '))
}

// Minimal ToolContext shape — execute() calls context.ask() and context.metadata().
const mockContext = {
  ask: async () => undefined,
  metadata: () => undefined,
  sessionID: 'smoke',
  messageID: 'smoke',
  agent: 'smoke',
  abort: new AbortController().signal,
}

console.log('=== Smoke test: skill deprecation warning ===')
console.log('Built plugin loaded from:', builtPluginPath)
console.log('Tool registered: systematic_skill')
console.log('')

// Invoke 1: orchestrating-swarms (should warn — has replacement + reason).
console.log('--- Invoke 1: orchestrating-swarms ---')
await skillTool.execute({ name: 'orchestrating-swarms' }, mockContext)
console.log(`captured warnings so far: ${warnings.length}`)
console.log(`last warning: ${warnings[warnings.length - 1] ?? '(none)'}`)
console.log('')

// Invoke 2: orchestrating-swarms again (should NOT warn — dedup).
console.log('--- Invoke 2: orchestrating-swarms (dedup test) ---')
await skillTool.execute({ name: 'orchestrating-swarms' }, mockContext)
console.log(`captured warnings so far: ${warnings.length}`)
console.log('expected: still 1 (dedup blocks second emit)')
console.log('')

// Invoke 3: claude-permissions-optimizer (should warn — no replacement).
console.log('--- Invoke 3: claude-permissions-optimizer ---')
await skillTool.execute({ name: 'claude-permissions-optimizer' }, mockContext)
console.log(`captured warnings so far: ${warnings.length}`)
console.log(`last warning: ${warnings[warnings.length - 1] ?? '(none)'}`)
console.log('')

// Invoke 4: setup (should NOT warn — not deprecated).
console.log('--- Invoke 4: setup (non-deprecated control) ---')
await skillTool.execute({ name: 'setup' }, mockContext)
console.log(`captured warnings so far: ${warnings.length}`)
console.log('expected: still 2 (non-deprecated skill emits nothing)')
console.log('')

// Restore console.warn.
console.warn = originalWarn

// Assertions.
const errors: string[] = []
if (warnings.length !== 2) {
  errors.push(`Expected 2 total warnings; got ${warnings.length}`)
}
if (!warnings[0]?.includes('orchestrating-swarms')) {
  errors.push(`Warning 1 missing skill name: ${warnings[0]}`)
}
if (!warnings[0]?.includes('Replacement: orchestrating-subagents')) {
  errors.push(`Warning 1 missing Replacement clause: ${warnings[0]}`)
}
if (!warnings[0]?.includes('Reason:')) {
  errors.push(`Warning 1 missing Reason clause: ${warnings[0]}`)
}
if (!warnings[1]?.includes('claude-permissions-optimizer')) {
  errors.push(`Warning 2 missing skill name: ${warnings[1]}`)
}
if (warnings[1]?.includes('Replacement:')) {
  errors.push(
    `Warning 2 unexpectedly includes Replacement clause: ${warnings[1]}`,
  )
}
if (!warnings[1]?.includes('Reason:')) {
  errors.push(`Warning 2 missing Reason clause: ${warnings[1]}`)
}

console.log('=== Captured warnings (full text) ===')
for (const [i, w] of warnings.entries()) {
  console.log(`[${i + 1}] ${w}`)
}
console.log('')

if (errors.length > 0) {
  console.log('=== FAIL ===')
  for (const e of errors) {
    console.log(`  ${e}`)
  }
  process.exit(1)
} else {
  console.log('=== PASS ===')
  console.log('  - orchestrating-swarms warns with Replacement + Reason')
  console.log(
    '  - claude-permissions-optimizer warns with Reason only (no Replacement)',
  )
  console.log(
    '  - dedup works: second invocation of same skill emits no warning',
  )
  console.log('  - non-deprecated skill (setup) emits no warning')
  process.exit(0)
}
