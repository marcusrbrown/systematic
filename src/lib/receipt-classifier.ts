import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Language, type Node, Parser } from 'web-tree-sitter'

import type {
  ReceiptClassification,
  ReceiptOperation,
  ReceiptReasonCode,
  TerminalObservation,
} from './receipt-ledger.js'

export interface ReceiptClassificationInput {
  command: string
  terminal: TerminalObservation
}

export interface ReceiptClassifierOptions {
  treeSitterWasmPath?: string
  bashWasmPath?: string
}

export interface ReceiptClassifier {
  classify(input: unknown): Promise<ReceiptClassification>
  close(): Promise<void>
}

interface ParsedCommand {
  executable: string
  arguments: string[]
}

interface ParserAssets {
  language: Language
}

type ParserFailure =
  | 'parser-asset-unavailable'
  | 'grammar-incompatible'
  | 'parser-failure'

const SUPPORTED_ABI_MINIMUM = 13
const SUPPORTED_ABI_MAXIMUM = 15
const MAX_COMMAND_LENGTH = 4096
const PROHIBITED_NODE_TYPES = new Set([
  'arithmetic_expansion',
  'case_statement',
  'command_substitution',
  'compound_statement',
  'declaration_command',
  'for_statement',
  'function_definition',
  'heredoc_body',
  'heredoc_start',
  'if_statement',
  'negated_command',
  'pipeline',
  'process_substitution',
  'redirected_statement',
  'subshell',
  'test_command',
  'until_statement',
  'while_statement',
])

const PREFIX_COMMANDS = new Set(['cd'])
const ALLOWED_ENVIRONMENT_NAMES = new Set(['CI'])

export function createReceiptClassifier(
  options: ReceiptClassifierOptions = {},
): ReceiptClassifier {
  let closed = false
  let parserAssets: Promise<ParserAssets> | undefined

  async function loadAssets(): Promise<ParserAssets> {
    if (parserAssets) return parserAssets
    parserAssets = initializeParserAssets(options)
    return parserAssets
  }

  return {
    async classify(input: unknown): Promise<ReceiptClassification> {
      if (closed) {
        return unavailable('classifier-closed')
      }

      const parsedInput = parseInput(input)
      if (!parsedInput)
        return rejected(null, 'unknown', 'invalid-terminal-result')

      let assets: ParserAssets
      try {
        assets = await loadAssets()
      } catch (error) {
        return unavailable(classifyParserFailure(error))
      }

      return classifyWithParser(assets, parsedInput)
    },
    async close(): Promise<void> {
      closed = true
      parserAssets = undefined
    },
  }
}

export type { ReceiptOperation }

function parseInput(value: unknown): ReceiptClassificationInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const candidate = value as { command?: unknown; terminal?: unknown }
  if (
    typeof candidate.command !== 'string' ||
    candidate.command.length === 0 ||
    candidate.command.length > MAX_COMMAND_LENGTH ||
    typeof candidate.terminal !== 'object' ||
    candidate.terminal === null ||
    Array.isArray(candidate.terminal)
  ) {
    return undefined
  }
  const terminal = candidate.terminal as Partial<TerminalObservation>
  if (
    (terminal.status !== 'success' &&
      terminal.status !== 'failure' &&
      terminal.status !== 'cancelled' &&
      terminal.status !== 'running' &&
      terminal.status !== 'unknown') ||
    (terminal.output !== 'empty' &&
      terminal.output !== 'non-empty' &&
      terminal.output !== 'unknown') ||
    typeof terminal.noOp !== 'boolean'
  ) {
    return undefined
  }
  return {
    command: candidate.command,
    terminal: {
      status: terminal.status,
      output: terminal.output,
      noOp: terminal.noOp,
    },
  }
}

