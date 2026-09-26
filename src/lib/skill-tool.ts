import type { ToolDefinition } from '@opencode-ai/plugin'
import { z } from 'zod'
import {
  buildSkillContentOutput,
  buildSkillToolDescription,
  buildSkillToolParameterHint,
  resolveSkill,
} from './skill-resolver.js'
import { isRecord } from './validation.js'

export { discoverSkillFiles } from './skill-resolver.js'

export interface SkillOutputStore {
  put(sessionID: string, callID: string, output: string): void
  take(sessionID: string, callID: string): string | undefined
}

interface SkillOutputStoreOptions {
  maxEntries?: number
  ttlMs?: number
  now?: () => number
}

const DEFAULT_MAX_ENTRIES = 32
const DEFAULT_TTL_MS = 300_000

/** Delimiter unlikely to appear in session/call IDs; avoids key collisions from naive concatenation. */
const STORE_KEY_DELIMITER = '\u0000'

/** In-memory cache of full (pre-truncation) skill tool output, keyed by session+call, for `restoreSkillOutput`. */
export function createSkillOutputStore(
  options?: SkillOutputStoreOptions,
): SkillOutputStore {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS
  const now = options?.now ?? Date.now
  const entries = new Map<string, { output: string; expiresAt: number }>()

  const toKey = (sessionID: string, callID: string): string =>
    `${sessionID}${STORE_KEY_DELIMITER}${callID}`

  return {
    put(sessionID, callID, output) {
      const key = toKey(sessionID, callID)
      entries.delete(key) // refresh insertion order on overwrite
      entries.set(key, { output, expiresAt: now() + ttlMs })
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value
        if (oldestKey === undefined) break
        entries.delete(oldestKey)
      }
    },
    take(sessionID, callID) {
      const key = toKey(sessionID, callID)
      const entry = entries.get(key)
      entries.delete(key) // take always consumes the entry
      if (!entry) return undefined
      if (now() > entry.expiresAt) return undefined
      return entry.output
    },
  }
}

/** Matches the host's truncation marker; captures nothing, only used to find where the preview ends. */
const TRUNCATION_MARKER_RE =
  /\n\n\.\.\.\d+ (?:lines|bytes) truncated\.\.\.\n\n/g

/** Restores the full skill output into a truncated host `tool.execute.after` result, mutating `output` in place. */
export function restoreSkillOutput(
  store: SkillOutputStore,
  input: unknown,
  output: unknown,
  options: { userOutputLimitSet: boolean },
): void {
  if (!isRecord(input) || input.tool !== 'systematic_skill') return
  const { sessionID, callID } = input
  if (typeof sessionID !== 'string' || sessionID === '') return
  if (typeof callID !== 'string' || callID === '') return

  const full = store.take(sessionID, callID) // always consumed once identity matches
  if (!full) return
  if (options.userOutputLimitSet) return
  if (!isRecord(output)) return
  if (!isRecord(output.metadata) || output.metadata.truncated !== true) return
  if (typeof output.output !== 'string') return

  const matches = [...output.output.matchAll(TRUNCATION_MARKER_RE)]
  const lastMatch = matches.at(-1)
  if (!lastMatch || lastMatch.index === undefined) return

  const preview = output.output.slice(0, lastMatch.index)
  if (!full.startsWith(preview)) return

  output.output = full
  output.metadata.truncated = false
  delete output.metadata.outputPath
}

export interface SkillToolOptions {
  bundledSkillsDir: string
  disabledSkills: string[]
  outputStore?: SkillOutputStore
}

export function createSkillTool(options: SkillToolOptions): ToolDefinition {
  const { bundledSkillsDir, disabledSkills, outputStore } = options
  const buildDescription = (): string =>
    buildSkillToolDescription({ bundledSkillsDir, disabledSkills })

  const buildParameterHint = (): string =>
    buildSkillToolParameterHint({ bundledSkillsDir, disabledSkills })

  let cachedDescription: string | null = null
  let cachedParameterHint: string | null = null

  return {
    get description() {
      if (cachedDescription == null) {
        cachedDescription = buildDescription()
      }
      return cachedDescription
    },
    args: {
      name: z.string().describe(
        (() => {
          if (cachedParameterHint == null) {
            cachedParameterHint = buildParameterHint()
          }
          return cachedParameterHint
        })(),
      ),
      arguments: z
        .string()
        .optional()
        .describe(
          'Raw argument text the user explicitly supplied for this skill, substituted for $ARGUMENTS and $1..$N. Omit when the user supplied none; never infer it.',
        ),
      // Double-cast is required, not stylistic: the SDK types its args
      // against its own bundled zod, whose Zod types are nominally
      // incompatible with this package's zod (v4-vs-v1 internal version
      // brands), so a direct cast fails typecheck. Runtime-safe because the
      // SDK's `tool()` is an identity function and OpenCode consumes args
      // structurally. Revisit if the SDK contract gains real behavior
      // (guarded by the no-runtime-import artifact test in package-exports).
    } as unknown as ToolDefinition['args'],
    async execute(
      args: { name: string; arguments?: string },
      context,
    ): Promise<string> {
      const requestedName = args.name

      const matchedSkill = resolveSkill(
        { bundledSkillsDir, disabledSkills },
        requestedName,
      )

      const { output, dir } = buildSkillContentOutput(
        matchedSkill,
        args.arguments,
      )

      await context.ask({
        permission: 'skill',
        patterns: [matchedSkill.prefixedName],
        always: [matchedSkill.prefixedName],
        metadata: {},
      })

      context.metadata({
        title: `Loaded skill: ${matchedSkill.prefixedName}`,
        metadata: {
          name: matchedSkill.prefixedName,
          dir,
        },
      })

      // Stash full output for restoreSkillOutput; callID isn't in ToolContext's installed type, so check at runtime.
      if (outputStore) {
        const contextRecord: unknown = context
        if (
          isRecord(contextRecord) &&
          typeof contextRecord.sessionID === 'string' &&
          contextRecord.sessionID !== '' &&
          typeof contextRecord.callID === 'string' &&
          contextRecord.callID !== ''
        ) {
          outputStore.put(contextRecord.sessionID, contextRecord.callID, output)
        }
      }

      return output
    },
  }
}
