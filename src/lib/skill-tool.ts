import type { ToolDefinition } from '@opencode-ai/plugin'
import { z } from 'zod'
import {
  buildSkillContentOutput,
  buildSkillToolDescription,
  buildSkillToolParameterHint,
  resolveSkill,
} from './skill-resolver.js'

export { discoverSkillFiles } from './skill-resolver.js'

export interface SkillToolOptions {
  bundledSkillsDir: string
  disabledSkills: string[]
}

export function createSkillTool(options: SkillToolOptions): ToolDefinition {
  const { bundledSkillsDir, disabledSkills } = options
  const buildDescription = (): string =>
    buildSkillToolDescription({ bundledSkillsDir, disabledSkills })

  const buildParameterHint = (): string =>
    buildSkillToolParameterHint({ bundledSkillsDir, disabledSkills })

  let cachedDescription: string | null = null
  let cachedParameterHint: string | null = null

  return {
    get description() {
      if (cachedDescription == null) {
        cachedDescription = buildDescription()
      }
      return cachedDescription
    },
    args: {
      name: z.string().describe(
        (() => {
          if (cachedParameterHint == null) {
            cachedParameterHint = buildParameterHint()
          }
          return cachedParameterHint
        })(),
      ),
      // Double-cast is required, not stylistic: the SDK types its args
      // against its own bundled zod, whose Zod types are nominally
      // incompatible with this package's zod (v4-vs-v1 internal version
      // brands), so a direct cast fails typecheck. Runtime-safe because the
      // SDK's `tool()` is an identity function and OpenCode consumes args
      // structurally. Revisit if the SDK contract gains real behavior
      // (guarded by the no-runtime-import artifact test in package-exports).
    } as unknown as ToolDefinition['args'],
    async execute(args: { name: string }, context): Promise<string> {
      const requestedName = args.name

      const matchedSkill = resolveSkill(
        { bundledSkillsDir, disabledSkills },
        requestedName,
      )

      const { output, dir } = buildSkillContentOutput(matchedSkill)

      await context.ask({
        permission: 'skill',
        patterns: [matchedSkill.prefixedName],
        always: [matchedSkill.prefixedName],
        metadata: {},
      })

      context.metadata({
        title: `Loaded skill: ${matchedSkill.prefixedName}`,
        metadata: {
          name: matchedSkill.prefixedName,
          dir,
        },
      })

      return output
    },
  }
}
