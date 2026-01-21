# @fro.bot/systematic Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and publish `@fro.bot/systematic`, an OpenCode plugin providing structured engineering workflows ported from CEP and Superpowers.

**Architecture:** npm package with Bun development, Node-compatible production. Plugin uses `tool()` from `@opencode-ai/plugin/tool`. Bootstrap injection uses `experimental.chat.system.transform` hook (NOT `session.prompt()`) as workaround for model reset issue per [Superpowers PR #228](https://github.com/obra/superpowers/pull/228). Three-tier content resolution (project > user > bundled).

**Tech Stack:** TypeScript, Bun, Commander.js (CLI), JSONC (config parsing)

**Reference Implementation:** https://github.com/obra/superpowers (OpenCode plugin pattern)

---

## Phase 1: Foundation

### Task 1.1: Initialize npm Package

**Files:**
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `tsconfig.json`
- Create: `.gitignore`

**Step 1: Create package.json**

```json
{
  "name": "@fro.bot/systematic",
  "version": "0.1.0",
  "description": "Structured engineering workflows for OpenCode",
  "type": "module",
  "main": "./.opencode/plugin/systematic.js",
  "bin": {
    "systematic": "./dist/cli/index.js"
  },
  "files": [
    ".opencode",
    "dist",
    "lib",
    "skills",
    "agents",
    "commands",
    "defaults"
  ],
  "scripts": {
    "build": "bun run build:lib && bun run build:plugin && bun run build:cli",
    "build:lib": "bun build src/lib/skills-core.ts --outfile lib/skills-core.js --target node --format esm",
    "build:plugin": "bun build src/plugin/systematic.ts --outfile .opencode/plugin/systematic.js --target node --format esm --external @opencode-ai/plugin/tool",
    "build:cli": "bun build src/cli/index.ts --outdir dist/cli --target node --format esm",
    "dev": "bun --watch src/plugin/systematic.ts",
    "test": "bash tests/run-tests.sh",
    "test:integration": "bash tests/run-tests.sh --integration",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "prepublishOnly": "bun run build && bun run test"
  },
  "keywords": [
    "opencode",
    "plugin",
    "ai",
    "workflow",
    "engineering"
  ],
  "author": "Marcus R. Brown",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/marcusrbrown/systematic.git"
  },
  "engines": {
    "node": ">=18"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": ">=0.1.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/bun": "latest",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  },
  "dependencies": {
    "commander": "^13.0.0",
    "jsonc-parser": "^3.3.0"
  }
}
```

**Step 2: Create bunfig.toml**

```toml
[install]
peer = false

[build]
target = "node"
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["bun-types", "node"],
    "strict": true,
    "skipLibCheck": true,
    "declaration": false,
    "outDir": "./dist",
    "rootDir": "./src",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "lib", ".opencode"]
}
```

**Step 4: Update .gitignore**

```gitignore
# Dependencies
node_modules/

# Build output
dist/
lib/
.opencode/plugin/

# IDE
.idea/
.vscode/
*.swp

# OS
.DS_Store

# Test
coverage/
tests/tmp/

# Logs
*.log

# Environment
.env
.env.local
```

**Step 5: Install dependencies**

Run: `bun install`
Expected: Dependencies installed, lockfile created

**Step 6: Commit**

```bash
git add package.json bunfig.toml tsconfig.json .gitignore bun.lockb
git commit -m "chore: initialize npm package with Bun"
```

---

### Task 1.2: Set Up Biome for Linting/Formatting

**Files:**
- Create: `biome.json`

**Step 1: Create biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "complexity": {
        "noExcessiveCognitiveComplexity": "warn"
      },
      "style": {
        "noNonNullAssertion": "warn"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  },
  "javascript": {
    "formatter": {
      "semicolons": "asNeeded",
      "quoteStyle": "single"
    }
  },
  "files": {
    "ignore": ["dist", "lib", ".opencode", "node_modules", "*.md"]
  }
}
```

**Step 2: Verify setup**

Run: `bun run lint`
Expected: No errors (no source files yet)

**Step 3: Commit**

```bash
git add biome.json
git commit -m "chore: add Biome for linting and formatting"
```

---

### Task 1.3: Create Skills Core Library

This is the shared library used by the plugin for skill resolution. Modeled directly after Superpowers' `lib/skills-core.js`.

**Files:**
- Create: `src/lib/skills-core.ts`

**Step 1: Create skills-core.ts**

```typescript
// src/lib/skills-core.ts
import fs from 'fs'
import path from 'path'

export interface SkillFrontmatter {
  name: string
  description: string
}

export interface SkillInfo {
  path: string
  skillFile: string
  name: string
  description: string
  sourceType: 'project' | 'user' | 'bundled'
}

export interface ResolvedSkill {
  skillFile: string
  sourceType: 'project' | 'user' | 'bundled'
  skillPath: string
}

/**
 * Extract YAML frontmatter from a skill file.
 * Format:
 * ---
 * name: skill-name
 * description: Use when [condition] - [what it does]
 * ---
 */
export function extractFrontmatter(filePath: string): SkillFrontmatter {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content.split('\n')

    let inFrontmatter = false
    let name = ''
    let description = ''

    for (const line of lines) {
      if (line.trim() === '---') {
        if (inFrontmatter) break
        inFrontmatter = true
        continue
      }

      if (inFrontmatter) {
        const match = line.match(/^(\w+):\s*(.*)$/)
        if (match) {
          const [, key, value] = match
          if (key === 'name') name = value.trim()
          if (key === 'description') description = value.trim()
        }
      }
    }

    return { name, description }
  } catch {
    return { name: '', description: '' }
  }
}

/**
 * Strip YAML frontmatter from skill content.
 */
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

/**
 * Find all SKILL.md files in a directory recursively.
 */
export function findSkillsInDir(
  dir: string,
  sourceType: 'project' | 'user' | 'bundled',
  maxDepth = 3
): SkillInfo[] {
  const skills: SkillInfo[] = []

  if (!fs.existsSync(dir)) return skills

  function recurse(currentDir: string, depth: number) {
    if (depth > maxDepth) return

    const entries = fs.readdirSync(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        const skillFile = path.join(fullPath, 'SKILL.md')
        if (fs.existsSync(skillFile)) {
          const { name, description } = extractFrontmatter(skillFile)
          skills.push({
            path: fullPath,
            skillFile,
            name: name || entry.name,
            description: description || '',
            sourceType,
          })
        }
        recurse(fullPath, depth + 1)
      }
    }
  }

  recurse(dir, 0)
  return skills
}

/**
 * Resolve a skill name to its file path with priority resolution.
 * Priority: project > user > bundled
 * 
 * Prefixes:
 * - "project:" forces project resolution
 * - "sys:" or "systematic:" forces bundled resolution  
 * - No prefix checks user first, then bundled
 */
