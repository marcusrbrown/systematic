const CAPABILITY_SNAPSHOT_SCHEMA_VERSION = 'cli-capabilities.v1' as const
const CAPABILITY_SNAPSHOT_COMMAND = 'systematic capabilities' as const

const CAPABILITY_SOURCE_IDS = [
  'config:custom',
  'config:global',
  'config:project',
  'config:user',
  'discovery:agents',
  'discovery:skills',
  'host:runtime',
  'package',
] as const

const CONFIG_SOURCE_KINDS = ['custom', 'project', 'user'] as const

const CONFIG_AUTHORITY_FIELD_PATHS = [
  'bootstrap.enabled',
  'bootstrap.file',
  'skills_as_commands',
  'workflow_guard.debug',
  'workflow_guard.mode',
] as const

const CONFIG_PROTECTED_FIELD_PATHS = [
  'workflow_guard',
  'agents.*.model',
  'agents.*.permission',
  'agents.*.skills',
  'agents.*.variant',
  'categories.*.model',
  'categories.*.permission',
  'categories.*.skills',
  'categories.*.variant',
] as const

const CONFIG_SOURCE_ERROR_CODES = [
  'parse-failed',
  'read-failed',
  'schema-invalid',
  'source-invalid',
] as const

const CONFIG_SOURCE_KIND_SET = new Set<string>(CONFIG_SOURCE_KINDS)
const CONFIG_AUTHORITY_FIELD_PATH_SET = new Set<string>(
  CONFIG_AUTHORITY_FIELD_PATHS,
)
const CONFIG_PROTECTED_FIELD_PATH_SET = new Set<string>(
  CONFIG_PROTECTED_FIELD_PATHS,
)
const CONFIG_SOURCE_ERROR_CODE_SET = new Set<string>(CONFIG_SOURCE_ERROR_CODES)

const CAPABILITY_SOURCE_PRESENCE = ['absent', 'invalid', 'present'] as const

const CAPABILITY_STATUSES = ['available', 'unknown', 'unavailable'] as const

const CAPABILITY_FACT_IDS = [
  'config-authority',
  'config-field-authority',
  'config-protected-field',
  'discovery-summary',
  'discovery-source-issue',
  'host-runtime',
] as const

const CAPABILITY_DISCOVERY_IDS = ['agents', 'skills'] as const

const CAPABILITY_LIMITATION_CODES = [
  'authority-unproven',
  'discovery-not-collected',
  'host-runtime-unobservable',
] as const

const CAPABILITY_ERROR_CODES = [
  'source-malformed',
  'source-read-failed',
  'source-unsupported',
  'structural-invalid',
] as const

const CAPABILITY_ROOT_IDS = [
  'agents',
  'cwd',
  'global',
  'package',
  'project',
  'skills',
  'user',
  'workspace',
] as const

type CapabilitySourceId = (typeof CAPABILITY_SOURCE_IDS)[number]
type ConfigSourceKind = (typeof CONFIG_SOURCE_KINDS)[number]
type ConfigAuthorityFieldPath = (typeof CONFIG_AUTHORITY_FIELD_PATHS)[number]
type ConfigProtectedFieldPath = (typeof CONFIG_PROTECTED_FIELD_PATHS)[number]
type ConfigSourceErrorCode = (typeof CONFIG_SOURCE_ERROR_CODES)[number]
type CapabilitySourcePresence = (typeof CAPABILITY_SOURCE_PRESENCE)[number]
type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number]
type CapabilityFactId = (typeof CAPABILITY_FACT_IDS)[number]
type CapabilityStatusFactId = Exclude<
  CapabilityFactId,
  'discovery-source-issue' | 'discovery-summary'
>
type CapabilityDiscoveryIssueErrorCode = Extract<
  CapabilityErrorCode,
  'source-malformed' | 'source-read-failed'
>
type CapabilityDiscoveryId = (typeof CAPABILITY_DISCOVERY_IDS)[number]
type CapabilityLimitationCode = (typeof CAPABILITY_LIMITATION_CODES)[number]
type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number]
type CapabilityRootId = (typeof CAPABILITY_ROOT_IDS)[number] | string

interface CapabilityPackageIdentity {
  readonly name: string
  readonly version: string
}

interface CapabilityRootInput {
  readonly id: CapabilityRootId
  readonly path: string
}

interface CapabilitySourceInput {
  readonly sourceId: CapabilitySourceId
  readonly presence: CapabilitySourcePresence
  readonly sourceKind?: ConfigSourceKind
  readonly path?: string
  readonly errorCode?: CapabilityErrorCode
}

