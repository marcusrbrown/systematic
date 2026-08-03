import { createHash } from 'node:crypto'

import type {
  CanonicalReceiptFields,
  ReceiptEnvelope,
  ReceiptLedgerMetadata,
  ReceiptOperation,
} from './receipt-ledger.js'
import { isLocalOperation } from './receipt-ledger.js'

export const RECEIPT_READBACK_SCHEMA_VERSION = 2 as const
export const RECEIPT_READBACK_PROTOCOL_VERSION = 2 as const
const LEGACY_RECEIPT_READBACK_SCHEMA_VERSION = 1 as const
const LEGACY_RECEIPT_READBACK_PROTOCOL_VERSION = 1 as const
type ReceiptReadbackVersion =
  | typeof RECEIPT_READBACK_SCHEMA_VERSION
  | typeof LEGACY_RECEIPT_READBACK_SCHEMA_VERSION

export type ReceiptDigestDomain =
  | 'repository'
  | 'worktree'
  | 'resource'
  | 'workspace'
  | 'epoch'
  | 'unit'
  | 'call'
  | 'registration'
export type ReceiptProgressionStateName = 'started' | 'completed'
export type ReceiptEpochFamily = 'work' | 'shipping'

export interface ReceiptResourceScope {
  readonly operation: ReceiptOperation
  readonly resourceIdentity: string
}

export type ReceiptReadbackFailureCategory =
  | 'malformed'
  | 'forbidden-field'
  | 'unknown-kind'
  | 'unknown-schema'
  | 'unknown-protocol'
  | 'unknown-capability'
  | 'integrity-mismatch'
  | 'missing-mint'
  | 'control-before-mint'
  | 'conflicting-marker'
  | 'out-of-order'
  | 'cross-registration'
  | 'capability-mismatch'
  | 'salt-mismatch'
  | 'receipt-mismatch'
  | 'progression-mismatch'
  | 'inconsistent-evidence'
  | 'missing-internal-id'
  | 'identity-digest-mismatch'
  | 'conflicting-seed'
  | 'missing-seed'

export interface ReceiptMintMarker {
  readonly kind: 'mint'
  readonly schemaVersion: ReceiptReadbackVersion
  readonly protocolVersion: ReceiptReadbackVersion
  readonly envelope: ReceiptEnvelope
  readonly sessionSalt: string
  readonly integrity: string
}

export interface ReceiptConsumeMarker {
  readonly kind: 'control'
  readonly schemaVersion: ReceiptReadbackVersion
  readonly protocolVersion: ReceiptReadbackVersion
  readonly registrationDigest: string
  readonly capabilityFlags: readonly string[]
  readonly control: 'consume'
  readonly receiptId: string
  readonly transitionDigest: string
  readonly timestamp: number
  readonly integrity: string
}

export interface ReceiptEpochProgressionMarker {
  readonly kind: 'control'
  readonly schemaVersion: ReceiptReadbackVersion
  readonly protocolVersion: ReceiptReadbackVersion
  readonly registrationDigest: string
  readonly capabilityFlags: readonly string[]
  readonly control: 'progression'
  readonly target: 'epoch'
  readonly epochId: string
  readonly epochDigest: string
  readonly family: ReceiptEpochFamily
  readonly state: ReceiptProgressionStateName
  readonly transitionDigest: string
  readonly timestamp: number
  readonly sessionSalt: string
  readonly integrity: string
}

export interface ReceiptUnitProgressionMarker {
  readonly kind: 'control'
  readonly schemaVersion: ReceiptReadbackVersion
  readonly protocolVersion: ReceiptReadbackVersion
  readonly registrationDigest: string
  readonly capabilityFlags: readonly string[]
  readonly control: 'progression'
  readonly target: 'unit'
  readonly epochId: string
  readonly epochDigest: string
  readonly unitId: string
  readonly unitDigest: string
  readonly family: ReceiptEpochFamily
  readonly requiredOperations: readonly ReceiptOperation[]
  readonly resourceScopes: readonly ReceiptResourceScope[]
  readonly pinnedOperationTargetIdentity?: string
  readonly state: ReceiptProgressionStateName
  readonly transitionDigest: string
  readonly timestamp: number
  readonly sessionSalt: string
  readonly integrity: string
}

export type ReceiptProgressionMarker =
  | ReceiptEpochProgressionMarker
  | ReceiptUnitProgressionMarker

type ReceiptEpochProgressionMarkerCore = Omit<
  ReceiptEpochProgressionMarker,
  'integrity'
>
type ReceiptUnitProgressionMarkerCore = Omit<
  ReceiptUnitProgressionMarker,
  'integrity'
>
type ReceiptProgressionMarkerCore =
  | ReceiptEpochProgressionMarkerCore
  | ReceiptUnitProgressionMarkerCore

export type ReceiptControlMarker =
  | ReceiptConsumeMarker
  | ReceiptProgressionMarker
export type ReceiptMarker = ReceiptMintMarker | ReceiptControlMarker

export type ReceiptProgressionMarkerInput =
  | {
      readonly target: 'epoch'
      readonly state: ReceiptProgressionStateName
      readonly epochId: string
      readonly family: ReceiptEpochFamily
      readonly transitionDigest: string
      readonly timestamp?: number
    }
  | {
      readonly target: 'unit'
      readonly state: ReceiptProgressionStateName
      readonly epochId: string
      readonly unitId: string
      readonly family: ReceiptEpochFamily
      readonly requiredOperations: readonly ReceiptOperation[]
      readonly resourceScopes: readonly ReceiptResourceScope[]
      readonly pinnedOperationTargetIdentity?: string
      readonly transitionDigest: string
      readonly timestamp?: number
    }

export interface ReceiptProgressionProjectionSource {
  readonly metadata: ReceiptLedgerMetadata | (() => ReceiptLedgerMetadata)
  readonly getSessionSalt: () => Uint8Array
  readonly digestIdentity: (
    domain: ReceiptDigestDomain,
    identity: string,
  ) => string
}

export interface ReceiptReadbackExpectation {
  readonly registrationDigest: string
  readonly capabilityFlags: readonly string[]
  readonly sessionSalt: Uint8Array
  readonly source?: 'runtime-verified'
  /**
   * When present, legacy v1 mint markers are rejected because they cannot
   * authenticate a foreign/worktree target. Absence retains the narrow v1
   * parent-target recovery shim; callers must validate that parent separately.
   */
  readonly operationTargetIdentity?: string
}

export type ReceiptEpochProgressionSnapshot = {
  readonly target: 'epoch'
  readonly state: ReceiptProgressionStateName
  readonly epochId: string
  readonly epochDigest: string
  readonly family: ReceiptEpochFamily
  readonly transitionDigest: string
}

export type ReceiptUnitProgressionSnapshot = {
  readonly target: 'unit'
  readonly state: ReceiptProgressionStateName
  readonly epochId: string
  readonly epochDigest: string
  readonly unitId: string
  readonly unitDigest: string
  readonly family: ReceiptEpochFamily
  readonly requiredOperations: readonly ReceiptOperation[]
  readonly resourceScopes: readonly ReceiptResourceScope[]
  readonly pinnedOperationTargetIdentity?: string
  readonly transitionDigest: string
}

export type ReceiptProgressionSnapshot =
  | ReceiptEpochProgressionSnapshot
  | ReceiptUnitProgressionSnapshot

export interface ReceiptReadbackProgression {
  readonly epoch: ReceiptEpochProgressionSnapshot | null
  readonly unit: ReceiptUnitProgressionSnapshot | null
}

export interface ReceiptReadbackState {
  readonly registrationDigest: string
  readonly receipts: readonly ReceiptEnvelope[]
  readonly progression: ReceiptReadbackProgression
}

export type ReceiptMarkerValidation =
  | { readonly status: 'valid'; readonly marker: ReceiptMarker }
  | {
      readonly status: 'rejected'
      readonly category: ReceiptReadbackFailureCategory
    }

export type ReceiptReadbackResult =
  | { readonly status: 'reconstructed'; readonly state: ReceiptReadbackState }
  | {
      readonly status: 'rejected'
      readonly category: ReceiptReadbackFailureCategory
    }

