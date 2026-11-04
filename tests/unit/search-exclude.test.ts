import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  compileExcludePattern,
  compileExcludePatterns,
  MAX_EXCLUDE_PATTERN_LENGTH,
  MAX_EXCLUDE_PATTERNS,
  validateExcludeList,
  validateExcludePattern,
} from '../../src/lib/search-exclude.js'

/** Compile one pattern and test it against root-relative paths. */
function matches(pattern: string, path: string): boolean {
  return compileExcludePatterns([pattern])(path)
}

function invalidReason(pattern: unknown): string {
  const verdict = validateExcludePattern(pattern)
  if (verdict.ok) {
    throw new Error(`expected an invalid pattern, got ok: ${String(pattern)}`)
  }
  return verdict.reason
}

describe('constants', () => {
  it('pins the documented limits', () => {
    expect(MAX_EXCLUDE_PATTERNS).toBe(64)
    expect(MAX_EXCLUDE_PATTERN_LENGTH).toBe(256)
  })
})

describe('name-only patterns (no slash)', () => {
  it('matches a file name at any depth and nothing longer', () => {
    expect(matches('log.md', 'log.md')).toBe(true)
    expect(matches('log.md', 'a/log.md')).toBe(true)
    expect(matches('log.md', 'a/b/c/log.md')).toBe(true)
    expect(matches('log.md', 'log.md.bak')).toBe(false)
    expect(matches('log.md', 'a/log.md.bak')).toBe(false)
    expect(matches('log.md', 'xlog.md')).toBe(false)
  })

  it('matches a directory name at depth 0 and depth 3', () => {
    expect(matches('.stryker-tmp', '.stryker-tmp')).toBe(true)
    expect(matches('.stryker-tmp', 'a/b/c/.stryker-tmp')).toBe(true)
    expect(matches('.stryker-tmp', 'stryker-tmp')).toBe(false)
  })

  it('tests the entry name only, never an ancestor segment', () => {
    expect(matches('drafts', 'drafts/a.md')).toBe(false)
    expect(matches('drafts', 'notes/drafts')).toBe(true)
  })

  it('is case-sensitive', () => {
    expect(matches('README.md', 'README.md')).toBe(true)
    expect(matches('README.md', 'readme.md')).toBe(false)
  })

  it('lets * match dotfiles and runs within a name', () => {
    expect(matches('*', '.hidden')).toBe(true)
    expect(matches('*.md', '.hidden.md')).toBe(true)
    expect(matches('legacy-*', 'nodes/legacy-1.json')).toBe(true)
    expect(matches('*.md', 'a/b.txt')).toBe(false)
  })

  it('lets ? match exactly one character', () => {
    expect(matches('a?c', 'abc')).toBe(true)
    expect(matches('a?c', 'ac')).toBe(false)
    expect(matches('a?c', 'abbc')).toBe(false)
    expect(matches('?', 'x/y')).toBe(true)
  })

  it('counts a character outside the BMP as one for ?', () => {
    expect(matches('a?c', 'a\u{1F600}c')).toBe(true)
    expect(matches('a??c', 'a\u{1F600}c')).toBe(false)
    expect(matches('a*c', 'a\u{1F600}c')).toBe(true)
  })

  it('never lets ? or * cross a slash', () => {
    // A name-only pattern sees one segment, so a slash can never be consumed.
    expect(matches('a?b', 'a/b')).toBe(false)
    expect(matches('a*b', 'a/b')).toBe(false)
    expect(matches('drafts/a?b', 'drafts/a/b')).toBe(false)
    expect(matches('drafts/a*b', 'drafts/a/b')).toBe(false)
  })

  it('gives a trailing slash the same result as none', () => {
    for (const path of ['log.md', 'a/log.md', 'log.md.bak', 'x/y']) {
      expect(matches('log.md/', path)).toBe(matches('log.md', path))
    }
    for (const path of ['drafts/a.md', 'notes/drafts/a.md', 'drafts/x/a.md']) {
      expect(matches('drafts/*.md/', path)).toBe(matches('drafts/*.md', path))
    }
  })

  it('treats a lone ** as matching every name', () => {
    expect(validateExcludePattern('**')).toEqual({ ok: true })
    expect(matches('**', 'a')).toBe(true)
    expect(matches('**', 'a/b/c')).toBe(true)
    expect(matches('**', '.hidden')).toBe(true)
  })

  it('never matches an empty path', () => {
    expect(matches('*', '')).toBe(false)
    expect(matches('**', '')).toBe(false)
    expect(matches('a/**', '')).toBe(false)
  })
})