async function initializeParserAssets(
  options: ReceiptClassifierOptions,
): Promise<ParserAssets> {
  const treeSitterWasmPath =
    options.treeSitterWasmPath ??
    resolveAsset('web-tree-sitter/tree-sitter.wasm')
  const bashWasmPath =
    options.bashWasmPath ??
    resolveAsset('tree-sitter-bash/tree-sitter-bash.wasm')
  if (!fs.existsSync(treeSitterWasmPath) || !fs.existsSync(bashWasmPath)) {
    throw new Error('parser-asset-unavailable')
  }

  try {
    await Parser.init({ locateFile: () => treeSitterWasmPath })
  } catch {
    throw new Error('parser-asset-unavailable')
  }

  let language: Language
  try {
    language = await Language.load(bashWasmPath)
  } catch {
    throw new Error('grammar-incompatible')
  }
  if (
    language.abiVersion < SUPPORTED_ABI_MINIMUM ||
    language.abiVersion > SUPPORTED_ABI_MAXIMUM
  ) {
    throw new Error('grammar-incompatible')
  }
  return { language }
}

function resolveAsset(specifier: string): string {
  const resolved = import.meta.resolve(specifier)
  return resolved.startsWith('file://') ? fileURLToPath(resolved) : resolved
}

function classifyParserFailure(error: unknown): ParserFailure {
  if (error instanceof Error && error.message === 'grammar-incompatible') {
    return 'grammar-incompatible'
  }
  if (error instanceof Error && error.message === 'parser-failure')
    return 'parser-failure'
  return 'parser-asset-unavailable'
}

function unavailable(
  reasonCode: ParserFailure | 'classifier-closed',
): ReceiptClassification {
  return {
    outcome: 'unavailable',
    category: null,
    attribution: 'unattributed',
    result: 'unknown',
    sideEffect: 'not-required',
    reasonCode,
  }
}

function rejected(
  category: ReceiptOperation | null,
  result: ReceiptClassification['result'],
  reasonCode: ReceiptReasonCode,
  sideEffect: ReceiptClassification['sideEffect'] = 'not-required',
): ReceiptClassification {
  return {
    outcome: 'rejected',
    category,
    attribution: category ? 'runtime-verified' : 'unattributed',
    result,
    sideEffect,
    reasonCode,
  }
}

function accepted(operation: ReceiptOperation): ReceiptClassification {
  return {
    outcome: 'accepted',
    category: operation,
    attribution: 'runtime-verified',
    result: 'success',
    sideEffect: operationNeedsSideEffect(operation)
      ? 'required'
      : 'not-required',
    reasonCode: 'recognized-command',
  }
}

function terminalClassification(
  operation: ReceiptOperation,
  terminal: TerminalObservation,
): ReceiptClassification {
  const sideEffect = operationNeedsSideEffect(operation)
    ? 'required'
    : 'not-required'
  if (terminal.status === 'failure')
    return rejected(operation, 'failure', 'terminal-failure', sideEffect)
  if (terminal.status === 'cancelled')
    return rejected(operation, 'unknown', 'terminal-cancelled', sideEffect)
  if (terminal.status === 'running')
    return rejected(operation, 'unknown', 'terminal-running', sideEffect)
  if (terminal.status === 'unknown')
    return rejected(operation, 'unknown', 'terminal-unknown', sideEffect)
  if (terminal.output === 'empty')
    return rejected(operation, 'success', 'empty-result', sideEffect)
  if (terminal.output === 'unknown')
    return rejected(operation, 'unknown', 'invalid-terminal-result', sideEffect)
  if (terminal.noOp)
    return rejected(operation, 'success', 'successful-no-op', sideEffect)
  return accepted(operation)
}

function operationNeedsSideEffect(operation: ReceiptOperation): boolean {
  return (
    operation === 'implementation' ||
    operation === 'commit' ||
    operation === 'push' ||
    operation === 'pr-creation'
  )
}

async function classifyWithParser(
  assets: ParserAssets,
  input: ReceiptClassificationInput,
): Promise<ReceiptClassification> {
  const parser = new Parser()
  let tree = null
  try {
    parser.setLanguage(assets.language)
    tree = parser.parse(input.command)
    if (!tree || tree.rootNode.hasError)
      return rejected(null, 'unknown', 'parser-failure')
    return classifyParsedShape(tree.rootNode, input.terminal)
  } catch {
    return unavailable('parser-failure')
  } finally {
    tree?.delete()
    parser.delete()
  }
}

