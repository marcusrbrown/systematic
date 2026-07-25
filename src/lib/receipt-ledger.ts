import { createHash, randomBytes } from 'node:crypto'

export const RECEIPT_SCHEMA_VERSION = 1 as const
export const RECEIPT_PROTOCOL_VERSION = 1 as const

export type ReceiptOperation =
  | 'implementation'
  | 'verification'
  | 'commit'
  | 'push'
  | 'pr-creation'
  | 'check-readback'
  | 'review-readback'

export type ReceiptClassificationOutcome =
  | 'accepted'
  | 'rejected'
  | 'unavailable'
export type ReceiptAttribution = 'runtime-verified' | 'unattributed'
export type ReceiptResult = 'success' | 'failure' | 'unknown'
export type ReceiptSideEffect = 'required' | 'not-required'
export type TerminalStatus =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'running'
  | 'unknown'
export type TerminalOutput = 'empty' | 'non-empty' | 'unknown'
export type DigestDomain =
  | 'repository'
  | 'worktree'
  | 'resource'
  | 'workspace'
  | 'epoch'
  | 'unit'
  | 'call'
  | 'registration'

export type ReceiptReasonCode =
  | 'already-consumed'
  | 'abandoned-observation'
  | 'ambiguous-attribution'
  | 'classification-rejected'
  | 'classification-unavailable'
  | 'call-context-conflict'
  | 'classifier-closed'
  | 'cross-registration-disputed'
  | 'capability-mismatch'
  | 'duplicate-finalization'
  | 'empty-result'
  | 'epoch-mismatch'
  | 'forbidden-field'
  | 'grammar-incompatible'
  | 'incomplete-envelope'
  | 'invalid-observation'
  | 'invalid-receipt'
  | 'invalid-terminal-result'
  | 'no-op-resource'
  | 'parser-asset-unavailable'
  | 'parser-failure'
  | 'prohibited-shell-shape'
  | 'successful-no-op'
  | 'terminal-failure'
  | 'terminal-cancelled'
  | 'terminal-running'
  | 'terminal-unknown'
  | 'unknown-envelope'
  | 'unknown-receipt'
  | 'unit-mismatch'
  | 'unchanged-workspace'
  | 'unsupported-command'
  | 'workspace-mismatch'
  | 'recognized-command'

export interface ReceiptClassification {
  outcome: ReceiptClassificationOutcome
  category: ReceiptOperation | null
  attribution: ReceiptAttribution
  result: ReceiptResult
  sideEffect: ReceiptSideEffect
  reasonCode: ReceiptReasonCode
}

export interface ReceiptContext {
  epochId: string
  unitId: string
  workspaceIdentity: string
  repositoryIdentity?: string
  worktreeIdentity?: string
  resourceIdentity?: string
}

export interface ReceiptObservationAfter {
  workspaceIdentity: string
  repositoryIdentity?: string
  worktreeIdentity?: string
  resourceIdentity?: string
}

export interface TerminalObservation {
  status: TerminalStatus
  output: TerminalOutput
  noOp: boolean
}

export interface ReceiptLedgerOptions {
  registrationIdentity?: string
  capabilityFlags?: readonly string[]
  sessionSalt?: Uint8Array
}

export interface ReceiptLedgerMetadata {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION
  protocolVersion: typeof RECEIPT_PROTOCOL_VERSION
  registrationDigest: string
  capabilityFlags: readonly string[]
}

export interface CanonicalReceiptFields {
  receiptId: string
  registrationDigest: string
  callDigest: string
  epochDigest: string
  unitDigest: string
  workspaceDigest: string
  repositoryDigest?: string
  worktreeDigest?: string
  resourceDigest?: string
  operation: ReceiptOperation
  result: 'success'
  source: 'runtime-verified'
  consumption: 'available' | 'consumed'
  timestamp: number
}

export interface ReceiptEnvelope {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION
  protocolVersion: typeof RECEIPT_PROTOCOL_VERSION
  registrationDigest: string
  capabilityFlags: readonly string[]
  compatibility: 'compatible'
  canonical: CanonicalReceiptFields
}

