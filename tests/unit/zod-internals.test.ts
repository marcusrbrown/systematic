import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  getZodDefaultInnerType,
  getZodObjectShape,
  getZodTypeName,
} from '../../scripts/lib/zod-internals.js'

describe('getZodTypeName', () => {
  test('returns the type name for a string schema', () => {
    const name = getZodTypeName(z.string())
    expect(typeof name).toBe('string')
    expect(name).toBeTruthy()
  })

  test('returns "default" for a schema wrapped with .default()', () => {
    const name = getZodTypeName(z.string().default('x'))
    expect(name).toBe('default')
  })

  test('returns a non-default type name for a plain string schema', () => {
    const name = getZodTypeName(z.string())
    expect(name).not.toBe('default')
  })
})

describe('getZodDefaultInnerType', () => {
  test('returns the inner schema for a ZodDefault wrapper', () => {
    const inner = getZodDefaultInnerType(z.string().default('x'))
    expect(inner).toBeDefined()
    if (inner) {
      expect(inner.parse('y')).toBe('y')
    }
  })

  test('returns undefined for a plain string schema (no default wrapper)', () => {
    const inner = getZodDefaultInnerType(z.string())
    expect(inner).toBeUndefined()
  })
})

describe('getZodObjectShape', () => {
  test('returns the shape for a ZodObject schema', () => {
    const shape = getZodObjectShape(z.object({ a: z.string() }))
    expect(shape).toBeDefined()
    if (shape) {
      expect('a' in shape).toBe(true)
    }
  })

  test('returns undefined for a non-object schema', () => {
    const shape = getZodObjectShape(z.string())
    expect(shape).toBeUndefined()
  })
})
