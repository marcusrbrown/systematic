// U5 real-host scenario: prove a real OpenCode scripted host loads the
// packaged `ce:review` skill content and then invokes the packaged
// `skills/ce-review/scripts/validate-review.mjs` helper's standalone
// `return` subcommand through its `SKILL_DIR` anchor -- once with a
// conforming payload and once with a malformed one -- and that the
// validator run writes nothing. `return` remains a supported CLI subcommand
// even though SKILL.md's Stage 4 raw-return admission call site now
// documents `screen` instead (Unit 6 replaced the inline `return` block
// there with a `screen` call site linking to
// references/pipeline-invocation.md#screen); this test also asserts the
// loaded SKILL.md prose reflects that `screen` call site and that the
// retired `return` invocation form is absent from it.
//
// The scripted model issues the exact Bash command this test constructs
// directly; the assertions read the host-visible tool parts (command, exit,
// output), not a fake parser. No marker writes are added to any production
// script.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type { z } from 'zod'

import { requireOpencodeAvailable } from '../../scripts/lib/opencode-availability.js'
import {
  applyReviewAdjudication,
  finalizeReview,
  prepareReviewCandidates,
  screenReviewReturn,
} from '../../src/lib/review-pipeline.js'
import {
  type AdjudicationEnvelopeSchema,
  FinalizeInputSchema,
} from '../../src/lib/review-pipeline-contract.js'
import {
  cleanupPackedTarball,
  createIsolatedFixture,
  destroyIsolatedFixture,
  extractPackagedPlugin,
  getOpencodeAvailability,
  type IsolatedFixture,
  isOpencodeAvailable,
  opencodeAvailabilityReason,
  packTarballOnce,
  REPO_ROOT,
  startOpencodeServer,
  stopAllOpencodeHosts,
  TIMEOUT_MS,
} from './fixtures/receipt-workflow-host.js'

requireOpencodeAvailable(getOpencodeAvailability())
if (!isOpencodeAvailable()) {
  console.warn(
    `[systematic] skipping OpenCode-dependent tests in ce-review-return-validation.test.ts: ${opencodeAvailabilityReason()}`,
  )
}

const MOCK_PROVIDER_ID = 'systematic-ce-review-return-probe'
const MOCK_MODEL_ID = 'ce-review-return-probe-model'
const VALIDATOR_RELATIVE = 'scripts/validate-review.mjs'

// Fresh, collision-free quoted-heredoc delimiters. The old fixed token is
// deliberately embedded inside the adversarial payload to prove it cannot
// terminate the heredoc and execute the injected shell lines.
const VALID_DELIMITER = 'REVIEW_RETURN_VALID_7C1F0A'
const MALFORMED_DELIMITER = 'REVIEW_RETURN_MALFORMED_9D2E4B'
const OLD_FIXED_DELIMITER = 'SYSTEMATIC_REVIEW_RETURN_EOF'

const VALID_RETURN = JSON.stringify({
  reviewer: 'correctness',
  findings: [],
  residual_risks: [],
  testing_gaps: [],
})

function malformedReturnPayload(canaryPath: string): string {
  const canary = JSON.stringify(canaryPath)
  return [
    '{ "reviewer": "correctness", "findings": [',
    OLD_FIXED_DELIMITER,
    `touch ${canary}`,
    `$(touch ${canary})`,
  ].join('\n')
}

interface ScriptedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface ScriptedResponse {
  text?: string
  toolCalls?: ScriptedToolCall[]
}

interface MockModelServer {
  url: string
  stop(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sseChunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function responseChunks(
  response: ScriptedResponse,
  id: string,
  created: number,
): Record<string, unknown>[] {
  if (response.toolCalls && response.toolCalls.length > 0) {
    return [
      ...response.toolCalls.map((toolCall, index) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model: MOCK_MODEL_ID,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: toolCall.id,
                  type: 'function',
                  function: {
                    name: toolCall.name,
                    arguments: JSON.stringify(toolCall.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })),
      {
        id,
        object: 'chat.completion.chunk',
        created,
        model: MOCK_MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ]
  }
  const text = response.text ?? ''
  return [
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model: MOCK_MODEL_ID,
      choices: [
        {
          index: 0,
          delta: text ? { role: 'assistant' } : {},
          finish_reason: null,
        },
      ],
    },
    ...(text
      ? [
          {
            id,
            object: 'chat.completion.chunk',
            created,
            model: MOCK_MODEL_ID,
            choices: [
              { index: 0, delta: { content: text }, finish_reason: null },
            ],
          },
        ]
      : []),
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model: MOCK_MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ]
}

function startMockModelServer(
  responses: readonly ScriptedResponse[],
): MockModelServer {
  let requestIndex = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        !request.url.endsWith('/chat/completions')
      ) {
        return new Response('not found', { status: 404 })
      }
      const response = responses[requestIndex] ?? { text: '' }
      requestIndex += 1
      const chunks = responseChunks(
        response,
        `ce-review-return-probe-${requestIndex}`,
        Math.floor(Date.now() / 1000),
      )
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(sseChunk(chunk)))
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

function buildProviderConfig(
  pluginUrls: readonly string[],
  baseUrl: string,
): string {
  return JSON.stringify({
    formatter: false,
    lsp: false,
    plugin: pluginUrls,
    provider: {
      [MOCK_PROVIDER_ID]: {
        name: 'CE Review Return Probe',
        id: MOCK_PROVIDER_ID,
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [MOCK_MODEL_ID]: {
            id: MOCK_MODEL_ID,
            name: 'CE Review Return Probe Model',
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: '2026-09-10',
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: 'unused-ce-review-return-key', baseURL: baseUrl },
      },
    },
  })
}

/** The exact command shape the skill prose documents: stdin-only, no argv JSON. */
function returnCommand(
  skillDir: string,
  payload: string,
  delimiter: string,
): string {
  return [
    `SKILL_DIR=${JSON.stringify(skillDir)};`,
    `node "$SKILL_DIR/scripts/validate-review.mjs" return <<'${delimiter}'`,
    payload,
    delimiter,
  ].join('\n')
}

function toolParts(
  messages: unknown[],
  toolName: string,
): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    if (!isRecord(message) || !Array.isArray(message.parts)) return []
    return message.parts.filter((part): part is Record<string, unknown> => {
      if (!isRecord(part)) return false
      return part.type === 'tool' && part.tool === toolName
    })
  })
}

function repoStatus(): string {
  return Bun.spawnSync(['git', 'status', '--short', '--untracked-files=all'], {
    cwd: REPO_ROOT,
  })
    .stdout.toString()
    .trim()
}

