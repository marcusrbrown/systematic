// Pi coding-agent extension entry point (built to dist/pi.js via pi.extensions manifest).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { buildAgentCatalog } from './lib/agent-resolver.js'
import {
  composeSystemPromptWithBootstrap,
  computeBootstrapContentSafe,
  readHarnessProfile,
} from './lib/bootstrap.js'
import { createRealPiDelegateSession } from './lib/pi-delegate-session.js'
import { createPiDelegateTool } from './lib/pi-delegate-tool.js'
import {
  buildSkillContentOutput,
  buildSkillToolDescription,
  buildSkillToolParameterHint,
  resolveSkill,
} from './lib/skill-resolver.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const bundledSkillsDir = path.join(packageRoot, 'skills')
const bundledAgentsDir = path.join(packageRoot, 'agents')
const PI_BOOTSTRAP_USAGE_TEMPLATE = `**Skills usage:**
- Use \`systematic_skill\` for Systematic skills.
- For non-Systematic skills, follow Pi's native skill instructions and read the listed SKILL.md path.`

const reportPiBootstrapFailure = (): void => {
  process.stderr.write(
    '[systematic] Failed to compute Pi bootstrap; continuing without injection.\n',
  )
}

const reportPiDelegateCatalogFailure = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(
    `[systematic] Failed to build Pi agent catalog; systematic_delegate will not be registered: ${message}\n`,
  )
}

type PiExtensionDependencies = {
  buildAgentCatalog?: typeof buildAgentCatalog
}

const defaultPiExtensionDependencies = {
  buildAgentCatalog,
} satisfies PiExtensionDependencies

export default async function systematicPiExtension(
  pi: ExtensionAPI,
  deps: PiExtensionDependencies = defaultPiExtensionDependencies,
): Promise<void> {
  const { buildAgentCatalog: buildAgentCatalogFn = buildAgentCatalog } = deps
  const disabledSkills: string[] = []
  const resolverOptions = { bundledSkillsDir, disabledSkills }

  // Match OpenCode's process-lifetime bootstrap snapshot.
  const bootstrapContent = computeBootstrapContentSafe(
    {
      bundledSkillsDir,
      usageTemplate: PI_BOOTSTRAP_USAGE_TEMPLATE,
      // Profile files owned by skills/using-systematic/references/ — Unit 2 of 2026-07-16-001 plan.
      profileBlock: readHarnessProfile(bundledSkillsDir, 'pi') ?? undefined,
    },
    reportPiBootstrapFailure,
  )

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
    promptSnippet: 'Use `systematic_skill` to load Systematic skills.',
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

  try {
    const catalog = buildAgentCatalogFn(bundledAgentsDir)
    pi.registerTool(
      createPiDelegateTool({
        catalog,
        createDelegateSession: createRealPiDelegateSession,
      }),
    )
  } catch (error) {
    reportPiDelegateCatalogFailure(error)
  }
}
