import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SystematicConfig } from './config.js'
import { parseFrontmatter } from './frontmatter.js'
import { renderCatalogVerbose } from './skill-catalog.js'

// Signatures used to identify OpenCode internal agents (title generator,
// summarizer, etc.) so bootstrap injection can be skipped. Exported for
// test access — must NOT be re-exported from the plugin entry point
// (src/index.ts) because OpenCode's plugin loader expects a single function
// export; additional named exports break loading.
export const INTERNAL_AGENT_SIGNATURES = [
  'You are a title generator',
  'You are a helpful AI assistant tasked with summarizing conversations',
  'Summarize what was done in this conversation',
]

const BOOTSTRAP_MARKER_OPEN = '<SYSTEMATIC_WORKFLOWS>'
const BOOTSTRAP_MARKER_CLOSE = '</SYSTEMATIC_WORKFLOWS>'

const findBootstrapMarkerBlock = (
  entry: string,
  fromIndex = 0,
): { start: number; closeStart: number; end: number } | null => {
  const start = entry.indexOf(BOOTSTRAP_MARKER_OPEN, fromIndex)
  if (start === -1) return null
  const closeStart = entry.indexOf(
    BOOTSTRAP_MARKER_CLOSE,
    start + BOOTSTRAP_MARKER_OPEN.length,
  )
  if (closeStart === -1) return null
  return { start, closeStart, end: closeStart + BOOTSTRAP_MARKER_CLOSE.length }
}

const removeCompleteBootstrapBlocks = (entry: string): string => {
  const segments: string[] = []
  let cursor = 0
  let block = findBootstrapMarkerBlock(entry, cursor)
  let hadNestedBlock = false

  while (block !== null) {
    const nestedStart = entry.indexOf(
      BOOTSTRAP_MARKER_OPEN,
      block.start + BOOTSTRAP_MARKER_OPEN.length,
    )

    if (nestedStart !== -1 && nestedStart < block.closeStart) {
      hadNestedBlock = true
      segments.push(entry.slice(cursor, nestedStart))
      cursor = nestedStart
      block = findBootstrapMarkerBlock(entry, cursor)
      continue
    }

    segments.push(entry.slice(cursor, block.start))
    cursor = block.end
    block = findBootstrapMarkerBlock(entry, cursor)
  }

  if (cursor === 0) return entry
  segments.push(entry.slice(cursor))
  const result = segments.join('')

  // When nested blocks are removed, previously truncated outer open/close
  // markers may now form a complete block. Recurse once to clean up in a
  // single call rather than requiring a second transform invocation.
  if (hadNestedBlock) {
    return removeCompleteBootstrapBlocks(result)
  }

  return result
}

/**
 * Inject bootstrap content into the system prompt array, placing exactly one
 * canonical block at the end of `output.system[0]`.
 *
 * All complete `<SYSTEMATIC_WORKFLOWS>…</SYSTEMATIC_WORKFLOWS>` blocks are
 * removed from every system entry first, then the current content is appended
 * once to `output.system[0]`. Partial/malformed marker fragments are left
 * untouched. This makes duplicate registration and prior last-entry placement
 * converge to the new canonical location; later invocations win.
 *
 * Exported for test access — must NOT be re-exported from the plugin entry
 * point (src/index.ts) because OpenCode's plugin loader expects a single
 * function export; additional named exports break loading. See
 * `docs/solutions/integration-issues/` for the v2.5.0 and v2.12.1 incidents.
 */
export const applyBootstrapContent = (
  output: { system: string[] },
  content: string,
): void => {
  // Remove every complete marker block from every entry.
  for (let i = 0; i < output.system.length; i++) {
    output.system[i] = removeCompleteBootstrapBlocks(output.system[i])
  }

  if (output.system.length === 0) {
    output.system.push(content)
    return
  }

  const first = output.system[0]
  output.system[0] = first.length > 0 ? `${first}\n\n${content}` : content
}

export interface BootstrapDeps {
  bundledSkillsDir: string
  usageTemplate?: string
  profileBlock?: string
}