interface BashRunDescription {
  command: string
  exit: number
  output: string
}

function describeBash(part: Record<string, unknown>): BashRunDescription {
  const state = (part.state ?? {}) as Record<string, unknown>
  const input = isRecord(state.input) ? state.input : {}
  const metadata = isRecord(state.metadata) ? state.metadata : {}
  // `state.output` is the display string ("(no output)" when the command
  // wrote nothing to the UI stream); the captured text lives in
  // `metadata.output` on this host.
  const captured = [state.output, metadata.output].filter(
    (value): value is string =>
      typeof value === 'string' && value !== '(no output)',
  )
  return {
    command: typeof input.command === 'string' ? input.command : '',
    exit: Number(metadata.exit),
    output: captured.join('\n'),
  }
}

/** Locates one scripted bash run by a unique marker in its command text
 * (its fresh heredoc delimiter, or another string known to appear in only
 * one scripted command) rather than by part id/order, which is fragile. */
function findBashRun(
  runs: readonly BashRunDescription[],
  marker: string,
): BashRunDescription {
  const run = runs.find((candidate) => candidate.command.includes(marker))
  if (!run) {
    throw new Error(`expected a scripted bash command containing ${marker}`)
  }
  return run
}

// ═══════════════════════════════════════════════════════════════════════════
// U7 real-host scenario: prove one complete Stage 4-6 synthesis run --
// `screen` (three personas), `prepare`, `merge`, and `finalize` -- through the
// real OpenCode scripted host, in a writing mode (persisted, validated
// artifact) and a report-only mode (no filesystem mutation), using the exact
// heredoc invocation shape `pipeline-invocation.md` documents at every phase.
//
// Every envelope fed to `prepare`, `merge`, and `finalize` is produced by
// calling the same pure library functions the packaged script is generated
// from (`screenReviewReturn`, `prepareReviewCandidates`,
// `applyReviewAdjudication`, `finalizeReview`) -- never hand-typed -- the same
// approach `ce-review-validator-packaging.test.ts`'s "finalize: repair-class
// fixture" describe uses. Only the three raw reviewer returns, the merge
// adjudication decision, the validator lifecycle result, the plan
// assessment, and the parent run metadata are hand-written. The in-process
// `finalizeReview` call additionally gives each test a precomputed
// expectation to assert the real host's `finalize` output against, and lets
// the report-only scenario compare against the writing scenario's report
// without threading state between two independent test bodies.
// ═══════════════════════════════════════════════════════════════════════════

const PIPELINE_AUTH_FILE = 'src/auth/session.ts'
const PIPELINE_BILLING_FILE = 'src/billing/invoice.ts'

function pipelineFinding(overrides: {
  readonly file: string
  readonly line: number
  readonly severity: 'P1' | 'P2' | 'P3'
  readonly requires_verification: boolean
  readonly title: string
  readonly why_it_matters: string
  readonly evidence: readonly string[]
  readonly suggested_fix: string
}): Record<string, unknown> {
  return {
    autofix_class: 'gated_auto',
    confidence: 0.85,
    owner: 'downstream-resolver',
    pre_existing: false,
    ...overrides,
  }
}

// Three-persona run: `correctness` and `maintainability` return real JSON
// payloads; `security` (risk-critical) returns malformed JSON, so its
// `screen` call itself is structurally rejected (exit 1) rather than
// admitted.
const PIPELINE_CORRECTNESS_RETURN = {
  findings: [
    pipelineFinding({
      evidence: [
        `${PIPELINE_AUTH_FILE}:42 rotates the session token on login only.`,
      ],
      file: PIPELINE_AUTH_FILE,
      line: 42,
      requires_verification: false,
      severity: 'P2',
      suggested_fix:
        'Rotate the session token on every privilege change, not just login.',
      title: 'Session token not rotated after privilege change',
      why_it_matters:
        'A stale session token remains valid after a privilege change, letting a revoked or downgraded session act with its old privileges.',
    }),
    pipelineFinding({
      evidence: [
        `${PIPELINE_BILLING_FILE}:10 applies the discount after the total is persisted.`,
      ],
      file: PIPELINE_BILLING_FILE,
      line: 10,
      requires_verification: true,
      severity: 'P1',
      suggested_fix: 'Apply the discount before computing the persisted total.',
      title: 'Invoice total computed before discount applied',
      why_it_matters:
        'Persisted invoice totals omit an already-approved discount, overcharging the customer.',
    }),
  ],
  residual_risks: [],
  reviewer: 'correctness',
  testing_gaps: [],
}

const PIPELINE_MAINTAINABILITY_RETURN = {
  findings: [
    pipelineFinding({
      evidence: [
        `${PIPELINE_AUTH_FILE}:42 duplicates rotation logic across three handlers.`,
      ],
      file: PIPELINE_AUTH_FILE,
      line: 42,
      requires_verification: false,
      severity: 'P3',
      suggested_fix: 'Extract the rotation logic into one shared helper.',
      title: 'Session rotation logic duplicated across handlers',
      why_it_matters:
        'Duplicated rotation logic drifts silently; a fix applied to one handler is easy to miss in the others.',
    }),
  ],
  residual_risks: [],
  reviewer: 'maintainability',
  testing_gaps: [],
}

// Deliberately incomplete JSON: `screen` rejects it as a whole-payload
// `malformed` outcome (never a partial finding-level rejection -- `screen`
// has no such thing) with the fixed rejection message and empty stdout.
const PIPELINE_SECURITY_MALFORMED_PAYLOAD =
  '{ "reviewer": "security", "findings": ['

const PIPELINE_CORRECTNESS_SCREEN = screenReviewReturn({
  expected_reviewer: 'correctness',
  raw_return: PIPELINE_CORRECTNESS_RETURN,
})
const PIPELINE_MAINTAINABILITY_SCREEN = screenReviewReturn({
  expected_reviewer: 'maintainability',
  raw_return: PIPELINE_MAINTAINABILITY_RETURN,
})
// Constructed directly, never through `screenReviewReturn`: the real `screen`
// call for this persona rejects the payload (exit 1) and prints no envelope
// to admit, so the parent hand-builds the `malformed` entry per
// pipeline-invocation.md's exit-1 handling, exactly as the unit-test fixture
// hand-builds a `validation_unavailable` entry for its exit-2 case.
const PIPELINE_SECURITY_SCREEN = {
  admitted_findings: [],
  dispatch_outcome: 'malformed',
  residual_risks: [],
  testing_gaps: [],
}

