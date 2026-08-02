import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Language, type Node, Parser } from 'web-tree-sitter'

import type {
  ReceiptClassification,
  ReceiptContext,
  ReceiptObservationAfter,
  ReceiptOperation,
  ReceiptReasonCode,
  TerminalObservation,
} from './receipt-ledger.js'

export interface ReceiptClassificationInput {
  command: string
  terminal: TerminalObservation
}

export interface ReceiptClassifierOptions {
  treeSitterWasmPath?: string
  bashWasmPath?: string
}

export interface ReceiptClassifier {
  classify(input: unknown): Promise<ReceiptClassification>
  classifyOperation?(input: unknown): Promise<ReceiptClassification>
  close(): Promise<void>
}

export type ReceiptOperationTool =
  | 'edit'
  | 'write'
  | 'apply-patch'
  | 'apply_patch'
  | 'bash'
  | 'git'
  | 'gh'
  | 'bun'
  | 'npm'

export type PullRequestObservationState = 'open' | 'closed' | 'merged'
export type CheckObservationState =
  | 'completed-success'
  | 'completed-failure'
  | 'pending'
export type ReviewObservationDecision =
  | 'approved'
  | 'changes-requested'
  | 'commented'
  | 'pending'

export interface ReceiptOperationContext extends ReceiptContext {
  resourceRevisionIdentity?: string
}

export interface ReceiptOperationAfter extends ReceiptObservationAfter {
  commitClosure?: boolean
  pullRequest?: {
    identity: string
    state: PullRequestObservationState
  }
  resourceRevisionIdentity?: string
  checkState?: CheckObservationState
  reviewDecision?: ReviewObservationDecision
}

export interface ReceiptOperationObservation {
  callId: string
  operation: ReceiptOperation
  tool: ReceiptOperationTool
  command?: string
  context: ReceiptOperationContext
  after?: ReceiptOperationAfter
  terminal: TerminalObservation
}

export function parseReceiptOperationAfter(
  input: unknown,
): ReceiptOperationAfter | undefined {
  return parseOperationAfter(input)
}

export function parseReceiptOperationObservation(
  input: unknown,
): ReceiptOperationObservation | undefined {
  return parseOperationInput(input)
}

interface ParsedCommand {
  executable: string
  arguments: string[]
}

interface ParsedOperationInput {
  callId: string
  operation: ReceiptOperation
  tool: ReceiptOperationTool
  command?: string
  context: ReceiptOperationContext
  after?: ReceiptOperationAfter
  terminal: TerminalObservation
}

interface ParserClassification {
  classification: ReceiptClassification
  executable?: string
}

interface ParsedOperationStateFields {
  repositoryIdentity?: string
  worktreeIdentity?: string
  operationTargetIdentity?: string
  resourceIdentity?: string
  resourceRevisionIdentity?: string
}

interface ParserAssets {
  language: Language
}

type ParserFailure =
  | 'parser-asset-unavailable'
  | 'grammar-incompatible'
  | 'parser-failure'

const SUPPORTED_ABI_MINIMUM = 13
const SUPPORTED_ABI_MAXIMUM = 15
const MAX_COMMAND_LENGTH = 4096
const DIGEST_IDENTITY_PATTERN = /^[0-9a-f]{64}$/
const PROHIBITED_NODE_TYPES = new Set([
  'arithmetic_expansion',
  'case_statement',
  'command_substitution',
  'compound_statement',
  'declaration_command',
  'for_statement',
  'function_definition',
  'heredoc_body',
  'heredoc_start',
  'if_statement',
  'negated_command',
  'pipeline',
  'process_substitution',
  'redirected_statement',
  'subshell',
  'test_command',
  'until_statement',
  'while_statement',
])

const PREFIX_COMMANDS = new Set(['cd'])
const ALLOWED_ENVIRONMENT_NAMES = new Set(['CI'])