export type PrepareObservationResult =
  | {
      status: 'prepared'
      preparationId: string
    }
  | {
      status: 'duplicate' | 'rejected'
      reasonCode: ReceiptReasonCode
    }

export type FinalizeObservationResult =
  | {
      status: 'finalized'
      receipt: ReceiptEnvelope
    }
  | {
      status: 'rejected'
      reasonCode: ReceiptReasonCode
    }

export type AbandonObservationResult =
  | {
      status: 'abandoned'
    }
  | {
      status: 'rejected'
      reasonCode: ReceiptReasonCode
    }

export type ConsumeReceiptResult =
  | {
      status: 'consumed'
      receipt: ReceiptEnvelope
    }
  | {
      status: 'rejected'
      reasonCode: ReceiptReasonCode
    }

export type EnvelopeValidationResult =
  | {
      compatibility: 'compatible'
      envelope: ReceiptEnvelope
    }
  | {
      compatibility: 'unavailable' | 'rejected'
      reasonCode: ReceiptReasonCode
    }

export interface ReceiptLedger {
  readonly metadata: ReceiptLedgerMetadata
  digestIdentity(domain: DigestDomain, identity: string): string
  prepareObservation(input: unknown): PrepareObservationResult
  finalizeObservation(input: unknown): FinalizeObservationResult
  abandonObservation(input: unknown): AbandonObservationResult
  consumeReceipt(receiptId: unknown, context: unknown): ConsumeReceiptResult
  validateEnvelope(input: unknown): EnvelopeValidationResult
  getEnvelope(receiptId: unknown): ReceiptEnvelope | undefined
  listReceipts(): readonly ReceiptEnvelope[]
  getSessionSalt(): Uint8Array
}

interface DigestedContext {
  epochDigest: string
  unitDigest: string
  workspaceDigest: string
  repositoryDigest?: string
  worktreeDigest?: string
  resourceDigest?: string
}

interface PreparedEntry {
  status: 'prepared' | 'finalized' | 'abandoned'
  callDigest: string
  operation: ReceiptOperation
  context: DigestedContext
  receiptId?: string
}

interface StoredReceipt {
  envelope: ReceiptEnvelope
  context: DigestedContext
}

interface ParsedPrepareObservation {
  callId: string
  operation: ReceiptOperation
  context: ReceiptContext
}

interface ParsedFinalizeObservation {
  callId: string
  context: ReceiptContext
  after: ReceiptObservationAfter
  classification: ReceiptClassification
  terminal: TerminalObservation
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

const DIGEST_DOMAIN_SET: ReadonlySet<string> = new Set([
  'repository',
  'worktree',
  'resource',
  'workspace',
  'epoch',
  'unit',
  'call',
  'registration',
])

const FORBIDDEN_OBSERVATION_FIELDS: ReadonlySet<string> = new Set([
  'canonical',
  'compatibility',
  'consumption',
  'envelope',
  'finalized',
  'receiptId',
])

const DEFAULT_CAPABILITIES = [
  'runtime-observation',
  'session-salted-digests',
  'bounded-envelope',
] as const

const MAX_IDENTITY_LENGTH = 1024
const MAX_CAPABILITIES = 16
const MAX_CAPABILITY_LENGTH = 128

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTITY_LENGTH
  )
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === 'string')
  )
}

function isOperation(value: unknown): value is ReceiptOperation {
  return typeof value === 'string' && OPERATION_SET.has(value)
}

