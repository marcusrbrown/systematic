import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const CASE_SCHEMA_VERSION = 1 as const
const RESULT_SCHEMA_VERSION = 1 as const
export const RUN_MANIFEST_SCHEMA_VERSION = 1 as const
const HARNESS = 'opencode' as const

export { CASE_SCHEMA_VERSION, HARNESS, RESULT_SCHEMA_VERSION }

export const CASE_IDS = [
  'bootstrap-loading',
  'fixture-local-write',
  'host-skill-coverage',
  'model-inheritance',
] as const

export type CaseId = (typeof CASE_IDS)[number]

export const MODES = ['source', 'installed'] as const
export type EvalMode = (typeof MODES)[number]

export const OUTCOMES = [
  'success',
  'infra_failure',
  'task_failure',
  'privacy_cleanup_failure',
] as const
export type EvalOutcome = (typeof OUTCOMES)[number]

export const OUTCOME_SUBCODES = {
  success: ['none'],
  infra_failure: [
    'identity_drift',
    'probe_unhealthy',
    'artifact_resolution',
    'opencode_unavailable',
    'path_escape',
    'primary_checkout_delta',
    'case_setup',
  ],
  task_failure: [
    'bootstrap_not_observed',
    'host_catalog_absent',
    'host_catalog_incomplete',
    'write_missing',
    'write_mismatch',
    'unexpected_exit',
    'model_policy_mismatch',
  ],
  privacy_cleanup_failure: [
    'redaction_failed',
    'residue_detected',
    'quarantine_failed',
    'atomic_write_failed',
  ],
} as const

export type EvalSubcode =
  (typeof OUTCOME_SUBCODES)[keyof typeof OUTCOME_SUBCODES][number]

export interface BootstrapLoadingCaseManifest {
  caseSchemaVersion: typeof CASE_SCHEMA_VERSION
  caseId: 'bootstrap-loading'
  harness: typeof HARNESS
  assertionIds: string[]
}

export interface FixtureLocalWriteCaseManifest {
  caseSchemaVersion: typeof CASE_SCHEMA_VERSION
  caseId: 'fixture-local-write'
  harness: typeof HARNESS
  assertionIds: string[]
  expectedArtifactId: string
  expectedContentId: string
}

export interface HostSkillCoverageCaseManifest {
  caseSchemaVersion: typeof CASE_SCHEMA_VERSION
  caseId: 'host-skill-coverage'
  harness: typeof HARNESS
  assertionIds: string[]
  /** Raw SKILL.md names; OpenCode's catalog does not add Systematic's prefix. */
  expectedSkillNames: string[]
}

export interface ModelInheritanceCaseManifest {
  caseSchemaVersion: typeof CASE_SCHEMA_VERSION
  caseId: 'model-inheritance'
  harness: typeof HARNESS
  assertionIds: string[]
  expectedAgentIds: string[]
  category: string
  categoryModel: string
  categoryVariant: string
  exactAgentId: string
  exactModel: string
  exactVariant: string
}

export type EvalCaseManifest =
  | BootstrapLoadingCaseManifest
  | FixtureLocalWriteCaseManifest
  | HostSkillCoverageCaseManifest
  | ModelInheritanceCaseManifest

export interface EvalIdentity {
  opencodeVersion: string
  opencodeBuildId: string
  probeId: string
  probeDigest: string
  fixtureContractVersion: number
  fixtureContractDigest: string
  caseSchemaVersion: typeof CASE_SCHEMA_VERSION
  resultSchemaVersion: typeof RESULT_SCHEMA_VERSION
  artifactId: string
  artifactDigest: string
}

export interface EvalEvidence {
  sanity: 'passed' | 'failed'
  process: 'completed' | 'failed'
  assertionIds: string[]
  promptComposition?: PromptCompositionObservation
  hostCatalogCoverage?: HostCatalogCoverageObservation
  modelInheritance?: ModelInheritanceObservation[]
}

export type PromptCatalogState = 'present' | 'absent' | 'impossible'

export interface PromptCatalogObservation {
  state: PromptCatalogState
  entryCount: number
  skillNames: string[]
}

export interface PromptCompositionObservation {
  bootstrapPayloadSize: number
  systematicCatalog: PromptCatalogObservation
  hostCatalog: PromptCatalogObservation
}

export interface HostCatalogCoverageObservation {
  state: PromptCatalogState
  expectedSkillNames: string[]
  observedSkillNames: string[]
  missingSkillNames: string[]
}

export type ModelAvailabilityPath = 'known' | 'unknown'
export type ModelInheritancePolicy =
  | 'none'
  | 'category'
  | 'exact'
  | 'null'
  | 'project-error'

export interface ModelAgentObservation {
  agentId: string
  modelPresent: boolean
  variantPresent: boolean
  model?: string
  variant?: string
}

export interface ModelInheritanceObservation {
  availability: ModelAvailabilityPath
  policy: ModelInheritancePolicy
  agents: ModelAgentObservation[]
}

export interface EvalCleanupState {
  status: 'clean' | 'residue' | 'quarantined'
  residue: 'none' | 'detected' | 'quarantined'
}

export interface EvalPrivacyState {
  status: 'validated' | 'rejected'
}

export interface SourceProvenance {
  kind: 'source'
  checkoutRelativeSource: string
  commitId: string
  worktreeId: string
  canonicalSourceEntryId: string
  opencodeConfigEntryId: string
}

export interface InstalledProvenance {
  kind: 'installed'
  packageName: string
  packageVersion: string
  tarballDigest: string
  extractedPackageRootId: string
  canonicalResolvedModuleEntryId: string
  opencodeConfigEntryId: string
}

export interface EvalResult {
  resultSchemaVersion: typeof RESULT_SCHEMA_VERSION
  caseSchemaVersion: typeof CASE_SCHEMA_VERSION
  caseId: CaseId
  harness: typeof HARNESS
  mode: EvalMode
  outcome: EvalOutcome
  subcode?: EvalSubcode
  runId: string
  fixtureSeed: string
  normalizedClock: string
  assertionIds: string[]
  identity: EvalIdentity
  evidence: EvalEvidence
  cleanup: EvalCleanupState
  privacy: EvalPrivacyState
  artifactRefs: string[]
  provenance: SourceProvenance | InstalledProvenance
}

export interface EvalCaseExecution {
  outcome: EvalOutcome
  subcode: EvalSubcode
  sanity: 'passed' | 'failed'
  process: 'completed' | 'failed'
  probeDigest: string
  artifactRefs: string[]
  promptComposition?: PromptCompositionObservation
  hostCatalogCoverage?: HostCatalogCoverageObservation
  modelInheritance?: ModelInheritanceObservation[]
}

export interface EvalFixture {
  mode: EvalMode
  runRoot: string
  caseRoot: string
  modeRoot: string
  projectRoot: string
  homeRoot: string
  xdgConfigRoot: string
  xdgDataRoot: string
  xdgCacheRoot: string
  xdgStateRoot: string
  opencodeConfigRoot: string
  opencodeConfigPath: string
  probeRoot: string
  npmCacheRoot: string
  npmPrefixRoot: string
  npmUserConfigPath: string
  artifactRoot: string
  tarballPath: string
  stagingRoot: string
  packageRoot: string
  provenanceRoot: string
  tmpRoot: string
}

interface ActiveEvalFixture {
  fixture: EvalFixture
  runId: string
  hooks?: EvalLifecycleHooks
  cleanupPromise?: Promise<CleanupResolution>
}

const activeEvalFixtures = new Map<EvalFixture, ActiveEvalFixture>()
const completedFixtureCleanups = new WeakMap<EvalFixture, CleanupResolution>()
let interruptionSignal: NodeJS.Signals | undefined
let interruptionCleanup: Promise<void> | undefined

function isEvalInterrupted(): boolean {
  return interruptionSignal !== undefined
}

export interface CreateEvalFixtureOptions {
  caseId: CaseId
  mode: EvalMode
  runId: string
  parentDir?: string
}

export interface ValidatedNpmTarEntry {
  path: string
  type: 'file' | 'directory'
  content: Uint8Array
}

export interface ValidatedNpmTarball {
  digest: string
  entries: readonly ValidatedNpmTarEntry[]
}

export interface InstalledPluginEntry {
  packageName: string
  packageVersion: string
  moduleEntry: string
  moduleEntryId: string
}

export interface InstalledArtifact extends InstalledPluginEntry {
  tarballPath: string
  tarballDigest: string
  packageRoot: string
  packageRootId: string
  configEntryId: string
}

export interface EvalChildEnvOptions {
  fixture: EvalFixture
  configContent: string
  modelBaseUrl: string
  parentEnv?: Readonly<Record<string, string | undefined>>
}

export interface PrimaryCheckoutIdentity {
  status: string
  sourceDigest: string
}

export interface ExactOpencodeRuntime {
  status: 'available' | 'unavailable' | 'mismatch'
  expectedVersion: string
  reportedVersion?: string
}

export interface SourceEvalOptions {
  caseId: CaseId
  fixtureSeed: string
  normalizedClock: string
  runId?: string
  parentDir?: string
  rootDir?: string
  timeoutMs?: number
  caseTimeoutMs?: number
  lifecycleHooks?: EvalLifecycleHooks
  reusableArtifact?: InstalledArtifact
}

export interface EvalLifecycleHooks {
  executeCase?: (input: {
    mode: EvalMode
    fixture: EvalFixture
    caseManifest: EvalCaseManifest
  }) => Promise<EvalCaseExecution>
  cleanupFixture?: (fixture: EvalFixture) => void | Promise<void>
  quarantineResidue?: (
    fixture: EvalFixture,
    quarantineRoot: string,
  ) => void | Promise<void>
}

export interface EvalSelectionRunnerInput extends SourceEvalOptions {
  mode: EvalMode
}

export interface EvalCliOptions {
  cases: CaseId[]
  modes: EvalMode[]
  fixtureSeed: string
  normalizedClock: string
  selectionIds: string[]
}

export interface EvalCliHelp {
  help: true
  usage: string
}

export type EvalCliParseResult = EvalCliHelp | EvalCliOptions

export interface EvalRunResultSummary {
  selectionId: string
  resultArtifactId: string
  outcome: EvalOutcome
  subcode: EvalSubcode
}

export interface EvalRunManifest {
  manifestSchemaVersion: typeof RUN_MANIFEST_SCHEMA_VERSION
  harness: typeof HARNESS
  runId: string
  requestedSelectionIds: string[]
  completedSelectionIds: string[]
  partial: boolean
  results: EvalRunResultSummary[]
}

export interface PersistEvalRunOptions {
  manifest: unknown
  results: readonly unknown[]
  runsRoot?: string
  rootDir?: string
  onRename?: (relativeId: string) => void
}

export interface EvalSelectionRunnerOptions {
  selectionIds: readonly string[]
  fixtureSeed: string
  normalizedClock: string
  runId?: string
  parentDir?: string
  rootDir?: string
  runsRoot?: string
  timeoutMs?: number
  caseTimeoutMs?: number
  sourceRunner?: (options: EvalSelectionRunnerInput) => Promise<EvalResult>
  installedRunner?: (options: EvalSelectionRunnerInput) => Promise<EvalResult>
  artifactCleanupHooks?: Pick<
    EvalLifecycleHooks,
    'cleanupFixture' | 'quarantineResidue'
  >
  packInstalledArtifact?: (options: {
    rootDir: string
    fixture: EvalFixture
  }) => InstalledArtifact
}

export interface EvalRunExecution {
  runId: string
  manifest: EvalRunManifest
  results: EvalResult[]
  persisted: PersistedEvalRun
}

export interface EvalCliOptionsOverride {
  runId?: string
  parentDir?: string
  rootDir?: string
  runsRoot?: string
  timeoutMs?: number
  caseTimeoutMs?: number
  sourceRunner?: (options: EvalSelectionRunnerInput) => Promise<EvalResult>
  installedRunner?: (options: EvalSelectionRunnerInput) => Promise<EvalResult>
  packInstalledArtifact?: (options: {
    rootDir: string
    fixture: EvalFixture
  }) => InstalledArtifact
}

export type EvalCliRunResult =
  | { kind: 'help'; exitCode: 0; usage: string }
  | {
      kind: 'run'
      exitCode: 0 | 1
      run: EvalRunExecution
    }
  | {
      kind: 'error'
      exitCode: 1 | 2
      code: string
      usage?: string
    }

export interface PersistedEvalRun {
  status: 'written'
  runId: string
  manifestArtifactId: 'manifest.json'
  resultArtifactIds: string[]
}

type ContractErrorCode =
  | 'case_invalid_shape'
  | 'case_unknown_field'
  | 'case_missing_field'
  | 'case_unsupported'
  | 'case_wrong_version'
  | 'case_invalid_field'
  | 'privacy_banned_field'
  | 'privacy_unsafe_value'
  | 'result_invalid_shape'
  | 'result_unknown_field'
  | 'result_missing_field'
  | 'result_invalid_field'
  | 'result_invalid_outcome'
  | 'result_invalid_subcode'
  | 'result_invalid_provenance'
  | 'serialized_invalid_encoding'
  | 'serialized_invalid_json'
  | 'manifest_invalid_shape'
  | 'manifest_unknown_field'
  | 'manifest_missing_field'
  | 'manifest_invalid_field'
  | 'manifest_invalid_state'
  | 'manifest_invalid_summary'

type RecordValue = Record<string, unknown>

const CASE_ASSERTIONS: Record<CaseId, readonly string[]> = {
  'bootstrap-loading': ['bootstrap-observed'],
  'fixture-local-write': ['fixture-file-content', 'fixture-file-created'],
  'host-skill-coverage': ['host-catalog-covered'],
  'model-inheritance': [
    'agents-inherit-invoking-model',
    'explicit-model-overlay-wins',
    'model-null-restores-inheritance',
    'project-model-trust-boundary',
  ],
}

const RESULT_REQUIRED_KEYS = [
  'resultSchemaVersion',
  'caseSchemaVersion',
  'caseId',
  'harness',
  'mode',
  'outcome',
  'runId',
  'fixtureSeed',
  'normalizedClock',
  'assertionIds',
  'identity',
  'evidence',
  'cleanup',
  'privacy',
  'artifactRefs',
  'provenance',
] as const

const RUN_MANIFEST_REQUIRED_KEYS = [
  'manifestSchemaVersion',
  'harness',
  'runId',
  'requestedSelectionIds',
  'completedSelectionIds',
  'partial',
  'results',
] as const