export function createReceiptClassifier(
  options: ReceiptClassifierOptions = {},
): ReceiptClassifier {
  let closed = false
  let parserAssets: Promise<ParserAssets> | undefined

  async function loadAssets(): Promise<ParserAssets> {
    if (parserAssets) return parserAssets
    parserAssets = initializeParserAssets(options)
    return parserAssets
  }

  return {
    async classify(input: unknown): Promise<ReceiptClassification> {
      if (closed) {
        return unavailable('classifier-closed')
      }

      const parsedInput = parseInput(input)
      if (!parsedInput)
        return rejected(null, 'unknown', 'invalid-terminal-result')

      let assets: ParserAssets
      try {
        assets = await loadAssets()
      } catch (error) {
        return unavailable(classifyParserFailure(error))
      }

      return classifyWithParser(assets, parsedInput)
    },
    async classifyOperation(input: unknown): Promise<ReceiptClassification> {
      if (closed) return unavailable('classifier-closed')

      const parsedInput = parseOperationInput(input)
      if (!parsedInput)
        return rejected(null, 'unknown', 'invalid-terminal-result')
      if (isShellTool(parsedInput.tool))
        return classifyShellOperation(parsedInput, loadAssets)
      return classifyNonShellOperation(parsedInput)
    },
    async close(): Promise<void> {
      closed = true
      parserAssets = undefined
    },
  }
}

export type { ReceiptOperation }

async function classifyShellOperation(
  input: ParsedOperationInput,
  loadAssets: () => Promise<ParserAssets>,
): Promise<ReceiptClassification> {
  if (!input.command) return invalidOperationClassification(input.operation)
  let assets: ParserAssets
  try {
    assets = await loadAssets()
  } catch (error) {
    return unavailable(classifyParserFailure(error))
  }
  const parsed = classifyWithParserDetails(assets, {
    command: input.command,
    terminal: input.terminal,
  })
  if (
    parsed.executable &&
    !matchesToolIdentity(input.tool, parsed.executable)
  ) {
    return rejected(
      parsed.classification.category,
      parsed.classification.result,
      'classification-rejected',
      sideEffectFor(input.operation),
    )
  }
  return validateOperationEvidence(input, parsed.classification)
}

function classifyNonShellOperation(
  input: ParsedOperationInput,
): ReceiptClassification {
  if (input.command !== undefined)
    return invalidOperationClassification(input.operation)
  return validateOperationEvidence(
    input,
    terminalClassification('implementation', input.terminal),
  )
}

function invalidOperationClassification(
  operation: ReceiptOperation,
): ReceiptClassification {
  return rejected(
    operation,
    'unknown',
    'invalid-terminal-result',
    sideEffectFor(operation),
  )
}

function sideEffectFor(
  operation: ReceiptOperation,
): 'required' | 'not-required' {
  return operationNeedsSideEffect(operation) ? 'required' : 'not-required'
}

function parseInput(value: unknown): ReceiptClassificationInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const candidate = value as { command?: unknown; terminal?: unknown }
  if (
    typeof candidate.command !== 'string' ||
    candidate.command.length === 0 ||
    candidate.command.length > MAX_COMMAND_LENGTH ||
    typeof candidate.terminal !== 'object' ||
    candidate.terminal === null ||
    Array.isArray(candidate.terminal)
  ) {
    return undefined
  }
  const terminal = candidate.terminal as Partial<TerminalObservation>
  if (
    (terminal.status !== 'success' &&
      terminal.status !== 'failure' &&
      terminal.status !== 'cancelled' &&
      terminal.status !== 'running' &&
      terminal.status !== 'unknown') ||
    (terminal.output !== 'empty' &&
      terminal.output !== 'non-empty' &&
      terminal.output !== 'unknown') ||
    typeof terminal.noOp !== 'boolean'
  ) {
    return undefined
  }
  return {
    command: candidate.command,
    terminal: {
      status: terminal.status,
      output: terminal.output,
      noOp: terminal.noOp,
    },
  }
}

const OPERATION_SET: ReadonlySet<string> = new Set([
  'implementation',
  'verification',
  'commit',
  'push',
  'pr-creation',
  'check-readback',
  'review-readback',
])

const OPERATION_TOOL_SET: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'apply-patch',
  'apply_patch',
  'bash',
  'git',
  'gh',
  'bun',
  'npm',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((field) => fields.has(field))
}

function isBoundedIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.trim().length > 0
  )
}

function isDigestIdentity(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_IDENTITY_PATTERN.test(value)
}

function isOperation(value: unknown): value is ReceiptOperation {
  return typeof value === 'string' && OPERATION_SET.has(value)
}

function isOperationTool(value: unknown): value is ReceiptOperationTool {
  return typeof value === 'string' && OPERATION_TOOL_SET.has(value)
}

