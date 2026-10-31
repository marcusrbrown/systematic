/**
 * Host adapters for the `systematic_search` tool: OpenCode v1 (zod), OpenCode
 * v2 (JSON Schema through the tool transform) and Pi (typebox). Each does host
 * I/O only: pick the start directory, hand over the settings, and map any
 * failure to one fixed line. Validation, ranking, the lifecycle and every byte
 * of the rendered text belong to `runSearch` in `search-core.ts`.
 *
 * No adapter asks for a permission: the tool reads only the project's own
 * `docs/solutions/`, `docs/plans/`, `docs/brainstorms/` and `docs/ideation/`,
 * under a realpath containment check in the corpus loader.
 * Every host schema declares `limit` as a plain integer and states the range
 * in the description, so the core's fixed error is what an out-of-range value
 * gets wherever the host passes it through.
 */

import type { ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ToolDefinition } from '@opencode-ai/plugin'
import type { Type as TypeBuilder } from 'typebox'
import { z } from 'zod'
import type { V2Installer } from './opencode-v2.js'
import type { V2ToolDefinition, V2ToolEditor } from './opencode-v2-skills.js'
import {
  runSearch,
  SEARCH_ARG_DESCRIPTIONS,
  SEARCH_ARGS,
  SEARCH_CONFIG_UNREADABLE_NOTE,
  SEARCH_NOTICES,
  SEARCH_TOOL_DESCRIPTION,
  SEARCH_TOOL_NAME,
  type SearchSettings,
} from './search-core.js'
import { isRecord } from './validation.js'

/** Whether the config leaves the tool on. Only an explicit `enabled: false` removes it. */
export function isSearchEnabled(settings: SearchSettings | undefined): boolean {
  return settings?.enabled !== false
}

/**
 * The one execute path. A missing start directory yields the no-project note
 * and never a guess; any throw (a hostile argument getter included) yields the
 * fixed failure line, with nothing from the error.
 */
async function executeSearch(
  args: unknown,
  startDir: string | undefined,
  settings: SearchSettings | undefined,
  unreadable: boolean | undefined,
): Promise<string> {
  try {
    if (startDir === undefined) return SEARCH_NOTICES.noProject
    const record = isRecord(args) ? args : {}
    const response = await runSearch(
      {
        query: record[SEARCH_ARGS.query],
        kind: record[SEARCH_ARGS.kind],
        limit: record[SEARCH_ARGS.limit],
      },
      {
        startDir,
        settings,
        // A user `search` block (or its file) that could not be read: results
        // carry the same `config unreadable` note the CLI and the bin print.
        ...(unreadable === true && { notes: [SEARCH_CONFIG_UNREADABLE_NOTE] }),
      },
    )
    return response.text
  } catch {
    return SEARCH_NOTICES.failed
  }
}

