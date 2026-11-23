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
 * by call id and put back into the request before each model call. An
 * in-memory store serves a running process. A result over the limit is also
 * written to the host's plugin storage (see {@link createDurableSkillOutputs}),
 * so the restore survives a restart.
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

/**
 * The part of the host's plugin `storage` domain this module uses. The host
 * namespaces it by plugin id, so no other plugin reads or writes these keys.
 * The host's own domain type is assignable to it.
 */
export interface V2Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: DurableJson): Promise<void>
  remove(key: string): Promise<void>
}

export interface DurableSkillOutputs {
  /** Keep one rendered output. Never rejects: a failure is reported once and the call carries on. */
  put(sessionID: string, callID: string, output: string): Promise<void>
  /** The output kept for exactly this session and call. Never rejects: a failure or a miss is `undefined`. */
  get(sessionID: string, callID: string): Promise<string | undefined>
}

interface DurableSkillOutputOptions {
  maxEntries?: number
  maxEntryBytes?: number
  report?: (message: string) => void
}

function lineCount(text: string): number {
  if (text === '') return 0
  let count = 1
  for (
    let index = text.indexOf('\n');
    index !== -1 && index < text.length - 1;
    index = text.indexOf('\n', index + 1)
  )
    count++
  return count
}

/** Whether the host cuts this text: over 2000 lines or 51200 bytes, counted as the host counts. */
export function exceedsHostOutputLimit(text: string): boolean {
  return (
    Buffer.byteLength(text, 'utf8') > HOST_OUTPUT_MAX_BYTES ||
    lineCount(text) > HOST_OUTPUT_MAX_LINES
  )
}

/**
 * Opaque ids can hold any character, so each is encoded before it joins the
 * key: `:` becomes `%3A`, which keeps two different pairs from sharing a key.
 */
function durableKey(sessionID: string, callID: string): string {
  return `${DURABLE_KEY_PREFIX}${encodeURIComponent(sessionID)}:${encodeURIComponent(callID)}`
}

function parseIndex(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/**
 * Rendered skill outputs kept in the host's plugin storage by session and call,
 * so a restart still has the full text. A read returns an output only when both
 * ids match. Writes drop evicted entries, then the index, then the entry, so a
 * partial failure never leaves an unindexed entry.
 */
export function createDurableSkillOutputs(
  storage: V2Storage,
  options: DurableSkillOutputOptions = {},
): DurableSkillOutputs {
  const maxEntries = options.maxEntries ?? DURABLE_MAX_ENTRIES
  const maxEntryBytes = options.maxEntryBytes ?? DURABLE_MAX_ENTRY_BYTES
  const report = options.report ?? (() => {})
  const reported = new Set<string>()
  const reportOnce = (kind: string, error?: unknown) => {
    if (reported.has(kind)) return
    reported.add(kind)
    const reason = error instanceof Error ? `: ${error.message}` : ''
    report(`${kind}${reason}`)
  }
  let queue: Promise<void> = Promise.resolve()

  const write = async (key: string, record: DurableJson) => {
    const index = parseIndex(await storage.get(DURABLE_INDEX_KEY)).filter(
      (entry) => entry !== key,
    )
    index.push(key)
    const evicted = index.splice(0, Math.max(0, index.length - maxEntries))
    for (const entry of evicted) await storage.remove(entry)
    await storage.set(DURABLE_INDEX_KEY, index)
    await storage.set(key, record)
  }

  return {
    put(sessionID, callID, output) {
      if (Buffer.byteLength(output, 'utf8') > maxEntryBytes) {
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
      }
      queue = queue.then(() =>
        write(durableKey(sessionID, callID), record).catch((error: unknown) =>
          reportOnce('skill output could not be kept across a restart', error),
        ),
      )
      return queue
    },
    async get(sessionID, callID) {
      try {
        const record = await storage.get(durableKey(sessionID, callID))
        if (
          !isRecord(record) ||
          record.v !== DURABLE_RECORD_VERSION ||
          record.sessionID !== sessionID ||
          record.callID !== callID ||
          typeof record.output !== 'string'
        )
          return undefined
        return record.output
      } catch (error) {
        reportOnce('kept skill output could not be read', error)
        return undefined
      }
    },
  }
}

/**
 * The in-memory store serves a running process and is dropped with it. The
 * durable copy (below) takes over after a restart.
 */
const RESTORE_TTL_MS = 24 * 60 * 60 * 1000
const RESTORE_MAX_ENTRIES = 32

/** The host's default tool output limit (`ToolOutput.MAX_LINES` / `MAX_BYTES`). */
const HOST_OUTPUT_MAX_BYTES = 50 * 1024
const HOST_OUTPUT_MAX_LINES = 2000

/** Per-entry cap: ten times the largest bundled skill, with room for `$ARGUMENTS`. */
export const DURABLE_MAX_ENTRY_BYTES = 1024 * 1024

/** Entries kept, oldest evicted first. */
export const DURABLE_MAX_ENTRIES = 32

const DURABLE_KEY_PREFIX = 'systematic:skill-output:'
const DURABLE_INDEX_KEY = 'systematic:skill-output-index'
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
 *
 * A part the store does not hold, and the host has cut, is read from `durable`
 * when there is one. That is decided here, before anything is awaited: a
 * request with no such part returns `undefined` and never touches storage. The
 * returned promise never rejects, and a read that fails or finds nothing
 * leaves the part as the host cut it.
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
      // Only what the host will cut needs a copy that outlives the process.
      if (durable !== undefined && exceedsHostOutputLimit(loaded.output))
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
