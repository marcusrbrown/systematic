import { createHash, randomBytes } from 'node:crypto'

export const CANONICAL_QUESTION_WORDING =
  'Confirm the requested guarded transition.' as const

const MAX_ID_LENGTH = 128
const MAX_RESOURCE_LENGTH = 512
const MAX_TRANSITION_LENGTH = 128
const DEFAULT_MAX_CHALLENGE_AGE_MS = 5 * 60 * 1000
const MAX_CHALLENGE_AGE_MS = 24 * 60 * 60 * 1000

export type QuestionPurpose = 'transition' | 'session-disablement'
export type QuestionAnswerClassification = 'affirmative' | 'non-affirmative'
export type QuestionAttestationReasonCode =
  | 'already-bound'
  | 'already-consumed'
  | 'already-disabled'
  | 'call-session-mismatch'
  | 'challenge-expired'
  | 'challenge-consumed'
  | 'invalid-input'
  | 'no-attestation'
  | 'non-affirmative'
  | 'rejected'
  | 'replay'
  | 'scope-mismatch'
  | 'substitution'
  | 'unknown-challenge'
  | 'unknown-request'

export interface QuestionAttestationOptions {
  clock?: () => number
  maxChallengeAgeMs?: number
}

export interface QuestionChallengeRecord {
  readonly challengeId: string
  readonly sessionId: string
  readonly resourceDigest: string
  readonly transitionKey: string
  readonly purpose: QuestionPurpose
  readonly createdAt: number
  readonly question: {
    readonly wording: typeof CANONICAL_QUESTION_WORDING
    readonly args: {
      readonly challengeId: string
      readonly purpose: QuestionPurpose
      readonly resourceDigest: string
      readonly transitionKey: string
    }
  }
}

export interface QuestionAttestation {
  readonly purpose: QuestionPurpose
  readonly sessionId: string
  readonly resourceDigest: string
  readonly transitionKey: string
  readonly requestId: string
  readonly answer: 'affirmed'
  readonly timestamp: number
  readonly consumption: 'available' | 'consumed'
}

export type ChallengeResult =
  | { readonly status: 'pending'; readonly challenge: QuestionChallengeRecord }
  | RejectedResult

export type BindAskedResult =
  | {
      readonly status: 'bound'
      readonly challengeId: string
      readonly requestId: string
    }
  | RejectedResult

export type ObserveReplyResult =
  | { readonly status: 'accepted'; readonly attestation: QuestionAttestation }
  | RejectedResult

export type ObserveRejectResult =
  | { readonly status: 'rejected'; readonly reasonCode: 'rejected' }
  | RejectedResult

export type ConsumeAttestationResult =
  | {
      readonly status: 'consumed'
      readonly projection: 'attested' | 'disabled'
      readonly attestation: QuestionAttestation
    }
  | RejectedResult

export type QuestionAttestationProjection =
  | KnownQuestionAttestationProjection
  | {
      readonly status: 'unknown'
      readonly reasonCode: QuestionAttestationReasonCode
    }

interface KnownQuestionAttestationProjection {
  readonly status: 'pending' | 'bound' | 'attested' | 'denied' | 'disabled'
  readonly challengeId: string
  readonly purpose: QuestionPurpose
  readonly sessionId: string
  readonly resourceDigest: string
  readonly transitionKey: string
  readonly requestId?: string
  readonly consumption?: 'available' | 'consumed'
}

export type SessionDisablementProjection =
  | {
      readonly status: 'enabled' | 'pending' | 'bound' | 'disabled'
      readonly sessionId: string
    }
  | {
      readonly status: 'unknown'
      readonly reasonCode: QuestionAttestationReasonCode
    }

export interface QuestionAttestationMachine {
  challenge(input: unknown): ChallengeResult
  bindAsked(input: unknown): BindAskedResult
  observeReply(input: unknown): ObserveReplyResult
  observeReject(input: unknown): ObserveRejectResult
  consumeAttestation(input: unknown): ConsumeAttestationResult
  status(input: unknown): QuestionAttestationProjection
  sessionStatus(input: unknown): SessionDisablementProjection
}

interface RejectedResult {
  readonly status: 'rejected'
  readonly reasonCode: QuestionAttestationReasonCode
}