describe('anchored patterns (with a slash)', () => {
  it('anchors a path pattern at the root', () => {
    expect(matches('drafts/*.md', 'drafts/a.md')).toBe(true)
    expect(matches('drafts/*.md', 'notes/drafts/a.md')).toBe(false)
    expect(matches('drafts/*.md', 'drafts/x/a.md')).toBe(false)
    expect(matches('drafts/*.md', 'drafts/a.txt')).toBe(false)
  })

  it('matches a single deep path exactly', () => {
    expect(matches('a/b/c.md', 'a/b/c.md')).toBe(true)
    expect(matches('a/b/c.md', 'a/b')).toBe(false)
    expect(matches('a/b/c.md', 'a/b/c.md/d')).toBe(false)
    expect(matches('a/b/c.md', 'x/a/b/c.md')).toBe(false)
  })

  it('matches zero or more segments for an inner **', () => {
    expect(matches('a/**/b', 'a/b')).toBe(true)
    expect(matches('a/**/b', 'a/x/b')).toBe(true)
    expect(matches('a/**/b', 'a/x/y/b')).toBe(true)
    expect(matches('a/**/b', 'b')).toBe(false)
    expect(matches('a/**/b', 'x/a/b')).toBe(false)
    expect(matches('a/**/b', 'a/x')).toBe(false)
  })

  it('matches a root entry for a leading **', () => {
    expect(matches('**/b', 'b')).toBe(true)
    expect(matches('**/b', 'x/b')).toBe(true)
    expect(matches('**/b', 'x/y/b')).toBe(true)
    expect(matches('**/b', 'b/x')).toBe(false)
    expect(matches('**/b', 'xb')).toBe(false)
  })

  it('matches the directory itself and its contents for a trailing **', () => {
    expect(matches('a/**', 'a')).toBe(true)
    expect(matches('a/**', 'a/x')).toBe(true)
    expect(matches('a/**', 'a/x/y')).toBe(true)
    expect(matches('a/**', 'b/x')).toBe(false)
    expect(matches('a/**', 'ab')).toBe(false)
  })

  it('combines ** with wildcards inside other segments', () => {
    expect(matches('docs/**/*.md', 'docs/a.md')).toBe(true)
    expect(matches('docs/**/*.md', 'docs/x/y/a.md')).toBe(true)
    expect(matches('docs/**/*.md', 'docs/x/a.txt')).toBe(false)
    expect(matches('docs/**/*.md', 'other/a.md')).toBe(false)
  })

  it('matches nodes/ and edges/ entries by their folder-relative path', () => {
    expect(matches('nodes/legacy-*.json', 'nodes/legacy-1.json')).toBe(true)
    expect(matches('nodes/legacy-*.json', 'edges/legacy-1.json')).toBe(false)
    expect(matches('edges/*', 'edges/e1.json')).toBe(true)
  })

  it('collapses a run of ** into one segment', () => {
    const collapsed = compileExcludePattern('a/**/**/**/b')
    const single = compileExcludePattern('a/**/b')
    expect(collapsed).toBeDefined()
    expect(collapsed).toEqual(single)
    expect(collapsed?.segments).toEqual(['a', '**', 'b'])
    expect(collapsed?.nameOnly).toBe(false)
    for (const path of ['a/b', 'a/x/b', 'a/x/y/b', 'b', 'x/a/b', 'a/x']) {
      expect(matches('a/**/**/**/b', path)).toBe(matches('a/**/b', path))
    }
  })

  it('records whether a pattern is name-only after stripping a trailing slash', () => {
    expect(compileExcludePattern('log.md')?.nameOnly).toBe(true)
    expect(compileExcludePattern('log.md/')?.nameOnly).toBe(true)
    expect(compileExcludePattern('a/b')?.nameOnly).toBe(false)
    expect(compileExcludePattern('**')?.nameOnly).toBe(true)
  })
})

describe('compileExcludePatterns', () => {
  it('matches nothing when the list is empty', () => {
    const matcher = compileExcludePatterns([])
    expect(matcher('anything')).toBe(false)
    expect(matcher('a/b/c')).toBe(false)
  })

  it('matches when any pattern matches', () => {
    const matcher = compileExcludePatterns(['log.md', '.stryker-tmp', 'a/*.md'])
    expect(matcher('log.md')).toBe(true)
    expect(matcher('x/.stryker-tmp')).toBe(true)
    expect(matcher('a/b.md')).toBe(true)
    expect(matcher('keep.md')).toBe(false)
    expect(matcher('x/a/b.md')).toBe(false)
  })

  it('skips an invalid pattern instead of throwing', () => {
    const matcher = compileExcludePatterns(['!log.md', 'keep.txt', '[a]'])
    expect(matcher('log.md')).toBe(false)
    expect(matcher('keep.txt')).toBe(true)
    expect(compileExcludePattern('!log.md')).toBeUndefined()
  })
})