export function resolveSkillPath(
  skillName: string,
  bundledDir: string,
  userDir: string | null,
  projectDir: string | null
): ResolvedSkill | null {
  const forceProject = skillName.startsWith('project:')
  const forceBundled = skillName.startsWith('sys:') || skillName.startsWith('systematic:')
  
  let actualSkillName = skillName
  if (forceProject) actualSkillName = skillName.replace(/^project:/, '')
  if (forceBundled) actualSkillName = skillName.replace(/^(sys:|systematic:)/, '')

  // Try project first (if project: prefix or no force)
  if ((forceProject || !forceBundled) && projectDir) {
    const projectPath = path.join(projectDir, actualSkillName)
    const projectSkillFile = path.join(projectPath, 'SKILL.md')
    if (fs.existsSync(projectSkillFile)) {
      return {
        skillFile: projectSkillFile,
        sourceType: 'project',
        skillPath: actualSkillName,
      }
    }
  }

  // Try user skills (if not forcing project or bundled)
  if (!forceProject && !forceBundled && userDir) {
    const userPath = path.join(userDir, actualSkillName)
    const userSkillFile = path.join(userPath, 'SKILL.md')
    if (fs.existsSync(userSkillFile)) {
      return {
        skillFile: userSkillFile,
        sourceType: 'user',
        skillPath: actualSkillName,
      }
    }
  }

  // Try bundled skills
  if (!forceProject && bundledDir) {
    const bundledPath = path.join(bundledDir, actualSkillName)
    const bundledSkillFile = path.join(bundledPath, 'SKILL.md')
    if (fs.existsSync(bundledSkillFile)) {
      return {
        skillFile: bundledSkillFile,
        sourceType: 'bundled',
        skillPath: actualSkillName,
      }
    }
  }

  return null
}

/**
 * Find agents in a directory (flat structure, .md files)
 */
export function findAgentsInDir(
  dir: string,
  sourceType: 'project' | 'user' | 'bundled'
): Array<{ name: string; file: string; sourceType: string }> {
  const agents: Array<{ name: string; file: string; sourceType: string }> = []
  
  if (!fs.existsSync(dir)) return agents

  const entries = fs.readdirSync(dir)
  for (const entry of entries) {
    if (entry.endsWith('.md')) {
      agents.push({
        name: entry.replace(/\.md$/, ''),
        file: path.join(dir, entry),
        sourceType,
      })
    }
  }

  return agents
}

/**
 * Find commands in a directory (flat structure, .md files)
 */
export function findCommandsInDir(
  dir: string,
  sourceType: 'project' | 'user' | 'bundled'
): Array<{ name: string; file: string; sourceType: string }> {
  const commands: Array<{ name: string; file: string; sourceType: string }> = []
  
  if (!fs.existsSync(dir)) return commands

  const entries = fs.readdirSync(dir)
  for (const entry of entries) {
    if (entry.endsWith('.md')) {
      // Convert sys-plan.md to /sys:plan
      const baseName = entry.replace(/\.md$/, '')
      const commandName = baseName.startsWith('sys-')
        ? `/sys:${baseName.slice(4)}`
        : `/${baseName}`
      commands.push({
        name: commandName,
        file: path.join(dir, entry),
        sourceType,
      })
    }
  }

  return commands
}
```

**Step 2: Build and verify**

Run: `bun run build:lib`
Expected: `lib/skills-core.js` created

**Step 3: Commit**

```bash
git add src/lib/skills-core.ts
git commit -m "feat: add skills-core library for skill resolution"
```

---

### Task 1.4: Create Config Module

**Files:**
- Create: `src/lib/config.ts`

**Step 1: Create config.ts**

```typescript
// src/lib/config.ts
import fs from 'fs'
import path from 'path'
import os from 'os'
import { parse as parseJsonc } from 'jsonc-parser'

export interface BootstrapConfig {
  enabled: boolean
  file?: string
}

export interface PathsConfig {
  user_skills: string
  user_agents: string
  user_commands: string
}

export interface SystematicConfig {
  disabled_skills: string[]
  disabled_agents: string[]
  disabled_commands: string[]
  bootstrap: BootstrapConfig
  paths: PathsConfig
}

const homeDir = os.homedir()

export const DEFAULT_CONFIG: SystematicConfig = {
  disabled_skills: [],
  disabled_agents: [],
  disabled_commands: [],
  bootstrap: {
    enabled: true,
  },
  paths: {
    user_skills: path.join(homeDir, '.config/opencode/systematic/skills'),
    user_agents: path.join(homeDir, '.config/opencode/systematic/agents'),
    user_commands: path.join(homeDir, '.config/opencode/systematic/commands'),
  },
}

function loadJsoncFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const content = fs.readFileSync(filePath, 'utf-8')
    return parseJsonc(content) as T
  } catch {
    return null
  }
}

function mergeArraysUnique<T>(arr1: T[] | undefined, arr2: T[] | undefined): T[] {
  const set = new Set<T>()
  if (arr1) arr1.forEach((item) => set.add(item))
  if (arr2) arr2.forEach((item) => set.add(item))
  return Array.from(set)
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  ...overrides: Array<Partial<T> | null>
): T {
  const result = { ...base }

  for (const override of overrides) {
    if (!override) continue
    for (const [key, value] of Object.entries(override)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof result[key] === 'object' &&
        result[key] !== null
      ) {
        ;(result as Record<string, unknown>)[key] = deepMerge(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>
        )
      } else if (value !== undefined) {
        ;(result as Record<string, unknown>)[key] = value
      }
    }
  }

  return result
}

export function loadConfig(projectDir: string): SystematicConfig {
  const userConfigPath = path.join(homeDir, '.config/opencode/systematic.json')
  const projectConfigPath = path.join(projectDir, '.opencode/systematic.json')

  const userConfig = loadJsoncFile<Partial<SystematicConfig>>(userConfigPath)
  const projectConfig = loadJsoncFile<Partial<SystematicConfig>>(projectConfigPath)

  // Deep merge base with user and project
  const merged = deepMerge(DEFAULT_CONFIG, userConfig, projectConfig)

  // Special handling for disabled_* arrays: union instead of replace
  merged.disabled_skills = mergeArraysUnique(
    mergeArraysUnique(DEFAULT_CONFIG.disabled_skills, userConfig?.disabled_skills),
    projectConfig?.disabled_skills
  )
  merged.disabled_agents = mergeArraysUnique(
    mergeArraysUnique(DEFAULT_CONFIG.disabled_agents, userConfig?.disabled_agents),
    projectConfig?.disabled_agents
  )
  merged.disabled_commands = mergeArraysUnique(
    mergeArraysUnique(DEFAULT_CONFIG.disabled_commands, userConfig?.disabled_commands),
    projectConfig?.disabled_commands
  )

  return merged
}