interface BindingIdentity {
  readonly sessionId: string
  readonly transition: string
  readonly purpose: QuestionPurpose
}

interface BindingInput extends BindingIdentity {
  readonly resource: string
}

interface ChallengeInput extends BindingInput {}

interface BindByIdInput {
  readonly challengeId: string
  readonly sessionId?: string
  readonly callId: string
  readonly requestId: string
}

interface BindByScopeInput extends BindingInput {
  readonly callId: string
  readonly requestId: string
}

interface ReplyInput {
  readonly sessionId: string
  readonly requestId: string
  readonly answer: unknown
}

interface RejectInput {
  readonly sessionId: string
  readonly requestId: string
}

interface ConsumeInput extends BindingInput {
  readonly requestId: string
}

interface InternalChallenge extends BindingIdentity {
  readonly challengeId: string
  readonly resourceDigest: string
  readonly createdAt: number
  state: 'pending' | 'bound' | 'denied' | 'consumed' | 'expired'
  callId?: string
  requestId?: string
}

interface InternalAttestation {
  readonly purpose: QuestionPurpose
  readonly sessionId: string
  readonly resourceDigest: string
  readonly transitionKey: string
  readonly requestId: string
  readonly answer: 'affirmed'
  readonly timestamp: number
  consumption: 'available' | 'consumed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return Object.keys(value).every((field) => fields.includes(field))
}

function isCleanBoundedString(
  value: unknown,
  maxLength: number,
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    return false
  }
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return false
  }
  return true
}

function isTransitionKey(value: unknown): value is string {
  return (
    isCleanBoundedString(value, MAX_TRANSITION_LENGTH) &&
    /^[a-z][a-z0-9._:-]*$/u.test(value)
  )
}

function isQuestionPurpose(value: unknown): value is QuestionPurpose {
  return value === 'transition' || value === 'session-disablement'
}

function digestResource(resource: string): string {
  return `sha256:${createHash('sha256')
    .update(`systematic-question-attestation:v1:resource:${resource}`, 'utf8')
    .digest('hex')}`
}

function bindingKey(input: BindingIdentity, resourceDigest: string): string {
  return [
    input.purpose,
    input.sessionId,
    resourceDigest,
    input.transition,
  ].join('\u0000')
}

function rejected(reasonCode: QuestionAttestationReasonCode): RejectedResult {
  return { status: 'rejected', reasonCode }
}

function cloneAttestation(
  attestation: InternalAttestation,
): QuestionAttestation {
  return {
    purpose: attestation.purpose,
    sessionId: attestation.sessionId,
    resourceDigest: attestation.resourceDigest,
    transitionKey: attestation.transitionKey,
    requestId: attestation.requestId,
    answer: 'affirmed',
    timestamp: attestation.timestamp,
    consumption: attestation.consumption,
  }
}

function readNow(clock: () => number): number {
  try {
    const value = clock()
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Date.now()
  } catch {
    return Date.now()
  }
}

function parsePurpose(value: unknown): QuestionPurpose | null {
  return isQuestionPurpose(value) ? value : null
}

function parseBinding(value: unknown): BindingInput | null {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ['sessionId', 'resource', 'transition', 'purpose'])
  ) {
    return null
  }
  const sessionId = value.sessionId
  const resource = value.resource
  const transition = value.transition
  const purpose = parsePurpose(value.purpose)
  if (
    !isCleanBoundedString(sessionId, MAX_ID_LENGTH) ||
    !isCleanBoundedString(resource, MAX_RESOURCE_LENGTH) ||
    !isTransitionKey(transition) ||
    purpose === null
  ) {
    return null
  }
  return { sessionId, resource, transition, purpose }
}

function parseChallengeInput(value: unknown): ChallengeInput | null {
  return parseBinding(value)
}

