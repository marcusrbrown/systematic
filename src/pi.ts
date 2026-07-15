// Pi coding-agent extension entry point (built to dist/pi.js via pi.extensions manifest).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
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