export type ReceiptReadbackSeedResult =
  | { readonly status: 'empty' }
  | {
      readonly status: 'ready'
      readonly sessionSalt: Uint8Array
      readonly registrationDigest: string
      readonly capabilityFlags: readonly string[]
    }
  | {
      readonly status: 'repair-required'
      readonly category: ReceiptReadbackFailureCategory
    }

const MAX_CAPABILITIES = 16
const MAX_CAPABILITY_LENGTH = 128
const MAX_MARKERS = 128
const SESSION_SALT_BYTES = 32
const SESSION_SALT_HEX_LENGTH = SESSION_SALT_BYTES * 2
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const RECEIPT_ID_PATTERN = /^[0-9a-f]{32}$/
const INTERNAL_ID_PATTERN = /^[0-9a-f]{32}$/
const MAX_REQUIRED_OPERATIONS = 7
const MAX_RESOURCE_SCOPES = 16
const RECEIPT_OPERATION_ORDER: readonly ReceiptOperation[] = [
  'implementation',
  'verification',
  'commit',
  'push',
  'pr-creation',
  'check-readback',
  'review-readback',
]

const ENVELOPE_KEYS = [
  'schemaVersion',
  'protocolVersion',
  'registrationDigest',
  'capabilityFlags',
  'compatibility',
  'canonical',
] as const

const CANONICAL_REQUIRED_KEYS = [
  'receiptId',
  'registrationDigest',
  'callDigest',
  'epochDigest',
  'unitDigest',
  'workspaceDigest',
  'operation',
  'result',
  'source',
  'consumption',
  'timestamp',
] as const

const CANONICAL_OPTIONAL_KEYS = [
  'repositoryDigest',
  'worktreeDigest',
  'operationTargetIdentity',
  'resourceDigest',
] as const

const LEGACY_CANONICAL_OPTIONAL_KEYS = [
  'repositoryDigest',
  'worktreeDigest',
  'resourceDigest',
] as const

const MINT_KEYS = [
  'kind',
  'schemaVersion',
  'protocolVersion',
  'envelope',
  'sessionSalt',
  'integrity',
] as const

const CONSUME_KEYS = [
  'kind',
  'schemaVersion',
  'protocolVersion',
  'registrationDigest',
  'capabilityFlags',
  'control',
  'receiptId',
  'transitionDigest',
  'timestamp',
  'integrity',
] as const

const PROGRESSION_BASE_KEYS = [
  'kind',
  'schemaVersion',
  'protocolVersion',
  'registrationDigest',
  'capabilityFlags',
  'control',
  'target',
] as const

const EPOCH_PROGRESSION_KEYS = [
  ...PROGRESSION_BASE_KEYS,
  'epochId',
  'epochDigest',
  'family',
  'state',
  'transitionDigest',
  'timestamp',
  'sessionSalt',
  'integrity',
] as const

const UNIT_PROGRESSION_KEYS = [
  ...PROGRESSION_BASE_KEYS,
  'epochId',
  'epochDigest',
  'unitId',
  'unitDigest',
  'family',
  'requiredOperations',
  'resourceScopes',
  'pinnedOperationTargetIdentity',
  'state',
  'transitionDigest',
  'timestamp',
  'sessionSalt',
  'integrity',
] as const

const LEGACY_UNIT_PROGRESSION_KEYS = UNIT_PROGRESSION_KEYS.filter(
  (key) => key !== 'pinnedOperationTargetIdentity',
)

const RESOURCE_SCOPE_KEYS = ['operation', 'resourceIdentity'] as const

const LEDGER_METADATA_KEYS = [
  'schemaVersion',
  'protocolVersion',
  'registrationDigest',
  'capabilityFlags',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  )
}

function isCurrentVersionPair(
  schemaVersion: unknown,
  protocolVersion: unknown,
): schemaVersion is typeof RECEIPT_READBACK_SCHEMA_VERSION {
  return (
    schemaVersion === RECEIPT_READBACK_SCHEMA_VERSION &&
    protocolVersion === RECEIPT_READBACK_PROTOCOL_VERSION
  )
}

function isLegacyVersionPair(
  schemaVersion: unknown,
  protocolVersion: unknown,
): schemaVersion is typeof LEGACY_RECEIPT_READBACK_SCHEMA_VERSION {
  return (
    schemaVersion === LEGACY_RECEIPT_READBACK_SCHEMA_VERSION &&
    protocolVersion === LEGACY_RECEIPT_READBACK_PROTOCOL_VERSION
  )
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value)
}

function isReceiptId(value: unknown): value is string {
  return typeof value === 'string' && RECEIPT_ID_PATTERN.test(value)
}

function isInternalId(value: unknown): value is string {
  return typeof value === 'string' && INTERNAL_ID_PATTERN.test(value)
}

function isFamily(value: unknown): value is ReceiptEpochFamily {
  return value === 'work' || value === 'shipping'
}

function isCapabilityList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) return false
  const flags = value.filter(
    (flag): flag is string =>
      typeof flag === 'string' &&
      flag.length > 0 &&
      flag.length <= MAX_CAPABILITY_LENGTH,
  )
  return flags.length === value.length && new Set(flags).size === flags.length
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isOperation(value: unknown): value is ReceiptOperation {
  return (
    value === 'implementation' ||
    value === 'verification' ||
    value === 'commit' ||
    value === 'push' ||
    value === 'pr-creation' ||
    value === 'check-readback' ||
    value === 'review-readback'
  )
}

function isSessionSaltHex(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === SESSION_SALT_HEX_LENGTH &&
    /^[0-9a-f]+$/.test(value)
  )
}

function sessionSaltHex(value: unknown): string | undefined {
  if (!(value instanceof Uint8Array) || value.byteLength !== SESSION_SALT_BYTES)
    return undefined
  return Buffer.from(value).toString('hex')
}

export function digestReceiptIdentity(
  domain: ReceiptDigestDomain,
  identity: string,
  sessionSalt: Uint8Array,
): string {
  const salt = sessionSaltHex(sessionSalt) ?? 'invalid-salt'
  return createHash('sha256')
    .update(`systematic/receipt-ledger/${domain}/v1/${salt}/${identity}`)
    .digest('hex')
}

function decodeSessionSalt(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'hex'))
}

function canonicalRequiredOperations(
  value: unknown,
): readonly ReceiptOperation[] | undefined {
  const canonical = normalizeRequiredOperations(value)
  if (!canonical || !Array.isArray(value)) return undefined
  return canonical.length === value.length &&
    canonical.every((operation, index) => operation === value[index])
    ? canonical
    : undefined
}

function normalizeRequiredOperations(
  value: unknown,
): readonly ReceiptOperation[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REQUIRED_OPERATIONS)
    return undefined
  const operations = value.filter(isOperation)
  if (operations.length !== value.length) return undefined
  if (new Set(operations).size !== operations.length) return undefined
  return RECEIPT_OPERATION_ORDER.filter((operation) =>
    operations.includes(operation),
  )
}

function canonicalResourceScopes(
  value: unknown,
): readonly ReceiptResourceScope[] | undefined {
  const canonical = normalizeResourceScopes(value)
  if (!canonical || !Array.isArray(value)) return undefined
  return canonical.length === value.length &&
    canonical.every((scope, index) => {
      const original = value[index]
      return (
        isRecord(original) &&
        original.operation === scope.operation &&
        original.resourceIdentity === scope.resourceIdentity
      )
    })
    ? canonical
    : undefined
}

function normalizeResourceScopes(
  value: unknown,
): readonly ReceiptResourceScope[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_RESOURCE_SCOPES)
    return undefined
  const scopes: ReceiptResourceScope[] = []
  const identities = new Set<string>()
  for (const item of value) {
    if (!isRecord(item) || !hasExactKeys(item, RESOURCE_SCOPE_KEYS))
      return undefined
    if (!isOperation(item.operation) || !isDigest(item.resourceIdentity))
      return undefined
    const identity = `${item.operation}/${item.resourceIdentity}`
    if (identities.has(identity)) return undefined
    identities.add(identity)
    scopes.push({
      operation: item.operation,
      resourceIdentity: item.resourceIdentity,
    })
  }
  const canonical = [...scopes].sort((first, second) => {
    const firstIndex = RECEIPT_OPERATION_ORDER.indexOf(first.operation)
    const secondIndex = RECEIPT_OPERATION_ORDER.indexOf(second.operation)
    return (
      firstIndex - secondIndex ||
      first.resourceIdentity.localeCompare(second.resourceIdentity)
    )
  })
  return canonical
}