function parseBindInput(
  value: unknown,
): BindByIdInput | BindByScopeInput | null {
  if (!isRecord(value)) return null
  const callId = value.callId
  const requestId = value.requestId
  if (
    !isCleanBoundedString(callId, MAX_ID_LENGTH) ||
    !isCleanBoundedString(requestId, MAX_ID_LENGTH)
  ) {
    return null
  }
  if (isCleanBoundedString(value.challengeId, MAX_ID_LENGTH)) {
    if (
      !hasOnlyFields(value, ['challengeId', 'sessionId', 'callId', 'requestId'])
    ) {
      return null
    }
    const sessionId = value.sessionId
    if (
      sessionId !== undefined &&
      !isCleanBoundedString(sessionId, MAX_ID_LENGTH)
    ) {
      return null
    }
    return {
      challengeId: value.challengeId,
      sessionId,
      callId,
      requestId,
    }
  }
  if (
    !hasOnlyFields(value, [
      'sessionId',
      'resource',
      'transition',
      'purpose',
      'callId',
      'requestId',
    ])
  ) {
    return null
  }
  const binding = parseBinding({
    sessionId: value.sessionId,
    resource: value.resource,
    transition: value.transition,
    purpose: value.purpose,
  })
  return binding === null ? null : { ...binding, callId, requestId }
}

function parseReplyInput(value: unknown): ReplyInput | null {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ['sessionId', 'requestId', 'answer'])
  ) {
    return null
  }
  return isCleanBoundedString(value.sessionId, MAX_ID_LENGTH) &&
    isCleanBoundedString(value.requestId, MAX_ID_LENGTH)
    ? {
        sessionId: value.sessionId,
        requestId: value.requestId,
        answer: value.answer,
      }
    : null
}

function parseRejectInput(value: unknown): RejectInput | null {
  if (!isRecord(value) || !hasOnlyFields(value, ['sessionId', 'requestId'])) {
    return null
  }
  return isCleanBoundedString(value.sessionId, MAX_ID_LENGTH) &&
    isCleanBoundedString(value.requestId, MAX_ID_LENGTH)
    ? { sessionId: value.sessionId, requestId: value.requestId }
    : null
}

function parseConsumeInput(value: unknown): ConsumeInput | null {
  if (
    !isRecord(value) ||
    !isCleanBoundedString(value.requestId, MAX_ID_LENGTH)
  ) {
    return null
  }
  if (
    !hasOnlyFields(value, [
      'sessionId',
      'resource',
      'transition',
      'purpose',
      'requestId',
    ])
  ) {
    return null
  }
  const binding = parseBinding({
    sessionId: value.sessionId,
    resource: value.resource,
    transition: value.transition,
    purpose: value.purpose,
  })
  return binding === null ? null : { ...binding, requestId: value.requestId }
}

function buildChallengeRecord(
  challenge: InternalChallenge,
): QuestionChallengeRecord {
  return {
    challengeId: challenge.challengeId,
    sessionId: challenge.sessionId,
    resourceDigest: challenge.resourceDigest,
    transitionKey: challenge.transition,
    purpose: challenge.purpose,
    createdAt: challenge.createdAt,
    question: {
      wording: CANONICAL_QUESTION_WORDING,
      args: {
        challengeId: challenge.challengeId,
        purpose: challenge.purpose,
        resourceDigest: challenge.resourceDigest,
        transitionKey: challenge.transition,
      },
    },
  }
}

function createChallengeId(counter: number): string {
  try {
    return `qat_${randomBytes(12).toString('hex')}`
  } catch {
    return `qat_${counter.toString(36)}`
  }
}

function isChallengeId(value: unknown): value is string {
  return (
    isCleanBoundedString(value, MAX_ID_LENGTH) && /^qat_[a-z0-9]+$/u.test(value)
  )
}

export function classifyQuestionAnswer(
  answer: unknown,
): QuestionAnswerClassification {
  return answer === 'yes' || answer === 'confirm'
    ? 'affirmative'
    : 'non-affirmative'
}

