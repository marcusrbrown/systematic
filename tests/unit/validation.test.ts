import { describe, expect, test } from 'bun:test'
import {
  extractBoolean,
  extractNonEmptyString,
  extractNumber,
  extractString,
  isAgentMode,
  isPermissionSetting,
  isRecord,
  isToolsMap,
  normalizePermission,
} from '../../src/lib/validation.ts'

// ---------------------------------------------------------------------------
// Type-guard predicates
// ---------------------------------------------------------------------------

describe('isRecord', () => {
  test('true for plain objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord({ nested: { b: 2 } })).toBe(true)
  })

  test('false for null, undefined, primitives, and arrays', () => {
    expect(isRecord(null)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
    expect(isRecord('string')).toBe(false)
    expect(isRecord(42)).toBe(false)
    expect(isRecord(true)).toBe(false)
    expect(isRecord([])).toBe(false)
    expect(isRecord([1, 2, 3])).toBe(false)
  })
})

describe('isPermissionSetting', () => {
  test('true for the three documented literals', () => {
    expect(isPermissionSetting('ask')).toBe(true)
    expect(isPermissionSetting('allow')).toBe(true)
    expect(isPermissionSetting('deny')).toBe(true)
  })

  test('false for other strings, nullish, objects, arrays, and wrong-case variants', () => {
    expect(isPermissionSetting('ALLOW')).toBe(false)
    expect(isPermissionSetting('allowed')).toBe(false)
    expect(isPermissionSetting('')).toBe(false)
    expect(isPermissionSetting(null)).toBe(false)
    expect(isPermissionSetting(undefined)).toBe(false)
    expect(isPermissionSetting({})).toBe(false)
    expect(isPermissionSetting([])).toBe(false)
    expect(isPermissionSetting(1)).toBe(false)
  })
})

describe('isToolsMap', () => {
  test('true for records with only boolean values', () => {
    expect(isToolsMap({})).toBe(true)
    expect(isToolsMap({ bash: true })).toBe(true)
    expect(isToolsMap({ bash: true, edit: false, read: true })).toBe(true)
  })

  test('false when any value is not a boolean', () => {
    expect(isToolsMap({ bash: 'not-a-boolean' })).toBe(false)
    expect(isToolsMap({ bash: true, edit: 'ask' })).toBe(false)
    expect(isToolsMap({ bash: 1 })).toBe(false)
    expect(isToolsMap({ bash: null })).toBe(false)
    expect(isToolsMap({ bash: { nested: true } })).toBe(false)
  })

  test('false for non-records', () => {
    expect(isToolsMap(null)).toBe(false)
    expect(isToolsMap(undefined)).toBe(false)
    expect(isToolsMap([])).toBe(false)
    expect(isToolsMap('tools')).toBe(false)
    expect(isToolsMap(42)).toBe(false)
  })
})

