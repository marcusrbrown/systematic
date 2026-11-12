/**
 * Import for `ce:connect`: take the run record of a scheduled run, which names
 * projects by the paths of a runner that no longer exists, and re-check every
 * candidate in it against the operator's own checkouts.
 *
 * Trust: the record is untrusted input, downloaded by the skill and handed over
 * as a directory. This module opens `run.json` in it and nothing else. Nothing
 * the record says is believed. A project is matched by its recorded `owner/repo`
 * to exactly one allowed local checkout. The rule id, the roles, the target
 * root and the candidate id are computed again from local roots, and every
 * fingerprint, excerpt and cited span is checked against the local files by the
 * same `checkCandidate` a local run uses. The recorded id is checked only to
 * detect a record that was edited, and is never used.
 *
 * Import rule: node builtins and the `connect-*` modules. The `ce:connect`
 * helper bundles this module, so it must never import zod, `config.ts` or
 * `config-schema.ts`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { readContainedFile } from './connect-evidence.js'
import {
  CANDIDATE_LIMITS,
  checkCandidate,
  type DigestCandidate,
  handoffLine,
  inline,
  isPasteablePath,
  nameDropped,
  type ProjectFacts,
  pathProblem,
  projectKey,
  quote,
  renderCandidate,
  ruleIdFor,
  sanitizeText,
  toCandidateRecord,
  type ValidationContext,
  type ValidCandidate,
} from './connect-helper-core.js'
import { type CandidateRecord, candidateIdentity } from './connect-state.js'

// ── The record ──────────────────────────────────────────────────────────────

/** The record's fixed place in the downloaded directory. */
export const IMPORT_RECORD_FILE = 'run.json'
export const MAX_IMPORT_RECORD_BYTES = 2 * 1024 * 1024

const MAX_IMPORT_PROJECTS = 64
const MAX_IMPORT_CANDIDATES = 200
const MAX_ROOT_LENGTH = 4096

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const REPO_SLUG = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const CANDIDATE_ID = /^[0-9a-f]{64}$/
const CONTROL = /[\p{Cc}\p{Cf}]/u
const CORPUS_PATH = /^docs\/(?:solutions|plans|brainstorms)\//

/** Why a downloaded record cannot be used at all. */
export type RecordFailure =
  | 'directory-unreadable'
  | 'record-missing'
  | 'record-symlink'
  | 'record-not-regular'
  | 'record-too-large'
  | 'record-unreadable'
  | 'record-malformed'
  | 'record-schema-version'

/** A project of the run as the record names it. */
export interface ImportProject {
  readonly root: string
  readonly key: string
  readonly name: string
  readonly repo?: string
  readonly commit?: string
}

export interface ImportRecord {
  /** The run's own id, from the record. */
  readonly runId: string
  readonly projects: readonly ImportProject[]
  /** Each candidate as recorded. Checked one by one, never trusted. */
  readonly candidates: readonly unknown[]
}

export type RecordRead =
  | { readonly status: 'ok'; readonly record: ImportRecord }
  | { readonly status: 'failed'; readonly reason: RecordFailure }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function plainString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= max &&
    !CONTROL.test(value)
  )
}

function parseProject(value: unknown): ImportProject | undefined {
  if (!isRecord(value)) return undefined
  const { root, key, name, repo, commit } = value
  if (!plainString(root, MAX_ROOT_LENGTH) || !path.posix.isAbsolute(root)) {
    return undefined
  }
  if (key !== projectKey(root)) return undefined
  if (typeof name !== 'string' || !PROJECT_NAME.test(name)) return undefined
  if (
    repo !== undefined &&
    !(typeof repo === 'string' && REPO_SLUG.test(repo))
  ) {
    return undefined
  }
  if (
    commit !== undefined &&
    !(typeof commit === 'string' && OBJECT_ID.test(commit))
  ) {
    return undefined
  }
  return {
    root,
    key,
    name,
    ...(repo === undefined ? {} : { repo }),
    ...(commit === undefined ? {} : { commit }),
  }
}

