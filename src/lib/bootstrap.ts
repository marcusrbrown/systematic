import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SystematicConfig } from './config.js'
import { parseFrontmatter } from './frontmatter.js'

export interface BootstrapDeps {
  bundledSkillsDir: string
}

function getToolMappingTemplate(bundledSkillsDir: string): string {
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
Bundled skills are in \`${bundledSkillsDir}/\``
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
  const toolMapping = getToolMappingTemplate(bundledSkillsDir)

  return `<SYSTEMATIC_WORKFLOWS>
You have access to structured engineering workflows via the systematic plugin.

**IMPORTANT: The using-systematic skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the systematic_skill tool to load "using-systematic" again - that would be redundant.**

${content}

${toolMapping}
</SYSTEMATIC_WORKFLOWS>`
}