describe('isAgentMode', () => {
  test('true for the three AgentMode literals', () => {
    expect(isAgentMode('subagent')).toBe(true)
    expect(isAgentMode('primary')).toBe(true)
    expect(isAgentMode('all')).toBe(true)
  })

  test('false for other strings and non-string values', () => {
    expect(isAgentMode('SUBAGENT')).toBe(false)
    expect(isAgentMode('other')).toBe(false)
    expect(isAgentMode('')).toBe(false)
    expect(isAgentMode(null)).toBe(false)
    expect(isAgentMode(undefined)).toBe(false)
    expect(isAgentMode(123)).toBe(false)
    expect(isAgentMode({})).toBe(false)
    expect(isAgentMode(['subagent'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// normalizePermission
// ---------------------------------------------------------------------------

describe('normalizePermission', () => {
  test('returns undefined for non-records (null, undefined, primitives, arrays)', () => {
    expect(normalizePermission(null)).toBeUndefined()
    expect(normalizePermission(undefined)).toBeUndefined()
    expect(normalizePermission('ask')).toBeUndefined()
    expect(normalizePermission(42)).toBeUndefined()
    expect(normalizePermission(['allow'])).toBeUndefined()
  })

  test('returns undefined for an empty object (no fields set)', () => {
    expect(normalizePermission({})).toBeUndefined()
  })

  test('returns a permission config with a single simple field', () => {
    expect(normalizePermission({ edit: 'ask' })).toEqual({ edit: 'ask' })
    expect(normalizePermission({ webfetch: 'allow' })).toEqual({
      webfetch: 'allow',
    })
  })

  test('returns a permission config with every simple field set', () => {
    expect(
      normalizePermission({
        edit: 'ask',
        webfetch: 'allow',
        doom_loop: 'deny',
        external_directory: 'ask',
        task: 'allow',
        skill: 'allow',
      }),
    ).toEqual({
      edit: 'ask',
      webfetch: 'allow',
      doom_loop: 'deny',
      external_directory: 'ask',
      task: 'allow',
      skill: 'allow',
    })
  })

  test('accepts bash as a single permission setting', () => {
    expect(normalizePermission({ bash: 'allow' })).toEqual({ bash: 'allow' })
    expect(normalizePermission({ bash: 'deny' })).toEqual({ bash: 'deny' })
  })

  test('accepts bash as a command map of permission settings', () => {
    expect(
      normalizePermission({
        bash: { 'ls *': 'allow', 'rm -rf *': 'deny' },
      }),
    ).toEqual({
      bash: { 'ls *': 'allow', 'rm -rf *': 'deny' },
    })
  })

  test('returns undefined when bash is a record with non-PermissionSetting values', () => {
    // FRAGILITY: validation.ts returns undefined on any malformed field rather than
    // dropping just the bad field. Downstream loadAgentAsConfig then swallows the
    // undefined into a silent `null`, so broken bundled assets disappear with no
    // CI signal. Documented as I3.e scope (bundled asset error surfacing) in
    // docs/brainstorms/2026-04-18-infra-improvements-requirements.md. Changing
    // this behavior (e.g., dropping only the bad field or throwing) must update
    // this test intentionally.
    expect(
      normalizePermission({ bash: { 'ls *': 'not-a-setting' } }),
    ).toBeUndefined()
  })

  test('returns undefined when bash is a non-record non-PermissionSetting value', () => {
    // FRAGILITY: same silent-undefined chain as the test above.
    expect(normalizePermission({ bash: 42 })).toBeUndefined()
    expect(normalizePermission({ bash: ['ls *'] })).toBeUndefined()
    expect(normalizePermission({ bash: null })).toBeUndefined()
  })

  test('returns undefined when any simple field has a malformed value', () => {
    // FRAGILITY: same silent-undefined chain as above.
    expect(normalizePermission({ edit: 'not-a-setting' })).toBeUndefined()
    expect(normalizePermission({ webfetch: 123 })).toBeUndefined()
    expect(normalizePermission({ task: {} })).toBeUndefined()
  })

  test('returns undefined when a field is explicitly set to undefined', () => {
    // FRAGILITY: `{ edit: undefined }` has 'edit' in the object (the `in`
    // operator returns true), so extractSimplePermission does NOT take the
    // "key absent" path. Instead it evaluates `isPermissionSetting(undefined)`
    // → false → returns null → normalizePermission returns undefined for the
    // entire config. An explicitly-undefined field poisons the whole config
    // rather than being ignored. Same silent-undefined chain as the tests
    // above. Changing this (e.g., treating explicit undefined as "absent")
    // must update this test intentionally.
    expect(normalizePermission({ edit: undefined })).toBeUndefined()
    expect(
      normalizePermission({ edit: 'ask', webfetch: undefined }),
    ).toBeUndefined()
  })

  test('mixes simple fields and bash map in one config', () => {
    expect(
      normalizePermission({
        edit: 'ask',
        bash: { 'git *': 'allow' },
        webfetch: 'deny',
      }),
    ).toEqual({
      edit: 'ask',
      bash: { 'git *': 'allow' },
      webfetch: 'deny',
    })
  })

  test('ignores unknown keys (only documented fields appear in output)', () => {
    expect(
      normalizePermission({
        edit: 'ask',
        unknown_field: 'something',
      }),
    ).toEqual({ edit: 'ask' })
  })
})

// ---------------------------------------------------------------------------
// extractString
// ---------------------------------------------------------------------------

describe('extractString', () => {
  test('returns the string value when present', () => {
    expect(extractString({ name: 'hello' }, 'name')).toBe('hello')
    expect(extractString({ name: '' }, 'name')).toBe('')
  })

  test('returns the default fallback ("") when key is missing', () => {
    expect(extractString({}, 'missing')).toBe('')
  })

  test('returns the supplied fallback when key is missing', () => {
    expect(extractString({}, 'missing', 'fb')).toBe('fb')
  })

  test('returns the fallback when value is the wrong type', () => {
    expect(extractString({ name: 42 }, 'name', 'fb')).toBe('fb')
    expect(extractString({ name: null }, 'name', 'fb')).toBe('fb')
    expect(extractString({ name: true }, 'name', 'fb')).toBe('fb')
    expect(extractString({ name: { nested: 'x' } }, 'name', 'fb')).toBe('fb')
    expect(extractString({ name: ['arr'] }, 'name', 'fb')).toBe('fb')
  })
})

// ---------------------------------------------------------------------------
// extractNonEmptyString
// ---------------------------------------------------------------------------

describe('extractNonEmptyString', () => {
  test('returns the trimmed value for non-empty strings', () => {
    expect(extractNonEmptyString({ name: 'hello' }, 'name')).toBe('hello')
    expect(extractNonEmptyString({ name: '  hello  ' }, 'name')).toBe('hello')
  })

  test('returns undefined for empty or whitespace-only strings', () => {
    expect(extractNonEmptyString({ name: '' }, 'name')).toBeUndefined()
    expect(extractNonEmptyString({ name: '   ' }, 'name')).toBeUndefined()
    expect(extractNonEmptyString({ name: '\t\n' }, 'name')).toBeUndefined()
  })

  test('returns undefined for non-string values', () => {
    expect(extractNonEmptyString({ name: 42 }, 'name')).toBeUndefined()
    expect(extractNonEmptyString({ name: null }, 'name')).toBeUndefined()
    expect(extractNonEmptyString({ name: true }, 'name')).toBeUndefined()
    expect(extractNonEmptyString({ name: {} }, 'name')).toBeUndefined()
  })

  test('returns undefined when key is missing', () => {
    expect(extractNonEmptyString({}, 'missing')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// extractNumber
// ---------------------------------------------------------------------------

describe('extractNumber', () => {
  test('returns the numeric value when present', () => {
    expect(extractNumber({ n: 42 }, 'n')).toBe(42)
    expect(extractNumber({ n: 0 }, 'n')).toBe(0)
    expect(extractNumber({ n: -3.14 }, 'n')).toBe(-3.14)
  })

  test('returns undefined for non-numeric values (no string coercion)', () => {
    expect(extractNumber({ n: '42' }, 'n')).toBeUndefined()
    expect(extractNumber({ n: 'forty-two' }, 'n')).toBeUndefined()
    expect(extractNumber({ n: null }, 'n')).toBeUndefined()
    expect(extractNumber({ n: true }, 'n')).toBeUndefined()
    expect(extractNumber({ n: {} }, 'n')).toBeUndefined()
  })

  test('returns undefined when key is missing', () => {
    expect(extractNumber({}, 'missing')).toBeUndefined()
  })

  test('preserves NaN as a number (typeof NaN === "number")', () => {
    // CORRECTNESS: extractNumber uses typeof, which considers NaN a number.
    // Callers must handle NaN themselves if they need finite-number semantics.
    expect(extractNumber({ n: Number.NaN }, 'n')).toBeNaN()
  })
})

// ---------------------------------------------------------------------------
// extractBoolean
// ---------------------------------------------------------------------------

describe('extractBoolean', () => {
  test('returns the boolean value when present', () => {
    expect(extractBoolean({ flag: true }, 'flag')).toBe(true)
    expect(extractBoolean({ flag: false }, 'flag')).toBe(false)
  })

  test('coerces the strings "true" and "false" (case-insensitive, trimmed)', () => {
    expect(extractBoolean({ flag: 'true' }, 'flag')).toBe(true)
    expect(extractBoolean({ flag: 'false' }, 'flag')).toBe(false)
    expect(extractBoolean({ flag: 'TRUE' }, 'flag')).toBe(true)
    expect(extractBoolean({ flag: 'False' }, 'flag')).toBe(false)
    expect(extractBoolean({ flag: '  true  ' }, 'flag')).toBe(true)
    expect(extractBoolean({ flag: '\tFALSE\n' }, 'flag')).toBe(false)
  })

  test('returns undefined for strings that are not "true" or "false"', () => {
    expect(extractBoolean({ flag: 'yes' }, 'flag')).toBeUndefined()
    expect(extractBoolean({ flag: 'no' }, 'flag')).toBeUndefined()
    expect(extractBoolean({ flag: '1' }, 'flag')).toBeUndefined()
    expect(extractBoolean({ flag: '' }, 'flag')).toBeUndefined()
  })

  test('returns undefined for non-boolean non-string values (no coercion)', () => {
    expect(extractBoolean({ flag: 1 }, 'flag')).toBeUndefined()
    expect(extractBoolean({ flag: 0 }, 'flag')).toBeUndefined()
    expect(extractBoolean({ flag: null }, 'flag')).toBeUndefined()
    expect(extractBoolean({ flag: [] }, 'flag')).toBeUndefined()
    expect(extractBoolean({ flag: {} }, 'flag')).toBeUndefined()
  })

  test('returns undefined when key is missing', () => {
    expect(extractBoolean({}, 'missing')).toBeUndefined()
  })
})