export type CapabilityFactInput =
  | {
      readonly factId: Exclude<
        CapabilityFactId,
        | 'config-field-authority'
        | 'config-protected-field'
        | 'discovery-source-issue'
        | 'discovery-summary'
      >
      readonly status: CapabilityStatus
      readonly sourceId?: CapabilitySourceId
      readonly limitationCode?: CapabilityLimitationCode
      readonly errorCode?: CapabilityErrorCode
    }
  | {
      readonly factId: 'config-field-authority'
      readonly fieldPath: ConfigAuthorityFieldPath
      readonly kind: 'authority'
      readonly sourceId: CapabilitySourceId
      readonly status: 'available'
    }
  | {
      readonly errorCode: CapabilityDiscoveryIssueErrorCode
      readonly factId: 'discovery-source-issue'
      readonly kind: 'status'
      readonly sourceId: 'discovery:skills'
      readonly status: 'unavailable'
    }
  | {
      readonly errorCode: CapabilityErrorCode
      readonly factId: 'discovery-summary'
      readonly kind?: 'status'
      readonly sourceId: CapabilitySourceId
      readonly status: 'unavailable'
    }
  | {
      readonly factId: 'config-protected-field'
      readonly fieldPath: ConfigProtectedFieldPath
      readonly kind: 'protection'
      readonly outcome: 'blocked'
      readonly sourceId: CapabilitySourceId
      readonly status: 'available'
    }
  | {
      readonly count: number
      readonly discoveryId: CapabilityDiscoveryId
      readonly factId: 'discovery-summary'
      readonly kind: 'discovery'
      readonly sourceId: CapabilitySourceId
      readonly status: 'available'
      readonly winningRoots: readonly string[]
    }

interface ConfigSourceMetadata {
  readonly errorCode?: ConfigSourceErrorCode
  readonly kind: ConfigSourceKind
  readonly path?: string
  readonly presence: CapabilitySourcePresence
}

interface ConfigAuthorityMetadata {
  readonly fieldPath: ConfigAuthorityFieldPath
  readonly sourceKind: ConfigSourceKind
}

interface ConfigProtectedFieldMetadata {
  readonly fieldPath: ConfigProtectedFieldPath
  readonly outcome: 'blocked'
  readonly sourceKind: ConfigSourceKind
}

export interface ConfigObservationMetadata {
  readonly authorities: readonly ConfigAuthorityMetadata[]
  readonly protectedFields: readonly ConfigProtectedFieldMetadata[]
  readonly sources: readonly ConfigSourceMetadata[]
}

export type CapabilityClock = () => number | Date
export type CapabilityOutputSink = (serialized: string) => void

interface CapabilitySnapshotBuilderOptions {
  readonly argv: readonly string[]
  readonly package: CapabilityPackageIdentity
  readonly roots: readonly CapabilityRootInput[]
  readonly sources?: readonly CapabilitySourceInput[]
  readonly facts?: readonly CapabilityFactInput[]
  readonly config?: ConfigObservationMetadata
  readonly observedAt?: string
  readonly clock?: CapabilityClock
  readonly outputSink?: CapabilityOutputSink
}

interface CapabilitySnapshotArgvIdentity {
  readonly executable: string
  readonly subcommand: 'capabilities'
}

interface CapabilitySnapshotIdentity {
  readonly argv: CapabilitySnapshotArgvIdentity
  readonly package: CapabilityPackageIdentity
}

interface CapabilitySnapshotRoot {
  readonly id: string
}

interface CapabilitySnapshotSource {
  readonly errorCode?: CapabilityErrorCode
  readonly kind: 'source'
  readonly presence: CapabilitySourcePresence
  readonly sourceId: CapabilitySourceId
  readonly sourceKind?: ConfigSourceKind
}

type CapabilitySnapshotFact =
  | {
      readonly factId: CapabilityStatusFactId
      readonly kind: 'status'
      readonly status: 'available'
    }
  | {
      readonly factId: CapabilityStatusFactId
      readonly kind: 'status'
      readonly limitationCode: CapabilityLimitationCode
      readonly status: 'unknown'
    }
  | {
      readonly errorCode: CapabilityErrorCode
      readonly factId: CapabilityStatusFactId
      readonly kind: 'status'
      readonly sourceId?: CapabilitySourceId
      readonly status: 'unavailable'
    }
  | {
      readonly errorCode: CapabilityErrorCode
      readonly factId: 'discovery-summary'
      readonly kind: 'status'
      readonly sourceId: CapabilitySourceId
      readonly status: 'unavailable'
    }
  | {
      readonly errorCode: CapabilityDiscoveryIssueErrorCode
      readonly factId: 'discovery-source-issue'
      readonly kind: 'status'
      readonly sourceId: 'discovery:skills'
      readonly status: 'unavailable'
    }
  | {
      readonly factId: 'config-field-authority'
      readonly fieldPath: ConfigAuthorityFieldPath
      readonly kind: 'authority'
      readonly sourceId: CapabilitySourceId
      readonly status: 'available'
    }
  | {
      readonly factId: 'config-protected-field'
      readonly fieldPath: ConfigProtectedFieldPath
      readonly kind: 'protection'
      readonly outcome: 'blocked'
      readonly sourceId: CapabilitySourceId
      readonly status: 'available'
    }
  | {
      readonly count: number
      readonly discoveryId: CapabilityDiscoveryId
      readonly factId: 'discovery-summary'
      readonly kind: 'discovery'
      readonly sourceId: CapabilitySourceId
      readonly status: 'available'
      readonly winningRoots: readonly string[]
    }