/** Check the parts of a record that every candidate depends on. */
export function parseImportRecord(value: unknown): RecordRead {
  const malformed = { status: 'failed', reason: 'record-malformed' } as const
  if (!isRecord(value)) return malformed
  if (value.schemaVersion !== 1) {
    return { status: 'failed', reason: 'record-schema-version' }
  }
  const { runId, projects, candidateBlock } = value
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) return malformed
  if (
    !Array.isArray(projects) ||
    projects.length < 1 ||
    projects.length > MAX_IMPORT_PROJECTS
  ) {
    return malformed
  }
  const parsed: ImportProject[] = []
  for (const item of projects as unknown[]) {
    const project = parseProject(item)
    if (project === undefined) return malformed
    if (parsed.some((known) => known.root === project.root)) return malformed
    parsed.push(project)
  }
  if (!isRecord(candidateBlock)) return malformed
  if (candidateBlock.schemaVersion !== 1) {
    return { status: 'failed', reason: 'record-schema-version' }
  }
  const { candidates } = candidateBlock
  if (!Array.isArray(candidates) || candidates.length > MAX_IMPORT_CANDIDATES) {
    return malformed
  }
  return {
    status: 'ok',
    record: { runId, projects: parsed, candidates: candidates as unknown[] },
  }
}

/**
 * Read `run.json` from a downloaded directory. The directory is resolved to a
 * real path once; the record is then read through the contained reader, which
 * refuses a symlink, a non-regular file and a record over the size bound. No
 * other entry of the directory is listed, opened or followed.
 */
export function readImportRecord(directory: string): RecordRead {
  let real: string
  try {
    real = fs.realpathSync.native(directory)
    if (!fs.statSync(real).isDirectory()) {
      return { status: 'failed', reason: 'directory-unreadable' }
    }
  } catch {
    return { status: 'failed', reason: 'directory-unreadable' }
  }
  const read = readContainedFile(real, IMPORT_RECORD_FILE, {
    maxBytes: MAX_IMPORT_RECORD_BYTES,
  })
  if (read.kind === 'refused') {
    switch (read.reason) {
      case 'missing':
        return { status: 'failed', reason: 'record-missing' }
      case 'symlink':
        return { status: 'failed', reason: 'record-symlink' }
      case 'not-regular':
        return { status: 'failed', reason: 'record-not-regular' }
      case 'too-large':
        return { status: 'failed', reason: 'record-too-large' }
      default:
        return { status: 'failed', reason: 'record-unreadable' }
    }
  }
  let value: unknown
  try {
    value = JSON.parse(read.bytes.toString('utf8'))
  } catch {
    return { status: 'failed', reason: 'record-malformed' }
  }
  return parseImportRecord(value)
}

// ── Mapping ─────────────────────────────────────────────────────────────────

/** An allowed local checkout. */
export interface LocalCheckout {
  readonly root: string
  readonly key: string
  readonly name: string
  readonly repo?: string
  readonly commit?: string
}

export type MappingRefusal =
  | 'project-without-repo'
  | 'repo-not-allowed'
  | 'repo-ambiguous'

export type ProjectMapping =
  | { readonly status: 'mapped'; readonly local: LocalCheckout }
  | {
      readonly status: 'unmapped'
      readonly reason: MappingRefusal
      /** The keys of the local checkouts that share the repository. */
      readonly keys?: readonly string[]
    }

/** Match a recorded project to exactly one allowed local checkout by `owner/repo`. */
export function mapProject(
  project: ImportProject,
  locals: readonly LocalCheckout[],
): ProjectMapping {
  if (project.repo === undefined) {
    return { status: 'unmapped', reason: 'project-without-repo' }
  }
  const matches = locals.filter((local) => local.repo === project.repo)
  const [only] = matches
  if (only === undefined) {
    return { status: 'unmapped', reason: 'repo-not-allowed' }
  }
  if (matches.length > 1) {
    return {
      status: 'unmapped',
      reason: 'repo-ambiguous',
      keys: matches.map((local) => local.key).sort(),
    }
  }
  return { status: 'mapped', local: only }
}

