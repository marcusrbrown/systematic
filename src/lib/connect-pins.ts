/**
 * Dependency pins for `ce:connect`: the version a project pins an upstream at,
 * read from the project's own files.
 *
 * `readPinValue` reads one pin value live from a project's working tree. The
 * read is contained and bounded (`readContainedFile`: safe relative path, no
 * symlink, size cap), parsed as JSON or JSONC, and walked by a dotted key
 * path. The result is a plain string that passed `PIN_VALUE_PATTERN` or one
 * fixed failure code. A failure never carries file content, a key, a value or
 * a path, so a code is safe to show. The file is untrusted data: a value that
 * fails the charset is rejected, never cleaned up.
 *
 * Import rule: node builtins, `jsonc-parser` and sibling connect modules only.
 * Never zod, `config.ts` or `config-schema.ts`, because the `ce:connect`
 * helper bundles this module. Never throws.
 */

import { type ParseError, parse as parseJsonc } from 'jsonc-parser'
import { isPinKey } from './connect-config.js'
import { readContainedFile } from './connect-evidence.js'

// ── Charset ─────────────────────────────────────────────────────────────────

/**
 * The shape of a pin value, and so of the version a rendered hint states: one
 * leading letter or digit, then letters, digits, `.`, `_`, `+` and `-`, 64
 * characters at most. It is `TAG_NAME_PATTERN` without the `/`: a tag may be
 * `release/1.2`, but a pinned version names no path, and refusing the slash
 * keeps a value from reading as one. Reject, do not sanitize.
 */
export const PIN_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

// ── Reading a pin value ─────────────────────────────────────────────────────

/** Why a pin value could not be read. The only text a failure carries. */
export type PinFailureCode =
  | 'pin-file-missing'
  | 'pin-file-too-large'
  | 'pin-file-invalid'
  | 'pin-key-absent'
  | 'pin-value-invalid'

export type PinValueResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'failed'; readonly code: PinFailureCode }

function failed(code: PinFailureCode): PinValueResult {
  return { kind: 'failed', code }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The value at a dotted key path, or `undefined` when no own property chain
 * leads there. Each step needs a plain object and an own property, so an
 * array, a primitive, `null` and an inherited name (`constructor`, `toString`,
 * `__proto__`) all end the walk.
 */
function walkKey(root: unknown, key: string): unknown {
  let current = root
  for (const segment of key.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
      return undefined
    }
    current = current[segment]
  }
  return current
}

/**
 * Read the string at `key` in the JSON or JSONC file `file` under `root`.
 *
 * `root` must be a trusted real path. `file` is repo-relative and `key` is
 * dotted segments with no array index. The working tree is read as it is:
 * tracked status is not checked, so an untracked file works.
 *
 * - `pin-file-missing`: no such file, a directory, a symlink, a path outside
 *   the root, or a file that cannot be read.
 * - `pin-file-too-large`: over the read cap.
 * - `pin-file-invalid`: empty, malformed, or not UTF-8 JSONC.
 * - `pin-key-absent`: the key does not lead to an own property.
 * - `pin-value-invalid`: the value is not a string that passes
 *   `PIN_VALUE_PATTERN`.
 */
export function readPinValue(
  root: string,
  file: string,
  key: string,
): PinValueResult {
  const read = readContainedFile(root, file)
  if (read.kind === 'refused') {
    return failed(
      read.reason === 'too-large' ? 'pin-file-too-large' : 'pin-file-missing',
    )
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
  } catch {
    return failed('pin-file-invalid')
  }
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || parsed === undefined)
    return failed('pin-file-invalid')
  if (!isPinKey(key)) return failed('pin-key-absent')
  const value = walkKey(parsed, key)
  if (value === undefined) return failed('pin-key-absent')
  if (typeof value !== 'string' || !PIN_VALUE_PATTERN.test(value)) {
    return failed('pin-value-invalid')
  }
  return { kind: 'ok', value }
}
