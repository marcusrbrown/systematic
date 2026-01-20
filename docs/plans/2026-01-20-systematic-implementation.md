# @fro.bot/systematic Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and publish `@fro.bot/systematic`, an OpenCode plugin providing structured engineering workflows.

**Architecture:** npm package with Bun development, Node-compatible production. Plugin exports tools and uses `experimental.chat.system.transform` for bootstrap injection. Three-tier content resolution (project > user > bundled).

**Tech Stack:** TypeScript, Bun, Commander.js (CLI), JSONC (config parsing)

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
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "systematic": "./dist/cli/index.js"
  },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist",
    "skills",
    "agents",
    "commands",
    "defaults"
  ],
  "scripts": {
    "build": "bun build:plugin && bun build:cli",
    "build:plugin": "bun build src/index.ts --outdir dist --target node --format esm",
    "build:cli": "bun build src/cli/index.ts --outdir dist/cli --target node --format esm",
    "dev": "bun --watch src/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "prepublishOnly": "bun run build"
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
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Update .gitignore**

```gitignore
# Dependencies
node_modules/

# Build output
dist/

# IDE
.idea/
.vscode/
*.swp

# OS
.DS_Store

# Test
coverage/

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
    "ignore": ["dist", "node_modules", "*.md"]
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

### Task 1.3: Implement Path Resolution Utilities

**Files:**
- Create: `src/lib/paths.ts`
- Create: `src/lib/paths.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/paths.test.ts
import { describe, expect, test } from 'bun:test'
import { resolvePath, getConfigPaths, getBundledPath } from './paths'
import { homedir } from 'node:os'
import { join } from 'node:path'

describe('resolvePath', () => {
  test('expands tilde to home directory', () => {
    const result = resolvePath('~/.config/opencode')
    expect(result).toBe(join(homedir(), '.config/opencode'))
  })

  test('returns absolute paths unchanged', () => {
    const result = resolvePath('/usr/local/bin')
    expect(result).toBe('/usr/local/bin')
  })

  test('resolves relative paths from cwd', () => {
    const result = resolvePath('./foo')
    expect(result).toBe(join(process.cwd(), 'foo'))
  })
})

describe('getConfigPaths', () => {
  test('returns user and project config paths', () => {
    const paths = getConfigPaths('/project/dir')
    expect(paths.userConfig).toBe(join(homedir(), '.config/opencode/systematic.json'))
    expect(paths.projectConfig).toBe('/project/dir/.opencode/systematic.json')
  })
})

describe('getBundledPath', () => {
  test('returns path within package for skills', () => {
    const result = getBundledPath('skills')
    expect(result).toContain('skills')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/lib/paths.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// src/lib/paths.ts
import { homedir } from 'node:os'
import { resolve, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export function resolvePath(inputPath: string): string {
  if (inputPath.startsWith('~/')) {
    return join(homedir(), inputPath.slice(2))
  }
  if (isAbsolute(inputPath)) {
    return inputPath
  }
  return resolve(process.cwd(), inputPath)
}

export interface ConfigPaths {
  userConfig: string
  projectConfig: string
  userDir: string
  projectDir: string
}

export function getConfigPaths(projectDir: string): ConfigPaths {
  return {
    userConfig: join(homedir(), '.config/opencode/systematic.json'),
    projectConfig: join(projectDir, '.opencode/systematic.json'),
    userDir: join(homedir(), '.config/opencode/systematic'),
    projectDir: join(projectDir, '.opencode/systematic'),
  }
}

export function getBundledPath(type: 'skills' | 'agents' | 'commands' | 'defaults'): string {
  // Navigate from dist/lib to package root, then to content dir
  return resolve(__dirname, '..', '..', type)
}

export function getPackageRoot(): string {
  return resolve(__dirname, '..', '..')
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/lib/paths.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/paths.ts src/lib/paths.test.ts
git commit -m "feat: add path resolution utilities"
```

---

### Task 1.4: Implement Deep Merge Utility

**Files:**
- Create: `src/lib/deep-merge.ts`
- Create: `src/lib/deep-merge.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/deep-merge.test.ts
import { describe, expect, test } from 'bun:test'
import { deepMerge, mergeArraysUnique } from './deep-merge'

describe('deepMerge', () => {
  test('merges flat objects', () => {
    const result = deepMerge({ a: 1 }, { b: 2 })
    expect(result).toEqual({ a: 1, b: 2 })
  })

  test('later values override earlier', () => {
    const result = deepMerge({ a: 1 }, { a: 2 })
    expect(result).toEqual({ a: 2 })
  })

  test('deeply merges nested objects', () => {
    const result = deepMerge(
      { bootstrap: { enabled: true, file: null } },
      { bootstrap: { file: 'custom.md' } }
    )
    expect(result).toEqual({ bootstrap: { enabled: true, file: 'custom.md' } })
  })

  test('replaces arrays by default', () => {
    const result = deepMerge({ arr: [1, 2] }, { arr: [3, 4] })
    expect(result).toEqual({ arr: [3, 4] })
  })
})

describe('mergeArraysUnique', () => {
  test('deduplicates and merges arrays', () => {
    const result = mergeArraysUnique(['a', 'b'], ['b', 'c'])
    expect(result).toEqual(['a', 'b', 'c'])
  })

  test('handles undefined arrays', () => {
    const result = mergeArraysUnique(undefined, ['a'])
    expect(result).toEqual(['a'])
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/lib/deep-merge.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// src/lib/deep-merge.ts
type PlainObject = Record<string, unknown>

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function deepMerge<T extends PlainObject>(...objects: Partial<T>[]): T {
  const result: PlainObject = {}

  for (const obj of objects) {
    if (!obj) continue

    for (const [key, value] of Object.entries(obj)) {
      if (isPlainObject(value) && isPlainObject(result[key])) {
        result[key] = deepMerge(result[key] as PlainObject, value)
      } else {
        result[key] = value
      }
    }
  }

  return result as T
}

export function mergeArraysUnique<T>(
  arr1: T[] | undefined,
  arr2: T[] | undefined
): T[] {
  const set = new Set<T>()
  if (arr1) arr1.forEach((item) => set.add(item))
  if (arr2) arr2.forEach((item) => set.add(item))
  return Array.from(set)
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/lib/deep-merge.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/deep-merge.ts src/lib/deep-merge.test.ts
git commit -m "feat: add deep merge utility"
```

---

### Task 1.5: Implement Config Loading

**Files:**
- Create: `src/config.ts`
- Create: `src/config.test.ts`
- Create: `src/types.ts`

**Step 1: Create types file**

```typescript
// src/types.ts
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

export const DEFAULT_CONFIG: SystematicConfig = {
  disabled_skills: [],
  disabled_agents: [],
  disabled_commands: [],
  bootstrap: {
    enabled: true,
  },
  paths: {
    user_skills: '~/.config/opencode/systematic/skills',
    user_agents: '~/.config/opencode/systematic/agents',
    user_commands: '~/.config/opencode/systematic/commands',
  },
}
```

**Step 2: Write the failing test**

```typescript
// src/config.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { loadConfig, mergeConfigs } from './config'
import { DEFAULT_CONFIG, type SystematicConfig } from './types'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('mergeConfigs', () => {
  test('merges disabled arrays with deduplication', () => {
    const user: Partial<SystematicConfig> = { disabled_skills: ['a', 'b'] }
    const project: Partial<SystematicConfig> = { disabled_skills: ['b', 'c'] }

    const result = mergeConfigs(DEFAULT_CONFIG, user, project)
    expect(result.disabled_skills).toEqual(['a', 'b', 'c'])
  })

  test('project bootstrap overrides user bootstrap', () => {
    const user: Partial<SystematicConfig> = { bootstrap: { enabled: true, file: 'user.md' } }
    const project: Partial<SystematicConfig> = { bootstrap: { enabled: false } }

    const result = mergeConfigs(DEFAULT_CONFIG, user, project)
    expect(result.bootstrap.enabled).toBe(false)
    expect(result.bootstrap.file).toBe('user.md')
  })
})

describe('loadConfig', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'systematic-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true })
  })

  test('returns default config when no files exist', async () => {
    const config = await loadConfig(tempDir)
    expect(config.bootstrap.enabled).toBe(true)
    expect(config.disabled_skills).toEqual([])
  })

  test('loads and parses project config', async () => {
    await mkdir(join(tempDir, '.opencode'), { recursive: true })
    await writeFile(
      join(tempDir, '.opencode/systematic.json'),
      '{ "disabled_skills": ["test-skill"] }'
    )

    const config = await loadConfig(tempDir)
    expect(config.disabled_skills).toContain('test-skill')
  })
})
```

**Step 3: Run test to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL with "Cannot find module"

**Step 4: Write minimal implementation**

```typescript
// src/config.ts
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { parse as parseJsonc } from 'jsonc-parser'
import { deepMerge, mergeArraysUnique } from './lib/deep-merge'
import { getConfigPaths, resolvePath } from './lib/paths'
import { DEFAULT_CONFIG, type SystematicConfig } from './types'

async function loadJsoncFile<T>(filePath: string): Promise<T | null> {
  const resolved = resolvePath(filePath)
  if (!existsSync(resolved)) {
    return null
  }
  const content = await readFile(resolved, 'utf-8')
  return parseJsonc(content) as T
}

export function mergeConfigs(
  base: SystematicConfig,
  user: Partial<SystematicConfig>,
  project: Partial<SystematicConfig>
): SystematicConfig {
  // Start with deep merge for nested objects
  const merged = deepMerge(base, user, project)

  // Special handling for disabled_* arrays: union instead of replace
  merged.disabled_skills = mergeArraysUnique(
    mergeArraysUnique(base.disabled_skills, user.disabled_skills),
    project.disabled_skills
  )
  merged.disabled_agents = mergeArraysUnique(
    mergeArraysUnique(base.disabled_agents, user.disabled_agents),
    project.disabled_agents
  )
  merged.disabled_commands = mergeArraysUnique(
    mergeArraysUnique(base.disabled_commands, user.disabled_commands),
    project.disabled_commands
  )

  return merged
}

export async function loadConfig(projectDir: string): Promise<SystematicConfig> {
  const paths = getConfigPaths(projectDir)

  const userConfig = await loadJsoncFile<Partial<SystematicConfig>>(paths.userConfig)
  const projectConfig = await loadJsoncFile<Partial<SystematicConfig>>(paths.projectConfig)

  return mergeConfigs(DEFAULT_CONFIG, userConfig ?? {}, projectConfig ?? {})
}
```

**Step 5: Run test to verify it passes**

Run: `bun test src/config.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/types.ts src/config.ts src/config.test.ts
git commit -m "feat: implement config loading with JSONC support"
```

---

## Phase 2: Plugin Core

### Task 2.1: Implement Skills Manager

**Files:**
- Create: `src/lib/skills-core.ts`
- Create: `src/lib/skills-core.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/skills-core.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { SkillsManager } from './skills-core'
import { DEFAULT_CONFIG, type SystematicConfig } from '../types'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('SkillsManager', () => {
  let tempDir: string
  let config: SystematicConfig

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skills-test-'))
    config = {
      ...DEFAULT_CONFIG,
      paths: {
        user_skills: join(tempDir, 'user/skills'),
        user_agents: join(tempDir, 'user/agents'),
        user_commands: join(tempDir, 'user/commands'),
      },
    }
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true })
  })

  test('resolves skill from project tier first', async () => {
    const projectSkillDir = join(tempDir, '.opencode/systematic/skills/test-skill')
    await mkdir(projectSkillDir, { recursive: true })
    await writeFile(join(projectSkillDir, 'SKILL.md'), '# Test Skill\nProject version')

    const manager = new SkillsManager(config, tempDir)
    const skill = await manager.resolve('test-skill')

    expect(skill).not.toBeNull()
    expect(skill?.tier).toBe('project')
    expect(skill?.content).toContain('Project version')
  })

  test('returns null for disabled skills', async () => {
    const configWithDisabled = {
      ...config,
      disabled_skills: ['test-skill'],
    }

    const manager = new SkillsManager(configWithDisabled, tempDir)
    const skill = await manager.resolve('test-skill')

    expect(skill).toBeNull()
  })

  test('lists all available skills', async () => {
    const projectSkillDir = join(tempDir, '.opencode/systematic/skills/skill-a')
    await mkdir(projectSkillDir, { recursive: true })
    await writeFile(join(projectSkillDir, 'SKILL.md'), '# Skill A')

    const userSkillDir = join(config.paths.user_skills, 'skill-b')
    await mkdir(userSkillDir, { recursive: true })
    await writeFile(join(userSkillDir, 'SKILL.md'), '# Skill B')

    const manager = new SkillsManager(config, tempDir)
    const skills = await manager.list()

    expect(skills.length).toBeGreaterThanOrEqual(2)
    expect(skills.find((s) => s.name === 'skill-a')).toBeDefined()
    expect(skills.find((s) => s.name === 'skill-b')).toBeDefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/lib/skills-core.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// src/lib/skills-core.ts
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SystematicConfig } from '../types'
import { getBundledPath, resolvePath } from './paths'

export type SkillTier = 'project' | 'user' | 'bundled'

export interface ResolvedSkill {
  name: string
  tier: SkillTier
  filePath: string
  content: string
}

export interface SkillInfo {
  name: string
  tier: SkillTier
  description?: string
}

export class SkillsManager {
  private config: SystematicConfig
  private projectDir: string

  constructor(config: SystematicConfig, projectDir: string) {
    this.config = config
    this.projectDir = projectDir
  }

  private getSkillDirs(): Array<{ dir: string; tier: SkillTier }> {
    return [
      { dir: join(this.projectDir, '.opencode/systematic/skills'), tier: 'project' },
      { dir: resolvePath(this.config.paths.user_skills), tier: 'user' },
      { dir: getBundledPath('skills'), tier: 'bundled' },
    ]
  }

  async resolve(name: string): Promise<ResolvedSkill | null> {
    if (this.config.disabled_skills.includes(name)) {
      return null
    }

    for (const { dir, tier } of this.getSkillDirs()) {
      const skillFile = join(dir, name, 'SKILL.md')
      if (existsSync(skillFile)) {
        const content = await readFile(skillFile, 'utf-8')
        return { name, tier, filePath: skillFile, content }
      }
    }

    return null
  }

  async list(): Promise<SkillInfo[]> {
    const seen = new Set<string>()
    const skills: SkillInfo[] = []

    for (const { dir, tier } of this.getSkillDirs()) {
      if (!existsSync(dir)) continue

      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (seen.has(entry.name)) continue
        if (this.config.disabled_skills.includes(entry.name)) continue

        const skillFile = join(dir, entry.name, 'SKILL.md')
        if (existsSync(skillFile)) {
          seen.add(entry.name)
          const content = await readFile(skillFile, 'utf-8')
          const description = this.extractDescription(content)
          skills.push({ name: entry.name, tier, description })
        }
      }
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  private extractDescription(content: string): string | undefined {
    // Look for first line starting with # (title), take second line as description
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.startsWith('# ')) {
        const nextLine = lines[i + 1]?.trim()
        if (nextLine && !nextLine.startsWith('#')) {
          return nextLine
        }
      }
    }
    return undefined
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/lib/skills-core.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/skills-core.ts src/lib/skills-core.test.ts
git commit -m "feat: implement skills manager with three-tier resolution"
```

---

### Task 2.2: Implement Bootstrap Module

**Files:**
- Create: `src/bootstrap.ts`
- Create: `defaults/bootstrap.md`

**Step 1: Create default bootstrap prompt**

```markdown
<!-- defaults/bootstrap.md -->
# Systematic Engineering Workflows

You have access to structured engineering workflows via the `systematic` plugin.

## Available Tools

- `systematic_find_skills` — List all available skills
- `systematic_use_skill` — Load a skill into context
- `systematic_find_agents` — List available review agents
- `systematic_find_commands` — List available commands

## Core Workflow

1. **Plan** (`/sys:plan`) — Transform ideas into structured implementation plans
2. **Work** (`/sys:work`) — Execute work items with tracking
3. **Review** (`/sys:review`) — Multi-perspective code review
4. **Compound** (`/sys:compound`) — Document learnings for future leverage

## Philosophy

Each unit of work should make subsequent work easier. Document what you learn, structure your approach, and build on prior knowledge.

When a skill might apply to your current task, use `systematic_use_skill` to load it. Skills provide proven workflows for common engineering tasks like TDD, debugging, and code review.
```

**Step 2: Create bootstrap module**

```typescript
// src/bootstrap.ts
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SystematicConfig } from './types'
import { getBundledPath, resolvePath } from './lib/paths'

export async function getBootstrapContent(config: SystematicConfig): Promise<string | null> {
  if (!config.bootstrap.enabled) {
    return null
  }

  // User override takes precedence
  if (config.bootstrap.file) {
    const customPath = resolvePath(config.bootstrap.file)
    if (existsSync(customPath)) {
      return await readFile(customPath, 'utf-8')
    }
  }

  // Fall back to bundled default
  const defaultPath = join(getBundledPath('defaults'), 'bootstrap.md')
  if (existsSync(defaultPath)) {
    return await readFile(defaultPath, 'utf-8')
  }

  return null
}
```

**Step 3: Commit**

```bash
git add src/bootstrap.ts defaults/bootstrap.md
git commit -m "feat: implement bootstrap injection with customizable prompt"
```

---

### Task 2.3: Create Plugin Tools

**Files:**
- Create: `src/tools/use-skill.ts`
- Create: `src/tools/find-skills.ts`
- Create: `src/tools/find-agents.ts`
- Create: `src/tools/find-commands.ts`
- Create: `src/tools/index.ts`

**Step 1: Create use-skill tool**

```typescript
// src/tools/use-skill.ts
import type { SkillsManager } from '../lib/skills-core'

export function createUseSkillTool(skillsManager: SkillsManager) {
  return {
    description: 'Load a skill to get detailed instructions for a specific task.',
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'Name of the skill to load',
        },
      },
      required: ['skill_name'],
    },
    execute: async ({ skill_name }: { skill_name: string }) => {
      const skill = await skillsManager.resolve(skill_name)

      if (!skill) {
        return {
          content: `Skill "${skill_name}" not found or is disabled.`,
          isError: true,
        }
      }

      return {
        content: `# Loading skill: ${skill.name}\n\n${skill.content}`,
      }
    },
  }
}
```

**Step 2: Create find-skills tool**

```typescript
// src/tools/find-skills.ts
import type { SkillsManager } from '../lib/skills-core'

export function createFindSkillsTool(skillsManager: SkillsManager) {
  return {
    description: 'List all available skills.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const skills = await skillsManager.list()

      if (skills.length === 0) {
        return { content: 'No skills available.' }
      }

      const lines = ['# Available Skills\n']
      for (const skill of skills) {
        const desc = skill.description ? ` — ${skill.description}` : ''
        lines.push(`- **${skill.name}** (${skill.tier})${desc}`)
      }

      return { content: lines.join('\n') }
    },
  }
}
```

**Step 3: Create find-agents tool**

```typescript
// src/tools/find-agents.ts
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SystematicConfig } from '../types'
import { getBundledPath, resolvePath } from '../lib/paths'

export function createFindAgentsTool(config: SystematicConfig, projectDir: string) {
  return {
    description: 'List all available agents.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const agents: Array<{ name: string; tier: string }> = []
      const seen = new Set<string>()

      const dirs = [
        { dir: join(projectDir, '.opencode/systematic/agents'), tier: 'project' },
        { dir: resolvePath(config.paths.user_agents), tier: 'user' },
        { dir: getBundledPath('agents'), tier: 'bundled' },
      ]

      for (const { dir, tier } of dirs) {
        if (!existsSync(dir)) continue

        const entries = await readdir(dir)
        for (const entry of entries) {
          if (!entry.endsWith('.md')) continue
          const name = entry.replace(/\.md$/, '')
          if (seen.has(name)) continue
          if (config.disabled_agents.includes(name)) continue

          seen.add(name)
          agents.push({ name, tier })
        }
      }

      if (agents.length === 0) {
        return { content: 'No agents available.' }
      }

      const lines = ['# Available Agents\n']
      for (const agent of agents.sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`- **${agent.name}** (${agent.tier})`)
      }

      return { content: lines.join('\n') }
    },
  }
}
```

**Step 4: Create find-commands tool**

```typescript
// src/tools/find-commands.ts
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SystematicConfig } from '../types'
import { getBundledPath, resolvePath } from '../lib/paths'

