import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin'
import {
  applyBootstrapContent,
  getBootstrapContent,
  INTERNAL_AGENT_SIGNATURES,
  readHarnessProfile,
} from './lib/bootstrap.js'
import { loadConfig } from './lib/config.js'
import { createConfigHandler } from './lib/config-handler.js'
import {
  createOpencodeOperationObserver,
  type OperationObserverResult,
} from './lib/opencode-operation-observer.js'
import {
  createOpencodeWorkflowGuard,
  isWorkflowGuardBlockedError,
} from './lib/opencode-workflow-guard.js'
import { createReceiptClassifier } from './lib/receipt-classifier.js'
import { createSkillTool } from './lib/skill-tool.js'

// Keep this local because OpenCode's plugin loader requires a default export
// only. The content-integrity gate reads this typed inventory instead of
// inferring hooks from the returned object shape.
const REGISTERED_PLUGIN_HOOKS = [
  'config',
  'tool',
  'tool.execute.before',
  'tool.execute.after',
  'event',
  'experimental.chat.system.transform',
] as const satisfies readonly (keyof Hooks)[]

type RegisteredPluginHooks = Required<
  Pick<Hooks, (typeof REGISTERED_PLUGIN_HOOKS)[number]>
>

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const packageRoot = path.resolve(__dirname, '..')
const bundledSkillsDir = path.join(packageRoot, 'skills')
const bundledAgentsDir = path.join(packageRoot, 'agents')
const bundledCommandsDir = path.join(packageRoot, 'commands')
const packageJsonPath = path.join(packageRoot, 'package.json')
const canonicalPackageSource = pathToFileURL(fs.realpathSync(packageRoot)).href
const registrationSourceIdentity = createHash('sha256')
  .update(
    `systematic/opencode-registration-source/v1/${canonicalPackageSource}`,
  )
  .digest('hex')