function parseOperationContext(
  value: unknown,
): ReceiptOperationContext | undefined {
  if (!isRecord(value)) return undefined
  if (
    !hasOnlyFields(
      value,
      new Set([
        'epochId',
        'unitId',
        'workspaceIdentity',
        'repositoryIdentity',
        'worktreeIdentity',
        'operationTargetIdentity',
        'resourceIdentity',
        'resourceRevisionIdentity',
      ]),
    )
  ) {
    return undefined
  }
  if (!hasRequiredOperationIdentities(value)) return undefined
  const fields = parseOperationStateFields(value)
  if (!fields) return undefined
  return {
    epochId: value.epochId,
    unitId: value.unitId,
    workspaceIdentity: value.workspaceIdentity,
    ...fields,
  }
}

function hasRequiredOperationIdentities(
  value: Record<string, unknown>,
): value is Record<string, string | undefined> & {
  epochId: string
  unitId: string
  workspaceIdentity: string
} {
  return (
    isBoundedIdentity(value.epochId) &&
    isBoundedIdentity(value.unitId) &&
    isDigestIdentity(value.workspaceIdentity)
  )
}

function parseOperationStateFields(
  value: Record<string, unknown>,
): ParsedOperationStateFields | undefined {
  const repositoryIdentity = parseOptionalDigestIdentity(
    value.repositoryIdentity,
  )
  const worktreeIdentity = parseOptionalDigestIdentity(value.worktreeIdentity)
  const operationTargetIdentity = parseOptionalDigestIdentity(
    value.operationTargetIdentity,
  )
  const resourceIdentity = parseOptionalDigestIdentity(value.resourceIdentity)
  const resourceRevisionIdentity = parseOptionalDigestIdentity(
    value.resourceRevisionIdentity,
  )
  if (
    !validOptionalIdentity(value.repositoryIdentity, repositoryIdentity) ||
    !validOptionalIdentity(value.worktreeIdentity, worktreeIdentity) ||
    !validOptionalIdentity(
      value.operationTargetIdentity,
      operationTargetIdentity,
    ) ||
    !validOptionalIdentity(value.resourceIdentity, resourceIdentity) ||
    !validOptionalIdentity(
      value.resourceRevisionIdentity,
      resourceRevisionIdentity,
    )
  ) {
    return undefined
  }
  return {
    repositoryIdentity,
    worktreeIdentity,
    operationTargetIdentity,
    resourceIdentity,
    resourceRevisionIdentity,
  }
}

function parseOptionalDigestIdentity(value: unknown): string | undefined {
  return value === undefined || !isDigestIdentity(value) ? undefined : value
}

function validOptionalIdentity(
  input: unknown,
  parsed: string | undefined,
): boolean {
  return input === undefined || parsed !== undefined
}

function parseOperationAfter(
  value: unknown,
): ReceiptOperationAfter | undefined {
  if (!isRecord(value)) return undefined
  if (!hasOnlyFields(value, OPERATION_AFTER_FIELDS)) {
    return undefined
  }
  if (!isDigestIdentity(value.workspaceIdentity)) return undefined
  const fields = parseOperationStateFields(value)
  if (!fields) return undefined
  const pullRequest = parseOptionalPullRequest(value.pullRequest)
  if (pullRequest === null) return undefined
  if (
    value.commitClosure !== undefined &&
    typeof value.commitClosure !== 'boolean'
  ) {
    return undefined
  }
  if (
    !isCheckState(value.checkState) ||
    !isReviewDecision(value.reviewDecision)
  ) {
    return undefined
  }
  return {
    workspaceIdentity: value.workspaceIdentity,
    ...fields,
    ...(pullRequest ? { pullRequest } : {}),
    ...(value.checkState !== undefined ? { checkState: value.checkState } : {}),
    ...(value.reviewDecision !== undefined
      ? { reviewDecision: value.reviewDecision }
      : {}),
    ...(value.commitClosure !== undefined
      ? { commitClosure: value.commitClosure }
      : {}),
  }
}

const OPERATION_AFTER_FIELDS = new Set([
  'workspaceIdentity',
  'repositoryIdentity',
  'worktreeIdentity',
  'operationTargetIdentity',
  'resourceIdentity',
  'resourceRevisionIdentity',
  'pullRequest',
  'checkState',
  'reviewDecision',
  'commitClosure',
])

function parseOptionalPullRequest(
  value: unknown,
): ReceiptOperationAfter['pullRequest'] | null | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, new Set(['identity', 'state'])) ||
    !isDigestIdentity(value.identity) ||
    !isPullRequestState(value.state)
  ) {
    return null
  }
  return { identity: value.identity, state: value.state }
}

function isPullRequestState(
  value: unknown,
): value is PullRequestObservationState {
  return value === 'open' || value === 'closed' || value === 'merged'
}