/** Reads a harness capability profile from the packaged using-systematic references. */
export function readHarnessProfile(
  bundledSkillsDir: string,
  name: string,
): string | null {
  const profilePath = path.join(
    bundledSkillsDir,
    'using-systematic/references',
    `${name}-profile.md`,
  )
  try {
    return fs.readFileSync(profilePath, 'utf8')
  } catch (error) {
    console.error(
      `Failed to read harness profile ${profilePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

type BootstrapContentConfig = Pick<
  SystematicConfig,
  'bootstrap' | 'disabled_skills'
>

const DEFAULT_BOOTSTRAP_CONFIG: BootstrapContentConfig = {
  bootstrap: { enabled: true },
  disabled_skills: [],
}

/** Safely computes default bootstrap content, returning null instead of throwing. */
export function computeBootstrapContentSafe(
  deps: BootstrapDeps,
  reportError?: (error: unknown) => void,
): string | null {
  try {
    return getBootstrapContent(DEFAULT_BOOTSTRAP_CONFIG, deps)
  } catch (error) {
    if (reportError !== undefined) {
      try {
        reportError(error)
      } catch {
        // Ignore reporter failures so startup stays non-blocking.
      }
    }
    return null
  }
}

/** Composes an existing system prompt with nullable bootstrap content; returns null when bootstrapContent is null. */
export function composeSystemPromptWithBootstrap(
  existingSystemPrompt: string,
  bootstrapContent: string | null,
): string | null {
  if (bootstrapContent === null) return null

  if (
    existingSystemPrompt === bootstrapContent ||
    existingSystemPrompt.endsWith(`\n\n${bootstrapContent}`)
  ) {
    return existingSystemPrompt
  }

  return existingSystemPrompt.length > 0
    ? `${existingSystemPrompt}\n\n${bootstrapContent}`
    : bootstrapContent
}

function getSkillUsageTemplate(): string {
  return `**Skills naming:**
- Systematic bundled skills use the \`systematic:\` prefix (e.g., \`systematic:onboarding\`)
- Workflow skills with their own namespace keep it (e.g., \`ce:brainstorm\`)
- Skills can also be invoked without prefix if unambiguous

**Skills usage:**
- Use \`systematic_skill\` to load Systematic bundled skills
- Use the \`skill\` tool for non-Systematic skills

**Skills location:**
Bundled skills ship with the Systematic plugin and are discoverable via \`systematic_skill\`.`
}

export function getBootstrapContent(
  config: BootstrapContentConfig,
  deps: BootstrapDeps,
): string | null {
  const { bundledSkillsDir, usageTemplate, profileBlock } = deps

  if (!config.bootstrap.enabled) return null

  if (config.bootstrap.file) {
    const customPath = config.bootstrap.file.startsWith('~/')
      ? path.join(os.homedir(), config.bootstrap.file.slice(2))
      : config.bootstrap.file
    if (fs.existsSync(customPath)) {
      return fs.readFileSync(customPath, 'utf8')
    }
  }

  const usingSystematicPath = path.join(
    bundledSkillsDir,
    'using-systematic/SKILL.md',
  )
  if (!fs.existsSync(usingSystematicPath)) return null

  const fullContent = fs.readFileSync(usingSystematicPath, 'utf8')
  const { body } = parseFrontmatter(fullContent)
  const content = body.trim()
  const skillUsage = usageTemplate ?? getSkillUsageTemplate()
  const catalog = renderCatalogVerbose({
    bundledSkillsDir,
    disabledSkills: config.disabled_skills,
  })
  const catalogSection = catalog.length > 0 ? `\n\n${catalog}` : ''

  const profileSection = profileBlock === undefined ? '' : `\n\n${profileBlock}`

  return `<SYSTEMATIC_WORKFLOWS>
You have access to structured engineering workflows via the Systematic plugin.

**IMPORTANT: The using-systematic skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the systematic_skill tool to load "using-systematic" again - that would be redundant.**

${content}

${skillUsage}${profileSection}${catalogSection}
</SYSTEMATIC_WORKFLOWS>`
}