const PIPELINE_SCREEN_RESULTS = [
  { result: PIPELINE_CORRECTNESS_SCREEN, reviewer: 'correctness' },
  { result: PIPELINE_MAINTAINABILITY_SCREEN, reviewer: 'maintainability' },
  { result: PIPELINE_SECURITY_SCREEN, reviewer: 'security' },
]

const PIPELINE_SELECTED_DISPATCHES = [
  {
    dispatch_outcome: 'findings',
    persona: 'correctness',
    selection_surface: [PIPELINE_AUTH_FILE, PIPELINE_BILLING_FILE],
  },
  {
    dispatch_outcome: 'findings',
    persona: 'maintainability',
    selection_surface: [PIPELINE_AUTH_FILE],
  },
  {
    dispatch_outcome: 'malformed',
    persona: 'security',
    selection_surface: [PIPELINE_AUTH_FILE],
  },
]

const PIPELINE_PREPARE_RAW_INPUT = {
  screen_results: PIPELINE_SCREEN_RESULTS,
  selected_dispatches: PIPELINE_SELECTED_DISPATCHES,
}

const PIPELINE_PREPARE_RESULT = prepareReviewCandidates({
  raw_input: PIPELINE_PREPARE_RAW_INPUT,
})
if (!PIPELINE_PREPARE_RESULT.ok) {
  throw new Error(
    `U7 pipeline fixture setup: prepare rejected: ${JSON.stringify(PIPELINE_PREPARE_RESULT.rejection)}`,
  )
}
const PIPELINE_PREPARED = PIPELINE_PREPARE_RESULT.value

// One candidate group forms on `PIPELINE_AUTH_FILE` (correctness +
// maintainability); correctness's billing finding is a true passthrough
// singleton needing no decision at all. Explicitly typed from the exported
// envelope schema (rather than `as const`) so `disposition: 'merged'` stays
// literal-narrowed while the array itself stays mutable, matching what both
// `applyReviewAdjudication` and the `merge` bash payload need.
const PIPELINE_MERGE_DECISIONS: z.infer<
  typeof AdjudicationEnvelopeSchema
>['decisions'] = [
  {
    decision_id: 'merged-session-rotation',
    disposition: 'merged',
    evidence: [
      `${PIPELINE_AUTH_FILE}:42 shows both the missing rotation and the duplicated logic.`,
    ],
    input_finding_ids: ['correctness#0', 'maintainability#0'],
    line: 42,
    suggested_fix:
      'Rotate the session token on every privilege change, via one shared helper.',
    title: 'Session token not rotated after privilege change',
    why_it_matters:
      'A stale session token remains valid after a privilege change, letting a revoked or downgraded session act with its old privileges.',
  },
]

const PIPELINE_MERGE_RESULT = applyReviewAdjudication({
  decisions: PIPELINE_MERGE_DECISIONS,
  prepared: PIPELINE_PREPARED,
})
if (!PIPELINE_MERGE_RESULT.ok) {
  throw new Error(
    `U7 pipeline fixture setup: merge rejected: ${JSON.stringify(PIPELINE_MERGE_RESULT.rejection)}`,
  )
}
const PIPELINE_MERGE = PIPELINE_MERGE_RESULT.value

// Sanity on the shape the plan calls for: one merged two-reviewer finding,
// one singleton, and exactly one validator request (the P1 billing
// singleton -- the merged finding is P2/no-verification, so it never enters
// the validation band).
if (PIPELINE_MERGE.merged_findings.length !== 2) {
  throw new Error(
    `U7 pipeline fixture setup: expected 2 merged findings, got ${PIPELINE_MERGE.merged_findings.length}`,
  )
}
const PIPELINE_SINGLETON_REQUEST = PIPELINE_MERGE.validator_requests[0]
if (
  PIPELINE_MERGE.validator_requests.length !== 1 ||
  !PIPELINE_SINGLETON_REQUEST
) {
  throw new Error(
    'U7 pipeline fixture setup: expected exactly one validator request',
  )
}
const PIPELINE_SINGLETON_FINDING_ID = PIPELINE_SINGLETON_REQUEST.finding_id

const PIPELINE_UNMET_REQUIREMENT_DESCRIPTION =
  'The plan requires the session token to rotate on every privilege change; the shipped diff only rotates it on login.'

const PIPELINE_PLAN_ASSESSMENT = {
  results: [
    {
      description: PIPELINE_UNMET_REQUIREMENT_DESCRIPTION,
      kind: 'explicit_unmet_requirement' as const,
    },
  ],
  verdict: 'One requirement not yet met.',
}

function buildPipelineFinalizeInput(
  mode: 'interactive' | 'report-only',
  runId: string,
): Record<string, unknown> {
  return {
    dispatch_records: PIPELINE_SELECTED_DISPATCHES,
    merge: PIPELINE_MERGE,
    parent_run_metadata: {
      applied_fixes: [],
      branch: 'main',
      harness: 'opencode',
      head_sha: 'd'.repeat(40),
      mode,
      run_id: runId,
      selected_dispatches: PIPELINE_SELECTED_DISPATCHES,
      timestamps: {
        completed_at: '2026-01-01T00:05:00.000Z',
        started_at: '2026-01-01T00:00:00.000Z',
      },
      validation: { reason: 'no autofix applied', status: 'not_attempted' },
    },
    plan_assessment: PIPELINE_PLAN_ASSESSMENT,
    prepared: PIPELINE_PREPARED,
    screen_results: PIPELINE_SCREEN_RESULTS,
    // One filtered validation result: a validator disproves the P1 billing
    // singleton, so it is excluded from risk-coverage eligibility and marked
    // `validated: false` in the artifact/report.
    validator_lifecycle_results: [
      {
        finding_id: PIPELINE_SINGLETON_FINDING_ID,
        result: {
          outcome: 'false',
          reason:
            'Reproduction found the discount applied before persistence in the current code.',
        },
      },
    ],
  }
}

const PIPELINE_RUN_ID_WRITING = 'ce-review-int-writing-1'
const PIPELINE_RUN_ID_REPORT_ONLY = 'ce-review-int-report-only-1'