function isCheckState(
  value: unknown,
): value is CheckObservationState | undefined {
  return (
    value === undefined ||
    value === 'completed-success' ||
    value === 'completed-failure' ||
    value === 'pending'
  )
}

function isReviewDecision(
  value: unknown,
): value is ReviewObservationDecision | undefined {
  return (
    value === undefined ||
    value === 'approved' ||
    value === 'changes-requested' ||
    value === 'commented' ||
    value === 'pending'
  )
}

function parseOperationTerminal(
  value: unknown,
): TerminalObservation | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, new Set(['status', 'output', 'noOp']))
  ) {
    return undefined
  }
  if (
    (value.status !== 'success' &&
      value.status !== 'failure' &&
      value.status !== 'cancelled' &&
      value.status !== 'running' &&
      value.status !== 'unknown') ||
    (value.output !== 'empty' &&
      value.output !== 'non-empty' &&
      value.output !== 'unknown') ||
    typeof value.noOp !== 'boolean'
  ) {
    return undefined
  }
  return {
    status: value.status,
    output: value.output,
    noOp: value.noOp,
  }
}

function parseOperationInput(value: unknown): ParsedOperationInput | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyFields(
      value,
      new Set([
        'callId',
        'operation',
        'tool',
        'command',
        'context',
        'after',
        'terminal',
      ]),
    ) ||
    !isBoundedIdentity(value.callId) ||
    !isOperation(value.operation) ||
    !isOperationTool(value.tool)
  ) {
    return undefined
  }
  if (
    value.command !== undefined &&
    (typeof value.command !== 'string' ||
      value.command.length === 0 ||
      value.command.length > MAX_COMMAND_LENGTH)
  ) {
    return undefined
  }
  const context = parseOperationContext(value.context)
  const terminal = parseOperationTerminal(value.terminal)
  if (!context || !terminal) return undefined
  return {
    callId: value.callId,
    operation: value.operation,
    tool: value.tool,
    command: value.command,
    context,
    after:
      value.after === undefined ? undefined : parseOperationAfter(value.after),
    terminal,
  }
}

function isShellTool(tool: ReceiptOperationTool): boolean {
  return (
    tool === 'bash' ||
    tool === 'git' ||
    tool === 'gh' ||
    tool === 'bun' ||
    tool === 'npm'
  )
}

function matchesToolIdentity(
  tool: ReceiptOperationTool,
  executable: string,
): boolean {
  return tool === 'bash' || tool === executable
}

async function initializeParserAssets(
  options: ReceiptClassifierOptions,
): Promise<ParserAssets> {
  const treeSitterWasmPath =
    options.treeSitterWasmPath ??
    resolveAsset('web-tree-sitter/tree-sitter.wasm')
  const bashWasmPath =
    options.bashWasmPath ??
    resolveAsset('tree-sitter-bash/tree-sitter-bash.wasm')
  if (!fs.existsSync(treeSitterWasmPath) || !fs.existsSync(bashWasmPath)) {
    throw new Error('parser-asset-unavailable')
  }

  try {
    await Parser.init({ locateFile: () => treeSitterWasmPath })
  } catch {
    throw new Error('parser-asset-unavailable')
  }

  let language: Language
  try {
    language = await Language.load(bashWasmPath)
  } catch {
    throw new Error('grammar-incompatible')
  }
  if (
    language.abiVersion < SUPPORTED_ABI_MINIMUM ||
    language.abiVersion > SUPPORTED_ABI_MAXIMUM
  ) {
    throw new Error('grammar-incompatible')
  }
  return { language }
}

function resolveAsset(specifier: string): string {
  const resolved = import.meta.resolve(specifier)
  return resolved.startsWith('file://') ? fileURLToPath(resolved) : resolved
}

function classifyParserFailure(error: unknown): ParserFailure {
  if (error instanceof Error && error.message === 'grammar-incompatible') {
    return 'grammar-incompatible'
  }
  if (error instanceof Error && error.message === 'parser-failure')
    return 'parser-failure'
  return 'parser-asset-unavailable'
}

function unavailable(
  reasonCode: ParserFailure | 'classifier-closed',
): ReceiptClassification {
  return {
    outcome: 'unavailable',
    category: null,
    attribution: 'unattributed',
    result: 'unknown',
    sideEffect: 'not-required',
    reasonCode,
  }
}