export function createFindCommandsTool(config: SystematicConfig, projectDir: string) {
  return {
    description: 'List all available commands.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const commands: Array<{ name: string; tier: string }> = []
      const seen = new Set<string>()

      const dirs = [
        { dir: join(projectDir, '.opencode/systematic/commands'), tier: 'project' },
        { dir: resolvePath(config.paths.user_commands), tier: 'user' },
        { dir: getBundledPath('commands'), tier: 'bundled' },
      ]

      for (const { dir, tier } of dirs) {
        if (!existsSync(dir)) continue

        const entries = await readdir(dir)
        for (const entry of entries) {
          if (!entry.endsWith('.md')) continue
          const name = entry.replace(/\.md$/, '').replace(/^sys-/, '/sys:')
          if (seen.has(name)) continue
          if (config.disabled_commands.includes(name)) continue

          seen.add(name)
          commands.push({ name, tier })
        }
      }

      if (commands.length === 0) {
        return { content: 'No commands available.' }
      }

      const lines = ['# Available Commands\n']
      for (const cmd of commands.sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`- **${cmd.name}** (${cmd.tier})`)
      }

      return { content: lines.join('\n') }
    },
  }
}
```

**Step 5: Create tools index**

```typescript
// src/tools/index.ts
export { createUseSkillTool } from './use-skill'
export { createFindSkillsTool } from './find-skills'
export { createFindAgentsTool } from './find-agents'
export { createFindCommandsTool } from './find-commands'
```

**Step 6: Commit**

```bash
git add src/tools/
git commit -m "feat: implement plugin tools for skills, agents, and commands"
```

---

### Task 2.4: Create Plugin Entry Point

**Files:**
- Create: `src/index.ts`

**Step 1: Create plugin entry point**

```typescript
// src/index.ts
import { loadConfig } from './config'
import { getBootstrapContent } from './bootstrap'
import { SkillsManager } from './lib/skills-core'
import {
  createUseSkillTool,
  createFindSkillsTool,
  createFindAgentsTool,
  createFindCommandsTool,
} from './tools'