function classifyParsedShape(
  root: Node,
  terminal: TerminalObservation,
): ReceiptClassification {
  const shape = parseCommandShape(root)
  if (!shape) return rejected(null, 'unknown', 'prohibited-shell-shape')
  const operation = classifyCommands(shape)
  if (!operation) return rejected(null, 'unknown', 'unsupported-command')
  return terminalClassification(operation, terminal)
}

function parseCommandShape(root: Node): ParsedCommand[] | undefined {
  if (root.type !== 'program' || root.namedChildren.length !== 1)
    return undefined
  const statement = root.namedChildren[0]
  if (!statement) return undefined
  if (containsProhibitedNode(statement)) return undefined
  if (statement.type === 'command') {
    const parsed = parseCommand(statement)
    return parsed ? [parsed] : undefined
  }
  if (statement.type !== 'list') return undefined

  return parseOrderedCommandList(statement)
}

function parseOrderedCommandList(statement: Node): ParsedCommand[] | undefined {
  const children = statement.children.filter(
    (child): child is Node => child !== null,
  )
  if (!isOrderedAndChain(children)) return undefined
  const commands: ParsedCommand[] = []
  for (let index = 0; index < children.length; index += 2) {
    const command = children[index]
    if (command?.type !== 'command') return undefined
    const parsed = parseCommand(command)
    if (!parsed) return undefined
    commands.push(parsed)
  }
  return commands
}

function isOrderedAndChain(children: readonly Node[]): boolean {
  if (children.length < 3) return false
  for (let index = 0; index < children.length; index += 1) {
    const expectedType = index % 2 === 0 ? 'command' : '&&'
    if (children[index]?.type !== expectedType) return false
  }
  return true
}

function containsProhibitedNode(node: Node): boolean {
  if (PROHIBITED_NODE_TYPES.has(node.type)) return true
  for (const child of node.namedChildren) {
    if (child && containsProhibitedNode(child)) return true
  }
  return false
}

function parseCommand(node: Node): ParsedCommand | undefined {
  if (node.type !== 'command') return undefined
  const commandName = node.childForFieldName('name')
  if (commandName?.type !== 'command_name') return undefined
  const executable = parsePlainToken(commandName.namedChildren[0])
  if (!executable) return undefined
  if (!hasSafeCommandChildren(node)) return undefined
  const argumentsList = parseArguments(node)
  if (!argumentsList) return undefined
  return { executable, arguments: argumentsList }
}

function hasSafeCommandChildren(node: Node): boolean {
  return node.namedChildren.every((child) => {
    if (!child || child.type === 'command_name') return true
    if (child.type === 'variable_assignment')
      return parseEnvironmentAssignment(child)
    return !containsDynamicSyntax(child)
  })
}

function parseArguments(node: Node): string[] | undefined {
  const argumentsList: string[] = []
  for (const argument of node.childrenForFieldName('argument')) {
    if (!argument) return undefined
    const token = parseArgument(argument)
    if (!token) return undefined
    argumentsList.push(token)
  }
  return argumentsList
}

function parseEnvironmentAssignment(node: Node): boolean {
  const name = node.childForFieldName('name')
  const value = node.childForFieldName('value')
  const nameText = name?.text
  const valueText = value?.text
  return (
    !!nameText &&
    ALLOWED_ENVIRONMENT_NAMES.has(nameText) &&
    (valueText === '1' || valueText === 'true' || valueText === 'TRUE')
  )
}

function parseArgument(node: Node): string | undefined {
  if (containsDynamicSyntax(node)) return undefined
  if (
    node.type === 'word' ||
    node.type === 'number' ||
    node.type === 'string' ||
    node.type === 'raw_string'
  ) {
    return node.type === 'word' || node.type === 'number'
      ? parseSafeWord(node.text)
      : node.text
  }
  return undefined
}

function parsePlainToken(node: Node | null): string | undefined {
  if (!node || containsDynamicSyntax(node)) return undefined
  if (node.type !== 'word' && node.type !== 'number') return undefined
  return parseSafeWord(node.text)
}

function parseSafeWord(value: string): string | undefined {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : undefined
}