/** A host-supplied directory counts only when it is a non-empty string. */
function usableDirectory(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// --- OpenCode v1 -----------------------------------------------------------

export interface SearchToolV1Options {
  readonly settings: SearchSettings | undefined
  /** `config.searchUnreadable`: adds the `config unreadable` note to every result. */
  readonly unreadable?: boolean | undefined
}

export function createSearchTool(options: SearchToolV1Options): ToolDefinition {
  const { settings, unreadable } = options
  return {
    description: SEARCH_TOOL_DESCRIPTION,
    // Double-cast for the same reason as the skill tool: the SDK types its args
    // against its own bundled zod, which is nominally incompatible with this
    // package's zod. The SDK's `tool()` is an identity function, so the host
    // consumes the args structurally.
    args: {
      [SEARCH_ARGS.query]: z.string().describe(SEARCH_ARG_DESCRIPTIONS.query),
      [SEARCH_ARGS.kind]: z
        .string()
        .optional()
        .describe(SEARCH_ARG_DESCRIPTIONS.kind),
      [SEARCH_ARGS.limit]: z
        .number()
        .int()
        .optional()
        .describe(SEARCH_ARG_DESCRIPTIONS.limit),
    } as unknown as ToolDefinition['args'],
    async execute(args, context): Promise<string> {
      // `context.directory` is on the 1.19.4 types and on the 1.18.29 floor
      // (the real-host floor lane searches the host project with no other
      // directory to fall back on). A context without it gets the no-project
      // note, never a guess.
      return executeSearch(
        args,
        usableDirectory(context.directory),
        settings,
        unreadable,
      )
    },
  }
}

// --- OpenCode v2 -----------------------------------------------------------

const V2_INPUT_SCHEMA: V2ToolDefinition['input'] = {
  type: 'object',
  properties: {
    [SEARCH_ARGS.query]: {
      type: 'string',
      description: SEARCH_ARG_DESCRIPTIONS.query,
    },
    [SEARCH_ARGS.kind]: {
      type: 'string',
      description: SEARCH_ARG_DESCRIPTIONS.kind,
    },
    [SEARCH_ARGS.limit]: {
      type: 'integer',
      description: SEARCH_ARG_DESCRIPTIONS.limit,
    },
  },
  required: [SEARCH_ARGS.query],
  additionalProperties: false,
}

/** The part of the v2 plugin context the search tool reads. */
interface V2LocationContext {
  readonly location?: { readonly directory?: unknown } | undefined
}

function createV2SearchTool(
  ctx: V2LocationContext,
  settings: SearchSettings | undefined,
  unreadable: boolean | undefined,
): V2ToolDefinition {
  return {
    name: SEARCH_TOOL_NAME,
    description: SEARCH_TOOL_DESCRIPTION,
    input: V2_INPUT_SCHEMA,
    // Without this the tool is reachable only through Code Mode.
    options: { codemode: false },
    async execute(input) {
      // Read per call. `process.cwd()` would search whichever project the
      // editor happened to start in, so an absent directory is a note.
      const startDir = usableDirectory(ctx.location?.directory)
      return {
        content: await executeSearch(input, startDir, settings, unreadable),
        metadata: {},
      }
    },
  }
}

/**
 * Registers `systematic_search` through the v2 tool transform. A name another
 * plugin already holds is left alone and reported once. Nothing registers when
 * `search.enabled` is false.
 */
export const installSearch: V2Installer = async ({
  ctx,
  snapshot,
  guard,
  report,
}) => {
  const settings = snapshot.config.search
  const unreadable = snapshot.config.searchUnreadable
  if (!isSearchEnabled(settings)) return
  const reported = new Set<string>()

  const toolTransform = guard.sync(
    'search tool transform',
    (editor: V2ToolEditor) => {
      if (editor.get(SEARCH_TOOL_NAME) !== undefined) {
        if (!reported.has(SEARCH_TOOL_NAME)) {
          reported.add(SEARCH_TOOL_NAME)
          report(
            `tool "${SEARCH_TOOL_NAME}" is already registered by another plugin; not registering the bundled one`,
          )
        }
        return
      }
      editor.add(createV2SearchTool(ctx, settings, unreadable))
    },
  )

  await guard.async('search tool registration', () =>
    ctx.tool.transform(toolTransform),
  )()
}

// --- Pi --------------------------------------------------------------------

function buildPiParameters(Type: typeof TypeBuilder) {
  return Type.Object({
    [SEARCH_ARGS.query]: Type.String({
      description: SEARCH_ARG_DESCRIPTIONS.query,
    }),
    [SEARCH_ARGS.kind]: Type.Optional(
      Type.String({ description: SEARCH_ARG_DESCRIPTIONS.kind }),
    ),
    [SEARCH_ARGS.limit]: Type.Optional(
      Type.Integer({ description: SEARCH_ARG_DESCRIPTIONS.limit }),
    ),
  })
}

export interface SearchToolPiOptions {
  readonly settings: SearchSettings | undefined
  /** `config.searchUnreadable`: adds the `config unreadable` note to every result. */
  readonly unreadable?: boolean | undefined
  /**
   * typebox's `Type` builder, supplied by the Pi entry. This module is also
   * imported by the OpenCode entries, and typebox is an optional peer that only
   * Pi installs, so it must not be a runtime import here: the OpenCode bundle
   * would carry a copy of it.
   */
  readonly Type: typeof TypeBuilder
}

/**
 * The Pi definition. `src/pi.ts` registers it for the parent session and hands
 * the same object to delegates as a custom tool, so both run one execute path.
 * The start directory is the per-call `ctx.cwd`, which in a delegate is the
 * delegate session's own cwd. The return type is the SDK's default, unnarrowed
 * definition: a narrowed one is not assignable to `customTools` (its renderers
 * take typed arguments), and `executeSearch` validates the raw arguments itself.
 */
export function createPiSearchTool(
  options: SearchToolPiOptions,
): PiToolDefinition {
  const { settings, unreadable, Type } = options
  return {
    name: SEARCH_TOOL_NAME,
    label: 'Systematic Search',
    description: SEARCH_TOOL_DESCRIPTION,
    promptSnippet:
      'Use `systematic_search` to find past learnings (docs/solutions), plans, brainstorms and ideation (docs/plans, docs/brainstorms, docs/ideation). Pass kind "all" to search them together.',
    parameters: buildPiParameters(Type),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = await executeSearch(
        params,
        usableDirectory(ctx.cwd),
        settings,
        unreadable,
      )
      return { content: [{ type: 'text', text }], details: undefined }
    },
  }
}