interface CapabilitySnapshot {
  readonly command: typeof CAPABILITY_SNAPSHOT_COMMAND
  readonly facts: readonly CapabilitySnapshotFact[]
  readonly identity: CapabilitySnapshotIdentity
  readonly observedAt: string
  readonly roots: readonly CapabilitySnapshotRoot[]
  readonly schemaVersion: typeof CAPABILITY_SNAPSHOT_SCHEMA_VERSION
  readonly sources: readonly CapabilitySnapshotSource[]
}

const CAPABILITY_SOURCE_ID_SET = new Set<string>(CAPABILITY_SOURCE_IDS)
const CAPABILITY_SOURCE_PRESENCE_SET = new Set<string>(
  CAPABILITY_SOURCE_PRESENCE,
)
const CAPABILITY_STATUS_SET = new Set<string>(CAPABILITY_STATUSES)
const CAPABILITY_FACT_ID_SET = new Set<string>(CAPABILITY_FACT_IDS)
const CAPABILITY_DISCOVERY_ID_SET = new Set<string>(CAPABILITY_DISCOVERY_IDS)
const CAPABILITY_LIMITATION_CODE_SET = new Set<string>(
  CAPABILITY_LIMITATION_CODES,
)
const CAPABILITY_ERROR_CODE_SET = new Set<string>(CAPABILITY_ERROR_CODES)

const MAX_DISPLAY_ID_LENGTH = 128
const MAX_PACKAGE_NAME_LENGTH = 128
const MAX_PACKAGE_VERSION_LENGTH = 64
const MAX_DISCOVERY_COUNT = 100_000
const MAX_DISCOVERY_ROOTS = 32

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new TypeError(`${label} has unknown key ${key}`)
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}

function assertEnum<T extends string>(
  value: unknown,
  values: ReadonlySet<string>,
  label: string,
): asserts value is T {
  if (typeof value !== 'string' || !values.has(value)) {
    throw new TypeError(`${label} is not an allowed value`)
  }
}

function normalizeDisplayId(value: string, label: string): string {
  assertString(value, label)
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
  if (
    normalized.length > MAX_DISPLAY_ID_LENGTH ||
    normalized.startsWith('/') ||
    normalized.includes('..') ||
    !/^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/.test(normalized)
  ) {
    throw new TypeError(`${label} must be a bounded relative display ID`)
  }
  return normalized
}

function normalizePackageName(value: string): string {
  assertString(value, 'package.name')
  if (
    value.length > MAX_PACKAGE_NAME_LENGTH ||
    !/^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(value)
  ) {
    throw new TypeError('package.name is not an allowed package identity')
  }
  return value
}

function normalizePackageVersion(value: string): string {
  assertString(value, 'package.version')
  if (
    value.length > MAX_PACKAGE_VERSION_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(value)
  ) {
    throw new TypeError('package.version is not an allowed version identity')
  }
  return value
}

function normalizeExecutable(value: string): string {
  assertString(value, 'argv[0]')
  const segments = value.replaceAll('\\', '/').split('/')
  const executable = segments.at(-1) ?? ''
  if (
    executable.length === 0 ||
    executable.length > MAX_DISPLAY_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/.test(executable)
  ) {
    throw new TypeError('argv[0] is not an allowed executable identity')
  }
  return executable
}

function normalizeArgv(
  argv: readonly string[],
): CapabilitySnapshotArgvIdentity {
  if (argv.length < 2) {
    throw new TypeError(
      'argv must include an executable and capabilities command',
    )
  }
  const executable = normalizeExecutable(argv[0] ?? '')
  if (argv[1] !== 'capabilities') {
    throw new TypeError('argv must identify the capabilities command')
  }
  return {
    executable,
    subcommand: 'capabilities',
  }
}

function canonicalizePath(value: string): string {
  assertString(value, 'root.path')
  const normalizedSeparators = value.replaceAll('\\', '/')
  const absolute = normalizedSeparators.startsWith('/')
  const segments: string[] = []
  for (const segment of normalizedSeparators.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') segments.pop()
      else if (!absolute) segments.push(segment)
      continue
    }
    segments.push(segment)
  }
  const joined = segments.join('/')
  return absolute ? `/${joined}` : joined
}

