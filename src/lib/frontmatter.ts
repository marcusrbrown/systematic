interface ParsedFrontmatter {
  data: Record<string, string | number | boolean>
  body: string
  raw: string
}

export type { ParsedFrontmatter }

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { data: {}, body: content, raw: '' }
  }

  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i
      break
    }
  }

  if (endIndex === -1) {
    return { data: {}, body: content, raw: '' }
  }

  const yamlLines = lines.slice(1, endIndex)
  const body = lines.slice(endIndex + 1).join('\n')
  const raw = lines.slice(0, endIndex + 1).join('\n')
  const data: Record<string, string | number | boolean> = {}

  for (const line of yamlLines) {
    const match = line.match(/^([\w-]+):\s*(.*)$/)
    if (match) {
      const [, key, value] = match
      if (value === 'true') data[key] = true
      else if (value === 'false') data[key] = false
      else if (/^\d+(\.\d+)?$/.test(value)) data[key] = parseFloat(value)
      else data[key] = value
    }
  }

  return { data, body, raw }
}

export function formatFrontmatter(data: Record<string, string | number | boolean>): string {
  const lines: string[] = ['---']
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${value}`)
  }
  lines.push('---')
  return lines.join('\n')
}

export function stripFrontmatter(content: string): string {
  const lines = content.split('\n')
  let inFrontmatter = false
  let frontmatterEnded = false
  const contentLines: string[] = []

  for (const line of lines) {
    if (line.trim() === '---') {
      if (inFrontmatter) {
        frontmatterEnded = true
        continue
      }
      inFrontmatter = true
      continue
    }

    if (frontmatterEnded || !inFrontmatter) {
      contentLines.push(line)
    }
  }

  return contentLines.join('\n').trim()
}