export const BANNED_FIELD_NAMES = new Set([
  'stdout',
  'stderr',
  'transcript',
  'rawstdout',
  'rawstderr',
  'rawtranscript',
  'env',
  'environment',
  'rawenv',
  'repository',
  'repositorycontent',
  'userprose',
  'userinput',
  'userprompt',
  'prompt',
  'prose',
  'content',
  'credentials',
  'credential',
  'token',
  'secret',
  'password',
  'privatekey',
  'socket',
  'auth',
  'authorization',
  'overlay',
  'configoverlay',
])

const ABSOLUTE_PATH_PATTERNS = [/^\//, /^\\/, /^[A-Za-z]:[\\/]/, /^file:\/\//i]

const SECRET_PATTERNS = [
  /\b(?:ghp|gho|github_pat|glpat|npm)[-_A-Za-z0-9]+/i,
  /\bsk[-_][A-Za-z0-9_-]{8,}\b/i,
  /\bAKIA[0-9A-Z]{8,}\b/,
  /\b(?:fake|dummy|test)[-_A-Za-z0-9]*(?:token|auth|key|secret|credential|password|socket)\b/i,
  /\b(?:token|secret|password|api[-_]?key|private[-_]?key|authorization)\s*[:=]/i,
  /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----/i,
  /\bssh-(?:rsa|ed25519|ecdsa)\b/i,
]

function fail(code: ContractErrorCode): never {
  throw new Error(`eval-contract:${code}`)
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, code: ContractErrorCode): RecordValue {
  if (!isRecord(value)) fail(code)
  return value
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.hasOwn(value, key)
}

function assertExactKeys(
  value: RecordValue,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  unknownCode: ContractErrorCode,
  missingCode: ContractErrorCode,
): void {
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(unknownCode)
  }
  for (const key of requiredKeys) {
    if (!hasOwn(value, key)) fail(missingCode)
  }
}

function normalizedFieldName(value: string): string {
  return value.replaceAll('_', '').replaceAll('-', '').toLowerCase()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function serializedFieldNamePattern(value: string): string {
  return [...value].map(escapeRegExp).join('[_-]*')
}

const BANNED_SERIALIZED_FIELD_PATTERN = new RegExp(
  `"(?:${[...BANNED_FIELD_NAMES].map(serializedFieldNamePattern).join('|')})"\\s*:`,
  'i',
)

function isAbsolutePath(value: string): boolean {
  return ABSOLUTE_PATH_PATTERNS.some((pattern) => pattern.test(value))
}

function hasUnsafeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value))
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      return true
    }
  }
  return false
}

function assertSafeString(value: string): void {
  if (
    value.length === 0 ||
    value.length > 512 ||
    hasControlCharacters(value) ||
    isAbsolutePath(value) ||
    hasUnsafeSecret(value)
  ) {
    fail('privacy_unsafe_value')
  }
}

function assertPrivacySafeTree(value: unknown): void {
  if (typeof value === 'string') {
    assertSafeString(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertPrivacySafeTree(item)
    return
  }
  if (!isRecord(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (BANNED_FIELD_NAMES.has(normalizedFieldName(key))) {
      fail('privacy_banned_field')
    }
    assertPrivacySafeTree(nested)
  }
}

function readString(value: unknown): string {
  if (typeof value !== 'string') fail('result_invalid_field')
  assertSafeString(value)
  return value
}

function readCaseString(value: unknown): string {
  if (typeof value !== 'string') fail('case_invalid_field')
  assertSafeString(value)
  return value
}

function readIdentifier(value: unknown): string {
  const result = readString(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) {
    fail('privacy_unsafe_value')
  }
  return result
}

function readSafeRelativeId(value: unknown): string {
  const result = readString(value)
  if (
    result.startsWith('.') ||
    result.includes('\\') ||
    result.includes(':') ||
    result
      .split('/')
      .some(
        (segment) => segment === '' || segment === '.' || segment === '..',
      ) ||
    !result
      .split('/')
      .every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(segment))
  ) {
    fail('privacy_unsafe_value')
  }
  return result
}

function readHash(value: unknown): string {
  const result = readString(value)
  if (!/^[a-f0-9]{64}$/.test(result)) fail('result_invalid_field')
  return result
}

function readCommitId(value: unknown): string {
  const result = readString(value)
  if (!/^[a-f0-9]{40}$/.test(result)) fail('result_invalid_field')
  return result
}

function readVersion(value: unknown): string {
  const result = readString(value)
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(result)) {
    fail('result_invalid_field')
  }
  return result
}

function readPackageName(value: unknown): string {
  const result = readString(value)
  if (!/^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(result)) {
    fail('result_invalid_field')
  }
  return result
}

function readClock(value: unknown): string {
  const result = readString(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)) {
    fail('result_invalid_field')
  }
  const parsed = new Date(result)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== result) {
    fail('result_invalid_field')
  }
  return result
}

const CLI_USAGE = [
  'Usage: bun scripts/run-evals.ts [options]',
  '',
  'Options:',
  '  --case <id>       Repeatable: bootstrap-loading | fixture-local-write | host-skill-coverage | model-inheritance',
  '  --mode <mode>     Repeatable: source | installed',
  '  --seed <seed>     [A-Za-z0-9][A-Za-z0-9._-]{0,127}',
  '  --clock <UTC>     YYYY-MM-DDTHH:mm:ss.sssZ',
  '  --help            Show this help',
  '',
  'Output: evals/runs/<runId>/; manifest.json is the final completion marker.',
  'Exit codes: 0 success; 1 completed or partial run with a non-success outcome; 2 invalid arguments.',
].join('\n')

type CliErrorCode =
  | 'unknown_argument'
  | 'missing_value'
  | 'missing_required'
  | 'invalid_case'
  | 'invalid_mode'
  | 'invalid_seed'
  | 'invalid_clock'
  | 'duplicate_singleton'
  | 'conflicting_argument'

function cliFail(code: CliErrorCode): never {
  throw new Error(`eval-cli:${code}`)
}

function isCaseId(value: string): value is CaseId {
  return CASE_IDS.includes(value as CaseId)
}

function isEvalMode(value: string): value is EvalMode {
  return MODES.includes(value as EvalMode)
}

function readCliSeed(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
    hasUnsafeSecret(value) ||
    isAbsolutePath(value) ||
    hasControlCharacters(value)
  ) {
    cliFail('invalid_seed')
  }
  return value
}

function readCliClock(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    cliFail('invalid_clock')
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    cliFail('invalid_clock')
  }
  return value
}

export function buildEvalSelectionIds(
  caseIds: readonly CaseId[],
  modes: readonly EvalMode[],
): string[] {
  const cases = [...new Set(caseIds)].sort()
  const selectedModes = [...new Set(modes)].sort()
  if (cases.length === 0 || selectedModes.length === 0) {
    cliFail('missing_required')
  }
  if (cases.some((caseId) => !isCaseId(caseId))) cliFail('invalid_case')
  if (selectedModes.some((mode) => !isEvalMode(mode))) cliFail('invalid_mode')
  return cases.flatMap((caseId) =>
    selectedModes.map((mode) => `${caseId}/${mode}`),
  )
}

type CliArgument = '--case' | '--mode' | '--seed' | '--clock'

interface CliAccumulator {
  cases: CaseId[]
  modes: EvalMode[]
  fixtureSeed?: string
  normalizedClock?: string
}

function isCliArgument(value: string): value is CliArgument {
  return (
    value === '--case' ||
    value === '--mode' ||
    value === '--seed' ||
    value === '--clock'
  )
}

function readCliArgument(
  argv: readonly string[],
  index: number,
): { argument: CliArgument; value: string; nextIndex: number } {
  const argument = argv[index]
  if (argument === undefined || !isCliArgument(argument)) {
    cliFail('unknown_argument')
  }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) cliFail('missing_value')
  return { argument, value, nextIndex: index + 1 }
}

function applyCliArgument(
  accumulator: CliAccumulator,
  argument: CliArgument,
  value: string,
): void {
  switch (argument) {
    case '--case':
      if (!isCaseId(value)) cliFail('invalid_case')
      accumulator.cases.push(value)
      return
    case '--mode':
      if (!isEvalMode(value)) cliFail('invalid_mode')
      accumulator.modes.push(value)
      return
    case '--seed':
      if (accumulator.fixtureSeed !== undefined) {
        cliFail('duplicate_singleton')
      }
      accumulator.fixtureSeed = readCliSeed(value)
      return
    case '--clock':
      if (accumulator.normalizedClock !== undefined) {
        cliFail('duplicate_singleton')
      }
      accumulator.normalizedClock = readCliClock(value)
      return
  }
}

export function parseEvalCliArgs(argv: readonly string[]): EvalCliParseResult {
  if (argv.length === 1 && argv[0] === '--help') {
    return { help: true, usage: CLI_USAGE }
  }

  const accumulator: CliAccumulator = { cases: [], modes: [] }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help') cliFail('conflicting_argument')
    const parsed = readCliArgument(argv, index)
    applyCliArgument(accumulator, parsed.argument, parsed.value)
    index = parsed.nextIndex
  }

  if (
    accumulator.cases.length === 0 ||
    accumulator.modes.length === 0 ||
    accumulator.fixtureSeed === undefined ||
    accumulator.normalizedClock === undefined
  ) {
    cliFail('missing_required')
  }

  const sortedCases = [...new Set(accumulator.cases)].sort()
  const sortedModes = [...new Set(accumulator.modes)].sort()
  return {
    cases: sortedCases,
    modes: sortedModes,
    fixtureSeed: accumulator.fixtureSeed,
    normalizedClock: accumulator.normalizedClock,
    selectionIds: buildEvalSelectionIds(sortedCases, sortedModes),
  }
}

function readInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail('result_invalid_field')
  }
  return value
}

const MAX_PROMPT_COMPOSITION_SIZE = 100_000
const MAX_PROMPT_CATALOG_ENTRIES = 128
const SAFE_PROMPT_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/

function readNonNegativeInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    fail('result_invalid_field')
  }
  return value
}

function readPromptSkillNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PROMPT_CATALOG_ENTRIES) {
    fail('result_invalid_field')
  }
  const names: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !SAFE_PROMPT_SKILL_NAME.test(item)) {
      fail('result_invalid_field')
    }
    assertSafeString(item)
    if (names.includes(item)) fail('result_invalid_field')
    names.push(item)
  }
  return names.sort()
}

function normalizePromptCatalogObservation(
  value: unknown,
): PromptCatalogObservation {
  const input = record(value, 'result_invalid_field')
  assertExactKeys(
    input,
    ['state', 'entryCount', 'skillNames'],
    [],
    'result_unknown_field',
    'result_missing_field',
  )
  const state = input.state
  if (state !== 'present' && state !== 'absent' && state !== 'impossible') {
    fail('result_invalid_field')
  }
  const entryCount = readNonNegativeInteger(
    input.entryCount,
    MAX_PROMPT_CATALOG_ENTRIES,
  )
  const skillNames = readPromptSkillNames(input.skillNames)
  if (state !== 'present' && (entryCount !== 0 || skillNames.length !== 0)) {
    fail('result_invalid_field')
  }
  if (skillNames.length > entryCount) fail('result_invalid_field')
  return { state, entryCount, skillNames }
}

function normalizePromptComposition(
  value: unknown,
): PromptCompositionObservation {
  const input = record(value, 'result_invalid_field')
  assertExactKeys(
    input,
    ['bootstrapPayloadSize', 'systematicCatalog', 'hostCatalog'],
    [],
    'result_unknown_field',
    'result_missing_field',
  )
  const bootstrapPayloadSize = readNonNegativeInteger(
    input.bootstrapPayloadSize,
    MAX_PROMPT_COMPOSITION_SIZE,
  )
  const systematicCatalog = normalizePromptCatalogObservation(
    input.systematicCatalog,
  )
  const hostCatalog = normalizePromptCatalogObservation(input.hostCatalog)
  return {
    bootstrapPayloadSize,
    systematicCatalog,
    hostCatalog,
  }
}

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function normalizeHostCatalogCoverage(
  value: unknown,
): HostCatalogCoverageObservation {
  const input = record(value, 'result_invalid_field')
  assertExactKeys(
    input,
    ['state', 'expectedSkillNames', 'observedSkillNames', 'missingSkillNames'],
    [],
    'result_unknown_field',
    'result_missing_field',
  )
  const state = input.state
  if (state !== 'present' && state !== 'absent' && state !== 'impossible') {
    fail('result_invalid_field')
  }
  const expectedSkillNames = readPromptSkillNames(input.expectedSkillNames)
  const observedSkillNames = readPromptSkillNames(input.observedSkillNames)
  const missingSkillNames = readPromptSkillNames(input.missingSkillNames)
  if (expectedSkillNames.length === 0) fail('result_invalid_field')

  if (state === 'impossible') {
    if (observedSkillNames.length !== 0 || missingSkillNames.length !== 0) {
      fail('result_invalid_field')
    }
    return {
      state,
      expectedSkillNames,
      observedSkillNames,
      missingSkillNames,
    }
  }

  const expectedMissingSkillNames = expectedSkillNames.filter(
    (name) => !observedSkillNames.includes(name),
  )
  if (!sameStringList(missingSkillNames, expectedMissingSkillNames)) {
    fail('result_invalid_field')
  }
  if (state === 'absent' && observedSkillNames.length !== 0) {
    fail('result_invalid_field')
  }
  return {
    state,
    expectedSkillNames,
    observedSkillNames,
    missingSkillNames,
  }
}

const MAX_MODEL_INHERITANCE_OBSERVATIONS = 16
const MAX_MODEL_AGENT_OBSERVATIONS = 128
const MODEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

function readModelIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !MODEL_IDENTIFIER_PATTERN.test(value)) {
    fail('result_invalid_field')
  }
  assertSafeString(value)
  return value
}

function normalizeModelAgentObservation(value: unknown): ModelAgentObservation {
  const input = record(value, 'result_invalid_field')
  assertExactKeys(
    input,
    ['agentId', 'modelPresent', 'variantPresent'],
    ['model', 'variant'],
    'result_unknown_field',
    'result_missing_field',
  )
  if (
    typeof input.modelPresent !== 'boolean' ||
    typeof input.variantPresent !== 'boolean'
  ) {
    fail('result_invalid_field')
  }
  const model = hasOwn(input, 'model')
    ? readModelIdentifier(input.model)
    : undefined
  const variant = hasOwn(input, 'variant')
    ? readModelIdentifier(input.variant)
    : undefined
  if (
    (!input.modelPresent && model !== undefined) ||
    (!input.variantPresent && variant !== undefined)
  ) {
    fail('result_invalid_field')
  }
  return {
    agentId: readSafeRelativeId(input.agentId),
    modelPresent: input.modelPresent,
    variantPresent: input.variantPresent,
    ...(model !== undefined ? { model } : {}),
    ...(variant !== undefined ? { variant } : {}),
  }
}

