/** Pi-specific adapter factory for the `systematic_delegate` tool. `noExtensions: true` is the structural depth-1 boundary; max turns is fixed at 20. */
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  type AgentCatalogEntry,
  resolveAgent,
  resolveToolAllowlist,
} from './agent-resolver.js'

/** Fixed, non-configurable delegation bounds (LOCKED). */
export const MAX_DELEGATE_TURNS = 20
export const DELEGATE_TOOL_NAME = 'systematic_delegate'
export const DELEGATE_EXECUTION_MODE = 'sequential' as const
const MAX_DELEGATE_DESCRIPTION_CHARS = 6000

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
  const intro = [
    `Delegate a task to one of Systematic's specialist personas.`,
    '',
    'Routing guidelines:',
    '- Use the narrowest persona that fits the task.',
    "- Send one concrete task plus constraints; don't ask the child to delegate again.",
    '- The child is in-process, sequential, capped at 20 turns, and inherits your model and working directory.',
    '',
    '## Available Personas',
    '',
  ].join('\n')

  const catalogText = renderDelegateCatalogCompact(
    catalog,
    MAX_DELEGATE_DESCRIPTION_CHARS - intro.length,
  )
  return `${intro}${catalogText}`
}

function buildAgentParameterHint(catalog: AgentCatalogEntry[]): string {
  const examples = catalog
    .slice(0, 3)
    .map((e) => `'${e.name}'`)
    .join(', ')
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ''
  return `Name of the Systematic persona to delegate to${hint}`
}

