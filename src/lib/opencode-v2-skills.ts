import fs from 'node:fs'
import type { Plugin } from '@opencode/plugin'
import { parseFrontmatter } from './frontmatter.js'
import type { SafeGuard, V2Installer } from './opencode-v2.js'
import {
  createSkillOutputStore,
  createSkillToolDescriptor,
  SKILL_TOOL_NAME,
  type SkillOutputStore,
  type SkillToolDescriptor,
  type SkillToolInput,
} from './skill-tool.js'
import { findSkillsInDir } from './skills.js'
import { isRecord } from './validation.js'

/**
 * Skills on OpenCode v2: the enabled bundled skills are registered with the
 * host so its native `skill` tool and `<available_skills>` list see them, and
 * `systematic_skill` is ported through the tool domain because the native tool
 * takes only an id: it cannot pass `$ARGUMENTS`.
 *
 * The host cuts a tool result at 2000 lines or 51200 bytes after the plugin
 * has returned it, and three bundled skills are larger. The full text is kept
 * by call id and put back into the request before each model call. Memory
 * serves a running process; every load is also kept in the host's plugin
 * storage (see {@link createDurableSkillOutputs}) so a restart still restores it.
 */

/** The part of a v2 skill this module writes. The host's own skill type is assignable to it. */
export interface V2SkillRecord {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  path: string
  content: string
}

export interface V2SkillEditor {
  get(id: string): unknown
  add(skill: V2SkillRecord): void
}

/** What `execute` receives. The host's own context type is assignable to it. */
export interface V2ToolContext {
  sessionID: string
  agent: string
  messageID: string
  id: string
  progress(update: Record<string, unknown>): Promise<void>
}

/** The JSON Schema shape of a tool's input: an object of described properties. */
export type V2ToolInputSchema = {
  type: 'object'
  properties: Record<string, { type: string; description: string }>
  required: readonly string[]
  additionalProperties: false
}

export interface V2ToolDefinition {
  name: string
  description: string
  input: V2ToolInputSchema
  options: { codemode: false }
  execute(
    input: unknown,
    context: V2ToolContext,
  ): Promise<{ content: string; metadata: Record<string, unknown> }>
}

export interface V2ToolEditor {
  get(id: string): unknown
  add(tool: V2ToolDefinition): void
}

type DurableJson =
  | string
  | number
  | boolean
  | null
  | DurableJson[]
  | { [key: string]: DurableJson }

/** The part of the host's plugin `storage` domain this module uses; the host namespaces it by plugin id. */
export interface V2Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: DurableJson): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: readonly { key: string; value: unknown }[]
    next?: string
  }>
}

/** One skill invocation: the assistant message that made the call and the provider's call id, which a provider may reuse across turns. */
export interface SkillCallIds {
  sessionID: string
  messageID: string
  callID: string
}

/** The in-memory store key for a call: the message id keeps a reused call id from reaching another turn's result. */
export function skillOutputHandle(messageID: string, callID: string): string {
  return `${messageID}\u0000${callID}`
}

export interface DurableSkillOutputs {
  /** Keep one rendered output. Never rejects and never takes longer than the deadline. */
  put(ids: SkillCallIds, output: string): Promise<void>
  /** The output kept for exactly this session, message and call. Never rejects: a failure or a miss is `undefined`. */
  get(ids: SkillCallIds): Promise<string | undefined>
}

interface DurableSkillOutputOptions {
  maxEntries?: number
  maxEntryBytes?: number
  maxAgeMs?: number
  deadlineMs?: number
  maxMisses?: number
  missTtlMs?: number
  now?: () => number
  report?: (message: string) => void
}

/** The storage key for a call, or `undefined` when an id cannot be encoded (an unpaired surrogate throws). */
function durableKey(ids: SkillCallIds): string | undefined {
  try {
    return `${DURABLE_KEY_PREFIX}${[ids.sessionID, ids.messageID, ids.callID].map(encodeURIComponent).join(':')}`
  } catch {
    return undefined
  }
}

/** Runs `operation` and rejects if it has not settled within `ms`; the operation itself is not cancelled. */
function withDeadline<T>(
  operation: () => Promise<T>,
  ms: number,
  label: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`storage did not answer within ${label} ms`)),
      Math.max(ms, 0),
    )
    // A pending deadline must not keep the host process alive.
    ;(timer as { unref?: () => void }).unref?.()
    new Promise<T>((settle) => settle(operation())).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** The write time of a stored record; anything without one reads as older than any limit. */