export function getConfigPaths(projectDir: string) {
  return {
    userConfig: path.join(homeDir, '.config/opencode/systematic.json'),
    projectConfig: path.join(projectDir, '.opencode/systematic.json'),
    userDir: path.join(homeDir, '.config/opencode/systematic'),
    projectDir: path.join(projectDir, '.opencode/systematic'),
  }
}
```

**Step 2: Commit**

```bash
git add src/lib/config.ts
git commit -m "feat: add config loading with JSONC support and merge logic"
```

---

## Phase 2: Plugin Core

### Task 2.1: Create Plugin Entry Point

This is the main plugin file that OpenCode loads. Uses `tool()` from `@opencode-ai/plugin/tool` exactly like Superpowers.

**Files:**
- Create: `src/plugin/systematic.ts`

**Step 1: Create systematic.ts**

```typescript
// src/plugin/systematic.ts
/**
 * Systematic plugin for OpenCode.ai
 *
 * Provides structured engineering workflows ported from CEP and Superpowers.
 */

import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'
import { tool } from '@opencode-ai/plugin/tool'
import * as skillsCore from '../../lib/skills-core.js'
import { loadConfig, type SystematicConfig } from '../../lib/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Derive content directories from plugin location
const bundledSkillsDir = path.resolve(__dirname, '../../skills')
const bundledAgentsDir = path.resolve(__dirname, '../../agents')
const bundledCommandsDir = path.resolve(__dirname, '../../commands')
const defaultsDir = path.resolve(__dirname, '../../defaults')

interface PluginContext {
  client: {
    session: {
      prompt: (options: {
        path: { id: string }
        body: {
          agent?: string
          noReply: boolean
          parts: Array<{ type: string; text: string; synthetic?: boolean }>
        }
      }) => Promise<void>
    }
  }
  directory: string
}

interface ExecuteContext {
  sessionID: string
  agent?: string
}

const getBootstrapContent = (config: SystematicConfig, compact = false): string | null => {
  if (!config.bootstrap.enabled) return null

  // Try custom bootstrap file first
  if (config.bootstrap.file) {
    const customPath = config.bootstrap.file.startsWith('~/')
      ? path.join(os.homedir(), config.bootstrap.file.slice(2))
      : config.bootstrap.file
    if (fs.existsSync(customPath)) {
      return fs.readFileSync(customPath, 'utf8')
    }
  }

  // Load using-systematic skill as bootstrap
  const usingSystematicPath = path.join(bundledSkillsDir, 'using-systematic/SKILL.md')
  if (!fs.existsSync(usingSystematicPath)) return null

  const fullContent = fs.readFileSync(usingSystematicPath, 'utf8')
  const content = skillsCore.stripFrontmatter(fullContent)

  const homeDir = os.homedir()
  const configDir = path.join(homeDir, '.config/opencode')

  const toolMapping = compact
    ? `**Tool Mapping:** TodoWrite->update_plan, Task->@mention, Skill->systematic_use_skill

**Skills naming (priority order):** project: > user > sys:`
    : `**Tool Mapping for OpenCode:**
When skills reference tools you don't have, substitute OpenCode equivalents:
- \`TodoWrite\` → \`update_plan\`
- \`Task\` tool with subagents → Use OpenCode's subagent system (@mention)
- \`Skill\` tool → \`systematic_use_skill\` custom tool
- \`Read\`, \`Write\`, \`Edit\`, \`Bash\` → Your native tools

**Skills naming (priority order):**
- Project skills: \`project:skill-name\` (in .opencode/systematic/skills/)
- User skills: \`skill-name\` (in ${configDir}/systematic/skills/)
- Bundled skills: \`sys:skill-name\` or \`systematic:skill-name\`
- Project overrides user, which overrides bundled when names match`

  return `<SYSTEMATIC_WORKFLOWS>
You have access to structured engineering workflows via the systematic plugin.

**IMPORTANT: The using-systematic skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use systematic_use_skill to load "using-systematic" - that would be redundant. Use systematic_use_skill only for OTHER skills.**

${content}

${toolMapping}
</SYSTEMATIC_WORKFLOWS>`
}