describe('validateExcludePattern', () => {
  const valid = [
    'log.md',
    '.stryker-tmp',
    'drafts/*.md',
    'a/**/b',
    '**/b',
    'a/**',
    '**',
    '*',
    '?',
    'a?c*',
    'dir/',
    'a b',
    'caf\u00E9',
    'a{b}',
    '-x',
    'a.b/c.d',
  ]
  for (const pattern of valid) {
    it(`accepts ${JSON.stringify(pattern)}`, () => {
      expect(validateExcludePattern(pattern)).toEqual({ ok: true })
    })
  }

  it('accepts a 256-character pattern and rejects a 257-character one', () => {
    expect(validateExcludePattern('a'.repeat(256))).toEqual({ ok: true })
    const reason = invalidReason('a'.repeat(257))
    expect(reason).toContain('256')
    expect(reason).not.toContain('aaaa')
  })

  // Each shape below is invalid for its own reason. Two shapes may share a
  // reason only when they break the same rule.
  const invalidShapes: ReadonlyArray<readonly [string, string, string]> = [
    ['empty', '', 'empty'],
    ['leading slash', '/a', 'leading slash'],
    ['bare slash', '/', 'leading slash'],
    ['negation', '!a', 'negation'],
    ['leading ./', './a', 'leading ./'],
    ['empty segment', 'a//b', 'empty segment'],
    ['doubled trailing slash', 'a//', 'empty segment'],
    ['dot segment', 'a/./b', '. segment'],
    ['lone dot', '.', '. segment'],
    ['leading ..', '../a', '.. segment'],
    ['inner ..', 'a/../b', '.. segment'],
    ['character class', '[a]', 'character class'],
    ['lone bracket', 'a]', 'character class'],
    ['backslash', 'a\\b', 'backslash'],
    ['embedded **', 'a**b', 'embedded **'],
    ['triple star', '***', 'embedded **'],
    ['trailing **', 'a**', 'embedded **'],
    ['leading **', '**a', 'embedded **'],
  ]

  const reasonByCategory = new Map<string, string>()
  for (const [label, pattern, category] of invalidShapes) {
    it(`rejects ${label} (${JSON.stringify(pattern)}) as ${category}`, () => {
      const reason = invalidReason(pattern)
      expect(reason.length).toBeGreaterThan(0)
      // The reason names the rule, never the pattern text.
      if (pattern.length > 1) {
        expect(reason).not.toContain(pattern)
      }
      const known = reasonByCategory.get(category)
      if (known === undefined) {
        reasonByCategory.set(category, reason)
      } else {
        expect(reason).toBe(known)
      }
    })
  }

  it('gives each rule its own reason', () => {
    const categories = new Set(invalidShapes.map(([, , category]) => category))
    const reasons = new Set<string>()
    const seen = new Set<string>()
    for (const [, pattern, category] of invalidShapes) {
      if (seen.has(category)) continue
      seen.add(category)
      reasons.add(invalidReason(pattern))
    }
    expect(reasons.size).toBe(categories.size)
    expect(categories.size).toBe(10)
  })

  it('rejects a non-string value as "not a string"', () => {
    for (const value of [1, null, undefined, true, {}, [], ['a']]) {
      expect(invalidReason(value)).toBe('not a string')
    }
  })

  it('never echoes distinctive pattern text in a reason', () => {
    for (const pattern of [
      '!SECRET-token',
      '/SECRET-token',
      './SECRET-token',
      'SECRET//token',
      'SECRET/../token',
      '[SECRET-token]',
      'SECRET\\token',
      'SECRET**token',
      `SECRET-${'x'.repeat(300)}`,
    ]) {
      expect(invalidReason(pattern)).not.toContain('SECRET')
    }
  })
})

