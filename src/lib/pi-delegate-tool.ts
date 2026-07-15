/** Pi-specific adapter factory for the `systematic_delegate` tool. `noExtensions: true` is the structural depth-1 boundary; max turns is fixed at 20. */
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  type AgentCatalogEntry,
  renderAgentCatalogCompact,
  resolveAgent,
  resolveToolAllowlist,
} from './agent-resolver.js'

/** Fixed, non-configurable delegation bounds (LOCKED). */
export const MAX_DELEGATE_TURNS = 20
export const DELEGATE_TOOL_NAME = 'systematic_delegate'
export const DELEGATE_EXECUTION_MODE = 'sequential' as const

export type DelegateOutcome = 'completed' | 'turn_limit' | 'aborted' | 'failed'

/** The parent session's model, narrowed to always-defined (validated before use). */
export type DelegateParentModel = NonNullable<ExtensionContext['model']>

export interface DelegateToolDetails {
  persona: string
  turnCount: number
  outcome: DelegateOutcome
}
export interface DelegateSessionLike {
  subscribe(listener: (event: { type: string }) => void): () => void
  prompt(text: string): Promise<void>
  abort(): Promise<void>
  dispose(): void
  getLastAssistantText(): string | undefined
}
export type CreateDelegateSession = (options: {
  agentName: string
  model: DelegateParentModel
  cwd: string
  systemPromptOverride: string
  allowedToolNames: string[]
}) => Promise<DelegateSessionLike>

export interface PiDelegateToolDeps {
  catalog: AgentCatalogEntry[]
  createDelegateSession: CreateDelegateSession
}

function buildDescription(catalog: AgentCatalogEntry[]): string {
  return `Delegate a task to one of Systematic's specialist personas, running as an ephemeral in-process subagent.

The child runs with no project/user extensions, a fixed 20-turn cap, and a least-privilege tool allowlist derived from the persona's declared tools. It inherits your model and working directory.

## Available Personas

${renderAgentCatalogCompact(catalog)}`
}

function buildAgentParameterHint(catalog: AgentCatalogEntry[]): string {
  const examples = catalog
    .slice(0, 3)
    .map((e) => `'${e.name}'`)
    .join(', ')
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ''
  return `Name of the Systematic persona to delegate to${hint}`
}
export function createPiDelegateTool(
  deps: PiDelegateToolDeps,
): ToolDefinition<
  ReturnType<typeof buildDelegateParametersSchema>,
  DelegateToolDetails
> {
  const { catalog } = deps

  return {
    name: DELEGATE_TOOL_NAME,
    label: 'Systematic Delegate',
    description: buildDescription(catalog),
    parameters: buildDelegateParametersSchema(catalog),
    executionMode: DELEGATE_EXECUTION_MODE,
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<DelegateToolDetails>> {
      return runDelegateTool(deps, params, signal, ctx)
    },
  } satisfies ToolDefinition<
    ReturnType<typeof buildDelegateParametersSchema>,
    DelegateToolDetails
  >
}

function buildDelegateParametersSchema(catalog: AgentCatalogEntry[]) {
  return Type.Object({
    agent: Type.String({ description: buildAgentParameterHint(catalog) }),
    task: Type.String({
      description: 'The task to delegate to the persona.',
    }),
  })
}

function errorResult(
  persona: string,
  outcome: DelegateOutcome,
  message: string,
  turnCount = 0,
): AgentToolResult<DelegateToolDetails> {
  return {
    content: [{ type: 'text', text: message }],
    details: { persona, turnCount, outcome },
    isError: true,
  } as AgentToolResult<DelegateToolDetails>
}

interface ValidatedDelegateRequest {
  agentName: string
  task: string
  personaBody: string
  allowedToolNames: string[]
  model: DelegateParentModel
}

type ValidationResult =
  | { ok: true; request: ValidatedDelegateRequest }
  | { ok: false; result: AgentToolResult<DelegateToolDetails> }
function validateDelegateRequest(
  catalog: AgentCatalogEntry[],
  params: { agent: string; task: string },
  ctx: ExtensionContext,
): ValidationResult {
  const { agent: agentName, task } = params

  const persona = resolveAgent(catalog, agentName)
  if (!persona) {
    return {
      ok: false,
      result: errorResult(
        agentName,
        'failed',
        `Unknown persona "${agentName}". Available personas: ${catalog
          .map((e) => e.name)
          .join(', ')}`,
      ),
    }
  }

  if (ctx.model === undefined) {
    return {
      ok: false,
      result: errorResult(
        agentName,
        'failed',
        'No model is available to inherit from the parent session; refusing to select a default model for the delegated child (fail-closed).',
      ),
    }
  }

  let allowedToolNames: string[]
  try {
    allowedToolNames = resolveToolAllowlist(persona.toolsSource).tools
  } catch (error) {
    return {
      ok: false,
      result: errorResult(
        agentName,
        'failed',
        error instanceof Error ? error.message : String(error),
      ),
    }
  }

  if (allowedToolNames.includes(DELEGATE_TOOL_NAME)) {
    return {
      ok: false,
      result: errorResult(
        agentName,
        'failed',
        `Internal error: resolved tool allowlist for persona "${agentName}" included ${DELEGATE_TOOL_NAME}; refusing to spawn (fail-closed re-entry guard).`,
      ),
    }
  }

  return {
    ok: true,
    request: {
      agentName,
      task,
      personaBody: persona.body,
      allowedToolNames,
      model: ctx.model,
    },
  }
}