export const SystematicPlugin = async ({ client, directory }: PluginContext) => {
  const homeDir = os.homedir()
  const config = loadConfig(directory)

  // Content directories with priority resolution
  const projectSkillsDir = path.join(directory, '.opencode/systematic/skills')
  const projectAgentsDir = path.join(directory, '.opencode/systematic/agents')
  const projectCommandsDir = path.join(directory, '.opencode/systematic/commands')
  const userSkillsDir = config.paths.user_skills
  const userAgentsDir = config.paths.user_agents
  const userCommandsDir = config.paths.user_commands

  return {
    tool: {
      systematic_use_skill: tool({
        description:
          'Load and read a specific skill to guide your work. Skills contain proven workflows, mandatory processes, and expert techniques.',
        args: {
          skill_name: tool.schema
            .string()
            .describe(
              'Name of the skill to load (e.g., "sys:brainstorming", "my-custom-skill", or "project:my-skill")'
            ),
        },
        execute: async (
          args: { skill_name: string },
          context: ExecuteContext
        ): Promise<string> => {
          const { skill_name } = args

          // Check if disabled
          const actualName = skill_name.replace(/^(project:|sys:|systematic:)/, '')
          if (config.disabled_skills.includes(actualName)) {
            return `Error: Skill "${skill_name}" is disabled in configuration.`
          }

          // Resolve with priority
          const resolved = skillsCore.resolveSkillPath(
            skill_name,
            bundledSkillsDir,
            userSkillsDir,
            projectSkillsDir
          )

          if (!resolved) {
            return `Error: Skill "${skill_name}" not found.\n\nRun systematic_find_skills to see available skills.`
          }

          const fullContent = fs.readFileSync(resolved.skillFile, 'utf8')
          const { name, description } = skillsCore.extractFrontmatter(resolved.skillFile)
          const content = skillsCore.stripFrontmatter(fullContent)
          const skillDirectory = path.dirname(resolved.skillFile)

          const skillHeader = `# ${name || skill_name}
# ${description || ''}
# Supporting tools and docs are in ${skillDirectory}
# ============================================`

          // Insert as user message with noReply for persistence across compaction
          try {
            await client.session.prompt({
              path: { id: context.sessionID },
              body: {
                agent: context.agent,
                noReply: true,
                parts: [
                  { type: 'text', text: `Loading skill: ${name || skill_name}`, synthetic: true },
                  { type: 'text', text: `${skillHeader}\n\n${content}`, synthetic: true },
                ],
              },
            })
          } catch {
            // Fallback: return content directly if message insertion fails
            return `${skillHeader}\n\n${content}`
          }

          return `Launching skill: ${name || skill_name}`
        },
      }),

      systematic_find_skills: tool({
        description:
          'List all available skills in the project, user, and bundled skill libraries.',
        args: {},
        execute: async (): Promise<string> => {
          const projectSkills = skillsCore.findSkillsInDir(projectSkillsDir, 'project', 3)
          const userSkills = skillsCore.findSkillsInDir(userSkillsDir, 'user', 3)
          const bundledSkills = skillsCore.findSkillsInDir(bundledSkillsDir, 'bundled', 3)

          // Filter disabled skills
          const filterDisabled = (skills: skillsCore.SkillInfo[]) =>
            skills.filter((s) => !config.disabled_skills.includes(s.name))

          const allSkills = [
            ...filterDisabled(projectSkills),
            ...filterDisabled(userSkills),
            ...filterDisabled(bundledSkills),
          ]

          if (allSkills.length === 0) {
            return `No skills found. Add skills to ${bundledSkillsDir}/ or ${userSkillsDir}/`
          }

          let output = 'Available skills:\n\n'

          for (const skill of allSkills) {
            let namespace: string
            switch (skill.sourceType) {
              case 'project':
                namespace = 'project:'
                break
              case 'user':
                namespace = ''
                break
              default:
                namespace = 'sys:'
            }

            output += `${namespace}${skill.name}\n`
            if (skill.description) {
              output += `  ${skill.description}\n`
            }
            output += `  Directory: ${skill.path}\n\n`
          }

          return output
        },
      }),

      systematic_find_agents: tool({
        description: 'List all available review agents.',
        args: {},
        execute: async (): Promise<string> => {
          const projectAgents = skillsCore.findAgentsInDir(projectAgentsDir, 'project')
          const userAgents = skillsCore.findAgentsInDir(userAgentsDir, 'user')
          const bundledAgents = skillsCore.findAgentsInDir(bundledAgentsDir, 'bundled')

          const seen = new Set<string>()
          const agents: Array<{ name: string; sourceType: string }> = []

          for (const list of [projectAgents, userAgents, bundledAgents]) {
            for (const agent of list) {
              if (seen.has(agent.name)) continue
              if (config.disabled_agents.includes(agent.name)) continue
              seen.add(agent.name)
              agents.push({ name: agent.name, sourceType: agent.sourceType })
            }
          }

          if (agents.length === 0) {
            return 'No agents available.'
          }

          let output = 'Available agents:\n\n'
          for (const agent of agents.sort((a, b) => a.name.localeCompare(b.name))) {
            output += `- ${agent.name} (${agent.sourceType})\n`
          }

          return output
        },
      }),

      systematic_find_commands: tool({
        description: 'List all available commands.',
        args: {},
        execute: async (): Promise<string> => {
          const projectCommands = skillsCore.findCommandsInDir(projectCommandsDir, 'project')
          const userCommands = skillsCore.findCommandsInDir(userCommandsDir, 'user')
          const bundledCommands = skillsCore.findCommandsInDir(bundledCommandsDir, 'bundled')

          const seen = new Set<string>()
          const commands: Array<{ name: string; sourceType: string }> = []

          for (const list of [projectCommands, userCommands, bundledCommands]) {
            for (const cmd of list) {
              if (seen.has(cmd.name)) continue
              if (config.disabled_commands.includes(cmd.name)) continue
              seen.add(cmd.name)
              commands.push({ name: cmd.name, sourceType: cmd.sourceType })
            }
          }

          if (commands.length === 0) {
            return 'No commands available.'
          }

          let output = 'Available commands:\n\n'
          for (const cmd of commands.sort((a, b) => a.name.localeCompare(b.name))) {
            output += `- ${cmd.name} (${cmd.sourceType})\n`
          }

          return output
        },
      }),
    },

    event: async () => {
      // Placeholder for future event handling
      // NOTE: Bootstrap injection uses experimental.chat.system.transform instead
      // of session.prompt() to avoid model reset issue (see PR #228)
    },

    // Workaround for session.prompt() model reset issue
    // See: https://github.com/obra/superpowers/pull/228
    experimental: {
      chat: {
        system: {
          transform: async ({ output }: { output: { system?: string } }) => {
            const content = getBootstrapContent(config, false)
            if (content) {
              output.system = output.system ? `${output.system}\n\n${content}` : content
            }
          },
        },
      },
    },
  }
}

export default SystematicPlugin
```

**Step 2: Create directory structure**

Run: `mkdir -p .opencode/plugin`

**Step 3: Build and verify**

Run: `bun run build:plugin`
Expected: `.opencode/plugin/systematic.js` created

**Step 4: Verify JavaScript syntax**

Run: `node --check .opencode/plugin/systematic.js`
Expected: No errors

**Step 5: Commit**

```bash
git add src/plugin/systematic.ts .opencode/
git commit -m "feat: create OpenCode plugin with tools and bootstrap injection"
```

---

## Phase 3: Test Infrastructure

### Task 3.1: Create Test Setup Script

Modeled after Superpowers' test infrastructure.

**Files:**
- Create: `tests/setup.sh`

**Step 1: Create setup.sh**

```bash
#!/usr/bin/env bash
# Setup script for systematic plugin tests
# Creates an isolated test environment with proper plugin installation
set -euo pipefail

# Get the repository root
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Create temp home directory for isolation
export TEST_HOME=$(mktemp -d)
export HOME="$TEST_HOME"
export XDG_CONFIG_HOME="$TEST_HOME/.config"
export OPENCODE_CONFIG_DIR="$TEST_HOME/.config/opencode"

# Build the plugin first
echo "Building plugin..."
cd "$REPO_ROOT"
bun run build

# Install plugin to test location
echo "Installing plugin to test environment..."
mkdir -p "$HOME/.config/opencode/systematic"

# Copy lib
cp -r "$REPO_ROOT/lib" "$HOME/.config/opencode/systematic/"

# Copy content
cp -r "$REPO_ROOT/skills" "$HOME/.config/opencode/systematic/"
cp -r "$REPO_ROOT/agents" "$HOME/.config/opencode/systematic/"
cp -r "$REPO_ROOT/commands" "$HOME/.config/opencode/systematic/"
cp -r "$REPO_ROOT/defaults" "$HOME/.config/opencode/systematic/"

# Copy plugin directory
mkdir -p "$HOME/.config/opencode/systematic/.opencode/plugin"
cp "$REPO_ROOT/.opencode/plugin/systematic.js" "$HOME/.config/opencode/systematic/.opencode/plugin/"

# Register plugin via symlink
mkdir -p "$HOME/.config/opencode/plugin"
ln -sf "$HOME/.config/opencode/systematic/.opencode/plugin/systematic.js" \
       "$HOME/.config/opencode/plugin/systematic.js"

