import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SystematicConfig } from './config.js'
import { parseFrontmatter } from './frontmatter.js'

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
): { start: number; end: number } | null => {
  const start = entry.indexOf(BOOTSTRAP_MARKER_OPEN)
  if (start === -1) return null
  const closeStart = entry.indexOf(
    BOOTSTRAP_MARKER_CLOSE,
    start + BOOTSTRAP_MARKER_OPEN.length,
  )
  if (closeStart === -1) return null
  return { start, end: closeStart + BOOTSTRAP_MARKER_CLOSE.length }
}

/**
 * Inject bootstrap content into the system prompt array, replacing any
 * existing `<SYSTEMATIC_WORKFLOWS>` block. Multi-load idempotency is via
 * the marker — most-recently-registered plugin wins under FIFO hook order.
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
  for (let i = 0; i < output.system.length; i++) {
    const entry = output.system[i]
    const block = findBootstrapMarkerBlock(entry)
    if (block !== null) {
      output.system[i] =
        entry.slice(0, block.start) + content + entry.slice(block.end)
      return
    }
  }
  if (output.system.length > 0) {
    output.system[output.system.length - 1] += `\n\n${content}`
  } else {
    output.system.push(content)
  }
}

export interface BootstrapDeps {
  bundledSkillsDir: string
}

function getToolMappingTemplate(): string {
  return `**Tool Mapping for OpenCode:**
When skills reference tools you don't have, substitute OpenCode equivalents:
- \`TodoWrite\` → \`todowrite\`
- \`Task\` tool with subagents → Use OpenCode's subagent system (@mention)
- \`Skill\` tool → OpenCode's native \`skill\` tool
- \`SystematicSkill\` tool → \`systematic_skill\` (Systematic plugin skills)
- \`Read\`, \`Write\`, \`Edit\`, \`Bash\` → Your native tools

**Skills naming:**
- Bundled skills use the \`systematic:\` prefix (e.g., \`systematic:brainstorming\`)
- Skills can also be invoked without prefix if unambiguous

**Skills usage:**
- Use \`systematic_skill\` to load Systematic bundled skills
- Use the native \`skill\` tool for non-Systematic skills

**Skills location:**
Bundled skills ship with the Systematic plugin and are discoverable via \`systematic_skill\`.`
}

export function getBootstrapContent(
  config: SystematicConfig,
  deps: BootstrapDeps,
): string | null {
  const { bundledSkillsDir } = deps

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
  const toolMapping = getToolMappingTemplate()

  return `<SYSTEMATIC_WORKFLOWS>
You have access to structured engineering workflows via the systematic plugin.

**IMPORTANT: The using-systematic skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the systematic_skill tool to load "using-systematic" again - that would be redundant.**

${content}

${toolMapping}
</SYSTEMATIC_WORKFLOWS>`
}