function cloneCanonical(
  canonical: CanonicalReceiptFields,
): CanonicalReceiptFields {
  return {
    receiptId: canonical.receiptId,
    registrationDigest: canonical.registrationDigest,
    callDigest: canonical.callDigest,
    epochDigest: canonical.epochDigest,
    unitDigest: canonical.unitDigest,
    workspaceDigest: canonical.workspaceDigest,
    repositoryDigest: canonical.repositoryDigest,
    worktreeDigest: canonical.worktreeDigest,
    ...(isLocalOperation(canonical.operation)
      ? { operationTargetIdentity: canonical.operationTargetIdentity }
      : {}),
    resourceDigest: canonical.resourceDigest,
    operation: canonical.operation,
    result: 'success',
    source: 'runtime-verified',
    consumption: canonical.consumption,
    timestamp: canonical.timestamp,
  }
}

function cloneEnvelope(envelope: ReceiptEnvelope): ReceiptEnvelope {
  return {
    schemaVersion: envelope.schemaVersion,
    protocolVersion: envelope.protocolVersion,
    registrationDigest: envelope.registrationDigest,
    capabilityFlags: [...envelope.capabilityFlags],
    compatibility: 'compatible',
    canonical: cloneCanonical(envelope.canonical),
  }
}

function parseEnvelope(value: unknown): ReceiptEnvelope | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_KEYS)) return undefined
  const currentVersion = isCurrentVersionPair(
    value.schemaVersion,
    value.protocolVersion,
  )
  const legacyVersion = isLegacyVersionPair(
    value.schemaVersion,
    value.protocolVersion,
  )
  if (
    (!currentVersion && !legacyVersion) ||
    value.compatibility !== 'compatible' ||
    !isDigest(value.registrationDigest) ||
    !isCapabilityList(value.capabilityFlags) ||
    !isRecord(value.canonical)
  ) {
    return undefined
  }

  const canonical = value.canonical
  const operation = isOperation(canonical.operation)
    ? canonical.operation
    : undefined
  if (
    !hasExactKeys(
      canonical,
      CANONICAL_REQUIRED_KEYS,
      currentVersion ? CANONICAL_OPTIONAL_KEYS : LEGACY_CANONICAL_OPTIONAL_KEYS,
    ) ||
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
    (canonical.operationTargetIdentity !== undefined &&
      !isDigest(canonical.operationTargetIdentity)) ||
    operation === undefined ||
    (currentVersion &&
      isLocalOperation(operation) &&
      !isDigest(canonical.operationTargetIdentity)) ||
    (currentVersion &&
      !isLocalOperation(operation) &&
      Object.hasOwn(canonical, 'operationTargetIdentity')) ||
    (legacyVersion && Object.hasOwn(canonical, 'operationTargetIdentity')) ||
    (canonical.resourceDigest !== undefined &&
      !isDigest(canonical.resourceDigest)) ||
    canonical.result !== 'success' ||
    canonical.source !== 'runtime-verified' ||
    (canonical.consumption !== 'available' &&
      canonical.consumption !== 'consumed') ||
    !isTimestamp(canonical.timestamp) ||
    canonical.registrationDigest !== value.registrationDigest
  ) {
    return undefined
  }

  return {
    schemaVersion: currentVersion
      ? RECEIPT_READBACK_SCHEMA_VERSION
      : LEGACY_RECEIPT_READBACK_SCHEMA_VERSION,
    protocolVersion: currentVersion
      ? RECEIPT_READBACK_PROTOCOL_VERSION
      : LEGACY_RECEIPT_READBACK_PROTOCOL_VERSION,
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
      ...(isLocalOperation(operation)
        ? { operationTargetIdentity: canonical.operationTargetIdentity }
        : {}),
      resourceDigest: canonical.resourceDigest,
      operation,
      result: 'success',
      source: 'runtime-verified',
      consumption: canonical.consumption,
      timestamp: canonical.timestamp,
    },
  }
}

function parseLedgerMetadata(
  value: unknown,
): ReceiptLedgerMetadata | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, LEDGER_METADATA_KEYS) ||
    value.schemaVersion !== RECEIPT_READBACK_SCHEMA_VERSION ||
    value.protocolVersion !== RECEIPT_READBACK_PROTOCOL_VERSION ||
    !isDigest(value.registrationDigest) ||
    !isCapabilityList(value.capabilityFlags)
  ) {
    return undefined
  }
  return {
    schemaVersion: RECEIPT_READBACK_SCHEMA_VERSION,
    protocolVersion: RECEIPT_READBACK_PROTOCOL_VERSION,
    registrationDigest: value.registrationDigest,
    capabilityFlags: [...value.capabilityFlags],
  }
}

function serializeEnvelope(envelope: ReceiptEnvelope): string {
  const canonical = envelope.canonical
  const canonicalFields = {
    receiptId: canonical.receiptId,
    registrationDigest: canonical.registrationDigest,
    callDigest: canonical.callDigest,
    epochDigest: canonical.epochDigest,
    unitDigest: canonical.unitDigest,
    workspaceDigest: canonical.workspaceDigest,
    repositoryDigest: canonical.repositoryDigest ?? null,
    worktreeDigest: canonical.worktreeDigest ?? null,
    ...(envelope.schemaVersion === RECEIPT_READBACK_SCHEMA_VERSION
      ? { operationTargetIdentity: canonical.operationTargetIdentity ?? null }
      : {}),
    resourceDigest: canonical.resourceDigest ?? null,
    operation: canonical.operation,
    result: canonical.result,
    source: canonical.source,
    consumption: canonical.consumption,
    timestamp: canonical.timestamp,
  }
  return JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    protocolVersion: envelope.protocolVersion,
    registrationDigest: envelope.registrationDigest,
    capabilityFlags: [...envelope.capabilityFlags],
    compatibility: envelope.compatibility,
    canonical: canonicalFields,
  })
}

function hashIntegrity(scope: string, value: string): string {
  return createHash('sha256')
    .update(`systematic/receipt-readback/${scope}/v1/${value}`)
    .digest('hex')
}

function mintIntegrity(envelope: ReceiptEnvelope, sessionSalt: string): string {
  return hashIntegrity('mint', `${sessionSalt}/${serializeEnvelope(envelope)}`)
}

function consumeIntegrity(
  marker: Omit<ReceiptConsumeMarker, 'integrity'>,
): string {
  return hashIntegrity(
    'consume',
    JSON.stringify({
      kind: marker.kind,
      schemaVersion: marker.schemaVersion,
      protocolVersion: marker.protocolVersion,
      registrationDigest: marker.registrationDigest,
      capabilityFlags: [...marker.capabilityFlags],
      control: marker.control,
      receiptId: marker.receiptId,
      transitionDigest: marker.transitionDigest,
      timestamp: marker.timestamp,
    }),
  )
}

function progressionIntegrity(marker: ReceiptProgressionMarkerCore): string {
  const declaration =
    marker.target === 'epoch'
      ? {
          target: marker.target,
          epochId: marker.epochId,
          epochDigest: marker.epochDigest,
          family: marker.family,
        }
      : {
          target: marker.target,
          epochId: marker.epochId,
          epochDigest: marker.epochDigest,
          unitId: marker.unitId,
          unitDigest: marker.unitDigest,
          family: marker.family,
          requiredOperations: [...marker.requiredOperations],
          resourceScopes: marker.resourceScopes.map((scope) => ({ ...scope })),
          ...(marker.schemaVersion === RECEIPT_READBACK_SCHEMA_VERSION
            ? {
                pinnedOperationTargetIdentity:
                  marker.pinnedOperationTargetIdentity ?? null,
              }
            : {}),
        }
  return hashIntegrity(
    'progression',
    JSON.stringify({
      kind: marker.kind,
      schemaVersion: marker.schemaVersion,
      protocolVersion: marker.protocolVersion,
      registrationDigest: marker.registrationDigest,
      capabilityFlags: [...marker.capabilityFlags],
      control: marker.control,
      target: marker.target,
      declaration,
      state: marker.state,
      transitionDigest: marker.transitionDigest,
      timestamp: marker.timestamp,
      sessionSalt: marker.sessionSalt,
    }),
  )
}

