import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from '@opencode-ai/plugin'
import { loadConfig, type SystematicConfig } from './lib/config.js'
import { createConfigHandler } from './lib/config-handler.js'
import { createSkillTool } from './lib/skill-tool.js'
import * as skillsCore from './lib/skills-core.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const packageRoot = path.resolve(__dirname, '..')
const bundledSkillsDir = path.join(packageRoot, 'skills')
const bundledAgentsDir = path.join(packageRoot, 'agents')
const bundledCommandsDir = path.join(packageRoot, 'commands')
const packageJsonPath = path.join(packageRoot, 'package.json')
let hasLoggedInit = false

const getPackageVersion = (): string => {
  try {
    if (!fs.existsSync(packageJsonPath)) return 'unknown'
    const content = fs.readFileSync(packageJsonPath, 'utf8')
    const parsed = JSON.parse(content) as { version?: string }
    return parsed.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const getBootstrapContent = (config: SystematicConfig): string | null => {
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
  const content = skillsCore.stripFrontmatter(fullContent)

  const toolMapping = `**Tool Mapping for OpenCode:**
When skills reference tools you don't have, substitute OpenCode equivalents:
- \`TodoWrite\` → \`update_plan\`
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

  return `<SYSTEMATIC_WORKFLOWS>
You have access to structured engineering workflows via the systematic plugin.

**IMPORTANT: The using-systematic skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the systematic_skill tool to load "using-systematic" again - that would be redundant.**

${content}

${toolMapping}
</SYSTEMATIC_WORKFLOWS>`
}

export const SystematicPlugin: Plugin = async ({ client, directory }) => {
  const config = loadConfig(directory)

  const configHandler = createConfigHandler({
    directory,
    bundledSkillsDir,
    bundledAgentsDir,
    bundledCommandsDir,
  })

  return {
    config: configHandler,

    tool: {
      systematic_skill: createSkillTool({
        bundledSkillsDir,
        disabledSkills: config.disabled_skills,
      }),
    },

    'experimental.chat.system.transform': async (_input, output) => {
      if (!hasLoggedInit) {
        hasLoggedInit = true
        const packageVersion = getPackageVersion()
        try {
          await client.app.log({
            body: {
              service: 'systematic',
              level: 'info',
              message: 'Systematic plugin initialized',
              extra: {
                version: packageVersion,
                bootstrapEnabled: config.bootstrap.enabled,
                disabledSkillsCount: config.disabled_skills.length,
                disabledAgentsCount: config.disabled_agents.length,
                disabledCommandsCount: config.disabled_commands.length,
              },
            },
          })
        } catch {
          // ignore logging failures to avoid blocking the hook
        }
      }

      // Skip for title generation requests
      const existingSystem = output.system.join('\n').toLowerCase()
      if (
        existingSystem.includes('title generator') ||
        existingSystem.includes('generate a title')
      ) {
        return
      }
      const content = getBootstrapContent(config)
      if (content) {
        if (!output.system) {
          output.system = []
        }
        output.system.push(content)
      }
    },
  }
}

export default SystematicPlugin
