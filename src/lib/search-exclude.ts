/**
 * Gitignore-style exclude patterns for external search sources: a validator
 * for one pattern and for a whole list, and a compiled matcher over
 * root-relative paths.
 *
 * This module imports nothing. The plugin bundle and the standalone
 * `systematic-search` bin both read source entries, so the pattern rules live
 * in one place that neither has to pull `config.ts` in to reach.
 *
 * Pattern rules:
 * - A pattern matches the path relative to a source root, `/`-separated and
 *   case-sensitive. One trailing `/` is ignored.
 * - A pattern with no `/` is name-only: it tests the entry's own name at any
 *   depth. A pattern with a `/` is anchored at the root and tested against the
 *   whole relative path.
 * - `*` matches any run of characters inside one segment (dotfiles included)
 *   and `?` matches one character. Neither crosses a `/`.
 * - `**` is special only as a whole segment. It matches zero or more segments,
 *   so `a/**` also matches `a`, and a pattern that starts with a `**` segment
 *   can match an entry at the root.
 * - Invalid: empty, a leading `/`, `!`, a leading `./`, an empty segment
 *   (`a//b`), a `.` or `..` segment, `[` or `]`, `\`, `**` inside a segment
 *   (`a**b`), more than 256 characters.
 *
 * The matcher tests one entry at a time and does not know whether the entry is
 * a file or a directory. A walk that tests every entry it reaches and does not
 * descend into a matched directory excludes the whole subtree that way.
 *
 * There is no regular expression and no recursion. A segment is matched with a
 * two-pointer scan that remembers one star position, and an anchored pattern
 * runs a dynamic program over pattern segments and path segments. A pattern is
 * at most 256 characters, so the cost grows linearly with the length of the
 * path. Validation reasons describe the broken rule and never repeat the
 * pattern text.
 */

/** The most patterns one source keeps; elements from this index on are dropped. */
export const MAX_EXCLUDE_PATTERNS = 64

/** The longest pattern accepted, in UTF-16 code units. */
export const MAX_EXCLUDE_PATTERN_LENGTH = 256

export type ExcludePatternCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** One element, or the over-limit tail, that a list validation dropped. */
export interface ExcludeIssue {
  readonly index: number
  readonly reason: string
}

export type ExcludeListValidation =
  | {
      readonly ok: true
      readonly patterns: readonly string[]
      readonly issues: readonly ExcludeIssue[]
    }
  | { readonly ok: false; readonly reason: string }

/** A validated pattern split into segments, with consecutive `**` collapsed. */
export interface CompiledExcludePattern {
  readonly segments: readonly string[]
  readonly nameOnly: boolean
}

/** Tests a root-relative path joined with `/`. */
export type ExcludeMatcher = (relativePath: string) => boolean

const REASON_NOT_A_STRING = 'not a string'
const REASON_NOT_AN_ARRAY = 'not an array'
const REASON_EMPTY = 'empty pattern'
const REASON_TOO_LONG = `longer than ${MAX_EXCLUDE_PATTERN_LENGTH} characters`
const REASON_BACKSLASH = 'backslash is not supported, use / between segments'
const REASON_NEGATION = 'negation with ! is not supported'
const REASON_LEADING_SLASH =
  'starts with /, patterns are relative to the source root'
const REASON_LEADING_DOT_SLASH = 'starts with ./, write the path without it'
const REASON_CHARACTER_CLASS = 'character classes with [ ] are not supported'
const REASON_EMPTY_SEGMENT = 'contains an empty path segment'
const REASON_DOT_SEGMENT = 'contains a . path segment'
const REASON_DOT_DOT_SEGMENT = 'contains a .. path segment'
const REASON_EMBEDDED_GLOBSTAR = '** must be a whole path segment'

const GLOBSTAR = '**'

type ParsedPattern =
  | { readonly ok: true; readonly compiled: CompiledExcludePattern }
  | { readonly ok: false; readonly reason: string }

function invalid(reason: string): ParsedPattern {
  return { ok: false, reason }
}

/** Whole-pattern rules, checked in order; the first that holds names the reason. */
const WHOLE_PATTERN_RULES: ReadonlyArray<
  readonly [(pattern: string) => boolean, string]
> = [
  [(pattern) => pattern.length === 0, REASON_EMPTY],
  [(pattern) => pattern.length > MAX_EXCLUDE_PATTERN_LENGTH, REASON_TOO_LONG],
  [(pattern) => pattern.includes('\\'), REASON_BACKSLASH],
  [(pattern) => pattern.startsWith('!'), REASON_NEGATION],
  [(pattern) => pattern.startsWith('/'), REASON_LEADING_SLASH],
  [(pattern) => pattern.startsWith('./'), REASON_LEADING_DOT_SLASH],
  [
    (pattern) => pattern.includes('[') || pattern.includes(']'),
    REASON_CHARACTER_CLASS,
  ],
]

/** The reason one pattern segment is invalid, or `undefined` when it is fine. */
function segmentProblem(segment: string): string | undefined {
  if (segment.length === 0) return REASON_EMPTY_SEGMENT
  if (segment === '.') return REASON_DOT_SEGMENT
  if (segment === '..') return REASON_DOT_DOT_SEGMENT
  if (segment !== GLOBSTAR && segment.includes(GLOBSTAR)) {
    return REASON_EMBEDDED_GLOBSTAR
  }
  return undefined
}