export interface PluginContext {
  directory: string
}

export const SystematicPlugin = async ({ directory }: PluginContext) => {
  const config = await loadConfig(directory)
  const skillsManager = new SkillsManager(config, directory)

  return {
    tool: {
      systematic_use_skill: createUseSkillTool(skillsManager),
      systematic_find_skills: createFindSkillsTool(skillsManager),
      systematic_find_agents: createFindAgentsTool(config, directory),
      systematic_find_commands: createFindCommandsTool(config, directory),
    },

    event: async () => {
      // Placeholder for future event handling
    },

    // Workaround for session.prompt() model reset issue
    // See: https://github.com/obra/superpowers/pull/228
    experimental: {
      chat: {
        system: {
          transform: async ({ output }: { output: { system?: string } }) => {
            const content = await getBootstrapContent(config)
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

**Step 2: Build and verify**

Run: `bun run build:plugin`
Expected: Build succeeds, dist/index.js created

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: create plugin entry point with tools and bootstrap injection"
```

---

## Phase 3: CLI

### Task 3.1: Create CLI Entry Point

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/init.ts`
- Create: `src/cli/config.ts`
- Create: `src/cli/list.ts`

**Step 1: Create init command**

```typescript
// src/cli/init.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser'

export async function initCommand(options: { project?: boolean }) {
  const configPath = options.project
    ? join(process.cwd(), 'opencode.json')
    : join(homedir(), '.config/opencode/opencode.json')

  // Ensure directory exists
  await mkdir(dirname(configPath), { recursive: true })

  // Load or create config
  let content = '{}'
  if (existsSync(configPath)) {
    content = await readFile(configPath, 'utf-8')
  }

  const config = parseJsonc(content) ?? {}
  const plugins: string[] = config.plugins ?? []

  if (plugins.includes('@fro.bot/systematic')) {
    console.log(`✓ Already configured in ${configPath}`)
    return
  }

  // Add plugin to array
  const edits = modify(content, ['plugins', -1], '@fro.bot/systematic', {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  const newContent = applyEdits(content, edits)

  await writeFile(configPath, newContent)
  console.log(`✓ Added @fro.bot/systematic to ${configPath}`)
}
```

**Step 2: Create config subcommands**

```typescript
// src/cli/config.ts
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../config'

export async function configShowCommand() {
  const config = await loadConfig(process.cwd())
  console.log(JSON.stringify(config, null, 2))
}

export async function configScaffoldCommand() {
  const baseDir = join(homedir(), '.config/opencode/systematic')

  const dirs = [
    join(baseDir, 'skills'),
    join(baseDir, 'agents'),
    join(baseDir, 'commands'),
  ]

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true })
  }

  // Create empty config if not exists
  const configPath = join(homedir(), '.config/opencode/systematic.json')
  if (!existsSync(configPath)) {
    await writeFile(configPath, '{}\n')
  }

  console.log('✓ Created override directories:')
  dirs.forEach((d) => console.log(`  ${d}`))
  console.log(`✓ Config file: ${configPath}`)
}

export async function configPathCommand() {
  const userConfig = join(homedir(), '.config/opencode/systematic.json')
  const projectConfig = join(process.cwd(), '.opencode/systematic.json')

  console.log('User config:', userConfig, existsSync(userConfig) ? '(exists)' : '(not found)')
  console.log('Project config:', projectConfig, existsSync(projectConfig) ? '(exists)' : '(not found)')
}
```

**Step 3: Create list command**

```typescript
// src/cli/list.ts
import { loadConfig } from '../config'
import { SkillsManager } from '../lib/skills-core'
import { createFindAgentsTool, createFindCommandsTool } from '../tools'

type ListType = 'skills' | 'agents' | 'commands'

export async function listCommand(type?: ListType) {
  const config = await loadConfig(process.cwd())
  const projectDir = process.cwd()

  if (!type || type === 'skills') {
    const manager = new SkillsManager(config, projectDir)
    const skills = await manager.list()
    console.log('\n## Skills\n')
    for (const skill of skills) {
      const desc = skill.description ? ` — ${skill.description}` : ''
      console.log(`  ${skill.name} (${skill.tier})${desc}`)
    }
  }

  if (!type || type === 'agents') {
    const agentsTool = createFindAgentsTool(config, projectDir)
    const result = await agentsTool.execute()
    console.log('\n## Agents\n')
    console.log(result.content.replace(/^# .*\n/, ''))
  }

  if (!type || type === 'commands') {
    const commandsTool = createFindCommandsTool(config, projectDir)
    const result = await commandsTool.execute()
    console.log('\n## Commands\n')
    console.log(result.content.replace(/^# .*\n/, ''))
  }
}
```

**Step 4: Create CLI entry point**

```typescript
// src/cli/index.ts
#!/usr/bin/env node
import { program } from 'commander'
import { initCommand } from './init'
import { configShowCommand, configScaffoldCommand, configPathCommand } from './config'
import { listCommand } from './list'

program
  .name('systematic')
  .description('Structured engineering workflows for OpenCode')
  .version('0.1.0')

program
  .command('init')
  .description('Add @fro.bot/systematic to OpenCode config')
  .option('-p, --project', 'Add to project opencode.json instead of user config')
  .action(initCommand)

const configCmd = program
  .command('config')
  .description('Configuration management')

configCmd
  .command('show')
  .description('Show merged configuration')
  .action(configShowCommand)

configCmd
  .command('scaffold')
  .description('Create user override directories')
  .action(configScaffoldCommand)

configCmd
  .command('path')
  .description('Print config file locations')
  .action(configPathCommand)

program
  .command('list [type]')
  .description('List bundled content (skills, agents, commands)')
  .action(listCommand)

program.parse()
```

**Step 5: Build and verify**

Run: `bun run build`
Expected: Build succeeds

Run: `node dist/cli/index.js --help`
Expected: Shows help output

**Step 6: Commit**

```bash
git add src/cli/
git commit -m "feat: implement CLI with init, config, and list commands"
```

---

## Phase 4: Content

### Task 4.1: Create Placeholder Skills

**Files:**
- Create: `skills/planning/SKILL.md`
- Create: `skills/code-review/SKILL.md`
- Create: `skills/tdd/SKILL.md`
- Create: `skills/debugging/SKILL.md`
- Create: `skills/verification/SKILL.md`
- Create: `skills/brainstorming/SKILL.md`
- Create: `skills/git-worktree/SKILL.md`
- Create: `skills/compound-docs/SKILL.md`
- Create: `skills/agent-native/SKILL.md`
- Create: `skills/writing-skills/SKILL.md`

**Step 1: Create skill directories and placeholder files**

Each skill should have a SKILL.md with:
- Title (# name)
- One-line description
- Placeholder content to be filled from CEP/Superpowers

```markdown
<!-- skills/planning/SKILL.md -->
# planning
Use when you need to create a structured implementation plan before coding.

## Overview

[Port from CEP /workflows:plan and Superpowers writing-plans]

## Process

1. Understand the requirements
2. Break down into tasks
3. Define success criteria
4. Create implementation steps

## Template

[To be completed]
```

Create similar placeholders for all 10 skills.

**Step 2: Commit**

```bash
git add skills/
git commit -m "feat: add placeholder skill files"
```

---

### Task 4.2: Create Placeholder Agents

**Files:**
- Create: `agents/architecture-strategist.md`
- Create: `agents/security-sentinel.md`
- Create: `agents/code-simplicity-reviewer.md`
- Create: `agents/framework-docs-researcher.md`
- Create: `agents/pattern-recognition-specialist.md`
- Create: `agents/performance-oracle.md`

**Step 1: Create agent files**

```markdown
<!-- agents/architecture-strategist.md -->
# Architecture Strategist

You are an expert software architect focused on system design decisions.

## Role

Analyze architectural implications of proposed changes. Consider:
- Scalability
- Maintainability
- Separation of concerns
- Integration patterns

## Approach

[Port from CEP architecture-strategist agent]
```

Create similar placeholders for all 6 agents.

**Step 2: Commit**

```bash
git add agents/
git commit -m "feat: add placeholder agent files"
```

---

### Task 4.3: Create Placeholder Commands

**Files:**
- Create: `commands/sys-plan.md`
- Create: `commands/sys-work.md`
- Create: `commands/sys-review.md`
- Create: `commands/sys-compound.md`
- Create: `commands/sys-deepen.md`
- Create: `commands/sys-lfg.md`

**Step 1: Create command files**

```markdown
<!-- commands/sys-plan.md -->
# /sys:plan

Transform ideas into structured implementation plans.

## Usage

```
/sys:plan <description of what you want to build>
```

## Process

1. Clarify requirements through questions
2. Explore architectural options
3. Create detailed implementation plan
4. Save to docs/plans/

## See Also

- `planning` skill
- `brainstorming` skill
```

Create similar placeholders for all 6 commands.

**Step 2: Commit**

```bash
git add commands/
git commit -m "feat: add placeholder command files"
```

---

## Phase 5: Polish

### Task 5.1: Run All Tests

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

**Step 3: Run lint**

Run: `bun run lint`
Expected: No errors (or only warnings)

---

### Task 5.2: Write README

**Files:**
- Create: `README.md`

**Step 1: Create README**

```markdown
# @fro.bot/systematic

Structured engineering workflows for OpenCode.

> *"Compound your engineering — each unit of work makes subsequent work easier"*

## Installation

```bash
npm install @fro.bot/systematic
npx systematic init
```

## Usage

Once installed, the plugin provides:

### Commands

- `/sys:plan` — Transform ideas into structured implementation plans
- `/sys:work` — Execute work items with tracking
- `/sys:review` — Multi-perspective code review
- `/sys:compound` — Document solved problems for future leverage
- `/sys:deepen` — Enhance plans with parallel research
- `/sys:lfg` — Full autonomous workflow (plan → work → review)

### Tools

- `systematic_find_skills` — List all available skills
- `systematic_use_skill` — Load a skill into context
- `systematic_find_agents` — List available review agents
- `systematic_find_commands` — List available commands

## Configuration

Create `~/.config/opencode/systematic.json`:

```jsonc
{
  "disabled_skills": [],
  "disabled_agents": [],
  "disabled_commands": [],
  "bootstrap": {
    "enabled": true
  }
}
```

## Customization

Override bundled content by placing files in:

- User: `~/.config/opencode/systematic/skills/`
- Project: `.opencode/systematic/skills/`

Project overrides take priority over user, which takes priority over bundled.

## CLI

```bash
systematic init              # Add to OpenCode config
systematic init --project    # Add to project config
systematic config show       # Show merged config
systematic config scaffold   # Create override directories
systematic list              # List all content
```

## Credits

Inspired by:
- [Compound Engineering Plugin](https://github.com/EveryInc/compound-engineering-plugin)
- [Superpowers](https://github.com/obra/superpowers)
- [Oh My OpenCode](https://github.com/code-yeongyu/oh-my-opencode)

## License

MIT
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

### Task 5.3: Final Build and Verification

**Step 1: Clean build**

Run: `rm -rf dist && bun run build`
Expected: Build succeeds

**Step 2: Test CLI**

Run: `node dist/cli/index.js list`
Expected: Lists skills, agents, commands

**Step 3: Verify package.json files array**

Ensure `files` array includes all necessary directories.

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore: final build verification"
```

---

## Summary

**Total Tasks:** 17 across 5 phases

| Phase | Tasks | Focus |
|-------|-------|-------|
| 1. Foundation | 5 | Package setup, utilities, config |
| 2. Plugin Core | 4 | Skills manager, bootstrap, tools, entry point |
| 3. CLI | 1 | init, config, list commands |
| 4. Content | 3 | Placeholder skills, agents, commands |
| 5. Polish | 3 | Tests, README, final verification |

**After completion:** Ready to publish with `npm publish` (after logging into npm with `@fro.bot` scope access).
