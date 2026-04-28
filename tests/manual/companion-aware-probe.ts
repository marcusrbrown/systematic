/**
 * Phase 0 validation probe for the companion-aware skill composition design.
 *
 * Goal: empirically verify that appending a `companion-magic-context.md` section
 * to the `ce:work` skill body causes the LLM to invoke companion tools
 * (`ctx_memory`, `ctx_search`, `ctx_note`) at workflow boundaries materially
 * more often than the same skill body without the companion section.
 *
 * Pass criterion (per docs/brainstorms/2026-04-27-companion-aware-skills-requirements.md):
 *   Condition B (with companion content): ctx_memory invoked at the unit-completion
 *     boundary in at least 4 of 5 sessions.
 *   Condition A (without companion content): ctx_memory invoked at the same
 *     boundary in at most 1 of 5 sessions.
 *   The gap proves the companion content (not baseline behavior) drives the change.
 *
 * Run: bun tests/manual/companion-aware-probe.ts
 *
 * Requires: opencode CLI on PATH (recent enough to support `serve
 * --print-logs`; older versions silently ignore the flag and the probe times
 * out without a useful error).
 */

import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOpencodeClient } from '@opencode-ai/sdk'

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)
const MODEL = 'opencode/big-pickle'
const [PROVIDER_ID, MODEL_ID] = MODEL.split('/')
const SESSIONS_PER_CONDITION = 5

// Companion content draft (the V1 candidate). If the probe passes, this is the
// starting point for skills/ce-work/companions/magic-context.md.
const COMPANION_CONTENT = `## Companion: magic-context (when installed)

The magic-context plugin provides cross-session memory tools. Use them at workflow boundaries to preserve state across compactions and session resumes.

### At every unit boundary
After marking a unit complete and before starting the next, snapshot progress:

  ctx_memory(action="write", category="WORKFLOW_STATE",
    content="ce:work session: branch=<branch>, plan=<plan-path>, completed=[<units>], current=<next-unit>, deferred=[<items>]")

### At session start
Before resuming work, check for prior state on this branch:

  ctx_search(query="ce:work session: branch <branch-name>", sources=["memory"], limit=1)

If a snapshot is found, summarize it for the user before proceeding.

### When the user defers an item
Record as a smart note (not just a local todo):

  ctx_note(action="write", content="<item>", surface_condition="<when to resurface>")

### Graceful degradation
If these tools are unavailable, skip the calls and continue normally.`

// Minimal extract of ce:work SKILL.md. Using a representative excerpt rather
// than the full ~340-line file keeps the probe prompt focused on the unit-
// boundary moment without diluting the signal in unrelated guidance.
const CE_WORK_SKILL_BODY = `# Work Execution Command

Execute work efficiently while maintaining quality and finishing features.

## Execution Workflow

You are running a multi-unit ce:work session. For each unit:

1. Read the unit definition from the plan
2. Implement the unit (TDD-first when behavior changes)
3. Verify quality gates: build, typecheck, lint, tests
4. Mark the unit complete in the plan
5. Brief the user on what was done and what comes next
6. Proceed to the next unit

Maintain the user's todo list throughout. When the user defers an item ("park this", "later", "follow-up"), record it.`

const TRIGGER_PROMPT = `I just finished Unit 1 of the attached two-unit plan (refactored \`parseConfig\` into pure helpers; build/typecheck/lint/tests all green; committed as \`refactor(config): split parseConfig into pure helpers\` on branch \`feat/parse-config-refactor\`). Plan path is \`docs/plans/2026-04-27-001-refactor-parse-config-plan.md\`. Mark Unit 1 complete and prepare to start Unit 2 (add property-based tests for the new helpers).`

interface SessionResult {
  condition: 'A' | 'B'
  sessionLabel: string
  ctxMemoryCalls: number
  ctxSearchCalls: number
  ctxNoteCalls: number
  errored: boolean
  error?: string
}

interface ConditionSummary {
  condition: 'A' | 'B'
  sessions: SessionResult[]
  unitBoundaryHits: number // sessions where ctx_memory was called at least once
}

async function startServer(env: NodeJS.ProcessEnv): Promise<{
  server: ChildProcess
  serverUrl: string
}> {
  const server = spawn('opencode', ['serve', '--port', '0', '--print-logs'], {
    env: { ...process.env, ...env },
    cwd: REPO_ROOT,
  })
  const serverUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Server start timed out (10s)')),
      10_000,
    )
    let buf = ''
    const onChunk = (chunk: Buffer) => {
      buf += chunk.toString()
      const match = buf.match(/(http:\/\/[\d.:]+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    }
    server.stdout?.on('data', onChunk)
    server.stderr?.on('data', onChunk)
    server.on('error', reject)
    server.on('exit', (code) => {
      if (code !== null && code !== 0) {
        reject(
          new Error(`Server exited early code=${code} buf=${buf.slice(-500)}`),
        )
      }
    })
  })
  return { server, serverUrl }
}