function normalizeObservedAt(
  options: CapabilitySnapshotBuilderOptions,
): string {
  const observedAt = options.observedAt
  if (observedAt !== undefined) {
    assertString(observedAt, 'observedAt')
    const parsed = new Date(observedAt)
    if (Number.isNaN(parsed.getTime())) {
      throw new TypeError('observedAt must be a valid timestamp')
    }
    return parsed.toISOString()
  }

  const now = options.clock?.() ?? Date.now()
  const timestamp = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError('clock must return a valid timestamp')
  }
  return timestamp.toISOString()
}

function normalizePackage(
  value: CapabilityPackageIdentity,
): CapabilityPackageIdentity {
  assertRecord(value, 'package')
  assertAllowedKeys(value, ['name', 'version'], 'package')
  return {
    name: normalizePackageName(value.name),
    version: normalizePackageVersion(value.version),
  }
}

function normalizeRoots(
  roots: readonly CapabilityRootInput[],
): readonly CapabilitySnapshotRoot[] {
  const normalized = roots.map((root, index) => {
    assertRecord(root, `roots[${index}]`)
    assertAllowedKeys(root, ['id', 'path'], `roots[${index}]`)
    const id = normalizeDisplayId(root.id, `roots[${index}].id`)
    const path = canonicalizePath(root.path)
    return { id, path }
  })

  normalized.sort((left, right) => {
    const pathOrder = compareText(left.path, right.path)
    return pathOrder !== 0 ? pathOrder : compareText(left.id, right.id)
  })

  const unique: CapabilitySnapshotRoot[] = []
  let previousPath: string | undefined
  for (const root of normalized) {
    if (root.path === previousPath) continue
    previousPath = root.path
    unique.push({ id: root.id })
  }
  unique.sort((left, right) => compareText(left.id, right.id))
  return unique
}