function storedAtOf(value: unknown): number {
  return isRecord(value) &&
    typeof value.storedAt === 'number' &&
    Number.isFinite(value.storedAt)
    ? value.storedAt
    : Number.MIN_SAFE_INTEGER
}

/** Rendered skill outputs kept in the host's plugin storage by session, message and call, one key per record and no index. */
export function createDurableSkillOutputs(
  storage: V2Storage,
  options: DurableSkillOutputOptions = {},
): DurableSkillOutputs {
  const maxEntries = options.maxEntries ?? DURABLE_MAX_ENTRIES
  const maxEntryBytes = options.maxEntryBytes ?? DURABLE_MAX_ENTRY_BYTES
  const maxAgeMs = options.maxAgeMs ?? DURABLE_MAX_AGE_MS
  const deadlineMs = options.deadlineMs ?? DURABLE_DEADLINE_MS
  const maxMisses = options.maxMisses ?? DURABLE_MAX_MISSES
  const missTtlMs = options.missTtlMs ?? DURABLE_MISS_TTL_MS
  const now = options.now ?? Date.now
  const report = options.report ?? (() => {})
  const reported = new Set<string>()
  const reportOnce = (kind: string, error?: unknown) => {
    if (reported.has(kind)) return
    reported.add(kind)
    const reason = error instanceof Error ? `: ${error.message}` : ''
    report(`${kind}${reason}`)
  }
  // Keys found to hold nothing usable, with when to look again, oldest first; a transient failure is never added.
  const misses = new Map<string, number>()
  const rememberMiss = (key: string) => {
    misses.delete(key)
    misses.set(key, now() + missTtlMs)
    for (const oldest of misses.keys()) {
      if (misses.size <= maxMisses) break
      misses.delete(oldest)
    }
  }
  const isKnownMiss = (key: string) => {
    const until = misses.get(key)
    if (until === undefined) return false
    if (until > now()) return true
    misses.delete(key)
    return false
  }
  // Set after a cleanup fails or times out: nothing more is written, so a store that cannot be trimmed cannot grow.
  let writesStopped = false

  // Every storage call draws on one deadline; none starts once it has passed.
  const call = <T>(until: number, operation: () => Promise<T>) => {
    const remaining = until - Date.now()
    return remaining <= 0
      ? Promise.reject(
          new Error(`storage did not answer within ${deadlineMs} ms`),
        )
      : withDeadline(operation, remaining, deadlineMs)
  }

  const listEntries = async (until: number) => {
    const found: { key: string; storedAt: number }[] = []
    let after: string | undefined
    for (let page = 0; page < DURABLE_SCAN_MAX_PAGES; page++) {
      const result = await call(until, () =>
        storage.scan({
          prefix: DURABLE_KEY_PREFIX,
          limit: DURABLE_SCAN_PAGE,
          ...(after === undefined ? {} : { after }),
        }),
      )
      for (const entry of result.entries)
        found.push({ key: entry.key, storedAt: storedAtOf(entry.value) })
      if (result.next === undefined) break
      after = result.next
    }
    return found
  }

  // Every writer ranks the same listing the same way, so overlapping trims agree on the survivors.
  const trim = async (until: number) => {
    const cutoff = now() - maxAgeMs
    const ranked = (await listEntries(until)).sort(
      (a, b) => b.storedAt - a.storedAt || (a.key < b.key ? -1 : 1),
    )
    const doomed = ranked.filter(
      (entry, index) => entry.storedAt < cutoff || index >= maxEntries,
    )
    const results = await Promise.allSettled(
      doomed.map((entry) => call(until, () => storage.remove(entry.key))),
    )
    const failed = results.find((result) => result.status === 'rejected')
    if (failed !== undefined) throw failed.reason
  }

  return {
    async put(ids, output) {
      if (writesStopped) return
      const key = durableKey(ids)
      if (key === undefined) {
        reportOnce(
          'skill output has an id that cannot be stored and is not kept across a restart',
        )
        return
      }
      if (Buffer.byteLength(output, 'utf8') > maxEntryBytes) {
        rememberMiss(key)
        reportOnce(
          `skill output is over ${maxEntryBytes} bytes and is not kept across a restart`,
        )
        return
      }
      const until = Date.now() + deadlineMs
      const record = {
        v: DURABLE_RECORD_VERSION,
        ...ids,
        output,
        storedAt: now(),
      }
      try {
        await call(until, () => storage.set(key, record))
      } catch (error) {
        reportOnce('skill output could not be kept across a restart', error)
        return
      }
      misses.delete(key)
      try {
        await trim(until)
      } catch (error) {
        writesStopped = true
        reportOnce(
          'old skill outputs could not be removed, so no more skill output is kept across a restart',
          error,
        )
      }
    },
    async get(ids) {
      const key = durableKey(ids)
      if (key === undefined || isKnownMiss(key)) return undefined
      let stored: unknown
      try {
        stored = await call(Date.now() + deadlineMs, () => storage.get(key))
      } catch (error) {
        reportOnce('kept skill output could not be read', error)
        return undefined
      }
      if (
        !isRecord(stored) ||
        stored.v !== DURABLE_RECORD_VERSION ||
        stored.sessionID !== ids.sessionID ||
        stored.messageID !== ids.messageID ||
        stored.callID !== ids.callID ||
        typeof stored.output !== 'string' ||
        now() - storedAtOf(stored) > maxAgeMs
      ) {
        rememberMiss(key)
        return undefined
      }
      return stored.output
    },
  }
}