function parsePattern(pattern: unknown): ParsedPattern {
  if (typeof pattern !== 'string') return invalid(REASON_NOT_A_STRING)
  for (const [applies, reason] of WHOLE_PATTERN_RULES) {
    if (applies(pattern)) return invalid(reason)
  }

  const body = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
  const segments: string[] = []
  for (const segment of body.split('/')) {
    const problem = segmentProblem(segment)
    if (problem !== undefined) return invalid(problem)
    // Consecutive `**` match what one `**` matches.
    if (segment === GLOBSTAR && segments[segments.length - 1] === GLOBSTAR) {
      continue
    }
    segments.push(segment)
  }

  return {
    ok: true,
    compiled: { segments, nameOnly: !body.includes('/') },
  }
}

/** Checks one element. The reason names the broken rule, never the pattern. */
export function validateExcludePattern(pattern: unknown): ExcludePatternCheck {
  const parsed = parsePattern(pattern)
  return parsed.ok ? { ok: true } : { ok: false, reason: parsed.reason }
}

/**
 * Validates the `exclude` value of one source entry. A value that is not an
 * array drops the whole source (`ok: false`). Inside an array, an invalid
 * element is dropped alone and reported by index. Only the first
 * `MAX_EXCLUDE_PATTERNS` elements are inspected, an invalid one still holds its
 * index, and the rest are dropped with one issue at index
 * `MAX_EXCLUDE_PATTERNS` that states the count.
 */
export function validateExcludeList(value: unknown): ExcludeListValidation {
  if (!Array.isArray(value)) return { ok: false, reason: REASON_NOT_AN_ARRAY }

  const patterns: string[] = []
  const issues: ExcludeIssue[] = []
  const inspected = Math.min(value.length, MAX_EXCLUDE_PATTERNS)
  for (let index = 0; index < inspected; index++) {
    const element: unknown = value[index]
    const verdict = validateExcludePattern(element)
    if (verdict.ok && typeof element === 'string') {
      patterns.push(element)
    } else if (!verdict.ok) {
      issues.push({ index, reason: verdict.reason })
    }
  }
  if (value.length > MAX_EXCLUDE_PATTERNS) {
    const dropped = value.length - MAX_EXCLUDE_PATTERNS
    issues.push({
      index: MAX_EXCLUDE_PATTERNS,
      reason: `${dropped} ${dropped === 1 ? 'pattern' : 'patterns'} over the limit of ${MAX_EXCLUDE_PATTERNS}`,
    })
  }
  return { ok: true, patterns, issues }
}

/** Compiles one pattern; an invalid pattern gives `undefined`. */
export function compileExcludePattern(
  pattern: string,
): CompiledExcludePattern | undefined {
  const parsed = parsePattern(pattern)
  return parsed.ok ? parsed.compiled : undefined
}

/** Length in UTF-16 code units of the character that starts at `index`. */
function characterLength(text: string, index: number): number {
  const high = text.charCodeAt(index)
  if (high >= 0xd800 && high <= 0xdbff && index + 1 < text.length) {
    const low = text.charCodeAt(index + 1)
    if (low >= 0xdc00 && low <= 0xdfff) return 2
  }
  return 1
}

/**
 * Matches one path segment against one pattern segment of literals, `*` and
 * `?`. Two pointers and one remembered star position, no recursion.
 */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let starP = -1
  let starT = 0
  while (t < text.length) {
    const code = p < pattern.length ? pattern.charCodeAt(p) : -1
    if (code === 0x2a) {
      starP = p
      starT = t
      p++
    } else if (code === 0x3f) {
      p++
      t += characterLength(text, t)
    } else if (code !== -1 && code === text.charCodeAt(t)) {
      p++
      t++
    } else if (starP !== -1) {
      // Give the last star one more character and retry after it.
      starT += characterLength(text, starT)
      t = starT
      p = starP + 1
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern.charCodeAt(p) === 0x2a) p++
  return p === pattern.length
}

/**
 * Matches pattern segments against path segments. `reached[j]` says the first
 * `j` pattern segments match the path segments consumed so far; `**` consumes
 * zero or more.
 */
function matchAnchored(
  pattern: readonly string[],
  path: readonly string[],
): boolean {
  let reached: boolean[] = new Array<boolean>(pattern.length + 1).fill(false)
  reached[0] = true
  for (let j = 1; j <= pattern.length; j++) {
    reached[j] = pattern[j - 1] === GLOBSTAR && reached[j - 1] === true
  }
  for (const segment of path) {
    const next: boolean[] = new Array<boolean>(pattern.length + 1).fill(false)
    for (let j = 1; j <= pattern.length; j++) {
      const part = pattern[j - 1] ?? ''
      next[j] =
        part === GLOBSTAR
          ? next[j - 1] === true || reached[j] === true
          : reached[j - 1] === true && matchSegment(part, segment)
    }
    reached = next
  }
  return reached[pattern.length] === true
}

function matchesCompiled(
  compiled: CompiledExcludePattern,
  relativePath: string,
): boolean {
  if (compiled.nameOnly) {
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
    const part = compiled.segments[0] ?? ''
    // A lone `**` matches every name, as `*` does.
    return part === GLOBSTAR || matchSegment(part, name)
  }
  return matchAnchored(compiled.segments, relativePath.split('/'))
}

/**
 * Compiles a list of patterns into one matcher. A pattern that fails
 * validation is skipped; callers run `validateExcludeList` first, so skipping
 * only keeps a search from throwing. An empty list matches nothing.
 */
export function compileExcludePatterns(
  patterns: readonly string[],
): ExcludeMatcher {
  const compiled: CompiledExcludePattern[] = []
  for (const pattern of patterns) {
    const one = compileExcludePattern(pattern)
    if (one !== undefined) compiled.push(one)
  }
  if (compiled.length === 0) return () => false
  return (relativePath) => {
    if (relativePath.length === 0) return false
    return compiled.some((entry) => matchesCompiled(entry, relativePath))
  }
}