function markerResult(
  category: ReceiptReadbackFailureCategory,
): ReceiptMarkerValidation {
  return { status: 'rejected', category }
}

function parseMintMarker(value: unknown): ReceiptMarkerValidation {
  if (!isRecord(value)) return markerResult('malformed')
  if (value.kind !== 'mint') {
    return markerResult(
      value.kind === 'control' ? 'unknown-kind' : 'unknown-kind',
    )
  }
  const currentVersion = isCurrentVersionPair(
    value.schemaVersion,
    value.protocolVersion,
  )
  const legacyVersion = isLegacyVersionPair(
    value.schemaVersion,
    value.protocolVersion,
  )
  if (!currentVersion && !legacyVersion) {
    if (
      value.schemaVersion !== RECEIPT_READBACK_SCHEMA_VERSION &&
      value.schemaVersion !== LEGACY_RECEIPT_READBACK_SCHEMA_VERSION
    )
      return markerResult('unknown-schema')
    return markerResult('unknown-protocol')
  }
  if (!hasExactKeys(value, MINT_KEYS)) return markerResult('forbidden-field')
  const envelope = parseEnvelope(value.envelope)
  if (!envelope) return markerResult('malformed')
  if (
    (currentVersion &&
      envelope.schemaVersion !== RECEIPT_READBACK_SCHEMA_VERSION) ||
    (legacyVersion && envelope.schemaVersion !== 1)
  ) {
    return markerResult('malformed')
  }
  if (!isSessionSaltHex(value.sessionSalt)) return markerResult('malformed')
  if (!isDigest(value.integrity)) return markerResult('malformed')
  if (envelope.canonical.consumption !== 'available')
    return markerResult('malformed')

  const marker: ReceiptMintMarker = {
    kind: 'mint',
    schemaVersion: value.schemaVersion as ReceiptReadbackVersion,
    protocolVersion: value.protocolVersion as ReceiptReadbackVersion,
    envelope,
    sessionSalt: value.sessionSalt,
    integrity: value.integrity,
  }
  if (mintIntegrity(envelope, marker.sessionSalt) !== marker.integrity)
    return markerResult('integrity-mismatch')
  return { status: 'valid', marker }
}

function parseConsumeMarker(
  value: Record<string, unknown>,
): ReceiptMarkerValidation {
  if (!hasExactKeys(value, CONSUME_KEYS)) return markerResult('forbidden-field')
  const currentVersion = isCurrentVersionPair(
    value.schemaVersion,
    value.protocolVersion,
  )
  const legacyVersion = isLegacyVersionPair(
    value.schemaVersion,
    value.protocolVersion,
  )
  if (
    (!currentVersion && !legacyVersion) ||
    value.kind !== 'control' ||
    value.control !== 'consume' ||
    !isDigest(value.registrationDigest) ||
    !isCapabilityList(value.capabilityFlags) ||
    !isReceiptId(value.receiptId) ||
    !isDigest(value.transitionDigest) ||
    !isTimestamp(value.timestamp) ||
    !isDigest(value.integrity)
  ) {
    return markerResult('malformed')
  }
  const marker = {
    kind: 'control' as const,
    schemaVersion: value.schemaVersion as ReceiptReadbackVersion,
    protocolVersion: value.protocolVersion as ReceiptReadbackVersion,
    registrationDigest: value.registrationDigest,
    capabilityFlags: [...value.capabilityFlags],
    control: 'consume' as const,
    receiptId: value.receiptId,
    transitionDigest: value.transitionDigest,
    timestamp: value.timestamp,
    integrity: value.integrity,
  }
  if (consumeIntegrity(marker) !== marker.integrity)
    return markerResult('integrity-mismatch')
  return { status: 'valid', marker }
}

function parseProgressionMarker(
  value: Record<string, unknown>,
): ReceiptMarkerValidation {
  if (value.target === 'epoch') return parseEpochProgressionMarker(value)
  if (value.target === 'unit') return parseUnitProgressionMarker(value)
  return markerResult('unknown-kind')
}

interface ParsedProgressionBase {
  readonly schemaVersion: ReceiptReadbackVersion
  readonly protocolVersion: ReceiptReadbackVersion
  readonly registrationDigest: string
  readonly capabilityFlags: readonly string[]
  readonly state: ReceiptProgressionStateName
  readonly transitionDigest: string
  readonly timestamp: number
  readonly sessionSalt: string
  readonly integrity: string
}

function parseProgressionBase(
  value: Record<string, unknown>,
): ParsedProgressionBase | undefined {
  if (
    (isCurrentVersionPair(value.schemaVersion, value.protocolVersion) ||
      isLegacyVersionPair(value.schemaVersion, value.protocolVersion)) &&
    value.kind === 'control' &&
    value.control === 'progression' &&
    isDigest(value.registrationDigest) &&
    isCapabilityList(value.capabilityFlags) &&
    (value.state === 'started' || value.state === 'completed') &&
    isDigest(value.transitionDigest) &&
    isTimestamp(value.timestamp) &&
    isSessionSaltHex(value.sessionSalt) &&
    isDigest(value.integrity)
  ) {
    return {
      schemaVersion: value.schemaVersion as ReceiptReadbackVersion,
      protocolVersion: value.protocolVersion as ReceiptReadbackVersion,
      registrationDigest: value.registrationDigest,
      capabilityFlags: [...value.capabilityFlags],
      state: value.state,
      transitionDigest: value.transitionDigest,
      timestamp: value.timestamp,
      sessionSalt: value.sessionSalt,
      integrity: value.integrity,
    }
  }
  return undefined
}

function parseEpochProgressionMarker(
  value: Record<string, unknown>,
): ReceiptMarkerValidation {
  if (!hasExactKeys(value, EPOCH_PROGRESSION_KEYS)) {
    return Object.hasOwn(value, 'epochId')
      ? markerResult('forbidden-field')
      : markerResult('missing-internal-id')
  }
  const base = parseProgressionBase(value)
  if (
    !base ||
    !isInternalId(value.epochId) ||
    !isDigest(value.epochDigest) ||
    !isFamily(value.family)
  ) {
    return markerResult(
      value.epochId === undefined ? 'missing-internal-id' : 'malformed',
    )
  }
  const marker: ReceiptEpochProgressionMarker = {
    kind: 'control',
    schemaVersion: base.schemaVersion,
    protocolVersion: base.protocolVersion,
    registrationDigest: base.registrationDigest,
    capabilityFlags: [...base.capabilityFlags],
    control: 'progression',
    target: 'epoch',
    epochId: value.epochId,
    epochDigest: value.epochDigest,
    family: value.family,
    state: base.state,
    transitionDigest: base.transitionDigest,
    timestamp: base.timestamp,
    sessionSalt: base.sessionSalt,
    integrity: base.integrity,
  }
  return progressionMarkerValidation(marker)
}

