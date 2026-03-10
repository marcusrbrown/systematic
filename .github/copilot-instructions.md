# Copilot Instructions for Systematic

Read `AGENTS.md` at the repository root before writing any code. It is the canonical source for project structure, conventions, and command reference.

## Stack

- **Runtime:** Bun (not Node.js, not Deno)
- **Language:** TypeScript 5.7+ with `strict: true`
- **Modules:** ESM only (`"type": "module"` in package.json)
- **Linter:** Biome — not ESLint, not Prettier
- **Tests:** `bun:test` with `describe`/`it` — not Jest, not Vitest
- **Package manager:** Bun — not npm, not pnpm, not yarn

## Verification Commands

Run these before marking work complete:

```bash
bun run build        # Build to dist/
bun run typecheck    # TypeScript strict mode
bun run lint         # Biome linter
bun test             # Unit and integration tests
```

All four must pass. Do not skip any.

## Do / Don't

### Imports

```typescript
// ✅ Do: node: protocol for builtins
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// ✅ Do: .js extension on relative imports (ESM requirement)
import { parseFrontmatter } from './frontmatter.js'

// ✅ Do: import type for type-only imports
import type { SkillConfig } from './types.js'

// ❌ Don't: bare builtin imports
import { readFile } from 'fs/promises'

// ❌ Don't: missing .js extension
import { parseFrontmatter } from './frontmatter'
```

### Type Safety

```typescript
// ✅ Do: unknown + type guards
function processInput(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected string, got ${typeof value}`)
  }
  return value
}

// ✅ Do: explicit return types on exports
export function findSkills(dir: string): Promise<SkillDefinition[]> { ... }

// ❌ Don't: any, @ts-ignore, @ts-expect-error, non-null assertions (!)
function processInput(value: any) { ... }
// @ts-ignore
someCall()!
```

### Architecture

```typescript
// ✅ Do: functions — this codebase has zero classes
export function createHandler(config: Config): Handler { ... }

// ❌ Don't: classes
class Handler { ... }
```

### Error Handling

```typescript
// ✅ Do: return null/empty for non-critical failures
export function loadConfig(path: string): Config | null { ... }

// ✅ Do: throw with context for critical failures
throw new Error(`Failed to parse ${filePath}: ${error.message}`)

// ❌ Don't: empty catch blocks
try { ... } catch (e) {}
```

### Naming

| Kind | Convention | Example |
|------|-----------|---------|
| Files | kebab-case | `skill-loader.ts` |
| Functions | camelCase | `findSkillsInDir` |
| Types/Interfaces | PascalCase | `SkillDefinition` |
| Tests | `*.test.ts` | `skills.test.ts` |

### Testing

```typescript
// ✅ Do: real temp dirs for filesystem isolation
import { describe, it, expect } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

describe('findSkills', () => {
  it('discovers SKILL.md files in subdirectories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'test-'))
    // ... create fixture files, run function, assert
  })
})

// ❌ Don't: mock libraries, Jest globals, or Vitest imports
import { jest } from '@jest/globals'
import { vi } from 'vitest'
```

## Plugin Architecture

The plugin exposes three hooks. Changes to any of these are high-risk:

- **`config`** — merges bundled skills/agents/commands into OpenCode config
- **`tool`** — registers the `systematic_skill` tool
- **`system.transform`** — injects bootstrap prompt into conversations

Treat modifications to `src/index.ts` hook implementations as breaking-change candidates.

## Bundled Content

Skills, agents, and commands are Markdown files with YAML frontmatter. When adding or modifying:

- Skills go in `skills/<name>/SKILL.md`
- Agents go in `agents/<category>/<name>.md`
- Commands go in `commands/<name>.md`
- Frontmatter must include `name` and `description` fields