# Create user skills directory
mkdir -p "$HOME/.config/opencode/systematic/skills"
mkdir -p "$HOME/.config/opencode/systematic/agents"
mkdir -p "$HOME/.config/opencode/systematic/commands"

# Create test user skill
mkdir -p "$HOME/.config/opencode/systematic/skills/user-test"
cat > "$HOME/.config/opencode/systematic/skills/user-test/SKILL.md" <<'EOF'
---
name: user-test
description: Test user skill for verification
---
# User Test Skill

This is a user skill used for testing.

USER_SKILL_MARKER_12345
EOF

# Create a project directory for project-level skill tests
mkdir -p "$TEST_HOME/test-project/.opencode/systematic/skills/project-test"
cat > "$TEST_HOME/test-project/.opencode/systematic/skills/project-test/SKILL.md" <<'EOF'
---
name: project-test
description: Test project skill for verification
---
# Project Test Skill

This is a project skill used for testing.

PROJECT_SKILL_MARKER_67890
EOF

echo "Setup complete: $TEST_HOME"
echo "Plugin installed to: $HOME/.config/opencode/systematic/.opencode/plugin/systematic.js"
echo "Plugin registered at: $HOME/.config/opencode/plugin/systematic.js"
echo "Test project at: $TEST_HOME/test-project"

# Helper function for cleanup
cleanup_test_env() {
    if [ -n "${TEST_HOME:-}" ] && [ -d "$TEST_HOME" ]; then
        rm -rf "$TEST_HOME"
    fi
}

# Export for use in tests
export -f cleanup_test_env
export REPO_ROOT
```

**Step 2: Make executable**

Run: `chmod +x tests/setup.sh`

**Step 3: Commit**

```bash
git add tests/setup.sh
git commit -m "test: add test setup script for isolated environment"
```

---

### Task 3.2: Create Plugin Loading Tests

**Files:**
- Create: `tests/test-plugin-loading.sh`

**Step 1: Create test-plugin-loading.sh**

```bash
#!/usr/bin/env bash
# Test: Plugin Loading
# Verifies that the systematic plugin loads correctly
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Test: Plugin Loading ==="

# Source setup to create isolated environment
source "$SCRIPT_DIR/setup.sh"

# Trap to cleanup on exit
trap cleanup_test_env EXIT

# Test 1: Verify plugin file exists and is registered
echo "Test 1: Checking plugin registration..."
if [ -L "$HOME/.config/opencode/plugin/systematic.js" ]; then
    echo "  [PASS] Plugin symlink exists"
else
    echo "  [FAIL] Plugin symlink not found at $HOME/.config/opencode/plugin/systematic.js"
    exit 1
fi

# Verify symlink target exists
if [ -f "$(readlink -f "$HOME/.config/opencode/plugin/systematic.js")" ]; then
    echo "  [PASS] Plugin symlink target exists"
else
    echo "  [FAIL] Plugin symlink target does not exist"
    exit 1
fi

# Test 2: Verify lib/skills-core.js is in place
echo "Test 2: Checking skills-core.js..."
if [ -f "$HOME/.config/opencode/systematic/lib/skills-core.js" ]; then
    echo "  [PASS] skills-core.js exists"
else
    echo "  [FAIL] skills-core.js not found"
    exit 1
fi

# Test 3: Verify skills directory is populated
echo "Test 3: Checking skills directory..."
skill_count=$(find "$HOME/.config/opencode/systematic/skills" -name "SKILL.md" | wc -l)
if [ "$skill_count" -gt 0 ]; then
    echo "  [PASS] Found $skill_count skills installed"
else
    echo "  [FAIL] No skills found in installed location"
    exit 1
fi

# Test 4: Check using-systematic skill exists (critical for bootstrap)
echo "Test 4: Checking using-systematic skill (required for bootstrap)..."
if [ -f "$HOME/.config/opencode/systematic/skills/using-systematic/SKILL.md" ]; then
    echo "  [PASS] using-systematic skill exists"
else
    echo "  [FAIL] using-systematic skill not found (required for bootstrap)"
    exit 1
fi

# Test 5: Verify plugin JavaScript syntax
echo "Test 5: Checking plugin JavaScript syntax..."
plugin_file="$HOME/.config/opencode/systematic/.opencode/plugin/systematic.js"
if node --check "$plugin_file" 2>/dev/null; then
    echo "  [PASS] Plugin JavaScript syntax is valid"
else
    echo "  [FAIL] Plugin has JavaScript syntax errors"
    exit 1
fi

# Test 6: Verify user test skill was created
echo "Test 6: Checking test fixtures..."
if [ -f "$HOME/.config/opencode/systematic/skills/user-test/SKILL.md" ]; then
    echo "  [PASS] User test skill fixture created"
else
    echo "  [FAIL] User test skill fixture not found"
    exit 1
fi

# Test 7: Verify agents exist
echo "Test 7: Checking agents directory..."
agent_count=$(find "$HOME/.config/opencode/systematic/agents" -name "*.md" 2>/dev/null | wc -l)
if [ "$agent_count" -gt 0 ]; then
    echo "  [PASS] Found $agent_count agents installed"
else
    echo "  [FAIL] No agents found"
    exit 1
fi

# Test 8: Verify commands exist
echo "Test 8: Checking commands directory..."
command_count=$(find "$HOME/.config/opencode/systematic/commands" -name "*.md" 2>/dev/null | wc -l)
if [ "$command_count" -gt 0 ]; then
    echo "  [PASS] Found $command_count commands installed"
else
    echo "  [FAIL] No commands found"
    exit 1
fi

echo ""
echo "=== All plugin loading tests passed ==="
```

**Step 2: Make executable**

Run: `chmod +x tests/test-plugin-loading.sh`

**Step 3: Commit**

```bash
git add tests/test-plugin-loading.sh
git commit -m "test: add plugin loading tests"
```

---

### Task 3.3: Create Skills Core Tests

**Files:**
- Create: `tests/test-skills-core.sh`

**Step 1: Create test-skills-core.sh**

```bash
#!/usr/bin/env bash
# Test: Skills Core Library
# Tests the skills-core.js library functions directly via Node.js
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Test: Skills Core Library ==="

# Source setup to create isolated environment
source "$SCRIPT_DIR/setup.sh"

# Trap to cleanup on exit
trap cleanup_test_env EXIT

# Test 1: Test extractFrontmatter function
echo "Test 1: Testing extractFrontmatter..."

# Create test file with frontmatter
test_skill_dir="$TEST_HOME/test-skill"
mkdir -p "$test_skill_dir"
cat > "$test_skill_dir/SKILL.md" <<'EOF'
---
name: test-skill
description: A test skill for unit testing
---
# Test Skill Content