function rejected(
  category: ReceiptOperation | null,
  result: ReceiptClassification['result'],
  reasonCode: ReceiptReasonCode,
  sideEffect: ReceiptClassification['sideEffect'] = 'not-required',
): ReceiptClassification {
  return {
    outcome: 'rejected',
    category,
    attribution: category ? 'runtime-verified' : 'unattributed',
    result,
    sideEffect,
    reasonCode,
  }
}

function accepted(operation: ReceiptOperation): ReceiptClassification {
  return {
    outcome: 'accepted',
    category: operation,
    attribution: 'runtime-verified',
    result: 'success',
    sideEffect: operationNeedsSideEffect(operation)
      ? 'required'
      : 'not-required',
    reasonCode: 'recognized-command',
  }
}

function terminalClassification(
  operation: ReceiptOperation,
  terminal: TerminalObservation,
): ReceiptClassification {
  const sideEffect = operationNeedsSideEffect(operation)
    ? 'required'
    : 'not-required'
  if (terminal.status === 'failure')
    return rejected(operation, 'failure', 'terminal-failure', sideEffect)
  if (terminal.status === 'cancelled')
    return rejected(operation, 'unknown', 'terminal-cancelled', sideEffect)
  if (terminal.status === 'running')
    return rejected(operation, 'unknown', 'terminal-running', sideEffect)
  if (terminal.status === 'unknown')
    return rejected(operation, 'unknown', 'terminal-unknown', sideEffect)
  if (terminal.output === 'empty')
    return rejected(operation, 'success', 'empty-result', sideEffect)
  if (terminal.output === 'unknown')
    return rejected(operation, 'unknown', 'invalid-terminal-result', sideEffect)
  if (terminal.noOp)
    return rejected(operation, 'success', 'successful-no-op', sideEffect)
  return accepted(operation)
}

function validateOperationEvidence(
  input: ParsedOperationInput,
  classification: ReceiptClassification,
): ReceiptClassification {
  if (classification.category !== input.operation)
    return rejectedClassification(input, classification)
  if (classification.outcome !== 'accepted') return classification
  if (!input.after) return invalidOperationClassification(input.operation)

  const { context, after } = input
  switch (input.operation) {
    case 'implementation':
      return validateImplementation(context, after, classification)
    case 'verification':
      return validateVerification(context, after, classification)
    case 'commit':
      return validateCommit(context, after, classification)
    case 'push':
      return validatePush(context, after, classification)
    case 'pr-creation':
      return validatePrCreation(context, after, classification)
    case 'check-readback':
      return validateCheck(after, context, classification)
    case 'review-readback':
      return validateReview(after, context, classification)
  }
}

function rejectedClassification(
  input: ParsedOperationInput,
  classification: ReceiptClassification,
): ReceiptClassification {
  return rejected(
    classification.category,
    classification.result,
    'classification-rejected',
    sideEffectFor(input.operation),
  )
}

function validateImplementation(
  context: ReceiptOperationContext,
  after: ReceiptOperationAfter,
  classification: ReceiptClassification,
): ReceiptClassification {
  const workspaceReason = validateWorkspaceIdentity(
    context,
    after,
    'implementation',
  )
  if (workspaceReason) return workspaceReason
  return context.worktreeIdentity &&
    after.worktreeIdentity &&
    context.worktreeIdentity !== after.worktreeIdentity
    ? classification
    : rejected('implementation', 'success', 'unchanged-worktree', 'required')
}

function validateVerification(
  context: ReceiptOperationContext,
  after: ReceiptOperationAfter,
  classification: ReceiptClassification,
): ReceiptClassification {
  return (
    validateWorkspaceIdentity(context, after, 'verification') ?? classification
  )
}

function validateCommit(
  context: ReceiptOperationContext,
  after: ReceiptOperationAfter,
  classification: ReceiptClassification,
): ReceiptClassification {
  const workspaceReason = validateWorkspaceIdentity(context, after, 'commit')
  if (workspaceReason) return workspaceReason
  if (after.commitClosure !== true) {
    return rejected('commit', 'success', 'no-op-resource', 'required')
  }
  return changedIdentity(context.repositoryIdentity, after.repositoryIdentity)
    ? classification
    : rejected('commit', 'success', 'no-op-resource', 'required')
}

function validatePush(
  context: ReceiptOperationContext,
  after: ReceiptOperationAfter,
  classification: ReceiptClassification,
): ReceiptClassification {
  const workspaceReason = validateWorkspaceIdentity(context, after, 'push')
  if (workspaceReason) return workspaceReason
  return sameResourceScope(context, after) &&
    changedIdentity(
      context.resourceRevisionIdentity,
      after.resourceRevisionIdentity,
    )
    ? classification
    : rejected('push', 'success', 'no-op-resource', 'required')
}