function buildOutcomeResult(
  agentName: string,
  turnCount: number,
  outcome: DelegateOutcome,
  text: string,
): AgentToolResult<DelegateToolDetails> {
  if (outcome === 'turn_limit') {
    return {
      content: [
        {
          type: 'text',
          text: `Delegation to "${agentName}" was stopped after exceeding the ${MAX_DELEGATE_TURNS}-turn limit.`,
        },
      ],
      details: { persona: agentName, turnCount, outcome },
      isError: true,
    } as AgentToolResult<DelegateToolDetails>
  }

  if (outcome === 'aborted') {
    return {
      content: [
        { type: 'text', text: `Delegation to "${agentName}" was aborted.` },
      ],
      details: { persona: agentName, turnCount, outcome },
      isError: true,
    } as AgentToolResult<DelegateToolDetails>
  }

  return {
    content: [{ type: 'text', text }],
    details: { persona: agentName, turnCount, outcome: 'completed' },
  } as AgentToolResult<DelegateToolDetails>
}

type AbortReason = 'turn_limit' | 'external'

/** Mutable run state shared across the abort/turn-cap/prompt orchestration below. */
interface DelegateRunState {
  session: DelegateSessionLike | undefined
  turnCount: number
  abortReason: AbortReason | undefined
  abortPromise: Promise<void> | undefined
  abortError: unknown
}

function requestAbort(state: DelegateRunState, reason: AbortReason): void {
  if (state.abortPromise) return
  state.abortReason = reason
  state.abortPromise = state.session?.abort().catch((error: unknown) => {
    state.abortError = error
  })
}

/** Installed Pi 0.80.6 emits `turn_start` before assistant streaming, so candidate turn 21 triggers abort while the public count stays at 20. */
function subscribeTurnCap(
  session: DelegateSessionLike,
  state: DelegateRunState,
): () => void {
  return session.subscribe((event) => {
    if (event.type !== 'turn_start') return
    if (state.turnCount >= MAX_DELEGATE_TURNS) {
      requestAbort(state, 'turn_limit')
      return
    }
    state.turnCount += 1
  })
}

/** Abort outcome stays authoritative over a `prompt()` rejection caused by our own `requestAbort()`. */
async function runPromptRespectingAbort(
  session: DelegateSessionLike,
  task: string,
  signal: AbortSignal | undefined,
  state: DelegateRunState,
): Promise<void> {
  const onExternalAbort = () => requestAbort(state, 'external')
  signal?.addEventListener('abort', onExternalAbort)

  // Abort is rechecked here since it may have fired during async session construction, before this listener existed.
  if (signal?.aborted) {
    requestAbort(state, 'external')
  }

  try {
    if (!state.abortReason) {
      await session.prompt(task)
    }
  } catch (promptError) {
    if (!state.abortReason) throw promptError
  } finally {
    signal?.removeEventListener('abort', onExternalAbort)
  }
}

/** Abort promise is awaited before dispose; abort outcome stays authoritative over other failure paths. */
async function runValidatedDelegateSession(
  createDelegateSession: CreateDelegateSession,
  request: ValidatedDelegateRequest,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<AgentToolResult<DelegateToolDetails>> {
  const { agentName, task, personaBody, allowedToolNames, model } = request

  if (signal?.aborted) {
    return buildOutcomeResult(agentName, 0, 'aborted', '')
  }

  const state: DelegateRunState = {
    session: undefined,
    turnCount: 0,
    abortReason: undefined,
    abortPromise: undefined,
    abortError: undefined,
  }
  let unsubscribe: (() => void) | undefined

  try {
    state.session = await createDelegateSession({
      agentName,
      model,
      cwd,
      systemPromptOverride: personaBody,
      allowedToolNames,
    })
    const activeSession = state.session

    unsubscribe = subscribeTurnCap(activeSession, state)
    await runPromptRespectingAbort(activeSession, task, signal, state)

    if (state.abortPromise) await state.abortPromise

    if (state.abortError !== undefined) {
      throw state.abortError instanceof Error
        ? state.abortError
        : new Error(String(state.abortError))
    }

    const outcome: DelegateOutcome =
      state.abortReason === 'turn_limit'
        ? 'turn_limit'
        : state.abortReason === 'external'
          ? 'aborted'
          : 'completed'
    const text = activeSession.getLastAssistantText() ?? ''
    return buildOutcomeResult(agentName, state.turnCount, outcome, text)
  } catch (error) {
    return errorResult(
      agentName,
      'failed',
      error instanceof Error ? error.message : String(error),
      state.turnCount,
    )
  } finally {
    unsubscribe?.()
    state.session?.dispose()
  }
}

async function runDelegateTool(
  deps: PiDelegateToolDeps,
  params: { agent: string; task: string },
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<DelegateToolDetails>> {
  const validation = validateDelegateRequest(deps.catalog, params, ctx)
  if (!validation.ok) return validation.result

  return runValidatedDelegateSession(
    deps.createDelegateSession,
    validation.request,
    signal,
    ctx.cwd,
  )
}