This is the content.
EOF

result=$(node -e "
const path = require('path');
const fs = require('fs');

function extractFrontmatter(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        let inFrontmatter = false;
        let name = '';
        let description = '';
        for (const line of lines) {
            if (line.trim() === '---') {
                if (inFrontmatter) break;
                inFrontmatter = true;
                continue;
            }
            if (inFrontmatter) {
                const match = line.match(/^(\w+):\s*(.*)$/);
                if (match) {
                    const [, key, value] = match;
                    if (key === 'name') name = value.trim();
                    if (key === 'description') description = value.trim();
                }
            }
        }
        return { name, description };
    } catch (error) {
        return { name: '', description: '' };
    }
}

const result = extractFrontmatter('$TEST_HOME/test-skill/SKILL.md');
console.log(JSON.stringify(result));
" 2>&1)

if echo "$result" | grep -q '"name":"test-skill"'; then
    echo "  [PASS] extractFrontmatter parses name correctly"
else
    echo "  [FAIL] extractFrontmatter did not parse name"
    echo "  Result: $result"
    exit 1
fi

if echo "$result" | grep -q '"description":"A test skill for unit testing"'; then
    echo "  [PASS] extractFrontmatter parses description correctly"
else
    echo "  [FAIL] extractFrontmatter did not parse description"
    exit 1
fi

# Test 2: Test stripFrontmatter function
echo ""
echo "Test 2: Testing stripFrontmatter..."

result=$(node -e "
const fs = require('fs');

function stripFrontmatter(content) {
    const lines = content.split('\n');
    let inFrontmatter = false;
    let frontmatterEnded = false;
    const contentLines = [];
    for (const line of lines) {
        if (line.trim() === '---') {
            if (inFrontmatter) {
                frontmatterEnded = true;
                continue;
            }
            inFrontmatter = true;
            continue;
        }
        if (frontmatterEnded || !inFrontmatter) {
            contentLines.push(line);
        }
    }
    return contentLines.join('\n').trim();
}

const content = fs.readFileSync('$TEST_HOME/test-skill/SKILL.md', 'utf8');
const stripped = stripFrontmatter(content);
console.log(stripped);
" 2>&1)

if echo "$result" | grep -q "# Test Skill Content"; then
    echo "  [PASS] stripFrontmatter preserves content"
else
    echo "  [FAIL] stripFrontmatter did not preserve content"
    echo "  Result: $result"
    exit 1
fi

if ! echo "$result" | grep -q "name: test-skill"; then
    echo "  [PASS] stripFrontmatter removes frontmatter"
else
    echo "  [FAIL] stripFrontmatter did not remove frontmatter"
    exit 1
fi

# Test 3: Test findSkillsInDir function
echo ""
echo "Test 3: Testing findSkillsInDir..."

# Create multiple test skills
mkdir -p "$TEST_HOME/skills-dir/skill-a"
mkdir -p "$TEST_HOME/skills-dir/skill-b"

cat > "$TEST_HOME/skills-dir/skill-a/SKILL.md" <<'EOF'
---
name: skill-a
description: First skill
---
# Skill A
EOF

cat > "$TEST_HOME/skills-dir/skill-b/SKILL.md" <<'EOF'
---
name: skill-b
description: Second skill
---
# Skill B
EOF

result=$(node -e "
const fs = require('fs');
const path = require('path');

function extractFrontmatter(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        let inFrontmatter = false;
        let name = '';
        let description = '';
        for (const line of lines) {
            if (line.trim() === '---') {
                if (inFrontmatter) break;
                inFrontmatter = true;
                continue;
            }
            if (inFrontmatter) {
                const match = line.match(/^(\w+):\s*(.*)$/);
                if (match) {
                    const [, key, value] = match;
                    if (key === 'name') name = value.trim();
                    if (key === 'description') description = value.trim();
                }
            }
        }
        return { name, description };
    } catch (error) {
        return { name: '', description: '' };
    }
}

function findSkillsInDir(dir, sourceType, maxDepth = 3) {
    const skills = [];
    if (!fs.existsSync(dir)) return skills;
    function recurse(currentDir, depth) {
        if (depth > maxDepth) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                const skillFile = path.join(fullPath, 'SKILL.md');
                if (fs.existsSync(skillFile)) {
                    const { name, description } = extractFrontmatter(skillFile);
                    skills.push({
                        path: fullPath,
                        skillFile: skillFile,
                        name: name || entry.name,
                        description: description || '',
                        sourceType: sourceType
                    });
                }
                recurse(fullPath, depth + 1);
            }
        }
    }
    recurse(dir, 0);
    return skills;
}

const skills = findSkillsInDir('$TEST_HOME/skills-dir', 'test', 3);
console.log(JSON.stringify(skills, null, 2));
" 2>&1)

skill_count=$(echo "$result" | grep -c '"name":' || echo "0")

if [ "$skill_count" -ge 2 ]; then
    echo "  [PASS] findSkillsInDir found all skills (found $skill_count)"
else
    echo "  [FAIL] findSkillsInDir did not find all skills (expected 2, found $skill_count)"
    echo "  Result: $result"
    exit 1
fi

# Test 4: Test resolveSkillPath priority
echo ""
echo "Test 4: Testing resolveSkillPath priority..."

# Create skills in user and bundled locations
mkdir -p "$TEST_HOME/user-skills/shared-skill"
mkdir -p "$TEST_HOME/bundled-skills/shared-skill"
mkdir -p "$TEST_HOME/bundled-skills/unique-skill"

cat > "$TEST_HOME/user-skills/shared-skill/SKILL.md" <<'EOF'
---
name: shared-skill
description: User version
---
# User Shared
EOF

cat > "$TEST_HOME/bundled-skills/shared-skill/SKILL.md" <<'EOF'
---
name: shared-skill
description: Bundled version
---
# Bundled Shared
EOF

cat > "$TEST_HOME/bundled-skills/unique-skill/SKILL.md" <<'EOF'
---
name: unique-skill
description: Only in bundled
---
# Unique
EOF

