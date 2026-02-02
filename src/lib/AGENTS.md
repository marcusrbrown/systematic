# src/lib — Core Implementation Modules

Plugin internals. 12 modules handling config, conversion, discovery, and tool implementation.

## Module Map

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| `config-handler.ts` | OpenCode config hook | `createConfigHandler()` |
| `skill-tool.ts` | systematic_skill tool | `createSkillTool()` |
| `skill-loader.ts` | Skill file loading | `loadSkill()` |
| `skills.ts` | Skill discovery | `findSkillsInDir()`, `extractFrontmatter()` |
| `agents.ts` | Agent discovery | `findAgentsInDir()`, `extractAgentFrontmatter()` |
| `commands.ts` | Command discovery | `findCommandsInDir()`, `extractCommandFrontmatter()` |
| `converter.ts` | CEP→OpenCode conversion | `convertContent()`, `convertFileWithCache()` |
| `frontmatter.ts` | YAML frontmatter utils | `parseFrontmatter()`, `serializeFrontmatter()` |
| `bootstrap.ts` | System prompt injection | `getBootstrapContent()` |
| `config.ts` | JSONC config loading | `loadConfig()`, `getConfigPaths()` |
| `validation.ts` | Input validation | Validation helpers |
| `walk-dir.ts` | Directory traversal | `walkDir()` |

## Data Flow

```
Plugin init
    ↓
loadConfig() ← reads JSONC from project/user paths
    ↓
createConfigHandler() ← merges bundled assets into OpenCode config
    │
    ├─ findSkillsInDir() + loadSkill() → skills as commands
    ├─ findAgentsInDir() + extractAgentFrontmatter() → agent configs
    └─ findCommandsInDir() + extractCommandFrontmatter() → command configs
           │
           └─ convertContent() / convertFileWithCache() ← CEP→OpenCode transform

createSkillTool() ← registers systematic_skill tool
    │
    └─ findSkillsInDir() → formats skill list as XML
    └─ loadSkill() → returns skill body on demand

getBootstrapContent() ← reads using-systematic SKILL.md for system prompt
```

## Key Interfaces

```typescript
// skills.ts
interface SkillInfo {
  path: string
  skillFile: string
  name: string
  description: string
  // ... frontmatter fields
}

// config.ts
interface SystematicConfig {
  disabled_skills: string[]
  disabled_agents: string[]
  disabled_commands: string[]
  bootstrap: { enabled: boolean; file?: string }
}

// config-handler.ts
interface ConfigHandlerDeps {
  directory: string
  bundledSkillsDir: string
  bundledAgentsDir: string
  bundledCommandsDir: string
}
```

## Converter Details

Transforms Claude Code (CEP) content to OpenCode format:

| Transformation | From | To |
|----------------|------|-----|
| Tool names | `TodoWrite` | `todowrite` |
| Tool refs | `Task` | `delegate_task` |
| Path separators | `\` | `/` |
| Model names | `claude-3-opus` | Normalized |
| Temperature | Inferred from content | 0.0-1.0 |

Caching: `convertFileWithCache()` uses file mtime to avoid re-parsing.

## Discovery Patterns

All discovery functions:
1. Take a directory path
2. Use `walkDir()` for traversal
3. Look for specific files (SKILL.md, *.md)
4. Extract YAML frontmatter
5. Return typed array of results

Example:
```typescript
const skills = findSkillsInDir(bundledSkillsDir, 'bundled', 3)
// Returns SkillInfo[] with name, description, path, etc.
```

## Config Loading

Priority chain:
1. `loadConfig(projectDir)` reads from:
   - `~/.config/opencode/systematic.json` (user)
   - `<projectDir>/.opencode/systematic.json` (project)
2. Merges with `DEFAULT_CONFIG`
3. Arrays merged uniquely via `mergeArraysUnique()`

## Testing

Unit tests in `tests/unit/`:
- `skills.test.ts` — skill discovery
- `config-handler.test.ts` — config merging
- `converter.test.ts` — CEP conversion
- `frontmatter.test.ts` — YAML parsing

Pattern:
```typescript
describe('moduleName', () => {
  let testDir: string
  beforeEach(() => { testDir = fs.mkdtempSync(...) })
  afterEach(() => { fs.rmSync(testDir, { recursive: true }) })
  test('behavior', () => { ... })
})
```
