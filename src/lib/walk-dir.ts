import fs from 'node:fs'
import path from 'node:path'

export interface WalkEntry {
  path: string
  name: string
  isDirectory: boolean
  depth: number
  category?: string // parent directory name (undefined for root level)
}

export interface WalkOptions {
  maxDepth?: number
  filter?: (entry: WalkEntry) => boolean
}

export function walkDir(rootDir: string, options: WalkOptions = {}): WalkEntry[] {
  const { maxDepth = 3, filter } = options
  const results: WalkEntry[] = []

  if (!fs.existsSync(rootDir)) return results

  function recurse(currentDir: string, depth: number, category?: string) {
    if (depth > maxDepth) return

    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      const walkEntry: WalkEntry = {
        path: fullPath,
        name: entry.name,
        isDirectory: entry.isDirectory(),
        depth,
        category,
      }

      if (!filter || filter(walkEntry)) {
        results.push(walkEntry)
      }

      if (entry.isDirectory()) {
        recurse(fullPath, depth + 1, entry.name)
      }
    }
  }

  recurse(rootDir, 0)
  return results
}
