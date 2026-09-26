// CHARACTERIZATION test against the real pinned OpenCode host: records how
// the pinned OpenCode host version (`EXACT_OPENCODE_VERSION`, exported by
// ./fixtures/receipt-workflow-host.ts) handles `!`-backtick shell snippets
// embedded in a discovered skill's slash-command template, and whether
// Systematic's own
// command registration for that skill shadows OpenCode's native
// `source: "skill"` command. This test does not assert a *desired*
// behavior -- it pins the *observed* behavior so a future OpenCode host
// bump that changes it fails loudly here instead of silently.
//
// Mechanism, verified directly from the pinned OpenCode host version's source
// (packages/opencode/src/session/prompt.ts, `SessionPrompt.command`; the
// exact tag lives in `EXACT_OPENCODE_VERSION` -- re-verify against that tag's
// source if this pin moves):
//   1. Numbered placeholders (`$1`, `$2`, ...) are substituted from a
//      shell-tokenized `input.arguments` first.
//   2. `$ARGUMENTS` is then substituted with the RAW, untokenized
//      `input.arguments` string (`template.replaceAll("$ARGUMENTS", ...)`).
//   3. The FULLY ASSEMBLED template (after both substitutions above) is
//      scanned with `bashRegex = /!`([^`]+)`/g` (`ConfigMarkdown.shell`);
//      every match is executed via `Process.text([cmd], { shell, nothrow:
//      true })` and its stdout is spliced back in place of the `!`...``
//      literal -- BEFORE the resulting text is ever sent to the model.
//   4. This shell execution has NO permission gate: `SessionPrompt.command`
//      never calls `Permission.ask`/`Permission.evaluate` for it (unlike a
//      real `bash` tool call). It runs even when the session's permission
//      ruleset denies everything, which this test proves by creating every
//      probe session with `[{ permission: '*', pattern: '*', action: 'deny' }]`.
//   5. Command registration order
//      (packages/opencode/src/command/index.ts, same pinned version as above):
//      built-ins, then `cfg.command` entries (source "command" -- this is
//      where Systematic's own `config` hook writes discovered-skill
//      commands, see src/lib/config-handler.ts's
//      `collectDiscoveredSkillsAsCommands`),
//      then MCP prompts, then `for (const item of skill.all()) { if
//      (commands[item.name]) continue; ... source: "skill" }`. A discovered
//      skill only gets OpenCode's native raw-body-inlined command when NO
//      earlier source already claimed that name -- Systematic claims every
//      discovered skill name unless `user-invocable: false` skips it
//      (src/lib/config-handler.ts's `collectDiscoveredSkillsAsCommands`).
//
// Fixture root: `<OPENCODE_CONFIG_DIR>/skill/<name>/SKILL.md`. This is the
// one root BOTH Systematic's `discoverSkills` (src/lib/discovered-skills.ts,
// via its `opencodeConfigDirOverride` param, itself read from
// `process.env.OPENCODE_CONFIG_DIR`) and OpenCode's native skill discovery
// (packages/opencode/src/skill/index.ts, same pinned version as above,
// `config.directories()` scanned with pattern `{skill,skills}/**/SKILL.md`)
// scan identically, because both read the very same `OPENCODE_CONFIG_DIR`
// env var this fixture already sets (`buildIsolatedOpencodeEnv`).
//
// Root-directory comparison (Systematic's `discoverSkills` vs OpenCode's
// native `Skill.discoverSkills` at the pinned host version, both verified
// directly from source at the paths above):
//   Both scan, in the same relative order:
//     - `<home>/.claude/skills/**/SKILL.md` (global, external)
//     - `<home>/.agents/skills/**/SKILL.md` (global, external)
//     - `.claude/skills/**/SKILL.md` and `.agents/skills/**/SKILL.md`,
//       up-walked from the project directory to the git worktree root
//       (inclusive), closest-first
//     - every OpenCode config directory (`config.directories()`-equivalent:
//       the global config dir, a project `.opencode` up-walk, `<home
//       >/.opencode`, then an `OPENCODE_CONFIG_DIR` override), each scanned
//       for `{skill,skills}/**/SKILL.md`
//   Roots ONLY OpenCode scans natively (Systematic has no equivalent):
//     - `cfg.skills.paths`: arbitrary directories declared in the project's
//       `opencode.json` under `skills.paths` (supports `~/` expansion,
//       absolute or relative-to-project paths), scanned with the fully
//       recursive `**/SKILL.md` (no `skill`/`skills` subdirectory
//       requirement at all).
//     - `cfg.skills.urls`: remote skill bundles declared under
//       `skills.urls`, pulled via OpenCode's `Discovery.pull` and scanned
//       the same recursive way.
//   Practical consequence: a skill reachable ONLY through `skills.paths` or
//   `skills.urls` is invisible to Systematic's own `discoverSkills`, so
//   Systematic never registers a command for it -- OpenCode's native
//   `source: "skill"` command (raw body inlined, `!`-snippets live) is the
//   ONLY reachable command for such a skill, with nothing in front of it.
//
// Process hygiene: this file is invoked directly, never through the full
// suite, per the exact `pgrep`/`bun test`/`comm` sequence documented in the
// task that produced it. See tests/integration/receipt-workflow-guard-real-host.test.ts
// and tests/integration/ce-review-return-validation.test.ts for the shared
// server + SDK client + mock OpenAI-compatible provider wiring this test
// reuses.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'