const getPackageVersion = (): string => {
  try {
    if (!fs.existsSync(packageJsonPath)) return 'unknown'
    const content = fs.readFileSync(packageJsonPath, 'utf8')
    const parsed = JSON.parse(content) as { version?: string }
    return parsed.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const initializePlugin = async ({
  client,
  directory,
  worktree,
}: PluginInput) => {
  let hasLoggedInit = false
  const config = loadConfig(directory)
  // Snapshot bootstrap once per plugin init so the cached system prefix stays
  // stable across requests. Custom bootstrap file edits take effect on restart.
  // Profile files owned by skills/using-systematic/references/ — Unit 2 of 2026-07-16-001 plan.
  const bootstrapContent = getBootstrapContent(config, {
    bundledSkillsDir,
    profileBlock: readHarnessProfile(bundledSkillsDir, 'opencode') ?? undefined,
  })

  const configHandler = createConfigHandler({
    directory,
    bundledSkillsDir,
    bundledAgentsDir,
    bundledCommandsDir,
  })
  const observer = createOpencodeOperationObserver({
    targetDirectory: typeof worktree === 'string' ? worktree : directory,
  })
  let initialSnapshot: OperationObserverResult
  try {
    initialSnapshot = await observer.snapshot()
  } catch {
    initialSnapshot = {
      status: 'unavailable' as const,
      reasonCode: 'target-unavailable' as const,
    }
  }
  const initialIdentities =
    initialSnapshot.status === 'available'
      ? initialSnapshot.snapshot
      : {
          targetDigest: observer.targetDigest,
          repositoryRevisionDigest: observer.targetDigest,
          worktreeRevisionDigest: observer.targetDigest,
        }
  const workflowGuard = createOpencodeWorkflowGuard({
    config: config.workflow_guard,
    workspaceIdentity: initialIdentities.targetDigest,
    repositoryIdentity: initialIdentities.repositoryRevisionDigest,
    worktreeIdentity: initialIdentities.worktreeRevisionDigest,
    registrationIdentity: registrationSourceIdentity,
    targetDirectory: typeof worktree === 'string' ? worktree : directory,
    sessionLocation: directory,
    observer,
    classifier: createReceiptClassifier(),
    hostReadback: (() => {
      // The installed SDK exposes session.messages / session.children as generic
      // RequestResult<T> shapes that don't directly assign to the narrow readback
      // contract used by hostReadback. A single boundary cast is required here;
      // the data payload is validated by the consumer before use.
      type SessionReadMethod = (input: {
        path: { id: string }
        query?: { directory?: string }
      }) => Promise<{ data?: unknown }>
      return {
        readSessionParts: async (sessionID) => {
          const messages = client.session.messages.bind(
            client.session,
          ) as unknown as SessionReadMethod
          const response = await messages({
            path: { id: sessionID },
            query: { directory },
          })
          return Array.isArray(response.data) ? response.data : []
        },
        listChildren: async (sessionID) => {
          const children = client.session.children.bind(
            client.session,
          ) as unknown as SessionReadMethod
          const response = await children({
            path: { id: sessionID },
            query: { directory },
          })
          if (!Array.isArray(response.data)) return []
          return response.data.flatMap((entry) => {
            if (
              typeof entry !== 'object' ||
              entry === null ||
              typeof entry.id !== 'string'
            ) {
              return []
            }
            return [{ sessionId: entry.id, parentID: entry.parentID }]
          })
        },
      }
    })(),
  })

  const hooks: RegisteredPluginHooks = {
    config: configHandler,

    tool: {
      systematic_skill: createSkillTool({
        bundledSkillsDir,
        disabledSkills: config.disabled_skills,
      }),
      ...workflowGuard.tools,
    },

    'tool.execute.before': async (input: unknown, output: unknown) => {
      try {
        await workflowGuard.hooks['tool.execute.before'](input, output)
      } catch (error) {
        if (isWorkflowGuardBlockedError(error)) throw error
      }
    },

    'tool.execute.after': async (input: unknown, output: unknown) => {
      try {
        await workflowGuard.hooks['tool.execute.after'](input, output)
      } catch {
        // Adapter after hooks are fail-closed and never block the host.
      }
    },

    event: async (input: unknown) => {
      try {
        await workflowGuard.hooks.event(input)
      } catch {
        // Event observation is fail-closed and never blocks the host.
      }
    },

    'experimental.chat.system.transform': async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      if (!hasLoggedInit) {
        hasLoggedInit = true
        const packageVersion = getPackageVersion()
        try {
          await client.app.log({
            body: {
              service: 'systematic',
              level: 'info',
              message: 'Systematic plugin initialized',
              extra: {
                version: packageVersion,
                bootstrapEnabled: config.bootstrap.enabled,
                disabledSkillsCount: config.disabled_skills.length,
                disabledAgentsCount: config.disabled_agents.length,
                disabledCommandsCount: config.disabled_commands.length,
              },
            },
          })
        } catch {
          // ignore logging failures to avoid blocking the hook
        }
      }

      // Skip for title generation requests
      const existingSystem = output.system.join('\n').toLowerCase()
      if (
        INTERNAL_AGENT_SIGNATURES.some((sig) =>
          existingSystem.includes(sig.toLowerCase()),
        )
      ) {
        try {
          await client.app.log({
            body: {
              service: 'systematic',
              level: 'info',
              message: 'Skipping bootstrap prompt injection for internal agent',
            },
          })
        } catch {
          // ignore logging failures to avoid blocking the hook
        }
        return
      }

      if (bootstrapContent) {
        applyBootstrapContent(output, bootstrapContent)
      }
      try {
        await workflowGuard.hooks['experimental.chat.system.transform'](
          _input,
          output,
        )
      } catch {
        // Transform observation is fail-closed and never blocks the host.
      }
    },
  }

  return hooks
}

const SystematicPlugin: Plugin = async (input) => {
  return initializePlugin(input)
}

export default SystematicPlugin
