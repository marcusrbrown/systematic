/** Pi-specific adapter factory for the `systematic_delegate` tool. `noExtensions: true` is the structural depth-1 boundary; max turns is fixed at 20. */
import type {
  AgentToolResult,
  CreateAgentSessionOptions,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  type AgentCatalogEntry,
  resolveAgent,
  resolveToolAllowlist,
} from './agent-resolver.js'
import type {
  PiSubagentsOverlayMap,
  SourcedOverlayConfigMap,
} from './config.js'
import {
  type RoutingFieldSource,
  resolveRouting,
  toSourcedPiSubagentsOverlays,
} from './routing-resolver.js'

/** Fixed, non-configurable delegation bounds (LOCKED). */
export const MAX_DELEGATE_TURNS = 20
export const DELEGATE_TOOL_NAME = 'systematic_delegate'
export const DELEGATE_EXECUTION_MODE = 'sequential' as const
const MAX_DELEGATE_DESCRIPTION_CHARS = 6000

export type DelegateOutcome = 'completed' | 'turn_limit' | 'aborted' | 'failed'

/** The parent session's model, narrowed to always-defined (validated before use). */
export type DelegateParentModel = NonNullable<ExtensionContext['model']>

/**
 * Derived from the pinned Pi SDK's own `CreateAgentSessionOptions` type
 * (`'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'` as of
 * @earendil-works/pi-coding-agent@0.83.0) rather than hand-declared, so a
 * future SDK bump that changes the union surfaces as a type error here
 * instead of silently drifting. Value-for-value identical to Systematic's
 * own `piSubagentsThinkingSchema` enum in config-schema.ts today — see
 * `isKnownThinkingLevel`'s runtime guard for the defence-in-depth check.
 */
export type DelegateThinkingLevel = NonNullable<
  CreateAgentSessionOptions['thinkingLevel']
>

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
  /** Omitted for a config-neutral or thinking-neutral dispatch — the child then inherits Pi's default thinking level. Resolved from `pi.thinking` (or the legacy `pi_subagents.thinking`) the same way `model` is; the pinned Pi SDK's `CreateAgentSessionOptions.thinkingLevel` field is what makes this a real session option, not just an export-time one. */
  thinkingLevel?: DelegateThinkingLevel
  cwd: string
  systemPromptOverride: string
  allowedToolNames: string[]
}) => Promise<DelegateSessionLike>

export interface PiDelegateToolDeps {
  catalog: AgentCatalogEntry[]
  createDelegateSession: CreateDelegateSession
  /**
   * Merged agent/category routing overlays from `loadConfigWithSources`'s
   * `overlays` field. Omit for a config-neutral tool — routing then always
   * inherits `ctx.model` (matches pre-Unit-5 behaviour).
   */
  overlays?: SourcedOverlayConfigMap
  /**
   * The final config's merged `pi_subagents` map (`SystematicConfig.pi_subagents`,
   * already project-stripped by the loader), for `resolveRouting`'s legacy
   * `thinking` fallback (R5). Model resolution never reads this map.
   */
  piSubagentsOverlays?: PiSubagentsOverlayMap
  /**
   * The active profile's name, from `ConfigObservationMetadata.activeProfile`.
   * Echoed in the R4a routing notice so a user with multiple profiles can
   * tell which one produced the model. `null`/omitted means no profile is
   * active.
   */
  activeProfile?: string | null
}

const EMPTY_ROUTING_OVERLAYS: SourcedOverlayConfigMap = {
  agents: {},
  categories: {},
}

