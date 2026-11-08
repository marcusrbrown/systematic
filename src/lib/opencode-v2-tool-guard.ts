import type { V2Installer } from './opencode-v2.js'

/**
 * Read-only tool guard for OpenCode v2.
 *
 * A v2 agent's own `permission:` rules are evaluated before a session's rules,
 * so a session-level allow lifts them, and `execute` (Code Mode) reaches
 * host-native tools no frontmatter key can name. This guard does not use rules.
 * It registers one `execute.before` hook. The host triggers that hook for every
 * tool call a session makes, before the call is looked up or run: a call the
 * model makes directly, a call to a tool the agent was never offered, and each
 * call made from inside Code Mode, which arrives under the host-native tool
 * name (`opencode_*`) with the session's agent. The hook sees the agent's name
 * and the tool's name, and a throw fails that one call with the message as the
 * tool's error, leaving the session running.
 *
 * The rule is an allowlist keyed on the agent's name. A listed agent may call
 * only the tools in {@link READ_ONLY_TOOL_ALLOWLIST}; anything else, including
 * a tool this code has never heard of, is refused. Every other agent is left
 * alone. Nothing here reads the agent's definition or any frontmatter field.
 *
 * The throw is deliberate and is not routed through the adapter's never-throw
 * guard, which would swallow it and let the call run.
 *
 * Registration fails closed. A failed `hook` call is not swallowed here: it
 * rejects, and `setupOpenCodeV2` then leaves the agents this guard protects out
 * of the plan, because a read-only agent without its allowlist is not read-only.
 */

/** Agents that may use only the read-only tools. Matched by exact name. */
export const READ_ONLY_AGENT_NAMES: readonly string[] = [
  'connections-researcher',
]

/** The only tools a read-only agent may call. Matched by exact name. */
export const READ_ONLY_TOOL_ALLOWLIST: readonly string[] = [
  'read',
  'grep',
  'glob',
  'skill',
  'systematic_search',
  'systematic_skill',
]

export type ToolCallVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly message: string }

const ALLOWED: ToolCallVerdict = { allowed: true }

/** Pure decision: may `agent` call `tool`? Never throws. */
export function decideToolCall(agent: unknown, tool: unknown): ToolCallVerdict {
  if (typeof agent !== 'string' || !READ_ONLY_AGENT_NAMES.includes(agent)) {
    return ALLOWED
  }
  if (typeof tool === 'string' && READ_ONLY_TOOL_ALLOWLIST.includes(tool)) {
    return ALLOWED
  }
  const name = typeof tool === 'string' ? tool : 'unknown'
  return {
    allowed: false,
    message: `The tool "${name}" is not available to the read-only ${agent} agent. It may call only: ${READ_ONLY_TOOL_ALLOWLIST.join(', ')}.`,
  }
}

interface ToolCallEvent {
  readonly agent?: unknown
  readonly tool?: unknown
}

/** The hook body. Throws to refuse the call; returns quietly to allow it. */
function refuseOutsideAllowlist(event: ToolCallEvent): void {
  const verdict = decideToolCall(event.agent, event.tool)
  if (!verdict.allowed) throw new Error(verdict.message)
}

export const installToolGuard: V2Installer = async ({ ctx }) => {
  await ctx.tool.hook('execute.before', refuseOutsideAllowlist)
}
