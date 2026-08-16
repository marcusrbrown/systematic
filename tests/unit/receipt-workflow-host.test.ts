import { describe, expect, test } from 'bun:test'

import {
  assertMixedVersionProbeEvents,
  type ProbeEvent,
} from '../integration/fixtures/receipt-workflow-host.js'

const WORKFLOW_OPEN = '<SYSTEMATIC_WORKFLOWS>'
const WORKFLOW_CLOSE = '</SYSTEMATIC_WORKFLOWS>'
const SKILL_GUIDANCE =
  'Use `systematic_skill` to load Systematic bundled skills'

function chatEvents(system: readonly string[]): ProbeEvent[] {
  return [
    { type: 'loaded' },
    {
      type: 'system',
      kind: 'chat',
      input: { sessionID: 'test-session', model: {} },
      system: [...system],
    },
  ]
}

describe('receipt workflow host assertions', () => {
  test('accepts one closed workflow block with skill discovery guidance', () => {
    expect(() =>
      assertMixedVersionProbeEvents(
        chatEvents([`${WORKFLOW_OPEN}\n${SKILL_GUIDANCE}\n${WORKFLOW_CLOSE}`]),
      ),
    ).not.toThrow()
  })

  test('rejects an extra closing marker anywhere in the system entries', () => {
    expect(() =>
      assertMixedVersionProbeEvents(
        chatEvents([
          `${WORKFLOW_OPEN}\n${SKILL_GUIDANCE}\n${WORKFLOW_CLOSE}`,
          WORKFLOW_CLOSE,
        ]),
      ),
    ).toThrow()
  })

  test('rejects a workflow block without systematic_skill guidance', () => {
    expect(() =>
      assertMixedVersionProbeEvents(
        chatEvents([`${WORKFLOW_OPEN}\n${WORKFLOW_CLOSE}`]),
      ),
    ).toThrow()
  })
})