function normalizeModelInheritanceObservation(
  value: unknown,
): ModelInheritanceObservation {
  const input = record(value, 'result_invalid_field')
  assertExactKeys(
    input,
    ['availability', 'policy', 'agents'],
    [],
    'result_unknown_field',
    'result_missing_field',
  )
  if (input.availability !== 'known' && input.availability !== 'unknown') {
    fail('result_invalid_field')
  }
  if (
    input.policy !== 'none' &&
    input.policy !== 'category' &&
    input.policy !== 'exact' &&
    input.policy !== 'null' &&
    input.policy !== 'project-error'
  ) {
    fail('result_invalid_field')
  }
  if (
    !Array.isArray(input.agents) ||
    input.agents.length > MAX_MODEL_AGENT_OBSERVATIONS
  ) {
    fail('result_invalid_field')
  }
  const agents = input.agents.map(normalizeModelAgentObservation)
  if (new Set(agents.map((agent) => agent.agentId)).size !== agents.length) {
    fail('result_invalid_field')
  }
  agents.sort((left, right) => left.agentId.localeCompare(right.agentId))
  if (
    input.policy === 'none' &&
    agents.some(
      (agent) => agent.model !== undefined || agent.variant !== undefined,
    )
  ) {
    fail('result_invalid_field')
  }
  return {
    availability: input.availability,
    policy: input.policy,
    agents,
  }
}

function readSortedIdentifiers(
  value: unknown,
  expected: readonly string[],
  code: ContractErrorCode,
): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(code)
  const identifiers: string[] = []
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item)
    ) {
      fail(code)
    }
    assertSafeString(item)
    if (identifiers.includes(item)) fail(code)
    identifiers.push(item)
  }
  const sorted = [...identifiers].sort()
  if (
    sorted.length !== expected.length ||
    sorted.some((item, index) => item !== expected[index])
  ) {
    fail(code)
  }
  return sorted
}

function readSortedArtifactRefs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('result_invalid_field')
  }
  const refs: string[] = []
  for (const item of value) {
    const ref = readSafeRelativeId(item)
    if (refs.includes(ref)) fail('result_invalid_field')
    refs.push(ref)
  }
  return refs.sort()
}

function readOutcome(value: unknown): EvalOutcome {
  if (typeof value !== 'string' || !OUTCOMES.includes(value as EvalOutcome)) {
    fail('result_invalid_outcome')
  }
  return value as EvalOutcome
}

function readMode(value: unknown): EvalMode {
  if (typeof value !== 'string' || !MODES.includes(value as EvalMode)) {
    fail('result_invalid_field')
  }
  return value as EvalMode
}

function readSubcode(value: unknown, outcome: EvalOutcome): EvalSubcode {
  const allowedSubcodes: readonly string[] = OUTCOME_SUBCODES[outcome]
  if (typeof value !== 'string' || !allowedSubcodes.includes(value)) {
    fail('result_invalid_subcode')
  }
  return value as EvalSubcode
}

function normalizeIdentity(value: unknown): EvalIdentity {
  const input = record(value, 'result_invalid_field')
  assertExactKeys(
    input,
    [
      'opencodeVersion',
      'opencodeBuildId',
      'probeId',
      'probeDigest',
      'fixtureContractVersion',
      'fixtureContractDigest',
      'caseSchemaVersion',
      'resultSchemaVersion',
      'artifactId',
      'artifactDigest',
    ],
    [],
    'result_unknown_field',
    'result_missing_field',
  )
  const caseSchemaVersion = readInteger(input.caseSchemaVersion)
  const resultSchemaVersion = readInteger(input.resultSchemaVersion)
  if (
    caseSchemaVersion !== CASE_SCHEMA_VERSION ||
    resultSchemaVersion !== RESULT_SCHEMA_VERSION
  ) {
    fail('result_invalid_field')
  }
  return {
    opencodeVersion: readVersion(input.opencodeVersion),
    opencodeBuildId: readIdentifier(input.opencodeBuildId),
    probeId: readIdentifier(input.probeId),
    probeDigest: readHash(input.probeDigest),
    fixtureContractVersion: readInteger(input.fixtureContractVersion),
    fixtureContractDigest: readHash(input.fixtureContractDigest),
    caseSchemaVersion,
    resultSchemaVersion,
    artifactId: readIdentifier(input.artifactId),
    artifactDigest: readHash(input.artifactDigest),
  }
}

function normalizeEvidence(
  value: unknown,
  assertionIds: readonly string[],
  caseId: CaseId,
): EvalEvidence {
  const input = record(value, 'result_invalid_field')
  assertExactKeys(
    input,
    ['sanity', 'process', 'assertionIds'],
    ['promptComposition', 'hostCatalogCoverage', 'modelInheritance'],
    'result_unknown_field',
    'result_missing_field',
  )
  const sanity = input.sanity
  const process = input.process
  if (sanity !== 'passed' && sanity !== 'failed') fail('result_invalid_field')
  if (process !== 'completed' && process !== 'failed')
    fail('result_invalid_field')
  const normalizedAssertionIds = readSortedIdentifiers(
    input.assertionIds,
    assertionIds,
    'result_invalid_field',
  )
  const normalized: EvalEvidence = {
    sanity,
    process,
    assertionIds: normalizedAssertionIds,
  }
  if (caseId !== 'model-inheritance' && hasOwn(input, 'modelInheritance')) {
    fail('result_invalid_field')
  }
  if (caseId === 'model-inheritance' && !hasOwn(input, 'modelInheritance')) {
    fail('result_invalid_field')
  }
  if (hasOwn(input, 'promptComposition')) {
    normalized.promptComposition = normalizePromptComposition(
      input.promptComposition,
    )
  }
  if (hasOwn(input, 'hostCatalogCoverage')) {
    normalized.hostCatalogCoverage = normalizeHostCatalogCoverage(
      input.hostCatalogCoverage,
    )
  }
  if (hasOwn(input, 'modelInheritance')) {
    if (
      !Array.isArray(input.modelInheritance) ||
      input.modelInheritance.length > MAX_MODEL_INHERITANCE_OBSERVATIONS
    ) {
      fail('result_invalid_field')
    }
    normalized.modelInheritance = input.modelInheritance.map(
      normalizeModelInheritanceObservation,
    )
  }
  return normalized
}

function normalizeCleanup(value: unknown): EvalCleanupState {
  const input = record(value, 'result_invalid_field')
  assertExactKeys(
    input,
    ['status', 'residue'],
    [],
    'result_unknown_field',
    'result_missing_field',
  )
  const status = input.status
  const residue = input.residue
  if (status !== 'clean' && status !== 'residue' && status !== 'quarantined') {
    fail('result_invalid_field')
  }
  if (
    residue !== 'none' &&
    residue !== 'detected' &&
    residue !== 'quarantined'
  ) {
    fail('result_invalid_field')
  }
  if (
    (status === 'clean' && residue !== 'none') ||
    (status === 'residue' && residue !== 'detected') ||
    (status === 'quarantined' && residue !== 'quarantined')
  ) {
    fail('result_invalid_field')
  }
  return { status, residue }
}

function normalizePrivacy(value: unknown): EvalPrivacyState {
  const input = record(value, 'result_invalid_field')
  assertExactKeys(
    input,
    ['status'],
    [],
    'result_unknown_field',
    'result_missing_field',
  )
  if (input.status !== 'validated' && input.status !== 'rejected') {
    fail('result_invalid_field')
  }
  return { status: input.status }
}

function normalizeProvenance(
  value: unknown,
  mode: EvalMode,
): SourceProvenance | InstalledProvenance {
  const input = record(value, 'result_invalid_provenance')
  const kind = input.kind
  if (kind === 'source') {
    if (mode !== 'source') fail('result_invalid_provenance')
    assertExactKeys(
      input,
      [
        'kind',
        'checkoutRelativeSource',
        'commitId',
        'worktreeId',
        'canonicalSourceEntryId',
        'opencodeConfigEntryId',
      ],
      [],
      'result_invalid_provenance',
      'result_invalid_provenance',
    )
    return {
      kind,
      checkoutRelativeSource: readSafeRelativeId(input.checkoutRelativeSource),
      commitId: readCommitId(input.commitId),
      worktreeId: readIdentifier(input.worktreeId),
      canonicalSourceEntryId: readIdentifier(input.canonicalSourceEntryId),
      opencodeConfigEntryId: readIdentifier(input.opencodeConfigEntryId),
    }
  }
  if (kind === 'installed') {
    if (mode !== 'installed') fail('result_invalid_provenance')
    assertExactKeys(
      input,
      [
        'kind',
        'packageName',
        'packageVersion',
        'tarballDigest',
        'extractedPackageRootId',
        'canonicalResolvedModuleEntryId',
        'opencodeConfigEntryId',
      ],
      [],
      'result_invalid_provenance',
      'result_invalid_provenance',
    )
    return {
      kind,
      packageName: readPackageName(input.packageName),
      packageVersion: readVersion(input.packageVersion),
      tarballDigest: readHash(input.tarballDigest),
      extractedPackageRootId: readIdentifier(input.extractedPackageRootId),
      canonicalResolvedModuleEntryId: readSafeRelativeId(
        input.canonicalResolvedModuleEntryId,
      ),
      opencodeConfigEntryId: readIdentifier(input.opencodeConfigEntryId),
    }
  }
  fail('result_invalid_provenance')
}

function parseHostSkillCoverageCaseManifest(
  value: RecordValue,
): HostSkillCoverageCaseManifest {
  assertExactKeys(
    value,
    [
      'caseSchemaVersion',
      'caseId',
      'harness',
      'assertionIds',
      'expectedSkillNames',
    ],
    [],
    'case_unknown_field',
    'case_missing_field',
  )
  if (value.caseSchemaVersion !== CASE_SCHEMA_VERSION) {
    fail('case_wrong_version')
  }
  if (value.harness !== HARNESS) fail('case_invalid_field')
  const assertionIds = readSortedIdentifiers(
    value.assertionIds,
    CASE_ASSERTIONS['host-skill-coverage'],
    'case_invalid_field',
  )
  const expectedSkillNames = readPromptSkillNames(value.expectedSkillNames)
  if (expectedSkillNames.length === 0) fail('case_invalid_field')
  return {
    caseSchemaVersion: CASE_SCHEMA_VERSION,
    caseId: 'host-skill-coverage',
    harness: HARNESS,
    assertionIds,
    expectedSkillNames,
  }
}

function readSortedAgentIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) fail('case_invalid_field')
  const ids = value.map((item) => readSafeRelativeId(item))
  if (new Set(ids).size !== ids.length) fail('case_invalid_field')
  return ids.sort()
}

function parseModelInheritanceCaseManifest(
  value: RecordValue,
): ModelInheritanceCaseManifest {
  assertExactKeys(
    value,
    [
      'caseSchemaVersion',
      'caseId',
      'harness',
      'assertionIds',
      'expectedAgentIds',
      'category',
      'categoryModel',
      'categoryVariant',
      'exactAgentId',
      'exactModel',
      'exactVariant',
    ],
    [],
    'case_unknown_field',
    'case_missing_field',
  )
  if (value.caseSchemaVersion !== CASE_SCHEMA_VERSION) {
    fail('case_wrong_version')
  }
  if (value.harness !== HARNESS) fail('case_invalid_field')
  const assertionIds = readSortedIdentifiers(
    value.assertionIds,
    CASE_ASSERTIONS['model-inheritance'],
    'case_invalid_field',
  )
  const expectedAgentIds = readSortedAgentIds(value.expectedAgentIds)
  const category = readIdentifier(value.category)
  const exactAgentId = readSafeRelativeId(value.exactAgentId)
  if (!exactAgentId.startsWith(`${category}/`)) fail('case_invalid_field')
  if (!expectedAgentIds.includes(exactAgentId)) fail('case_invalid_field')
  if (!expectedAgentIds.some((id) => id.startsWith(`${category}/`))) {
    fail('case_invalid_field')
  }
  return {
    caseSchemaVersion: CASE_SCHEMA_VERSION,
    caseId: 'model-inheritance',
    harness: HARNESS,
    assertionIds,
    expectedAgentIds,
    category,
    categoryModel: readModelIdentifier(value.categoryModel),
    categoryVariant: readModelIdentifier(value.categoryVariant),
    exactAgentId,
    exactModel: readModelIdentifier(value.exactModel),
    exactVariant: readModelIdentifier(value.exactVariant),
  }
}

export function parseCaseManifest(input: unknown): EvalCaseManifest {
  assertPrivacySafeTree(input)
  const value = record(input, 'case_invalid_shape')
  const caseId = value.caseId
  if (typeof caseId !== 'string' || !isCaseId(caseId)) {
    fail('case_unsupported')
  }

  if (caseId === 'bootstrap-loading') {
    assertExactKeys(
      value,
      ['caseSchemaVersion', 'caseId', 'harness', 'assertionIds'],
      [],
      'case_unknown_field',
      'case_missing_field',
    )
    if (value.caseSchemaVersion !== CASE_SCHEMA_VERSION) {
      fail('case_wrong_version')
    }
    if (value.harness !== HARNESS) fail('case_invalid_field')
    const assertionIds = readSortedIdentifiers(
      value.assertionIds,
      CASE_ASSERTIONS[caseId],
      'case_invalid_field',
    )
    return {
      caseSchemaVersion: CASE_SCHEMA_VERSION,
      caseId,
      harness: HARNESS,
      assertionIds,
    }
  }

  if (caseId === 'host-skill-coverage') {
    return parseHostSkillCoverageCaseManifest(value)
  }

  if (caseId === 'model-inheritance') {
    return parseModelInheritanceCaseManifest(value)
  }

  assertExactKeys(
    value,
    [
      'caseSchemaVersion',
      'caseId',
      'harness',
      'assertionIds',
      'expectedArtifactId',
      'expectedContentId',
    ],
    [],
    'case_unknown_field',
    'case_missing_field',
  )
  if (value.caseSchemaVersion !== CASE_SCHEMA_VERSION) {
    fail('case_wrong_version')
  }
  if (value.harness !== HARNESS) fail('case_invalid_field')
  const assertionIds = readSortedIdentifiers(
    value.assertionIds,
    CASE_ASSERTIONS[caseId],
    'case_invalid_field',
  )
  const expectedArtifactId = readSafeRelativeId(value.expectedArtifactId)
  const expectedContentId = readCaseString(value.expectedContentId)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(expectedContentId)) {
    fail('case_invalid_field')
  }
  return {
    caseSchemaVersion: CASE_SCHEMA_VERSION,
    caseId,
    harness: HARNESS,
    assertionIds,
    expectedArtifactId,
    expectedContentId,
  }
}

