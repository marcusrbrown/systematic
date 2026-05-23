import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASTRO_CONFIG_PATH = path.resolve(__dirname, '../../docs/astro.config.mjs')

/**
 * Extract the `redirects` object from astro.config.mjs by reading the file
 * and parsing the redirect entries with a simple regex. This avoids importing
 * the ESM config (which pulls in Astro/Starlight at test time).
 */
function extractRedirects(source: string): Record<string, string> {
  const redirectsMatch = source.match(/redirects:\s*\{([^}]+)\}/)
  if (!redirectsMatch) return {}

  const block = redirectsMatch[1]
  const result: Record<string, string> = {}

  // Match 'key': 'value' or "key": "value" pairs
  const pairRe = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g
  for (;;) {
    const m = pairRe.exec(block)
    if (m === null) break
    result[m[1]] = m[2]
  }
  return result
}

describe('astro.config.mjs redirects', () => {
  let redirects: Record<string, string>

  test('astro.config.mjs exists and is readable', () => {
    expect(fs.existsSync(ASTRO_CONFIG_PATH)).toBe(true)
    const source = fs.readFileSync(ASTRO_CONFIG_PATH, 'utf-8')
    redirects = extractRedirects(source)
    expect(Object.keys(redirects).length).toBeGreaterThan(0)
  })

  test('/getting-started/configuration/ redirects to /systematic/reference/configuration/', () => {
    const source = fs.readFileSync(ASTRO_CONFIG_PATH, 'utf-8')
    const r = extractRedirects(source)
    expect(r['/getting-started/configuration/']).toBe(
      '/systematic/reference/configuration/',
    )
  })

  test('/reference/systematic-config/ redirects to /systematic/reference/configuration/', () => {
    const source = fs.readFileSync(ASTRO_CONFIG_PATH, 'utf-8')
    const r = extractRedirects(source)
    expect(r['/reference/systematic-config/']).toBe(
      '/systematic/reference/configuration/',
    )
  })
})