describe('validateExcludeList', () => {
  it('keeps every valid pattern and reports no issues', () => {
    const result = validateExcludeList(['log.md', '.stryker-tmp'])
    expect(result).toEqual({
      ok: true,
      patterns: ['log.md', '.stryker-tmp'],
      issues: [],
    })
  })

  it('treats an empty array as a no-op', () => {
    expect(validateExcludeList([])).toEqual({
      ok: true,
      patterns: [],
      issues: [],
    })
  })

  it('drops the source for a non-array value', () => {
    for (const value of ['log.md', 1, null, {}, true]) {
      const result = validateExcludeList(value)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('not an array')
      }
    }
  })

  it('drops invalid elements one by one and keeps their valid neighbors', () => {
    const result = validateExcludeList(['drafts/*.md', '[bad]', 7, 'keep'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.patterns).toEqual(['drafts/*.md', 'keep'])
    expect(result.issues).toEqual([
      { index: 1, reason: invalidReason('[bad]') },
      { index: 2, reason: 'not a string' },
    ])
    expect(JSON.stringify(result.issues)).not.toContain('bad')
  })

  it('reports a negated pattern and keeps the collapsed neighbor', () => {
    const result = validateExcludeList(['!log.md', 'a/**/**/**/b'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.patterns).toEqual(['a/**/**/**/b'])
    expect(result.issues).toEqual([
      { index: 0, reason: invalidReason('!log.md') },
    ])
  })

  it('keeps exactly 64 patterns and raises nothing at the limit', () => {
    const list = Array.from({ length: 64 }, (_, i) => `p${i}`)
    const result = validateExcludeList(list)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.patterns).toHaveLength(64)
    expect(result.issues).toEqual([])
  })

  it('drops elements from index 64 on with one aggregate issue', () => {
    const list = Array.from({ length: 70 }, (_, i) => `p${i}`)
    const result = validateExcludeList(list)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.patterns).toEqual(list.slice(0, 64))
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.index).toBe(64)
    expect(result.issues[0]?.reason).toContain('6')
    expect(result.issues[0]?.reason).toContain('64')
  })

  it('reports the 65th element alone as exclude[64]', () => {
    const list = Array.from({ length: 65 }, (_, i) => `p${i}`)
    const result = validateExcludeList(list)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.patterns).toHaveLength(64)
    expect(result.issues.map((issue) => issue.index)).toEqual([64])
  })

  it('lets an invalid element occupy an index inside the limit', () => {
    const list = Array.from({ length: 65 }, (_, i) => `p${i}`)
    list[3] = '!bad'
    const result = validateExcludeList(list)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 64 slots are inspected, one is invalid: 63 kept, and p64 is over the limit.
    expect(result.patterns).toHaveLength(63)
    expect(result.patterns).not.toContain('!bad')
    expect(result.patterns).not.toContain('p64')
    expect(result.issues.map((issue) => issue.index)).toEqual([3, 64])
  })

  it('does not inspect elements past the limit', () => {
    const list: unknown[] = Array.from({ length: 64 }, (_, i) => `p${i}`)
    list.push('!bad', 5, '')
    const result = validateExcludeList(list)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.index).toBe(64)
  })

  it('keeps duplicate patterns as written', () => {
    const result = validateExcludeList(['a', 'a'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.patterns).toEqual(['a', 'a'])
  })
})

describe('bounded matching', () => {
  it('answers correctly for a stacked-star pattern against a long run of one character', () => {
    const run = 'a'.repeat(255)
    expect(matches('*a*a*a*a*b', run)).toBe(false)
    expect(matches('*a*a*a*a*b', `${run}b`)).toBe(true)
    expect(matches('*a*a*a*a*', run)).toBe(true)
    expect(matches('a/*a*a*a*a*b', `a/${run}`)).toBe(false)
    expect(matches('a/*a*a*a*a*b', `a/${run}b`)).toBe(true)
  })

  it('answers correctly for a 10,000-segment path against stacked **', () => {
    const segments = Array.from({ length: 10_000 }, (_, i) => `s${i}`)
    const path = segments.join('/')
    const stacked = `${Array.from({ length: 60 }, () => '**').join('/')}/s9999`
    expect(matches(stacked, path)).toBe(true)
    expect(matches(`${stacked}x`, path)).toBe(false)
    expect(matches('s0/**/s5000/**/s9999', path)).toBe(true)
    expect(matches('s0/**/s9999/**/s5000', path)).toBe(false)
    expect(matches('**/*/**/*/**/*/**/nope', path)).toBe(false)
  })

  it('answers correctly for an uncollapsed-looking pattern at the length limit', () => {
    const pattern = `${'a/**/'.repeat(50)}z`
    expect(pattern.length).toBeLessThanOrEqual(MAX_EXCLUDE_PATTERN_LENGTH)
    expect(validateExcludePattern(pattern)).toEqual({ ok: true })
    const path = `${'a/'.repeat(5_000)}z`
    expect(matches(pattern, path)).toBe(true)
    expect(matches(pattern, `${path}z`)).toBe(false)
  })
})

describe('module shape', () => {
  // The matcher is shared by the plugin bundle and the standalone bin, so a
  // runtime import would widen the bin's import graph.
  it('stays import-free', () => {
    const source = readFileSync(
      new URL('../../src/lib/search-exclude.ts', import.meta.url),
      'utf8',
    )
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(withoutComments).not.toMatch(/^\s*import\b/m)
    expect(withoutComments).not.toMatch(/\bimport\s*\(/)
    expect(withoutComments).not.toMatch(/\brequire\s*\(/)
    // Matching is hand-written so its cost stays bounded.
    expect(withoutComments).not.toMatch(
      /\bRegExp\b|\.(?:test|match|exec|search)\(/,
    )
  })
})