export function createQuestionAttestation(
  options: QuestionAttestationOptions = {},
): QuestionAttestationMachine {
  const optionsRecord = isRecord(options) ? options : {}
  const clock =
    typeof optionsRecord.clock === 'function'
      ? (optionsRecord.clock as () => number)
      : Date.now
  const configuredAge = optionsRecord.maxChallengeAgeMs
  const maxChallengeAgeMs =
    typeof configuredAge === 'number' &&
    Number.isFinite(configuredAge) &&
    configuredAge > 0 &&
    configuredAge <= MAX_CHALLENGE_AGE_MS
      ? Math.floor(configuredAge)
      : DEFAULT_MAX_CHALLENGE_AGE_MS

  const challenges = new Map<string, InternalChallenge>()
  const activeByBinding = new Map<string, string>()
  const challengeByRequest = new Map<string, string>()
  const attestations = new Map<string, InternalAttestation>()
  const seenRequestIds = new Set<string>()
  const disabledSessions = new Set<string>()
  let challengeCounter = 0

  function expireChallenges(now: number): void {
    for (const [challengeId, challenge] of challenges) {
      if (
        (challenge.state === 'pending' || challenge.state === 'bound') &&
        now - challenge.createdAt > maxChallengeAgeMs
      ) {
        challenge.state = 'expired'
        const key = bindingKey(challenge, challenge.resourceDigest)
        if (activeByBinding.get(key) === challengeId)
          activeByBinding.delete(key)
      }
    }
  }

  function findChallengeByScope(input: BindingInput): InternalChallenge | null {
    const resourceDigest = digestResource(input.resource)
    const challengeId = activeByBinding.get(bindingKey(input, resourceDigest))
    return challengeId === undefined
      ? null
      : (challenges.get(challengeId) ?? null)
  }

  function findChallengeById(challengeId: string): InternalChallenge | null {
    return challenges.get(challengeId) ?? null
  }

  function findBindChallenge(
    input: BindByIdInput | BindByScopeInput,
  ): InternalChallenge | null {
    return 'challengeId' in input
      ? findChallengeById(input.challengeId)
      : findChallengeByScope(input)
  }

  function bindStateRejection(
    challenge: InternalChallenge,
    input: BindByIdInput | BindByScopeInput,
  ): QuestionAttestationReasonCode | null {
    if (challenge.state === 'expired') return 'challenge-expired'
    if (challenge.state === 'denied' || challenge.state === 'consumed') {
      return 'challenge-consumed'
    }
    if (
      'sessionId' in input &&
      input.sessionId !== undefined &&
      input.sessionId !== challenge.sessionId
    ) {
      return 'call-session-mismatch'
    }
    if (challenge.state === 'bound') {
      return challenge.requestId === input.requestId
        ? 'already-bound'
        : 'substitution'
    }
    return seenRequestIds.has(input.requestId) ? 'replay' : null
  }

  function requestChallenge(requestId: string): InternalChallenge | null {
    const challengeId = challengeByRequest.get(requestId)
    return challengeId === undefined
      ? null
      : (challenges.get(challengeId) ?? null)
  }

  function replyStateRejection(
    challenge: InternalChallenge,
    input: ReplyInput,
  ): QuestionAttestationReasonCode | null {
    if (challenge.sessionId !== input.sessionId) return 'substitution'
    if (challenge.state === 'expired') return 'challenge-expired'
    if (
      challenge.state !== 'bound' ||
      challenge.requestId !== input.requestId
    ) {
      return 'replay'
    }
    return null
  }

  function rejectStateRejection(
    challenge: InternalChallenge,
    input: RejectInput,
  ): QuestionAttestationReasonCode | null {
    if (challenge.sessionId !== input.sessionId) return 'substitution'
    if (challenge.state === 'denied' || challenge.state === 'consumed') {
      return 'already-consumed'
    }
    if (challenge.state === 'expired') return 'challenge-expired'
    return null
  }

  function statusChallenge(input: unknown): InternalChallenge | null {
    if (!isRecord(input)) return null
    if (isChallengeId(input.challengeId))
      return findChallengeById(input.challengeId)
    const parsed = parseBinding(input)
    return parsed === null ? null : findChallengeByScope(parsed)
  }

  function projectionBase(
    challenge: InternalChallenge,
    status: 'pending' | 'bound' | 'attested' | 'denied' | 'disabled',
  ): KnownQuestionAttestationProjection {
    return {
      status,
      challengeId: challenge.challengeId,
      purpose: challenge.purpose,
      sessionId: challenge.sessionId,
      resourceDigest: challenge.resourceDigest,
      transitionKey: challenge.transition,
      ...(challenge.requestId === undefined
        ? {}
        : { requestId: challenge.requestId }),
    }
  }

  function projectChallenge(
    challenge: InternalChallenge,
  ): QuestionAttestationProjection {
    const attestation =
      challenge.requestId === undefined
        ? undefined
        : attestations.get(challenge.requestId)
    if (attestation !== undefined) {
      const status =
        attestation.purpose === 'session-disablement' &&
        attestation.consumption === 'consumed'
          ? 'disabled'
          : 'attested'
      return {
        ...projectionBase(challenge, status),
        consumption: attestation.consumption,
      }
    }
    if (challenge.state === 'pending' || challenge.state === 'bound') {
      return projectionBase(challenge, challenge.state)
    }
    if (challenge.state === 'denied') {
      return projectionBase(challenge, 'denied')
    }
    return { status: 'unknown', reasonCode: 'challenge-expired' }
  }

  function removeActiveChallenge(challenge: InternalChallenge): void {
    const key = bindingKey(challenge, challenge.resourceDigest)
    if (activeByBinding.get(key) === challenge.challengeId) {
      activeByBinding.delete(key)
    }
  }

  function challenge(input: unknown): ChallengeResult {
    try {
      const parsed = parseChallengeInput(input)
      if (parsed === null) return rejected('invalid-input')
      const now = readNow(clock)
      expireChallenges(now)
      if (
        parsed.purpose === 'session-disablement' &&
        disabledSessions.has(parsed.sessionId)
      ) {
        return rejected('already-disabled')
      }
      const resourceDigest = digestResource(parsed.resource)
      const key = bindingKey(parsed, resourceDigest)
      const activeId = activeByBinding.get(key)
      if (activeId !== undefined) {
        const activeChallenge = challenges.get(activeId)
        if (
          activeChallenge !== undefined &&
          (activeChallenge.state === 'pending' ||
            activeChallenge.state === 'bound')
        ) {
          return {
            status: 'pending',
            challenge: buildChallengeRecord(activeChallenge),
          }
        }
        activeByBinding.delete(key)
      }
      const created: InternalChallenge = {
        sessionId: parsed.sessionId,
        transition: parsed.transition,
        purpose: parsed.purpose,
        challengeId: createChallengeId(++challengeCounter),
        resourceDigest,
        createdAt: now,
        state: 'pending',
      }
      challenges.set(created.challengeId, created)
      activeByBinding.set(key, created.challengeId)
      return { status: 'pending', challenge: buildChallengeRecord(created) }
    } catch {
      return rejected('invalid-input')
    }
  }

  function bindAsked(input: unknown): BindAskedResult {
    try {
      const parsed = parseBindInput(input)
      if (parsed === null) return rejected('invalid-input')
      expireChallenges(readNow(clock))
      const challenge = findBindChallenge(parsed)
      if (challenge === null) return rejected('unknown-challenge')
      const stateRejection = bindStateRejection(challenge, parsed)
      if (stateRejection !== null) return rejected(stateRejection)
      challenge.state = 'bound'
      challenge.callId = parsed.callId
      challenge.requestId = parsed.requestId
      challengeByRequest.set(parsed.requestId, challenge.challengeId)
      seenRequestIds.add(parsed.requestId)
      return {
        status: 'bound',
        challengeId: challenge.challengeId,
        requestId: parsed.requestId,
      }
    } catch {
      return rejected('invalid-input')
    }
  }

  function observeReply(input: unknown): ObserveReplyResult {
    try {
      const parsed = parseReplyInput(input)
      if (parsed === null) return rejected('invalid-input')
      expireChallenges(readNow(clock))
      const challenge = requestChallenge(parsed.requestId)
      if (challenge === null) {
        const replay = seenRequestIds.has(parsed.requestId)
        seenRequestIds.add(parsed.requestId)
        return rejected(replay ? 'replay' : 'unknown-request')
      }
      const stateRejection = replyStateRejection(challenge, parsed)
      if (stateRejection !== null) return rejected(stateRejection)
      if (classifyQuestionAnswer(parsed.answer) !== 'affirmative') {
        challenge.state = 'denied'
        removeActiveChallenge(challenge)
        return rejected('non-affirmative')
      }
      const attestation: InternalAttestation = {
        purpose: challenge.purpose,
        sessionId: challenge.sessionId,
        resourceDigest: challenge.resourceDigest,
        transitionKey: challenge.transition,
        requestId: parsed.requestId,
        answer: 'affirmed',
        timestamp: readNow(clock),
        consumption: 'available',
      }
      challenge.state = 'consumed'
      removeActiveChallenge(challenge)
      attestations.set(parsed.requestId, attestation)
      return { status: 'accepted', attestation: cloneAttestation(attestation) }
    } catch {
      return rejected('invalid-input')
    }
  }

  function observeReject(input: unknown): ObserveRejectResult {
    try {
      const parsed = parseRejectInput(input)
      if (parsed === null) return rejected('invalid-input')
      expireChallenges(readNow(clock))
      const challenge = requestChallenge(parsed.requestId)
      if (challenge === null) {
        const replay = seenRequestIds.has(parsed.requestId)
        seenRequestIds.add(parsed.requestId)
        return rejected(replay ? 'replay' : 'unknown-request')
      }
      const stateRejection = rejectStateRejection(challenge, parsed)
      if (stateRejection !== null) return rejected(stateRejection)
      challenge.state = 'denied'
      removeActiveChallenge(challenge)
      return { status: 'rejected', reasonCode: 'rejected' }
    } catch {
      return rejected('invalid-input')
    }
  }

  function consumeAttestation(input: unknown): ConsumeAttestationResult {
    try {
      const parsed = parseConsumeInput(input)
      if (parsed === null) return rejected('invalid-input')
      const resourceDigest = digestResource(parsed.resource)
      const attestation = attestations.get(parsed.requestId)
      if (attestation === undefined) return rejected('no-attestation')
      if (
        attestation.purpose !== parsed.purpose ||
        attestation.sessionId !== parsed.sessionId ||
        attestation.resourceDigest !== resourceDigest ||
        attestation.transitionKey !== parsed.transition
      ) {
        return rejected('scope-mismatch')
      }
      if (attestation.consumption === 'consumed')
        return rejected('already-consumed')
      attestation.consumption = 'consumed'
      if (attestation.purpose === 'session-disablement') {
        disabledSessions.add(attestation.sessionId)
      }
      return {
        status: 'consumed',
        projection:
          attestation.purpose === 'session-disablement'
            ? 'disabled'
            : 'attested',
        attestation: cloneAttestation(attestation),
      }
    } catch {
      return rejected('invalid-input')
    }
  }

  function status(input: unknown): QuestionAttestationProjection {
    try {
      if (!isRecord(input))
        return { status: 'unknown', reasonCode: 'invalid-input' }
      expireChallenges(readNow(clock))
      if (input.challengeId !== undefined) {
        if (
          !hasOnlyFields(input, ['challengeId']) ||
          !isChallengeId(input.challengeId)
        ) {
          return { status: 'unknown', reasonCode: 'invalid-input' }
        }
      } else if (
        !hasOnlyFields(input, [
          'sessionId',
          'resource',
          'transition',
          'purpose',
        ])
      ) {
        return { status: 'unknown', reasonCode: 'invalid-input' }
      }
      const challenge = statusChallenge(input)
      if (challenge === null)
        return { status: 'unknown', reasonCode: 'unknown-challenge' }
      return projectChallenge(challenge)
    } catch {
      return { status: 'unknown', reasonCode: 'invalid-input' }
    }
  }

  function sessionStatus(input: unknown): SessionDisablementProjection {
    try {
      if (
        !isRecord(input) ||
        !hasOnlyFields(input, ['sessionId']) ||
        !isCleanBoundedString(input.sessionId, MAX_ID_LENGTH)
      ) {
        return { status: 'unknown', reasonCode: 'invalid-input' }
      }
      expireChallenges(readNow(clock))
      const sessionId = input.sessionId
      if (disabledSessions.has(sessionId))
        return { status: 'disabled', sessionId }
      for (const challenge of challenges.values()) {
        if (
          challenge.sessionId === sessionId &&
          challenge.purpose === 'session-disablement' &&
          (challenge.state === 'pending' || challenge.state === 'bound')
        ) {
          return { status: challenge.state, sessionId }
        }
      }
      return { status: 'enabled', sessionId }
    } catch {
      return { status: 'unknown', reasonCode: 'invalid-input' }
    }
  }

  return {
    challenge,
    bindAsked,
    observeReply,
    observeReject,
    consumeAttestation,
    status,
    sessionStatus,
  }
}