async function runOneSession(args: {
  serverUrl: string
  projectDir: string
  skillBody: string
  condition: 'A' | 'B'
  sessionLabel: string
  logFile: string
}): Promise<SessionResult> {
  const { serverUrl, projectDir, skillBody, condition, sessionLabel, logFile } =
    args

  const client = createOpencodeClient({
    baseUrl: serverUrl,
    directory: projectDir,
  })

  const result: SessionResult = {
    condition,
    sessionLabel,
    ctxMemoryCalls: 0,
    ctxSearchCalls: 0,
    ctxNoteCalls: 0,
    errored: false,
  }

  try {
    const created = await client.session.create({
      body: { title: `probe-${condition}-${sessionLabel}` },
    })
    const createdData = created.data as { id?: string } | undefined
    if (!createdData?.id) {
      throw new Error(
        `session.create returned no id: ${JSON.stringify(created)}`,
      )
    }
    const sessionID = createdData.id

    // First message: deliver the skill body as standing instructions.
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
        parts: [
          {
            type: 'text',
            text: `Standing instructions for this session (treat as your operating manual):\n\n${skillBody}\n\nAcknowledge in one short sentence.`,
          },
        ],
      },
    })

    // Second message: the unit-completion trigger.
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
        parts: [{ type: 'text', text: TRIGGER_PROMPT }],
      },
    })
  } catch (err) {
    result.errored = true
    result.error = err instanceof Error ? err.message : String(err)
  }

  // Count tool invocations attributed to this session via the log. The
  // per-entry condition + session_label filter below is the sole correctness
  // mechanism; we do not slice on log offset because (a) the filter already
  // ignores entries from other sessions, and (b) any offset snapshot is
  // racy against asynchronous appendFileSync calls from prior sessions.
  const allLines = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
    : []
  for (const line of allLines) {
    try {
      const entry = JSON.parse(line) as {
        tool: string
        condition: string
        session_label: string
      }
      if (entry.condition !== condition || entry.session_label !== sessionLabel)
        continue
      if (entry.tool === 'ctx_memory') result.ctxMemoryCalls += 1
      if (entry.tool === 'ctx_search') result.ctxSearchCalls += 1
      if (entry.tool === 'ctx_note') result.ctxNoteCalls += 1
    } catch {
      // skip malformed lines
    }
  }

  return result
}

async function runCondition(args: {
  condition: 'A' | 'B'
  skillBody: string
  logFile: string
}): Promise<ConditionSummary> {
  const { condition, skillBody, logFile } = args

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `companion-probe-${condition}-`),
  )
  const projectDir = path.join(tempDir, 'project')
  fs.mkdirSync(projectDir, { recursive: true })

  const probeToolsPlugin = `file://${path.join(REPO_ROOT, 'tests/manual/probe-companion-tools.ts')}`
  const opencodeConfig = JSON.stringify({ plugin: [probeToolsPlugin] })

  const sessions: SessionResult[] = []

  for (let i = 0; i < SESSIONS_PER_CONDITION; i += 1) {
    const sessionLabel = `s${i + 1}`
    const env: NodeJS.ProcessEnv = {
      OPENCODE_CONFIG_CONTENT: opencodeConfig,
      PROBE_TOOL_LOG: logFile,
      PROBE_CONDITION: condition,
      PROBE_SESSION_LABEL: sessionLabel,
    }
    const { server, serverUrl } = await startServer(env)
    try {
      const result = await runOneSession({
        serverUrl,
        projectDir,
        skillBody,
        condition,
        sessionLabel,
        logFile,
      })
      sessions.push(result)
      console.log(
        `[probe ${condition}/${sessionLabel}] ctx_memory=${result.ctxMemoryCalls} ctx_search=${result.ctxSearchCalls} ctx_note=${result.ctxNoteCalls}${result.errored ? ` err=${result.error}` : ''}`,
      )
    } finally {
      await new Promise<void>((resolve) => {
        server.once('close', () => resolve())
        server.kill('SIGTERM')
      })
    }
  }

  const unitBoundaryHits = sessions.filter((s) => s.ctxMemoryCalls > 0).length
  return { condition, sessions, unitBoundaryHits }
}

const logFile = path.join(
  os.tmpdir(),
  `companion-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`,
)
console.log(`[probe] log file: ${logFile}`)

const conditionA = await runCondition({
  condition: 'A',
  skillBody: CE_WORK_SKILL_BODY,
  logFile,
})

const conditionB = await runCondition({
  condition: 'B',
  skillBody: `${CE_WORK_SKILL_BODY}\n\n---\n\n${COMPANION_CONTENT}`,
  logFile,
})

console.log('\n=== PROBE SUMMARY ===')
console.log(
  `Condition A (no companion): ${conditionA.unitBoundaryHits}/${SESSIONS_PER_CONDITION} sessions called ctx_memory`,
)
console.log(
  `Condition B (with companion): ${conditionB.unitBoundaryHits}/${SESSIONS_PER_CONDITION} sessions called ctx_memory`,
)

console.log('\nPer-session ctx_memory calls:')
console.log(
  `  A: ${conditionA.sessions.map((s) => s.ctxMemoryCalls).join(', ')}`,
)
console.log(
  `  B: ${conditionB.sessions.map((s) => s.ctxMemoryCalls).join(', ')}`,
)

const passed =
  conditionB.unitBoundaryHits >= 4 && conditionA.unitBoundaryHits <= 1

if (passed) {
  console.log(
    '\n[verdict] PASS — companion content materially drives ctx_memory invocation.',
  )
  console.log('         Proceed with V1 design as scoped (ce:plan).')
  process.exit(0)
} else if (conditionB.unitBoundaryHits >= 4) {
  console.log('\n[verdict] AMBIGUOUS — both conditions invoke ctx_memory.')
  console.log(
    '         Baseline model behavior may be sufficient. Reconsider whether companion content is needed for ce:work specifically.',
  )
  process.exit(2)
} else {
  console.log(
    '\n[verdict] FAIL — companion content does not drive measurable change.',
  )
  console.log(
    '         Pivot options: stronger guidance language (re-probe), system-prompt injection via experimental.chat.system.transform, or abandon companion-aware composition.',
  )
  process.exit(1)
}