function validatePrCreation(
  context: ReceiptOperationContext,
  after: ReceiptOperationAfter,
  classification: ReceiptClassification,
): ReceiptClassification {
  const workspaceReason = validateWorkspaceIdentity(
    context,
    after,
    'pr-creation',
  )
  if (workspaceReason) return workspaceReason
  const pullRequest = after.pullRequest
  return sameResourceScope(context, after) &&
    resourceRevisionChanged(context, after, true) &&
    pullRequest !== undefined &&
    pullRequest.identity === after.resourceIdentity &&
    pullRequest.state === 'open'
    ? classification
    : rejected('pr-creation', 'success', 'no-op-resource', 'required')
}

function validateCheck(
  after: ReceiptOperationAfter,
  context: ReceiptOperationContext,
  classification: ReceiptClassification,
): ReceiptClassification {
  const workspaceReason = validateWorkspaceIdentity(
    context,
    after,
    'check-readback',
  )
  if (workspaceReason) return workspaceReason
  const pullRequest = after.pullRequest
  return sameResourceScope(context, after) &&
    after.resourceRevisionIdentity !== undefined &&
    pullRequest !== undefined &&
    pullRequest.identity === after.resourceIdentity &&
    pullRequest.state === 'open' &&
    after.checkState === 'completed-success'
    ? classification
    : rejected('check-readback', 'success', 'no-op-resource', 'not-required')
}

function validateReview(
  after: ReceiptOperationAfter,
  context: ReceiptOperationContext,
  classification: ReceiptClassification,
): ReceiptClassification {
  const workspaceReason = validateWorkspaceIdentity(
    context,
    after,
    'review-readback',
  )
  if (workspaceReason) return workspaceReason
  const pullRequest = after.pullRequest
  return sameResourceScope(context, after) &&
    after.resourceRevisionIdentity !== undefined &&
    pullRequest !== undefined &&
    pullRequest.identity === after.resourceIdentity &&
    pullRequest.state === 'open' &&
    after.reviewDecision === 'approved'
    ? classification
    : rejected('review-readback', 'success', 'no-op-resource', 'not-required')
}

function sameResourceScope(
  context: ReceiptOperationContext,
  after: ReceiptOperationAfter,
): boolean {
  return (
    context.resourceIdentity !== undefined &&
    context.resourceIdentity === after.resourceIdentity
  )
}

function validateWorkspaceIdentity(
  context: ReceiptOperationContext,
  after: ReceiptOperationAfter,
  operation: ReceiptOperation,
): ReceiptClassification | undefined {
  return after.workspaceIdentity === context.workspaceIdentity
    ? undefined
    : rejected(
        operation,
        'success',
        'workspace-mismatch',
        sideEffectFor(operation),
      )
}

function resourceRevisionChanged(
  context: ReceiptOperationContext,
  after: ReceiptOperationAfter,
  allowMissingBefore: boolean,
): boolean {
  if (after.resourceRevisionIdentity === undefined) return false
  if (context.resourceRevisionIdentity === undefined) return allowMissingBefore
  return context.resourceRevisionIdentity !== after.resourceRevisionIdentity
}

function changedIdentity(
  before: string | undefined,
  after: string | undefined,
): boolean {
  return before !== undefined && after !== undefined && before !== after
}

function operationNeedsSideEffect(operation: ReceiptOperation): boolean {
  return (
    operation === 'implementation' ||
    operation === 'commit' ||
    operation === 'push' ||
    operation === 'pr-creation'
  )
}

async function classifyWithParser(
  assets: ParserAssets,
  input: ReceiptClassificationInput,
): Promise<ReceiptClassification> {
  return classifyWithParserDetails(assets, input).classification
}

function classifyWithParserDetails(
  assets: ParserAssets,
  input: ReceiptClassificationInput,
): ParserClassification {
  const parser = new Parser()
  let tree = null
  try {
    parser.setLanguage(assets.language)
    tree = parser.parse(input.command)
    if (!tree || tree.rootNode.hasError)
      return { classification: rejected(null, 'unknown', 'parser-failure') }
    const shape = parseCommandShape(tree.rootNode)
    if (!shape) {
      return {
        classification: rejected(null, 'unknown', 'prohibited-shell-shape'),
      }
    }
    const operation = classifyCommands(shape)
    if (!operation) {
      return {
        classification: rejected(null, 'unknown', 'unsupported-command'),
      }
    }
    return {
      classification: terminalClassification(operation, input.terminal),
      executable: shape[shape.length - 1]?.executable,
    }
  } catch {
    return { classification: unavailable('parser-failure') }
  } finally {
    tree?.delete()
    parser.delete()
  }
}