function compactText(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''

  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  if (maxChars === 1) return normalized.slice(0, 1)
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`
}

function buildPromptSnippet(body: string): string {
  const firstParagraph = body.split(/\n\s*\n/u, 1)[0] ?? body
  return compactText(firstParagraph, 96)
}

function renderDelegateCatalogCompact(
  catalog: AgentCatalogEntry[],
  budget: number,
): string {
  if (catalog.length === 0) {
    return 'No Systematic personas are currently available.'
  }

  const fixedOverhead =
    catalog.reduce(
      (total, entry) => total + `- ${entry.name}:  — promptSnippet: `.length,
      0,
    ) +
    (catalog.length - 1)

  if (budget <= fixedOverhead) {
    return catalog.map((entry) => `- ${entry.name}:`).join('\n')
  }

  const perEntryBudget = Math.floor((budget - fixedOverhead) / catalog.length)
  const descriptionBudget = Math.max(1, Math.floor(perEntryBudget * 0.6))
  const promptSnippetBudget = Math.max(1, perEntryBudget - descriptionBudget)

  return catalog
    .map((entry) => {
      const description = compactText(entry.description, descriptionBudget)
      const promptSnippet = compactText(
        buildPromptSnippet(entry.body),
        promptSnippetBudget,
      )
      return `- ${entry.name}: ${description} — promptSnippet: ${promptSnippet}`
    })
    .join('\n')
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
    promptSnippet:
      'Use the narrowest persona that fits the task, and delegate one concrete job.',
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

function buildSuccessResult(
  agentName: string,
  turnCount: number,
  text: string,
): AgentToolResult<DelegateToolDetails> {
  return {
    content: [{ type: 'text', text }],
    details: { persona: agentName, turnCount, outcome: 'completed' },
  }
}

function buildAbortError(agentName: string, turnCount: number): Error {
  const suffix =
    turnCount > 0
      ? ` after ${turnCount} turns`
      : ' before the child session finished starting'
  return new Error(`Delegation to "${agentName}" was aborted${suffix}.`)
}

function buildTurnLimitError(agentName: string, turnCount: number): Error {
  return new Error(
    `Delegation to "${agentName}" stopped after the ${MAX_DELEGATE_TURNS}-turn limit (${turnCount} turns).`,
  )
}

function buildFailureError(
  agentName: string,
  turnCount: number,
  message: string,
): Error {
  const suffix = turnCount > 0 ? ` after ${turnCount} turns` : ''
  return new Error(`Delegation to "${agentName}" failed${suffix}: ${message}`)
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

interface ValidatedDelegateRequest {
  agentName: string
  task: string
  personaBody: string
  allowedToolNames: string[]
  model: DelegateParentModel
}

function validateDelegateRequest(
  catalog: AgentCatalogEntry[],
  params: { agent: string; task: string },
  ctx: ExtensionContext,
): ValidatedDelegateRequest {
  const { agent: agentName, task } = params

  const persona = resolveAgent(catalog, agentName)
  if (!persona) {
    throw new Error(
      `Unknown persona "${agentName}". Available personas: ${catalog
        .map((e) => e.name)
        .join(', ')}`,
    )
  }

  if (ctx.model === undefined) {
    throw new Error(
      `Delegation to "${agentName}" cannot start because no model is available to inherit from the parent session; refusing to select a default model (fail-closed).`,
    )
  }

  let allowedToolNames: string[]
  try {
    allowedToolNames = resolveToolAllowlist(persona.toolsSource).tools
  } catch (error) {
    throw new Error(
      `Delegation to "${agentName}" cannot start because its tool allowlist is invalid: ${normalizeError(error).message}`,
    )
  }

  if (allowedToolNames.includes(DELEGATE_TOOL_NAME)) {
    throw new Error(
      `Internal error: resolved tool allowlist for persona "${agentName}" included ${DELEGATE_TOOL_NAME}; refusing to spawn (fail-closed re-entry guard).`,
    )
  }

  return {
    agentName,
    task,
    personaBody: persona.body,
    allowedToolNames,
    model: ctx.model,
  }
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

function cleanUpLateSession(session: DelegateSessionLike): void {
  void session
    .abort()
    .catch(() => {})
    .finally(() => {
      try {
        session.dispose()
      } catch {
        // Best-effort cleanup only.
      }
    })
}

/** Abort promise is raced against construction so parent abort can preempt a never-settling child factory. */
async function runValidatedDelegateSession(
  createDelegateSession: CreateDelegateSession,
  request: ValidatedDelegateRequest,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<AgentToolResult<DelegateToolDetails>> {
  const { agentName, task, personaBody, allowedToolNames, model } = request

  if (signal?.aborted) {
    throw buildAbortError(agentName, 0)
  }

  const state: DelegateRunState = {
    session: undefined,
    turnCount: 0,
    abortReason: undefined,
    abortPromise: undefined,
    abortError: undefined,
  }
  let unsubscribe: (() => void) | undefined
  let removeExternalAbortListener: (() => void) | undefined

  try {
    const sessionPromise = createDelegateSession({
      agentName,
      model,
      cwd,
      systemPromptOverride: personaBody,
      allowedToolNames,
    })

    void sessionPromise.then(
      (session) => {
        if (signal?.aborted || state.abortReason !== undefined) {
          cleanUpLateSession(session)
        }
      },
      () => {},
    )

    const sessionOrAbort = signal
      ? await Promise.race([
          sessionPromise.then((session) => ({
            kind: 'session' as const,
            session,
          })),
          new Promise<'aborted'>((resolve) => {
            const onAbort = () => {
              signal.removeEventListener('abort', onAbort)
              requestAbort(state, 'external')
              resolve('aborted')
            }
            signal.addEventListener('abort', onAbort)
            removeExternalAbortListener = () => {
              signal.removeEventListener('abort', onAbort)
            }
          }),
        ])
      : { kind: 'session' as const, session: await sessionPromise }

    if (sessionOrAbort === 'aborted') {
      throw buildAbortError(agentName, state.turnCount)
    }

    const activeSession = sessionOrAbort.session
    state.session = activeSession

    unsubscribe = subscribeTurnCap(activeSession, state)
    await runPromptRespectingAbort(activeSession, task, signal, state)

    if (state.abortPromise) await state.abortPromise

    if (state.abortError !== undefined) {
      throw buildFailureError(
        agentName,
        state.turnCount,
        normalizeError(state.abortError).message,
      )
    }

    if (state.abortReason === 'turn_limit') {
      throw buildTurnLimitError(agentName, state.turnCount)
    }

    if (state.abortReason === 'external') {
      throw buildAbortError(agentName, state.turnCount)
    }

    const text = activeSession.getLastAssistantText() ?? ''
    return buildSuccessResult(agentName, state.turnCount, text)
  } catch (error) {
    const normalized = normalizeError(error)
    if (
      normalized.message.startsWith(
        `Delegation to "${agentName}" was aborted`,
      ) ||
      normalized.message.startsWith(
        `Delegation to "${agentName}" stopped after`,
      ) ||
      normalized.message.startsWith(`Delegation to "${agentName}" failed`)
    ) {
      throw normalized
    }

    throw buildFailureError(agentName, state.turnCount, normalized.message)
  } finally {
    removeExternalAbortListener?.()
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
  const request = validateDelegateRequest(deps.catalog, params, ctx)
  return runValidatedDelegateSession(
    deps.createDelegateSession,
    request,
    signal,
    ctx.cwd,
  )
}
