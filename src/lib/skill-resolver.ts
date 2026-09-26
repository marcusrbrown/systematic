import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildCatalogEntries, renderCatalogCompact } from './skill-catalog.js'
import {
  extractSkillBody,
  type LoadedSkill,
  loadSkill,
} from './skill-loader.js'
import { findSkillsInDir } from './skills.js'

/**
 * Harness-neutral options shared by every adapter (OpenCode, Pi, ...).
 */
export interface SkillResolverOptions {
  bundledSkillsDir: string
  disabledSkills: string[]
}

function getAllSkills(options: SkillResolverOptions): LoadedSkill[] {
  const { bundledSkillsDir, disabledSkills } = options
  return findSkillsInDir(bundledSkillsDir)
    .filter((s) => !disabledSkills.includes(s.name))
    .map((skillInfo) => loadSkill(skillInfo))
    .filter((s): s is LoadedSkill => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolves a requested skill name (with or without the `systematic:` prefix)
 * against the bundled skill catalog. Throws the same not-found error text
 * regardless of the calling harness.
 */
export function resolveSkill(
  options: SkillResolverOptions,
  requestedName: string,
): LoadedSkill {
  const normalizedName = requestedName.startsWith('systematic:')
    ? requestedName.slice('systematic:'.length)
    : requestedName

  const skills = getAllSkills(options)
  const matchedSkill = skills.find((s) => s.name === normalizedName)

  if (!matchedSkill) {
    const availableSystematic = buildCatalogEntries(options).map(
      (s) => s.prefixedName,
    )
    throw new Error(
      `Skill "${requestedName}" not found. Available systematic skills: ${availableSystematic.join(', ')}`,
    )
  }

  return matchedSkill
}

/**
 * Deterministic, catalog-derived tool description shared by every harness.
 */
export function buildSkillToolDescription(
  options: SkillResolverOptions,
): string {
  const catalog = renderCatalogCompact(options)

  return `Load a specialized skill that provides domain-specific instructions and workflows.

When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.

The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.

Tool output includes a \`<skill_content name="...">\` block with the loaded content.

${catalog}`
}

/**
 * Deterministic, catalog-derived parameter hint shared by every harness.
 */
export function buildSkillToolParameterHint(
  options: SkillResolverOptions,
): string {
  const entries = buildCatalogEntries(options)
  const examples = entries
    .slice(0, 3)
    .map((s) => `'${s.prefixedName}'`)
    .join(', ')
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ''
  return `The name of the skill from available_skills${hint}`
}

/**
 * Parses positional arguments from a raw argument string using OpenCode
 * v1.18.32 native slash-command semantics: whitespace-separated, with
 * quoted segments (`"..."` or `'...'`) treated as a single argument with
 * the surrounding quotes stripped.
 */
function parsePositionalArgs(raw: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match = pattern.exec(raw)
  while (match !== null) {
    const [, doubleQuoted, singleQuoted, bare] = match
    args.push(doubleQuoted ?? singleQuoted ?? bare ?? '')
    match = pattern.exec(raw)
  }
  return args
}

/**
 * Substitutes `$1`, `$2`, ... and `$ARGUMENTS` placeholders into a skill
 * body, mirroring OpenCode's `SessionPrompt.command` native slash-command
 * argument semantics (v1.18.32). Text-only substitution — never executes
 * anything.
 *
 * 1. Parse positional args from `raw` (see {@link parsePositionalArgs}).
 * 2. Replace each `$N` (regex `\$(\d+)`): if `N - 1 >= args.length` → "";
 *    if `N` is the highest placeholder number found in the body → the
 *    remaining args from position `N` joined with a space; otherwise the
 *    single arg at position `N`.
 * 3. Replace every `$ARGUMENTS` with the raw argument string.
 * 4. If the body had neither positional placeholders nor `$ARGUMENTS`, and
 *    `raw.trim()` is non-empty, append `"\n\n" + raw` to the body.
 */
export function substituteSkillArguments(body: string, raw: string): string {
  const placeholderNumbers = [...body.matchAll(/\$(\d+)/g)].map((m) =>
    Number(m[1]),
  )
  const hasPositional = placeholderNumbers.length > 0
  const hasArguments = body.includes('$ARGUMENTS')

  let result = body

  if (hasPositional) {
    const last = Math.max(...placeholderNumbers)
    const args = parsePositionalArgs(raw)
    result = result.replace(/\$(\d+)/g, (_match, numStr: string) => {
      const n = Number(numStr)
      if (n - 1 >= args.length) return ''
      if (n === last) return args.slice(n - 1).join(' ')
      return args[n - 1] ?? ''
    })
  }

  result = result.replaceAll('$ARGUMENTS', raw)

  if (!hasPositional && !hasArguments && raw.trim().length > 0) {
    result = `${result}\n\n${raw}`
  }

  return result
}

/**
 * Builds the exact `<skill_content>`-wrapped output shared by every harness.
 *
 * When `argument` is `undefined`, the output is byte-identical to calling
 * this without argument support at all (Pi's caller in src/pi.ts relies on
 * this). When `argument` is a string (including an empty string), it is
 * substituted into the trimmed body via {@link substituteSkillArguments}
 * before wrapping — the wrapper lines themselves are never substituted.
 */
export function buildSkillContentOutput(
  matchedSkill: LoadedSkill,
  argument?: string,
): {
  output: string
  dir: string
} {
  const trimmedBody = extractSkillBody(matchedSkill.wrappedTemplate).trim()
  const body =
    argument === undefined
      ? trimmedBody
      : substituteSkillArguments(trimmedBody, argument)
  const dir = path.dirname(matchedSkill.skillFile)
  const base = pathToFileURL(dir).href
  const files = discoverSkillFiles(dir)

  const lines = [
    `<skill_content name="${matchedSkill.prefixedName}">`,
    `# Skill: ${matchedSkill.prefixedName}`,
    '',
    body,
    '',
    `Base directory for this skill: ${base}`,
    'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.',
    'Note: file list is sampled.',
  ]

  if (files) {
    lines.push('', '<skill_files>', files, '</skill_files>')
  }

  lines.push('</skill_content>')

  return { output: lines.join('\n'), dir }
}

/**
 * Discovers skill files in a directory and formats them as XML tags.
 * Recursively searches subdirectories, includes hidden files, excludes .git and SKILL.md.
 * Matches OpenCode v1.1.50 behavior exactly.
 *
 * @param dir - Directory path to search for skill files
 * @param limit - Maximum number of files to return (default: 10)
 * @returns String with absolute file paths formatted as XML tags, one per line
 */
export function discoverSkillFiles(dir: string, limit = 10): string {
  const files: string[] = []

  function shouldSkipDirectory(name: string): boolean {
    return name === '.git'
  }

  function shouldIncludeFile(name: string): boolean {
    return name !== 'SKILL.md'
  }

  function handleEntry(entry: fs.Dirent, currentDir: string): void {
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) {
        recurse(path.resolve(currentDir, entry.name))
      }
    } else if (shouldIncludeFile(entry.name)) {
      files.push(path.resolve(currentDir, entry.name))
    }
  }

  function recurse(currentDir: string): void {
    if (files.length >= limit) return

    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true })

      for (const entry of entries) {
        if (files.length >= limit) break
        handleEntry(entry, currentDir)
      }
    } catch {
      // Silently ignore read errors
    }
  }

  recurse(dir)
  return files.map((file) => `  <file>${file}</file>`).join('\n')
}