function parseCommandShape(root: Node): ParsedCommand[] | undefined {
  if (root.type !== 'program' || root.namedChildren.length !== 1)
    return undefined
  const statement = root.namedChildren[0]
  if (!statement) return undefined
  if (containsProhibitedNode(statement)) return undefined
  if (statement.type === 'command') {
    const parsed = parseCommand(statement)
    return parsed ? [parsed] : undefined
  }
  if (statement.type !== 'list') return undefined

  return parseOrderedCommandList(statement)
}

function parseOrderedCommandList(statement: Node): ParsedCommand[] | undefined {
  const children = statement.children.filter(
    (child): child is Node => child !== null,
  )
  if (!isOrderedAndChain(children)) return undefined
  const commands: ParsedCommand[] = []
  for (let index = 0; index < children.length; index += 2) {
    const command = children[index]
    if (command?.type !== 'command') return undefined
    const parsed = parseCommand(command)
    if (!parsed) return undefined
    commands.push(parsed)
  }
  return commands
}

function isOrderedAndChain(children: readonly Node[]): boolean {
  if (children.length < 3) return false
  for (let index = 0; index < children.length; index += 1) {
    const expectedType = index % 2 === 0 ? 'command' : '&&'
    if (children[index]?.type !== expectedType) return false
  }
  return true
}

function containsProhibitedNode(node: Node): boolean {
  if (PROHIBITED_NODE_TYPES.has(node.type)) return true
  for (const child of node.namedChildren) {
    if (child && containsProhibitedNode(child)) return true
  }
  return false
}

function parseCommand(node: Node): ParsedCommand | undefined {
  if (node.type !== 'command') return undefined
  const commandName = node.childForFieldName('name')
  if (commandName?.type !== 'command_name') return undefined
  const executable = parsePlainToken(commandName.namedChildren[0])
  if (!executable) return undefined
  if (!hasSafeCommandChildren(node)) return undefined
  const argumentsList = parseArguments(node)
  if (!argumentsList) return undefined
  return { executable, arguments: argumentsList }
}

function hasSafeCommandChildren(node: Node): boolean {
  return node.namedChildren.every((child) => {
    if (!child || child.type === 'command_name') return true
    if (child.type === 'variable_assignment')
      return parseEnvironmentAssignment(child)
    return !containsDynamicSyntax(child)
  })
}

function parseArguments(node: Node): string[] | undefined {
  const argumentsList: string[] = []
  for (const argument of node.childrenForFieldName('argument')) {
    if (!argument) return undefined
    const token = parseArgument(argument)
    if (!token) return undefined
    argumentsList.push(token)
  }
  return argumentsList
}

function parseEnvironmentAssignment(node: Node): boolean {
  const name = node.childForFieldName('name')
  const value = node.childForFieldName('value')
  const nameText = name?.text
  const valueText = value?.text
  return (
    !!nameText &&
    ALLOWED_ENVIRONMENT_NAMES.has(nameText) &&
    (valueText === '1' || valueText === 'true' || valueText === 'TRUE')
  )
}

function parseArgument(node: Node): string | undefined {
  if (containsDynamicSyntax(node)) return undefined
  if (
    node.type === 'word' ||
    node.type === 'number' ||
    node.type === 'string' ||
    node.type === 'raw_string'
  ) {
    return node.type === 'word' || node.type === 'number'
      ? parseSafeWord(node.text)
      : node.text
  }
  return undefined
}

function parsePlainToken(node: Node | null): string | undefined {
  if (!node || containsDynamicSyntax(node)) return undefined
  if (node.type !== 'word' && node.type !== 'number') return undefined
  return parseSafeWord(node.text)
}

function parseSafeWord(value: string): string | undefined {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : undefined
}

function containsDynamicSyntax(node: Node): boolean {
  if (
    node.type === 'command_substitution' ||
    node.type === 'process_substitution' ||
    node.type === 'variable_expansion' ||
    node.type === 'expansion' ||
    node.type === 'concatenation' ||
    node.type === 'arithmetic_expansion'
  ) {
    return true
  }
  for (const child of node.namedChildren) {
    if (child && containsDynamicSyntax(child)) return true
  }
  return false
}