function parseUnitProgressionMarker(
  value: Record<string, unknown>,
): ReceiptMarkerValidation {
  const currentVersion = isCurrentVersionPair(
    value.schemaVersion,
    value.protocolVersion,
  )
  if (
    !hasExactKeys(
      value,
      LEGACY_UNIT_PROGRESSION_KEYS,
      currentVersion ? ['pinnedOperationTargetIdentity'] : [],
    )
  ) {
    return Object.hasOwn(value, 'epochId') && Object.hasOwn(value, 'unitId')
      ? markerResult('forbidden-field')
      : markerResult('missing-internal-id')
  }
  const requiredOperations = canonicalRequiredOperations(
    value.requiredOperations,
  )
  const resourceScopes = canonicalResourceScopes(value.resourceScopes)
  const pinnedOperationTargetIdentity =
    value.pinnedOperationTargetIdentity === undefined
      ? undefined
      : isDigest(value.pinnedOperationTargetIdentity)
        ? value.pinnedOperationTargetIdentity
        : undefined
  const base = parseProgressionBase(value)
  if (
    !base ||
    !isInternalId(value.epochId) ||
    !isDigest(value.epochDigest) ||
    !isInternalId(value.unitId) ||
    !isDigest(value.unitDigest) ||
    !isFamily(value.family) ||
    !requiredOperations ||
    !resourceScopes ||
    (value.pinnedOperationTargetIdentity !== undefined &&
      pinnedOperationTargetIdentity === undefined)
  ) {
    return value.epochId === undefined || value.unitId === undefined
      ? markerResult('missing-internal-id')
      : markerResult('malformed')
  }
  const marker: ReceiptUnitProgressionMarker = {
    kind: 'control',
    schemaVersion: base.schemaVersion,
    protocolVersion: base.protocolVersion,
    registrationDigest: base.registrationDigest,
    capabilityFlags: [...base.capabilityFlags],
    control: 'progression',
    target: 'unit',
    epochId: value.epochId,
    epochDigest: value.epochDigest,
    unitId: value.unitId,
    unitDigest: value.unitDigest,
    family: value.family,
    requiredOperations: [...requiredOperations],
    resourceScopes: resourceScopes.map((scope) => ({ ...scope })),
    ...(pinnedOperationTargetIdentity ? { pinnedOperationTargetIdentity } : {}),
    state: base.state,
    transitionDigest: base.transitionDigest,
    timestamp: base.timestamp,
    sessionSalt: base.sessionSalt,
    integrity: base.integrity,
  }
  return progressionMarkerValidation(marker)
}

function progressionMarkerValidation(
  marker: ReceiptProgressionMarker,
): ReceiptMarkerValidation {
  return progressionIntegrity(marker) === marker.integrity
    ? { status: 'valid', marker }
    : markerResult('integrity-mismatch')
}

export function validateReceiptMarker(input: unknown): ReceiptMarkerValidation {
  if (!isRecord(input)) return markerResult('malformed')
  if (input.kind === 'mint') return parseMintMarker(input)
  if (input.kind !== 'control') return markerResult('unknown-kind')
  if (
    !isCurrentVersionPair(input.schemaVersion, input.protocolVersion) &&
    !isLegacyVersionPair(input.schemaVersion, input.protocolVersion)
  ) {
    if (
      input.schemaVersion !== RECEIPT_READBACK_SCHEMA_VERSION &&
      input.schemaVersion !== LEGACY_RECEIPT_READBACK_SCHEMA_VERSION
    )
      return markerResult('unknown-schema')
    return markerResult('unknown-protocol')
  }
  if (input.control === 'consume') return parseConsumeMarker(input)
  if (input.control === 'progression') return parseProgressionMarker(input)
  return markerResult('unknown-kind')
}

function seedFromMarker(marker: ReceiptMarker):
  | {
      readonly sessionSalt: string
      readonly registrationDigest: string
      readonly capabilityFlags: readonly string[]
    }
  | undefined {
  if (marker.kind === 'mint') {
    return {
      sessionSalt: marker.sessionSalt,
      registrationDigest: marker.envelope.registrationDigest,
      capabilityFlags: marker.envelope.capabilityFlags,
    }
  }
  if (marker.control !== 'progression') return undefined
  return {
    sessionSalt: marker.sessionSalt,
    registrationDigest: marker.registrationDigest,
    capabilityFlags: marker.capabilityFlags,
  }
}

/**
 * Extracts the registrationDigest from a validated marker.
 * Returns undefined for unknown/malformed shapes.
 */
function registrationDigestFromMarker(marker: ReceiptMarker): string {
  if (marker.kind === 'mint') return marker.envelope.registrationDigest
  return marker.registrationDigest
}

/**
 * Filters a raw marker array, retaining only markers that belong to the given
 * registrationDigest. Markers that cannot be parsed (malformed, unknown schema,
 * etc.) are retained as-is so that downstream callers can fail-closed on them.
 *
 * Use this before extractReceiptReadbackSeed / foldReceiptReadback when the
 * shared metadata array may contain markers from multiple concurrent
 * registrations (e.g. dual-registration in a single OpenCode session).
 */
export function filterMarkersByRegistration(
  markers: readonly unknown[],
  ownRegistrationDigest: string,
): unknown[] {
  return markers.filter((input) => {
    const validation = validateReceiptMarker(input)
    // Cannot parse → retain fail-closed (caller will reject it)
    if (validation.status !== 'valid') return true
    return (
      registrationDigestFromMarker(validation.marker) === ownRegistrationDigest
    )
  })
}

export function extractReceiptReadbackSeed(
  inputs: readonly unknown[],
): ReceiptReadbackSeedResult {
  if (inputs.length === 0) return { status: 'empty' }
  if (inputs.length > MAX_MARKERS)
    return { status: 'repair-required', category: 'malformed' }
  let seed:
    | {
        readonly sessionSalt: string
        readonly registrationDigest: string
        readonly capabilityFlags: readonly string[]
      }
    | undefined
  let sawMarker = false
  for (const input of inputs) {
    const validation = validateReceiptMarker(input)
    if (validation.status !== 'valid') {
      return { status: 'repair-required', category: validation.category }
    }
    sawMarker = true
    const markerSeed = seedFromMarker(validation.marker)
    if (!markerSeed) continue
    if (!seed) {
      seed = markerSeed
      continue
    }
    if (
      seed.sessionSalt !== markerSeed.sessionSalt ||
      seed.registrationDigest !== markerSeed.registrationDigest ||
      !capabilitiesEqual(seed.capabilityFlags, markerSeed.capabilityFlags)
    ) {
      return { status: 'repair-required', category: 'conflicting-seed' }
    }
  }
  if (!sawMarker || !seed)
    return { status: 'repair-required', category: 'missing-seed' }
  return {
    status: 'ready',
    sessionSalt: decodeSessionSalt(seed.sessionSalt),
    registrationDigest: seed.registrationDigest,
    capabilityFlags: [...seed.capabilityFlags],
  }
}

export function projectReceiptMintMarker(
  receipt: unknown,
  sessionSalt: Uint8Array,
): ReceiptMintMarker | undefined {
  const envelope = parseEnvelope(receipt)
  const salt = sessionSaltHex(sessionSalt)
  if (!envelope || !salt || envelope.canonical.consumption !== 'available')
    return undefined
  return {
    kind: 'mint',
    schemaVersion: RECEIPT_READBACK_SCHEMA_VERSION,
    protocolVersion: RECEIPT_READBACK_PROTOCOL_VERSION,
    envelope: cloneEnvelope(envelope),
    sessionSalt: salt,
    integrity: mintIntegrity(envelope, salt),
  }
}

export function projectReceiptConsumptionMarker(
  receipt: unknown,
  transitionDigest: string,
  timestamp = Date.now(),
): ReceiptConsumeMarker | undefined {
  const envelope = parseEnvelope(receipt)
  if (!envelope || !isDigest(transitionDigest) || !isTimestamp(timestamp)) {
    return undefined
  }
  const markerWithoutIntegrity: Omit<ReceiptConsumeMarker, 'integrity'> = {
    kind: 'control' as const,
    schemaVersion: RECEIPT_READBACK_SCHEMA_VERSION,
    protocolVersion: RECEIPT_READBACK_PROTOCOL_VERSION,
    registrationDigest: envelope.registrationDigest,
    capabilityFlags: [...envelope.capabilityFlags],
    control: 'consume' as const,
    receiptId: envelope.canonical.receiptId,
    transitionDigest,
    timestamp,
  }
  return {
    ...markerWithoutIntegrity,
    integrity: consumeIntegrity(markerWithoutIntegrity),
  }
}

export function projectReceiptProgressionMarker(
  source: ReceiptProgressionProjectionSource,
  input: ReceiptProgressionMarkerInput,
): ReceiptProgressionMarker | undefined {
  const context = projectionContext(source, input)
  if (!context) return undefined
  if (input.target === 'epoch')
    return projectEpochMarker(source, input, context)
  return projectUnitMarker(source, input, context)
}