import { requireOpencodeAvailable } from '../../scripts/lib/opencode-availability.js'
import {
  cleanupPackedTarball,
  createIsolatedFixture,
  destroyIsolatedFixture,
  extractPackagedPlugin,
  getOpencodeAvailability,
  type IsolatedFixture,
  isOpencodeAvailable,
  opencodeAvailabilityReason,
  packTarballOnce,
  scriptedResponseChunks,
  startOpencodeServer,
  stopAllOpencodeHosts,
  TIMEOUT_MS,
} from './fixtures/receipt-workflow-host.js'

requireOpencodeAvailable(getOpencodeAvailability())
if (!isOpencodeAvailable()) {
  console.warn(
    `[systematic] skipping OpenCode-dependent tests in skill-command-probe.test.ts: ${opencodeAvailabilityReason()}`,
  )
}

const MOCK_PROVIDER_ID = 'skill-command-probe-provider'
const MOCK_MODEL_ID = 'skill-command-probe-model'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sseChunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

interface MockModelServer {
  url: string
  stop(): void
}

/**
 * Always responds with plain text (no tool calls), so every `session.command`
 * call in this test resolves after exactly one model turn. This test reads
 * back "what text reached the model" from the host's own persisted user
 * message (via `client.session.messages`) rather than from this server's
 * inbound request bodies: with a global deny-all permission ruleset the
 * assembled `tools` array is empty for every request (title-generation AND
 * the real chat turn alike), so the two are not reliably distinguishable at
 * the HTTP boundary. The persisted user message's `text` part is exactly
 * the string `resolvePromptParts` pushes into the same request this server
 * answers, so it is an equally authoritative source of truth.
 */
let requestCounter = 0
function startRespondingModel(): MockModelServer {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (
        request.method !== 'POST' ||
        !request.url.endsWith('/chat/completions')
      ) {
        return new Response('not found', { status: 404 })
      }
      requestCounter += 1
      const chunks = scriptedResponseChunks(
        { text: 'skill-command-probe turn complete' },
        `skill-command-probe-${requestCounter}`,
        Math.floor(Date.now() / 1000),
      )
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(sseChunk(chunk)))
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

function buildProviderConfig(
  pluginUrls: readonly string[],
  baseUrl: string,
): string {
  return JSON.stringify({
    formatter: false,
    lsp: false,
    plugin: pluginUrls,
    provider: {
      [MOCK_PROVIDER_ID]: {
        name: 'Skill Command Probe Provider',
        id: MOCK_PROVIDER_ID,
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [MOCK_MODEL_ID]: {
            id: MOCK_MODEL_ID,
            name: 'Skill Command Probe Model',
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: '2026-09-25',
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: 'unused-skill-command-probe-key', baseURL: baseUrl },
      },
    },
  })
}

/**
 * A plugin that records every event's `type` OpenCode publishes during the
 * run, so the test can positively confirm (rather than assume) that no
 * permission-ask event was ever raised for the `!`-snippet shell execution.
 */
function writeEventProbe(fixture: IsolatedFixture): {
  url: string
  capturePath: string
} {
  const probeDir = path.join(fixture.tempRoot, 'event-probe-plugin')
  const capturePath = path.join(fixture.tempRoot, 'event-probe.jsonl')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.writeFileSync(
    path.join(probeDir, 'package.json'),
    JSON.stringify({
      name: 'skill-command-probe-events',
      type: 'module',
      main: './index.mjs',
    }),
  )
  fs.writeFileSync(
    path.join(probeDir, 'index.mjs'),
    `import fs from 'node:fs'

const capturePath = ${JSON.stringify(capturePath)}

export default async function probe() {
  return {
    event: async ({ event }) => {
      try {
        fs.appendFileSync(capturePath, JSON.stringify({ type: event?.type ?? null }) + '\\n')
      } catch {
        // best-effort capture only
      }
    },
  }
}
`,
  )
  return { url: pathToFileURL(probeDir).href, capturePath }
}

