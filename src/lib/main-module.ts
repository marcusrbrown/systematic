/**
 * The direct-execution guard shared by `src/cli.ts`, `src/claude-code-validator-bin.ts`
 * and the `systematic-search` bin.
 *
 * It replaces `import.meta.main`, which Node only gained in 24.2. A module that
 * runs under Node 20 or 22 would see `undefined` and never self-execute. The
 * guard compares the realpath of `argv[1]` with the realpath of the module, so
 * it holds when the file is reached through a symlink (the npm `.bin` link, a
 * macOS `/var` to `/private/var` temp path) or a relative path.
 *
 * Fail-closed: when either side is missing or cannot be resolved the answer is
 * `false`, so importing the module for tests or tooling runs nothing.
 *
 * The caller passes its own `import.meta.url`. This module cannot read it: in a
 * bundle with code splitting this file may live in a shared chunk, and its URL
 * would then name the chunk and never the entry.
 *
 * `src/ce-review-validator.ts` keeps its own copy on purpose. It feeds a
 * committed bundle, and keeping it self-contained keeps that bundle's digest
 * independent of this file.
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

function resolveRealPath(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  try {
    return fs.realpathSync(value)
  } catch {
    return undefined
  }
}

function moduleFilePath(moduleUrl: string): string | undefined {
  try {
    return fileURLToPath(moduleUrl)
  } catch {
    return undefined
  }
}

/**
 * Whether the module at `moduleUrl` is the process entry point.
 *
 * @param moduleUrl The caller's `import.meta.url`.
 * @param argv The process argument vector. Defaults to `process.argv`; the
 * entry script is `argv[1]`. A vector with no `argv[1]` (a REPL, `node -e`)
 * is never a main module.
 */
export function isMainModule(
  moduleUrl: string,
  argv: readonly string[] = process.argv,
): boolean {
  const entryPath = resolveRealPath(argv[1])
  const modulePath = resolveRealPath(moduleFilePath(moduleUrl))
  return (
    entryPath !== undefined &&
    modulePath !== undefined &&
    entryPath === modulePath
  )
}
