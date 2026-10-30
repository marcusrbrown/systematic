/**
 * The command-line adapter for durable-output search, shared by
 * `systematic search` (`src/cli.ts`) and the `systematic-search` plugin
 * bin. Like the tool adapters it does host I/O only: parse flags, pick the
 * start directory, hand the settings to `runSearch`, and map the response to
 * an exit code. Every byte of a search result is the core's text.
 *
 * It never loads config itself. The caller injects a settings loader, so
 * `cli.ts` can use the full loader (project config included, with its strip
 * warnings) and the bin can use the user-level reader alone.
 *
 * Exit codes: 0 for results, no hits and disabled; 1 for an unexpected
 * failure; 2 for usage errors. There is no `--json`.
 *
 * Import rule: this module is bundled into the `systematic-search` bin, so it
 * may import only `search-core.ts` and node builtins.
 */

import path from 'node:path'
import {
  MAX_LIMIT,
  MIN_LIMIT,
  runSearch,
  SEARCH_ARGS,
  SEARCH_CONFIG_UNREADABLE_NOTE,
  SEARCH_NOTICES,
  type SearchSettings,
} from './search-core.js'

export const SEARCH_CLI_USAGE = `Usage: systematic search <query...> [--dir <path>] [--kind solution] [--limit <${MIN_LIMIT}-${MAX_LIMIT}>] [--]

Searches the project's docs/solutions learnings by symptom, error text, module
or topic, and prints ranked hits.

Options:
  --dir <path>     Start the search from <path> (default: the current directory).
                   The project root is the nearest ancestor holding .git.
  --kind <kind>    The kind of durable output to search. Only "solution" exists.
  --limit <n>      How many hits to return, ${MIN_LIMIT} to ${MAX_LIMIT} (default: 8).
  --               End of options; everything after it is part of the query.
  -h, --help       Show this help.

Exit statuses: 0 results, no hits, or search disabled; 2 usage error`

/** What `search.enabled: false` prints. The researcher falls back to grep on it. */
export const SEARCH_CLI_DISABLED_NOTICE =
  'Search is disabled (search.enabled is false in your Systematic config), so there is nothing to search.'

/** What a settings loader returns. The bin's user-level reader returns the same shape. */
export interface SearchCliSettingsLoad {
  readonly settings?: SearchSettings | undefined
  /** Printed to stderr, one per line, before the search runs. */
  readonly warnings: readonly string[]
  /** A source could not be read: its settings were ignored and results carry a `config unreadable` note. */
  readonly unreadable: boolean
}

/** Receives the absolute start directory. A loader that does not need it ignores it. */
export type SearchCliSettingsLoader = (
  startDir: string,
) => SearchCliSettingsLoad

export interface SearchCliOptions {
  /** The arguments after the `search` command: query words and flags. */
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly loadSettings: SearchCliSettingsLoader
  readonly outputSink?: (message: string) => void
  readonly errorSink?: (message: string) => void
}

type ValueFlag = 'dir' | 'kind' | 'limit'

const VALUE_FLAGS: ReadonlySet<string> = new Set<ValueFlag>([
  'dir',
  'kind',
  'limit',
])

function isValueFlag(name: string): name is ValueFlag {
  return VALUE_FLAGS.has(name)
}

type ParsedArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'search'
      readonly query: string
      readonly flags: Readonly<Partial<Record<ValueFlag, string>>>
    }

function usageError(message: string): ParsedArgs {
  return { kind: 'error', message: `${message}\n${SEARCH_CLI_USAGE}` }
}

type FlagRead =
  | {
      readonly kind: 'flag'
      readonly name: ValueFlag
      readonly value: string
      /** How many argv entries the flag used: 1 for `--name=value`, 2 for `--name value`. */
      readonly consumed: number
    }
  | { readonly kind: 'error'; readonly message: string }

/**
 * Read one `--name value` or `--name=value` flag starting at `argv[index]`.
 * `seen` holds the flags already read, so a repeat is an error.
 */