// Precomputed, in-process expectations for the real host's `finalize` output
// in each mode -- the same generated script the host runs is built from
// `finalizeReview` itself (see the `generator drift` describe above), so a
// deep-equal match against the host's captured output is a real consistency
// proof, not a tautology.
const PIPELINE_FINALIZE_WRITING_RESULT = finalizeReview(
  FinalizeInputSchema.parse(
    buildPipelineFinalizeInput('interactive', PIPELINE_RUN_ID_WRITING),
  ),
)
if (!PIPELINE_FINALIZE_WRITING_RESULT.ok) {
  throw new Error(
    `U7 pipeline fixture setup: finalize (writing) rejected: ${JSON.stringify(PIPELINE_FINALIZE_WRITING_RESULT.rejection)}`,
  )
}
const PIPELINE_FINALIZE_WRITING_EXPECTED =
  PIPELINE_FINALIZE_WRITING_RESULT.value
if (PIPELINE_FINALIZE_WRITING_EXPECTED.kind !== 'writing') {
  throw new Error(
    `U7 pipeline fixture setup: expected finalize kind "writing", got ${PIPELINE_FINALIZE_WRITING_EXPECTED.kind}`,
  )
}
const PIPELINE_FINALIZE_WRITING_ARTIFACT =
  PIPELINE_FINALIZE_WRITING_EXPECTED.artifact
const PIPELINE_FINALIZE_WRITING_REPORT =
  PIPELINE_FINALIZE_WRITING_EXPECTED.report

const PIPELINE_FINALIZE_REPORT_ONLY_RESULT = finalizeReview(
  FinalizeInputSchema.parse(
    buildPipelineFinalizeInput('report-only', PIPELINE_RUN_ID_REPORT_ONLY),
  ),
)
if (!PIPELINE_FINALIZE_REPORT_ONLY_RESULT.ok) {
  throw new Error(
    `U7 pipeline fixture setup: finalize (report-only) rejected: ${JSON.stringify(PIPELINE_FINALIZE_REPORT_ONLY_RESULT.rejection)}`,
  )
}
const PIPELINE_FINALIZE_REPORT_ONLY_EXPECTED =
  PIPELINE_FINALIZE_REPORT_ONLY_RESULT.value
if (PIPELINE_FINALIZE_REPORT_ONLY_EXPECTED.kind !== 'report_only') {
  throw new Error(
    `U7 pipeline fixture setup: expected finalize kind "report_only", got ${PIPELINE_FINALIZE_REPORT_ONLY_EXPECTED.kind}`,
  )
}

// Fresh, collision-free delimiters for every pipeline-phase heredoc used
// below, one per distinct payload per pipeline-invocation.md's "never reuse a
// fixed delimiter across payloads" guidance. `screen`/`prepare`/`merge`
// payloads are byte-identical between the writing and report-only scenarios
// (only `parent_run_metadata` differs, and only inside `finalize`), so their
// delimiters are reused across both scenarios' bash calls rather than
// duplicated.
const SCREEN_CORRECTNESS_DELIMITER = 'PIPELINE_SCREEN_CORRECTNESS_3F8A21'
const SCREEN_SECURITY_DELIMITER = 'PIPELINE_SCREEN_SECURITY_MALFORMED_9B4E77'
const SCREEN_MAINTAINABILITY_DELIMITER =
  'PIPELINE_SCREEN_MAINTAINABILITY_5C2D80'
const PREPARE_DELIMITER = 'PIPELINE_PREPARE_INPUT_71AC4F'
const MERGE_DELIMITER = 'PIPELINE_MERGE_INPUT_E62B39'
// Two independent capture delimiters for the writing scenario's `finalize`
// determinism check: byte-identical stdin fed to two separate real-host
// invocations must produce byte-identical stdout.
const FINALIZE_WRITING_CAPTURE_A_DELIMITER =
  'PIPELINE_FINALIZE_WRITING_CAPTURE_A_0D9F5A'
const FINALIZE_WRITING_CAPTURE_B_DELIMITER =
  'PIPELINE_FINALIZE_WRITING_CAPTURE_B_7E1C48'
const FINALIZE_REPORT_ONLY_DELIMITER = 'PIPELINE_FINALIZE_REPORT_ONLY_2E9B60'

function assertDelimiterAbsent(payload: string, delimiter: string): void {
  expect(payload.split('\n').every((line) => line !== delimiter)).toBe(true)
}

/** One pipeline-phase invocation: reassigns `SKILL_DIR` and invokes
 * `node "$SKILL_DIR/scripts/validate-review.mjs" <invocation>` against a
 * fresh single-quoted heredoc, exactly as pipeline-invocation.md documents
 * every phase. `capturePath`, when given, redirects stdout to a file so the
 * test can read back the exact bytes the command wrote without relying on
 * the host's own (lossy, whitespace-joining) captured-output text. */
function pipelinePhaseCommand(
  skillDir: string,
  invocation: string,
  payload: string,
  delimiter: string,
  capturePath?: string,
): string {
  const redirect = capturePath ? ` > ${JSON.stringify(capturePath)}` : ''
  return [
    `SKILL_DIR=${JSON.stringify(skillDir)};`,
    `node "$SKILL_DIR/scripts/validate-review.mjs" ${invocation} <<'${delimiter}'${redirect}`,
    payload,
    delimiter,
  ].join('\n')
}

/** Atomically persists `review-summary.json` from an already-captured
 * `finalize` response: extracts the response's `artifact` field (never the
 * whole `{kind, artifact, report}` wrapper the CLI prints -- the artifact
 * schema has no `kind`/`report` fields, exactly like the unit test's
 * repair-class fixture writes `parsed.artifact`, not `parsed`, as the
 * persisted file) and writes it into a fresh temp file in the run
 * directory before renaming it over `review-summary.json` -- the same
 * capture-then-rename shape pipeline-invocation.md#persisting-the-artifact
 * describes. Uses a hand-rolled unique temp name (shell PID + `$RANDOM`)
 * rather than the `mktemp` binary: this host's BSD `mktemp` does not honor
 * a template suffix placed after the trailing `X` run (verified directly:
 * it left the literal "XXXXXX.tmp" in the resulting filename instead of
 * substituting it), which would silently defeat the uniqueness `mktemp` is
 * supposed to provide. `umask 077` gives the file the same owner-only
 * permissions the reference calls for. */