function readCapturedEventTypes(capturePath: string): string[] {
  if (!fs.existsSync(capturePath)) return []
  const content = fs.readFileSync(capturePath, 'utf8').trim()
  if (content === '') return []
  return content.split('\n').map((line) => {
    const parsed = JSON.parse(line) as { type?: unknown }
    return typeof parsed.type === 'string' ? parsed.type : 'unknown'
  })
}

/** The persisted user message's `text` part is exactly the string OpenCode
 * assembled server-side (after `$ARGUMENTS`/positional substitution and
 * `!`-snippet execution) and forwarded to the model provider verbatim via
 * `resolvePromptParts`. */
function lastUserMessageText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!isRecord(message)) continue
    const info = message.info
    if (!isRecord(info) || info.role !== 'user') continue
    const parts = message.parts
    if (!Array.isArray(parts)) continue
    const textParts = parts.filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === 'text',
    )
    if (textParts.length === 0) continue
    return textParts
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('\n')
  }
  throw new Error('no user message with a text part found in session.messages')
}

interface CommandListEntry {
  name: string
  source?: string
}

describe.skipIf(!isOpencodeAvailable())(
  'discovered-skill slash command `!`-snippet handling — real OpenCode host characterization',
  () => {
    beforeAll(() => {
      packTarballOnce()
    }, 200_000)

    afterAll(async () => {
      await stopAllOpencodeHosts()
      cleanupPackedTarball()
    })

    test(
      'records observed sentinel/permission/provider-text outcomes for scenarios A-D',
      async () => {
        const fixture: IsolatedFixture = createIsolatedFixture()
        const packaged = extractPackagedPlugin(fixture)
        const eventProbe = writeEventProbe(fixture)

        const skillRoot = path.join(fixture.configDir, 'skill')
        const bodySentinelPath = path.join(fixture.tempRoot, 'body-sentinel')
        const argSentinelPath = path.join(fixture.tempRoot, 'arg-sentinel')
        const nativeSentinelPath = path.join(
          fixture.tempRoot,
          'native-sentinel',
        )
        const inlineSentinelPath = path.join(
          fixture.tempRoot,
          'inline-sentinel',
        )

        // Scenario A & C fixture: default model-invocable discovered skill.
        // Systematic now inlines this skill's full body via
        // `loadDiscoveredSkillAsCommand`/`wrapSkillTemplate` (the old
        // one-line, body-less shim is gone), so this fixture's own
        // embedded `!`-snippet and `$ARGUMENTS` line are both part of the
        // assembled command template OpenCode processes.
        fs.mkdirSync(path.join(skillRoot, 'probe-snippet'), { recursive: true })
        fs.writeFileSync(
          path.join(skillRoot, 'probe-snippet', 'SKILL.md'),
          [
            '---',
            'name: probe-snippet',
            'description: Probe skill for characterizing shell snippet handling in slash commands',
            '---',
            'Probe snippet skill body.',
            '',
            `!\`touch ${bodySentinelPath}\``,
            '',
            '$ARGUMENTS',
            '',
          ].join('\n'),
        )

        // Scenario B control fixture: `user-invocable: false` is a
        // Systematic-only convention OpenCode's own frontmatter parser does
        // not recognize (it only reads `name`/`description`), so Systematic
        // skips registering a `cfg.command` entry for it while OpenCode
        // still discovers and lists the skill -- letting OpenCode's native
        // `source: "skill"` command registration claim this name unshadowed.
        fs.mkdirSync(path.join(skillRoot, 'probe-native'), { recursive: true })
        fs.writeFileSync(
          path.join(skillRoot, 'probe-native', 'SKILL.md'),
          [
            '---',
            'name: probe-native',
            'description: Control skill reachable only via OpenCode native command registration',
            'user-invocable: false',
            '---',
            'Probe native skill body.',
            '',
            `!\`touch ${nativeSentinelPath}\``,
            '',
          ].join('\n'),
        )

        // Scenario D fixture: `disable-model-invocation: true`. Now
        // behaviorally equivalent to scenario A's command template --
        // every discovered skill's command inlines its raw body via
        // `wrapSkillTemplate` unconditionally today -- kept as a separate
        // fixture to prove that equivalence rather than assume it.
        fs.mkdirSync(path.join(skillRoot, 'probe-inline'), { recursive: true })
        fs.writeFileSync(
          path.join(skillRoot, 'probe-inline', 'SKILL.md'),
          [
            '---',
            'name: probe-inline',
            'description: Control skill exercising the existing wrapSkillTemplate raw-body inlining',
            'disable-model-invocation: true',
            '---',
            'Probe inline skill body.',
            '',
            `!\`touch ${inlineSentinelPath}\``,
            '',
          ].join('\n'),
        )

        const model = startRespondingModel()
        const configContent = buildProviderConfig(
          [packaged.pluginUrl, eventProbe.url],
          model.url,
        )
        const host = await startOpencodeServer(fixture, configContent)

        try {
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: fixture.projectDir,
          })

          async function runCommand(
            command: string,
            commandArguments: string,
          ): Promise<{ text: string }> {
            const created = await client.session.create({
              directory: fixture.projectDir,
              title: `skill-command-probe ${command}`,
              // Global deny-all: if a sentinel still appears after this,
              // the `!`-snippet substitution provably bypasses the
              // permission system entirely (it never calls Permission.ask).
              permission: [{ permission: '*', pattern: '*', action: 'deny' }],
            })
            if (created.data === undefined) {
              throw new Error(
                `session create failed for ${command}: ${JSON.stringify(created.error)}`,
              )
            }
            const sessionID = created.data.id
            const result = await client.session.command({
              sessionID,
              directory: fixture.projectDir,
              command,
              arguments: commandArguments,
              model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
            })
            if (result.data === undefined) {
              throw new Error(
                `session command failed for ${command}: ${JSON.stringify(result.error)}`,
              )
            }
            const messagesResult = await client.session.messages({
              sessionID,
              directory: fixture.projectDir,
            })
            if (messagesResult.data === undefined) {
              throw new Error(
                `session messages failed for ${command}: ${JSON.stringify(messagesResult.error)}`,
              )
            }
            return {
              text: lastUserMessageText(messagesResult.data as unknown[]),
            }
          }

          // Command-registry check: directly answers "which template
          // actually ran" for scenario B by inspecting the `source` field
          // OpenCode reports for each probe command, rather than inferring
          // it only from provider text.
          const commandListResult = await client.command.list({
            directory: fixture.projectDir,
          })
          if (commandListResult.data === undefined) {
            throw new Error(
              `command list failed: ${JSON.stringify(commandListResult.error)}`,
            )
          }
          const commandList = commandListResult.data as CommandListEntry[]
          const findOne = (name: string): CommandListEntry => {
            const matches = commandList.filter((entry) => entry.name === name)
            expect(matches).toHaveLength(1)
            const [entry] = matches
            if (!entry) throw new Error(`unreachable: no entry for ${name}`)
            return entry
          }
          const probeSnippetCommand = findOne('probe-snippet')
          const probeNativeCommand = findOne('probe-native')
          const probeInlineCommand = findOne('probe-inline')

          // Systematic's `cfg.command` entry (source "command") is written
          // before OpenCode's native skill-command loop runs, and that loop
          // skips any name already claimed -- so no separate native
          // `source: "skill"` command is ever reachable under this name.
          expect(probeSnippetCommand.source).toBe('command')
          // `user-invocable: false` skipped Systematic's registration, so
          // OpenCode's own native skill-command loop claimed this name.
          expect(probeNativeCommand.source).toBe('skill')
          // `disable-model-invocation: true` still gets a Systematic
          // `cfg.command` entry (the raw-body-inlining branch), so it is
          // registered as "command" too, not "skill".
          expect(probeInlineCommand.source).toBe('command')

          // --- Scenario A: current Systematic behavior for a default
          // model-invocable discovered skill, no arguments. The shim is
          // gone -- `loadDiscoveredSkillAsCommand` now inlines the full
          // body via `wrapSkillTemplate` for every discovered skill
          // (unconditionally, not only `disable-model-invocation: true`
          // ones), so this fixture's own embedded `!`-snippet runs as part
          // of command assembly even with no arguments supplied. ---
          const scenarioA = await runCommand('probe-snippet', '')
          const scenarioASentinel = fs.existsSync(bodySentinelPath)
          expect(scenarioASentinel).toBe(true)
          expect(scenarioA.text).toContain('Probe snippet skill body.')
          expect(scenarioA.text).toContain('Base directory for this skill:')
          expect(scenarioA.text).not.toContain('touch')

          // --- Scenario B: OpenCode's native command for a name Systematic
          // does not claim (raw body inlined; snippet already lives there) ---
          const scenarioB = await runCommand('probe-native', '')
          const scenarioBSentinel = fs.existsSync(nativeSentinelPath)
          expect(scenarioBSentinel).toBe(true)
          expect(scenarioB.text).toContain('Probe native skill body.')
          expect(scenarioB.text).toContain('Base directory for this skill:')
          expect(scenarioB.text).not.toContain('touch')

          // --- Scenario C: same inlined-body command as A, but the
          // argument string itself also carries a `!`-snippet, injected
          // into the assembled template through the `wrapSkillTemplate`
          // wrapper's own literal `$ARGUMENTS` placeholder (and this
          // fixture's own body-level `$ARGUMENTS` line, via `replaceAll`).
          // `bodySentinelPath` was already touched by scenario A above and
          // stays touched (inlining re-runs the body's own snippet on every
          // invocation; `touch` is idempotent), so this checks it is still
          // present rather than newly absent. ---
          const argSnippet = `!\`touch ${argSentinelPath}\``
          const scenarioC = await runCommand('probe-snippet', argSnippet)
          const scenarioCArgSentinel = fs.existsSync(argSentinelPath)
          const scenarioCBodySentinelStillPresent =
            fs.existsSync(bodySentinelPath)
          expect(scenarioCArgSentinel).toBe(true)
          expect(scenarioCBodySentinelStillPresent).toBe(true)
          // The snippet's own stdout (empty, for `touch`) replaces the
          // literal `!`...`` text before the model ever sees it -- so the
          // executed command leaves no visible trace in the transcript.
          expect(scenarioC.text).not.toContain('touch')
          expect(scenarioC.text).not.toContain(argSnippet)

          // --- Scenario D: disable-model-invocation body inlining, the
          // closest existing proxy for "inline everything" today ---
          const scenarioD = await runCommand('probe-inline', '')
          const scenarioDSentinel = fs.existsSync(inlineSentinelPath)
          expect(scenarioDSentinel).toBe(true)
          expect(scenarioD.text).toContain('Probe inline skill body.')
          expect(scenarioD.text).not.toContain('touch')

          const observedEventTypes = readCapturedEventTypes(
            eventProbe.capturePath,
          )
          const permissionEvents = observedEventTypes.filter((type) =>
            /permission/i.test(type),
          )
          // No permission-ask/permission-updated event was ever raised for
          // any of the four `!`-snippet executions above, despite every
          // session using a global deny-all ruleset.
          expect(permissionEvents).toEqual([])

          console.log(
            `SKILL_COMMAND_PROBE_RESULTS ${JSON.stringify(
              {
                commandSources: {
                  'probe-snippet': probeSnippetCommand.source,
                  'probe-native': probeNativeCommand.source,
                  'probe-inline': probeInlineCommand.source,
                },
                scenarioA: {
                  description: 'Systematic inlined-body command, no arguments',
                  sentinelCreated: scenarioASentinel,
                  permissionEventRaised: false,
                  providerText: scenarioA.text,
                },
                scenarioB: {
                  description:
                    'OpenCode native source:"skill" command, unshadowed',
                  sentinelCreated: scenarioBSentinel,
                  permissionEventRaised: false,
                  providerText: scenarioB.text,
                },
                scenarioC: {
                  description:
                    'Systematic inlined-body command, argument string carries the snippet',
                  argSentinelCreated: scenarioCArgSentinel,
                  bodySentinelStillPresent: scenarioCBodySentinelStillPresent,
                  permissionEventRaised: false,
                  providerText: scenarioC.text,
                },
                scenarioD: {
                  description:
                    'disable-model-invocation raw-body inlining (now behaviorally equivalent to scenario A)',
                  sentinelCreated: scenarioDSentinel,
                  permissionEventRaised: false,
                  providerText: scenarioD.text,
                },
                allObservedEventTypes: Array.from(new Set(observedEventTypes)),
              },
              null,
              2,
            )}`,
          )
        } finally {
          await host.stop()
          model.stop()
          destroyIsolatedFixture(fixture)
        }
      },
      TIMEOUT_MS * 3,
    )
  },
)
