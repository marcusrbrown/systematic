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
 * by call id and put back into the request before each model call.
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

/**
 * Restoration only has to outlive a session's use of one skill result. A
 * plugin restart drops it, after which the host's cut copy is all that is left.
 */
const RESTORE_TTL_MS = 24 * 60 * 60 * 1000
const RESTORE_MAX_ENTRIES = 32

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
 * Put the full text back into the tool results of a model request. Matching is
 * by session, tool name and call id. Nothing depends on the host's marker
 * text. The store is read, not emptied: the host builds each request from
 * history, so the same result is restored on every later request.
 */
export function restoreSkillResults(
  store: SkillOutputStore,
  event: unknown,
): void {
  if (!isRecord(event) || typeof event.sessionID !== 'string') return
  const { sessionID, messages } = event
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'tool') continue
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) restorePart(store, sessionID, part)
  }
}

function restorePart(
  store: SkillOutputStore,
  sessionID: string,
  part: unknown,
): void {
  if (!isRecord(part) || part.type !== 'tool-result') return
  if (part.name !== SKILL_TOOL_NAME || typeof part.id !== 'string') return
  const full = store.peek(sessionID, part.id)
  if (full === undefined) return
  part.result = { type: 'content', value: [{ type: 'text', text: full }] }
}

function createToolDefinition(
  ctx: Plugin.Context,
  descriptor: SkillToolDescriptor,
  store: SkillOutputStore,
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
    editor.add(createToolDefinition(ctx, descriptor, store, guard))
  })

  const restore = guard.sync('skill output restore', (event: unknown) => {
    restoreSkillResults(store, event)
  })

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