function pipelineFinalizePersistCommand(
  runDir: string,
  capturedFinalizePath: string,
): string {
  const extractArtifact = [
    "const fs = require('node:fs');",
    'const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));',
    'fs.writeFileSync(process.argv[2], JSON.stringify(data.artifact));',
  ].join(' ')
  return [
    '# u7-finalize-persist',
    `RUN_DIR=${JSON.stringify(runDir)};`,
    `CAPTURED_FINALIZE_PATH=${JSON.stringify(capturedFinalizePath)};`,
    'mkdir -p "$RUN_DIR"',
    'TMP_FILE="$RUN_DIR/.review-summary.$$.$RANDOM.tmp"',
    '(umask 077; : > "$TMP_FILE")',
    `if node -e ${JSON.stringify(extractArtifact)} "$CAPTURED_FINALIZE_PATH" "$TMP_FILE"`,
    'then',
    '  mv "$TMP_FILE" "$RUN_DIR/review-summary.json"',
    'else',
    '  rm -f "$TMP_FILE"',
    '  exit 1',
    'fi',
  ].join('\n')
}

function pipelineArtifactCommand(
  skillDir: string,
  artifactRelativePath: string,
): string {
  return [
    `SKILL_DIR=${JSON.stringify(skillDir)};`,
    `ARTIFACT_PATH=${JSON.stringify(artifactRelativePath)};`,
    'node "$SKILL_DIR/scripts/validate-review.mjs" artifact "$ARTIFACT_PATH"',
  ].join('\n')
}