/** Routing state shared across every dispatch made through one registered tool instance (closure-scoped; see R4a's "once per session" note). */
interface RoutingContext {
  overlays: SourcedOverlayConfigMap
  piSubagentsOverlays: SourcedOverlayConfigMap
  activeProfile: string | null
  /** Qualified persona ids (`category/key`) already notified once, per R4a. */
  notifiedAgentIds: Set<string>
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
  const { catalog, createDelegateSession } = deps
  // Built once per registered tool instance and captured by every dispatch's
  // closure below — this is the "once per session" state R4a's KTD describes
  // (the tool has no session object of its own to hang state on; a Pi
  // extension instance lives for the process's life, which is the session).
  const routing: RoutingContext = {
    overlays: deps.overlays ?? EMPTY_ROUTING_OVERLAYS,
    piSubagentsOverlays: toSourcedPiSubagentsOverlays(deps.piSubagentsOverlays),
    activeProfile: deps.activeProfile ?? null,
    notifiedAgentIds: new Set<string>(),
  }

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
      return runDelegateTool(
        { catalog, createDelegateSession },
        routing,
        params,
        signal,
        ctx,
      )
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
  notice: string | undefined,
): AgentToolResult<DelegateToolDetails> {
  return {
    content: [{ type: 'text', text: notice ? `${text}\n\n${notice}` : text }],
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
  thinkingLevel: DelegateThinkingLevel | undefined
  /** R4a one-line notice for the first dispatch of an agent whose model came from config; `undefined` otherwise. */
  routingNotice: string | undefined
  /**
   * Marks `persona.id` as notified in `RoutingContext.notifiedAgentIds`.
   * Present only alongside a defined `routingNotice`. Deliberately NOT
   * called at resolution time -- call it only once `createDelegateSession`
   * has actually produced a session, so a dispatch that fails before then
   * (e.g. `createDelegateSession` rejects) does not consume the one-time
   * notification slot for an agent the user was never actually told about.
   */
  commitRoutingNotice: (() => void) | undefined
}

/**
 * Systematic's `piSubagentsThinkingSchema` enum (config-schema.ts:
 * 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max') is value-for-value
 * identical to the pinned Pi SDK's `ThinkingLevel` union today, so a resolved
 * qualifier string never needs mapping — only a defence-in-depth runtime
 * check in case a future SDK bump narrows the union out from under a config
 * value schema validation already accepted.
 */
const KNOWN_THINKING_LEVELS: readonly DelegateThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

function isKnownThinkingLevel(value: string): value is DelegateThinkingLevel {
  return (KNOWN_THINKING_LEVELS as readonly string[]).includes(value)
}

/** `undefined` qualifier means no layer set `pi.thinking` (or the legacy `pi_subagents.thinking`) — the child then inherits Pi's default thinking level, same as an omitted `thinkingLevel` session option. */
function resolveThinkingLevel(
  agentName: string,
  qualifier: string | undefined,
): DelegateThinkingLevel | undefined {
  if (qualifier === undefined) return undefined
  if (!isKnownThinkingLevel(qualifier)) {
    throw new Error(
      `Delegation to "${agentName}" cannot start because the configured thinking level "${qualifier}" is not recognized by this Pi installation.`,
    )
  }
  return qualifier
}

/** Splits a `provider/model` routing string. `resolveRouting`'s inputs are schema-validated against `MODEL_PATTERN` upstream, so a malformed string here would indicate a config-loading bug — fails closed rather than silently misrouting. */
function splitModelString(
  agentName: string,
  modelString: string,
): { provider: string; id: string } {
  const separatorIndex = modelString.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex === modelString.length - 1) {
    throw new Error(
      `Delegation to "${agentName}" cannot start because the configured model "${modelString}" is not in "provider/model" format.`,
    )
  }
  return {
    provider: modelString.slice(0, separatorIndex),
    id: modelString.slice(separatorIndex + 1),
  }
}

/** One-line R4a notice naming the resolved model, its precedence layer, the applied thinking level (if any), and whether a profile was active. Format is this implementation's choice (plan left it "deferred to implementation"). */
function formatRoutingNotice(
  agentName: string,
  modelString: string,
  source: RoutingFieldSource,
  activeProfile: string | null,
  thinkingLevel: DelegateThinkingLevel | undefined,
): string {
  const profileNote =
    activeProfile !== null
      ? ` (active profile "${activeProfile}")`
      : ' (no active profile)'
  const thinkingNote =
    thinkingLevel !== undefined ? `, thinking "${thinkingLevel}"` : ''
  return `[systematic] "${agentName}" routed to model "${modelString}"${thinkingNote} from config (${source.level} ${source.form})${profileNote}.`
}

/**
 * One-line R4a notice for the case where no layer sets `model` (the
 * delegate inherits the parent session's model) but a `thinking` qualifier
 * DID resolve from config. Without this, a config whose only routing is
 * `pi.thinking` (or the legacy `pi_subagents.thinking`) silently applied
 * that thinking level with no R4a notice at all, since `formatRoutingNotice`
 * is only reachable when `resolution.source.model` is set.
 */
function formatInheritedModelThinkingNotice(
  agentName: string,
  source: RoutingFieldSource,
  activeProfile: string | null,
  thinkingLevel: DelegateThinkingLevel,
): string {
  const profileNote =
    activeProfile !== null
      ? ` (active profile "${activeProfile}")`
      : ' (no active profile)'
  return `[systematic] "${agentName}" routed on the inherited model with thinking "${thinkingLevel}" from config (${source.level} ${source.form})${profileNote}.`
}

interface ResolvedPersonaRouting {
  model: DelegateParentModel
  thinkingLevel: DelegateThinkingLevel | undefined
  notice: string | undefined
  /** Present only alongside `notice`; see `ValidatedDelegateRequest.commitRoutingNotice`. */
  commitNotice: (() => void) | undefined
}