interface ProgressionProjectionContext {
  readonly metadata: ReceiptLedgerMetadata
  readonly sessionSalt: string
  readonly timestamp: number
}

function projectionContext(
  source: ReceiptProgressionProjectionSource,
  input: ReceiptProgressionMarkerInput,
): ProgressionProjectionContext | undefined {
  if (!isRecord(source) || !isRecord(input)) return undefined
  const metadataValue =
    typeof source.metadata === 'function' ? source.metadata() : source.metadata
  const metadata = parseLedgerMetadata(metadataValue)
  const salt = sessionSaltHex(source.getSessionSalt())
  const timestamp = input.timestamp ?? Date.now()
  if (
    !metadata ||
    !salt ||
    !isTimestamp(timestamp) ||
    (input.state !== 'started' && input.state !== 'completed') ||
    !isDigest(input.transitionDigest) ||
    typeof source.digestIdentity !== 'function'
  ) {
    return undefined
  }
  return { metadata, sessionSalt: salt, timestamp }
}

function projectEpochMarker(
  source: ReceiptProgressionProjectionSource,
  input: Extract<ReceiptProgressionMarkerInput, { target: 'epoch' }>,
  context: ProgressionProjectionContext,
): ReceiptEpochProgressionMarker | undefined {
  if (!isInternalId(input.epochId) || !isFamily(input.family)) return undefined
  const markerWithoutIntegrity: ReceiptEpochProgressionMarkerCore = {
    kind: 'control',
    schemaVersion: RECEIPT_READBACK_SCHEMA_VERSION,
    protocolVersion: RECEIPT_READBACK_PROTOCOL_VERSION,
    registrationDigest: context.metadata.registrationDigest,
    capabilityFlags: [...context.metadata.capabilityFlags],
    control: 'progression',
    target: 'epoch',
    epochId: input.epochId,
    epochDigest: source.digestIdentity('epoch', input.epochId),
    family: input.family,
    state: input.state,
    transitionDigest: input.transitionDigest,
    timestamp: context.timestamp,
    sessionSalt: context.sessionSalt,
  }
  if (!isDigest(markerWithoutIntegrity.epochDigest)) return undefined
  return {
    ...markerWithoutIntegrity,
    integrity: progressionIntegrity(markerWithoutIntegrity),
  }
}

function projectUnitMarker(
  source: ReceiptProgressionProjectionSource,
  input: Extract<ReceiptProgressionMarkerInput, { target: 'unit' }>,
  context: ProgressionProjectionContext,
): ReceiptUnitProgressionMarker | undefined {
  if (
    !isInternalId(input.epochId) ||
    !isInternalId(input.unitId) ||
    !isFamily(input.family) ||
    normalizeRequiredOperations(input.requiredOperations) === undefined ||
    normalizeResourceScopes(input.resourceScopes) === undefined ||
    (input.pinnedOperationTargetIdentity !== undefined &&
      !isDigest(input.pinnedOperationTargetIdentity))
  ) {
    return undefined
  }
  const requiredOperations = normalizeRequiredOperations(
    input.requiredOperations,
  )
  const resourceScopes = normalizeResourceScopes(input.resourceScopes)
  if (!requiredOperations || !resourceScopes) return undefined
  const markerWithoutIntegrity: ReceiptUnitProgressionMarkerCore = {
    kind: 'control',
    schemaVersion: RECEIPT_READBACK_SCHEMA_VERSION,
    protocolVersion: RECEIPT_READBACK_PROTOCOL_VERSION,
    registrationDigest: context.metadata.registrationDigest,
    capabilityFlags: [...context.metadata.capabilityFlags],
    control: 'progression',
    target: 'unit',
    epochId: input.epochId,
    epochDigest: source.digestIdentity('epoch', input.epochId),
    unitId: input.unitId,
    unitDigest: source.digestIdentity('unit', input.unitId),
    family: input.family,
    requiredOperations: [...requiredOperations],
    resourceScopes: resourceScopes.map((scope) => ({ ...scope })),
    ...(input.pinnedOperationTargetIdentity
      ? { pinnedOperationTargetIdentity: input.pinnedOperationTargetIdentity }
      : {}),
    state: input.state,
    transitionDigest: input.transitionDigest,
    timestamp: context.timestamp,
    sessionSalt: context.sessionSalt,
  }
  if (
    !isDigest(markerWithoutIntegrity.epochDigest) ||
    !isDigest(markerWithoutIntegrity.unitDigest)
  ) {
    return undefined
  }
  return {
    ...markerWithoutIntegrity,
    integrity: progressionIntegrity(markerWithoutIntegrity),
  }
}

function capabilitiesEqual(
  first: readonly string[],
  second: readonly string[],
): boolean {
  return (
    first.length === second.length &&
    first.every((flag, index) => flag === second[index])
  )
}

function cloneMarker(marker: ReceiptMarker): ReceiptMarker {
  if (marker.kind === 'mint') {
    return {
      kind: 'mint',
      schemaVersion: marker.schemaVersion,
      protocolVersion: marker.protocolVersion,
      envelope: cloneEnvelope(marker.envelope),
      sessionSalt: marker.sessionSalt,
      integrity: marker.integrity,
    }
  }
  if (marker.control === 'consume') {
    return {
      kind: 'control',
      schemaVersion: marker.schemaVersion,
      protocolVersion: marker.protocolVersion,
      registrationDigest: marker.registrationDigest,
      capabilityFlags: [...marker.capabilityFlags],
      control: 'consume',
      receiptId: marker.receiptId,
      transitionDigest: marker.transitionDigest,
      timestamp: marker.timestamp,
      integrity: marker.integrity,
    }
  }
  if (marker.target === 'epoch') {
    return {
      kind: 'control',
      schemaVersion: marker.schemaVersion,
      protocolVersion: marker.protocolVersion,
      registrationDigest: marker.registrationDigest,
      capabilityFlags: [...marker.capabilityFlags],
      control: 'progression',
      target: 'epoch',
      epochId: marker.epochId,
      epochDigest: marker.epochDigest,
      family: marker.family,
      state: marker.state,
      transitionDigest: marker.transitionDigest,
      timestamp: marker.timestamp,
      sessionSalt: marker.sessionSalt,
      integrity: marker.integrity,
    }
  }
  return {
    kind: 'control',
    schemaVersion: marker.schemaVersion,
    protocolVersion: marker.protocolVersion,
    registrationDigest: marker.registrationDigest,
    capabilityFlags: [...marker.capabilityFlags],
    control: 'progression',
    target: 'unit',
    epochId: marker.epochId,
    epochDigest: marker.epochDigest,
    unitId: marker.unitId,
    unitDigest: marker.unitDigest,
    family: marker.family,
    requiredOperations: [...marker.requiredOperations],
    resourceScopes: marker.resourceScopes.map((scope) => ({ ...scope })),
    ...(marker.pinnedOperationTargetIdentity
      ? { pinnedOperationTargetIdentity: marker.pinnedOperationTargetIdentity }
      : {}),
    state: marker.state,
    transitionDigest: marker.transitionDigest,
    timestamp: marker.timestamp,
    sessionSalt: marker.sessionSalt,
    integrity: marker.integrity,
  }
}