const RESTORE_TTL_MS = 24 * 60 * 60 * 1000
const RESTORE_MAX_ENTRIES = 32

/** Per-entry cap: ten times the largest bundled skill, with room for `$ARGUMENTS`. */
export const DURABLE_MAX_ENTRY_BYTES = 1024 * 1024

/** Entries kept, newest first. */
export const DURABLE_MAX_ENTRIES = 32

/** Matches the host's `ToolOutput.RETENTION` for its own spill files. */
export const DURABLE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** How long any one storage call may take before it is treated as failed. */
export const DURABLE_DEADLINE_MS = 2000

/** Known-missing keys remembered per process. */
export const DURABLE_MAX_MISSES = 256

/** How long a remembered miss stands before the key is read again. */
export const DURABLE_MISS_TTL_MS = 60 * 1000

const DURABLE_SCAN_PAGE = 100
const DURABLE_SCAN_MAX_PAGES = 10
const DURABLE_KEY_PREFIX = 'systematic:skill-output:'
const DURABLE_RECORD_VERSION = 2

/** The enabled bundled skills as v2 records, in name order. */
export function readBundledSkills(
  bundledSkillsDir: string,
  enabledSkills: readonly string[],
  report: (message: string) => void,
): V2SkillRecord[] {
  const enabled = new Set(enabledSkills)
  const records: V2SkillRecord[] = []
  const infos = findSkillsInDir(bundledSkillsDir)
    .filter((info) => enabled.has(info.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const info of infos) {
    try {
      const { body } = parseFrontmatter(fs.readFileSync(info.skillFile, 'utf8'))
      records.push({
        id: info.name,
        name: info.name,
        ...(info.description === '' ? {} : { description: info.description }),
        // A skill that opts out of model invocation stays loadable by id.
        ...(info.disableModelInvocation === true ? { autoinvoke: false } : {}),
        path: info.skillFile,
        content: body.trim(),
      })
    } catch (error) {
      report(
        `skill "${info.name}" could not be read; leaving it out: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
  }
  return records
}

/**
 * Add one skill to a transform editor. An id that already exists belongs to an
 * earlier plugin and is left alone. A user or on-disk skill of the same id
 * replaces this one after every plugin transform has run, and that cannot be
 * seen from here, so it is silent.
 */
export function addBundledSkill(
  editor: V2SkillEditor,
  skill: V2SkillRecord,
  reported: Set<string>,
  report: (message: string) => void,
): void {
  if (editor.get(skill.id) !== undefined) {
    if (reported.has(skill.id)) return
    reported.add(skill.id)
    report(
      `skill "${skill.id}" is already defined by another plugin; skipping the bundled skill`,
    )
    return
  }
  editor.add(skill)
}

function parseToolInput(input: unknown): SkillToolInput {
  if (!isRecord(input) || typeof input.name !== 'string') {
    throw new Error('systematic_skill requires a "name" string')
  }
  if (input.arguments !== undefined && typeof input.arguments !== 'string') {
    throw new Error('systematic_skill "arguments" must be a string')
  }
  return { name: input.name, arguments: input.arguments }
}

/**
 * Put the full text back into the tool results of a model request where the
 * host cut it. Matching is by session, the assistant message that made the call,
 * tool name and call id. Nothing depends on the host's marker text. The store is
 * read, not emptied: the host builds each request from history, so the same
 * result is restored on every later request.
 * A cut part the store lacks is read from `durable`; a request with none returns `undefined` before any await.
 * A result whose calling message cannot be identified is left as the host cut it.
 */
export function restoreSkillResults(
  store: SkillOutputStore,
  event: unknown,
  durable?: DurableSkillOutputs,
): Promise<void> | undefined {
  if (!isRecord(event) || typeof event.sessionID !== 'string') return undefined
  const { sessionID, messages } = event
  if (!Array.isArray(messages)) return undefined
  const pending: PendingRestore[] = []
  // The assistant message of the latest skill call under each call id so far; `undefined` when it cannot be told.
  const callers = new Map<string, string | undefined>()
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    if (message.role === 'assistant') noteSkillCalls(callers, message)
    if (message.role !== 'tool') continue
    for (const part of message.content)
      restorePart(store, sessionID, part, callers, durable, pending)
  }
  if (durable === undefined || pending.length === 0) return undefined
  return restoreFromDurable(store, durable, pending)
}

function noteSkillCalls(
  callers: Map<string, string | undefined>,
  message: Record<string, unknown>,
): void {
  if (!Array.isArray(message.content)) return
  const seen = new Set<string>()
  for (const part of message.content) {
    if (!isRecord(part) || part.type !== 'tool-call') continue
    if (part.name !== SKILL_TOOL_NAME || typeof part.id !== 'string') continue
    // A call id twice in one message, or a message with no id, cannot be told apart.
    const named = typeof message.id === 'string' && !seen.has(part.id)
    callers.set(part.id, named ? (message.id as string) : undefined)
    seen.add(part.id)
  }
}

interface PendingRestore {
  part: Record<string, unknown>
  ids: SkillCallIds
}

function restorePart(
  store: SkillOutputStore,
  sessionID: string,
  part: unknown,
  callers: ReadonlyMap<string, string | undefined>,
  durable: DurableSkillOutputs | undefined,
  pending: PendingRestore[],
): void {
  if (!isRecord(part) || part.type !== 'tool-result') return
  if (part.name !== SKILL_TOOL_NAME || typeof part.id !== 'string') return
  const messageID = callers.get(part.id)
  if (messageID === undefined) return
  const full = store.peek(sessionID, skillOutputHandle(messageID, part.id))
  if (full !== undefined) {
    part.result = restoredResult(part.result, full)
    return
  }
  if (durable !== undefined && isCutByHost(part.result))
    pending.push({ part, ids: { sessionID, messageID, callID: part.id } })
}

/** A host cut adds a marker part, so a cut skill is a `content` result of more than one part. */
function isCutByHost(result: unknown): boolean {
  return (
    isRecord(result) &&
    result.type === 'content' &&
    Array.isArray(result.value) &&
    result.value.length > 1
  )
}

async function restoreFromDurable(
  store: SkillOutputStore,
  durable: DurableSkillOutputs,
  pending: readonly PendingRestore[],
): Promise<void> {
  await Promise.all(
    pending.map(async ({ part, ids }) => {
      const full = await durable.get(ids)
      if (full === undefined) return
      part.result = restoredResult(part.result, full)
      // Later requests in this process read it from memory.
      store.put(
        ids.sessionID,
        skillOutputHandle(ids.messageID, ids.callID),
        full,
      )
    }),
  )
}

/**
 * The host lowers a single text part to `{ type: 'text' }` and anything else to
 * `{ type: 'content' }`, and that kind decides the request body: a string or an
 * array. Keep the kind, and touch the result only when its text is not the full
 * text, so a skill under the host limit reads the same with or without a store
 * entry. A result that is neither kind (an error) is left alone.
 */
function restoredResult(result: unknown, full: string): unknown {
  if (!isRecord(result)) return result
  if (result.type === 'text') {
    return result.value === full ? result : { type: 'text', value: full }
  }
  if (result.type !== 'content' || !Array.isArray(result.value)) return result
  const [only, ...more] = result.value
  if (
    more.length === 0 &&
    isRecord(only) &&
    only.type === 'text' &&
    only.text === full
  )
    return result
  return { ...result, value: [{ type: 'text', text: full }] }
}

function createToolDefinition(
  ctx: Plugin.Context,
  descriptor: SkillToolDescriptor,
  store: SkillOutputStore,
  durable: DurableSkillOutputs | undefined,
  guard: SafeGuard,
): V2ToolDefinition {
  return {
    name: descriptor.name,
    description: descriptor.description,
    input: descriptor.input,
    // Without this the tool is reachable only through Code Mode.
    options: { codemode: false },
    // Errors here are the protocol, not defects: a skill that is unknown or
    // disabled, and a denied permission, reach the model as a tool error. The
    // host turns a throw from `execute` into that error, so nothing is guarded.
    async execute(input, context) {
      // Resolving first means an unknown or disabled skill never prompts.
      const loaded = descriptor.load(parseToolInput(input))
      await ctx.permission.assert({
        sessionID: context.sessionID,
        agent: context.agent,
        action: 'skill',
        resources: [loaded.skillName],
        source: {
          type: 'tool',
          messageID: context.messageID,
          id: context.id,
        },
      })
      const progress = guard.async('skill progress', () =>
        context.progress({
          title: loaded.title,
          name: loaded.prefixedName,
          dir: loaded.dir,
        }),
      )
      await progress()
      const ids = {
        sessionID: context.sessionID,
        messageID: context.messageID,
        callID: context.id,
      }
      store.put(
        ids.sessionID,
        skillOutputHandle(ids.messageID, ids.callID),
        loaded.output,
      )
      if (durable !== undefined) await durable.put(ids, loaded.output)
      return {
        content: loaded.output,
        metadata: { name: loaded.prefixedName, dir: loaded.dir },
      }
    },
  }
}

export const installSkills: V2Installer = async ({
  ctx,
  snapshot,
  guard,
  report,
}) => {
  const bundledSkills = readBundledSkills(
    `${snapshot.packageRoot}/skills`,
    snapshot.plan.enabledSkills,
    report,
  )
  const descriptor = createSkillToolDescriptor({
    bundledSkillsDir: `${snapshot.packageRoot}/skills`,
    disabledSkills: snapshot.config.disabled_skills,
  })
  const store = createSkillOutputStore({
    maxEntries: RESTORE_MAX_ENTRIES,
    ttlMs: RESTORE_TTL_MS,
  })
  // A host without plugin storage keeps the in-memory restore only.
  const storage: Plugin.Context['storage'] | undefined = ctx.storage
  const durable =
    storage === undefined
      ? undefined
      : createDurableSkillOutputs(storage, { report })
  const reported = new Set<string>()

  const skillTransform = guard.sync(
    'skill transform',
    (editor: V2SkillEditor) => {
      for (const skill of bundledSkills) {
        const add = guard.sync(`skill "${skill.id}"`, addBundledSkill)
        add(editor, skill, reported, report)
      }
    },
  )

  const toolTransform = guard.sync('tool transform', (editor: V2ToolEditor) => {
    if (editor.get(descriptor.name) !== undefined) {
      if (!reported.has(descriptor.name)) {
        reported.add(descriptor.name)
        report(
          `tool "${descriptor.name}" is already registered by another plugin; not registering the bundled one`,
        )
      }
      return
    }
    editor.add(createToolDefinition(ctx, descriptor, store, durable, guard))
  })

  const restoreNow = guard.sync('skill output restore', (event: unknown) =>
    restoreSkillResults(store, event, durable),
  )
  // A request with nothing to read from storage returns synchronously, so the
  // host waits for this hook only when there is a read to wait for.
  const restore = (event: unknown): Promise<void> | undefined => {
    const pending = restoreNow(event)
    if (pending === undefined) return undefined
    return guard.async('skill output restore', () => pending)()
  }

  await guard.async('skill registration', () =>
    ctx.skill.transform(skillTransform),
  )()
  await guard.async('tool registration', () =>
    ctx.tool.transform(toolTransform),
  )()
  await guard.async('skill output restore registration', () =>
    ctx.session.hook('context', restore),
  )()
}