function containsDynamicSyntax(node: Node): boolean {
  if (
    node.type === 'command_substitution' ||
    node.type === 'process_substitution' ||
    node.type === 'variable_expansion' ||
    node.type === 'expansion' ||
    node.type === 'concatenation' ||
    node.type === 'arithmetic_expansion'
  ) {
    return true
  }
  for (const child of node.namedChildren) {
    if (child && containsDynamicSyntax(child)) return true
  }
  return false
}

function classifyCommands(
  commands: readonly ParsedCommand[],
): ReceiptOperation | undefined {
  if (commands.length === 0) return undefined
  for (const prefix of commands.slice(0, -1)) {
    if (!isAllowedPrefix(prefix)) return undefined
  }
  return classifyFinalCommand(commands[commands.length - 1])
}

function isAllowedPrefix(command: ParsedCommand): boolean {
  return (
    PREFIX_COMMANDS.has(command.executable) &&
    command.arguments.length === 1 &&
    isSafeRelativeCwd(command.arguments[0] ?? '')
  )
}

function isSafeRelativeCwd(value: string): boolean {
  if (value === '.') return true
  if (value.startsWith('/') || value.startsWith('~')) return false
  const relative = value.startsWith('./') ? value.slice(2) : value
  if (relative.length === 0) return false
  return relative
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        /^[A-Za-z0-9_-]+$/.test(segment),
    )
}

function classifyFinalCommand(
  command: ParsedCommand,
): ReceiptOperation | undefined {
  const { executable, arguments: args } = command
  if (executable === 'git') return classifyGitCommand(args)
  if (executable === 'bun' || executable === 'npm') {
    return args[0] === 'test' &&
      (args.length === 1 || (args.length === 2 && isSafePathArgument(args[1])))
      ? 'verification'
      : undefined
  }
  if (executable === 'gh') return classifyGhCommand(args)
  return undefined
}

function classifyGitCommand(
  args: readonly string[],
): ReceiptOperation | undefined {
  if (args[0] === 'apply' && args.length === 2 && isSafePathArgument(args[1])) {
    return 'implementation'
  }
  if (
    args[0] === 'status' &&
    (args.length === 1 ||
      (args.length === 2 &&
        (args[1] === '--short' || args[1] === '--porcelain')))
  ) {
    return 'verification'
  }
  if (args.length === 2 && args[0] === 'diff' && args[1] === '--check')
    return 'verification'
  if (
    args.length === 3 &&
    args[0] === 'commit' &&
    args[1] === '-m' &&
    !isEmptyShellString(args[2])
  ) {
    return 'commit'
  }
  if (
    args.length === 3 &&
    args[0] === 'push' &&
    isSafePathArgument(args[1]) &&
    isSafePathArgument(args[2])
  ) {
    return 'push'
  }
  return undefined
}

function classifyGhCommand(
  args: readonly string[],
): ReceiptOperation | undefined {
  if (args[0] !== 'pr') return undefined
  if (
    args.length === 6 &&
    args[1] === 'create' &&
    args[2] === '--title' &&
    args[3]?.length > 0 &&
    args[4] === '--body' &&
    args[5]?.length > 0 &&
    !isEmptyShellString(args[3]) &&
    !isEmptyShellString(args[5])
  ) {
    return 'pr-creation'
  }
  if (args.length === 3 && args[1] === 'checks' && isPullRequestNumber(args[2]))
    return 'check-readback'
  if (
    args.length === 5 &&
    args[1] === 'view' &&
    isPullRequestNumber(args[2]) &&
    args[3] === '--json' &&
    (args[4] === 'reviews' || args[4] === 'reviewDecision')
  ) {
    return 'review-readback'
  }
  return undefined
}

function isSafePathArgument(value: string | undefined): boolean {
  if (
    !value ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.startsWith('~')
  )
    return false
  const relative = value.startsWith('./') ? value.slice(2) : value
  if (relative.length === 0) return false
  return relative
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        /^[A-Za-z0-9_.:@%+=,-]+$/.test(segment),
    )
}

function isEmptyShellString(value: string | undefined): boolean {
  return value === '""' || value === "''"
}

function isPullRequestNumber(value: string | undefined): boolean {
  return !!value && /^[0-9]+$/.test(value)
}