/** One recorded project and where it landed, for the answer. */
export interface ProjectReport {
  readonly name: string
  readonly repo?: string
  readonly ciCommit?: string
  readonly status: 'mapped' | MappingRefusal
  readonly localRoot?: string
  readonly localKey?: string
  readonly localName?: string
  readonly localCommit?: string
}

// ── Refusals ────────────────────────────────────────────────────────────────

export type RefusalReason =
  | 'candidate-malformed'
  | 'duplicate-candidate'
  | 'candidate-id-mismatch'
  | 'project-not-in-record'
  | MappingRefusal
  | 'project-unreadable'
  | 'path-rejected'
  | 'rule-id-mismatch'
  | 'file-not-tracked'
  | 'file-symlink'
  | 'file-changed'
  | 'file-vanished'
  | 'check-failed'

/** The fixed text for each refusal. */
export const REFUSAL_TEXT: Readonly<Record<RefusalReason, string>> =
  Object.freeze({
    'candidate-malformed': 'the candidate is malformed',
    'duplicate-candidate': 'the record lists this candidate more than once',
    'candidate-id-mismatch':
      'the recorded id does not match the candidate, so the record was changed',
    'project-not-in-record':
      'the candidate names a project the record does not list',
    'project-without-repo':
      'a project of the candidate has no GitHub remote in the record, so it cannot be mapped to a local checkout',
    'repo-not-allowed':
      'no allowed local checkout has the recorded repository as its origin',
    'repo-ambiguous':
      'more than one allowed local checkout has the recorded repository as its origin',
    'project-unreadable': 'a mapped local checkout could not be read',
    'path-rejected': 'a cited path is not a safe path for this kind of file',
    'rule-id-mismatch':
      'the recorded rule id does not belong to any source of the candidate',
    'file-not-tracked': 'a cited file is not tracked in the local checkout',
    'file-symlink': 'a cited file is a symlink in the local checkout',
    'file-changed': 'a cited file differs from the file the run read',
    'file-vanished': 'a cited file is gone from the local checkout',
    'check-failed': 'the candidate failed a check against the local files',
  })

export interface ImportRefusal {
  /** The recorded id, when it is well formed. */
  readonly id: string | null
  /** A display-safe line: capped, with control characters removed. */
  readonly title: string
  readonly reason: RefusalReason
  readonly reasonText: string
  /** The sub-reason of a path or a check, from a fixed list. */
  readonly detail?: string
  /** `<local project>:<path>` of the file the refusal is about. */
  readonly file?: string
  readonly keys?: readonly string[]
  readonly repo?: string
}

export interface ImportAccepted {
  readonly recordedId: string
  /** The candidate with local roots, checked against local files. */
  readonly candidate: ValidCandidate
  readonly record: CandidateRecord
  /** The id computed from local roots. */
  readonly id: string
}

export interface Verification {
  readonly projects: readonly ProjectReport[]
  readonly accepted: readonly ImportAccepted[]
  readonly refused: readonly ImportRefusal[]
}

export interface VerifyInput {
  readonly record: ImportRecord
  readonly locals: readonly LocalCheckout[]
  /** The inventory of a local checkout, or nothing when it cannot be read. */
  readonly factsFor: (root: string) => ProjectFacts | undefined
}

// ── One candidate ───────────────────────────────────────────────────────────

interface FileRef {
  readonly project: string
  readonly path: string
  readonly fingerprint: string
  readonly excerpt: string
  readonly rest: Readonly<Record<string, unknown>>
}

interface Shape {
  readonly id: string
  readonly kind: string
  readonly ruleId: string
  readonly target: string
  readonly title: unknown
  readonly summary: unknown
  readonly nextStep: unknown
  readonly overlapCheck: unknown
  readonly sources: readonly FileRef[]
  readonly counterevidence: readonly FileRef[]
  readonly targetEvidence: ReadonlyArray<Record<string, unknown>>
}

