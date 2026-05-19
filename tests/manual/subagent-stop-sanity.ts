#!/usr/bin/env bun

/**
 * Sanity smoke test for the dual-plugin counter architecture used by
 * subagent-stop-probe.ts.
 *
 * Verifies that:
 *   1. opencode serve starts with both the Systematic plugin and a per-run
 *      counter plugin loaded.
 *   2. A session.prompt call to opencode-go/deepseek-v4-flash completes.
 *   3. At least one tool call is observed (tool.execute.before fires) and
 *      written to the JSONL log within 60 seconds of the prompt being sent.
 *
 * This test is the RED gate that must pass before the full behavioral probe
 * (subagent-stop-probe.ts) is meaningful. If this test fails, the probe's
 * empty JSONL is explained by infrastructure failure, not behavioral signal.
 *
 * Run: bun tests/manual/subagent-stop-sanity.ts
 *
 * Requires: opencode CLI on PATH, opencode-go/deepseek-v4-flash auth present.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

const PROVIDER_ID = 'opencode'
const MODEL_ID = 'big-pickle'

/**
 * Wall-time budget for the entire prompt round-trip (model inference included).
 * big-pickle is a verified free OpenCode Zen endpoint; latency is variable and
 * sessions can take 2-4 minutes to return when the provider is under load. 5
 * minutes is a generous ceiling that still catches actually-hung sessions.
 */
const PROMPT_TIMEOUT_MS = 300_000

/**
 * How long after the prompt is sent we wait for at least one JSONL line to
 * appear. The tool.execute.before hook fires synchronously during prompt
 * processing, so the line should appear well before the prompt returns.
 */
const JSONL_DEADLINE_MS = 60_000

/**
 * Generate the counter plugin source. The plugin observes every tool call
 * via tool.execute.before and writes a tool_call_observed entry to the JSONL
 * log. It also writes a system_transform entry on each system prompt assembly
 * so we can verify the hook pipeline is active even before the first tool call.
 *
 * The plugin is written as a self-contained ESM module with no external
 * dependencies beyond node:fs. appendLine is wrapped in try/catch so a write
 * failure surfaces on stderr rather than silently aborting the hook.
 */
function counterPluginSource(logFile: string): string {
  return `
import fs from 'node:fs'

const LOG_FILE = ${JSON.stringify(logFile)}

function appendLine(obj) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(obj) + '\\n')
  } catch (err) {
    process.stderr.write('[sanity-counter] appendLine error: ' + String(err) + '\\n')
  }
}

const counterPlugin = async () => {
  return {
    'tool.execute.before': async (input, _output) => {
      appendLine({
        type: 'tool_call_observed',
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        ts: new Date().toISOString(),
      })
    },
    'experimental.chat.system.transform': async (input, output) => {
      appendLine({
        type: 'system_transform_observed',
        sessionID: input?.sessionID ?? 'unknown',
        systemPartCount: output?.system?.length ?? 0,
        ts: new Date().toISOString(),
      })
    },
  }
}

export default counterPlugin
`
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
      () => reject(new Error('Server start timed out after 20s')),
      20_000,
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

function killServer(server: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    server.once('close', () => resolve())
    server.kill('SIGTERM')
    // Force-kill after 5s if SIGTERM is ignored
    setTimeout(() => {
      try {
        server.kill('SIGKILL')
      } catch {
        // already dead
      }
    }, 5_000)
  })
}

/**
 * Parse all valid JSONL entries from a log file. Returns an empty array if
 * the file does not exist or contains no parseable lines.
 */
function readJsonlEntries(logFile: string): Record<string, unknown>[] {
  if (!fs.existsSync(logFile)) return []
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

/**
 * Poll the JSONL file until at least one line of the given type appears,
 * or the deadline elapses. Returns the matching line or null on timeout.
 */
async function waitForJsonlEntry(
  logFile: string,
  type: string,
  deadlineMs: number,
): Promise<Record<string, unknown> | null> {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    const found = readJsonlEntries(logFile).find((e) => e.type === type)
    if (found !== undefined) return found
    await new Promise<void>((r) => setTimeout(r, 500))
  }
  return null
}

/** Report a passing assertion with diagnostic context from the JSONL log. */
function reportPass(
  entry: Record<string, unknown>,
  logFile: string,
  elapsed: number,
): void {
  console.log(`\nPASS: tool_call_observed entry found after ${elapsed}ms`)
  console.log(
    `  tool=${String(entry.tool)} sessionID=${String(entry.sessionID)}`,
  )
  const transformCount = readJsonlEntries(logFile).filter(
    (e) => e.type === 'system_transform_observed',
  ).length
  if (transformCount > 0) {
    console.log(`  system_transform_observed entries: ${transformCount}`)
  }
}