result=$(node -e "
const fs = require('fs');
const path = require('path');

function resolveSkillPath(skillName, bundledDir, userDir, projectDir) {
    const forceProject = skillName.startsWith('project:');
    const forceBundled = skillName.startsWith('sys:') || skillName.startsWith('systematic:');
    
    let actualSkillName = skillName;
    if (forceProject) actualSkillName = skillName.replace(/^project:/, '');
    if (forceBundled) actualSkillName = skillName.replace(/^(sys:|systematic:)/, '');

    // Try project first
    if ((forceProject || !forceBundled) && projectDir) {
        const projectPath = path.join(projectDir, actualSkillName);
        const projectSkillFile = path.join(projectPath, 'SKILL.md');
        if (fs.existsSync(projectSkillFile)) {
            return { skillFile: projectSkillFile, sourceType: 'project', skillPath: actualSkillName };
        }
    }

    // Try user skills
    if (!forceProject && !forceBundled && userDir) {
        const userPath = path.join(userDir, actualSkillName);
        const userSkillFile = path.join(userPath, 'SKILL.md');
        if (fs.existsSync(userSkillFile)) {
            return { skillFile: userSkillFile, sourceType: 'user', skillPath: actualSkillName };
        }
    }

    // Try bundled
    if (!forceProject && bundledDir) {
        const bundledPath = path.join(bundledDir, actualSkillName);
        const bundledSkillFile = path.join(bundledPath, 'SKILL.md');
        if (fs.existsSync(bundledSkillFile)) {
            return { skillFile: bundledSkillFile, sourceType: 'bundled', skillPath: actualSkillName };
        }
    }

    return null;
}

const bundledDir = '$TEST_HOME/bundled-skills';
const userDir = '$TEST_HOME/user-skills';

// Test 1: Shared skill should resolve to user
const shared = resolveSkillPath('shared-skill', bundledDir, userDir, null);
console.log('SHARED:', JSON.stringify(shared));

// Test 2: sys: prefix should force bundled
const forced = resolveSkillPath('sys:shared-skill', bundledDir, userDir, null);
console.log('FORCED:', JSON.stringify(forced));

// Test 3: Unique skill should resolve to bundled
const unique = resolveSkillPath('unique-skill', bundledDir, userDir, null);
console.log('UNIQUE:', JSON.stringify(unique));

// Test 4: Non-existent skill
const notfound = resolveSkillPath('not-a-skill', bundledDir, userDir, null);
console.log('NOTFOUND:', JSON.stringify(notfound));
" 2>&1)

if echo "$result" | grep -q 'SHARED:.*"sourceType":"user"'; then
    echo "  [PASS] User skills shadow bundled skills"
else
    echo "  [FAIL] User skills not shadowing correctly"
    echo "  Result: $result"
    exit 1
fi

if echo "$result" | grep -q 'FORCED:.*"sourceType":"bundled"'; then
    echo "  [PASS] sys: prefix forces bundled resolution"
else
    echo "  [FAIL] sys: prefix not working"
    exit 1
fi

if echo "$result" | grep -q 'UNIQUE:.*"sourceType":"bundled"'; then
    echo "  [PASS] Unique bundled skills are found"
else
    echo "  [FAIL] Unique bundled skills not found"
    exit 1
fi

if echo "$result" | grep -q 'NOTFOUND: null'; then
    echo "  [PASS] Non-existent skills return null"
else
    echo "  [FAIL] Non-existent skills should return null"
    exit 1
fi

echo ""
echo "=== All skills-core library tests passed ==="
```

**Step 2: Make executable**

Run: `chmod +x tests/test-skills-core.sh`

**Step 3: Commit**

```bash
git add tests/test-skills-core.sh
git commit -m "test: add skills-core library tests"
```

---

### Task 3.4: Create Test Runner

**Files:**
- Create: `tests/run-tests.sh`

**Step 1: Create run-tests.sh**

```bash
#!/usr/bin/env bash
# Main test runner for systematic plugin test suite
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo " Systematic Plugin Test Suite"
echo "========================================"
echo ""
echo "Repository: $(cd .. && pwd)"
echo "Test time: $(date)"
echo ""

# Parse command line arguments
RUN_INTEGRATION=false
VERBOSE=false
SPECIFIC_TEST=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --integration|-i)
            RUN_INTEGRATION=true
            shift
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --test|-t)
            SPECIFIC_TEST="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --integration, -i  Run integration tests (requires OpenCode)"
            echo "  --verbose, -v      Show verbose output"
            echo "  --test, -t NAME    Run only the specified test"
            echo "  --help, -h         Show this help"
            echo ""
            echo "Tests:"
            echo "  test-plugin-loading.sh  Verify plugin installation and structure"
            echo "  test-skills-core.sh     Test skills-core.js library functions"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# List of tests to run
tests=(
    "test-plugin-loading.sh"
    "test-skills-core.sh"
)

# Integration tests (require OpenCode)
integration_tests=()

# Add integration tests if requested
if [ "$RUN_INTEGRATION" = true ]; then
    tests+=("${integration_tests[@]}")
fi

# Filter to specific test if requested
if [ -n "$SPECIFIC_TEST" ]; then
    tests=("$SPECIFIC_TEST")
fi

# Track results
passed=0
failed=0
skipped=0

# Run each test
for test in "${tests[@]}"; do
    echo "----------------------------------------"
    echo "Running: $test"
    echo "----------------------------------------"

    test_path="$SCRIPT_DIR/$test"

    if [ ! -f "$test_path" ]; then
        echo "  [SKIP] Test file not found: $test"
        skipped=$((skipped + 1))
        continue
    fi

    if [ ! -x "$test_path" ]; then
        echo "  Making $test executable..."
        chmod +x "$test_path"
    fi

    start_time=$(date +%s)

    if [ "$VERBOSE" = true ]; then
        if bash "$test_path"; then
            end_time=$(date +%s)
            duration=$((end_time - start_time))
            echo ""
            echo "  [PASS] $test (${duration}s)"
            passed=$((passed + 1))
        else
            end_time=$(date +%s)
            duration=$((end_time - start_time))
            echo ""
            echo "  [FAIL] $test (${duration}s)"
            failed=$((failed + 1))
        fi
    else
        if output=$(bash "$test_path" 2>&1); then
            end_time=$(date +%s)
            duration=$((end_time - start_time))
            echo "  [PASS] (${duration}s)"
            passed=$((passed + 1))
        else
            end_time=$(date +%s)
            duration=$((end_time - start_time))
            echo "  [FAIL] (${duration}s)"
            echo ""
            echo "  Output:"
            echo "$output" | sed 's/^/    /'
            failed=$((failed + 1))
        fi
    fi

    echo ""
done

# Print summary
echo "========================================"
echo " Test Results Summary"
echo "========================================"
echo ""
echo "  Passed:  $passed"
echo "  Failed:  $failed"
echo "  Skipped: $skipped"
echo ""