function normalizeSources(
  sources: readonly CapabilitySourceInput[],
): readonly CapabilitySnapshotSource[] {
  const normalized = sources.map(normalizeSource)

  normalized.sort(compareSources)

  const unique: Array<
    CapabilitySnapshotSource & { readonly canonicalPath?: string }
  > = []
  const seen = new Set<string>()
  for (const source of normalized) {
    const key = source.canonicalPath ?? `source:${source.sourceId}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(source)
  }
  unique.sort((left, right) => compareText(left.sourceId, right.sourceId))
  return unique.map(({ canonicalPath: _canonicalPath, ...source }) => source)
}

function compareSources(
  left: CapabilitySnapshotSource & { readonly canonicalPath?: string },
  right: CapabilitySnapshotSource & { readonly canonicalPath?: string },
): number {
  const pathOrder = compareText(
    left.canonicalPath ?? '',
    right.canonicalPath ?? '',
  )
  if (pathOrder !== 0) return pathOrder
  const sourceOrder = compareText(left.sourceId, right.sourceId)
  if (sourceOrder !== 0) return sourceOrder
  return compareText(left.presence, right.presence)
}

function normalizeSource(
  source: CapabilitySourceInput,
  index: number,
): CapabilitySnapshotSource & { readonly canonicalPath?: string } {
  assertRecord(source, `sources[${index}]`)
  assertAllowedKeys(
    source,
    ['errorCode', 'path', 'presence', 'sourceId', 'sourceKind'],
    `sources[${index}]`,
  )
  assertEnum<CapabilitySourceId>(
    source.sourceId,
    CAPABILITY_SOURCE_ID_SET,
    `sources[${index}].sourceId`,
  )
  assertEnum<CapabilitySourcePresence>(
    source.presence,
    CAPABILITY_SOURCE_PRESENCE_SET,
    `sources[${index}].presence`,
  )
  assertSourceKind(source, index)
  const canonicalPath =
    source.path === undefined ? undefined : canonicalizePath(source.path)
  if (source.presence === 'invalid') {
    assertEnum<CapabilityErrorCode>(
      source.errorCode,
      CAPABILITY_ERROR_CODE_SET,
      `sources[${index}].errorCode`,
    )
    return {
      errorCode: source.errorCode,
      kind: 'source',
      presence: source.presence,
      sourceId: source.sourceId,
      ...(source.sourceKind === undefined
        ? {}
        : { sourceKind: source.sourceKind }),
      canonicalPath,
    }
  }
  if (source.errorCode !== undefined) {
    throw new TypeError(
      `sources[${index}].errorCode is only valid for invalid sources`,
    )
  }
  return {
    kind: 'source',
    presence: source.presence,
    sourceId: source.sourceId,
    ...(source.sourceKind === undefined
      ? {}
      : { sourceKind: source.sourceKind }),
    canonicalPath,
  }
}

function assertSourceKind(source: CapabilitySourceInput, index: number): void {
  if (source.sourceKind === undefined) return
  assertEnum<ConfigSourceKind>(
    source.sourceKind,
    CONFIG_SOURCE_KIND_SET,
    `sources[${index}].sourceKind`,
  )
  if (source.sourceId !== configSourceId(source.sourceKind)) {
    throw new TypeError(`sources[${index}].sourceKind does not match sourceId`)
  }
}

function configSourceId(sourceKind: ConfigSourceKind): CapabilitySourceId {
  return `config:${sourceKind}` as CapabilitySourceId
}

function configErrorCode(
  errorCode: ConfigSourceErrorCode,
): CapabilityErrorCode {
  return errorCode === 'read-failed' ? 'source-read-failed' : 'source-malformed'
}

function normalizeConfigObservation(config: ConfigObservationMetadata): {
  readonly facts: readonly CapabilityFactInput[]
  readonly sources: readonly CapabilitySourceInput[]
} {
  assertRecord(config, 'config')
  assertAllowedKeys(
    config,
    ['authorities', 'protectedFields', 'sources'],
    'config',
  )
  if (!Array.isArray(config.sources)) {
    throw new TypeError('config.sources must be an array')
  }
  if (!Array.isArray(config.authorities)) {
    throw new TypeError('config.authorities must be an array')
  }
  if (!Array.isArray(config.protectedFields)) {
    throw new TypeError('config.protectedFields must be an array')
  }

  const sources = config.sources.map((source, index) => {
    assertRecord(source, `config.sources[${index}]`)
    assertAllowedKeys(
      source,
      ['errorCode', 'kind', 'path', 'presence'],
      `config.sources[${index}]`,
    )
    assertEnum<ConfigSourceKind>(
      source.kind,
      CONFIG_SOURCE_KIND_SET,
      `config.sources[${index}].kind`,
    )
    assertEnum<CapabilitySourcePresence>(
      source.presence,
      CAPABILITY_SOURCE_PRESENCE_SET,
      `config.sources[${index}].presence`,
    )
    const pathValue = source.path
    if (pathValue !== undefined) {
      assertString(pathValue, `config.sources[${index}].path`)
      canonicalizePath(pathValue)
    }
    if (source.errorCode !== undefined) {
      assertEnum<ConfigSourceErrorCode>(
        source.errorCode,
        CONFIG_SOURCE_ERROR_CODE_SET,
        `config.sources[${index}].errorCode`,
      )
    }
    return {
      ...(source.errorCode === undefined
        ? {}
        : { errorCode: configErrorCode(source.errorCode) }),
      ...(pathValue === undefined ? {} : { path: pathValue }),
      presence: source.presence,
      sourceId: configSourceId(source.kind),
      sourceKind: source.kind,
    }
  })

  const facts: CapabilityFactInput[] = []
  for (const source of sources) {
    if (source.presence !== 'invalid' || source.errorCode === undefined)
      continue
    facts.push({
      errorCode: source.errorCode,
      factId: 'config-authority',
      sourceId: source.sourceId,
      status: 'unavailable',
    })
  }
  config.authorities.forEach((authority, index) => {
    assertRecord(authority, `config.authorities[${index}]`)
    assertAllowedKeys(
      authority,
      ['fieldPath', 'sourceKind'],
      `config.authorities[${index}]`,
    )
    assertEnum<ConfigAuthorityFieldPath>(
      authority.fieldPath,
      CONFIG_AUTHORITY_FIELD_PATH_SET,
      `config.authorities[${index}].fieldPath`,
    )
    assertEnum<ConfigSourceKind>(
      authority.sourceKind,
      CONFIG_SOURCE_KIND_SET,
      `config.authorities[${index}].sourceKind`,
    )
    facts.push({
      factId: 'config-field-authority',
      fieldPath: authority.fieldPath,
      kind: 'authority',
      sourceId: configSourceId(authority.sourceKind),
      status: 'available',
    })
  })

  config.protectedFields.forEach((protectedField, index) => {
    assertRecord(protectedField, `config.protectedFields[${index}]`)
    assertAllowedKeys(
      protectedField,
      ['fieldPath', 'outcome', 'sourceKind'],
      `config.protectedFields[${index}]`,
    )
    assertEnum<ConfigProtectedFieldPath>(
      protectedField.fieldPath,
      CONFIG_PROTECTED_FIELD_PATH_SET,
      `config.protectedFields[${index}].fieldPath`,
    )
    assertEnum<ConfigSourceKind>(
      protectedField.sourceKind,
      CONFIG_SOURCE_KIND_SET,
      `config.protectedFields[${index}].sourceKind`,
    )
    if (protectedField.outcome !== 'blocked') {
      throw new TypeError(
        `config.protectedFields[${index}].outcome must be blocked`,
      )
    }
    facts.push({
      factId: 'config-protected-field',
      fieldPath: protectedField.fieldPath,
      kind: 'protection',
      outcome: 'blocked',
      sourceId: configSourceId(protectedField.sourceKind),
      status: 'available',
    })
  })

  return { facts, sources }
}

function normalizeFact(value: unknown, label: string): CapabilitySnapshotFact {
  assertRecord(value, label)
  assertAllowedKeys(
    value,
    [
      'errorCode',
      'factId',
      'fieldPath',
      'kind',
      'limitationCode',
      'outcome',
      'sourceId',
      'status',
      'count',
      'discoveryId',
      'winningRoots',
    ],
    label,
  )
  assertEnum<CapabilityFactId>(
    value.factId,
    CAPABILITY_FACT_ID_SET,
    `${label}.factId`,
  )

  if (value.factId === 'config-field-authority') {
    return normalizeAuthorityFact(value, label)
  }
  if (value.factId === 'config-protected-field') {
    return normalizeProtectionFact(value, label)
  }
  if (value.factId === 'discovery-summary') {
    return normalizeDiscoveryFact(value, label)
  }
  if (value.factId === 'discovery-source-issue') {
    return normalizeDiscoverySourceIssueFact(value, label)
  }
  return normalizeStatusFact(value, label)
}

function normalizeAuthorityFact(
  value: Record<string, unknown>,
  label: string,
): CapabilitySnapshotFact {
  assertNoDiscoveryFields(value, label)
  assertEnum<ConfigAuthorityFieldPath>(
    value.fieldPath,
    CONFIG_AUTHORITY_FIELD_PATH_SET,
    `${label}.fieldPath`,
  )
  if (value.kind !== 'authority') {
    throw new TypeError(`${label}.kind must be authority`)
  }
  assertAvailableFactSource(value, label)
  return {
    factId: 'config-field-authority',
    fieldPath: value.fieldPath,
    kind: 'authority',
    sourceId: value.sourceId,
    status: 'available',
  }
}

function normalizeProtectionFact(
  value: Record<string, unknown>,
  label: string,
): CapabilitySnapshotFact {
  assertNoDiscoveryFields(value, label)
  assertEnum<ConfigProtectedFieldPath>(
    value.fieldPath,
    CONFIG_PROTECTED_FIELD_PATH_SET,
    `${label}.fieldPath`,
  )
  if (value.kind !== 'protection') {
    throw new TypeError(`${label}.kind must be protection`)
  }
  if (value.outcome !== 'blocked') {
    throw new TypeError(`${label}.outcome must be blocked`)
  }
  assertAvailableFactSource(value, label)
  return {
    factId: 'config-protected-field',
    fieldPath: value.fieldPath,
    kind: 'protection',
    outcome: 'blocked',
    sourceId: value.sourceId,
    status: 'available',
  }
}

function assertAvailableFactSource(
  value: Record<string, unknown>,
  label: string,
): asserts value is Record<string, unknown> & {
  readonly sourceId: CapabilitySourceId
} {
  assertEnum<CapabilitySourceId>(
    value.sourceId,
    CAPABILITY_SOURCE_ID_SET,
    `${label}.sourceId`,
  )
  if (value.status !== 'available') {
    throw new TypeError(`${label}.status must be available`)
  }
}

function normalizeStatusFact(
  value: Record<string, unknown>,
  label: string,
): CapabilitySnapshotFact {
  assertNoDiscoveryFields(value, label)
  if (value.kind !== undefined && value.kind !== 'status') {
    throw new TypeError(`${label}.kind must be status`)
  }
  assertEnum<CapabilityStatus>(
    value.status,
    CAPABILITY_STATUS_SET,
    `${label}.status`,
  )
  if (value.sourceId !== undefined) {
    assertEnum<CapabilitySourceId>(
      value.sourceId,
      CAPABILITY_SOURCE_ID_SET,
      `${label}.sourceId`,
    )
  }

  switch (value.status) {
    case 'available':
      return normalizeAvailableFact(value, label)
    case 'unknown':
      return normalizeUnknownFact(value, label)
    case 'unavailable':
      return normalizeUnavailableFact(value, label)
  }
}

function assertNoDiscoveryFields(
  value: Record<string, unknown>,
  label: string,
): void {
  if (
    value.count !== undefined ||
    value.discoveryId !== undefined ||
    value.winningRoots !== undefined
  ) {
    throw new TypeError(`${label} discovery fields require discovery kind`)
  }
}

function normalizeDiscoveryFact(
  value: Record<string, unknown>,
  label: string,
): CapabilitySnapshotFact {
  if (value.status === 'unavailable') {
    return normalizeUnavailableDiscoveryFact(value, label)
  }

  if (value.status !== 'available') {
    throw new TypeError(`${label}.status must be available or unavailable`)
  }
  assertAvailableDiscoveryFact(value, label)
  assertEnum<CapabilityDiscoveryId>(
    value.discoveryId,
    CAPABILITY_DISCOVERY_ID_SET,
    `${label}.discoveryId`,
  )
  const expectedSourceId = `discovery:${value.discoveryId}`
  if (value.sourceId !== expectedSourceId) {
    throw new TypeError(`${label}.sourceId does not match discoveryId`)
  }
  assertEnum<CapabilitySourceId>(
    value.sourceId,
    CAPABILITY_SOURCE_ID_SET,
    `${label}.sourceId`,
  )
  const count = value.count
  if (
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > MAX_DISCOVERY_COUNT
  ) {
    throw new TypeError(`${label}.count must be a bounded integer`)
  }
  if (!Array.isArray(value.winningRoots)) {
    throw new TypeError(`${label}.winningRoots must be an array`)
  }
  if (value.winningRoots.length > MAX_DISCOVERY_ROOTS) {
    throw new TypeError(`${label}.winningRoots exceeds the bounded limit`)
  }
  const winningRoots = value.winningRoots.map((root, index) => {
    assertString(root, `${label}.winningRoots[${index}]`)
    return normalizeDisplayId(root, `${label}.winningRoots[${index}]`)
  })
  winningRoots.sort(compareText)
  return {
    count,
    discoveryId: value.discoveryId,
    factId: 'discovery-summary',
    kind: 'discovery',
    sourceId: value.sourceId,
    status: 'available',
    winningRoots: [...new Set(winningRoots)],
  }
}

function normalizeDiscoverySourceIssueFact(
  value: Record<string, unknown>,
  label: string,
): CapabilitySnapshotFact {
  if (value.kind !== 'status') {
    throw new TypeError(`${label}.kind must be status`)
  }
  if (value.status !== 'unavailable') {
    throw new TypeError(`${label}.status must be unavailable`)
  }
  if (value.sourceId !== 'discovery:skills') {
    throw new TypeError(`${label}.sourceId must be discovery:skills`)
  }
  if (
    value.errorCode !== 'source-malformed' &&
    value.errorCode !== 'source-read-failed'
  ) {
    throw new TypeError(`${label}.errorCode is not a discovery source error`)
  }
  if (
    value.count !== undefined ||
    value.discoveryId !== undefined ||
    value.fieldPath !== undefined ||
    value.limitationCode !== undefined ||
    value.outcome !== undefined ||
    value.winningRoots !== undefined
  ) {
    throw new TypeError(`${label} has invalid discovery source issue fields`)
  }
  return {
    errorCode: value.errorCode,
    factId: 'discovery-source-issue',
    kind: 'status',
    sourceId: 'discovery:skills',
    status: 'unavailable',
  }
}

function normalizeUnavailableDiscoveryFact(
  value: Record<string, unknown>,
  label: string,
): CapabilitySnapshotFact {
  if (value.kind !== undefined && value.kind !== 'status') {
    throw new TypeError(`${label}.kind must be status`)
  }
  if (value.sourceId === undefined) {
    throw new TypeError(`${label}.sourceId is required`)
  }
  if (
    value.count !== undefined ||
    value.discoveryId !== undefined ||
    value.winningRoots !== undefined
  ) {
    throw new TypeError(`${label} unavailable discovery fields are invalid`)
  }
  assertEnum<CapabilitySourceId>(
    value.sourceId,
    CAPABILITY_SOURCE_ID_SET,
    `${label}.sourceId`,
  )
  return normalizeUnavailableFact(value, label)
}

function assertAvailableDiscoveryFact(
  value: Record<string, unknown>,
  label: string,
): void {
  if (value.kind !== 'discovery') {
    throw new TypeError(`${label}.kind must be discovery`)
  }
  if (
    value.errorCode !== undefined ||
    value.limitationCode !== undefined ||
    value.outcome !== undefined
  ) {
    throw new TypeError(`${label} available discovery fields are invalid`)
  }
}

function normalizeAvailableFact(
  value: Record<string, unknown>,
  label: string,
): CapabilitySnapshotFact {
  if (value.sourceId !== undefined || value.errorCode !== undefined) {
    throw new TypeError(
      `${label} available facts cannot include source or error metadata`,
    )
  }
  if (value.limitationCode !== undefined) {
    throw new TypeError(`${label} available facts cannot include a limitation`)
  }
  return {
    factId: value.factId as CapabilityStatusFactId,
    kind: 'status',
    status: 'available',
  }
}

function normalizeUnknownFact(
  value: Record<string, unknown>,
  label: string,
): CapabilitySnapshotFact {
  assertEnum<CapabilityLimitationCode>(
    value.limitationCode,
    CAPABILITY_LIMITATION_CODE_SET,
    `${label}.limitationCode`,
  )
  if (value.sourceId !== undefined || value.errorCode !== undefined) {
    throw new TypeError(
      `${label} unknown facts cannot include source or error metadata`,
    )
  }
  return {
    factId: value.factId as CapabilityStatusFactId,
    kind: 'status',
    limitationCode: value.limitationCode,
    status: 'unknown',
  }
}

function normalizeUnavailableFact(
  value: Record<string, unknown>,
  label: string,
): CapabilitySnapshotFact {
  assertEnum<CapabilityErrorCode>(
    value.errorCode,
    CAPABILITY_ERROR_CODE_SET,
    `${label}.errorCode`,
  )
  if (value.limitationCode !== undefined) {
    throw new TypeError(
      `${label} unavailable facts cannot include a limitation`,
    )
  }
  return {
    errorCode: value.errorCode,
    factId: value.factId as CapabilityStatusFactId,
    kind: 'status',
    ...(value.sourceId === undefined
      ? {}
      : { sourceId: value.sourceId as CapabilitySourceId }),
    status: 'unavailable',
  }
}

function normalizeFacts(
  facts: readonly unknown[],
): readonly CapabilitySnapshotFact[] {
  const normalized = facts.map((fact, index) =>
    normalizeFact(fact, `facts[${index}]`),
  )

  normalized.sort(compareFacts)
  return normalized
}

function compareFacts(
  left: CapabilitySnapshotFact,
  right: CapabilitySnapshotFact,
): number {
  const factOrder = compareText(left.factId, right.factId)
  if (factOrder !== 0) return factOrder
  const fieldOrder = compareText(
    factField(left, 'fieldPath'),
    factField(right, 'fieldPath'),
  )
  if (fieldOrder !== 0) return fieldOrder
  const statusOrder = compareText(left.status, right.status)
  if (statusOrder !== 0) return statusOrder
  const sourceOrder = compareText(
    factField(left, 'sourceId'),
    factField(right, 'sourceId'),
  )
  if (sourceOrder !== 0) return sourceOrder
  const discoveryOrder = compareText(
    factField(left, 'discoveryId'),
    factField(right, 'discoveryId'),
  )
  if (discoveryOrder !== 0) return discoveryOrder
  return compareText(
    factField(left, 'errorCode'),
    factField(right, 'errorCode'),
  )
}

function factField(
  fact: CapabilitySnapshotFact,
  field: 'discoveryId' | 'errorCode' | 'fieldPath' | 'sourceId',
): string {
  if (field === 'discoveryId' && 'discoveryId' in fact) return fact.discoveryId
  if (field === 'errorCode' && 'errorCode' in fact) return fact.errorCode
  if (field === 'fieldPath' && 'fieldPath' in fact) return fact.fieldPath
  if (field === 'sourceId' && 'sourceId' in fact) return fact.sourceId ?? ''
  return ''
}

export function buildCapabilitySnapshot(
  options: CapabilitySnapshotBuilderOptions,
): CapabilitySnapshot {
  assertRecord(options, 'options')
  assertAllowedKeys(
    options,
    [
      'argv',
      'clock',
      'config',
      'facts',
      'observedAt',
      'outputSink',
      'package',
      'roots',
      'sources',
    ],
    'options',
  )
  if (!Array.isArray(options.argv)) throw new TypeError('argv must be an array')
  if (!Array.isArray(options.roots))
    throw new TypeError('roots must be an array')
  if (options.sources !== undefined && !Array.isArray(options.sources)) {
    throw new TypeError('sources must be an array')
  }
  if (options.facts !== undefined && !Array.isArray(options.facts)) {
    throw new TypeError('facts must be an array')
  }

  const configObservation = options.config
    ? normalizeConfigObservation(options.config)
    : { facts: [], sources: [] }

  const snapshot: CapabilitySnapshot = {
    command: CAPABILITY_SNAPSHOT_COMMAND,
    facts: normalizeFacts([
      ...(options.facts ?? []),
      ...configObservation.facts,
    ]),
    identity: {
      argv: normalizeArgv(options.argv),
      package: normalizePackage(options.package),
    },
    observedAt: normalizeObservedAt(options),
    roots: normalizeRoots(options.roots),
    schemaVersion: CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    sources: normalizeSources([
      ...(options.sources ?? []),
      ...configObservation.sources,
    ]),
  }

  const serialized = JSON.stringify(snapshot)
  options.outputSink?.(serialized)
  return snapshot
}

export function serializeCapabilitySnapshot(
  snapshot: CapabilitySnapshot,
): string {
  return JSON.stringify(snapshot)
}
