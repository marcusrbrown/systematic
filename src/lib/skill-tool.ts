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

/** The registry key of the skill tool; the host reports it as the part's `tool`. */
export const SKILL_TOOL_NAME = 'systematic_skill'

export interface SkillOutputStore {
  put(sessionID: string, callID: string, output: string): void
  /** Returns the entry and removes it. */
  take(sessionID: string, callID: string): string | undefined
  /** Returns the entry and keeps it, for hosts that read the same output on every request. */
  peek(sessionID: string, callID: string): string | undefined
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
    peek(sessionID, callID) {
      const entry = entries.get(toKey(sessionID, callID))
      if (!entry || now() > entry.expiresAt) return undefined
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
  if (!isRecord(input) || input.tool !== SKILL_TOOL_NAME) return
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

/**
 * Clears the `compacted` flag of completed skill-tool results in a request the
 * host is assembling, so the model receives the stored body and not the prune
 * placeholder. Each part gets a fresh `state.time` without `compacted`, so a
 * failure partway through leaves every part valid. The host rebuilds the
 * request from storage each time, so nothing persists.
 */
export function restoreCompactedSkillResults(output: unknown): void {
  if (!isRecord(output) || !Array.isArray(output.messages)) return
  for (const message of output.messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue
    for (const part of message.parts) restoreCompactedPart(part)
  }
}

function restoreCompactedPart(part: unknown): void {
  if (!isRecord(part) || part.type !== 'tool') return
  if (part.tool !== SKILL_TOOL_NAME) return
  const { state } = part
  if (!isRecord(state) || state.status !== 'completed') return
  const { time } = state
  if (!isRecord(time) || Array.isArray(time) || !time.compacted) return
  const { compacted: _compacted, ...rest } = time
  state.time = rest
}

/** The `arguments` parameter text. One string for every adapter, so the tool reads the same on each host. */
const SKILL_ARGUMENTS_DESCRIPTION =
  'Raw argument text the user explicitly supplied for this skill, substituted for $ARGUMENTS and $1..$N. Omit to leave those placeholders as written; an explicit empty string substitutes them with nothing. Only pass text the user explicitly supplied; never infer it.'

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
      arguments: z.string().optional().describe(SKILL_ARGUMENTS_DESCRIPTION),
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

export interface SkillToolInput {
  name: string
  arguments?: string
}

export interface LoadedSkillOutput {
  /** The bare skill name: the permission resource, whichever form was asked for. */
  skillName: string
  /** The `systematic:`-prefixed form, as shown to the user and the model. */
  prefixedName: string
  /** `Loaded skill: <prefixed name>`, for progress reporting. */
  title: string
  /** The `<skill_content>` text the model receives. */
  output: string
  /** The skill's base directory. */
  dir: string
}

/**
 * A host-neutral description of the skill tool, with no zod and no host import.
 * An adapter whose host takes JSON Schema (OpenCode v2) registers `input`
 * as is and calls `load` from its own `execute`. `load` throws the shared
 * not-found error, which is also what a disabled skill gets.
 */
export interface SkillToolDescriptor {
  name: typeof SKILL_TOOL_NAME
  description: string
  input: {
    type: 'object'
    properties: {
      name: { type: 'string'; description: string }
      arguments: { type: 'string'; description: string }
    }
    required: ['name']
    additionalProperties: false
  }
  load(args: SkillToolInput): LoadedSkillOutput
}

export function createSkillToolDescriptor(
  options: Pick<SkillToolOptions, 'bundledSkillsDir' | 'disabledSkills'>,
): SkillToolDescriptor {
  const { bundledSkillsDir, disabledSkills } = options
  return {
    name: SKILL_TOOL_NAME,
    description: buildSkillToolDescription({
      bundledSkillsDir,
      disabledSkills,
    }),
    input: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: buildSkillToolParameterHint({
            bundledSkillsDir,
            disabledSkills,
          }),
        },
        arguments: {
          type: 'string',
          description: SKILL_ARGUMENTS_DESCRIPTION,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    load(args) {
      const matched = resolveSkill(
        { bundledSkillsDir, disabledSkills },
        args.name,
      )
      const { output, dir } = buildSkillContentOutput(matched, args.arguments)
      return {
        skillName: matched.name,
        prefixedName: matched.prefixedName,
        title: `Loaded skill: ${matched.prefixedName}`,
        output,
        dir,
      }
    },
  }
}