function fileRefs(value: unknown, max: number): FileRef[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) return undefined
  const out: FileRef[] = []
  for (const item of value as unknown[]) {
    if (!isRecord(item)) return undefined
    const { project, path: file, fingerprint, excerpt } = item
    if (
      typeof project !== 'string' ||
      typeof file !== 'string' ||
      typeof fingerprint !== 'string' ||
      typeof excerpt !== 'string'
    ) {
      return undefined
    }
    out.push({ project, path: file, fingerprint, excerpt, rest: item })
  }
  return out
}

function evidenceRefs(
  value: unknown,
  max: number,
): Array<Record<string, unknown>> | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) return undefined
  const out: Array<Record<string, unknown>> = []
  for (const item of value as unknown[]) {
    if (!isRecord(item)) return undefined
    if (typeof item.path !== 'string' || typeof item.fingerprint !== 'string') {
      return undefined
    }
    out.push(item)
  }
  return out
}

/** The parts of a recorded candidate that the checks below need typed. */
function shapeOf(raw: unknown): Shape | undefined {
  if (!isRecord(raw)) return undefined
  const { id, kind, ruleId, target } = raw
  if (typeof id !== 'string' || !CANDIDATE_ID.test(id)) return undefined
  if (
    typeof kind !== 'string' ||
    typeof ruleId !== 'string' ||
    typeof target !== 'string'
  ) {
    return undefined
  }
  const sources = fileRefs(raw.sources, CANDIDATE_LIMITS.sources)
  const counterevidence = fileRefs(
    raw.counterevidence,
    CANDIDATE_LIMITS.counterevidence,
  )
  const targetEvidence = evidenceRefs(
    raw.targetEvidence,
    CANDIDATE_LIMITS.targetEvidence,
  )
  if (
    sources === undefined ||
    counterevidence === undefined ||
    targetEvidence === undefined
  ) {
    return undefined
  }
  return {
    id,
    kind,
    ruleId,
    target,
    title: raw.title,
    summary: raw.summary,
    nextStep: raw.nextStep,
    overlapCheck: raw.overlapCheck,
    sources,
    counterevidence,
    targetEvidence,
  }
}

/** The identity the producer would have written, from the recorded roots. */
function recordedIdentity(shape: Shape): string {
  return candidateIdentity({
    kind: shape.kind,
    target: shape.target,
    ruleId: shape.ruleId,
    sources: shape.sources.map((source) => ({
      role: `source@${projectKey(source.project)}`,
      path: source.path,
      fingerprint: source.fingerprint,
    })),
    targetEvidence: shape.targetEvidence.map((item) => ({
      path: String(item.path),
      fingerprint: String(item.fingerprint),
    })),
  })
}

type Check<T> = T | ImportRefusalBody

interface ImportRefusalBody {
  readonly refusal: Omit<ImportRefusal, 'id' | 'title' | 'reasonText'>
}

function isRefusal<T>(value: Check<T>): value is ImportRefusalBody {
  return typeof value === 'object' && value !== null && 'refusal' in value
}

function refuse(
  reason: RefusalReason,
  extra: Partial<Omit<ImportRefusal, 'reason'>> = {},
): ImportRefusalBody {
  return { refusal: { reason, ...extra } }
}

function pathRefusal(
  file: string,
  corpusOnly: boolean,
): ImportRefusalBody | undefined {
  const problem = pathProblem(file)
  if (problem !== undefined) return refuse('path-rejected', { detail: problem })
  if (corpusOnly && !CORPUS_PATH.test(file)) {
    return refuse('path-rejected', { detail: 'outside-corpus' })
  }
  return undefined
}

interface Landing {
  readonly local: LocalCheckout
  readonly facts: ProjectFacts
}

