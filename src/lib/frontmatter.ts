import yaml from 'js-yaml'

export interface FrontmatterResult<T = Record<string, unknown>> {
  data: T
  body: string
  hadFrontmatter: boolean
  parseError: boolean
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

export function formatFrontmatter(
  data: Record<string, string | number | boolean>,
): string {
  const lines: string[] = ['---']
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${value}`)
  }
  lines.push('---')
  return lines.join('\n')
}

export function stripFrontmatter(content: string): string {
  const { body, hadFrontmatter } = parseFrontmatter(content)
  return hadFrontmatter ? body.trim() : content.trim()
}
