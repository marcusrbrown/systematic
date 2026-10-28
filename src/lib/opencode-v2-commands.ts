import type { Plugin } from '@opencode/plugin'
import type { PlannedCommand } from './asset-plan.js'
import type { V2Installer } from './opencode-v2.js'
import { substituteSkillArguments } from './skill-resolver.js'

/**
 * Systematic commands on OpenCode v2.
 *
 * A v2 plugin command receives the text typed after its name, untouched, and
 * submits its own prompt. So this module does what OpenCode's own command path
 * does for a stored command's text: expand `$ARGUMENTS` and `$1..$N`, then
 * submit one prompt on the invoking session with the invocation's delivery and
 * attachments. It never runs `!`-backtick blocks; their text stays literal in
 * the prompt.
 *
 * It does not route. A v2 plugin command cannot choose an agent or a model for
 * its prompt, and switching the session around the turn leaves the user's
 * session changed. A command that declares `agent`, `model` or `subtask` is
 * refused with a message instead; OpenCode commands written in Markdown or JSON
 * can do that routing.
 */

type CommandEditor = Parameters<
  Parameters<Plugin.Context['command']['transform']>[0]
>[0]
export type V2CommandDefinition = Parameters<CommandEditor['add']>[0]
type Invocation = Parameters<V2CommandDefinition['execute']>[0]

export interface CommandRuntime {
  ctx: Plugin.Context
  report: (message: string) => void
  /** Diagnostics already written, so a command run twice reports once. */
  reported: Set<string>
}

export function createCommandRuntime(
  ctx: Plugin.Context,
  report: (message: string) => void,
): CommandRuntime {
  return { ctx, report, reported: new Set() }
}

function reportOnce(runtime: CommandRuntime, key: string, message: string) {
  if (runtime.reported.has(key)) return
  runtime.reported.add(key)
  runtime.report(message)
}

/** The first routing field a command declares, which v2 cannot honor. */
function declaredRouting(
  planned: PlannedCommand,
): 'agent' | 'model' | 'subtask' | undefined {
  if (planned.agent !== undefined) return 'agent'
  if (planned.model !== undefined) return 'model'
  if (planned.subtask !== undefined) return 'subtask'
  return undefined
}

function refusalMessage(name: string, field: string): string {
  return `Systematic command "${name}" declares ${field}, which OpenCode v2 plugin commands cannot route. Define it as an OpenCode command in Markdown or JSON to choose its agent or model.`
}

async function submit(
  runtime: CommandRuntime,
  planned: PlannedCommand,
  invocation: Invocation,
): Promise<void> {
  // The text is exactly what was typed after the name; expanding it is ours.
  const text = substituteSkillArguments(
    planned.template,
    invocation.prompt.text,
  )
  const { files, agents, skills } = invocation.prompt
  await runtime.ctx.session.prompt({
    sessionID: invocation.sessionID,
    text,
    files,
    agents,
    skills,
    delivery: invocation.delivery,
  })
}

/**
 * One command. A failure in `execute` is written to the log and thrown on: the
 * host turns it into an error for whoever ran the command and keeps the plugin
 * loaded, so the user hears about it. Swallowing it would not.
 */
export function buildCommand(
  runtime: CommandRuntime,
  name: string,
  planned: PlannedCommand,
): V2CommandDefinition {
  return {
    name,
    ...(planned.description === undefined
      ? {}
      : { description: planned.description }),
    async execute(invocation) {
      const field = declaredRouting(planned)
      if (field !== undefined) {
        const message = refusalMessage(name, field)
        reportOnce(runtime, `refused:${name}`, message)
        throw new Error(message)
      }
      try {
        await submit(runtime, planned, invocation)
      } catch (error) {
        runtime.report(
          `command "${name}" failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        )
        throw error
      }
    },
  }
}

export const installCommands: V2Installer = async ({
  ctx,
  snapshot,
  guard,
  report,
}) => {
  // A plugin command with a built-in's name replaces it. The built-ins are
  // visible now; commands from the user's own config are applied after the
  // plugin transforms and replace ours instead.
  const builtIns =
    (await guard.async(
      'command list',
      async () =>
        new Set((await ctx.command.list()).data.map((entry) => entry.name)),
    )()) ?? new Set<string>()

  const runtime = createCommandRuntime(ctx, report)
  const transform = guard.sync('command transform', (editor: CommandEditor) => {
    for (const [name, planned] of Object.entries(snapshot.plan.commands)) {
      if (builtIns.has(name)) {
        reportOnce(
          runtime,
          `built-in:${name}`,
          `command "${name}" has the name of a built-in command; not registering the bundled one`,
        )
        continue
      }
      guard.sync(`command "${name}"`, () => {
        editor.add(buildCommand(runtime, name, planned))
      })()
    }
  })
  await guard.async('command registration', () =>
    ctx.command.transform(transform),
  )()
}
