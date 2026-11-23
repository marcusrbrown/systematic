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

export interface DurableSkillOutputs {
  /** Keep one rendered output. Never rejects and never takes longer than the deadline. */
  put(sessionID: string, callID: string, output: string): Promise<void>
  /** The output kept for exactly this session and call. Never rejects: a failure or a miss is `undefined`. */
  get(sessionID: string, callID: string): Promise<string | undefined>
}

interface DurableSkillOutputOptions {
  maxEntries?: number
  maxEntryBytes?: number
  maxAgeMs?: number
  deadlineMs?: number
  maxMisses?: number
  now?: () => number
  report?: (message: string) => void
}

/** Opaque ids can hold any character, so each is encoded: `:` becomes `%3A` and two pairs never share a key. */
function durableKey(sessionID: string, callID: string): string {
  return `${DURABLE_KEY_PREFIX}${encodeURIComponent(sessionID)}:${encodeURIComponent(callID)}`
}

/** Runs `operation` and rejects if it has not settled within `ms`; the operation itself is not cancelled. */
function withDeadline<T>(operation: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`storage did not answer within ${ms} ms`)),
      ms,
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

/** Rendered skill outputs kept in the host's plugin storage by session and call, one key per record and no index. */
export function createDurableSkillOutputs(
  storage: V2Storage,
  options: DurableSkillOutputOptions = {},
): DurableSkillOutputs {
  const maxEntries = options.maxEntries ?? DURABLE_MAX_ENTRIES
  const maxEntryBytes = options.maxEntryBytes ?? DURABLE_MAX_ENTRY_BYTES
  const maxAgeMs = options.maxAgeMs ?? DURABLE_MAX_AGE_MS
  const deadlineMs = options.deadlineMs ?? DURABLE_DEADLINE_MS
  const maxMisses = options.maxMisses ?? DURABLE_MAX_MISSES
  const now = options.now ?? Date.now
  const report = options.report ?? (() => {})
  const reported = new Set<string>()
  const reportOnce = (kind: string, error?: unknown) => {
    if (reported.has(kind)) return
    reported.add(kind)
    const reason = error instanceof Error ? `: ${error.message}` : ''
    report(`${kind}${reason}`)
  }
  // Keys known to hold nothing usable, oldest first; a transient failure is never added.
  const misses = new Set<string>()
  const rememberMiss = (key: string) => {
    misses.delete(key)
    misses.add(key)
    for (const oldest of misses) {
      if (misses.size <= maxMisses) break
      misses.delete(oldest)
    }
  }
  const call = <T>(operation: () => Promise<T>) =>
    withDeadline(operation, deadlineMs)

  const listEntries = async () => {
    const found: { key: string; storedAt: number }[] = []
    let after: string | undefined
    for (let page = 0; page < DURABLE_SCAN_MAX_PAGES; page++) {
      const result = await call(() =>
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

  // Runs only after the new entry is written; the entry just written is never removed.
  const trim = async (ownKey: string) => {
    const cutoff = now() - maxAgeMs
    const others = (await listEntries())
      .filter((entry) => entry.key !== ownKey)
      .sort((a, b) => b.storedAt - a.storedAt || (a.key < b.key ? -1 : 1))
    const doomed = others.filter(
      (entry, index) => entry.storedAt < cutoff || index >= maxEntries - 1,
    )
    const results = await Promise.allSettled(
      doomed.map((entry) => call(() => storage.remove(entry.key))),
    )
    const failed = results.find((result) => result.status === 'rejected')
    if (failed !== undefined) throw failed.reason
  }

  return {
    put(sessionID, callID, output) {
      const key = durableKey(sessionID, callID)
      if (Buffer.byteLength(output, 'utf8') > maxEntryBytes) {
        rememberMiss(key)
        reportOnce(
          `skill output is over ${maxEntryBytes} bytes and is not kept across a restart`,
        )
        return Promise.resolve()
      }
      const record = {
        v: DURABLE_RECORD_VERSION,
        sessionID,
        callID,
        output,
        storedAt: now(),
      }
      let written = false
      const work = async () => {
        await call(() => storage.set(key, record))
        written = true
        misses.delete(key)
        await trim(key).catch((error: unknown) =>
          reportOnce('old skill outputs could not be removed', error),
        )
      }
      return withDeadline(work, deadlineMs).catch((error: unknown) =>
        reportOnce(
          written
            ? 'old skill outputs could not be removed'
            : 'skill output could not be kept across a restart',
          error,
        ),
      )
    },
    async get(sessionID, callID) {
      const key = durableKey(sessionID, callID)
      if (misses.has(key)) return undefined
      let record: unknown
      try {
        record = await call(() => storage.get(key))
      } catch (error) {
        reportOnce('kept skill output could not be read', error)
        return undefined
      }
      if (
        !isRecord(record) ||
        record.v !== DURABLE_RECORD_VERSION ||
        record.sessionID !== sessionID ||
        record.callID !== callID ||
        typeof record.output !== 'string' ||
        now() - storedAtOf(record) > maxAgeMs
      ) {
        rememberMiss(key)
        return undefined
      }
      return record.output
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

const DURABLE_SCAN_PAGE = 100
const DURABLE_SCAN_MAX_PAGES = 10
const DURABLE_KEY_PREFIX = 'systematic:skill-output:'
const DURABLE_RECORD_VERSION = 1

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
 * host cut it. Matching is by session, tool name and call id. Nothing depends
 * on the host's marker text. The store is read, not emptied: the host builds
 * each request from history, so the same result is restored on every later
 * request.
 * A cut part the store lacks is read from `durable`; a request with none returns `undefined` before any await.
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
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'tool') continue
    if (!Array.isArray(message.content)) continue
    for (const part of message.content)
      restorePart(store, sessionID, part, durable, pending)
  }
  if (durable === undefined || pending.length === 0) return undefined
  return restoreFromDurable(store, durable, pending)
}

interface PendingRestore {
  part: Record<string, unknown>
  sessionID: string
  callID: string
}

function restorePart(
  store: SkillOutputStore,
  sessionID: string,
  part: unknown,
  durable: DurableSkillOutputs | undefined,
  pending: PendingRestore[],
): void {
  if (!isRecord(part) || part.type !== 'tool-result') return
  if (part.name !== SKILL_TOOL_NAME || typeof part.id !== 'string') return
  const full = store.peek(sessionID, part.id)
  if (full !== undefined) {
    part.result = restoredResult(part.result, full)
    return
  }
  if (durable !== undefined && isCutByHost(part.result))
    pending.push({ part, sessionID, callID: part.id })
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
    pending.map(async ({ part, sessionID, callID }) => {
      const full = await durable.get(sessionID, callID)
      if (full === undefined) return
      part.result = restoredResult(part.result, full)
      // Later requests in this process read it from memory.
      store.put(sessionID, callID, full)
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
      store.put(context.sessionID, context.id, loaded.output)
      if (durable !== undefined)
        await durable.put(context.sessionID, context.id, loaded.output)
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
