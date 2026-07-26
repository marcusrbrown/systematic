import { describe, expect, test } from 'bun:test'

import {
  CANONICAL_QUESTION_WORDING,
  classifyQuestionAnswer,
  createQuestionAttestation,
  type QuestionPurpose,
} from '../../src/lib/question-attestation.js'

const SESSION_ID = 'session-a'
const RESOURCE = '/private/workspaces/project-a'
const OTHER_RESOURCE = '/private/workspaces/project-b'
const TRANSITION = 'unit-completion'
const OTHER_TRANSITION = 'epoch-completion'

function createChallenge(
  machine: ReturnType<typeof createQuestionAttestation>,
  purpose: QuestionPurpose = 'transition',
  sessionId = SESSION_ID,
  resource = RESOURCE,
  transition = TRANSITION,
) {
  const result = machine.challenge({
    sessionId,
    resource,
    transition,
    purpose,
  })
  expect(result.status).toBe('pending')
  if (result.status !== 'pending') throw new Error('challenge was not created')
  return result.challenge
}

function bindChallenge(
  machine: ReturnType<typeof createQuestionAttestation>,
  challengeId: string,
  requestId = 'request-1',
  callId = 'call-1',
  sessionId = SESSION_ID,
) {
  return machine.bindAsked({
    challengeId,
    sessionId,
    callId,
    requestId,
  })
}

function affirm(
  machine: ReturnType<typeof createQuestionAttestation>,
  requestId = 'request-1',
  sessionId = SESSION_ID,
) {
  return machine.observeReply({ sessionId, requestId, answer: 'yes' })
}

