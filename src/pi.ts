// Pi coding-agent extension entry point (built to dist/pi.js via pi.extensions manifest).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  composeSystemPromptWithBootstrap,
  computeBootstrapContentSafe,
} from './lib/bootstrap.js'
import {
  buildSkillContentOutput,
  buildSkillToolDescription,
  buildSkillToolParameterHint,
  resolveSkill,
} from './lib/skill-resolver.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const bundledSkillsDir = path.join(packageRoot, 'skills')

export default async function systematicPiExtension(
  pi: ExtensionAPI,
): Promise<void> {
  const disabledSkills: string[] = []
  const resolverOptions = { bundledSkillsDir, disabledSkills }

  // Match OpenCode's process-lifetime bootstrap snapshot.
  const bootstrapContent = computeBootstrapContentSafe({ bundledSkillsDir })

  pi.on(
    'before_agent_start',
    (event: BeforeAgentStartEvent): BeforeAgentStartEventResult | undefined => {
      const systemPrompt = composeSystemPromptWithBootstrap(
        event.systemPrompt,
        bootstrapContent,
      )
      if (systemPrompt === null) return undefined
      return { systemPrompt }
    },
  )

  pi.registerTool({
    name: 'systematic_skill',
    label: 'Systematic Skill',
    description: buildSkillToolDescription(resolverOptions),
    parameters: Type.Object({
      name: Type.String({
        description: buildSkillToolParameterHint(resolverOptions),
      }),
    }),
    async execute(_toolCallId, params) {
      const matchedSkill = resolveSkill(resolverOptions, params.name)
      const { output, dir } = buildSkillContentOutput(matchedSkill)

      return {
        content: [{ type: 'text', text: output }],
        details: { skillDir: dir },
      }
    },
  })
}