interface Landings {
  readonly projects: readonly ImportProject[]
  mappingOf(root: string): ProjectMapping | undefined
  projectOf(root: string): ImportProject | undefined
  /** The facts of a local checkout, read once per checkout. */
  factsOf(local: LocalCheckout): ProjectFacts | undefined
}

function createLandings(
  projects: readonly ImportProject[],
  locals: readonly LocalCheckout[],
  factsFor: (root: string) => ProjectFacts | undefined,
): Landings {
  const byRecorded = new Map<string, ProjectMapping>()
  for (const project of projects) {
    byRecorded.set(project.root, mapProject(project, locals))
  }
  const cache = new Map<string, ProjectFacts | undefined>()
  return {
    projects,
    mappingOf: (root) => byRecorded.get(root),
    projectOf: (root) => projects.find((project) => project.root === root),
    factsOf(local) {
      if (!cache.has(local.root)) cache.set(local.root, factsFor(local.root))
      return cache.get(local.root)
    },
  }
}

/** Every recorded root a candidate depends on must map to one local checkout. */
function land(shape: Shape, landings: Landings): Check<Map<string, Landing>> {
  const roots = new Set([
    shape.target,
    ...shape.sources.map((source) => source.project),
    ...shape.counterevidence.map((source) => source.project),
  ])
  const out = new Map<string, Landing>()
  for (const root of roots) {
    const project = landings.projectOf(root)
    const mapping = landings.mappingOf(root)
    if (project === undefined || mapping === undefined) {
      return refuse('project-not-in-record')
    }
    if (mapping.status === 'unmapped') {
      return refuse(mapping.reason, {
        ...(mapping.keys === undefined ? {} : { keys: mapping.keys }),
        ...(project.repo === undefined ? {} : { repo: project.repo }),
      })
    }
    const facts = landings.factsOf(mapping.local)
    if (facts === undefined) return refuse('project-unreadable')
    out.set(root, { local: mapping.local, facts })
  }
  return out
}

/** Sources must be learnings in the corpus; counterevidence and target evidence may be any tracked file. */
function checkPaths(shape: Shape): ImportRefusalBody | undefined {
  const groups: Array<[ReadonlyArray<{ readonly path: string }>, boolean]> = [
    [shape.sources, true],
    [shape.counterevidence, false],
    [shape.targetEvidence.map((item) => ({ path: String(item.path) })), false],
  ]
  for (const [items, corpusOnly] of groups) {
    for (const item of items) {
      const refusal = pathRefusal(item.path, corpusOnly)
      if (refusal !== undefined) return refusal
    }
  }
  return undefined
}

/** The recorded rule id must be the id of one of the candidate's own sources. */
function localRuleId(
  shape: Shape,
  landed: ReadonlyMap<string, Landing>,
): Check<string> {
  const bound = shape.sources.find(
    (source) => ruleIdFor(source.project, source.path) === shape.ruleId,
  )
  const landing = bound === undefined ? undefined : landed.get(bound.project)
  if (bound === undefined || landing === undefined) {
    return refuse('rule-id-mismatch')
  }
  return ruleIdFor(landing.local.root, bound.path)
}

function localFile(
  landing: Landing,
  rel: string,
  fingerprint: string,
): ImportRefusalBody | undefined {
  const file = `${landing.local.name}:${rel}`
  const known = landing.facts.files.get(rel)
  if (known === undefined) {
    const probe = readContainedFile(landing.local.root, rel, { maxBytes: 1 })
    const symlink = probe.kind === 'refused' && probe.reason === 'symlink'
    return refuse(symlink ? 'file-symlink' : 'file-not-tracked', { file })
  }
  return known.sha256 === fingerprint
    ? undefined
    : refuse('file-changed', { file })
}