describe('question attestation', () => {
  test('mints and consumes one attestation through the complete correlated flow', () => {
    const machine = createQuestionAttestation({
      clock: () => 1_700_000_000_000,
    })
    const challenge = createChallenge(machine)

    expect(challenge.question).toEqual({
      wording: CANONICAL_QUESTION_WORDING,
      args: {
        challengeId: challenge.challengeId,
        purpose: 'transition',
        resourceDigest: challenge.resourceDigest,
        transitionKey: TRANSITION,
      },
    })
    expect(JSON.stringify(challenge)).not.toContain(RESOURCE)

    expect(bindChallenge(machine, challenge.challengeId)).toMatchObject({
      status: 'bound',
      requestId: 'request-1',
    })

    const reply = affirm(machine)
    expect(reply).toMatchObject({ status: 'accepted' })
    if (reply.status !== 'accepted') throw new Error('reply was not accepted')
    expect(reply.attestation).toEqual({
      purpose: 'transition',
      sessionId: SESSION_ID,
      resourceDigest: challenge.resourceDigest,
      transitionKey: TRANSITION,
      requestId: 'request-1',
      answer: 'affirmed',
      timestamp: 1_700_000_000_000,
      consumption: 'available',
    })

    expect(
      machine.consumeAttestation({
        purpose: 'transition',
        sessionId: SESSION_ID,
        resource: RESOURCE,
        transition: TRANSITION,
        requestId: 'request-1',
      }),
    ).toMatchObject({
      status: 'consumed',
      projection: 'attested',
      attestation: { consumption: 'consumed' },
    })

    expect(
      machine.consumeAttestation({
        purpose: 'transition',
        sessionId: SESSION_ID,
        resource: RESOURCE,
        transition: TRANSITION,
        requestId: 'request-1',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'already-consumed' })
  })

  test('denies a non-affirmative reply and cannot consume it', () => {
    const machine = createQuestionAttestation()
    const challenge = createChallenge(machine)
    expect(bindChallenge(machine, challenge.challengeId)).toMatchObject({
      status: 'bound',
    })

    expect(
      machine.observeReply({
        sessionId: SESSION_ID,
        requestId: 'request-1',
        answer: 'yes, I agree to everything',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'non-affirmative' })
    expect(
      machine.consumeAttestation({
        purpose: 'transition',
        sessionId: SESSION_ID,
        resource: RESOURCE,
        transition: TRANSITION,
        requestId: 'request-1',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'no-attestation' })
  })

  test('rejects replayed request IDs and request substitution', () => {
    const machine = createQuestionAttestation()
    const first = createChallenge(machine)
    expect(bindChallenge(machine, first.challengeId)).toMatchObject({
      status: 'bound',
    })
    expect(affirm(machine)).toMatchObject({ status: 'accepted' })
    expect(affirm(machine)).toMatchObject({
      status: 'rejected',
      reasonCode: 'replay',
    })

    const second = createChallenge(
      machine,
      'transition',
      SESSION_ID,
      OTHER_RESOURCE,
    )
    expect(
      bindChallenge(machine, second.challengeId, 'request-1', 'call-2'),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'replay',
    })

    const third = createChallenge(
      machine,
      'transition',
      SESSION_ID,
      OTHER_RESOURCE,
    )
    expect(
      bindChallenge(machine, third.challengeId, 'request-3', 'call-3'),
    ).toMatchObject({
      status: 'bound',
    })
    expect(
      bindChallenge(machine, third.challengeId, 'request-4', 'call-3'),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'substitution',
    })
    expect(
      bindChallenge(machine, third.challengeId, 'request-3', 'call-4'),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'already-bound',
    })
  })

  test('rejects cross-scope consumption without consuming the valid attestation', () => {
    const machine = createQuestionAttestation()
    const challenge = createChallenge(machine)
    bindChallenge(machine, challenge.challengeId)
    expect(affirm(machine)).toMatchObject({ status: 'accepted' })

    const scopes = [
      { sessionId: 'session-b' },
      { resource: OTHER_RESOURCE },
      { transition: OTHER_TRANSITION },
      { purpose: 'session-disablement' as const },
    ]
    for (const scope of scopes) {
      expect(
        machine.consumeAttestation({
          purpose: scope.purpose ?? 'transition',
          sessionId: scope.sessionId ?? SESSION_ID,
          resource: scope.resource ?? RESOURCE,
          transition: scope.transition ?? TRANSITION,
          requestId: 'request-1',
        }),
      ).toMatchObject({ status: 'rejected', reasonCode: 'scope-mismatch' })
    }

    expect(
      machine.consumeAttestation({
        purpose: 'transition',
        sessionId: SESSION_ID,
        resource: RESOURCE,
        transition: TRANSITION,
        requestId: 'request-1',
      }),
    ).toMatchObject({ status: 'consumed' })
  })

  test('does not treat an unbound reply as evidence', () => {
    const machine = createQuestionAttestation()

    expect(
      machine.observeReply({
        sessionId: SESSION_ID,
        requestId: 'unbound-request',
        answer: 'yes',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'unknown-request' })
    expect(
      machine.consumeAttestation({
        purpose: 'transition',
        sessionId: SESSION_ID,
        resource: RESOURCE,
        transition: TRANSITION,
        requestId: 'unbound-request',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'no-attestation' })
  })

  test('rejects a bound request and makes the rejection terminal', () => {
    const machine = createQuestionAttestation()
    const challenge = createChallenge(machine)
    bindChallenge(machine, challenge.challengeId)

    expect(
      machine.observeReject({ sessionId: SESSION_ID, requestId: 'request-1' }),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'rejected',
    })
    expect(
      machine.observeReject({ sessionId: SESSION_ID, requestId: 'request-1' }),
    ).toMatchObject({
      status: 'rejected',
      reasonCode: 'already-consumed',
    })
    expect(
      machine.status({ challengeId: challenge.challengeId }),
    ).toMatchObject({ status: 'denied' })
    expect(
      machine.consumeAttestation({
        purpose: 'transition',
        sessionId: SESSION_ID,
        resource: RESOURCE,
        transition: TRANSITION,
        requestId: 'request-1',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'no-attestation' })
  })

  test('uses the same chain for per-session disablement and projects disabled state', () => {
    const machine = createQuestionAttestation()
    const challenge = createChallenge(machine, 'session-disablement')
    bindChallenge(machine, challenge.challengeId)
    expect(affirm(machine)).toMatchObject({ status: 'accepted' })

    const consumed = machine.consumeAttestation({
      purpose: 'session-disablement',
      sessionId: SESSION_ID,
      resource: RESOURCE,
      transition: TRANSITION,
      requestId: 'request-1',
    })
    expect(consumed).toMatchObject({
      status: 'consumed',
      projection: 'disabled',
      attestation: { purpose: 'session-disablement' },
    })
    expect(machine.sessionStatus({ sessionId: SESSION_ID })).toMatchObject({
      status: 'disabled',
    })
    expect(machine.sessionStatus({ sessionId: 'session-b' })).toMatchObject({
      status: 'enabled',
    })
    expect(
      machine.challenge({
        sessionId: SESSION_ID,
        resource: RESOURCE,
        transition: TRANSITION,
        purpose: 'session-disablement',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'already-disabled' })
  })

  test('stores only bounded metadata and uses an exact affirmative allowlist', () => {
    expect(classifyQuestionAnswer('yes')).toBe('affirmative')
    expect(classifyQuestionAnswer('confirm')).toBe('affirmative')
    expect(classifyQuestionAnswer('YES')).toBe('non-affirmative')
    expect(classifyQuestionAnswer('yes please')).toBe('non-affirmative')
    expect(classifyQuestionAnswer({ answer: 'yes' })).toBe('non-affirmative')
    expect(classifyQuestionAnswer(1)).toBe('non-affirmative')

    const machine = createQuestionAttestation({ clock: () => 123 })
    const challenge = createChallenge(machine)
    expect(JSON.stringify(challenge)).not.toContain(RESOURCE)
    bindChallenge(machine, challenge.challengeId)
    const reply = machine.observeReply({
      sessionId: SESSION_ID,
      requestId: 'request-1',
      answer: 'yes',
    })
    expect(reply).toMatchObject({ status: 'accepted' })
    if (reply.status !== 'accepted') throw new Error('reply was not accepted')
    expect(JSON.stringify(reply.attestation)).not.toContain('yes')
    expect(JSON.stringify(reply.attestation)).not.toContain('user prose')
  })

  test('idempotently returns one pending challenge and fails closed on malformed input', () => {
    const machine = createQuestionAttestation()
    const first = machine.challenge({
      sessionId: SESSION_ID,
      resource: RESOURCE,
      transition: TRANSITION,
      purpose: 'transition',
    })
    const second = machine.challenge({
      sessionId: SESSION_ID,
      resource: RESOURCE,
      transition: TRANSITION,
      purpose: 'transition',
    })
    expect(second).toEqual(first)

    expect(machine.challenge(null)).toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-input',
    })
    expect(
      machine.challenge({
        sessionId: SESSION_ID,
        resource: 'x'.repeat(513),
        transition: TRANSITION,
        purpose: 'transition',
      }),
    ).toMatchObject({ status: 'rejected', reasonCode: 'invalid-input' })
    expect(machine.bindAsked({})).toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-input',
    })
    expect(machine.observeReject({})).toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-input',
    })
    expect(machine.consumeAttestation({})).toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-input',
    })
  })

  test('keeps state closure-scoped across machine registrations', () => {
    const first = createQuestionAttestation()
    const second = createQuestionAttestation()
    const firstChallenge = createChallenge(first)
    const secondChallenge = createChallenge(second)

    expect(firstChallenge.challengeId).not.toBe(secondChallenge.challengeId)
    expect(bindChallenge(first, secondChallenge.challengeId)).toMatchObject({
      status: 'rejected',
      reasonCode: 'unknown-challenge',
    })
  })
})
