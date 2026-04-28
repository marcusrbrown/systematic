/**
 * Phase 0 OQ-1 validation probe for the experimental.session.compacting hook.
 *
 * Goal: determine whether content appended to `output.context` actually survives
 * OpenCode's compactor LLM. The probe injects a marker string and triggers a
 * real compaction via the SDK summarize endpoint, then inspects the post-
 * compaction message stream for the marker.
 *
 * Run: bun tests/manual/session-compacting-probe.ts
 *
 * Requires: opencode CLI on PATH, `bun run build` already executed,
 * SYSTEMATIC_PROBE_LOG file path will be set automatically.
 */

import { spawn } from 'node:child_process'
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

interface ProbeResult {
  hookFired: boolean
  hookFiredCount: number
  markerInjected: string | null
  markerInSummary: 'verbatim' | 'paraphrased' | 'absent'
  markerOccurrences: number
  summaryText: string
  notes: string[]
}

async function runProbe(): Promise<ProbeResult> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-probe-'))
  const projectDir = path.join(tempDir, 'project')
  fs.mkdirSync(projectDir, { recursive: true })

  const probeLogPath = path.join(tempDir, 'probe.log')
  const nonce = Math.random().toString(36).slice(2, 10)

  const pluginPath = `file://${path.join(REPO_ROOT, 'src/index.ts')}`
  const opencodeConfig = JSON.stringify({ plugin: [pluginPath] })

  console.log(`[probe] tempDir: ${tempDir}`)
  console.log(`[probe] probeLogPath: ${probeLogPath}`)
  console.log(`[probe] nonce: ${nonce}`)

  // Spawn `opencode serve` and capture the URL from stdout/stderr.
  const env = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: opencodeConfig,
    SYSTEMATIC_PROBE_LOG: probeLogPath,
    SYSTEMATIC_PROBE_NONCE: nonce,
  }

  console.log('[probe] spawning opencode serve...')
  const server = spawn('opencode', ['serve', '--port', '0', '--print-logs'], {
    cwd: projectDir,
    env,
  })

  const serverUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Server start timed out (10s)'))
    }, 10_000)

    let buffer = ''
    const onChunk = (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = buffer.match(/(http:\/\/[\d.:]+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    }
    server.stdout?.on('data', onChunk)
    server.stderr?.on('data', onChunk)
    server.on('error', reject)
    server.on('exit', (code: number | null) => {
      if (code !== null && code !== 0) {
        reject(new Error(`Server exited early with code ${code}: ${buffer}`))
      }
    })
  })

  console.log(`[probe] server URL: ${serverUrl}`)

  const client = createOpencodeClient({
    baseUrl: serverUrl,
    directory: projectDir,
  })

  const notes: string[] = []
  let markerInjected: string | null = null
  let summaryText = ''
  let markerInSummary: ProbeResult['markerInSummary'] = 'absent'
  let markerOccurrences = 0

  try {
    console.log('[probe] creating session...')
    const created = await client.session.create({
      body: { title: 'systematic-probe' },
    })
    const sessionID = (created.data as { id?: string } | undefined)?.id ?? ''
    if (!sessionID) {
      throw new Error(`Failed to create session: ${JSON.stringify(created)}`)
    }
    console.log(`[probe] sessionID: ${sessionID}`)

    // Send a couple of substantive prompts so the conversation has real content
    // for the compactor to summarize.
    for (const text of [
      'Reply with a single short sentence acknowledging this message. Nothing else.',
      'Reply with a single short sentence about TypeScript. Nothing else.',
    ]) {
      console.log(`[probe] sending prompt: ${text.slice(0, 50)}...`)
      const resp = await client.session.prompt({
        path: { id: sessionID },
        body: {
          model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
          parts: [{ type: 'text', text }],
        },
      })
      const errMsg =
        resp.error != null ? JSON.stringify(resp.error).slice(0, 300) : null
      if (errMsg) notes.push(`prompt error: ${errMsg}`)
    }

    // Trigger compaction.
    console.log('[probe] calling summarize...')
    const summarizeResp = await client.session.summarize({
      path: { id: sessionID },
      body: { providerID: PROVIDER_ID, modelID: MODEL_ID },
    })
    if (summarizeResp.error != null) {
      notes.push(
        `summarize error: ${JSON.stringify(summarizeResp.error).slice(0, 300)}`,
      )
    }

    // Read the resulting messages.
    console.log('[probe] fetching messages...')
    const msgs = await client.session.messages({ path: { id: sessionID } })
    const messages = (msgs.data ?? []) as Array<{
      info?: { role?: string; summary?: boolean }
      parts?: Array<{ type?: string; text?: string }>
    }>

    // The summarize endpoint typically produces a new summary message at the
    // end of the stream. Scan ALL messages for our marker.
    const allText = messages
      .flatMap((m) => m.parts ?? [])
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n---\n')

    summaryText = allText
    markerInjected = `<systematic-probe>marker-${nonce}-sid-${sessionID}</systematic-probe>`

    if (allText.includes(markerInjected)) {
      markerInSummary = 'verbatim'
      markerOccurrences = allText.split(markerInjected).length - 1
    } else if (
      allText.includes(`marker-${nonce}`) ||
      allText.includes('systematic-probe')
    ) {
      markerInSummary = 'paraphrased'
      markerOccurrences = (allText.match(/systematic-probe/g) ?? []).length
    }

    notes.push(`messages_count=${messages.length}`)
    notes.push(`total_text_chars=${allText.length}`)
  } catch (err) {
    notes.push(
      `probe error: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    server.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
  }

  // Inspect the probe log.
  const probeLog = fs.existsSync(probeLogPath)
    ? fs.readFileSync(probeLogPath, 'utf8')
    : ''
  const hookFiredCount = (probeLog.match(/HOOK_FIRED/g) ?? []).length
  const hookFired = hookFiredCount > 0

  console.log(`[probe] hookFiredCount=${hookFiredCount}`)
  console.log(`[probe] markerInSummary=${markerInSummary}`)

  return {
    hookFired,
    hookFiredCount,
    markerInjected,
    markerInSummary,
    markerOccurrences,
    summaryText,
    notes,
  }
}

const result = await runProbe()
console.log('\n=== PROBE RESULT ===')
console.log(JSON.stringify(result, null, 2))

if (result.markerInSummary === 'verbatim') {
  console.log('\n[verdict] VERBATIM — proceed with full V1 design as scoped.')
  process.exit(0)
} else if (result.markerInSummary === 'paraphrased') {
  console.log(
    '\n[verdict] PARAPHRASED — proceed with V1, but reframe R3 to expect paraphrased preservation.',
  )
  process.exit(0)
} else if (!result.hookFired) {
  console.log(
    '\n[verdict] HOOK DID NOT FIRE — abort design. Investigate whether experimental.session.compacting is actually wired into the production compaction path.',
  )
  process.exit(2)
} else {
  console.log(
    '\n[verdict] MARKER DROPPED — append-only design fails. Switch to output.prompt override or a skill-layer alternative.',
  )
  process.exit(1)
}