/**
 * Resolves the dispatched persona's effective model and thinking level on
 * the `pi` harness. `resolveRouting`'s `model: string` wins over the parent
 * session's model; `undefined` (nothing set) or `null` (explicit "inherit",
 * e.g. a lower layer's `model: null` beating a category's pinned model) both
 * fall back to `ctx.model`, preserving the existing fail-closed rule when
 * that is also undefined. `thinkingLevel` resolves independently of which
 * branch supplied the model — a config can set `pi.thinking` alone with the
 * model inherited from the parent session.
 */
function resolvePersonaRouting(
  persona: AgentCatalogEntry,
  agentName: string,
  ctx: ExtensionContext,
  routing: RoutingContext,
): ResolvedPersonaRouting {
  const resolution = resolveRouting({
    overlays: routing.overlays,
    piSubagentsOverlays: routing.piSubagentsOverlays,
    target: { agentKey: persona.key, category: persona.category },
    harness: 'pi',
  })

  const thinkingLevel = resolveThinkingLevel(agentName, resolution.qualifier)

  if (typeof resolution.model !== 'string') {
    if (ctx.model === undefined) {
      throw new Error(
        `Delegation to "${agentName}" cannot start because no model is available to inherit from the parent session; refusing to select a default model (fail-closed).`,
      )
    }

    let inheritedNotice: string | undefined
    let inheritedCommitNotice: (() => void) | undefined
    const qualifierSource = resolution.source.qualifier
    if (
      thinkingLevel !== undefined &&
      qualifierSource &&
      !routing.notifiedAgentIds.has(persona.id)
    ) {
      inheritedNotice = formatInheritedModelThinkingNotice(
        agentName,
        qualifierSource,
        routing.activeProfile,
        thinkingLevel,
      )
      // Deliberately not committed here -- see the field doc on
      // `ValidatedDelegateRequest.commitRoutingNotice` for why the
      // one-time notification slot must survive a failed dispatch.
      inheritedCommitNotice = () => routing.notifiedAgentIds.add(persona.id)
    }

    return {
      model: ctx.model,
      thinkingLevel,
      notice: inheritedNotice,
      commitNotice: inheritedCommitNotice,
    }
  }

  const { provider, id } = splitModelString(agentName, resolution.model)
  const resolvedModel = ctx.modelRegistry.find(provider, id)
  if (!resolvedModel) {
    throw new Error(
      `Delegation to "${agentName}" cannot start because the configured model "${resolution.model}" is not registered with this Pi installation (unknown provider/model).`,
    )
  }

  let notice: string | undefined
  let commitNotice: (() => void) | undefined
  const source = resolution.source.model
  if (source && !routing.notifiedAgentIds.has(persona.id)) {
    notice = formatRoutingNotice(
      agentName,
      resolution.model,
      source,
      routing.activeProfile,
      thinkingLevel,
    )
    // Deliberately not committed here -- see the field doc on
    // `ValidatedDelegateRequest.commitRoutingNotice` for why the one-time
    // notification slot must survive a failed dispatch.
    commitNotice = () => routing.notifiedAgentIds.add(persona.id)
  }

  return { model: resolvedModel, thinkingLevel, notice, commitNotice }
}

function validateDelegateRequest(
  catalog: AgentCatalogEntry[],
  params: { agent: string; task: string },
  ctx: ExtensionContext,
  routing: RoutingContext,
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

  const { model, thinkingLevel, notice, commitNotice } = resolvePersonaRouting(
    persona,
    agentName,
    ctx,
    routing,
  )

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
    model,
    thinkingLevel,
    routingNotice: notice,
    commitRoutingNotice: commitNotice,
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
  const {
    agentName,
    task,
    personaBody,
    allowedToolNames,
    model,
    thinkingLevel,
    routingNotice,
    commitRoutingNotice,
  } = request

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
      thinkingLevel,
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
    // Session creation succeeded -- now, and only now, consume the
    // one-time routing-notice slot (see `ValidatedDelegateRequest.commitRoutingNotice`).
    commitRoutingNotice?.()

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
    return buildSuccessResult(agentName, state.turnCount, text, routingNotice)
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
  deps: Pick<PiDelegateToolDeps, 'catalog' | 'createDelegateSession'>,
  routing: RoutingContext,
  params: { agent: string; task: string },
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<DelegateToolDetails>> {
  const request = validateDelegateRequest(deps.catalog, params, ctx, routing)
  return runValidatedDelegateSession(
    deps.createDelegateSession,
    request,
    signal,
    ctx.cwd,
  )
}
