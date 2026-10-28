import type { V2Installer } from './opencode-v2.js'
import { isRecord } from './validation.js'

/**
 * The Systematic bootstrap on OpenCode v2.
 *
 * v2 has an instruction entry store: a keyed value per session that the host
 * puts in the first system message as `<context key="...">`. Title requests
 * leave it out, compaction and the requests after it carry it once, and
 * putting the same value again changes nothing. So the bootstrap is one entry
 * per session, and nothing edits the system prompt.
 *
 * The entry is put from the `prompt` hook, which fires for every admitted
 * prompt: new, resumed and subagent sessions alike. The `session.created`
 * event is not used. A plugin whose location is booted by the very
 * `session.create` call never sees that event, so the first session after each
 * service start would go without the bootstrap.
 *
 * A put that fails is reported and never thrown: a throwing `prompt` hook
 * fails the prompt with an HTTP 500.
 *
 * Two host behaviors are accepted and documented rather than worked around:
 * a bootstrap that changes between runs freezes the system block at the old
 * text and adds a `<system-update>` message with the new one, and entries stay
 * with their sessions after the plugin is removed.
 */

/** One stable key, so a changed bootstrap replaces the old value in place. */
export const BOOTSTRAP_ENTRY_KEY = 'systematic.bootstrap'

/** The host rejects an entry value over 256 KiB of JSON. */
export const BOOTSTRAP_MAX_BYTES = 256 * 1024

/**
 * Sessions remembered as done, so a busy service does not put again on every
 * prompt. A session pushed out is put once more on its next prompt, which the
 * host treats as no change.
 */
const REMEMBERED_SESSIONS = 512

/**
 * The skill usage block for v2. It names only what v2 registers:
 * `systematic_skill` (with arguments) and the host's own `skill` tool, which
 * takes only an id.
 */
export const OPENCODE_V2_USAGE_TEMPLATE = `**Skills naming:**
- Systematic bundled skills use the \`systematic:\` prefix (e.g., \`systematic:onboarding\`)
- Workflow skills with their own namespace keep it (e.g., \`ce:brainstorm\`)
- Skills can also be invoked without prefix if unambiguous

**Skills usage:**
- Use \`systematic_skill\` to load Systematic bundled skills; pass \`arguments\` only when the user supplied them
- Use the \`skill\` tool, which takes the skill \`id\`, for non-Systematic skills

**Skills location:**
Bundled skills ship with the Systematic plugin and are discoverable via \`systematic_skill\`.`

/** The size the host measures: the JSON text of the value, in bytes. */
export function entryValueBytes(content: string): number {
  return new TextEncoder().encode(JSON.stringify(content)).length
}

function sessionIdOf(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined
  return typeof event.sessionID === 'string' ? event.sessionID : undefined
}

export const installBootstrap: V2Installer = async ({
  ctx,
  snapshot,
  guard,
  report,
}) => {
  const content = snapshot.bootstrapContent
  // Disabled, or nothing to compose: no hook, no entry.
  if (content === null) return

  const bytes = entryValueBytes(content)
  if (bytes > BOOTSTRAP_MAX_BYTES) {
    report(
      `the bootstrap is ${bytes} bytes, over the ${BOOTSTRAP_MAX_BYTES} byte limit for an instruction entry; not injecting it`,
    )
    return
  }

  const done = new Set<string>()
  const reported = new Set<string>()

  const put = async (sessionID: string): Promise<void> => {
    try {
      await ctx.session.instructions.entry.put({
        sessionID,
        key: BOOTSTRAP_ENTRY_KEY,
        value: content,
      })
    } catch (error) {
      // Not remembered, so the next prompt of the session tries again. The
      // message is reported once, however many prompts hit it.
      const message = error instanceof Error ? error.message : 'unknown error'
      if (!reported.has(message)) {
        reported.add(message)
        report(`bootstrap could not be put for a session: ${message}`)
      }
      return
    }
    done.add(sessionID)
    if (done.size > REMEMBERED_SESSIONS) {
      const oldest = done.values().next().value
      if (oldest !== undefined) done.delete(oldest)
    }
  }

  const onPrompt = guard.async(
    'bootstrap prompt hook',
    async (event: unknown) => {
      const sessionID = sessionIdOf(event)
      if (sessionID === undefined || done.has(sessionID)) return
      await put(sessionID)
    },
  )

  await guard.async('bootstrap registration', () =>
    ctx.session.hook('prompt', onPrompt),
  )()
}