function classifyCommands(
  commands: readonly ParsedCommand[],
): ReceiptOperation | undefined {
  if (commands.length === 0) return undefined
  for (const prefix of commands.slice(0, -1)) {
    if (!isAllowedPrefix(prefix)) return undefined
  }
  return classifyFinalCommand(commands[commands.length - 1])
}

function isAllowedPrefix(command: ParsedCommand): boolean {
  return (
    PREFIX_COMMANDS.has(command.executable) &&
    command.arguments.length === 1 &&
    isSafeRelativeCwd(command.arguments[0] ?? '')
  )
}

function isSafeRelativeCwd(value: string): boolean {
  if (value === '.') return true
  if (value.startsWith('/') || value.startsWith('~')) return false
  const relative = value.startsWith('./') ? value.slice(2) : value
  if (relative.length === 0) return false
  return relative
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        /^[A-Za-z0-9_-]+$/.test(segment),
    )
}

function classifyFinalCommand(
  command: ParsedCommand,
): ReceiptOperation | undefined {
  const { executable, arguments: args } = command
  if (executable === 'git') return classifyGitCommand(args)
  if (executable === 'bun' || executable === 'npm') {
    return args[0] === 'test' &&
      (args.length === 1 || (args.length === 2 && isSafePathArgument(args[1])))
      ? 'verification'
      : undefined
  }
  if (executable === 'gh') return classifyGhCommand(args)
  return undefined
}

function classifyGitCommand(
  args: readonly string[],
): ReceiptOperation | undefined {
  if (args[0] === 'apply' && args.length === 2 && isSafePathArgument(args[1])) {
    return 'implementation'
  }
  if (
    args[0] === 'status' &&
    (args.length === 1 ||
      (args.length === 2 &&
        (args[1] === '--short' || args[1] === '--porcelain')))
  ) {
    return 'verification'
  }
  if (args.length === 2 && args[0] === 'diff' && args[1] === '--check')
    return 'verification'
  if (
    args.length === 3 &&
    args[0] === 'commit' &&
    args[1] === '-m' &&
    !isEmptyShellString(args[2])
  ) {
    return 'commit'
  }
  if (classifySafePushCommand(args)) return 'push'
  return undefined
}

function classifySafePushCommand(args: readonly string[]): boolean {
  if (args[0] !== 'push') return false
  const rest = args.slice(1)
  if (rest.length === 0) return true
  if (rest.some(isDestructivePushArgument)) return false
  const hasUpstreamFlag = rest[0] === '-u' || rest[0] === '--set-upstream'
  const offset = hasUpstreamFlag ? 1 : 0
  const positional = rest.slice(offset)
  if (positional.length === 0 || positional.length > 2) return false
  return positional.every((value) => isSafePathArgument(value))
}

function isDestructivePushArgument(value: string): boolean {
  if (value.startsWith('+') || value.startsWith(':')) return true
  if (value === '-f' || value === '-d') return true
  return [
    '--force',
    '--force-with-lease',
    '--delete',
    '--mirror',
    '--prune',
  ].some((option) => value === option || value.startsWith(`${option}=`))
}

function classifyGhCommand(
  args: readonly string[],
): ReceiptOperation | undefined {
  if (args[0] !== 'pr') return undefined
  if (
    args.length === 6 &&
    args[1] === 'create' &&
    args[2] === '--title' &&
    args[3]?.length > 0 &&
    args[4] === '--body' &&
    args[5]?.length > 0 &&
    !isEmptyShellString(args[3]) &&
    !isEmptyShellString(args[5])
  ) {
    return 'pr-creation'
  }
  if (args.length === 3 && args[1] === 'checks' && isPullRequestNumber(args[2]))
    return 'check-readback'
  if (
    args.length === 5 &&
    args[1] === 'view' &&
    isPullRequestNumber(args[2]) &&
    args[3] === '--json' &&
    (args[4] === 'reviews' || args[4] === 'reviewDecision')
  ) {
    return 'review-readback'
  }
  return undefined
}

function isSafePathArgument(value: string | undefined): boolean {
  if (
    !value ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.startsWith('~')
  )
    return false
  const relative = value.startsWith('./') ? value.slice(2) : value
  if (relative.length === 0) return false
  return relative
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        /^[A-Za-z0-9_.:@%+=,-]+$/.test(segment),
    )
}

function isEmptyShellString(value: string | undefined): boolean {
  return value === '""' || value === "''"
}

function isPullRequestNumber(value: string | undefined): boolean {
  return !!value && /^[0-9]+$/.test(value)
}