/** A cited file that is missing, a symlink or changed is named; the rest is left to `checkCandidate`. */
function checkFiles(
  shape: Shape,
  landed: ReadonlyMap<string, Landing>,
): ImportRefusalBody | undefined {
  const refs: Array<[string, string, string]> = [
    ...shape.sources.map((s): [string, string, string] => [
      s.project,
      s.path,
      s.fingerprint,
    ]),
    ...shape.counterevidence.map((s): [string, string, string] => [
      s.project,
      s.path,
      s.fingerprint,
    ]),
    ...shape.targetEvidence.map((e): [string, string, string] => [
      shape.target,
      String(e.path),
      String(e.fingerprint),
    ]),
  ]
  for (const [root, rel, fingerprint] of refs) {
    const landing = landed.get(root)
    if (landing === undefined) return refuse('project-not-in-record')
    const refusal = localFile(landing, rel, fingerprint)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

function localRaw(
  shape: Shape,
  ruleId: string,
  landed: ReadonlyMap<string, Landing>,
): Record<string, unknown> {
  const rootOf = (recorded: string): string =>
    landed.get(recorded)?.local.root ?? recorded
  const source = (ref: FileRef): Record<string, unknown> => ({
    project: rootOf(ref.project),
    path: ref.path,
    fingerprint: ref.fingerprint,
    excerpt: ref.excerpt,
  })
  return {
    kind: shape.kind,
    ruleId,
    target: rootOf(shape.target),
    title: shape.title,
    summary: shape.summary,
    nextStep: shape.nextStep,
    overlapCheck: shape.overlapCheck,
    sources: shape.sources.map(source),
    targetEvidence: shape.targetEvidence.map((item) => ({
      path: item.path,
      start: item.start,
      end: item.end,
      symbol: item.symbol,
      fingerprint: item.fingerprint,
      excerpt: item.excerpt,
    })),
    counterevidence: shape.counterevidence.map(source),
  }
}

function contextOf(landed: ReadonlyMap<string, Landing>): ValidationContext {
  const projects = new Map<string, ProjectFacts>()
  const ruleIds = new Set<string>()
  for (const { local, facts } of landed.values()) {
    projects.set(local.root, facts)
    for (const [rel, info] of facts.files) {
      if (info.role === 'learning') ruleIds.add(ruleIdFor(local.root, rel))
    }
  }
  return { projects, ruleIds }
}

function verifyOne(
  raw: unknown,
  landings: Landings,
  seen: Set<string>,
): ImportAccepted | ImportRefusalBody {
  const shape = shapeOf(raw)
  if (shape === undefined) return refuse('candidate-malformed')
  if (seen.has(shape.id)) return refuse('duplicate-candidate')
  seen.add(shape.id)
  if (recordedIdentity(shape) !== shape.id) {
    return refuse('candidate-id-mismatch')
  }
  const landed = land(shape, landings)
  if (isRefusal(landed)) return landed
  const pathIssue = checkPaths(shape)
  if (pathIssue !== undefined) return pathIssue
  const ruleId = localRuleId(shape, landed)
  if (isRefusal(ruleId)) return ruleId
  const fileIssue = checkFiles(shape, landed)
  if (fileIssue !== undefined) return fileIssue

  const checked = checkCandidate(
    localRaw(shape, ruleId, landed),
    contextOf(landed),
  )
  if (checked.status === 'dropped') {
    return refuse('check-failed', { detail: checked.reason })
  }
  if (checked.status === 'unresolved') {
    const [missing] = checked.missing
    return refuse('file-vanished', {
      ...(missing === undefined ? {} : { file: missing }),
    })
  }
  const record = toCandidateRecord(checked.candidate)
  return {
    recordedId: shape.id,
    candidate: checked.candidate,
    record,
    id: candidateIdentity(record),
  }
}

function projectReports(landings: Landings): ProjectReport[] {
  return landings.projects.map((project) => {
    const mapping = landings.mappingOf(project.root)
    const base = {
      name: project.name,
      ...(project.repo === undefined ? {} : { repo: project.repo }),
      ...(project.commit === undefined ? {} : { ciCommit: project.commit }),
    }
    if (mapping === undefined || mapping.status === 'unmapped') {
      return { ...base, status: mapping?.reason ?? 'repo-not-allowed' }
    }
    const { local } = mapping
    return {
      ...base,
      status: 'mapped' as const,
      localRoot: local.root,
      localKey: local.key,
      localName: local.name,
      ...(local.commit === undefined ? {} : { localCommit: local.commit }),
    }
  })
}

function named(
  raw: unknown,
  refusal: ImportRefusalBody['refusal'],
): ImportRefusal {
  const id =
    isRecord(raw) && typeof raw.id === 'string' && CANDIDATE_ID.test(raw.id)
      ? raw.id
      : null
  return {
    ...refusal,
    id,
    title: nameDropped('import', raw, refusal.reason).title,
    reasonText: REFUSAL_TEXT[refusal.reason],
    ...(refusal.file === undefined
      ? {}
      : { file: sanitizeText(refusal.file).replaceAll('\n', ' ') }),
  }
}

/**
 * Check every candidate of the record against the local checkouts. A candidate
 * is accepted only when it maps, its paths and ids hold, and `checkCandidate`
 * passes on local files. Everything else is refused with a fixed reason; one
 * refusal never stops the others.
 */
export function verifyRecord(input: VerifyInput): Verification {
  const landings = createLandings(
    input.record.projects,
    input.locals,
    input.factsFor,
  )
  const accepted: ImportAccepted[] = []
  const refused: ImportRefusal[] = []
  const seen = new Set<string>()
  const local = new Set<string>()
  for (const raw of input.record.candidates) {
    const outcome = verifyOne(raw, landings, seen)
    if ('refusal' in outcome) {
      refused.push(named(raw, outcome.refusal))
      continue
    }
    if (local.has(outcome.id)) {
      refused.push(named(raw, refuse('duplicate-candidate').refusal))
      continue
    }
    local.add(outcome.id)
    accepted.push(outcome)
  }
  return { projects: projectReports(landings), accepted, refused }
}

// ── Rendering ───────────────────────────────────────────────────────────────

export interface ImportProvenance {
  readonly repo: string
  readonly runId: string
  readonly commit?: string
}

/** What was done with one candidate that passed local checks. */
export interface ImportedCandidate {
  readonly item: DigestCandidate
  /** The run record that holds it. */
  readonly runRecordPath: string
}

export interface SkippedCandidate {
  readonly id: string
  readonly title: string
  readonly reason: 'rejected-locally' | 'promoted-locally'
  readonly refreshPointer?: string
}

export interface ImportModel {
  readonly runId: string | undefined
  readonly outcome: 'complete' | 'degraded'
  /** Why the import is degraded; empty when it is complete. */
  readonly degradeReasons: readonly string[]
  readonly provenance: ImportProvenance
  /** The run's own id, from the record. */
  readonly sourceRunId: string
  readonly projects: readonly ProjectReport[]
  readonly imported: number
  readonly candidates: readonly ImportedCandidate[]
  readonly skipped: readonly SkippedCandidate[]
  readonly refused: readonly ImportRefusal[]
}

function provenanceLine(provenance: ImportProvenance): string {
  const commit =
    provenance.commit === undefined
      ? ''
      : ` at commit ${inline(provenance.commit)}`
  return `GitHub run ${inline(provenance.runId)} of ${inline(provenance.repo)}${commit}`
}

function projectLine(project: ProjectReport): string {
  const repo = project.repo === undefined ? 'no GitHub remote' : project.repo
  const head = `- ${inline(project.name)} (${inline(repo)})`
  if (project.status !== 'mapped') {
    return `${head}: not mapped (${REFUSAL_TEXT[project.status]})`
  }
  const ci =
    project.ciCommit === undefined ? 'unknown' : inline(project.ciCommit)
  const local =
    project.localCommit === undefined ? 'unknown' : inline(project.localCommit)
  return `${head}: CI commit ${ci}; local commit ${local} in ${inline(project.localRoot ?? '')}`
}

function refusalLines(refused: readonly ImportRefusal[]): string[] {
  if (refused.length === 0) return []
  const out = ['Refused (nothing was imported from these):']
  for (const item of refused) {
    const where = item.file === undefined ? '' : ` File: ${inline(item.file)}.`
    const detail = item.detail === undefined ? '' : ` (${item.detail})`
    const keys =
      item.keys === undefined
        ? ''
        : ` Local project keys: ${item.keys.map(inline).join(', ')}.`
    out.push(
      quote(item.title),
      `  ${item.reason}${detail}: ${item.reasonText}.${where}${keys}`,
    )
  }
  return out
}

function skippedLines(skipped: readonly SkippedCandidate[]): string[] {
  if (skipped.length === 0) return []
  const out = ['Skipped (already decided locally):']
  for (const item of skipped) {
    const pointer =
      item.refreshPointer === undefined
        ? ''
        : ` Refresh pointer: ${inline(item.refreshPointer)}.`
    out.push(quote(item.title), `  ${item.reason}.${pointer}`)
  }
  return out
}

const MAX_LINES_LISTED = 50

function promotionLines(candidates: readonly ImportedCandidate[]): string[] {
  if (candidates.length === 0) return []
  const out = ['Candidates (untrusted text, quoted):']
  for (const { item, runRecordPath } of candidates.slice(0, MAX_LINES_LISTED)) {
    out.push(quote(`${item.candidate.kind}: ${item.candidate.title}`))
    out.push(handoffLine(item, runRecordPath, isPasteablePath(runRecordPath)))
  }
  const left = candidates.length - MAX_LINES_LISTED
  if (left > 0) out.push(`${left} more candidates are in the run record.`)
  return out
}

/**
 * The chat summary of an import. Every value in it is either made by the
 * helper or passed a validator; titles are quoted. The promotion lines are the
 * ones a local run prints, so `ce:compound` takes them unchanged.
 */
export function renderImportSummary(
  model: ImportModel,
  digestPath: string | undefined,
): string {
  const out = [
    `Connect import ${model.runId === undefined ? '(no new run)' : sanitizeText(model.runId)}: ${model.outcome}.`,
    `Imported: ${model.imported}. Already imported: ${model.candidates.length - model.imported}. Skipped: ${model.skipped.length}. Refused: ${model.refused.length}.`,
    `Source: ${provenanceLine(model.provenance)}.`,
    'Projects:',
    ...model.projects.map(projectLine),
  ]
  if (model.outcome === 'degraded') {
    out.push(
      'Degraded because: some candidates were refused. A refused candidate is not proof the lesson is wrong; run the scheduled run again to see it afresh.',
    )
  }
  out.push(...refusalLines(model.refused), ...skippedLines(model.skipped))
  if (digestPath !== undefined) {
    out.push(`Digest: ${sanitizeText(digestPath).replaceAll('\n', ' ')}`)
  }
  out.push(...promotionLines(model.candidates))
  return out.join('\n')
}

/** The digest of an import run, with the same quoting a local digest uses. */
export function renderImportDigest(
  model: ImportModel,
  written: readonly DigestCandidate[],
  generatedAt: string,
): string {
  const out = [
    `# Connect import digest ${inline(model.runId ?? 'none')}`,
    '',
    `Outcome: ${model.outcome}`,
    ...(model.degradeReasons.length > 0
      ? [`Degraded because: ${model.degradeReasons.map(inline).join(', ')}`]
      : []),
    `Generated: ${generatedAt}`,
    `Source: ${provenanceLine(model.provenance)}`,
    `Run record: ${inline(model.sourceRunId)}`,
    '',
    'Projects:',
    ...model.projects.map(projectLine),
    '',
    ...refusalLines(model.refused),
    ...(model.refused.length > 0 ? [''] : []),
    ...skippedLines(model.skipped),
    ...(model.skipped.length > 0 ? [''] : []),
    '## Candidates',
    '',
  ]
  if (written.length === 0) out.push('None.', '')
  written.forEach((item, index) => {
    out.push(...renderCandidate(item, index))
  })
  return `${out.join('\n').trimEnd()}\n`
}
