/**
 * Thin adapters over zod private internals (`_def`). Isolated here so a future
 * zod major upgrade only needs to change this file. All other code should use
 * these functions instead of reading `_def` directly.
 *
 * Pinned to `zod@4.4.3` exact in package.json; the dependency-version comment
 * here is the canary — bump zod, re-verify these adapters, then bump the pin.
 */
import type { z } from 'zod'

export function getZodTypeName(schema: z.ZodType): string | undefined {
  return (schema as { _def?: { type?: string } })._def?.type
}

export function getZodDefaultInnerType(
  schema: z.ZodType,
): z.ZodType | undefined {
  return (schema as { _def?: { innerType?: z.ZodType } })._def?.innerType
}

export function getZodObjectShape(
  schema: z.ZodType,
): Record<string, z.ZodType> | undefined {
  return (schema as { _def?: { shape?: Record<string, z.ZodType> } })._def
    ?.shape
}