function isReceiptReasonCode(value: unknown): value is ReceiptReasonCode {
  return (
    typeof value === 'string' &&
    new Set<ReceiptReasonCode>([
      'already-consumed',
      'abandoned-observation',
      'ambiguous-attribution',
      'classification-rejected',
      'classification-unavailable',
      'call-context-conflict',
      'classifier-closed',
      'cross-registration-disputed',
      'capability-mismatch',
      'duplicate-finalization',
      'empty-result',
      'epoch-mismatch',
      'forbidden-field',
      'grammar-incompatible',
      'incomplete-envelope',
      'invalid-observation',
      'invalid-receipt',
      'invalid-terminal-result',
      'no-op-resource',
      'parser-asset-unavailable',
      'parser-failure',
      'prohibited-shell-shape',
      'successful-no-op',
      'terminal-failure',
      'terminal-cancelled',
      'terminal-running',
      'terminal-unknown',
      'unknown-envelope',
      'unknown-receipt',
      'unit-mismatch',
      'unchanged-workspace',
      'unsupported-command',
      'workspace-mismatch',
      'recognized-command',
    ]).has(value as ReceiptReasonCode)
  )
}

function hasForbiddenTopLevelField(value: Record<string, unknown>): boolean {
  for (const field of FORBIDDEN_OBSERVATION_FIELDS) {
    if (field in value) return true
  }
  return false
}

function normalizedIdentity(value: unknown): string | undefined {
  if (!isString(value)) return undefined
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= MAX_IDENTITY_LENGTH
    ? normalized
    : undefined
}

function cloneEnvelope(envelope: ReceiptEnvelope): ReceiptEnvelope {
  return {
    ...envelope,
    capabilityFlags: [...envelope.capabilityFlags],
    canonical: { ...envelope.canonical },
  }
}

function parseContext(value: unknown): ReceiptContext | undefined {
  if (!isRecord(value)) return undefined
  const epochId = normalizedIdentity(value.epochId)
  const unitId = normalizedIdentity(value.unitId)
  const workspaceIdentity = normalizedIdentity(value.workspaceIdentity)
  if (!epochId || !unitId || !workspaceIdentity) return undefined

  const repositoryIdentity =
    value.repositoryIdentity === undefined
      ? undefined
      : normalizedIdentity(value.repositoryIdentity)
  const worktreeIdentity =
    value.worktreeIdentity === undefined
      ? undefined
      : normalizedIdentity(value.worktreeIdentity)
  const resourceIdentity =
    value.resourceIdentity === undefined
      ? undefined
      : normalizedIdentity(value.resourceIdentity)
  if (
    (value.repositoryIdentity !== undefined && !repositoryIdentity) ||
    (value.worktreeIdentity !== undefined && !worktreeIdentity) ||
    (value.resourceIdentity !== undefined && !resourceIdentity)
  ) {
    return undefined
  }

  return {
    epochId,
    unitId,
    workspaceIdentity,
    repositoryIdentity,
    worktreeIdentity,
    resourceIdentity,
  }
}

function parseAfter(value: unknown): ReceiptObservationAfter | undefined {
  const context = parseContext({
    epochId: 'after',
    unitId: 'after',
    ...(isRecord(value) ? value : {}),
  })
  if (!context) return undefined
  return {
    workspaceIdentity: context.workspaceIdentity,
    repositoryIdentity: context.repositoryIdentity,
    worktreeIdentity: context.worktreeIdentity,
    resourceIdentity: context.resourceIdentity,
  }
}

function isTerminalStatus(value: unknown): value is TerminalStatus {
  return (
    value === 'success' ||
    value === 'failure' ||
    value === 'cancelled' ||
    value === 'running' ||
    value === 'unknown'
  )
}

function isTerminalOutput(value: unknown): value is TerminalOutput {
  return value === 'empty' || value === 'non-empty' || value === 'unknown'
}

