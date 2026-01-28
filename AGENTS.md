# AGENTS.md - Coding Agent Guidelines for Systematic

**Generated:** 2026-01-28 | **Commit:** d4bfa75 | **Branch:** main

## Project Overview

OpenCode plugin providing systematic engineering workflows. Converts/adapts Claude Code agents, skills, and commands from Compound Engineering Plugin (CEP) to OpenCode.

**Key insight:** This repo has two distinct parts:
1. **TypeScript source** (`src/`) - Plugin logic, tools, config handling
2. **Bundled assets** (`skills/`, `agents/`, `commands/`) - OpenCode Markdown content shipped with npm package

## Build & Test Commands

```bash
# Install dependencies
bun install

# Build (outputs to dist/)
bun run build

# Type checking (strict mode)
bun run typecheck

# Lint with Biome
bun run lint

# Run unit tests
bun test tests/unit

# Run a single test file
bun test tests/unit/skills-core.test.ts

# Run tests matching a pattern
bun test --filter "extractFrontmatter"

# Run all tests (unit + integration)
bun test

# Run integration tests only
bun test tests/integration
```

## Technology Stack

- **Runtime**: Bun (not Node.js for execution, but Node.js API compatible)
- **Language**: TypeScript 5.7+ with strict mode
- **Module System**: ESM (`"type": "module"`)
- **Target**: ES2022
- **Linter/Formatter**: Biome (not ESLint/Prettier)
- **Testing**: Bun's native test runner (`bun:test`)

## Code Style

### Formatting (Biome)

- **Indent**: 2 spaces
- **Quotes**: Single quotes for strings
- **Semicolons**: As needed (omit where possible)
- **Line width**: Default (no strict limit)

### Imports

```typescript
// 1. Node.js built-ins with node: protocol
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 2. External dependencies
import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'

// 3. Internal modules with .js extension (ESM requirement)
import { loadConfig } from './lib/config.js'
import * as skillsCore from './lib/skills-core.js'
```

### TypeScript Patterns

```typescript
// Prefer function declarations over classes
export function extractFrontmatter(filePath: string): SkillFrontmatter {
  // implementation
}

// Use explicit return types
export function findSkillsInDir(
  dir: string,
  sourceType: 'project' | 'user' | 'bundled',
  maxDepth = 3
): SkillInfo[] {
  // implementation
}

// Define interfaces for data structures
export interface SkillInfo {
  path: string
  skillFile: string
  name: string
  description: string
  sourceType: 'project' | 'user' | 'bundled'
}

// Use union types for constrained values
type SourceType = 'project' | 'user' | 'bundled'

// Prefer const for immutable bindings
const packageRoot = path.resolve(__dirname, '..')

// Arrow functions for inline callbacks
const filtered = skills.filter((s) => !disabled.includes(s.name))
```

### Error Handling

```typescript
// Return null/empty for non-critical failures
export function extractFrontmatter(filePath: string): SkillFrontmatter {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    // parse...
    return { name, description }
  } catch {
    return { name: '', description: '' }
  }
}

// Early return for guard clauses
if (!fs.existsSync(dir)) return skills

// Throw for critical errors with context
if (!validTypes.includes(typeArg)) {
  console.error(`Invalid type: ${typeArg}. Must be one of: ${validTypes.join(', ')}`)
  process.exit(1)
}
```

### Naming Conventions

- **Files**: kebab-case (`skills-core.ts`, `config.ts`)
- **Functions**: camelCase (`findSkillsInDir`, `loadConfig`)
- **Interfaces/Types**: PascalCase (`SkillInfo`, `SystematicConfig`)
- **Constants**: SCREAMING_SNAKE_CASE or camelCase based on scope
- **Test files**: `*.test.ts` in `tests/` directory

## Testing Patterns

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('module-name', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-test-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('functionName', () => {
    test('describes expected behavior', () => {
      const result = functionUnderTest(input)
      expect(result).toBe(expected)
    })

    test('handles edge case', () => {
      expect(functionUnderTest(null)).toEqual([])
    })
  })
})
```

## Project Structure

```
systematic/
├── src/
│   ├── index.ts              # Plugin entry point (SystematicPlugin)
│   ├── cli.ts                # CLI entry point
│   └── lib/
│       ├── agents.ts         # Agent discovery + frontmatter parsing
│       ├── bootstrap.ts      # System prompt injection
│       ├── commands.ts       # Command discovery + frontmatter parsing
│       ├── config.ts         # JSONC config loading (project > user)
│       ├── config-handler.ts # OpenCode config hook (merges bundled → existing)
│       ├── converter.ts      # CEP to OpenCode conversion
│       ├── frontmatter.ts    # YAML frontmatter utilities
│       ├── skill-tool.ts     # `systematic_skill` tool implementation
│       ├── skills.ts         # Skill discovery + frontmatter parsing
│       └── walk-dir.ts       # Recursive directory traversal
├── tests/
│   ├── unit/                 # Unit tests (bun test tests/unit)
│   └── integration/          # Integration tests
├── skills/                   # Bundled OpenCode skill definitions (SKILL.md)
├── agents/                   # Bundled OpenCode agent definitions (Markdown)
├── commands/                 # Bundled OpenCode command definitions (Markdown)
├── dist/                     # Build output (git-ignored)
├── biome.json                # Biome linter/formatter config
├── tsconfig.json             # TypeScript config
└── package.json
```

## Key Patterns

### Plugin Export Pattern

```typescript
export const SystematicPlugin: Plugin = async ({ client, directory }) => {
  const config = loadConfig(directory)

  return {
    tool: {
      tool_name: tool({
        description: 'Tool description',
        args: {},
        execute: async (): Promise<string> => {
          // implementation
        },
      }),
    },
  }
}

export default SystematicPlugin
```

### Skill File Format

Skills are directories containing `SKILL.md` with YAML frontmatter:

```markdown
---
name: skill-name
description: Use when [condition] - [what it does]
---

# Skill Content
```

### Configuration Loading

Supports JSONC (JSON with comments). Priority: project > user > bundled.

## Linting Rules (Biome)

- `noExcessiveCognitiveComplexity`: warn
- `noNonNullAssertion`: warn
- All recommended rules enabled
- Markdown files excluded from linting

## Don'ts

- Don't use `require()` - use ESM imports
- Don't omit `.js` extension in relative imports
- Don't use classes when functions suffice
- Don't use `any` - prefer `unknown` with type guards
- Don't ignore Biome warnings without justification
- Don't use `@ts-ignore` or `@ts-expect-error`