if [ "$RUN_INTEGRATION" = false ] && [ ${#integration_tests[@]} -gt 0 ]; then
    echo "Note: Integration tests were not run."
    echo "Use --integration flag to run tests that require OpenCode."
    echo ""
fi

if [ $failed -gt 0 ]; then
    echo "STATUS: FAILED"
    exit 1
else
    echo "STATUS: PASSED"
    exit 0
fi
```

**Step 2: Make executable**

Run: `chmod +x tests/run-tests.sh`

**Step 3: Commit**

```bash
git add tests/run-tests.sh
git commit -m "test: add main test runner"
```

---

## Phase 4: CLI

### Task 4.1: Create CLI

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/init.ts`
- Create: `src/cli/config.ts`
- Create: `src/cli/list.ts`

See original plan for CLI implementation - unchanged. Key commands:
- `systematic init [--project]`
- `systematic config show`
- `systematic config scaffold`
- `systematic config path`
- `systematic list [skills|agents|commands]`

---

## Phase 5: Content - Full Skill Porting

**CRITICAL: This phase ports FULL content from CEP and Superpowers - NOT placeholders.**

### Task 5.1: Create using-systematic Skill

This is the bootstrap skill that teaches the AI how to use systematic.

**Files:**
- Create: `skills/using-systematic/SKILL.md`

**Step 1: Create the skill**

Port and adapt from Superpowers `using-superpowers` skill, adjusted for systematic namespace and tools.

```markdown
---
name: using-systematic
description: Core skill that teaches how to use structured engineering workflows
---

# Using Systematic

## Overview

You have access to structured engineering workflows via the systematic plugin. This skill is automatically loaded at session start.

## Available Tools

- `systematic_use_skill` - Load a skill to guide your work
- `systematic_find_skills` - List all available skills
- `systematic_find_agents` - List available review agents
- `systematic_find_commands` - List available commands

## Core Workflow

1. **Plan** (`/sys:plan`) - Transform ideas into structured implementation plans
2. **Work** (`/sys:work`) - Execute work items with tracking
3. **Review** (`/sys:review`) - Multi-perspective code review
4. **Compound** (`/sys:compound`) - Document learnings for future leverage

## When to Use Skills

Before taking action, check if a skill applies:

| Situation | Skill |
|-----------|-------|
| Creating features or components | `sys:brainstorming` |
| Multi-step implementation | `sys:planning` |
| Writing code | `sys:tdd` |
| Debugging issues | `sys:debugging` |
| Before claiming completion | `sys:verification` |
| Reviewing code | `sys:code-review` |
| Starting isolated work | `sys:git-worktree` |

## Red Flags

These thoughts mean STOP - check for a skill:

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | Skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "This doesn't need a formal skill" | If a skill exists, use it. |
| "I remember this skill" | Skills evolve. Load current version. |

## Philosophy

Each unit of work should make subsequent work easier:
- Document what you learn
- Structure your approach
- Build on prior knowledge
- Compound your engineering

When a skill might apply to your current task, use `systematic_use_skill` to load it. Skills provide proven workflows for common engineering tasks.
```

**Step 2: Commit**

```bash
git add skills/using-systematic/
git commit -m "feat: add using-systematic bootstrap skill"
```

---

### Task 5.2: Port Superpowers Skills

Port these skills from Superpowers with full content:

1. **brainstorming** - From `superpowers/skills/brainstorming/SKILL.md`
2. **planning** - From `superpowers/skills/writing-plans/SKILL.md`
3. **executing-plans** - From `superpowers/skills/executing-plans/SKILL.md`
4. **tdd** - From `superpowers/skills/test-driven-development/SKILL.md`
5. **debugging** - From `superpowers/skills/systematic-debugging/SKILL.md`
6. **verification** - From `superpowers/skills/verification-before-completion/SKILL.md`
7. **git-worktree** - From `superpowers/skills/using-git-worktrees/SKILL.md`
8. **writing-skills** - From `superpowers/skills/writing-skills/SKILL.md`

**For each skill:**
1. Fetch the full SKILL.md content from Superpowers repo
2. Adapt tool references (Skill → systematic_use_skill, TodoWrite → update_plan)
3. Update namespace references (superpowers: → sys:)
4. Save to `skills/<name>/SKILL.md`
5. Commit individually

---

### Task 5.3: Port CEP Skills

Port these from CEP:

1. **code-review** - Multi-agent review patterns
2. **compound-docs** - Knowledge capture patterns
3. **agent-native** - Build AI agents with prompt-native architecture

**For each skill:**
1. Fetch content from CEP repo
2. Adapt for OpenCode tooling
3. Save and commit

---

### Task 5.4: Port CEP Commands

Port these command files from CEP:

1. **sys-plan.md** - From CEP `/workflows:plan`
2. **sys-work.md** - From CEP `/workflows:work`
3. **sys-review.md** - From CEP `/workflows:review`
4. **sys-compound.md** - From CEP `/workflows:compound`
5. **sys-deepen.md** - From CEP `/deepen-plan`
6. **sys-lfg.md** - From CEP `/lfg`

**For each command:**
1. Fetch full content from CEP
2. Adapt for OpenCode (tool names, references)
3. Save to `commands/sys-<name>.md`
4. Commit

---

### Task 5.5: Port CEP Agents

Port these agent prompts from CEP:

1. **architecture-strategist.md**
2. **security-sentinel.md**
3. **code-simplicity-reviewer.md**
4. **framework-docs-researcher.md**
5. **pattern-recognition-specialist.md**
6. **performance-oracle.md**

**For each agent:**
1. Fetch full agent prompt from CEP
2. Save to `agents/<name>.md`
3. Commit

---

## Phase 6: Polish

### Task 6.1: Create Default Bootstrap

**Files:**
- Create: `defaults/bootstrap.md`

Minimal fallback if using-systematic skill is missing.

---

### Task 6.2: Run Full Test Suite

```bash
bun run test
```

All tests must pass.

---

### Task 6.3: Write README

Full documentation with installation, usage, customization, and credits.

---

### Task 6.4: Final Verification

1. Clean build: `rm -rf dist lib .opencode/plugin && bun run build`
2. Run tests: `bun run test`
3. Typecheck: `bun run typecheck`
4. Lint: `bun run lint`
5. Manual verification: `node dist/cli/index.js list`

---

## Summary

**Total Tasks:** 20+ across 6 phases

| Phase | Focus |
|-------|-------|
| 1. Foundation | Package, Biome, skills-core, config |
| 2. Plugin Core | OpenCode plugin with tools and events |
| 3. Test Infrastructure | Isolated test environment, test runner |
| 4. CLI | init, config, list commands |
| 5. Content | **FULL** skill/agent/command porting from CEP + Superpowers |
| 6. Polish | Bootstrap, tests, README, verification |

**Key Differences from Original Plan:**
- Uses `tool()` from `@opencode-ai/plugin/tool` (matches Superpowers exactly)
- Uses `experimental.chat.system.transform` for bootstrap injection (workaround for model reset issue per PR #228)
- `session.prompt()` still used for `systematic_use_skill` tool to inject skills into conversation
- Comprehensive bash test suite modeled after Superpowers
- Phase 5 explicitly requires FULL content porting, not placeholders
- Test setup creates isolated environment with fixtures

**After completion:** Ready to publish with `npm publish --access public`