describe.skipIf(!isOpencodeAvailable())(
  'ce:review return validation — real OpenCode scripted host',
  () => {
    beforeAll(() => {
      packTarballOnce()
    }, 200_000)

    afterAll(async () => {
      await stopAllOpencodeHosts()
      cleanupPackedTarball()
    })

    test(
      'loads the packaged skill, runs the SKILL_DIR validator for conforming and malformed returns, and writes nothing',
      async () => {
        const repoStatusBefore = repoStatus()
        const fixture: IsolatedFixture = createIsolatedFixture()
        const packaged = extractPackagedPlugin(fixture)
        // Use the fixture's exposed skill path verbatim (not realpathed): the
        // validator's direct-entry guard must itself be symlink-insensitive.
        const skillDir = path.join(packaged.packageDir, 'skills/ce-review')
        const validatorPath = path.join(skillDir, VALIDATOR_RELATIVE)
        const canaryPath = path.join(fixture.tempRoot, 'heredoc-canary')

        // Precondition: the packaged skill tree actually ships the helper.
        expect(fs.existsSync(validatorPath)).toBe(true)
        const malformedPayload = malformedReturnPayload(canaryPath)
        // Each fresh delimiter must be absent as a complete line in its payload.
        expect(
          VALID_RETURN.split('\n').every((line) => line !== VALID_DELIMITER),
        ).toBe(true)
        expect(
          malformedPayload
            .split('\n')
            .every((line) => line !== MALFORMED_DELIMITER),
        ).toBe(true)

        const validCommand = returnCommand(
          skillDir,
          VALID_RETURN,
          VALID_DELIMITER,
        )
        const malformedCommand = returnCommand(
          skillDir,
          malformedPayload,
          MALFORMED_DELIMITER,
        )

        const model = startMockModelServer([
          {
            toolCalls: [
              {
                id: 'ce-review-skill-load',
                name: 'systematic_skill',
                arguments: { name: 'ce:review' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'ce-review-return-valid',
                name: 'bash',
                arguments: { command: validCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'ce-review-return-malformed',
                name: 'bash',
                arguments: { command: malformedCommand },
              },
            ],
          },
          { text: 'validation scenarios complete' },
        ])
        const host = await startOpencodeServer(
          fixture,
          buildProviderConfig([packaged.pluginUrl], model.url),
        )

        try {
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: fixture.projectDir,
          })
          const created = await client.session.create({
            directory: fixture.projectDir,
            title: 'ce:review return validation',
            permission: [{ permission: '*', pattern: '*', action: 'allow' }],
          })
          if (created.data === undefined) {
            throw new Error('session create failed')
          }
          const sessionID = created.data.id
          await client.session.prompt({
            sessionID,
            directory: fixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [
              {
                type: 'text',
                text: 'Load the ce:review skill, then run its return validator against both payloads.',
              },
            ],
          })

          const messagesResult = await client.session.messages({
            sessionID,
            directory: fixture.projectDir,
          })
          if (messagesResult.data === undefined) {
            throw new Error('session messages failed')
          }
          const messages = messagesResult.data as unknown[]

          // The ce:review skill content is loaded before any Bash validator call.
          const skillParts = toolParts(messages, 'systematic_skill')
          expect(skillParts).toHaveLength(1)
          const skillState = skillParts[0]?.state as Record<string, unknown>
          const skillOutput = skillState.output
          expect(typeof skillOutput).toBe('string')
          const skillText = skillOutput as string
          expect(skillText).toContain('<skill_content name="ce:review">')
          expect(skillText).toContain('Base directory for this skill:')
          // The prose the model sees documents the `screen` call site (Unit
          // 6 replaced the inline `return` block here) and links to the
          // shared pipeline-invocation reference; the retired `return`
          // invocation form is absent from SKILL.md's raw-return admission
          // prose.
          expect(skillText).toContain(
            'node "$SKILL_DIR/scripts/validate-review.mjs" screen --reviewer <persona> --harness <opencode|pi|claude-code>',
          )
          expect(skillText).toContain(
            './references/pipeline-invocation.md#screen',
          )
          expect(skillText).not.toContain(
            'node "$SKILL_DIR/scripts/validate-review.mjs" return',
          )

          const bashParts = toolParts(messages, 'bash')
          expect(bashParts.length).toBeGreaterThanOrEqual(2)

          // Locate by command content rather than part id/order fragility.
          const runs = bashParts.map(describeBash)
          const validRun = runs.find((run) =>
            run.command.includes(VALID_RETURN.slice(0, 24)),
          )
          const malformedRun = runs.find((run) =>
            run.command.includes(OLD_FIXED_DELIMITER),
          )
          if (!validRun || !malformedRun) {
            throw new Error('expected both scripted validator commands to run')
          }

          // Both commands invoke the exact packaged helper through SKILL_DIR.
          for (const run of [validRun, malformedRun]) {
            expect(run.command).toContain(
              'node "$SKILL_DIR/scripts/validate-review.mjs" return',
            )
            expect(run.command).toContain(skillDir)
            // No payload in argv: the node line carries no JSON.
            const nodeLine = run.command
              .split('\n')
              .find((line) => line.includes('validate-review.mjs" return'))
            expect(nodeLine).toBeDefined()
            expect(nodeLine).not.toContain('{')
          }

          expect(validRun.exit, validRun.output).toBe(0)
          expect(validRun.output).toContain('Review return is valid')
          expect(malformedRun.exit, malformedRun.output).toBe(1)
          expect(malformedRun.output).toContain('not valid JSON')
          // The old fixed delimiter could not terminate the quoted heredoc, so
          // the injected shell lines never ran and the canary was not written.
          expect(fs.existsSync(canaryPath)).toBe(false)

          // Report-only / no-write: the validator admitted no run artifact.
          expect(
            fs.existsSync(
              path.join(fixture.projectDir, '.context/systematic/ce-review'),
            ),
          ).toBe(false)
          expect(fs.existsSync(path.join(fixture.projectDir, '.context'))).toBe(
            false,
          )
        } finally {
          await host.stop()
          model.stop()
          destroyIsolatedFixture(fixture)
        }
        expect(repoStatus()).toBe(repoStatusBefore)
      },
      TIMEOUT_MS * 3,
    )

    test(
      'runs screen, prepare, merge, and finalize through the real host for one writing-mode Stage 4-6 pass, then persists and validates the artifact atomically',
      async () => {
        const repoStatusBefore = repoStatus()
        const fixture: IsolatedFixture = createIsolatedFixture()
        const packaged = extractPackagedPlugin(fixture)
        const skillDir = path.join(packaged.packageDir, 'skills/ce-review')
        const runId = PIPELINE_RUN_ID_WRITING
        const runDir = path.join(
          fixture.projectDir,
          '.context/systematic/ce-review',
          runId,
        )
        const artifactPath = path.join(runDir, 'review-summary.json')
        const relativeArtifactPath = `.context/systematic/ce-review/${runId}/review-summary.json`
        const captureOnePath = path.join(
          fixture.tempRoot,
          'finalize-writing-capture-a.json',
        )
        const captureTwoPath = path.join(
          fixture.tempRoot,
          'finalize-writing-capture-b.json',
        )
        const screenSecurityStdoutPath = path.join(
          fixture.tempRoot,
          'screen-security-malformed-stdout-writing.txt',
        )

        const finalizePayload = JSON.stringify(
          buildPipelineFinalizeInput('interactive', runId),
        )

        assertDelimiterAbsent(
          JSON.stringify(PIPELINE_CORRECTNESS_RETURN),
          SCREEN_CORRECTNESS_DELIMITER,
        )
        assertDelimiterAbsent(
          PIPELINE_SECURITY_MALFORMED_PAYLOAD,
          SCREEN_SECURITY_DELIMITER,
        )
        assertDelimiterAbsent(
          finalizePayload,
          FINALIZE_WRITING_CAPTURE_A_DELIMITER,
        )
        assertDelimiterAbsent(
          finalizePayload,
          FINALIZE_WRITING_CAPTURE_B_DELIMITER,
        )

        const correctnessCommand = pipelinePhaseCommand(
          skillDir,
          'screen --reviewer correctness --harness opencode',
          JSON.stringify(PIPELINE_CORRECTNESS_RETURN),
          SCREEN_CORRECTNESS_DELIMITER,
        )
        const securityCommand = pipelinePhaseCommand(
          skillDir,
          'screen --reviewer security --harness opencode',
          PIPELINE_SECURITY_MALFORMED_PAYLOAD,
          SCREEN_SECURITY_DELIMITER,
          screenSecurityStdoutPath,
        )
        const maintainabilityCommand = pipelinePhaseCommand(
          skillDir,
          'screen --reviewer maintainability --harness opencode',
          JSON.stringify(PIPELINE_MAINTAINABILITY_RETURN),
          SCREEN_MAINTAINABILITY_DELIMITER,
        )
        const prepareCommand = pipelinePhaseCommand(
          skillDir,
          'prepare',
          JSON.stringify(PIPELINE_PREPARE_RAW_INPUT),
          PREPARE_DELIMITER,
        )
        const mergeCommand = pipelinePhaseCommand(
          skillDir,
          'merge',
          JSON.stringify({
            adjudication: { decisions: PIPELINE_MERGE_DECISIONS },
            prepared: PIPELINE_PREPARED,
          }),
          MERGE_DELIMITER,
        )
        // Two independent `finalize` invocations against byte-identical
        // stdin: capture A feeds the content assertions and the persisted
        // artifact; capture B exists solely to prove determinism against A.
        const finalizeCaptureCommandA = pipelinePhaseCommand(
          skillDir,
          'finalize',
          finalizePayload,
          FINALIZE_WRITING_CAPTURE_A_DELIMITER,
          captureOnePath,
        )
        const finalizeCaptureCommandB = pipelinePhaseCommand(
          skillDir,
          'finalize',
          finalizePayload,
          FINALIZE_WRITING_CAPTURE_B_DELIMITER,
          captureTwoPath,
        )
        const finalizePersistCommand = pipelineFinalizePersistCommand(
          runDir,
          captureOnePath,
        )
        const artifactCommand = pipelineArtifactCommand(
          skillDir,
          relativeArtifactPath,
        )

        const model = startMockModelServer([
          {
            toolCalls: [
              {
                id: 'u7-screen-correctness',
                name: 'bash',
                arguments: { command: correctnessCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-screen-security',
                name: 'bash',
                arguments: { command: securityCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-screen-maintainability',
                name: 'bash',
                arguments: { command: maintainabilityCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-prepare',
                name: 'bash',
                arguments: { command: prepareCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-merge',
                name: 'bash',
                arguments: { command: mergeCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-finalize-capture-a',
                name: 'bash',
                arguments: { command: finalizeCaptureCommandA },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-finalize-capture-b',
                name: 'bash',
                arguments: { command: finalizeCaptureCommandB },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-finalize-persist',
                name: 'bash',
                arguments: { command: finalizePersistCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-artifact',
                name: 'bash',
                arguments: { command: artifactCommand },
              },
            ],
          },
          { text: 'writing-mode Stage 4-6 scenario complete' },
        ])
        const host = await startOpencodeServer(
          fixture,
          buildProviderConfig([packaged.pluginUrl], model.url),
        )

        try {
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: fixture.projectDir,
          })
          const created = await client.session.create({
            directory: fixture.projectDir,
            title: 'ce:review U7 writing-mode pipeline',
            permission: [{ permission: '*', pattern: '*', action: 'allow' }],
          })
          if (created.data === undefined) {
            throw new Error('session create failed')
          }
          const sessionID = created.data.id
          await client.session.prompt({
            sessionID,
            directory: fixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [
              {
                type: 'text',
                text: 'Run the ce:review Stage 4-6 synthesis pipeline end to end and persist the artifact.',
              },
            ],
          })

          const messagesResult = await client.session.messages({
            sessionID,
            directory: fixture.projectDir,
          })
          if (messagesResult.data === undefined) {
            throw new Error('session messages failed')
          }
          const messages = messagesResult.data as unknown[]
          const runs = toolParts(messages, 'bash').map(describeBash)

          const correctnessRun = findBashRun(runs, SCREEN_CORRECTNESS_DELIMITER)
          const securityRun = findBashRun(runs, SCREEN_SECURITY_DELIMITER)
          const maintainabilityRun = findBashRun(
            runs,
            SCREEN_MAINTAINABILITY_DELIMITER,
          )
          const prepareRun = findBashRun(runs, PREPARE_DELIMITER)
          const mergeRun = findBashRun(runs, MERGE_DELIMITER)
          const finalizeCaptureRunA = findBashRun(
            runs,
            FINALIZE_WRITING_CAPTURE_A_DELIMITER,
          )
          const finalizeCaptureRunB = findBashRun(
            runs,
            FINALIZE_WRITING_CAPTURE_B_DELIMITER,
          )
          const finalizePersistRun = findBashRun(runs, 'u7-finalize-persist')
          const artifactRun = findBashRun(
            runs,
            'validate-review.mjs" artifact "$ARTIFACT_PATH"',
          )

          // Every phase exits 0 except the malformed `screen` call.
          expect(correctnessRun.exit, correctnessRun.output).toBe(0)
          expect(maintainabilityRun.exit, maintainabilityRun.output).toBe(0)
          expect(prepareRun.exit, prepareRun.output).toBe(0)
          expect(mergeRun.exit, mergeRun.output).toBe(0)
          expect(finalizeCaptureRunA.exit, finalizeCaptureRunA.output).toBe(0)
          expect(finalizeCaptureRunB.exit, finalizeCaptureRunB.output).toBe(0)
          expect(finalizePersistRun.exit, finalizePersistRun.output).toBe(0)
          expect(artifactRun.exit, artifactRun.output).toBe(0)
          expect(artifactRun.output).toContain('Review artifact is valid')

          // The malformed `screen` call exits 1 with the fixed rejection
          // message and writes nothing to stdout; its stdout was redirected to
          // a scratch file, which stays empty.
          expect(securityRun.exit, securityRun.output).toBe(1)
          expect(securityRun.output).toContain(
            'screen rejected the reviewer return',
          )
          expect(fs.statSync(screenSecurityStdoutPath).size).toBe(0)

          // Read `finalize`'s captured stdout back from disk -- never the
          // host's own text rendering, which joins/duplicates channels -- and
          // compare it against the in-process `finalizeReview` expectation.
          const capturedFinalizeText = fs.readFileSync(captureOnePath, 'utf8')
          expect(JSON.parse(capturedFinalizeText)).toEqual(
            PIPELINE_FINALIZE_WRITING_EXPECTED,
          )
          expect(PIPELINE_FINALIZE_WRITING_ARTIFACT.run_status).toBe('degraded')
          expect(
            PIPELINE_FINALIZE_WRITING_REPORT.residual_actionable_work,
          ).toContain(PIPELINE_UNMET_REQUIREMENT_DESCRIPTION)

          // Determinism: two independent real-host `finalize` invocations
          // against byte-identical stdin (capture A and capture B) produce
          // byte-identical stdout -- compared as raw bytes read straight off
          // disk, never through the host's own (lossy, channel-joining)
          // captured-output text.
          const capturedBytesA = fs.readFileSync(captureOnePath)
          const capturedBytesB = fs.readFileSync(captureTwoPath)
          expect(capturedBytesA.equals(capturedBytesB)).toBe(true)

          // The persisted artifact is exactly capture A's `artifact` field,
          // extracted and re-serialized -- never the whole
          // `{kind, artifact, report}` wrapper `finalize` prints, which has no
          // `schema_version` at its own top level and would fail `artifact`
          // validation.
          expect(fs.existsSync(artifactPath)).toBe(true)
          const persistedArtifact: unknown = JSON.parse(
            fs.readFileSync(artifactPath, 'utf8'),
          )
          expect(persistedArtifact).toEqual(PIPELINE_FINALIZE_WRITING_ARTIFACT)

          // No `.tmp` leftover after a successful persisted write.
          const runDirEntries = fs.readdirSync(runDir)
          expect(runDirEntries).toEqual(['review-summary.json'])

          // R26 (plain Node step, not through the host): a killed write after
          // the persisted artifact already exists leaves at most a stale
          // `.tmp` file, with the prior artifact left untouched.
          const priorArtifactBytes = fs.readFileSync(artifactPath)
          const staleTmpPath = path.join(
            runDir,
            '.review-summary.killed-write.tmp',
          )
          fs.writeFileSync(staleTmpPath, '{"incomplete": true')
          const afterStaleWriteEntries = [...fs.readdirSync(runDir)].sort()
          expect(afterStaleWriteEntries).toEqual(
            ['.review-summary.killed-write.tmp', 'review-summary.json'].sort(),
          )
          expect(fs.readFileSync(artifactPath).equals(priorArtifactBytes)).toBe(
            true,
          )
          fs.rmSync(staleTmpPath)
        } finally {
          await host.stop()
          model.stop()
          destroyIsolatedFixture(fixture)
        }
        expect(repoStatus()).toBe(repoStatusBefore)
      },
      TIMEOUT_MS * 4,
    )

    test(
      'runs the same screen, prepare, merge, and finalize phases through the real host in report-only mode with no filesystem mutation',
      async () => {
        const repoStatusBefore = repoStatus()
        const fixture: IsolatedFixture = createIsolatedFixture()
        const packaged = extractPackagedPlugin(fixture)
        const skillDir = path.join(packaged.packageDir, 'skills/ce-review')
        const runId = PIPELINE_RUN_ID_REPORT_ONLY
        const captureOnePath = path.join(
          fixture.tempRoot,
          'finalize-report-only-capture.json',
        )
        const screenSecurityStdoutPath = path.join(
          fixture.tempRoot,
          'screen-security-malformed-stdout-report-only.txt',
        )

        const finalizePayload = JSON.stringify(
          buildPipelineFinalizeInput('report-only', runId),
        )
        assertDelimiterAbsent(finalizePayload, FINALIZE_REPORT_ONLY_DELIMITER)

        const correctnessCommand = pipelinePhaseCommand(
          skillDir,
          'screen --reviewer correctness --harness opencode',
          JSON.stringify(PIPELINE_CORRECTNESS_RETURN),
          SCREEN_CORRECTNESS_DELIMITER,
        )
        const securityCommand = pipelinePhaseCommand(
          skillDir,
          'screen --reviewer security --harness opencode',
          PIPELINE_SECURITY_MALFORMED_PAYLOAD,
          SCREEN_SECURITY_DELIMITER,
          screenSecurityStdoutPath,
        )
        const maintainabilityCommand = pipelinePhaseCommand(
          skillDir,
          'screen --reviewer maintainability --harness opencode',
          JSON.stringify(PIPELINE_MAINTAINABILITY_RETURN),
          SCREEN_MAINTAINABILITY_DELIMITER,
        )
        const prepareCommand = pipelinePhaseCommand(
          skillDir,
          'prepare',
          JSON.stringify(PIPELINE_PREPARE_RAW_INPUT),
          PREPARE_DELIMITER,
        )
        const mergeCommand = pipelinePhaseCommand(
          skillDir,
          'merge',
          JSON.stringify({
            adjudication: { decisions: PIPELINE_MERGE_DECISIONS },
            prepared: PIPELINE_PREPARED,
          }),
          MERGE_DELIMITER,
        )
        const finalizeCaptureCommand = pipelinePhaseCommand(
          skillDir,
          'finalize',
          finalizePayload,
          FINALIZE_REPORT_ONLY_DELIMITER,
          captureOnePath,
        )

        const model = startMockModelServer([
          {
            toolCalls: [
              {
                id: 'u7-report-only-screen-correctness',
                name: 'bash',
                arguments: { command: correctnessCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-report-only-screen-security',
                name: 'bash',
                arguments: { command: securityCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-report-only-screen-maintainability',
                name: 'bash',
                arguments: { command: maintainabilityCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-report-only-prepare',
                name: 'bash',
                arguments: { command: prepareCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-report-only-merge',
                name: 'bash',
                arguments: { command: mergeCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u7-report-only-finalize',
                name: 'bash',
                arguments: { command: finalizeCaptureCommand },
              },
            ],
          },
          { text: 'report-only Stage 4-6 scenario complete' },
        ])
        const host = await startOpencodeServer(
          fixture,
          buildProviderConfig([packaged.pluginUrl], model.url),
        )

        try {
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: fixture.projectDir,
          })
          const created = await client.session.create({
            directory: fixture.projectDir,
            title: 'ce:review U7 report-only pipeline',
            permission: [{ permission: '*', pattern: '*', action: 'allow' }],
          })
          if (created.data === undefined) {
            throw new Error('session create failed')
          }
          const sessionID = created.data.id
          await client.session.prompt({
            sessionID,
            directory: fixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [
              {
                type: 'text',
                text: 'Run the ce:review Stage 4-6 synthesis pipeline in report-only mode.',
              },
            ],
          })

          const messagesResult = await client.session.messages({
            sessionID,
            directory: fixture.projectDir,
          })
          if (messagesResult.data === undefined) {
            throw new Error('session messages failed')
          }
          const messages = messagesResult.data as unknown[]
          const runs = toolParts(messages, 'bash').map(describeBash)

          const correctnessRun = findBashRun(runs, SCREEN_CORRECTNESS_DELIMITER)
          const securityRun = findBashRun(runs, SCREEN_SECURITY_DELIMITER)
          const maintainabilityRun = findBashRun(
            runs,
            SCREEN_MAINTAINABILITY_DELIMITER,
          )
          const prepareRun = findBashRun(runs, PREPARE_DELIMITER)
          const mergeRun = findBashRun(runs, MERGE_DELIMITER)
          const finalizeRun = findBashRun(runs, FINALIZE_REPORT_ONLY_DELIMITER)

          expect(correctnessRun.exit, correctnessRun.output).toBe(0)
          expect(maintainabilityRun.exit, maintainabilityRun.output).toBe(0)
          expect(prepareRun.exit, prepareRun.output).toBe(0)
          expect(mergeRun.exit, mergeRun.output).toBe(0)
          expect(finalizeRun.exit, finalizeRun.output).toBe(0)
          expect(securityRun.exit, securityRun.output).toBe(1)
          expect(securityRun.output).toContain(
            'screen rejected the reviewer return',
          )
          expect(fs.statSync(screenSecurityStdoutPath).size).toBe(0)

          const capturedFinalizeText = fs.readFileSync(captureOnePath, 'utf8')
          const capturedFinalize: unknown = JSON.parse(capturedFinalizeText)
          expect(capturedFinalize).toEqual(
            PIPELINE_FINALIZE_REPORT_ONLY_EXPECTED,
          )
          if (
            !isRecord(capturedFinalize) ||
            capturedFinalize.kind !== 'report_only'
          ) {
            throw new Error(
              'expected the report-only finalize call to return kind "report_only"',
            )
          }

          // Same `findings`, `queues`, `disposition_counts`, `coverage`, and
          // `verdict` values as scenario 1's `report` -- compared via the two
          // precomputed in-process projections, which the assertions above
          // already tied to each scenario's real host output.
          expect({
            coverage: PIPELINE_FINALIZE_REPORT_ONLY_EXPECTED.coverage,
            disposition_counts:
              PIPELINE_FINALIZE_REPORT_ONLY_EXPECTED.disposition_counts,
            findings: PIPELINE_FINALIZE_REPORT_ONLY_EXPECTED.findings,
            queues: PIPELINE_FINALIZE_REPORT_ONLY_EXPECTED.queues,
            verdict: PIPELINE_FINALIZE_REPORT_ONLY_EXPECTED.verdict,
          }).toEqual({
            coverage: PIPELINE_FINALIZE_WRITING_REPORT.coverage,
            disposition_counts:
              PIPELINE_FINALIZE_WRITING_REPORT.disposition_counts,
            findings: PIPELINE_FINALIZE_WRITING_REPORT.findings,
            queues: PIPELINE_FINALIZE_WRITING_REPORT.queues,
            verdict: PIPELINE_FINALIZE_WRITING_REPORT.verdict,
          })

          // Report-only never creates a run directory, never writes a temp
          // file, and never runs `artifact` validation.
          expect(
            fs.existsSync(
              path.join(fixture.projectDir, '.context/systematic/ce-review'),
            ),
          ).toBe(false)
          expect(fs.existsSync(path.join(fixture.projectDir, '.context'))).toBe(
            false,
          )
        } finally {
          await host.stop()
          model.stop()
          destroyIsolatedFixture(fixture)
        }
        expect(repoStatus()).toBe(repoStatusBefore)
      },
      TIMEOUT_MS * 4,
    )
  },
)
