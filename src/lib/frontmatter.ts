import yaml from 'js-yaml'

export interface FrontmatterResult<T = Record<string, unknown>> {
  data: T
  body: string
  hadFrontmatter: boolean
  parseError: boolean
}

/**
 * Returns the raw YAML text between the opening and closing `---` delimiters,
 * or `null` when the content has no frontmatter block.
 *
 * Scope: flat top-level frontmatter only. Nested/indented mapping values are
 * returned verbatim as part of the block — callers that scan individual lines
 * (e.g. parse-safety checks) must skip indented lines themselves.
 *
 * Handles LF and CRLF line endings. The closing `---` does not need a trailing
 * newline (handles files that end immediately after the delimiter).
 */
export function extractFrontmatterBlock(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n?---/)
  return match ? (match[1] ?? '') : null
}

/**
 * Parses YAML frontmatter from Markdown content.
 *
 * Uses js-yaml with JSON_SCHEMA for security (prevents code execution via YAML tags).
 * Supports all standard YAML keys including hyphenated ones (e.g., 'argument-hint').
 *
 * @param content - Markdown content with optional frontmatter
 * @returns Parsed frontmatter data, body content, and parsing status
 */
export function parseFrontmatter<T = Record<string, unknown>>(
  content: string,
): FrontmatterResult<T> {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n([\s\S]*)$/
  const match = content.match(frontmatterRegex)

  if (!match) {
    return {
      data: {} as T,
      body: content,
      hadFrontmatter: false,
      parseError: false,
    }
  }

  const yamlContent = match[1]
  const body = match[2]

  try {
    const parsed = yaml.load(yamlContent, { schema: yaml.JSON_SCHEMA })
    const data = (parsed ?? {}) as T
    return { data, body, hadFrontmatter: true, parseError: false }
  } catch {
    return { data: {} as T, body, hadFrontmatter: true, parseError: true }
  }
}

export function formatFrontmatter(data: Record<string, unknown>): string {
  if (Object.keys(data).length === 0) {
    return ['---', '---'].join('\n')
  }

  const yamlContent = yaml
    .dump(data, {
      schema: yaml.JSON_SCHEMA,
      lineWidth: -1,
      noRefs: true,
    })
    .trimEnd()

  return ['---', yamlContent, '---'].join('\n')
}

/**
 * Removes YAML frontmatter from content and returns the body.
 * Convenience wrapper around parseFrontmatter.
 */
export function stripFrontmatter(content: string): string {
  const { body, hadFrontmatter } = parseFrontmatter(content)
  return hadFrontmatter ? body.trim() : content.trim()
}
