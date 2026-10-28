import type { Plugin } from '@opencode/plugin'
import type { PlannedCommand } from './asset-plan.js'
import type { SafeGuard, V2Installer } from './opencode-v2.js'
import { substituteSkillArguments } from './skill-resolver.js'
import { isRecord } from './validation.js'

/**
 * Systematic commands on OpenCode v2.
 *
 * A v2 plugin command receives the text typed after its name, untouched, and
 * submits its own prompt. So this module does what OpenCode's own command path
 * does for a stored command: expand `$ARGUMENTS` and `$1..$N`, route to the
 * command's agent and model, and run as a child session in subagent mode. It
 * never runs `!`-backtick blocks; their text stays literal in the prompt.
 *
 * `prompt` takes no agent or model, so routing switches the session and
 * switches it back once the turn ends. Both the turn and a subagent run
 * continue after `execute` returns, so the invoker is not held for their whole
 * length.
 */

type CommandEditor = Parameters<
  Parameters<Plugin.Context['command']['transform']>[0]
>[0]
export type V2CommandDefinition = Parameters<CommandEditor['add']>[0]
type Invocation = Parameters<V2CommandDefinition['execute']>[0]
type PromptAttachments = Pick<
  Invocation['prompt'],
  'files' | 'agents' | 'skills'
>

export interface V2ModelRef {
  providerID: string
  id: string
  variant?: string
}

/** The agents a command can name: what `ctx.agent.list()` reports. */
interface HostAgent {
  id: string
  mode: 'primary' | 'subagent' | 'all'
  model?: V2ModelRef
}

export interface CommandRuntime {
  ctx: Plugin.Context
  guard: SafeGuard
  report: (message: string) => void
  /** Diagnostics already written, so a command run twice reports once. */
  reported: Set<string>
  /** Turns and subagent runs still going after their `execute` returned. */
  background: Set<Promise<unknown>>
  /** Per session: the pending put-back of a command's agent and model. */
  restoring: Map<string, Promise<unknown>>
}

export function createCommandRuntime(
  ctx: Plugin.Context,
  guard: SafeGuard,
  report: (message: string) => void,
): CommandRuntime {
  return {
    ctx,
    guard,
    report,
    reported: new Set(),
    background: new Set(),
    restoring: new Map(),
  }
}

function reportOnce(runtime: CommandRuntime, key: string, message: string) {
  if (runtime.reported.has(key)) return
  runtime.reported.add(key)
  runtime.report(message)
}

/** `provider/model` or `provider/model#variant` to the v2 model reference. */
export function parseModelRef(value: string): V2ModelRef | undefined {
  const hash = value.indexOf('#')
  const base = hash === -1 ? value : value.slice(0, hash)
  const variant = hash === -1 ? undefined : value.slice(hash + 1)
  if (variant === '') return undefined
  const slash = base.indexOf('/')
  if (slash <= 0 || slash === base.length - 1) return undefined
  const providerID = base.slice(0, slash)
  const id = base.slice(slash + 1)
  return variant === undefined
    ? { providerID, id }
    : { providerID, id, variant }
}

function sameModel(a: V2ModelRef, b: V2ModelRef): boolean {
  return (
    a.providerID === b.providerID &&
    a.id === b.id &&
    (a.variant ?? 'default') === (b.variant ?? 'default')
  )
}

interface Route {
  agent: HostAgent | undefined
  model: V2ModelRef | undefined
  subagent: boolean
}

async function resolveRoute(
  runtime: CommandRuntime,
  name: string,
  planned: PlannedCommand,
): Promise<Route> {
  let agent: HostAgent | undefined
  if (planned.agent !== undefined) {
    // `switchAgent` to an id nobody registered succeeds, and then every turn
    // of the session fails. Look the agent up first.
    const listed = await runtime.ctx.agent.list()
    agent = listed.data.find((candidate) => candidate.id === planned.agent)
    if (agent === undefined) {
      reportOnce(
        runtime,
        `agent:${name}`,
        `command "${name}" names agent "${planned.agent}", which is not registered; running on the current agent`,
      )
    }
  }

  let model: V2ModelRef | undefined
  if (planned.model !== undefined) {
    model = parseModelRef(planned.model)
    if (model === undefined) {
      reportOnce(
        runtime,
        `model:${name}`,
        `command "${name}" has model "${planned.model}", which is not provider/model; ignoring the model`,
      )
    }
  }

  // The rule OpenCode applies to a stored command: a child when asked for, or
  // when the agent is a subagent and the command did not opt out.
  const subagent =
    planned.subtask === true ||
    (planned.subtask !== false && agent?.mode === 'subagent')
  return { agent, model, subagent }
}

function attachmentsOf(invocation: Invocation): PromptAttachments {
  const { files, agents, skills } = invocation.prompt
  return { files, agents, skills }
}

/** Runs `task` after `execute` has returned and keeps it reachable until it ends. */
function startBackground(
  runtime: CommandRuntime,
  label: string,
  task: () => Promise<void>,
): Promise<void> {
  const running = runtime.guard.async(label, task)()
  const tracked = running.then(() => undefined)
  runtime.background.add(tracked)
  void tracked.finally(() => runtime.background.delete(tracked))
  return tracked
}

interface SessionSnapshot {
  agent: string | undefined
  model: V2ModelRef | undefined
}

async function readSession(
  runtime: CommandRuntime,
  sessionID: string,
): Promise<SessionSnapshot> {
  const info = await runtime.ctx.session.get({ sessionID })
  return { agent: info.agent, model: info.model }
}

interface Switched {
  /** The agent the command switched to, when it did. */
  agent: string | undefined
  /** The model the command switched to, when it did. */
  model: V2ModelRef | undefined
}