function readValueFlag(
  argv: readonly string[],
  index: number,
  seen: Readonly<Partial<Record<ValueFlag, string>>>,
): FlagRead {
  const arg = argv[index] ?? ''
  const equals = arg.indexOf('=')
  const name = arg.slice(2, equals === -1 ? undefined : equals)
  if (!arg.startsWith('--') || !isValueFlag(name)) {
    return { kind: 'error', message: 'Error: unknown option.' }
  }
  if (seen[name] !== undefined) {
    return {
      kind: 'error',
      message: 'Error: an option was given more than once.',
    }
  }
  const value = equals === -1 ? argv[index + 1] : arg.slice(equals + 1)
  if (value === undefined) {
    return { kind: 'error', message: 'Error: an option is missing its value.' }
  }
  return { kind: 'flag', name, value, consumed: equals === -1 ? 2 : 1 }
}

/**
 * Split argv into query words and flags. A flag is `--name value` or
 * `--name=value`; `--` ends flag parsing; a lone `-` is a word. Messages are
 * fixed text: no flag name or value from argv is echoed.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const words: string[] = []
  const flags: Partial<Record<ValueFlag, string>> = {}
  let endOfFlags = false
  let index = 0
  while (index < argv.length) {
    const arg = argv[index] ?? ''
    if (endOfFlags || !arg.startsWith('-') || arg === '-') {
      words.push(arg)
      index += 1
    } else if (arg === '--') {
      endOfFlags = true
      index += 1
    } else if (arg === '-h' || arg === '--help') {
      return { kind: 'help' }
    } else {
      const read = readValueFlag(argv, index, flags)
      if (read.kind === 'error') return usageError(read.message)
      flags[read.name] = read.value
      index += read.consumed
    }
  }
  return { kind: 'search', query: words.join(' '), flags }
}

/** A canonical integer string becomes a number; anything else stays a string for the core to reject. */
function limitValue(raw: string | undefined): number | string | undefined {
  if (raw === undefined) return undefined
  return /^-?\d+$/.test(raw) ? Number(raw) : raw
}

/**
 * Run `systematic search`. Flag parse errors are decided first, before any
 * settings are loaded; a request the core rejects (an empty query, a bad
 * `--limit`) is decided after, so a disabled search says so first. Returns the process exit code and never throws.
 */
export async function runSearchCli(options: SearchCliOptions): Promise<number> {
  const outputSink =
    options.outputSink ?? ((message: string) => console.log(message))
  const errorSink =
    options.errorSink ?? ((message: string) => console.error(message))

  const parsed = parseArgs(options.argv)
  if (parsed.kind === 'help') {
    outputSink(SEARCH_CLI_USAGE)
    return 0
  }
  if (parsed.kind === 'error') {
    errorSink(parsed.message)
    return 2
  }

  try {
    const startDir = path.resolve(
      options.cwd ?? process.cwd(),
      parsed.flags.dir ?? '.',
    )

    let load: SearchCliSettingsLoad
    try {
      load = options.loadSettings(startDir)
    } catch {
      // A loader that throws is an unreadable config, never a failed search.
      load = { settings: undefined, warnings: [], unreadable: true }
    }
    for (const warning of load.warnings) errorSink(warning)

    if (load.settings?.enabled === false) {
      outputSink(SEARCH_CLI_DISABLED_NOTICE)
      return 0
    }

    const response = await runSearch(
      {
        [SEARCH_ARGS.query]: parsed.query,
        [SEARCH_ARGS.kind]: parsed.flags.kind,
        [SEARCH_ARGS.limit]: limitValue(parsed.flags.limit),
      },
      {
        startDir,
        settings: load.settings,
        ...(load.unreadable && { notes: [SEARCH_CONFIG_UNREADABLE_NOTE] }),
      },
    )
    if (!response.ok) {
      // `runSearch` rejects only a bad request: the caller's mistake.
      errorSink(response.text)
      return 2
    }
    outputSink(response.text)
    return 0
  } catch {
    errorSink(SEARCH_NOTICES.failed)
    return 1
  }
}