/** Report a failing assertion with full JSONL dump for diagnosis. */
function reportFail(
  logFile: string,
  promptSettled: boolean,
  promptError: string | null,
): void {
  console.error(
    `\nFAIL: No tool_call_observed entry in JSONL within ${JSONL_DEADLINE_MS}ms`,
  )
  console.error(`  Prompt settled: ${promptSettled}`)
  if (promptError) console.error(`  Prompt error: ${promptError}`)
  if (!fs.existsSync(logFile)) {
    console.error('  JSONL file was never created')
    return
  }
  const contents = fs.readFileSync(logFile, 'utf8').trim()
  if (!contents) {
    console.error('  JSONL file exists but is empty')
    return
  }
  console.error('  JSONL contents:')
  for (const line of contents.split('\n')) {
    console.error(`    ${line}`)
  }
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'subagent-stop-sanity-'))
  const projectDir = path.join(tempDir, 'project')
  await mkdir(projectDir, { recursive: true })

  // Write a sentinel file the model can read — this guarantees at least one
  // tool call (read_file or list_directory) when we ask the model to inspect it.
  const sentinelFile = path.join(projectDir, 'sentinel.txt')
  await writeFile(sentinelFile, 'SANITY_SENTINEL_VALUE\n')

  const logFile = path.join(tempDir, 'sanity.jsonl')
  const pluginFile = path.join(tempDir, 'counter-plugin.js')
  await writeFile(pluginFile, counterPluginSource(logFile))

  const systematicPluginFile = path.join(REPO_ROOT, 'dist/index.js')
  if (!fs.existsSync(systematicPluginFile)) {
    console.error(
      `ERROR: Systematic plugin not built at ${systematicPluginFile} — run 'bun run build' first`,
    )
    process.exit(1)
  }

  const opencodeConfig = JSON.stringify({
    plugin: [`file://${systematicPluginFile}`, `file://${pluginFile}`],
  })

  console.log('Starting opencode server with dual-plugin config...')
  const { server, serverUrl } = await startServer({
    OPENCODE_CONFIG_CONTENT: opencodeConfig,
  })
  console.log(`Server started at ${serverUrl}`)

  let exitCode = 0

  try {
    // Create a session scoped to the temp project dir.
    const sessionResp = await fetch(`${serverUrl}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-opencode-directory': projectDir,
      },
      body: JSON.stringify({ title: 'sanity-smoke' }),
    })
    if (!sessionResp.ok) {
      throw new Error(
        `session.create failed: ${sessionResp.status} ${await sessionResp.text()}`,
      )
    }
    const sessionData = (await sessionResp.json()) as { id?: string }
    const sessionId = sessionData.id
    if (typeof sessionId !== 'string') {
      throw new Error(
        `session.create returned no id: ${JSON.stringify(sessionData)}`,
      )
    }
    console.log(`Session created: ${sessionId}`)

    // Send a prompt that forces at least one tool call. Asking the model to
    // read the sentinel file guarantees a read_file or glob invocation.
    const promptText =
      `Read the file sentinel.txt in the current directory and tell me its contents. ` +
      `Use the available file tools to read it.`

    console.log('Sending prompt (waiting for tool_call_observed in JSONL)...')
    const promptStart = Date.now()

    // Fire the prompt in the background so we can poll the JSONL concurrently.
    let promptSettled = false
    let promptError: string | null = null
    const promptFetch = fetch(`${serverUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-opencode-directory': projectDir,
      },
      body: JSON.stringify({
        model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
        parts: [{ type: 'text', text: promptText }],
      }),
      signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS),
    })
      .then((r) => {
        promptSettled = true
        if (!r.ok) {
          promptError = `HTTP ${r.status}`
        }
      })
      .catch((err: unknown) => {
        promptSettled = true
        promptError = err instanceof Error ? err.message : String(err)
      })

    // Poll for the JSONL entry. We expect tool_call_observed within 60s of
    // the prompt being sent (the hook fires before the model response returns).
    const entry = await waitForJsonlEntry(
      logFile,
      'tool_call_observed',
      JSONL_DEADLINE_MS,
    )

    const elapsed = Date.now() - promptStart

    if (entry !== null) {
      reportPass(entry, logFile, elapsed)
    } else {
      reportFail(logFile, promptSettled, promptError)
      exitCode = 1
    }

    // Wait for the prompt to settle (or timeout) before killing the server.
    await Promise.race([
      promptFetch,
      new Promise<void>((r) => setTimeout(r, PROMPT_TIMEOUT_MS)),
    ])
  } catch (err) {
    console.error('ERROR:', err instanceof Error ? err.message : String(err))
    exitCode = 1
  } finally {
    console.log('Stopping server...')
    await killServer(server)
    console.log('Server stopped.')
  }

  process.exit(exitCode)
}

main().catch((err: unknown) => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