function parseTerminal(value: unknown): TerminalObservation | undefined {
  if (
    !isRecord(value) ||
    !isTerminalStatus(value.status) ||
    !isTerminalOutput(value.output) ||
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

function parseClassification(
  value: unknown,
): ReceiptClassification | undefined {
  if (!isRecord(value)) return undefined
  if (
    (value.outcome !== 'accepted' &&
      value.outcome !== 'rejected' &&
      value.outcome !== 'unavailable') ||
    (value.attribution !== 'runtime-verified' &&
      value.attribution !== 'unattributed') ||
    (value.result !== 'success' &&
      value.result !== 'failure' &&
      value.result !== 'unknown') ||
    (value.sideEffect !== 'required' && value.sideEffect !== 'not-required') ||
    (value.category !== null && !isOperation(value.category)) ||
    !isReceiptReasonCode(value.reasonCode)
  ) {
    return undefined
  }
  return {
    outcome: value.outcome,
    category: value.category,
    attribution: value.attribution,
    result: value.result,
    sideEffect: value.sideEffect,
    reasonCode: value.reasonCode,
  }
}

function parsePrepareObservation(
  input: unknown,
): ParsedPrepareObservation | undefined {
  if (!isRecord(input) || hasForbiddenTopLevelField(input)) return undefined
  const callId = normalizedIdentity(input.callId)
  const operation = isOperation(input.operation) ? input.operation : undefined
  const context = parseContext(input.context)
  if (!callId || !operation || !context) return undefined
  return { callId, operation, context }
}

function prepareInvalidObservationResult(
  input: unknown,
): PrepareObservationResult {
  return {
    status: 'rejected',
    reasonCode:
      isRecord(input) && hasForbiddenTopLevelField(input)
        ? 'forbidden-field'
        : 'invalid-observation',
  }
}

function parseFinalizeObservation(
  input: unknown,
): ParsedFinalizeObservation | undefined {
  if (!isRecord(input) || hasForbiddenTopLevelField(input)) return undefined
  const callId = normalizedIdentity(input.callId)
  const context = parseContext(input.context)
  const after = parseAfter(input.after)
  const classification = parseClassification(input.classification)
  const terminal = parseTerminal(input.terminal)
  if (!callId || !context || !after || !classification || !terminal)
    return undefined
  return { callId, context, after, classification, terminal }
}

function compareDigestedContexts(
  expected: DigestedContext,
  actual: DigestedContext,
): ReceiptReasonCode | undefined {
  if (expected.epochDigest !== actual.epochDigest) return 'epoch-mismatch'
  if (expected.unitDigest !== actual.unitDigest) return 'unit-mismatch'
  if (expected.workspaceDigest !== actual.workspaceDigest)
    return 'workspace-mismatch'
  if (expected.repositoryDigest !== actual.repositoryDigest)
    return 'workspace-mismatch'
  if (expected.worktreeDigest !== actual.worktreeDigest)
    return 'workspace-mismatch'
  if (expected.resourceDigest !== actual.resourceDigest)
    return 'workspace-mismatch'
  return undefined
}

function resolveExistingPrepare(
  existing: PreparedEntry,
  operation: ReceiptOperation,
  context: DigestedContext,
): PrepareObservationResult {
  if (
    existing.operation !== operation ||
    compareDigestedContexts(existing.context, context)
  ) {
    return { status: 'rejected', reasonCode: 'call-context-conflict' }
  }
  if (existing.status === 'abandoned') {
    return { status: 'rejected', reasonCode: 'abandoned-observation' }
  }
  if (existing.status === 'prepared' || existing.status === 'finalized') {
    return { status: 'duplicate', reasonCode: 'duplicate-finalization' }
  }
  return { status: 'rejected', reasonCode: 'invalid-observation' }
}

function validateEnvelopeInput(
  input: Record<string, unknown>,
): EnvelopeValidationResult | undefined {
  if (!('schemaVersion' in input) || !('protocolVersion' in input)) {
    return { compatibility: 'unavailable', reasonCode: 'incomplete-envelope' }
  }
  if (
    input.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    input.protocolVersion !== RECEIPT_PROTOCOL_VERSION
  ) {
    return { compatibility: 'unavailable', reasonCode: 'unknown-envelope' }
  }
  if (!('capabilityFlags' in input) || input.capabilityFlags === undefined) {
    return { compatibility: 'unavailable', reasonCode: 'incomplete-envelope' }
  }
  if (!isBoundedCapabilityList(input.capabilityFlags)) {
    return { compatibility: 'unavailable', reasonCode: 'capability-mismatch' }
  }
  return undefined
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isReceiptId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

function parseEnvelope(value: unknown): ReceiptEnvelope | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    value.protocolVersion !== RECEIPT_PROTOCOL_VERSION ||
    value.compatibility !== 'compatible' ||
    !isDigest(value.registrationDigest) ||
    !isBoundedCapabilityList(value.capabilityFlags) ||
    !isRecord(value.canonical)
  ) {
    return undefined
  }
  const canonical = value.canonical
  if (
    !isReceiptId(canonical.receiptId) ||
    !isDigest(canonical.registrationDigest) ||
    !isDigest(canonical.callDigest) ||
    !isDigest(canonical.epochDigest) ||
    !isDigest(canonical.unitDigest) ||
    !isDigest(canonical.workspaceDigest) ||
    (canonical.repositoryDigest !== undefined &&
      !isDigest(canonical.repositoryDigest)) ||
    (canonical.worktreeDigest !== undefined &&
      !isDigest(canonical.worktreeDigest)) ||
    (canonical.resourceDigest !== undefined &&
      !isDigest(canonical.resourceDigest)) ||
    !isOperation(canonical.operation) ||
    canonical.result !== 'success' ||
    canonical.source !== 'runtime-verified' ||
    (canonical.consumption !== 'available' &&
      canonical.consumption !== 'consumed') ||
    typeof canonical.timestamp !== 'number' ||
    !Number.isFinite(canonical.timestamp)
  ) {
    return undefined
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    protocolVersion: RECEIPT_PROTOCOL_VERSION,
    registrationDigest: value.registrationDigest,
    capabilityFlags: [...value.capabilityFlags],
    compatibility: 'compatible',
    canonical: {
      receiptId: canonical.receiptId,
      registrationDigest: canonical.registrationDigest,
      callDigest: canonical.callDigest,
      epochDigest: canonical.epochDigest,
      unitDigest: canonical.unitDigest,
      workspaceDigest: canonical.workspaceDigest,
      repositoryDigest: canonical.repositoryDigest,
      worktreeDigest: canonical.worktreeDigest,
      resourceDigest: canonical.resourceDigest,
      operation: canonical.operation,
      result: 'success',
      source: 'runtime-verified',
      consumption: canonical.consumption,
      timestamp: canonical.timestamp,
    },
  }
}

function isBoundedCapabilityList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_CAPABILITIES &&
    value.every(
      (flag) =>
        typeof flag === 'string' &&
        flag.length > 0 &&
        flag.length <= MAX_CAPABILITY_LENGTH,
    )
  )
}

