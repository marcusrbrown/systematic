# src/lib — Core Implementation

Modules implementing plugin logic: discovery, config, schema validation, and tool registration.

## Data Flow

```
loadConfig() → createConfigHandler() → {
  findSkillsInDir()  → loadSkillAsCommand()  → OpenCode config
  findAgentsInDir()  → loadAgentAsConfig()   → OpenCode config
  findCommandsInDir() → loadCommandAsConfig() → OpenCode config
}

createSkillTool() → buildSkillToolDescription()/buildSkillToolParameterHint()/buildSkillContentOutput()/resolveSkill() → OpenCode tool
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

### Loading Layer

| Module | Key Exports | Role |
|--------|-------------|------|
| `skill-loader.ts` | `loadSkill`, `LoadedSkill`, `SKILL_PREFIX` | Loads + wraps skill content in XML template |
| `skill-resolver.ts` | `resolveSkill`, `buildSkillToolDescription`, `buildSkillToolParameterHint`, `buildSkillContentOutput`, `discoverSkillFiles` | Harness-neutral skill resolution, wrapped output, and catalog helpers shared by both adapters |
| `agent-resolver.ts` | `buildAgentCatalog`, `resolveAgent`, `renderAgentCatalogCompact`, `resolveToolAllowlist`, `DEFAULT_READONLY_TOOLS` | Harness-neutral, in-memory runtime catalog built from packaged `agents/<category>/<name>.md` (category dropped from the lookup key, duplicate names fail-closed); parses each persona's `tools:` frontmatter value into a least-privilege Pi tool allowlist, validated at catalog-build time so unknown/denylisted tools fail closed with source-path context |
| `validation.ts` | `isAgentMode`, `isPermissionSetting`, `normalizePermission`, `extractString`, `extractBoolean` | Agent config extraction + type guards + safe value extraction |

### Config & Integration Layer

| Module | Key Exports | Role |
|--------|-------------|------|
| `config.ts` | `loadConfig`, `getConfigPaths`, `SystematicConfig`, `DEFAULT_CONFIG` | JSONC config loading + merging |
| `config-schema.ts` | `SystematicConfigSchema`, `validateConfig`, `SECURITY_OVERLAY_FIELDS`, `AgentOverlaySchema`, `CategoryOverlaySchema`, `BootstrapSchema` | Canonical Zod schema for user config; security field list |
| `agent-colors.ts` | `isValidAgentColor`, `OPENCODE_AGENT_COLOR_TOKENS` | Color validator (hex or named token) + accepted token enum |
| `config-handler.ts` | `createConfigHandler`, `ConfigHandlerDeps`, `formatAgentDescription`, `toTitleCase` | OpenCode config hook (collects + emits all assets) |
| `skill-tool.ts` | `createSkillTool`, `SkillToolOptions` | OpenCode `systematic_skill` adapter (tool wiring, permission/metadata side effects, execution bridging) |
| `bootstrap.ts` | `getBootstrapContent`, `applyBootstrapContent`, `computeBootstrapContentSafe`, `composeSystemPromptWithBootstrap`, `INTERNAL_AGENT_SIGNATURES`, `BootstrapDeps` | System prompt injection (using-systematic skill); harness-neutral safe-compute/compose helpers reused by Pi's `before_agent_start` |
| `pi-delegate-tool.ts` | `createPiDelegateTool`, `MAX_DELEGATE_TURNS`, `DELEGATE_TOOL_NAME`, `DELEGATE_EXECUTION_MODE`, `DelegateSessionLike`, `CreateDelegateSession` | Pi `systematic_delegate` tool factory: `{agent, task}`-only schema, fail-closed validation (unknown persona/model/tool/re-entry) before any session is created, fixed 20-turn cap enforced via `session.subscribe()` + `abort()`, `AbortSignal` propagation, unsubscribe/dispose in `finally`. Depends on Pi session construction only through the injectable `CreateDelegateSession` seam (no live Pi SDK import), so it is unit-testable without a real Pi session/provider |
| `pi-delegate-session.ts` | `createRealPiDelegateSession` | The real `CreateDelegateSession` implementation: `DefaultResourceLoader` with `noExtensions: true` (depth 1) plus every other resource category suppressed, `systemPromptOverride` replacing the prompt with the persona body, `SessionManager.inMemory()`, `reload()` before session creation. The only module that statically imports the live Pi SDK for delegation |
| `setup.ts` | `setupHarness`, `isSetupError`, `Harness`, `SetupResult`, `PI_PACKAGE_IDENTIFIER`, `SYSTEMATIC_PACKAGE_NAME` | Backs `systematic setup --harness opencode\|pi` (`src/cli.ts`): project-local-only, single-trusted-read + atomic-no-clobber-backup writes to either OpenCode's singular `plugin` array (v1.17.6 schema; `plugins`/duplicate-keys rejected) or `.pi/settings.json`'s `packages` array (structural JSONC edit, filter-aware tagged-entry idempotency); never touches the other harness's config; discriminated `SetupResult` (`'configured' \| 'already-configured'`), plain-Error `isSetupError()` marker (no custom class) |

## Key Types

- **Discovery:** `SkillInfo`, `AgentInfo`, `CommandInfo`, `WalkEntry` — all have `name` + path/file fields
- **Config:** `SystematicConfig` (disabled lists + bootstrap), `ConfigHandlerDeps` (directory paths)

## Patterns

- **Function-only**: Zero classes. All modules export factory functions or pure helpers
- **Interface-first**: Data shapes defined as interfaces, logic as functions
- **Null returns**: Non-critical failures return `null`/`undefined` (not throws)
- **Type guards**: `validation.ts` provides safe extraction from `unknown` frontmatter data
- **Const enums**: `AgentMode`, `PermissionSetting` for compile-time safety

## Notes

- `parseFrontmatter` is the most-imported function across the codebase
- `walkDir` is the foundation layer, used by all three discovery modules
- `findSkillsInDir` is the highest-centrality discovery function across the loading layer
- `SKILL_PREFIX` = `'systematic:'` — all skills registered with this prefix
- `parseFrontmatter` is regex-based (not a YAML library for delimiter detection)
- `formatFrontmatter` uses `js-yaml` dump with `noRefs` and core schema
- `config-handler.ts` contains internal `loadAgentAsConfig`/`loadCommandAsConfig`/`loadSkillAsCommand` — the glue between discovery and OpenCode config output
