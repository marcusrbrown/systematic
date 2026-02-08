# src/lib — Core Implementation

13 modules implementing plugin logic: discovery, conversion, config, and tool registration.

## Data Flow

```
loadConfig() → createConfigHandler() → {
  findSkillsInDir()  → loadSkillAsCommand()  → OpenCode config
  findAgentsInDir()  → loadAgentAsConfig()   → OpenCode config
  findCommandsInDir() → loadCommandAsConfig() → OpenCode config
}

createSkillTool() → discoverSkillFiles() → loadSkill() → formatted output
getBootstrapContent() → reads using-systematic SKILL.md → system prompt
```

All discovery follows same pattern: `dir → walkDir() → find files → parseFrontmatter() → typed array`

## Modules

### Discovery Layer

| Module | Key Exports | Role |
|--------|-------------|------|
| `walk-dir.ts` | `walkDir`, `WalkEntry`, `WalkOptions` | Recursive dir walker with depth + category tracking |
| `skills.ts` | `findSkillsInDir`, `SkillInfo`, `SkillFrontmatter` | Skill discovery (maxDepth, frontmatter extraction) |
| `agents.ts` | `findAgentsInDir`, `AgentInfo`, `AgentFrontmatter` | Agent discovery (category from subdir name) |
| `commands.ts` | `findCommandsInDir`, `CommandInfo`, `CommandFrontmatter` | Command discovery |
| `frontmatter.ts` | `parseFrontmatter`, `formatFrontmatter`, `stripFrontmatter` | YAML frontmatter parse/format/strip |

### Conversion Layer

| Module | Key Exports | Role |
|--------|-------------|------|
| `converter.ts` | `convertContent`, `convertFileWithCache`, `clearConverterCache` | CEP→OpenCode transforms (tool names, models, body refs) |
| `skill-loader.ts` | `loadSkill`, `LoadedSkill`, `SKILL_PREFIX` | Loads + wraps skill content in XML template |
| `validation.ts` | `isAgentMode`, `isPermissionSetting`, `buildPermissionObject` | Agent config extraction + type guards |

### Config & Integration Layer

| Module | Key Exports | Role |
|--------|-------------|------|
| `config.ts` | `loadConfig`, `getConfigPaths`, `SystematicConfig`, `DEFAULT_CONFIG` | JSONC config loading + merging |
| `config-handler.ts` | `createConfigHandler`, `ConfigHandlerDeps` | OpenCode config hook (collects + converts all assets) |
| `skill-tool.ts` | `createSkillTool`, `SkillToolOptions` | `systematic_skill` tool (XML description, skill execution) |
| `bootstrap.ts` | `getBootstrapContent`, `BootstrapDeps` | System prompt injection (using-systematic skill) |

## Key Interfaces

```typescript
// Discovery
interface SkillInfo { path, skillFile, name, description }
interface AgentInfo { name, file, category }
interface CommandInfo { name, file, category }
interface WalkEntry { path, name, isDirectory, depth, category }

// Config
interface SystematicConfig { disabled_skills, disabled_agents, disabled_commands, bootstrap: BootstrapConfig }
interface ConfigHandlerDeps { directory, bundledSkillsDir, bundledAgentsDir, bundledCommandsDir }

// Conversion
type ContentType = 'skill' | 'agent' | 'command'
type SourceType = 'cep' | 'opencode'
interface ConvertOptions { source, agentMode, skipBodyTransform }
```

## Converter Details

CEP→OpenCode transforms:
- **Tool names**: `TodoWrite`→`todowrite`, `Task`→`delegate_task`, `Skill`→`skill`
- **Models**: Claude model name normalization
- **Body**: Replaces tool references outside code blocks (regex-based)
- **Frontmatter**: Strips CEP-only fields, adds OpenCode fields
- **Caching**: `convertFileWithCache` uses file mtime for invalidation

## Patterns

- **Function-only**: Zero classes. All modules export factory functions or pure helpers
- **Interface-first**: Data shapes defined as interfaces, logic as functions
- **Null returns**: Non-critical failures return `null`/`undefined` (not throws)
- **Type guards**: `validation.ts` provides safe extraction from `unknown` frontmatter data
- **Const enums**: `AgentMode`, `PermissionSetting` for compile-time safety

## Notes

- `findSkillsInDir` is highest-centrality function (6 references across 3 modules)
- `SKILL_PREFIX` = `'systematic:'` — all skills registered with this prefix
- `parseFrontmatter` is regex-based (not a YAML library for delimiter detection)
- `formatFrontmatter` uses `js-yaml` dump with `noRefs` and core schema
- `config-handler.ts` contains internal `loadAgentAsConfig`/`loadCommandAsConfig`/`loadSkillAsCommand` — the glue between discovery and OpenCode config output