function capabilityListsEqual(
  first: readonly string[],
  second: readonly string[],
): boolean {
  return (
    first.length === second.length &&
    first.every((flag, index) => flag === second[index])
  )
}

function createSessionSalt(input: Uint8Array | undefined): Uint8Array {
  if (input === undefined) return new Uint8Array(randomBytes(32))
  if (!(input instanceof Uint8Array) || input.byteLength !== 32) {
    throw new Error('invalid-session-salt')
  }
  return new Uint8Array(input)
}

function validateConfiguredCapabilities(
  input: readonly string[] | undefined,
): void {
  const candidates: unknown = input ?? DEFAULT_CAPABILITIES
  if (
    !isStringArray(candidates) ||
    candidates.length > MAX_CAPABILITIES ||
    candidates.some(
      (flag) => flag.length === 0 || flag.length > MAX_CAPABILITY_LENGTH,
    )
  ) {
    throw new Error('invalid-capability-flags')
  }
}

export function createReceiptLedger(
  options: ReceiptLedgerOptions = {},
): ReceiptLedger {
  const sessionSaltBytes = createSessionSalt(options.sessionSalt)
  const sessionSalt = Buffer.from(sessionSaltBytes).toString('hex')
  const registrationInput =
    normalizedIdentity(options.registrationIdentity) ??
    randomBytes(16).toString('hex')
  const registrationDigest = digest(
    'registration',
    registrationInput,
    sessionSalt,
  )
  validateConfiguredCapabilities(options.capabilityFlags)
  const capabilityFlags = Object.freeze(
    normalizeCapabilities(options.capabilityFlags),
  )
  const metadata: ReceiptLedgerMetadata = Object.freeze({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    protocolVersion: RECEIPT_PROTOCOL_VERSION,
    registrationDigest,
    capabilityFlags,
  })

  const lifecycleByCall = new Map<string, PreparedEntry>()
  const receipts = new Map<string, StoredReceipt>()

  function digestIdentity(domain: DigestDomain, identity: string): string {
    const normalized = normalizedIdentity(identity)
    if (!normalized || !DIGEST_DOMAIN_SET.has(domain)) {
      return digest(domain, 'invalid', sessionSalt)
    }
    return digest(domain, normalized, sessionSalt)
  }

  function digestContext(context: ReceiptContext): DigestedContext {
    return {
      epochDigest: digestIdentity('epoch', context.epochId),
      unitDigest: digestIdentity('unit', context.unitId),
      workspaceDigest: digestIdentity('workspace', context.workspaceIdentity),
      repositoryDigest: context.repositoryIdentity
        ? digestIdentity('repository', context.repositoryIdentity)
        : undefined,
      worktreeDigest: context.worktreeIdentity
        ? digestIdentity('worktree', context.worktreeIdentity)
        : undefined,
      resourceDigest: context.resourceIdentity
        ? digestIdentity('resource', context.resourceIdentity)
        : undefined,
    }
  }

  function sealEntry(entry: PreparedEntry): void {
    if (entry.status !== 'prepared') return
    entry.status = 'abandoned'
  }

  function prepareObservation(input: unknown): PrepareObservationResult {
    const parsed = parsePrepareObservation(input)
    if (!parsed) return prepareInvalidObservationResult(input)

    const callDigest = digestIdentity('call', parsed.callId)
    const digested = digestContext(parsed.context)
    const existing = lifecycleByCall.get(callDigest)
    if (existing) {
      return resolveExistingPrepare(existing, parsed.operation, digested)
    }

    const preparationId = randomBytes(16).toString('hex')
    lifecycleByCall.set(callDigest, {
      status: 'prepared',
      callDigest,
      operation: parsed.operation,
      context: digested,
    })
    return { status: 'prepared', preparationId }
  }

  function finalizeObservation(input: unknown): FinalizeObservationResult {
    const parsed = parseFinalizeObservation(input)
    if (!parsed) return invalidObservationResult(input)

    const callDigest = digestIdentity('call', parsed.callId)
    const actualContext = digestContext(parsed.context)
    const matchingEntry = lifecycleByCall.get(callDigest)
    if (!matchingEntry) return invalidObservationResult(input)
    const contextMismatch = compareDigestedContexts(
      matchingEntry.context,
      actualContext,
    )
    if (contextMismatch) {
      sealEntry(matchingEntry)
      return { status: 'rejected', reasonCode: contextMismatch }
    }
    const entryRejection = validateFinalizationEntry(matchingEntry, parsed)
    if (entryRejection) {
      sealEntry(matchingEntry)
      return { status: 'rejected', reasonCode: entryRejection }
    }

    const afterDigests = digestAfter(parsed.after)
    const noOpReason = getNoOpReason(matchingEntry, afterDigests)
    if (noOpReason) {
      sealEntry(matchingEntry)
      return { status: 'rejected', reasonCode: noOpReason }
    }

    return mintReceipt(matchingEntry, callDigest, afterDigests)
  }

  function invalidObservationResult(input: unknown): FinalizeObservationResult {
    return {
      status: 'rejected',
      reasonCode:
        isRecord(input) && hasForbiddenTopLevelField(input)
          ? 'forbidden-field'
          : 'invalid-observation',
    }
  }

  function validateFinalizationEntry(
    entry: PreparedEntry,
    parsed: ParsedFinalizeObservation,
  ): ReceiptReasonCode | undefined {
    if (entry.status === 'abandoned') return 'abandoned-observation'
    if (entry.status === 'finalized') return 'duplicate-finalization'
    return (
      validateClassification(parsed.classification, entry.operation) ??
      validateTerminal(parsed.classification, parsed.terminal)
    )
  }

  function validateClassification(
    classification: ReceiptClassification,
    operation: ReceiptOperation,
  ): ReceiptReasonCode | undefined {
    if (classification.category !== operation) return 'classification-rejected'
    if (classification.outcome === 'unavailable')
      return 'classification-unavailable'
    if (
      classification.outcome !== 'accepted' ||
      classification.attribution !== 'runtime-verified'
    ) {
      return 'classification-rejected'
    }
    return undefined
  }

  function validateTerminal(
    classification: ReceiptClassification,
    terminal: TerminalObservation,
  ): ReceiptReasonCode | undefined {
    if (classification.result !== 'success' || terminal.status !== 'success') {
      return 'terminal-failure'
    }
    if (terminal.output === 'empty') return 'empty-result'
    if (terminal.output === 'unknown') return 'invalid-terminal-result'
    if (terminal.noOp) return 'successful-no-op'
    return undefined
  }

  function digestAfter(after: ReceiptObservationAfter): DigestedContext {
    return {
      epochDigest: '',
      unitDigest: '',
      workspaceDigest: digestIdentity('workspace', after.workspaceIdentity),
      repositoryDigest: after.repositoryIdentity
        ? digestIdentity('repository', after.repositoryIdentity)
        : undefined,
      worktreeDigest: after.worktreeIdentity
        ? digestIdentity('worktree', after.worktreeIdentity)
        : undefined,
      resourceDigest: after.resourceIdentity
        ? digestIdentity('resource', after.resourceIdentity)
        : undefined,
    }
  }

  function getNoOpReason(
    entry: PreparedEntry,
    after: DigestedContext,
  ): ReceiptReasonCode | undefined {
    if (
      entry.operation === 'implementation' &&
      after.workspaceDigest === entry.context.workspaceDigest
    ) {
      return 'unchanged-workspace'
    }
    if (
      entry.operation === 'commit' &&
      (!entry.context.repositoryDigest ||
        !after.repositoryDigest ||
        after.repositoryDigest === entry.context.repositoryDigest)
    ) {
      return 'no-op-resource'
    }
    if (
      (entry.operation === 'push' || entry.operation === 'pr-creation') &&
      (!entry.context.resourceDigest ||
        !after.resourceDigest ||
        after.resourceDigest === entry.context.resourceDigest)
    ) {
      return 'no-op-resource'
    }
    return undefined
  }

  function mintReceipt(
    entry: PreparedEntry,
    callDigest: string,
    after: DigestedContext,
  ): FinalizeObservationResult {
    const receiptId = randomBytes(16).toString('hex')
    const canonical: CanonicalReceiptFields = {
      receiptId,
      registrationDigest,
      callDigest,
      epochDigest: entry.context.epochDigest,
      unitDigest: entry.context.unitDigest,
      workspaceDigest: after.workspaceDigest,
      repositoryDigest: after.repositoryDigest,
      worktreeDigest: after.worktreeDigest,
      resourceDigest: after.resourceDigest,
      operation: entry.operation,
      result: 'success',
      source: 'runtime-verified',
      consumption: 'available',
      timestamp: Date.now(),
    }
    const envelope: ReceiptEnvelope = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      protocolVersion: RECEIPT_PROTOCOL_VERSION,
      registrationDigest,
      capabilityFlags,
      compatibility: 'compatible',
      canonical,
    }
    entry.status = 'finalized'
    entry.receiptId = receiptId
    receipts.set(receiptId, {
      envelope,
      context: {
        ...entry.context,
        workspaceDigest: after.workspaceDigest,
        repositoryDigest: after.repositoryDigest,
        worktreeDigest: after.worktreeDigest,
        resourceDigest: after.resourceDigest,
      },
    })
    return { status: 'finalized', receipt: cloneEnvelope(envelope) }
  }

  function abandonObservation(input: unknown): AbandonObservationResult {
    if (!isRecord(input))
      return { status: 'rejected', reasonCode: 'invalid-observation' }
    const callId = normalizedIdentity(input.callId)
    const context = parseContext(input.context)
    if (!callId || !context)
      return { status: 'rejected', reasonCode: 'invalid-observation' }
    const callDigest = digestIdentity('call', callId)
    const digested = digestContext(context)
    const matchingEntry = lifecycleByCall.get(callDigest)
    if (!matchingEntry)
      return { status: 'rejected', reasonCode: 'unknown-receipt' }
    const contextMismatch = compareDigestedContexts(
      matchingEntry.context,
      digested,
    )
    if (contextMismatch)
      return { status: 'rejected', reasonCode: contextMismatch }
    if (matchingEntry.status !== 'prepared') {
      return { status: 'rejected', reasonCode: 'duplicate-finalization' }
    }
    sealEntry(matchingEntry)
    return { status: 'abandoned' }
  }

  function consumeReceipt(
    receiptId: unknown,
    contextInput: unknown,
  ): ConsumeReceiptResult {
    if (!isReceiptId(receiptId))
      return { status: 'rejected', reasonCode: 'unknown-receipt' }
    const context = parseContext(contextInput)
    if (!context)
      return { status: 'rejected', reasonCode: 'invalid-observation' }
    const stored = receipts.get(receiptId)
    if (!stored) return { status: 'rejected', reasonCode: 'unknown-receipt' }
    const actual = digestContext(context)
    const contextMismatch = compareDigestedContexts(stored.context, actual)
    if (contextMismatch)
      return { status: 'rejected', reasonCode: contextMismatch }
    if (stored.envelope.canonical.consumption === 'consumed') {
      return { status: 'rejected', reasonCode: 'already-consumed' }
    }
    stored.envelope.canonical.consumption = 'consumed'
    return { status: 'consumed', receipt: cloneEnvelope(stored.envelope) }
  }

  function validateEnvelope(input: unknown): EnvelopeValidationResult {
    if (!isRecord(input))
      return { compatibility: 'unavailable', reasonCode: 'incomplete-envelope' }
    const inputValidation = validateEnvelopeInput(input)
    if (inputValidation) return inputValidation
    const envelope = parseEnvelope(input)
    if (!envelope)
      return { compatibility: 'unavailable', reasonCode: 'incomplete-envelope' }
    if (
      envelope.registrationDigest !== registrationDigest ||
      envelope.canonical.registrationDigest !== registrationDigest
    ) {
      return {
        compatibility: 'rejected',
        reasonCode: 'cross-registration-disputed',
      }
    }
    if (!capabilityListsEqual(envelope.capabilityFlags, capabilityFlags)) {
      return {
        compatibility: 'unavailable',
        reasonCode: 'capability-mismatch',
      }
    }
    return { compatibility: 'compatible', envelope: cloneEnvelope(envelope) }
  }

  function getEnvelope(receiptId: unknown): ReceiptEnvelope | undefined {
    if (!isReceiptId(receiptId)) return undefined
    const stored = receipts.get(receiptId)
    return stored ? cloneEnvelope(stored.envelope) : undefined
  }

  function listReceipts(): readonly ReceiptEnvelope[] {
    return [...receipts.values()].map(({ envelope }) => cloneEnvelope(envelope))
  }

  function getSessionSalt(): Uint8Array {
    return new Uint8Array(sessionSaltBytes)
  }

  return {
    metadata,
    digestIdentity,
    prepareObservation,
    finalizeObservation,
    abandonObservation,
    consumeReceipt,
    validateEnvelope,
    getEnvelope,
    listReceipts,
    getSessionSalt,
  }
}

function normalizeCapabilities(
  input: readonly string[] | undefined,
): readonly string[] {
  const candidates = input ?? DEFAULT_CAPABILITIES
  return [...new Set(candidates)].sort()
}

function digest(
  domain: DigestDomain,
  value: string,
  sessionSalt: string,
): string {
  return createHash('sha256')
    .update(`systematic/receipt-ledger/${domain}/v1/${sessionSalt}/${value}`)
    .digest('hex')
}