function serializeMarker(marker: ReceiptMarker): string {
  if (marker.kind === 'mint') {
    return JSON.stringify({
      kind: marker.kind,
      schemaVersion: marker.schemaVersion,
      protocolVersion: marker.protocolVersion,
      envelope: serializeEnvelope(marker.envelope),
      sessionSalt: marker.sessionSalt,
      integrity: marker.integrity,
    })
  }
  if (marker.control === 'consume') {
    return JSON.stringify({
      kind: marker.kind,
      schemaVersion: marker.schemaVersion,
      protocolVersion: marker.protocolVersion,
      registrationDigest: marker.registrationDigest,
      capabilityFlags: [...marker.capabilityFlags],
      control: marker.control,
      receiptId: marker.receiptId,
      transitionDigest: marker.transitionDigest,
      timestamp: marker.timestamp,
      integrity: marker.integrity,
    })
  }
  if (marker.target === 'epoch') {
    return JSON.stringify({
      kind: marker.kind,
      schemaVersion: marker.schemaVersion,
      protocolVersion: marker.protocolVersion,
      registrationDigest: marker.registrationDigest,
      capabilityFlags: [...marker.capabilityFlags],
      control: marker.control,
      target: marker.target,
      epochId: marker.epochId,
      epochDigest: marker.epochDigest,
      family: marker.family,
      state: marker.state,
      transitionDigest: marker.transitionDigest,
      timestamp: marker.timestamp,
      sessionSalt: marker.sessionSalt,
      integrity: marker.integrity,
    })
  }
  return JSON.stringify({
    kind: marker.kind,
    schemaVersion: marker.schemaVersion,
    protocolVersion: marker.protocolVersion,
    registrationDigest: marker.registrationDigest,
    capabilityFlags: [...marker.capabilityFlags],
    control: marker.control,
    target: marker.target,
    epochId: marker.epochId,
    epochDigest: marker.epochDigest,
    unitId: marker.unitId,
    unitDigest: marker.unitDigest,
    family: marker.family,
    requiredOperations: [...marker.requiredOperations],
    resourceScopes: marker.resourceScopes.map((scope) => ({ ...scope })),
    ...(marker.schemaVersion === RECEIPT_READBACK_SCHEMA_VERSION
      ? {
          pinnedOperationTargetIdentity:
            marker.pinnedOperationTargetIdentity ?? null,
        }
      : {}),
    state: marker.state,
    transitionDigest: marker.transitionDigest,
    timestamp: marker.timestamp,
    sessionSalt: marker.sessionSalt,
    integrity: marker.integrity,
  })
}

function rejected(
  category: ReceiptReadbackFailureCategory,
): ReceiptReadbackResult {
  return { status: 'rejected', category }
}

function validateExpectation(
  expectation: ReceiptReadbackExpectation,
): { salt: string; source: 'runtime-verified' } | undefined {
  const salt = sessionSaltHex(expectation.sessionSalt)
  if (
    !salt ||
    !isDigest(expectation.registrationDigest) ||
    !isCapabilityList(expectation.capabilityFlags)
  ) {
    return undefined
  }
  return { salt, source: expectation.source ?? 'runtime-verified' }
}

function sameEnvelope(
  first: ReceiptEnvelope,
  second: ReceiptEnvelope,
): boolean {
  return serializeEnvelope(first) === serializeEnvelope(second)
}

interface FoldContext {
  readonly expectation: ReceiptReadbackExpectation
  readonly expectedSource: 'runtime-verified'
  readonly expectedSalt: string
  readonly mintByReceipt: Map<string, ReceiptEnvelope>
  readonly consumedByReceipt: Map<string, ReceiptConsumeMarker>
  progression: ReceiptReadbackProgression
  readonly seenMarkers: Set<string>
}

function foldMintMarker(
  marker: ReceiptMintMarker,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  if (marker.sessionSalt !== context.expectedSalt) return 'salt-mismatch'
  if (
    marker.envelope.schemaVersion === 1 &&
    context.expectation.operationTargetIdentity
  ) {
    return 'identity-digest-mismatch'
  }
  if (
    marker.envelope.schemaVersion === RECEIPT_READBACK_SCHEMA_VERSION &&
    context.expectation.operationTargetIdentity &&
    marker.envelope.canonical.operationTargetIdentity !==
      context.expectation.operationTargetIdentity
  ) {
    return 'identity-digest-mismatch'
  }
  const registrationMatches =
    marker.envelope.registrationDigest ===
      context.expectation.registrationDigest &&
    marker.envelope.canonical.registrationDigest ===
      context.expectation.registrationDigest
  if (!registrationMatches) return 'cross-registration'
  if (
    !capabilitiesEqual(
      marker.envelope.capabilityFlags,
      context.expectation.capabilityFlags,
    ) ||
    marker.envelope.canonical.source !== context.expectedSource
  ) {
    return 'capability-mismatch'
  }

  const receiptId = marker.envelope.canonical.receiptId
  const existing = context.mintByReceipt.get(receiptId)
  if (existing) {
    return sameEnvelope(existing, marker.envelope)
      ? undefined
      : 'conflicting-marker'
  }
  for (const prior of context.mintByReceipt.values()) {
    if (prior.canonical.callDigest === marker.envelope.canonical.callDigest)
      return 'conflicting-marker'
  }
  context.mintByReceipt.set(receiptId, marker.envelope)
  return undefined
}

function controlScopeFailure(
  marker: ReceiptControlMarker,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  if (marker.registrationDigest !== context.expectation.registrationDigest)
    return 'cross-registration'
  if (
    !capabilitiesEqual(
      marker.capabilityFlags,
      context.expectation.capabilityFlags,
    )
  )
    return 'capability-mismatch'
  return undefined
}

function progressionIdentityFailure(
  marker: ReceiptProgressionMarker,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  if (marker.sessionSalt !== context.expectedSalt) return 'salt-mismatch'
  const salt = decodeSessionSalt(marker.sessionSalt)
  if (
    digestReceiptIdentity('epoch', marker.epochId, salt) !== marker.epochDigest
  ) {
    return 'identity-digest-mismatch'
  }
  if (
    marker.target === 'unit' &&
    digestReceiptIdentity('unit', marker.unitId, salt) !== marker.unitDigest
  ) {
    return 'identity-digest-mismatch'
  }
  return undefined
}

function foldConsumeMarker(
  marker: ReceiptConsumeMarker,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  const existing = context.consumedByReceipt.get(marker.receiptId)
  if (existing && serializeMarker(existing) !== serializeMarker(marker))
    return 'conflicting-marker'
  context.consumedByReceipt.set(marker.receiptId, marker)
  return undefined
}

function progressionSnapshot(
  marker: ReceiptEpochProgressionMarker,
): ReceiptEpochProgressionSnapshot
function progressionSnapshot(
  marker: ReceiptUnitProgressionMarker,
): ReceiptUnitProgressionSnapshot
function progressionSnapshot(
  marker: ReceiptProgressionMarker,
): ReceiptProgressionSnapshot {
  if (marker.target === 'epoch') {
    return {
      target: 'epoch',
      state: marker.state,
      epochId: marker.epochId,
      epochDigest: marker.epochDigest,
      family: marker.family,
      transitionDigest: marker.transitionDigest,
    }
  }
  return {
    target: 'unit',
    state: marker.state,
    epochId: marker.epochId,
    epochDigest: marker.epochDigest,
    unitId: marker.unitId,
    unitDigest: marker.unitDigest,
    family: marker.family,
    requiredOperations: [...marker.requiredOperations],
    resourceScopes: marker.resourceScopes.map((scope) => ({ ...scope })),
    ...(marker.pinnedOperationTargetIdentity
      ? { pinnedOperationTargetIdentity: marker.pinnedOperationTargetIdentity }
      : {}),
    transitionDigest: marker.transitionDigest,
  }
}

function completionEvidence(
  marker: ReceiptProgressionMarker,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  const receipts = [...context.mintByReceipt.values()].filter(
    (envelope) =>
      envelope.canonical.epochDigest === marker.epochDigest &&
      (marker.target === 'epoch' ||
        envelope.canonical.unitDigest === marker.unitDigest),
  )
  if (receipts.length === 0) return 'missing-mint'
  if (
    receipts.some(
      (envelope) =>
        !context.consumedByReceipt.has(envelope.canonical.receiptId),
    )
  ) {
    return 'inconsistent-evidence'
  }
  return undefined
}

function applyEpochProgression(
  marker: ReceiptEpochProgressionMarker,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  return marker.state === 'started'
    ? applyEpochStart(marker, context)
    : applyEpochComplete(marker, context)
}

function applyEpochStart(
  marker: ReceiptEpochProgressionMarker,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  const snapshot: ReceiptEpochProgressionSnapshot = progressionSnapshot(marker)
  const current = context.progression.epoch
  if (!current) {
    context.progression = { epoch: snapshot, unit: null }
    return undefined
  }
  if (current.epochId === marker.epochId) {
    if (current.family !== marker.family) return 'conflicting-marker'
    return current.state === 'completed' ? 'out-of-order' : 'conflicting-marker'
  }
  if (current.state !== 'completed') return 'out-of-order'
  context.progression = { epoch: snapshot, unit: null }
  return undefined
}