export function normalizeResult(input: unknown): EvalResult {
  assertPrivacySafeTree(input)
  const value = record(input, 'result_invalid_shape')
  assertExactKeys(
    value,
    RESULT_REQUIRED_KEYS,
    ['subcode'],
    'result_unknown_field',
    'result_missing_field',
  )

  if (value.resultSchemaVersion !== RESULT_SCHEMA_VERSION) {
    fail('result_invalid_field')
  }
  if (value.caseSchemaVersion !== CASE_SCHEMA_VERSION) {
    fail('result_invalid_field')
  }
  if (value.harness !== HARNESS) fail('result_invalid_field')

  const caseId = value.caseId
  if (typeof caseId !== 'string' || !isCaseId(caseId)) {
    fail('result_invalid_field')
  }
  const mode = readMode(value.mode)
  const outcome = readOutcome(value.outcome)
  const subcode = hasOwn(value, 'subcode')
    ? readSubcode(value.subcode, outcome)
    : undefined
  const assertionIds = readSortedIdentifiers(
    value.assertionIds,
    CASE_ASSERTIONS[caseId],
    'result_invalid_field',
  )
  const identity = normalizeIdentity(value.identity)
  if (
    identity.caseSchemaVersion !== value.caseSchemaVersion ||
    identity.resultSchemaVersion !== value.resultSchemaVersion
  ) {
    fail('result_invalid_field')
  }

  const normalized: EvalResult = {
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    caseSchemaVersion: CASE_SCHEMA_VERSION,
    caseId,
    harness: HARNESS,
    mode,
    outcome,
    runId: readIdentifier(value.runId),
    fixtureSeed: readIdentifier(value.fixtureSeed),
    normalizedClock: readClock(value.normalizedClock),
    assertionIds,
    identity,
    evidence: normalizeEvidence(value.evidence, assertionIds, caseId),
    cleanup: normalizeCleanup(value.cleanup),
    privacy: normalizePrivacy(value.privacy),
    artifactRefs: readSortedArtifactRefs(value.artifactRefs),
    provenance: normalizeProvenance(value.provenance, mode),
  }
  if (subcode !== undefined) normalized.subcode = subcode
  return normalized
}

export function redactResult(input: unknown): EvalResult {
  return normalizeResult(input)
}

function readSelectionId(value: unknown, code: ContractErrorCode): string {
  if (typeof value !== 'string') fail(code)
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) fail(code)
  const caseId = value.slice(0, separator)
  const mode = value.slice(separator + 1)
  if (!isCaseId(caseId) || !isEvalMode(mode)) fail(code)
  return `${caseId}/${mode}`
}

function readSortedSelectionIds(
  value: unknown,
  allowEmpty: boolean,
  code: ContractErrorCode,
): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(code)
  }
  const selectionIds: string[] = []
  for (const item of value) {
    const selectionId = readSelectionId(item, code)
    if (selectionIds.includes(selectionId)) fail(code)
    selectionIds.push(selectionId)
  }
  return selectionIds.sort()
}

function normalizeRunSummary(value: unknown): EvalRunResultSummary {
  const input = record(value, 'manifest_invalid_summary')
  assertExactKeys(
    input,
    ['selectionId', 'resultArtifactId', 'outcome', 'subcode'],
    [],
    'manifest_invalid_summary',
    'manifest_invalid_summary',
  )
  const selectionId = readSelectionId(
    input.selectionId,
    'manifest_invalid_summary',
  )
  const outcome = readOutcome(input.outcome)
  return {
    selectionId,
    resultArtifactId: readSafeRelativeId(input.resultArtifactId),
    outcome,
    subcode: readSubcode(input.subcode, outcome),
  }
}

export function normalizeRunManifest(input: unknown): EvalRunManifest {
  assertPrivacySafeTree(input)
  const value = record(input, 'manifest_invalid_shape')
  assertExactKeys(
    value,
    RUN_MANIFEST_REQUIRED_KEYS,
    [],
    'manifest_unknown_field',
    'manifest_missing_field',
  )
  if (value.manifestSchemaVersion !== RUN_MANIFEST_SCHEMA_VERSION) {
    fail('manifest_invalid_field')
  }
  if (value.harness !== HARNESS) fail('manifest_invalid_field')

  const runId = readIdentifier(value.runId)
  const requestedSelectionIds = readSortedSelectionIds(
    value.requestedSelectionIds,
    false,
    'manifest_invalid_field',
  )
  const completedSelectionIds = readSortedSelectionIds(
    value.completedSelectionIds,
    true,
    'manifest_invalid_field',
  )
  if (typeof value.partial !== 'boolean') fail('manifest_invalid_state')
  const partial = value.partial
  if (
    completedSelectionIds.some(
      (selectionId) => !requestedSelectionIds.includes(selectionId),
    ) ||
    partial !== (completedSelectionIds.length !== requestedSelectionIds.length)
  ) {
    fail('manifest_invalid_state')
  }

  if (!Array.isArray(value.results)) fail('manifest_invalid_summary')
  const results = value.results.map(normalizeRunSummary)
  const seenArtifactIds = new Set<string>()
  for (const result of results) {
    if (
      !completedSelectionIds.includes(result.selectionId) ||
      seenArtifactIds.has(result.resultArtifactId)
    ) {
      fail('manifest_invalid_summary')
    }
    seenArtifactIds.add(result.resultArtifactId)
  }
  const resultSelectionIds = results.map((result) => result.selectionId).sort()
  if (
    resultSelectionIds.length !== completedSelectionIds.length ||
    resultSelectionIds.some(
      (selectionId, index) => selectionId !== completedSelectionIds[index],
    )
  ) {
    fail('manifest_invalid_summary')
  }

  return {
    manifestSchemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    harness: HARNESS,
    runId,
    requestedSelectionIds,
    completedSelectionIds,
    partial,
    results: results.sort((left, right) =>
      left.selectionId.localeCompare(right.selectionId),
    ),
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (!isRecord(value)) return value
  const result: RecordValue = {}
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalize(value[key])
  }
  return result
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value))
  if (typeof serialized !== 'string') fail('serialized_invalid_json')
  return serialized
}

function decodeSerializedResult(input: string | Uint8Array): string {
  if (typeof input === 'string') return input
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input)
  } catch {
    fail('serialized_invalid_encoding')
  }
}

export function assertSerializedTextSafe(serialized: string): void {
  if (
    BANNED_SERIALIZED_FIELD_PATTERN.test(serialized) ||
    hasUnsafeSecret(serialized) ||
    /(?:["':]|^)(?:\/|\\\\|[A-Za-z]:[\\/]|file:\/\/)/i.test(serialized)
  ) {
    fail('privacy_unsafe_value')
  }
}

export function validateSerializedResult(
  input: string | Uint8Array,
): EvalResult {
  const serialized = decodeSerializedResult(input)
  if (serialized.startsWith('\uFEFF')) fail('serialized_invalid_json')
  assertSerializedTextSafe(serialized)
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    fail('serialized_invalid_json')
  }
  return normalizeResult(parsed)
}

export function serializeResult(input: unknown): string {
  const normalized = redactResult(input)
  const serialized = canonicalJson(normalized)
  validateSerializedResult(serialized)
  return serialized
}

export function validateSerializedRunManifest(
  input: string | Uint8Array,
): EvalRunManifest {
  const serialized = decodeSerializedResult(input)
  if (serialized.startsWith('\uFEFF')) fail('serialized_invalid_json')
  assertSerializedTextSafe(serialized)
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    fail('serialized_invalid_json')
  }
  return normalizeRunManifest(parsed)
}

export function serializeRunManifest(input: unknown): string {
  const normalized = normalizeRunManifest(input)
  const serialized = canonicalJson(normalized)
  validateSerializedRunManifest(serialized)
  return serialized
}

export const EXPECTED_OPENCODE_VERSION = '1.18.21' as const

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const FIXTURE_CONTRACT_VERSION = 1 as const
const FIXTURE_CONTRACT_DIGEST = createHash('sha256')
  .update('systematic-eval-fixture-contract-v1')
  .digest('hex')
const EXECUTION_PATH =
  process.env.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
const ZERO_DIGEST = '0'.repeat(64)

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath: string, fallback: string): string {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return sha256Text(fallback)
  }
}

function ensureSafeFixtureId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('eval-path:invalid_fixture_id')
  }
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true })
}

function canonicalizePath(value: string): string {
  let current = path.resolve(value)
  const suffix: string[] = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(current, ...suffix)
    suffix.unshift(path.basename(current))
    current = parent
  }
  return path.resolve(fs.realpathSync(current), ...suffix)
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

export function assertEvalPathContained(
  root: string,
  candidate: string,
): string {
  const canonicalRoot = canonicalizePath(root)
  const canonicalCandidate = canonicalizePath(candidate)
  if (!isContained(canonicalRoot, canonicalCandidate)) {
    throw new Error('eval-path:path_escape')
  }
  return canonicalCandidate
}

function tryMakePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(directory, 0o700)
  } catch {
    // Some filesystems do not support chmod; creation still remains best effort.
  }
}

function persistFail(
  code: 'invalid_input' | 'run_exists' | 'atomic_write_failed',
): never {
  throw new Error(`eval-persist:${code}`)
}

function selectionIdFor(caseId: CaseId, mode: EvalMode): string {
  return `${caseId}/${mode}`
}

interface NormalizedPersistedResult {
  selectionId: string
  artifactId: string
  serialized: string
}

interface PendingPersistedFile {
  relativeId: string
  bytes: Buffer
  target: string
  temporary: string
}

function normalizePersistedResults(
  manifest: EvalRunManifest,
  candidates: readonly unknown[],
): NormalizedPersistedResult[] {
  const summaryBySelection = new Map(
    manifest.results.map((summary) => [summary.selectionId, summary]),
  )
  const normalizedResults: NormalizedPersistedResult[] = []
  const seenSelections = new Set<string>()
  for (const candidate of candidates) {
    const result = normalizeResult(candidate)
    const selectionId = selectionIdFor(result.caseId, result.mode)
    const summary = summaryBySelection.get(selectionId)
    const subcode = result.subcode ?? 'none'
    const matchesSummary =
      summary !== undefined &&
      !seenSelections.has(selectionId) &&
      summary.outcome === result.outcome &&
      summary.subcode === subcode
    if (result.runId !== manifest.runId || !matchesSummary) {
      persistFail('invalid_input')
    }
    const serialized = serializeResult(result)
    validateSerializedResult(new TextEncoder().encode(serialized))
    normalizedResults.push({
      selectionId,
      artifactId: summary.resultArtifactId,
      serialized,
    })
    seenSelections.add(selectionId)
  }
  if (seenSelections.size !== manifest.completedSelectionIds.length) {
    persistFail('invalid_input')
  }
  return normalizedResults.sort((left, right) =>
    left.selectionId.localeCompare(right.selectionId),
  )
}