/**
 * Put back what the command switched, but only while the session still shows
 * what the command set. A switch made by the user in the meantime stays.
 */
async function restoreSession(
  runtime: CommandRuntime,
  sessionID: string,
  before: SessionSnapshot,
  switched: Switched,
): Promise<void> {
  const { session } = runtime.ctx
  let agentRestored = false
  const current = await readSession(runtime, sessionID)
  if (
    switched.agent !== undefined &&
    before.agent !== undefined &&
    current.agent === switched.agent
  ) {
    await session.switchAgent({ sessionID, agent: before.agent })
    agentRestored = true
  }
  if (before.model === undefined) return
  const now = agentRestored ? await readSession(runtime, sessionID) : current
  if (now.model === undefined || sameModel(now.model, before.model)) return
  // An explicit model is undone while it is still the one in place. Switching
  // the agent back can also bring the previous agent's model along, which
  // is undone when the agent was ours to put back.
  const stillOurs =
    switched.model !== undefined && sameModel(now.model, switched.model)
  if (stillOurs || (agentRestored && switched.agent !== undefined)) {
    await session.switchModel({ sessionID, model: before.model })
  }
}

async function runInline(
  runtime: CommandRuntime,
  name: string,
  invocation: Invocation,
  text: string,
  route: Route,
): Promise<void> {
  const { ctx } = runtime
  const sessionID = invocation.sessionID
  // A run that overlaps the previous one would read its switched state as the
  // original. Wait for that run to put the session back first.
  await runtime.restoring.get(sessionID)

  const before = await readSession(runtime, sessionID)
  const agentID = route.agent?.id
  const switched: Switched = {
    agent:
      agentID !== undefined && before.agent !== agentID ? agentID : undefined,
    model: route.model,
  }

  try {
    if (switched.agent !== undefined) {
      await ctx.session.switchAgent({ sessionID, agent: switched.agent })
    }
    if (switched.model !== undefined) {
      await ctx.session.switchModel({ sessionID, model: switched.model })
    }
    await ctx.session.prompt({
      sessionID,
      text,
      ...attachmentsOf(invocation),
      delivery: invocation.delivery,
    })
  } catch (error) {
    // The prompt error is the one the invoker needs; a failed put-back is
    // reported on its own and never replaces it.
    await restoreSession(runtime, sessionID, before, switched).catch(
      (restoreError: unknown) => {
        runtime.report(
          `command "${name}" could not restore the session: ${restoreError instanceof Error ? restoreError.message : 'unknown error'}`,
        )
      },
    )
    throw error
  }

  if (switched.agent === undefined && switched.model === undefined) return
  const restore = startBackground(
    runtime,
    `command "${name}" restore`,
    async () => {
      await ctx.session.wait({ sessionID })
      await restoreSession(runtime, sessionID, before, switched)
    },
  )
  runtime.restoring.set(sessionID, restore)
  void restore.finally(() => {
    if (runtime.restoring.get(sessionID) === restore) {
      runtime.restoring.delete(sessionID)
    }
  })
}

function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message.type !== 'assistant') continue
    if (!Array.isArray(message.content)) return ''
    return message.content
      .filter(
        (part): part is { type: 'text'; text: string } =>
          isRecord(part) &&
          part.type === 'text' &&
          typeof part.text === 'string',
      )
      .map((part) => part.text)
      .join('\n')
  }
  return ''
}

async function startSubagent(
  runtime: CommandRuntime,
  name: string,
  invocation: Invocation,
  text: string,
  route: Route,
): Promise<void> {
  const { ctx } = runtime
  const parentID = invocation.sessionID
  const parent = await readSession(runtime, parentID)
  const agent = route.agent?.id ?? parent.agent
  // The command's model, else the agent's own, else the parent's. A model set
  // on the child would hide the agent's own, so it is left off in that case.
  const model =
    route.model ?? (route.agent?.model === undefined ? parent.model : undefined)

  const child = await ctx.session.create({
    parentID,
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    title: name,
  })
  await ctx.session.prompt({
    sessionID: child.id,
    text,
    ...attachmentsOf(invocation),
  })

  void startBackground(runtime, `command "${name}" subagent`, async () => {
    await ctx.session.wait({ sessionID: child.id })
    const outcome = (await ctx.session.get({ sessionID: child.id })).outcome
    const reply = lastAssistantText(
      await ctx.session.context({ sessionID: child.id }),
    )
    const finished = outcome === undefined || outcome === 'succeeded'
    const body = reply === '' ? '(the subagent returned no text)' : reply
    await ctx.session.synthetic({
      sessionID: parentID,
      text: finished
        ? `Result of command ${name} (subagent session ${child.id}):\n\n${body}`
        : `Command ${name} did not finish: its subagent session ${child.id} ${outcome}.${reply === '' ? '' : `\n\n${reply}`}`,
      description: `Result of ${name}`,
      delivery: invocation.delivery,
    })
  })
}

async function runCommand(
  runtime: CommandRuntime,
  name: string,
  planned: PlannedCommand,
  invocation: Invocation,
): Promise<void> {
  // The text is exactly what was typed after the name; expanding it is ours.
  const text = substituteSkillArguments(
    planned.template,
    invocation.prompt.text,
  )
  const route = await resolveRoute(runtime, name, planned)
  await (route.subagent
    ? startSubagent(runtime, name, invocation, text, route)
    : runInline(runtime, name, invocation, text, route))
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
      try {
        await runCommand(runtime, name, planned, invocation)
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

  const runtime = createCommandRuntime(ctx, guard, report)
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