function applyEpochComplete(
  marker: ReceiptEpochProgressionMarker,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  const current = context.progression.epoch
  if (!current || current.epochId !== marker.epochId) return 'out-of-order'
  if (current.family !== marker.family) return 'conflicting-marker'
  if (current.state !== 'started') return 'out-of-order'
  if (
    context.progression.unit &&
    context.progression.unit.epochId === marker.epochId &&
    context.progression.unit.state !== 'completed'
  ) {
    return 'inconsistent-evidence'
  }
  const evidenceFailure = completionEvidence(marker, context)
  if (evidenceFailure) return evidenceFailure
  context.progression = {
    epoch: progressionSnapshot(marker),
    unit: context.progression.unit,
  }
  return undefined
}

function applyUnitProgression(
  marker: ReceiptUnitProgressionMarker,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  const epoch = context.progression.epoch
  if (!epoch || epoch.epochId !== marker.epochId) return 'progression-mismatch'
  if (epoch.family !== marker.family) return 'conflicting-marker'
  if (epoch.state !== 'started') return 'out-of-order'
  if (marker.state === 'started') return applyUnitStart(marker, epoch, context)
  return applyUnitComplete(marker, epoch, context)
}

function applyUnitStart(
  marker: ReceiptUnitProgressionMarker,
  epoch: ReceiptEpochProgressionSnapshot,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  const snapshot: ReceiptUnitProgressionSnapshot = progressionSnapshot(marker)
  const current = context.progression.unit
  if (!current) {
    context.progression = { epoch, unit: snapshot }
    return undefined
  }
  if (current.unitId === marker.unitId) {
    if (current.state === 'completed') return 'out-of-order'
    if (
      !sameUnitDeclaration(current, marker) &&
      unitHasMintedEvidence(current, context)
    ) {
      return 'out-of-order'
    }
    if (
      sameUnitDeclaration(current, marker) &&
      current.transitionDigest !== marker.transitionDigest &&
      current.pinnedOperationTargetIdentity ===
        marker.pinnedOperationTargetIdentity
    ) {
      return 'conflicting-marker'
    }
    if (!unitDeclarationExtends(current, marker)) return 'conflicting-marker'
    if (
      sameUnitDeclaration(current, marker) &&
      current.pinnedOperationTargetIdentity ===
        marker.pinnedOperationTargetIdentity
    ) {
      return undefined
    }
    context.progression = { epoch, unit: snapshot }
    return undefined
  }
  if (current.state !== 'completed') return 'out-of-order'
  context.progression = { epoch, unit: snapshot }
  return undefined
}

function applyUnitComplete(
  marker: ReceiptUnitProgressionMarker,
  epoch: ReceiptEpochProgressionSnapshot,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  const current = context.progression.unit
  if (!current || current.unitId !== marker.unitId) return 'out-of-order'
  if (!sameUnitDeclaration(current, marker)) return 'conflicting-marker'
  if (current.state !== 'started') return 'out-of-order'
  const evidenceFailure = completionEvidence(marker, context)
  if (evidenceFailure) return evidenceFailure
  context.progression = {
    epoch,
    unit: progressionSnapshot(marker),
  }
  return undefined
}

function unitHasMintedEvidence(
  current: ReceiptUnitProgressionSnapshot,
  context: FoldContext,
): boolean {
  return [...context.mintByReceipt.values()].some(
    (envelope) =>
      envelope.canonical.epochDigest === current.epochDigest &&
      envelope.canonical.unitDigest === current.unitDigest,
  )
}

function sameUnitDeclaration(
  current: ReceiptUnitProgressionSnapshot,
  marker: ReceiptUnitProgressionMarker,
): boolean {
  return (
    current.epochDigest === marker.epochDigest &&
    current.unitDigest === marker.unitDigest &&
    current.family === marker.family &&
    JSON.stringify(current.requiredOperations) ===
      JSON.stringify(marker.requiredOperations) &&
    JSON.stringify(current.resourceScopes) ===
      JSON.stringify(marker.resourceScopes)
  )
}

function unitDeclarationExtends(
  current: ReceiptUnitProgressionSnapshot,
  marker: ReceiptUnitProgressionMarker,
): boolean {
  if (
    current.epochDigest !== marker.epochDigest ||
    current.unitDigest !== marker.unitDigest ||
    current.family !== marker.family
  ) {
    return false
  }
  const nextOperations = new Set(marker.requiredOperations)
  if (
    current.requiredOperations.some(
      (operation) => !nextOperations.has(operation),
    )
  ) {
    return false
  }
  const nextScopes = new Map(
    marker.resourceScopes.map((scope) => [
      scope.operation,
      scope.resourceIdentity,
    ]),
  )
  if (
    ![...current.resourceScopes].every(
      (scope) => nextScopes.get(scope.operation) === scope.resourceIdentity,
    )
  ) {
    return false
  }
  return (
    current.pinnedOperationTargetIdentity === undefined ||
    current.pinnedOperationTargetIdentity ===
      marker.pinnedOperationTargetIdentity
  )
}

function foldProgressionMarker(
  marker: ReceiptProgressionMarker,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  return marker.target === 'epoch'
    ? applyEpochProgression(marker, context)
    : applyUnitProgression(marker, context)
}

function foldControlMarker(
  marker: ReceiptControlMarker,
  context: FoldContext,
): ReceiptReadbackFailureCategory | undefined {
  const scopeFailure = controlScopeFailure(marker, context)
  if (scopeFailure) return scopeFailure
  const markerIdentity = serializeMarker(marker)
  if (context.seenMarkers.has(markerIdentity)) return undefined
  if (marker.control === 'progression') {
    const identityFailure = progressionIdentityFailure(marker, context)
    if (identityFailure) return identityFailure
    context.seenMarkers.add(markerIdentity)
    return foldProgressionMarker(marker, context)
  }
  const mint = context.mintByReceipt.get(marker.receiptId)
  if (!mint) return 'control-before-mint'
  if (mint.canonical.source !== context.expectedSource)
    return 'receipt-mismatch'
  context.seenMarkers.add(markerIdentity)
  return foldConsumeMarker(marker, context)
}

export function foldReceiptReadback(
  inputs: readonly unknown[],
  expectation: ReceiptReadbackExpectation,
): ReceiptReadbackResult {
  if (inputs.length > MAX_MARKERS) return rejected('malformed')
  const expected = validateExpectation(expectation)
  if (!expected) return rejected('malformed')

  const context: FoldContext = {
    expectation,
    expectedSource: expected.source,
    expectedSalt: expected.salt,
    mintByReceipt: new Map(),
    consumedByReceipt: new Map(),
    progression: { epoch: null, unit: null },
    seenMarkers: new Set(),
  }

  for (const input of inputs) {
    const validation = validateReceiptMarker(input)
    if (validation.status !== 'valid') return rejected(validation.category)
    const marker = cloneMarker(validation.marker)
    const failure =
      marker.kind === 'mint'
        ? foldMintMarker(marker, context)
        : foldControlMarker(marker, context)
    if (failure) return rejected(failure)
  }

  const receipts = [...context.mintByReceipt.entries()].map(
    ([receiptId, envelope]) => {
      const consumed = context.consumedByReceipt.has(receiptId)
      const copy = cloneEnvelope(envelope)
      if (consumed) copy.canonical.consumption = 'consumed'
      return copy
    },
  )

  return {
    status: 'reconstructed',
    state: {
      registrationDigest: expectation.registrationDigest,
      receipts,
      progression: context.progression,
    },
  }
}

export function receiptReadbackExpectationFromMetadata(
  metadata: ReceiptLedgerMetadata,
  sessionSalt: Uint8Array,
  operationTargetIdentity?: string,
): ReceiptReadbackExpectation {
  return {
    registrationDigest: metadata.registrationDigest,
    capabilityFlags: [...metadata.capabilityFlags],
    sessionSalt: new Uint8Array(sessionSalt),
    source: 'runtime-verified',
    operationTargetIdentity,
  }
}