function preparePendingPersistedFiles(
  runRoot: string,
  files: ReadonlyArray<{ relativeId: string; bytes: Buffer }>,
): PendingPersistedFile[] {
  return files.map((file) => {
    const target = assertEvalPathContained(
      runRoot,
      path.join(runRoot, file.relativeId),
    )
    if (fs.existsSync(target)) persistFail('run_exists')
    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.tmp.${randomUUID()}`,
    )
    assertEvalPathContained(runRoot, temporary)
    return { ...file, target, temporary }
  })
}

function writePersistedTemps(files: readonly PendingPersistedFile[]): void {
  for (const file of files) {
    tryMakePrivateDirectory(path.dirname(file.target))
    fs.writeFileSync(file.temporary, file.bytes, {
      flag: 'wx',
      mode: 0o600,
    })
    try {
      fs.chmodSync(file.temporary, 0o600)
    } catch {
      // Some filesystems do not support chmod; creation still remains best effort.
    }
  }
}

function renamePersistedTemps(
  files: readonly PendingPersistedFile[],
  createdFinals: string[],
  onRename?: (relativeId: string) => void,
): void {
  for (const file of files) {
    onRename?.(file.relativeId)
    fs.renameSync(file.temporary, file.target)
    createdFinals.push(file.target)
    try {
      fs.chmodSync(file.target, 0o600)
    } catch {
      // Some filesystems do not support chmod; creation still remains best effort.
    }
  }
}

function writePersistedFiles(
  runsRoot: string,
  runRoot: string,
  files: readonly PendingPersistedFile[],
  onRename?: (relativeId: string) => void,
): void {
  const createdFinals: string[] = []
  let createdRunRoot = false
  try {
    tryMakePrivateDirectory(runsRoot)
    fs.mkdirSync(runRoot, { mode: 0o700 })
    createdRunRoot = true
    try {
      fs.chmodSync(runRoot, 0o700)
    } catch {
      // Some filesystems do not support chmod; creation still remains best effort.
    }
    writePersistedTemps(files)
    renamePersistedTemps(files, createdFinals, onRename)
  } catch {
    for (const file of files) fs.rmSync(file.temporary, { force: true })
    for (const file of createdFinals) fs.rmSync(file, { force: true })
    if (createdRunRoot) fs.rmSync(runRoot, { recursive: true, force: true })
    persistFail('atomic_write_failed')
  }
}

export function persistEvalRun(
  options: PersistEvalRunOptions,
): PersistedEvalRun {
  const manifest = normalizeRunManifest(options.manifest)
  const serializedManifest = serializeRunManifest(manifest)
  validateSerializedRunManifest(new TextEncoder().encode(serializedManifest))
  if (!Array.isArray(options.results)) persistFail('invalid_input')
  const normalizedResults = normalizePersistedResults(manifest, options.results)
  const runsRoot = path.resolve(
    options.runsRoot ??
      path.join(options.rootDir ?? REPO_ROOT, 'evals', 'runs'),
  )
  const runRoot = path.join(runsRoot, manifest.runId)
  assertEvalPathContained(runsRoot, runRoot)
  if (
    manifest.results.some(
      (summary) => summary.resultArtifactId === 'manifest.json',
    )
  ) {
    persistFail('invalid_input')
  }
  if (fs.existsSync(runRoot)) persistFail('run_exists')

  const pendingFiles = preparePendingPersistedFiles(runRoot, [
    ...normalizedResults.map((result) => ({
      relativeId: result.artifactId,
      bytes: Buffer.from(result.serialized),
    })),
    { relativeId: 'manifest.json', bytes: Buffer.from(serializedManifest) },
  ])
  writePersistedFiles(runsRoot, runRoot, pendingFiles, options.onRename)
  return {
    status: 'written',
    runId: manifest.runId,
    manifestArtifactId: 'manifest.json',
    resultArtifactIds: normalizedResults.map((result) => result.artifactId),
  }
}

function fixtureControlledPaths(fixture: EvalFixture): string[] {
  return [
    fixture.runRoot,
    fixture.caseRoot,
    fixture.modeRoot,
    fixture.projectRoot,
    fixture.homeRoot,
    fixture.xdgConfigRoot,
    fixture.xdgDataRoot,
    fixture.xdgCacheRoot,
    fixture.xdgStateRoot,
    fixture.opencodeConfigRoot,
    fixture.opencodeConfigPath,
    fixture.probeRoot,
    fixture.npmCacheRoot,
    fixture.npmPrefixRoot,
    fixture.npmUserConfigPath,
    fixture.artifactRoot,
    fixture.tarballPath,
    fixture.stagingRoot,
    fixture.packageRoot,
    fixture.provenanceRoot,
    fixture.tmpRoot,
  ]
}

function assertFixturePathsContained(fixture: EvalFixture): void {
  for (const controlledPath of fixtureControlledPaths(fixture)) {
    assertEvalPathContained(fixture.runRoot, controlledPath)
  }
}

export function createEvalFixture(
  options: CreateEvalFixtureOptions,
): EvalFixture {
  ensureSafeFixtureId(options.runId)

  const parentDir = path.resolve(options.parentDir ?? os.tmpdir())
  ensureDirectory(parentDir)
  const runRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(parentDir), 'systematic-eval-'),
  )
  const caseRoot = path.join(runRoot, options.caseId)
  const modeRoot = path.join(caseRoot, options.mode)
  const fixture: EvalFixture = {
    mode: options.mode,
    runRoot,
    caseRoot,
    modeRoot,
    projectRoot: path.join(modeRoot, 'project'),
    homeRoot: path.join(modeRoot, 'home'),
    xdgConfigRoot: path.join(modeRoot, 'xdg-config'),
    xdgDataRoot: path.join(modeRoot, 'xdg-data'),
    xdgCacheRoot: path.join(modeRoot, 'xdg-cache'),
    xdgStateRoot: path.join(modeRoot, 'xdg-state'),
    opencodeConfigRoot: path.join(modeRoot, 'opencode-config'),
    opencodeConfigPath: path.join(modeRoot, 'opencode-config', 'opencode.json'),
    probeRoot: path.join(modeRoot, 'probe'),
    npmCacheRoot: path.join(modeRoot, 'npm-cache'),
    npmPrefixRoot: path.join(modeRoot, 'npm-prefix'),
    npmUserConfigPath: path.join(modeRoot, 'npmrc'),
    artifactRoot: path.join(modeRoot, 'artifact'),
    tarballPath: path.join(modeRoot, 'artifact', 'package.tgz'),
    stagingRoot: path.join(modeRoot, 'artifact', 'staging'),
    packageRoot: path.join(modeRoot, 'package-root'),
    provenanceRoot: path.join(modeRoot, 'provenance'),
    tmpRoot: path.join(modeRoot, 'tmp'),
  }

  for (const directory of [
    fixture.caseRoot,
    fixture.modeRoot,
    fixture.projectRoot,
    fixture.homeRoot,
    fixture.xdgConfigRoot,
    fixture.xdgDataRoot,
    fixture.xdgCacheRoot,
    fixture.xdgStateRoot,
    fixture.opencodeConfigRoot,
    fixture.probeRoot,
    fixture.npmCacheRoot,
    fixture.npmPrefixRoot,
    fixture.artifactRoot,
    fixture.stagingRoot,
    fixture.packageRoot,
    fixture.provenanceRoot,
    fixture.tmpRoot,
  ]) {
    ensureDirectory(directory)
  }

  fs.writeFileSync(
    path.join(fixture.projectRoot, 'package.json'),
    JSON.stringify({
      name: 'systematic-eval-fixture',
      private: true,
      type: 'module',
    }),
  )
  fs.writeFileSync(fixture.npmUserConfigPath, '# isolated eval npm config\n')
  assertFixturePathsContained(fixture)
  return fixture
}

export function cleanupEvalFixture(fixture: EvalFixture): void {
  fs.rmSync(fixture.runRoot, { recursive: true, force: true })
}

interface CleanupResolution {
  cleanup: EvalCleanupState
  failureSubcode?: 'residue_detected' | 'quarantine_failed'
}

function uniqueQuarantineRoot(fixture: EvalFixture, runId: string): string {
  const parentDir = path.dirname(fixture.runRoot)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(
      parentDir,
      `systematic-eval-quarantine-${runId}-${randomUUID().replaceAll('-', '')}`,
    )
    assertEvalPathContained(parentDir, candidate)
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error('eval-cleanup:quarantine_target_unavailable')
}

async function cleanupCaseFixture(
  fixture: EvalFixture,
  runId: string,
  hooks: EvalLifecycleHooks | undefined,
): Promise<CleanupResolution> {
  let cleanupFailed = false
  try {
    if (hooks?.cleanupFixture) {
      await hooks.cleanupFixture(fixture)
    } else {
      cleanupEvalFixture(fixture)
    }
  } catch {
    cleanupFailed = true
  }

  if (!fs.existsSync(fixture.runRoot)) {
    return {
      cleanup: { status: 'clean', residue: 'none' },
      ...(cleanupFailed ? { failureSubcode: 'residue_detected' as const } : {}),
    }
  }

  let quarantineRoot: string
  try {
    quarantineRoot = uniqueQuarantineRoot(fixture, runId)
    if (hooks?.quarantineResidue) {
      await hooks.quarantineResidue(fixture, quarantineRoot)
    } else {
      fs.renameSync(fixture.runRoot, quarantineRoot)
    }
  } catch {
    return {
      cleanup: { status: 'residue', residue: 'detected' },
      failureSubcode: 'quarantine_failed',
    }
  }

  if (!fs.existsSync(fixture.runRoot) && fs.existsSync(quarantineRoot)) {
    return {
      cleanup: { status: 'quarantined', residue: 'quarantined' },
      failureSubcode: 'residue_detected',
    }
  }

  return {
    cleanup: { status: 'residue', residue: 'detected' },
    failureSubcode: 'quarantine_failed',
  }
}

function registerActiveEvalFixture(
  fixture: EvalFixture,
  runId: string,
  hooks: EvalLifecycleHooks | undefined,
): void {
  activeEvalFixtures.set(fixture, { fixture, runId, hooks })
}

function unregisterActiveEvalFixture(fixture: EvalFixture): void {
  activeEvalFixtures.delete(fixture)
}

async function cleanupRegisteredEvalFixture(
  fixture: EvalFixture,
  fallbackRunId: string,
  fallbackHooks: EvalLifecycleHooks | undefined,
): Promise<CleanupResolution> {
  const completed = completedFixtureCleanups.get(fixture)
  if (completed) return completed

  const registration = activeEvalFixtures.get(fixture)
  if (!registration) {
    const cleanup = await cleanupCaseFixture(
      fixture,
      fallbackRunId,
      fallbackHooks,
    )
    completedFixtureCleanups.set(fixture, cleanup)
    return cleanup
  }

  registration.cleanupPromise ??= cleanupCaseFixture(
    registration.fixture,
    registration.runId,
    registration.hooks,
  )
  const cleanup = await registration.cleanupPromise
  completedFixtureCleanups.set(fixture, cleanup)
  return cleanup
}

const MAX_NPM_TARBALL_BYTES = 128 * 1024 * 1024
const MAX_NPM_TAR_ENTRIES = 10_000

function artifactFailure(code: 'artifact_resolution' | 'path_escape'): never {
  throw new Error(`eval-artifact:${code}`)
}

function readTarText(
  header: Buffer,
  offset: number,
  length: number,
  allowEmpty = true,
): string {
  const bytes = header.subarray(offset, offset + length)
  const nulIndex = bytes.indexOf(0)
  const valueBytes = nulIndex === -1 ? bytes : bytes.subarray(0, nulIndex)
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(valueBytes)
  } catch {
    artifactFailure('artifact_resolution')
  }
  if (!allowEmpty && value.length === 0) artifactFailure('artifact_resolution')
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) artifactFailure('artifact_resolution')
  }
  return value
}

function readTarOctal(header: Buffer, offset: number, length: number): number {
  const raw = header
    .subarray(offset, offset + length)
    .toString('ascii')
    .replace(/\0.*$/, '')
    .trim()
  if (!/^[0-7]+$/.test(raw)) artifactFailure('artifact_resolution')
  const value = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(value) || value < 0) {
    artifactFailure('artifact_resolution')
  }
  return value
}

function validateTarPath(value: string, allowRoot: boolean): string {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^file:/i.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('//') ||
    value.startsWith('\\\\')
  ) {
    artifactFailure('path_escape')
  }
  const segments = value.split(/[\\/]/)
  if (
    segments.some((segment, index) => {
      if (segment === '' && index !== segments.length - 1) return true
      return segment === '.' || segment === '..'
    })
  ) {
    artifactFailure('path_escape')
  }
  if (segments[0] !== 'package') artifactFailure('path_escape')
  const relative = segments.slice(1).join('/')
  if (relative === '' && !allowRoot) artifactFailure('artifact_resolution')
  return relative.replace(/\/$/, '')
}

function isZeroTarBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false
  return true
}

function validateTarHeaderChecksum(header: Buffer): void {
  const stored = readTarOctal(header, 148, 8)
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  if (actual !== stored) artifactFailure('artifact_resolution')
}

function readNpmTarEntryType(typeFlag: number): 'file' | 'directory' {
  if (typeFlag === 0 || typeFlag === 0x30) return 'file'
  if (typeFlag === 0x35) return 'directory'
  artifactFailure('artifact_resolution')
}

function parseNpmTarEntry(
  archive: Buffer,
  offset: number,
): { entry: ValidatedNpmTarEntry; nextOffset: number } {
  const header = archive.subarray(offset, offset + 512)
  validateTarHeaderChecksum(header)
  if (header.toString('ascii', 257, 263) !== 'ustar\0') {
    artifactFailure('artifact_resolution')
  }
  const name = readTarText(header, 0, 100, false)
  const prefix = readTarText(header, 345, 155)
  const fullName = prefix.length > 0 ? `${prefix}/${name}` : name
  const type = readNpmTarEntryType(header[156])
  const relativePath = validateTarPath(fullName, type === 'directory')
  readTarText(header, 157, 100)
  const size = readTarOctal(header, 124, 12)
  const contentOffset = offset + 512
  if (size > MAX_NPM_TARBALL_BYTES || contentOffset + size > archive.length) {
    artifactFailure('artifact_resolution')
  }
  const nextOffset = contentOffset + Math.ceil(size / 512) * 512
  if (nextOffset > archive.length) artifactFailure('artifact_resolution')
  return {
    entry: {
      path: relativePath,
      type,
      content: Buffer.from(
        archive.subarray(contentOffset, contentOffset + size),
      ),
    },
    nextOffset,
  }
}

function appendNpmTarEntry(
  archive: Buffer,
  offset: number,
  entries: ValidatedNpmTarEntry[],
  names: Set<string>,
): number {
  if (entries.length >= MAX_NPM_TAR_ENTRIES) {
    artifactFailure('artifact_resolution')
  }
  const parsed = parseNpmTarEntry(archive, offset)
  if (names.has(parsed.entry.path)) artifactFailure('artifact_resolution')
  names.add(parsed.entry.path)
  entries.push(parsed.entry)
  return parsed.nextOffset
}

function readValidatedNpmTarEntries(archive: Buffer): ValidatedNpmTarEntry[] {
  const entries: ValidatedNpmTarEntry[] = []
  const names = new Set<string>()
  let offset = 0
  let zeroBlocks = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (isZeroTarBlock(header)) {
      zeroBlocks += 1
      offset += 512
      if (zeroBlocks >= 2) break
      continue
    }
    if (zeroBlocks > 0) {
      artifactFailure('artifact_resolution')
    }
    offset = appendNpmTarEntry(archive, offset, entries, names)
  }
  if (zeroBlocks < 2 || entries.length === 0) {
    artifactFailure('artifact_resolution')
  }
  for (; offset < archive.length; offset += 1) {
    if (archive[offset] !== 0) artifactFailure('artifact_resolution')
  }
  return entries
}

export function validateNpmTarball(tarballPath: string): ValidatedNpmTarball {
  let compressed: Buffer
  try {
    compressed = fs.readFileSync(tarballPath)
  } catch {
    artifactFailure('artifact_resolution')
  }
  if (compressed.length > MAX_NPM_TARBALL_BYTES) {
    artifactFailure('artifact_resolution')
  }

  let archive: Buffer
  try {
    archive = gunzipSync(compressed, {
      maxOutputLength: MAX_NPM_TARBALL_BYTES,
    })
  } catch {
    artifactFailure('artifact_resolution')
  }
  if (archive.length > MAX_NPM_TARBALL_BYTES) {
    artifactFailure('artifact_resolution')
  }

  return {
    digest: createHash('sha256').update(compressed).digest('hex'),
    entries: readValidatedNpmTarEntries(archive),
  }
}

function verifyExtractedPackageTree(
  packageRoot: string,
  allowSafeSymlinks = false,
): void {
  const canonicalRoot = fs.realpathSync(packageRoot)
  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      verifyExtractedEntry(
        path.join(directory, entry.name),
        canonicalRoot,
        allowSafeSymlinks,
      )
    }
  }

  function verifyExtractedEntry(
    entryPath: string,
    root: string,
    allowSymlink: boolean,
  ): void {
    const stat = fs.lstatSync(entryPath)
    if (stat.isSymbolicLink()) {
      if (!allowSymlink) artifactFailure('path_escape')
      if (!isContained(root, fs.realpathSync(entryPath))) {
        artifactFailure('path_escape')
      }
      return
    }
    if (!isContained(root, fs.realpathSync(entryPath))) {
      artifactFailure('path_escape')
    }
    if (stat.isDirectory()) {
      walk(entryPath)
      return
    }
    if (!stat.isFile()) artifactFailure('artifact_resolution')
  }

  walk(canonicalRoot)
}

export function extractValidatedNpmTarball(
  tarballPath: string,
  destination: string,
): void {
  const archive = validateNpmTarball(tarballPath)
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of archive.entries) {
    if (entry.path === '') continue
    const target = assertEvalPathContained(
      destination,
      path.join(destination, entry.path),
    )
    if (entry.type === 'directory') {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.content)
  }
  verifyExtractedPackageTree(destination)
}

function readInstalledPackageJson(packageRoot: string): {
  packageName: string
  packageVersion: string
} {
  const packageJsonPath = path.join(packageRoot, 'package.json')
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as unknown
  } catch {
    artifactFailure('artifact_resolution')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    artifactFailure('artifact_resolution')
  }
  const packageJson = value as Record<string, unknown>
  const packageName = packageJson.name
  const packageVersion = packageJson.version
  if (
    typeof packageName !== 'string' ||
    !/^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(packageName) ||
    typeof packageVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(packageVersion)
  ) {
    artifactFailure('artifact_resolution')
  }
  if (packageJson.main !== './dist/index.js') {
    artifactFailure('artifact_resolution')
  }
  const exportsValue = packageJson.exports
  if (
    !exportsValue ||
    typeof exportsValue !== 'object' ||
    Array.isArray(exportsValue)
  ) {
    artifactFailure('artifact_resolution')
  }
  const rootExport = (exportsValue as Record<string, unknown>)['.']
  if (
    !rootExport ||
    typeof rootExport !== 'object' ||
    Array.isArray(rootExport)
  ) {
    artifactFailure('artifact_resolution')
  }
  if ((rootExport as Record<string, unknown>).import !== './dist/index.js') {
    artifactFailure('artifact_resolution')
  }
  return { packageName, packageVersion }
}

function hasExternalNodeModulesFallback(value: string): boolean {
  if (path.basename(value) === 'node_modules') return true
  let current = path.dirname(value)
  while (true) {
    if (path.basename(current) === 'node_modules') return true
    try {
      if (fs.statSync(path.join(current, 'node_modules')).isDirectory()) {
        return true
      }
    } catch {
      // Missing or inaccessible fallback directories are not usable fallbacks.
    }
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

export function assertInstalledResolutionPath(
  packageRoot: string,
  candidate: string,
  checkoutRoot = REPO_ROOT,
): string {
  const canonicalPackageRoot = canonicalizePath(packageRoot)
  const canonicalCheckoutRoot = canonicalizePath(checkoutRoot)
  if (
    isContained(canonicalCheckoutRoot, canonicalPackageRoot) ||
    hasExternalNodeModulesFallback(canonicalPackageRoot)
  ) {
    artifactFailure('path_escape')
  }
  const canonicalCandidate = canonicalizePath(candidate)
  if (
    !isContained(canonicalPackageRoot, canonicalCandidate) ||
    isContained(canonicalCheckoutRoot, canonicalCandidate)
  ) {
    artifactFailure('path_escape')
  }
  return canonicalCandidate
}

export function resolveInstalledPluginEntry(
  packageRoot: string,
  checkoutRoot = REPO_ROOT,
): InstalledPluginEntry {
  const metadata = readInstalledPackageJson(packageRoot)
  const moduleEntry = assertInstalledResolutionPath(
    packageRoot,
    path.join(packageRoot, 'dist/index.js'),
    checkoutRoot,
  )
  try {
    if (!fs.lstatSync(moduleEntry).isFile()) {
      artifactFailure('artifact_resolution')
    }
  } catch {
    artifactFailure('artifact_resolution')
  }
  return {
    ...metadata,
    moduleEntry,
    moduleEntryId: 'dist/index.js',
  }
}

function installPackedArtifact(options: {
  rootDir: string
  fixture: EvalFixture
  sourceTarballPath: string
  expectedDigest?: string
}): InstalledArtifact {
  const { fixture, rootDir } = options
  const sourceTarballPath = path.resolve(options.sourceTarballPath)
  const tarballPath = fixture.tarballPath
  assertFixturePathsContained(fixture)
  assertEvalPathContained(path.dirname(sourceTarballPath), sourceTarballPath)
  if (
    isContained(canonicalizePath(rootDir), canonicalizePath(sourceTarballPath))
  ) {
    artifactFailure('path_escape')
  }
  assertEvalPathContained(fixture.artifactRoot, tarballPath)
  if (sourceTarballPath !== tarballPath) {
    fs.copyFileSync(sourceTarballPath, tarballPath, fs.constants.COPYFILE_EXCL)
  }
  if (!fs.existsSync(tarballPath)) artifactFailure('artifact_resolution')
  const archive = validateNpmTarball(tarballPath)
  if (
    options.expectedDigest !== undefined &&
    archive.digest !== options.expectedDigest
  ) {
    artifactFailure('artifact_resolution')
  }

  const buildEnv = buildEvalChildEnv({
    fixture,
    configContent: '{}',
    modelBaseUrl: 'http://127.0.0.1:1/v1',
  })
  extractValidatedNpmTarball(tarballPath, fixture.stagingRoot)
  fs.rmSync(fixture.packageRoot, { recursive: true, force: true })
  fs.renameSync(fixture.stagingRoot, fixture.packageRoot)
  fs.mkdirSync(fixture.stagingRoot, { recursive: true })
  const install = spawnSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      '--omit=dev',
    ],
    {
      cwd: fixture.packageRoot,
      env: buildEnv,
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
  if (install.error || install.status !== 0) {
    artifactFailure('artifact_resolution')
  }
  verifyExtractedPackageTree(fixture.packageRoot, true)
  const plugin = resolveInstalledPluginEntry(fixture.packageRoot, rootDir)
  return {
    ...plugin,
    tarballPath,
    tarballDigest: archive.digest,
    packageRoot: fixture.packageRoot,
    packageRootId: 'installed-package-root',
    configEntryId: 'installed-config',
  }
}

export function packInstalledArtifact(options: {
  rootDir: string
  fixture: EvalFixture
}): InstalledArtifact {
  const { fixture, rootDir } = options
  assertFixturePathsContained(fixture)
  assertEvalPathContained(rootDir, path.join(rootDir, 'dist/index.js'))
  const buildEnv = buildEvalChildEnv({
    fixture,
    configContent: '{}',
    modelBaseUrl: 'http://127.0.0.1:1/v1',
  })
  const build = spawnSync('bun', ['run', 'build'], {
    cwd: rootDir,
    env: buildEnv,
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (build.error || build.status !== 0) {
    artifactFailure('artifact_resolution')
  }
  const pack = spawnSync(
    'npm',
    [
      'pack',
      '--ignore-scripts',
      '--pack-destination',
      fixture.artifactRoot,
      '--silent',
    ],
    {
      cwd: rootDir,
      env: buildEnv,
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
  if (pack.error || pack.status !== 0) {
    artifactFailure('artifact_resolution')
  }
  const tarballName = pack.stdout.trim().split(/\r?\n/).at(-1)
  if (!tarballName || path.basename(tarballName) !== tarballName) {
    artifactFailure('artifact_resolution')
  }
  const packedTarballPath = assertEvalPathContained(
    fixture.artifactRoot,
    path.join(fixture.artifactRoot, tarballName),
  )
  if (!fs.existsSync(packedTarballPath)) artifactFailure('artifact_resolution')
  if (packedTarballPath !== fixture.tarballPath) {
    fs.renameSync(packedTarballPath, fixture.tarballPath)
  }
  const archive = validateNpmTarball(fixture.tarballPath)
  return installPackedArtifact({
    rootDir,
    fixture,
    sourceTarballPath: fixture.tarballPath,
    expectedDigest: archive.digest,
  })
}

export function buildEvalChildEnv(
  options: EvalChildEnvOptions,
): Record<string, string> {
  const parentPath = options.parentEnv?.PATH ?? EXECUTION_PATH
  return {
    PATH: parentPath,
    HOME: options.fixture.homeRoot,
    LANG: 'C',
    LC_ALL: 'C',
    LC_CTYPE: 'C',
    TZ: 'UTC',
    TERM: 'dumb',
    NO_COLOR: '1',
    TMPDIR: options.fixture.tmpRoot,
    TMP: options.fixture.tmpRoot,
    TEMP: options.fixture.tmpRoot,
    XDG_CONFIG_HOME: options.fixture.xdgConfigRoot,
    XDG_DATA_HOME: options.fixture.xdgDataRoot,
    XDG_CACHE_HOME: options.fixture.xdgCacheRoot,
    XDG_STATE_HOME: options.fixture.xdgStateRoot,
    OPENCODE_CONFIG_DIR: options.fixture.opencodeConfigRoot,
    OPENCODE_CONFIG_CONTENT: options.configContent,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_PRUNE: '1',
    NPM_CONFIG_CACHE: options.fixture.npmCacheRoot,
    npm_config_cache: options.fixture.npmCacheRoot,
    npm_config_prefix: options.fixture.npmPrefixRoot,
    NPM_CONFIG_USERCONFIG: options.fixture.npmUserConfigPath,
    npm_config_update_notifier: 'false',
    EVAL_MODEL_BASE_URL: options.modelBaseUrl,
  }
}

export function capturePrimaryCheckout(
  rootDir = REPO_ROOT,
): PrimaryCheckoutIdentity {
  const status = spawnSync(
    'git',
    ['status', '--short', '--untracked-files=all'],
    { cwd: rootDir, encoding: 'utf8' },
  )
  if (status.status !== 0) throw new Error('eval-git:identity_unavailable')
  const sourcePath = path.join(rootDir, 'src/index.ts')
  return {
    status: status.stdout.trim(),
    sourceDigest: sha256File(sourcePath, 'missing-source-entry'),
  }
}

function readGitCommitId(rootDir: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8',
  })
  const value = result.status === 0 ? result.stdout.trim() : ''
  return /^[a-f0-9]{40}$/.test(value)
    ? value
    : sha256Text(`commit:${rootDir}`).slice(0, 40)
}

function readCaseManifest(rootDir: string, caseId: CaseId): EvalCaseManifest {
  const filePath = path.join(
    rootDir,
    'evals',
    'cases',
    'opencode',
    `${caseId}.json`,
  )
  return parseCaseManifest(
    JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown,
  )
}

function extractVersion(output: string): string | undefined {
  const matches = output.match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/g)
  return matches?.at(-1)
}

export function verifyExactOpencodeRuntime(options: {
  fixture: EvalFixture
  parentEnv?: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
}): ExactOpencodeRuntime {
  const env = buildEvalChildEnv({
    fixture: options.fixture,
    configContent: '{}',
    modelBaseUrl: 'http://127.0.0.1:1/v1',
    parentEnv: options.parentEnv,
  })
  const result = spawnSync(
    'npx',
    ['--yes', `opencode-ai@${EXPECTED_OPENCODE_VERSION}`, '--version'],
    {
      cwd: options.fixture.projectRoot,
      env,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 300_000,
    },
  )
  if (result.error || result.status !== 0) {
    return {
      status: 'unavailable',
      expectedVersion: EXPECTED_OPENCODE_VERSION,
    }
  }
  const reportedVersion = extractVersion(result.stdout)
  if (!reportedVersion) {
    return {
      status: 'unavailable',
      expectedVersion: EXPECTED_OPENCODE_VERSION,
    }
  }
  return {
    status:
      reportedVersion === EXPECTED_OPENCODE_VERSION ? 'available' : 'mismatch',
    expectedVersion: EXPECTED_OPENCODE_VERSION,
    reportedVersion,
  }
}

function failedExecution(
  subcode: EvalSubcode,
  probeDigest = ZERO_DIGEST,
): EvalCaseExecution {
  return {
    outcome: 'infra_failure',
    subcode,
    sanity: 'failed',
    process: 'failed',
    probeDigest,
    artifactRefs: ['probe/events.jsonl'],
  }
}

function cleanupFailureExecution(
  probeDigest: string,
  subcode: 'residue_detected' | 'quarantine_failed' = 'residue_detected',
): EvalCaseExecution {
  return {
    outcome: 'privacy_cleanup_failure',
    subcode,
    sanity: 'failed',
    process: 'failed',
    probeDigest,
    artifactRefs: ['probe/events.jsonl'],
  }
}

function classifySetupError(error: unknown): EvalCaseExecution {
  if (error instanceof Error && error.message === 'eval-path:path_escape') {
    return failedExecution('path_escape')
  }
  return failedExecution('case_setup')
}

function classifyArtifactError(error: unknown): EvalCaseExecution {
  if (error instanceof Error && error.message.includes('path_escape')) {
    return failedExecution('path_escape')
  }
  return failedExecution('artifact_resolution')
}

function createEvalRunId(): string {
  return `run-${randomUUID().replaceAll('-', '')}`
}

interface EvalResultBuilderInput {
  rootDir: string
  caseManifest: EvalCaseManifest
  runId: string
  fixtureSeed: string
  normalizedClock: string
  runtime: ExactOpencodeRuntime
  execution: EvalCaseExecution
  cleanup: EvalCleanupState
  artifact?: InstalledArtifact
}

function buildResultEnvelope(input: {
  caseManifest: EvalCaseManifest
  mode: EvalMode
  runId: string
  fixtureSeed: string
  normalizedClock: string
  runtime: ExactOpencodeRuntime
  execution: EvalCaseExecution
  cleanup: EvalCleanupState
  artifactId: string
  artifactDigest: string
  provenance: SourceProvenance | InstalledProvenance
}): EvalResult {
  const runtimeVersion =
    input.runtime.reportedVersion ?? EXPECTED_OPENCODE_VERSION
  const result: Record<string, unknown> = {
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    caseSchemaVersion: CASE_SCHEMA_VERSION,
    caseId: input.caseManifest.caseId,
    harness: HARNESS,
    mode: input.mode,
    outcome: input.execution.outcome,
    subcode: input.execution.subcode,
    runId: input.runId,
    fixtureSeed: input.fixtureSeed,
    normalizedClock: input.normalizedClock,
    assertionIds: input.caseManifest.assertionIds,
    identity: {
      opencodeVersion: runtimeVersion,
      opencodeBuildId:
        input.runtime.status === 'available'
          ? `opencode-ai-${EXPECTED_OPENCODE_VERSION}`
          : 'opencode-runtime-unavailable',
      probeId: 'systematic-eval-probe-v3',
      probeDigest: input.execution.probeDigest,
      fixtureContractVersion: FIXTURE_CONTRACT_VERSION,
      fixtureContractDigest: FIXTURE_CONTRACT_DIGEST,
      caseSchemaVersion: CASE_SCHEMA_VERSION,
      resultSchemaVersion: RESULT_SCHEMA_VERSION,
      artifactId: input.artifactId,
      artifactDigest: input.artifactDigest,
    },
    evidence: {
      sanity: input.execution.sanity,
      process: input.execution.process,
      assertionIds: input.caseManifest.assertionIds,
      ...(input.execution.promptComposition
        ? { promptComposition: input.execution.promptComposition }
        : {}),
      ...(input.execution.hostCatalogCoverage
        ? { hostCatalogCoverage: input.execution.hostCatalogCoverage }
        : {}),
      ...(input.caseManifest.caseId === 'model-inheritance'
        ? { modelInheritance: input.execution.modelInheritance ?? [] }
        : input.execution.modelInheritance
          ? { modelInheritance: input.execution.modelInheritance }
          : {}),
    },
    cleanup: input.cleanup,
    privacy: { status: 'validated' },
    artifactRefs: input.execution.artifactRefs,
    provenance: input.provenance,
  }
  return normalizeResult(result)
}

function buildSourceResult(input: EvalResultBuilderInput): EvalResult {
  const sourceEntry = path.join(input.rootDir, 'src', 'index.ts')
  const artifactDigest = sha256File(sourceEntry, 'missing-source-entry')
  const commitId = readGitCommitId(input.rootDir)
  const worktreeId = sha256Text(`worktree:${input.rootDir}`).slice(0, 32)
  return buildResultEnvelope({
    ...input,
    mode: 'source',
    artifactId: 'source-entry',
    artifactDigest,
    provenance: {
      kind: 'source',
      checkoutRelativeSource: 'src/index.ts',
      commitId,
      worktreeId,
      canonicalSourceEntryId: 'source-entry',
      opencodeConfigEntryId: 'source-config',
    },
  })
}

function buildInstalledResult(input: EvalResultBuilderInput): EvalResult {
  const artifact = input.artifact
  return buildResultEnvelope({
    ...input,
    mode: 'installed',
    artifactId: 'installed-entry',
    artifactDigest: artifact?.tarballDigest ?? ZERO_DIGEST,
    provenance: {
      kind: 'installed',
      packageName: artifact?.packageName ?? '@fro.bot/systematic',
      packageVersion: artifact?.packageVersion ?? '0.0.0-semantic-release',
      tarballDigest: artifact?.tarballDigest ?? ZERO_DIGEST,
      extractedPackageRootId:
        artifact?.packageRootId ?? 'installed-package-root',
      canonicalResolvedModuleEntryId:
        artifact?.moduleEntryId ?? 'dist/index.js',
      opencodeConfigEntryId: artifact?.configEntryId ?? 'installed-config',
    },
  })
}

async function executeInstalledArtifactCase(input: {
  fixture: EvalFixture
  artifact: InstalledArtifact
  caseManifest: EvalCaseManifest
  timeoutMs?: number
  caseTimeoutMs?: number
}): Promise<{ runtime: ExactOpencodeRuntime; execution: EvalCaseExecution }> {
  const runtime = verifyExactOpencodeRuntime({
    fixture: input.fixture,
    parentEnv: process.env,
    timeoutMs: input.timeoutMs,
  })
  if (runtime.status !== 'available') {
    return {
      runtime,
      execution: failedExecution(
        runtime.status === 'mismatch'
          ? 'identity_drift'
          : 'opencode_unavailable',
      ),
    }
  }
  try {
    const installedModule = (await import(
      pathToFileURL(input.artifact.moduleEntry).href
    )) as { default?: unknown }
    if (typeof installedModule.default !== 'function') {
      return { runtime, execution: failedExecution('artifact_resolution') }
    }
  } catch {
    return { runtime, execution: failedExecution('artifact_resolution') }
  }
  const { executeInstalledCase } = await import('./eval-cases/opencode.ts')
  return {
    runtime,
    execution: await executeInstalledCase({
      fixture: input.fixture,
      caseManifest: input.caseManifest,
      installedEntry: input.artifact.moduleEntry,
      parentEnv: process.env,
      timeoutMs: input.timeoutMs,
      caseTimeoutMs: input.caseTimeoutMs,
    }),
  }
}

async function executeLifecycleCase(
  hooks: EvalLifecycleHooks,
  mode: EvalMode,
  fixture: EvalFixture,
  caseManifest: EvalCaseManifest,
): Promise<EvalCaseExecution> {
  const executeCase = hooks.executeCase
  if (!executeCase) return failedExecution('case_setup')
  try {
    return await executeCase({ mode, fixture, caseManifest })
  } catch {
    return failedExecution(
      mode === 'source' ? 'case_setup' : 'artifact_resolution',
    )
  }
}

interface EvalStageInput {
  options: SourceEvalOptions
  fixture: EvalFixture
  caseManifest: EvalCaseManifest
  rootDir: string
}

interface EvalStageResult {
  runtime: ExactOpencodeRuntime
  execution: EvalCaseExecution
  artifact?: InstalledArtifact
}

type EvalStage = (input: EvalStageInput) => Promise<EvalStageResult>

type EvalResultBuilder = (input: EvalResultBuilderInput) => EvalResult

async function executeSourceStage(options: {
  options: SourceEvalOptions
  fixture: EvalFixture
  caseManifest: EvalCaseManifest
  rootDir: string
}): Promise<EvalStageResult> {
  assertEvalPathContained(
    options.rootDir,
    path.join(options.rootDir, 'src', 'index.ts'),
  )
  if (options.options.lifecycleHooks?.executeCase) {
    return {
      runtime: {
        status: 'available',
        expectedVersion: EXPECTED_OPENCODE_VERSION,
        reportedVersion: EXPECTED_OPENCODE_VERSION,
      },
      execution: await executeLifecycleCase(
        options.options.lifecycleHooks,
        'source',
        options.fixture,
        options.caseManifest,
      ),
    }
  }

  const runtime = verifyExactOpencodeRuntime({
    fixture: options.fixture,
    parentEnv: process.env,
    timeoutMs: options.options.timeoutMs,
  })
  if (runtime.status === 'unavailable') {
    return { runtime, execution: failedExecution('opencode_unavailable') }
  }
  if (runtime.status === 'mismatch') {
    return { runtime, execution: failedExecution('identity_drift') }
  }
  const { executeSourceCase } = await import('./eval-cases/opencode.ts')
  return {
    runtime,
    execution: await executeSourceCase({
      fixture: options.fixture,
      caseManifest: options.caseManifest,
      sourceEntry: assertEvalPathContained(
        options.rootDir,
        path.join(options.rootDir, 'src', 'index.ts'),
      ),
      parentEnv: process.env,
      timeoutMs: options.options.timeoutMs,
      caseTimeoutMs: options.options.caseTimeoutMs,
    }),
  }
}

async function executeInstalledStage(options: {
  options: SourceEvalOptions
  fixture: EvalFixture
  artifact: InstalledArtifact
  caseManifest: EvalCaseManifest
}): Promise<EvalStageResult> {
  if (options.options.lifecycleHooks?.executeCase) {
    return {
      runtime: {
        status: 'available',
        expectedVersion: EXPECTED_OPENCODE_VERSION,
        reportedVersion: EXPECTED_OPENCODE_VERSION,
      },
      execution: await executeLifecycleCase(
        options.options.lifecycleHooks,
        'installed',
        options.fixture,
        options.caseManifest,
      ),
    }
  }
  return executeInstalledArtifactCase({
    fixture: options.fixture,
    artifact: options.artifact,
    caseManifest: options.caseManifest,
    timeoutMs: options.options.timeoutMs,
    caseTimeoutMs: options.options.caseTimeoutMs,
  })
}

async function executeInstalledEvalStage(
  options: EvalStageInput,
): Promise<EvalStageResult> {
  const artifact = options.options.reusableArtifact
    ? installPackedArtifact({
        rootDir: options.rootDir,
        fixture: options.fixture,
        sourceTarballPath: options.options.reusableArtifact.tarballPath,
        expectedDigest: options.options.reusableArtifact.tarballDigest,
      })
    : packInstalledArtifact({
        rootDir: options.rootDir,
        fixture: options.fixture,
      })
  const stage = await executeInstalledStage({
    options: options.options,
    fixture: options.fixture,
    artifact,
    caseManifest: options.caseManifest,
  })
  return { ...stage, artifact }
}

async function runEvalLifecycle(
  options: SourceEvalOptions,
  mode: EvalMode,
  executeStage: EvalStage,
  buildResult: EvalResultBuilder,
): Promise<EvalResult> {
  const rootDir = path.resolve(options.rootDir ?? REPO_ROOT)
  const runId = options.runId ?? createEvalRunId()
  const caseManifest = readCaseManifest(rootDir, options.caseId)
  const before = capturePrimaryCheckout(rootDir)
  const runtime: ExactOpencodeRuntime = {
    status: 'unavailable',
    expectedVersion: EXPECTED_OPENCODE_VERSION,
  }
  let execution = failedExecution('case_setup')
  let cleanup: EvalCleanupState = { status: 'clean', residue: 'none' }
  let fixture: EvalFixture | undefined
  let artifact: InstalledArtifact | undefined

  try {
    fixture = createEvalFixture({
      caseId: options.caseId,
      mode,
      runId,
      parentDir: options.parentDir,
    })
    registerActiveEvalFixture(fixture, runId, options.lifecycleHooks)
    assertFixturePathsContained(fixture)

    const stage = await executeStage({
      options,
      fixture,
      caseManifest,
      rootDir,
    })
    Object.assign(runtime, stage.runtime)
    execution = stage.execution
    artifact = stage.artifact
  } catch (error) {
    execution =
      mode === 'source'
        ? classifySetupError(error)
        : classifyArtifactError(error)
  } finally {
    if (fixture) {
      const cleanupResult = await cleanupRegisteredEvalFixture(
        fixture,
        runId,
        options.lifecycleHooks,
      )
      cleanup = cleanupResult.cleanup
      if (cleanupResult.failureSubcode) {
        execution = cleanupFailureExecution(
          execution.probeDigest,
          cleanupResult.failureSubcode,
        )
      }
      unregisterActiveEvalFixture(fixture)
    }

    try {
      const after = capturePrimaryCheckout(rootDir)
      if (
        execution.outcome !== 'privacy_cleanup_failure' &&
        (after.status !== before.status ||
          after.sourceDigest !== before.sourceDigest)
      ) {
        execution = failedExecution(
          'primary_checkout_delta',
          execution.probeDigest,
        )
      }
    } catch {
      if (execution.outcome !== 'privacy_cleanup_failure') {
        execution = failedExecution(
          'primary_checkout_delta',
          execution.probeDigest,
        )
      }
    }
  }

  return buildResult({
    rootDir,
    caseManifest,
    runId,
    fixtureSeed: options.fixtureSeed,
    normalizedClock: options.normalizedClock,
    runtime,
    execution,
    cleanup,
    artifact,
  })
}

export async function runSourceEval(
  options: SourceEvalOptions,
): Promise<EvalResult> {
  return runEvalLifecycle(
    options,
    'source',
    executeSourceStage,
    buildSourceResult,
  )
}

export async function runInstalledEval(
  options: SourceEvalOptions,
): Promise<EvalResult> {
  return runEvalLifecycle(
    options,
    'installed',
    executeInstalledEvalStage,
    buildInstalledResult,
  )
}

function parseEvalSelectionId(selectionId: string): {
  caseId: CaseId
  mode: EvalMode
} {
  const separator = selectionId.indexOf('/')
  if (separator <= 0 || separator === selectionId.length - 1) {
    throw new Error('eval-run:invalid_selection')
  }
  const caseId = selectionId.slice(0, separator)
  const mode = selectionId.slice(separator + 1)
  if (!isCaseId(caseId) || !isEvalMode(mode)) {
    throw new Error('eval-run:invalid_selection')
  }
  return { caseId, mode }
}

function resultArtifactId(caseId: CaseId, mode: EvalMode): string {
  return `results/${caseId}/${mode}.json`
}

function isRunnerWideFailure(result: EvalResult): boolean {
  return (
    result.outcome === 'infra_failure' &&
    [
      'identity_drift',
      'path_escape',
      'primary_checkout_delta',
      'opencode_unavailable',
      'probe_unhealthy',
    ].includes(result.subcode ?? '')
  )
}

function isUnresolvedCleanupFailure(result: EvalResult): boolean {
  return (
    result.outcome === 'privacy_cleanup_failure' &&
    (result.subcode === 'quarantine_failed' ||
      result.cleanup.status === 'residue')
  )
}

function buildSelectionFailureResult(options: {
  caseId: CaseId
  mode: EvalMode
  runId: string
  fixtureSeed: string
  normalizedClock: string
  rootDir: string
  subcode: 'artifact_resolution' | 'path_escape' | 'case_setup'
}): EvalResult {
  const caseManifest = readCaseManifest(options.rootDir, options.caseId)
  const execution = failedExecution(options.subcode)
  const runtime: ExactOpencodeRuntime = {
    status: 'unavailable',
    expectedVersion: EXPECTED_OPENCODE_VERSION,
  }
  if (options.mode === 'source') {
    return buildSourceResult({
      rootDir: options.rootDir,
      caseManifest,
      runId: options.runId,
      fixtureSeed: options.fixtureSeed,
      normalizedClock: options.normalizedClock,
      runtime,
      execution,
      cleanup: { status: 'clean', residue: 'none' },
    })
  }
  return buildInstalledResult({
    caseManifest,
    runId: options.runId,
    fixtureSeed: options.fixtureSeed,
    normalizedClock: options.normalizedClock,
    runtime,
    execution,
    cleanup: { status: 'clean', residue: 'none' },
  })
}

interface ParsedEvalSelection {
  selectionId: string
  caseId: CaseId
  mode: EvalMode
}

interface EvalSelectionState {
  results: EvalResult[]
  reusableArtifact?: InstalledArtifact
  artifactFixture?: EvalFixture
  artifactCleanup?: CleanupResolution
  installedBlocked: boolean
  abortLaterSelections: boolean
}

type ArtifactPreparation =
  | {
      status: 'ready'
      fixture: EvalFixture
      artifact: InstalledArtifact
    }
  | {
      status: 'failed'
      fixture?: EvalFixture
      result: EvalResult
      abortLaterSelections: boolean
    }

function shouldSkipSelection(
  selection: ParsedEvalSelection,
  state: EvalSelectionState,
): boolean {
  return (
    state.abortLaterSelections ||
    (selection.mode === 'installed' && state.installedBlocked)
  )
}

function prepareInstalledArtifact(options: {
  selection: ParsedEvalSelection
  runId: string
  rootDir: string
  parentDir?: string
  fixtureSeed: string
  normalizedClock: string
  packer: (options: {
    rootDir: string
    fixture: EvalFixture
  }) => InstalledArtifact
}): ArtifactPreparation {
  let fixture: EvalFixture | undefined
  try {
    fixture = createEvalFixture({
      caseId: options.selection.caseId,
      mode: 'installed',
      runId: `${options.runId}-pack`,
      parentDir: options.parentDir,
    })
    return {
      status: 'ready',
      fixture,
      artifact: options.packer({ rootDir: options.rootDir, fixture }),
    }
  } catch (error) {
    const pathEscape =
      error instanceof Error && error.message.includes('path_escape')
    return {
      status: 'failed',
      fixture,
      result: buildSelectionFailureResult({
        caseId: options.selection.caseId,
        mode: 'installed',
        runId: options.runId,
        fixtureSeed: options.fixtureSeed,
        normalizedClock: options.normalizedClock,
        rootDir: options.rootDir,
        subcode: pathEscape ? 'path_escape' : 'artifact_resolution',
      }),
      abortLaterSelections: pathEscape,
    }
  }
}

function selectionRunnerOptions(
  options: EvalSelectionRunnerOptions,
  selection: ParsedEvalSelection,
  runId: string,
  reusableArtifact: InstalledArtifact | undefined,
): EvalSelectionRunnerInput {
  return {
    mode: selection.mode,
    caseId: selection.caseId,
    fixtureSeed: options.fixtureSeed,
    normalizedClock: options.normalizedClock,
    runId,
    parentDir: options.parentDir,
    rootDir: path.resolve(options.rootDir ?? REPO_ROOT),
    timeoutMs: options.timeoutMs,
    caseTimeoutMs: options.caseTimeoutMs,
    ...(selection.mode === 'installed' && reusableArtifact
      ? { reusableArtifact }
      : {}),
  }
}

async function executeEvalSelection(options: {
  config: EvalSelectionRunnerOptions
  selection: ParsedEvalSelection
  runId: string
  reusableArtifact?: InstalledArtifact
}): Promise<EvalResult> {
  const runnerOptions = selectionRunnerOptions(
    options.config,
    options.selection,
    options.runId,
    options.reusableArtifact,
  )
  const runner =
    options.selection.mode === 'source'
      ? (options.config.sourceRunner ?? runSourceEval)
      : (options.config.installedRunner ?? runInstalledEval)
  try {
    return normalizeResult(await runner(runnerOptions))
  } catch {
    return buildSelectionFailureResult({
      caseId: options.selection.caseId,
      mode: options.selection.mode,
      runId: options.runId,
      fixtureSeed: options.config.fixtureSeed,
      normalizedClock: options.config.normalizedClock,
      rootDir: path.resolve(options.config.rootDir ?? REPO_ROOT),
      subcode:
        options.selection.mode === 'source'
          ? 'case_setup'
          : 'artifact_resolution',
    })
  }
}

function updateSelectionState(
  state: EvalSelectionState,
  selection: ParsedEvalSelection,
  result: EvalResult,
): void {
  if (
    selection.mode === 'installed' &&
    result.subcode === 'artifact_resolution'
  ) {
    state.installedBlocked = true
  }
  if (isRunnerWideFailure(result) || isUnresolvedCleanupFailure(result)) {
    state.abortLaterSelections = true
  }
}

function convertArtifactDependentResults(
  results: readonly EvalResult[],
  cleanup: CleanupResolution,
): EvalResult[] {
  if (!cleanup.failureSubcode) return [...results]
  return results.map((result) => {
    if (result.mode !== 'installed') return result
    return normalizeResult({
      ...result,
      outcome: 'privacy_cleanup_failure',
      subcode: cleanup.failureSubcode,
      evidence: {
        ...result.evidence,
        sanity: 'failed',
        process: 'failed',
      },
      cleanup: cleanup.cleanup,
    })
  })
}

async function cleanupSharedArtifact(
  state: EvalSelectionState,
  runId: string,
  hooks: EvalSelectionRunnerOptions['artifactCleanupHooks'],
): Promise<void> {
  if (!state.artifactFixture || state.artifactCleanup) return
  const fixture = state.artifactFixture
  const cleanup = await cleanupRegisteredEvalFixture(
    fixture,
    `${runId}-pack`,
    hooks,
  )
  state.artifactCleanup = cleanup
  if (cleanup.failureSubcode && state.reusableArtifact) {
    state.results = convertArtifactDependentResults(state.results, cleanup)
  }
  if (
    cleanup.failureSubcode === 'quarantine_failed' ||
    cleanup.cleanup.status === 'residue'
  ) {
    state.abortLaterSelections = true
  }
  unregisterActiveEvalFixture(fixture)
  state.artifactFixture = undefined
  state.reusableArtifact = undefined
}

function buildEvalRunManifest(
  runId: string,
  requestedSelectionIds: readonly string[],
  results: readonly EvalResult[],
): EvalRunManifest {
  const completedSelectionIds = results
    .map((result) => selectionIdFor(result.caseId, result.mode))
    .sort()
  return {
    manifestSchemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    harness: HARNESS,
    runId,
    requestedSelectionIds: [...requestedSelectionIds],
    completedSelectionIds,
    partial: completedSelectionIds.length !== requestedSelectionIds.length,
    results: results
      .map((result) => ({
        selectionId: selectionIdFor(result.caseId, result.mode),
        resultArtifactId: resultArtifactId(result.caseId, result.mode),
        outcome: result.outcome,
        subcode: result.subcode ?? 'none',
      }))
      .sort((left, right) => left.selectionId.localeCompare(right.selectionId)),
  }
}

function lastInstalledSelectionIndex(
  selections: readonly ParsedEvalSelection[],
): number {
  let lastIndex = -1
  for (let index = 0; index < selections.length; index += 1) {
    if (selections[index]?.mode === 'installed') lastIndex = index
  }
  return lastIndex
}

function prepareSelectionArtifact(options: {
  config: EvalSelectionRunnerOptions
  selection: ParsedEvalSelection
  runId: string
  rootDir: string
  state: EvalSelectionState
  packer: (options: {
    rootDir: string
    fixture: EvalFixture
  }) => InstalledArtifact
}): boolean {
  if (
    options.selection.mode !== 'installed' ||
    options.state.reusableArtifact
  ) {
    return true
  }
  const preparation = prepareInstalledArtifact({
    selection: options.selection,
    runId: options.runId,
    rootDir: options.rootDir,
    parentDir: options.config.parentDir,
    fixtureSeed: options.config.fixtureSeed,
    normalizedClock: options.config.normalizedClock,
    packer: options.packer,
  })
  options.state.artifactFixture = preparation.fixture
  if (preparation.fixture) {
    registerActiveEvalFixture(
      preparation.fixture,
      `${options.runId}-pack`,
      options.config.artifactCleanupHooks,
    )
  }
  if (preparation.status === 'failed') {
    options.state.results.push(preparation.result)
    options.state.abortLaterSelections ||= preparation.abortLaterSelections
    if (!preparation.abortLaterSelections) options.state.installedBlocked = true
    return false
  }
  options.state.reusableArtifact = preparation.artifact
  return true
}

async function executeSelectionIteration(options: {
  config: EvalSelectionRunnerOptions
  selection: ParsedEvalSelection
  runId: string
  rootDir: string
  state: EvalSelectionState
  packer: (options: {
    rootDir: string
    fixture: EvalFixture
  }) => InstalledArtifact
}): Promise<void> {
  if (shouldSkipSelection(options.selection, options.state)) return
  if (
    !prepareSelectionArtifact({
      config: options.config,
      selection: options.selection,
      runId: options.runId,
      rootDir: options.rootDir,
      state: options.state,
      packer: options.packer,
    })
  ) {
    return
  }
  const result = await executeEvalSelection({
    config: options.config,
    selection: options.selection,
    runId: options.runId,
    reusableArtifact: options.state.reusableArtifact,
  })
  options.state.results.push(result)
  updateSelectionState(options.state, options.selection, result)
}

async function executeSelectionLoop(options: {
  config: EvalSelectionRunnerOptions
  selections: readonly ParsedEvalSelection[]
  runId: string
  rootDir: string
  state: EvalSelectionState
  packer: (options: {
    rootDir: string
    fixture: EvalFixture
  }) => InstalledArtifact
}): Promise<void> {
  const { state } = options
  const lastInstalledIndex = lastInstalledSelectionIndex(options.selections)

  for (let index = 0; index < options.selections.length; index += 1) {
    const selection = options.selections[index]
    if (!selection) continue
    if (isEvalInterrupted()) {
      state.abortLaterSelections = true
      break
    }
    await executeSelectionIteration({
      config: options.config,
      selection,
      runId: options.runId,
      rootDir: options.rootDir,
      state,
      packer: options.packer,
    })

    if (index === lastInstalledIndex) {
      await cleanupSharedArtifact(
        state,
        options.runId,
        options.config.artifactCleanupHooks,
      )
    }
  }
}

export async function runEvalSelections(
  options: EvalSelectionRunnerOptions,
): Promise<EvalRunExecution> {
  const rootDir = path.resolve(options.rootDir ?? REPO_ROOT)
  const runId = options.runId ?? createEvalRunId()
  ensureSafeFixtureId(runId)
  const requestedSelectionIds = [...new Set(options.selectionIds)].sort()
  if (requestedSelectionIds.length === 0) {
    throw new Error('eval-run:invalid_selection')
  }
  const selections = requestedSelectionIds.map((selectionId) => ({
    selectionId,
    ...parseEvalSelectionId(selectionId),
  }))
  const packer = options.packInstalledArtifact ?? packInstalledArtifact
  const state: EvalSelectionState = {
    results: [],
    installedBlocked: false,
    abortLaterSelections: false,
  }

  try {
    await executeSelectionLoop({
      config: options,
      selections,
      runId,
      rootDir,
      state,
      packer,
    })
  } finally {
    if (state.artifactFixture) {
      await cleanupSharedArtifact(state, runId, options.artifactCleanupHooks)
    }
  }

  const manifest = buildEvalRunManifest(
    runId,
    requestedSelectionIds,
    state.results,
  )
  const persisted = persistEvalRun({
    manifest,
    results: state.results,
    runsRoot: options.runsRoot,
    rootDir,
  })
  return {
    runId,
    manifest: normalizeRunManifest(manifest),
    results: state.results,
    persisted,
  }
}

function safeCliErrorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  const match = message.match(/^((?:eval-cli|eval-run|eval-persist):[a-z_]+)$/)
  return match?.[1] ?? fallback
}

function evalRunExitCode(run: EvalRunExecution): 0 | 1 {
  return !run.manifest.partial &&
    run.results.length === run.manifest.requestedSelectionIds.length &&
    run.results.every((result) => result.outcome === 'success')
    ? 0
    : 1
}

export async function runEvalCli(
  argv: readonly string[],
  overrides: EvalCliOptionsOverride = {},
): Promise<EvalCliRunResult> {
  let parsed: EvalCliParseResult
  try {
    parsed = parseEvalCliArgs(argv)
  } catch (error) {
    return {
      kind: 'error',
      exitCode: 2,
      code: safeCliErrorCode(error, 'eval-cli:invalid_arguments'),
      usage: CLI_USAGE,
    }
  }
  if ('help' in parsed) {
    return { kind: 'help', exitCode: 0, usage: parsed.usage }
  }

  try {
    const run = await runEvalSelections({
      selectionIds: parsed.selectionIds,
      fixtureSeed: parsed.fixtureSeed,
      normalizedClock: parsed.normalizedClock,
      runId: overrides.runId,
      parentDir: overrides.parentDir,
      rootDir: overrides.rootDir,
      runsRoot: overrides.runsRoot,
      timeoutMs: overrides.timeoutMs,
      caseTimeoutMs: overrides.caseTimeoutMs,
      sourceRunner: overrides.sourceRunner,
      installedRunner: overrides.installedRunner,
      packInstalledArtifact: overrides.packInstalledArtifact,
    })
    return { kind: 'run', exitCode: evalRunExitCode(run), run }
  } catch (error) {
    return {
      kind: 'error',
      exitCode: 1,
      code: safeCliErrorCode(error, 'eval-run:execution_failed'),
    }
  }
}

function printEvalCliResult(result: EvalCliRunResult): void {
  if (result.kind === 'help') {
    console.log(result.usage)
    return
  }
  if (result.kind === 'error') {
    console.error(
      JSON.stringify({
        status: 'error',
        exitCode: result.exitCode,
        code: result.code,
        ...(result.usage ? { usage: result.usage } : {}),
      }),
    )
    process.exitCode = result.exitCode
    return
  }
  console.log(
    JSON.stringify({
      status: 'written',
      exitCode: result.exitCode,
      runId: result.run.runId,
      manifestArtifactId: `evals/runs/${result.run.runId}/manifest.json`,
      requestedCount: result.run.manifest.requestedSelectionIds.length,
      completedCount: result.run.manifest.completedSelectionIds.length,
      partial: result.run.manifest.partial,
    }),
  )
  process.exitCode = result.exitCode
}

async function cleanupInterruptedEval(): Promise<void> {
  try {
    const resources = await import('./eval-cases/opencode.ts')
    await resources.stopActiveEvalResources()
  } catch {
    // The bounded force-exit timer remains the final cleanup guard.
  }
  for (const registration of [...activeEvalFixtures.values()]) {
    try {
      await cleanupRegisteredEvalFixture(
        registration.fixture,
        registration.runId,
        registration.hooks,
      )
    } catch {
      // The bounded force-exit timer remains the final cleanup guard.
    } finally {
      unregisterActiveEvalFixture(registration.fixture)
    }
  }
}

export function installEvalSignalHandlers(): () => void {
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (interruptionSignal) return
    interruptionSignal = signal
    process.exitCode = 1
    const forceExit = setTimeout(() => process.exit(1), 7_500)
    forceExit.unref()
    interruptionCleanup = cleanupInterruptedEval().finally(() => {
      clearTimeout(forceExit)
    })
  }
  const onSigint = (): void => handleSignal('SIGINT')
  const onSigterm = (): void => handleSignal('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  return () => {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    interruptionSignal = undefined
    interruptionCleanup = undefined
  }
}

function printInterruptedEvalResult(result: EvalCliRunResult): void {
  const runId = result.kind === 'run' ? result.run.runId : undefined
  console.log(
    JSON.stringify({
      status: 'interrupted',
      exitCode: 1,
      ...(runId
        ? {
            runId,
            manifestArtifactId: `evals/runs/${runId}/manifest.json`,
          }
        : {}),
    }),
  )
  process.exitCode = 1
}

async function main(): Promise<void> {
  const removeSignalHandlers = installEvalSignalHandlers()
  try {
    const result = await runEvalCli(process.argv.slice(2))
    if (interruptionCleanup) await interruptionCleanup
    if (interruptionSignal) {
      printInterruptedEvalResult(result)
    } else {
      printEvalCliResult(result)
    }
  } finally {
    removeSignalHandlers()
  }
}

if (import.meta.main) {
  void main().catch(() => {
    console.error(
      JSON.stringify({
        status: 'error',
        exitCode: 1,
        code: 'eval-run:execution_failed',
      }),
    )
    process.exitCode = 1
  })
}
