/**
 * Stub plugin used by tests/manual/companion-aware-probe.ts.
 *
 * Registers `ctx_memory`, `ctx_search`, and `ctx_note` as no-op tools that
 * append a structured log entry per invocation. The probe runner counts
 * lines in the log to compare invocation rates between conditions.
 */

import fs from 'node:fs'
import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'

const logFileEnv = process.env.PROBE_TOOL_LOG
if (!logFileEnv) {
  throw new Error('PROBE_TOOL_LOG env var must be set')
}
const logFile: string = logFileEnv

const condition = process.env.PROBE_CONDITION ?? 'unknown'
const sessionLabel = process.env.PROBE_SESSION_LABEL ?? '?'

function logCall(name: string, args: unknown): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tool: name,
    condition,
    session_label: sessionLabel,
    args: JSON.stringify(args).slice(0, 400),
  })
  fs.appendFileSync(logFile, `${line}\n`)
}

export const probeCompanionTools: Plugin = async () => {
  return {
    tool: {
      ctx_memory: tool({
        description:
          'Manage cross-session project memories. Write or delete entries by category.',
        args: {
          action: tool.schema
            .enum(['write', 'delete'])
            .describe('write to add a memory; delete to remove by id'),
          category: tool.schema
            .string()
            .optional()
            .describe('Memory category, e.g. WORKFLOW_STATE'),
          content: tool.schema.string().optional().describe('Memory content'),
          id: tool.schema.number().optional().describe('Memory ID for delete'),
        },
        async execute(args) {
          logCall('ctx_memory', args)
          return JSON.stringify({ ok: true, id: 1 })
        },
      }),
      ctx_search: tool({
        description:
          'Search across project memories, session facts, and conversation history.',
        args: {
          query: tool.schema.string().describe('Search query'),
          sources: tool.schema
            .array(tool.schema.enum(['memory', 'message', 'git_commit']))
            .optional(),
          limit: tool.schema.number().optional(),
        },
        async execute(args) {
          logCall('ctx_search', args)
          return JSON.stringify({ results: [] })
        },
      }),
      ctx_note: tool({
        description:
          'Save or inspect durable session notes that persist for this session.',
        args: {
          action: tool.schema
            .enum(['write', 'read', 'dismiss', 'update'])
            .optional(),
          content: tool.schema.string().optional(),
          surface_condition: tool.schema.string().optional(),
          note_id: tool.schema.number().optional(),
        },
        async execute(args) {
          logCall('ctx_note', args)
          return JSON.stringify({ ok: true })
        },
      }),
    },
  }
}

export default probeCompanionTools
