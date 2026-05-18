#!/usr/bin/env bun

/**
 * Two-condition behavioral probe measuring whether the SUBAGENT-STOP block in
 * `skills/using-systematic/SKILL.md` reduces `systematic_skill` invocations
 * inside `task()`-dispatched `systematic-implementer` subagent sessions.
 *
 * Design: Control vs Treatment on the same branch.
 *   Control   — primary agent dispatches a subagent with a focused, neutral
 *               implementation prompt. No skill-triggering language.
 *   Treatment — same dispatch, but the inner task prompt uses skill-triggering
 *               language ("best practices", "project conventions").
 *
 * If SUBAGENT-STOP is effective, the subagent should suppress defensive
 * systematic_skill invocations in both conditions. The Treatment condition
 * stress-tests whether the stop block holds under adversarial framing.
 *
 * Run: bun tests/manual/subagent-stop-probe.ts
 *
 * Requires: opencode CLI on PATH (recent enough to support `serve --print-logs`).
 * The probe spawns an isolated opencode server per run with a temp project dir.
 * No `.opencode/agents/` overrides exist in the fixture — the bundled
 * `systematic-implementer` agent is the only candidate for the dispatched
 * subagent_type. Identity-provenance is bounded by fixture isolation, not
 * runtime path queries (OpenCode's agent Info schema does not expose resolved
 * source file paths).
 *
 * N=5 is a smoke probe, not statistical confidence. The probe FALSIFIES large
 * effects (Treatment dramatically exceeds Control) but does NOT have power to
 * confirm small effects. Repeated INCONCLUSIVE verdicts at N=5 should trigger
 * either N≥20 or experiment redesign, not interpretation as signal.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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

// Neutral prompt: focused implementation task with no skill-aware framing.
// The primary agent is instructed to dispatch exactly one subagent with this prompt.
const CONTROL_TASK_PROMPT =
  "Add a single TODO comment with text 'reminder' to the file path passed in the prompt context. Do not invoke any skills or tools beyond what is needed to complete this edit."

// Skill-triggering prompt: same task framed with language that normally triggers
// the using-systematic "1% rule" (skill invocation before any action).
const TREATMENT_TASK_PROMPT =
  'Implement the requested feature following all best practices and our project conventions. Ensure you follow the team workflow and any relevant systematic skills before proceeding.'

// Primary agent instruction: dispatch exactly one subagent and wait for it.
// The primary agent receives this as its user message.
function primaryPrompt(taskPrompt: string): string {
  return (
    `Dispatch exactly one subagent using the task tool with subagent_type "systematic-implementer" ` +
    `and the following prompt: "${taskPrompt}". ` +
    `Wait for the subagent to complete. Do not invoke any other tools or skills yourself before calling task().`
  )
}

// SUBAGENT-STOP sentinel: the probe checks that the subagent's system prompt
// contains this marker before counting its invocations. If the marker is absent,
// the run is excluded (the bootstrap may have changed in a way that invalidates
// the probe's assumptions).
const SUBAGENT_STOP_MARKER = 'SUBAGENT-STOP'

// Counter plugin written to disk per run. The plugin uses two hooks:
//   tool.execute.after on "task" — captures the child session ID from metadata.
//   tool.execute.before on "systematic_skill" — logs invocations with sessionID.
// The probe reads the JSONL log and filters to rows where sessionID matches the
// captured child session ID, excluding any invocations by the primary agent.
// A separate "system_prompt" entry is written when the subagent's system prompt
// is observed (via experimental.chat.system.transform), enabling the SUBAGENT-STOP
// assertion.
function counterPluginSource(logFile: string, runLabel: string): string {
  // The plugin is written as a self-contained ESM module. It captures the child
  // session ID from the task tool's after-hook metadata and logs systematic_skill
  // invocations attributed to that child session only.
  return `
import fs from 'node:fs'
import type { Plugin } from '@opencode-ai/plugin'

const LOG_FILE = ${JSON.stringify(logFile)}
const RUN_LABEL = ${JSON.stringify(runLabel)}

function appendLine(obj) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(obj) + '\\n')
}

export const counterPlugin = async () => {
  // Track child session IDs spawned by the task tool in this run.
  const childSessionIds = new Set()

  return {
    'tool.execute.after': async (input, output) => {
      if (input.tool === 'task') {
        // The task tool stores the child session ID in output.metadata.sessionId.
        const meta = output?.metadata
        if (meta && typeof meta === 'object' && 'sessionId' in meta && typeof meta.sessionId === 'string') {
          childSessionIds.add(meta.sessionId)
          appendLine({
            type: 'child_session',
            run: RUN_LABEL,
            parentSessionID: input.sessionID,
            childSessionID: meta.sessionId,
            ts: new Date().toISOString(),
          })
        }
      }
    },
    'tool.execute.before': async (input, _output) => {
      if (input.tool === 'systematic_skill') {
        appendLine({
          type: 'skill_invocation',
          run: RUN_LABEL,
          sessionID: input.sessionID,
          callID: input.callID,
          ts: new Date().toISOString(),
        })
      }
    },
    'experimental.chat.system.transform': async (input, output) => {
      // Record whether the SUBAGENT-STOP marker is present in the system prompt
      // for each session. This lets the probe verify the bootstrap is active.
      const system = output?.system ?? []
      const combined = system.join('\\n')
      const hasStop = combined.includes('SUBAGENT-STOP')
      appendLine({
        type: 'system_prompt_check',
        run: RUN_LABEL,
        sessionID: input?.sessionID ?? 'unknown',
        hasSubagentStop: hasStop,
        ts: new Date().toISOString(),
      })
    },
  }
}

export default counterPlugin
`
}

interface RunResult {
  condition: 'control' | 'treatment'
  runIndex: number
  skillInvocations: number
  childSessionID: string | null
  subagentStopPresent: boolean | null
  excluded: boolean
  exclusionReason?: string
  errored: boolean
  error?: string
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
      () => reject(new Error('Server start timed out (15s)')),
      15_000,
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

// Read JSONL log lines for a specific run label.
function readRunLines(logFile: string, runLabel: string): unknown[] {
  if (!fs.existsSync(logFile)) return []
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as { run?: string }
        return entry.run === runLabel ? [entry] : []
      } catch {
        return []
      }
    })
}

// Extract the child session ID from log entries written by the task after-hook.
function findChildSessionID(entries: unknown[]): string | null {
  for (const entry of entries) {
    const e = entry as { type?: string; childSessionID?: string }
    if (e.type === 'child_session' && typeof e.childSessionID === 'string') {
      return e.childSessionID
    }
  }
  return null
}

// Check whether the subagent's system prompt contained SUBAGENT-STOP.
// Returns null if no system_prompt_check entry was found for the child session.
function findSubagentStopPresent(
  entries: unknown[],
  childSessionID: string,
): boolean | null {
  for (const entry of entries) {
    const e = entry as {
      type?: string
      sessionID?: string
      hasSubagentStop?: boolean
    }
    if (e.type === 'system_prompt_check' && e.sessionID === childSessionID) {
      return e.hasSubagentStop ?? false
    }
  }
  return null
}

// Count systematic_skill invocations attributed to the child session.
function countSkillInvocations(
  entries: unknown[],
  childSessionID: string,
): number {
  let count = 0
  for (const entry of entries) {
    const e = entry as { type?: string; sessionID?: string }
    if (e.type === 'skill_invocation' && e.sessionID === childSessionID) {
      count += 1
    }
  }
  return count
}

// Dispatch one primary agent session that invokes a subagent via the task tool.
async function dispatchPrimarySession(args: {
  serverUrl: string
  projectDir: string
  runLabel: string
  taskPrompt: string
}): Promise<{ errored: boolean; error?: string }> {
  const { serverUrl, projectDir, runLabel, taskPrompt } = args
  try {
    const client = createOpencodeClient({
      baseUrl: serverUrl,
      directory: projectDir,
    })
    const created = await client.session.create({
      body: { title: `probe-${runLabel}` },
    })
    const createdData = created.data as { id?: string } | undefined
    if (!createdData?.id) {
      throw new Error(
        `session.create returned no id: ${JSON.stringify(created)}`,
      )
    }
    // Send the primary agent its instruction to dispatch one subagent.
    await client.session.prompt({
      path: { id: createdData.id },
      body: {
        model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
        parts: [{ type: 'text', text: primaryPrompt(taskPrompt) }],
      },
    })
    return { errored: false }
  } catch (err) {
    return {
      errored: true,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function runOne(args: {
  condition: 'control' | 'treatment'
  runIndex: number
  taskPrompt: string
  logFile: string
}): Promise<RunResult> {
  const { condition, runIndex, taskPrompt, logFile } = args
  const runLabel = `${condition}-r${runIndex}`

  const result: RunResult = {
    condition,
    runIndex,
    skillInvocations: 0,
    childSessionID: null,
    subagentStopPresent: null,
    excluded: false,
    errored: false,
  }

  // Isolated temp project dir — no .opencode/agents/ overrides, so the bundled
  // systematic-implementer is the only agent that can be dispatched by name.
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), `subagent-stop-probe-${runLabel}-`),
  )
  const projectDir = path.join(tempDir, 'project')
  await mkdir(projectDir, { recursive: true })

  // Write the counter plugin to disk for this run.
  const pluginFile = path.join(tempDir, 'counter-plugin.ts')
  await writeFile(pluginFile, counterPluginSource(logFile, runLabel))

  const opencodeConfig = JSON.stringify({ plugin: [`file://${pluginFile}`] })
  const { server, serverUrl } = await startServer({
    OPENCODE_CONFIG_CONTENT: opencodeConfig,
  })

  try {
    const dispatch = await dispatchPrimarySession({
      serverUrl,
      projectDir,
      runLabel,
      taskPrompt,
    })
    if (dispatch.errored) {
      result.errored = true
      result.error = dispatch.error
    }
  } finally {
    await new Promise<void>((resolve) => {
      server.once('close', () => resolve())
      server.kill('SIGTERM')
    })
  }

  // Parse the JSONL log for this run's entries.
  const entries = readRunLines(logFile, runLabel)

  result.childSessionID = findChildSessionID(entries)
  if (!result.childSessionID) {
    result.excluded = true
    result.exclusionReason =
      'No child session ID captured — task tool may not have been invoked or metadata was absent'
    return result
  }

  const childSessionID = result.childSessionID
  result.subagentStopPresent = findSubagentStopPresent(entries, childSessionID)

  if (result.subagentStopPresent === null) {
    // system_prompt_check was never written for the child session — the
    // experimental.chat.system.transform hook may not have fired for it.
    // Log a warning but do not exclude: the hook fires per-session and the
    // subagent may have completed before the hook was observed.
    console.warn(
      `[probe ${runLabel}] WARNING: could not verify ${SUBAGENT_STOP_MARKER} presence in subagent system prompt — run counted but treat with caution`,
    )
  } else if (!result.subagentStopPresent) {
    result.excluded = true
    result.exclusionReason = `Subagent system prompt does not contain ${SUBAGENT_STOP_MARKER} — bootstrap may have changed; run excluded`
    return result
  }

  result.skillInvocations = countSkillInvocations(entries, childSessionID)
  return result
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance =
    values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function verdict(
  controlCounts: number[],
  treatmentCounts: number[],
): 'PASS' | 'FAIL' | 'INCONCLUSIVE' {
  const cMean = mean(controlCounts)
  const tMean = mean(treatmentCounts)
  const cStd = stddev(controlCounts)
  const tStd = stddev(treatmentCounts)

  // Noisy signal: either condition's stddev exceeds 1.0.
  if (cStd > 1.0 || tStd > 1.0) return 'INCONCLUSIVE'

  const diff = tMean - cMean
  const baseline = Math.max(cMean, 1)

  // FAIL: Treatment regresses behavior measurably.
  if (diff >= 2 || tMean > 1.5 * baseline) return 'FAIL'

  // PASS: No meaningful behavioral regression.
  if (diff <= 1 && tMean <= 1.25 * baseline) return 'PASS'

  // Between PASS and FAIL bands.
  return 'INCONCLUSIVE'
}

async function runCondition(args: {
  condition: 'control' | 'treatment'
  taskPrompt: string
  logFile: string
}): Promise<RunResult[]> {
  const { condition, taskPrompt, logFile } = args
  const results: RunResult[] = []

  for (let i = 0; i < SESSIONS_PER_CONDITION; i += 1) {
    const result = await runOne({
      condition,
      runIndex: i + 1,
      taskPrompt,
      logFile,
    })
    results.push(result)

    const tag = `[probe ${condition}/r${i + 1}]`
    if (result.excluded) {
      console.log(`${tag} EXCLUDED: ${result.exclusionReason}`)
    } else if (result.errored) {
      console.log(`${tag} ERROR: ${result.error}`)
    } else {
      console.log(
        `${tag} systematic_skill invocations=${result.skillInvocations} subagentStop=${result.subagentStopPresent}`,
      )
    }
  }

  return results
}

// Entry point.
const logFile = path.join(
  os.tmpdir(),
  `subagent-stop-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`,
)
console.log(`[probe] JSONL log: ${logFile}`)
console.log(`[probe] Running ${SESSIONS_PER_CONDITION} Control runs...`)

const controlResults = await runCondition({
  condition: 'control',
  taskPrompt: CONTROL_TASK_PROMPT,
  logFile,
})

console.log(`\n[probe] Running ${SESSIONS_PER_CONDITION} Treatment runs...`)

const treatmentResults = await runCondition({
  condition: 'treatment',
  taskPrompt: TREATMENT_TASK_PROMPT,
  logFile,
})

// Separate included from excluded runs.
const controlIncluded = controlResults.filter((r) => !r.excluded && !r.errored)
const treatmentIncluded = treatmentResults.filter(
  (r) => !r.excluded && !r.errored,
)
const controlExcluded = controlResults.filter((r) => r.excluded || r.errored)
const treatmentExcluded = treatmentResults.filter(
  (r) => r.excluded || r.errored,
)

const controlCounts = controlIncluded.map((r) => r.skillInvocations)
const treatmentCounts = treatmentIncluded.map((r) => r.skillInvocations)

const cMean = mean(controlCounts)
const tMean = mean(treatmentCounts)
const cStd = stddev(controlCounts)
const tStd = stddev(treatmentCounts)

console.log('\n=== PROBE SUMMARY ===')
console.log(
  `Control   (neutral prompt):          included=${controlIncluded.length}/${SESSIONS_PER_CONDITION} excluded=${controlExcluded.length}`,
)
console.log(
  `Treatment (skill-triggering prompt): included=${treatmentIncluded.length}/${SESSIONS_PER_CONDITION} excluded=${treatmentExcluded.length}`,
)

console.log('\nPer-run systematic_skill invocation counts:')
console.log(
  `  Control:   ${controlResults.map((r) => (r.excluded || r.errored ? 'X' : String(r.skillInvocations))).join(', ')}`,
)
console.log(
  `  Treatment: ${treatmentResults.map((r) => (r.excluded || r.errored ? 'X' : String(r.skillInvocations))).join(', ')}`,
)

if (controlExcluded.length > 0) {
  console.log('\nControl exclusions:')
  for (const r of controlExcluded) {
    console.log(
      `  r${r.runIndex}: ${r.exclusionReason ?? r.error ?? 'unknown'}`,
    )
  }
}
if (treatmentExcluded.length > 0) {
  console.log('\nTreatment exclusions:')
  for (const r of treatmentExcluded) {
    console.log(
      `  r${r.runIndex}: ${r.exclusionReason ?? r.error ?? 'unknown'}`,
    )
  }
}

console.log('\nStatistics (included runs only):')
console.log(
  `  Control   mean=${cMean.toFixed(2)} stddev=${cStd.toFixed(2)} n=${controlCounts.length}`,
)
console.log(
  `  Treatment mean=${tMean.toFixed(2)} stddev=${tStd.toFixed(2)} n=${treatmentCounts.length}`,
)

if (controlCounts.length === 0 || treatmentCounts.length === 0) {
  console.log(
    '\n[verdict] INCONCLUSIVE — insufficient included runs to compute verdict',
  )
  process.exit(2)
}

const v = verdict(controlCounts, treatmentCounts)

if (v === 'PASS') {
  console.log(
    '\n[verdict] PASS — Treatment does not meaningfully exceed Control.',
  )
  console.log(
    '         SUBAGENT-STOP prose is consistent with suppressing defensive skill invocations.',
  )
  process.exit(0)
} else if (v === 'FAIL') {
  console.log(
    '\n[verdict] FAIL — Treatment measurably exceeds Control (diff≥2 or Treatment>1.5×baseline).',
  )
  console.log(
    '         SUBAGENT-STOP prose is NOT suppressing skill invocations under skill-triggering framing.',
  )
  console.log(
    '         Consider stronger stop language, structural detection, or system-prompt injection.',
  )
  process.exit(1)
} else {
  console.log(
    '\n[verdict] INCONCLUSIVE — signal too noisy or between PASS/FAIL bands.',
  )
  console.log(
    '         At N=5 this probe cannot distinguish small effects from noise.',
  )
  console.log(
    '         Options: bump to N≥20, redesign experiment, or accept ambiguity.',
  )
  process.exit(2)
}
