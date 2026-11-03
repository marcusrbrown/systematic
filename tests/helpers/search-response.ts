import type { SearchResponse } from '../../src/lib/search-core.js'
import type { SearchResult } from '../../src/lib/search-render.js'

/**
 * The structured built-in result of a response. A response that failed, or
 * that answered `kind: "external"`, has none, so asking for it is a test
 * error rather than an empty value.
 */
export function builtinResult(response: SearchResponse): SearchResult {
  if (!response.ok) throw new Error(`search failed: ${response.text}`)
  if (response.selector !== 'builtin') {
    throw new Error('expected a built-in response, got an external one')
  }
  return response.result
}
