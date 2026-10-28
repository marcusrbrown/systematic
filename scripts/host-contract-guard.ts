/**
 * Guards the host contract suite's skip/pass floor.
 *
 * The contract runs as three profiles: the full contract on the v2 host (in
 * several shards) and a smoke subset on the v1 host at its floor and at its
 * current pin. Each profile has its own file list, pass floor and exempt
 * skips. The guard judges one profile per run: it reads one report/log pair
 * per job or shard, given on the command line as alternating paths
 * (`--profile <p> <junit> <log> [<junit> <log> ...]`), merges them, and judges
 * the union: every expected file must appear in some report, every skip must
 * be exempt for that profile, and the pass counts summed across the logs must
 * clear that profile's floor. A single pair is the one-shard case of the same
 * rule.
 *
 * `files --profile <p>` prints a profile's file list, one path per line. Every
 * host job passes that output to `bun test`, so the lists below are the single
 * source for what each job runs.
 *
 * The module-scope throw (`SYSTEMATIC_REQUIRE_OPENCODE=1`) already covers a
 * missing or mismatched host. This guard covers what it cannot: a per-test
 * gate such as `test.skipIf(!DIST_LOCAL_AVAILABLE)` skipping for an
 * unexpected reason while the job stays green, or a whole-file collapse (a
 * crash or an early exit) that still leaves the console summary and pass
 * floor looking plausible. The exempt set, the expected-file list, and the
 * floor all live here, next to the guard, so widening any of them is a
 * reviewed change.
 *
 * Structured as pure functions (parse JUnit XML string, parse the log's pass
 * count, evaluate the parsed shape into violations) plus a thin CLI wrapper
 * that performs the file I/O and exits non-zero on any violation. Splitting
 * it this way is what makes `evaluate()` unit-testable against synthetic
 * fixtures without touching the filesystem.
 */
import { readFileSync } from 'node:fs'

/**
 * The only test allowed to skip today: the mixed-version test stays opt-in
 * because enabling it would put a fetch of a published `@fro.bot/systematic`
 * release on the path that gates publishing the next one. That release only
 * loads on a v1 host, so the exemption belongs to the v1 profiles alone (see
 * {@link PROFILE_EXEMPT_SKIPS}); a skip in the v2 profile is always unexpected.
 *
 * This set is bidirectional: {@link evaluate} fails both when an
 * unlisted test skips (`unexpectedSkips`) and when a listed entry is
 * *absent* from the run (`missingExemptSkips`). A rename of the exempt
 * test's `classname`/`name` therefore fails loudly here (the old key stops
 * matching and shows up as missing) rather than silently accepting a
 * differently-named skip as a match.
 */
export const EXEMPT_SKIPS: readonly {
  readonly classname: string
  readonly name: string
}[] = [
  {
    classname: 'opencode mixed-version integration',
    name: 'pinned package plus local source keep systematic_skill deterministic and converge bootstrap',
  },
]

/**
 * The host contract runs as three profiles: the full contract on the v2 host,
 * and a smoke subset on the v1 host at its floor and at its current pin. Each
 * profile lists the integration files it must run.
 */
export const HOST_CONTRACT_PROFILES = ['v2', 'v1-floor', 'v1-current'] as const

export type HostContractProfile = (typeof HOST_CONTRACT_PROFILES)[number]

/**
 * What the v2 profile runs. Host-neutral files (the Pi and Claude Code
 * bundles, release tooling, the eval fixtures) run here once and nowhere else.
 * `opencode.test.ts` takes its host from the harness, so it runs on both hosts.
 * `opencode-v2.test.ts` is the v2 host contract: load, agents, skills, the
 * `systematic_skill` port, output restoration, commands and the bootstrap.
 */
const V2_SUITE_FILES: readonly string[] = [
  'tests/integration/claude-code.test.ts',
  'tests/integration/eval-artifact.test.ts',
  'tests/integration/eval-fixture.test.ts',
  'tests/integration/opencode-v2.test.ts',
  'tests/integration/opencode.test.ts',
  'tests/integration/pi.test.ts',
  'tests/integration/release-notes-ci.test.ts',
  'tests/integration/validate-release-target.test.ts',
]

/**
 * What both v1 profiles run: the behaviors a v1 user relies on.
 *
 * - `opencode.test.ts`: load and bootstrap, registration and enabled skill
 *   loads.
 * - `opencode-v1.test.ts`: the packaged catalog, a rejected config and the
 *   mixed-version run. v2 covers these in `opencode-v2.test.ts`; the
 *   mixed-version run loads a published release that only loads on v1.
 * - `ce-review-return-validation.test.ts`: per-agent permissions and the skill
 *   scripts, driven through the v1 session client and tool-part readback.
 * - `skill-delivery.test.ts`: output restoration, the `tool_output` override,
 *   prune and the discovered-skill slash command, all of which read the v1
 *   session API. v2 covers restoration, arguments and discovered-skill
 *   commands in `opencode-v2.test.ts`; the override and prune have no v2
 *   counterpart.
 * - `skill-command-probe.test.ts`: the `!`-backtick command probe observes
 *   v1-only behavior that v2 never reproduces.
 */
const V1_SMOKE_FILES: readonly string[] = [
  'tests/integration/ce-review-return-validation.test.ts',
  'tests/integration/opencode-v1.test.ts',
  'tests/integration/opencode.test.ts',
  'tests/integration/skill-command-probe.test.ts',
  'tests/integration/skill-delivery.test.ts',
]

/**
 * `eval-runner.test.ts` drives the eval runner, which launches the current v1
 * CLI through its own pin whatever host a job targets. It belongs to the
 * current-pin profile only: the floor job would run it against the wrong host,
 * and the v2 job would need a v1 install it does not otherwise have.
 */
const V1_CURRENT_ONLY_FILES: readonly string[] = [
  'tests/integration/eval-runner.test.ts',
]

/**
 * The per-profile file lists, the single source for what each host job runs.
 * Every test file under `tests/integration/` must appear in at least one list,
 * so a new file cannot silently go unrun; `host-contract-guard.test.ts` checks
 * that against the directory.
 */
export const PROFILE_SUITE_FILES: Readonly<
  Record<HostContractProfile, readonly string[]>
> = {
  v2: V2_SUITE_FILES,
  'v1-floor': V1_SMOKE_FILES,
  'v1-current': [...V1_SMOKE_FILES, ...V1_CURRENT_ONLY_FILES],
}

/**
 * Every integration test file any profile runs, sorted. The guard judges each
 * profile against its own list in {@link PROFILE_SUITE_FILES}; this union is
 * what the directory-drift test compares with `tests/integration/`. A file
 * producing zero JUnit `<testsuite>` entries means `bun test` never actually
 * ran it — the exact failure mode a mass-skip or an early crash would produce
 * while the console summary and pass floor alone could still look plausible.
 */
export const EXPECTED_SUITE_FILES: readonly string[] = [
  ...new Set(Object.values(PROFILE_SUITE_FILES).flat()),
].sort()

/**
 * The skips each profile tolerates. The v2 profile tolerates none. The v1
 * profiles tolerate the opt-in mixed-version test (see {@link EXEMPT_SKIPS}).
 */
export const PROFILE_EXEMPT_SKIPS: Readonly<
  Record<HostContractProfile, typeof EXEMPT_SKIPS>
> = {
  v2: [],
  'v1-floor': EXEMPT_SKIPS,
  'v1-current': EXEMPT_SKIPS,
}

/**
 * The floor catches a mass collapse of a profile: a run that passes far fewer
 * tests than it should. It does not prove that any host-touching file ran, so
 * it is not the host-coverage check. Host coverage rests on the profile's file
 * list (every listed file must appear in some report), the per-file results,
 * and the exempt-skip check.
 *
 * Each floor sits well under what its profile passes, so a normal change in
 * test count does not trip it but a mass collapse does. The first CI runs on
 * Linux passed 163 (v2), 32 (v1 floor) and 72 (v1 current), all green, which
 * puts the floors at roughly 86%, 88% and 83% of those counts. Raise a floor
 * as its suite grows, and do not lower it without a documented reason.
 */
export const PROFILE_PASS_FLOORS: Readonly<
  Record<HostContractProfile, number>
> = {
  v2: 140,
  'v1-floor': 28,
  'v1-current': 60,
}

export interface SkippedTestCase {
  readonly classname: string
  readonly name: string
}

export interface ParsedJUnit {
  readonly producedFiles: ReadonlySet<string>
  readonly skipped: readonly SkippedTestCase[]
}

/**
 * Decodes the five XML predefined entities plus numeric character
 * references. Bun's JUnit reporter XML-escapes attribute values, so a test
 * name containing `<`, `&`, etc. (this repo has one: the "payload &lt;=
 * 10000 chars" test in claude-code.test.ts, confirmed by generating a real
 * JUnit report) round-trips through `&lt;` in the report. Decoding here
 * keeps comparisons against literal `EXEMPT_SKIPS` strings correct and
 * keeps violation messages readable instead of printing raw entities.
 */
function decodeXmlEntities(str: string): string {
  return str.replaceAll(
    /&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g,
    (match, entity: string) => {
      switch (entity) {
        case 'amp':
          return '&'
        case 'lt':
          return '<'
        case 'gt':
          return '>'
        case 'quot':
          return '"'
        case 'apos':
          return "'"
        default: {
          const codePoint = entity.startsWith('#x')
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10)
          // `String.fromCodePoint` throws a RangeError above 0x10FFFF (the
          // highest valid Unicode code point) instead of returning a
          // sentinel, so an out-of-range numeric reference -- malformed
          // input, not something Bun's own reporter would ever emit -- is
          // left as the literal source text rather than crashing this
          // guard. Surrogate-range code points (0xD800-0xDFFF) are
          // deliberately NOT excluded: `String.fromCodePoint` accepts them
          // without throwing (producing a lone surrogate in the string,
          // unlike the stricter validation some Unicode-aware APIs apply),
          // so there is no crash to prevent, and no test name a real `bun
          // test` JUnit run could plausibly produce would contain one.
          return Number.isNaN(codePoint) || codePoint > 0x10ffff
            ? match
            : String.fromCodePoint(codePoint)
        }
      }
    },
  )
}

function parseAttrs(str: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrRe = /(\w+)="([^"]*)"/g
  for (const m of str.matchAll(attrRe)) {
    const [, key, value] = m
    if (key !== undefined && value !== undefined) {
      attrs[key] = decodeXmlEntities(value)
    }
  }
  return attrs
}

/**
 * Parses a Bun JUnit XML report into the produced testsuite `file=`
 * attributes and the skipped testcases.
 *
 * Bun emits one outer `<testsuite>` per test file, plus one nested
 * `<testsuite>` per describe block, all sharing that file's `file=`
 * attribute — so collecting every testsuite's file attribute and taking the
 * unique set recovers exactly the set of files bun actually loaded and ran,
 * regardless of describe nesting. The `<testsuite\b` pattern never matches
 * the closing `</testsuite>` tag (a `/` immediately follows `<`, not `t`),
 * and never matches the plural `<testsuites` container (no word boundary
 * between `testsuite` and the trailing `s`).
 */
export function parseJUnitXml(xml: string): ParsedJUnit {
  const testsuiteRe = /<testsuite\b([^>]*)>/g
  const producedFiles = new Set<string>()
  for (const suiteMatch of xml.matchAll(testsuiteRe)) {
    const attrsStr = suiteMatch[1]
    if (attrsStr === undefined) continue
    const attrs = parseAttrs(attrsStr)
    if (attrs.file !== undefined) producedFiles.add(attrs.file)
  }

  const testcaseRe = /<testcase\b([^>]*?)(\/>|>[\s\S]*?<\/testcase>)/g
  const skipped: SkippedTestCase[] = []
  for (const caseMatch of xml.matchAll(testcaseRe)) {
    const [, attrStr, rest] = caseMatch
    if (attrStr === undefined || rest === undefined) continue
    const attrs = parseAttrs(attrStr)
    if (rest.includes('<skipped')) {
      skipped.push({ classname: attrs.classname ?? '', name: attrs.name ?? '' })
    }
  }

  return { producedFiles, skipped }
}

/**
 * Extracts the pass count from a captured `bun test` log.
 *
 * Bun's default reporter prints one "<N> pass" summary line per run; take
 * the last match rather than the first so a captured log containing more
 * than one summary is scored on the final, authoritative count. Returns
 * `undefined` when no such line is found (a malformed or truncated log).
 */
export function parseLogPassCount(log: string): number | undefined {
  const passMatches = [...log.matchAll(/^\s*(\d+)\s+pass\s*$/gm)]
  const lastPassMatch = passMatches.at(-1)
  const rawCount = lastPassMatch?.[1]
  if (rawCount === undefined) return undefined
  return Number(rawCount)
}

export interface GuardViolation {
  readonly kind:
    | 'missing-files'
    | 'unexpected-skips'
    | 'missing-exempt-skips'
    | 'no-pass-line'
    | 'below-pass-floor'
  readonly message: string
  readonly details: readonly string[]
}

export interface EvaluateInput {
  readonly parsed: ParsedJUnit
  readonly passCount: number | undefined
}

/**
 * Merges the evidence of several shards into the evidence of one run: the
 * union of produced files, every skipped case, and the sum of the pass
 * counts. A shard whose log had no pass line makes the sum unknown
 * (`undefined`), which {@link evaluate} reports as `no-pass-line`: a total
 * built from the counts that were readable would understate the run and could
 * still clear the floor. Merging nothing gives an empty union.
 */
export function mergeEvidence(shards: readonly EvaluateInput[]): EvaluateInput {
  const producedFiles = new Set<string>()
  const skipped: SkippedTestCase[] = []
  let passCount: number | undefined = shards.length === 0 ? undefined : 0
  for (const shard of shards) {
    for (const file of shard.parsed.producedFiles) producedFiles.add(file)
    skipped.push(...shard.parsed.skipped)
    passCount =
      passCount === undefined || shard.passCount === undefined
        ? undefined
        : passCount + shard.passCount
  }
  return { parsed: { producedFiles, skipped }, passCount }
}

function skipKey(s: SkippedTestCase): string {
  return `${s.classname}::${s.name}`
}

/**
 * Evaluates a parsed JUnit report plus a parsed pass count against the
 * five failure conditions the guard enforces for one profile. Pure: takes
 * already-parsed data in, returns violations out, performs no I/O.
 */
export function evaluate(
  input: EvaluateInput,
  profile: HostContractProfile,
): GuardViolation[] {
  const { parsed, passCount } = input
  const violations: GuardViolation[] = []
  const passFloor = PROFILE_PASS_FLOORS[profile]

  const missingFiles = PROFILE_SUITE_FILES[profile].filter(
    (f) => !parsed.producedFiles.has(f),
  )
  if (missingFiles.length > 0) {
    violations.push({
      kind: 'missing-files',
      message:
        'Expected integration test file(s) produced no JUnit suite (bun test never ran them):',
      details: missingFiles,
    })
  }

  const exemptKeys = new Set(PROFILE_EXEMPT_SKIPS[profile].map(skipKey))
  const actualKeys = parsed.skipped.map(skipKey)

  const unexpected = actualKeys.filter((k) => !exemptKeys.has(k))
  if (unexpected.length > 0) {
    violations.push({
      kind: 'unexpected-skips',
      message: 'Unexpected skipped test(s) (not in the known-exempt set):',
      details: unexpected,
    })
  }

  const missingExempt = [...exemptKeys].filter((k) => !actualKeys.includes(k))
  if (missingExempt.length > 0) {
    violations.push({
      kind: 'missing-exempt-skips',
      message:
        'Known-exempt skip(s) not found in this run (exempt set is stale):',
      details: missingExempt,
    })
  }

  if (passCount === undefined) {
    violations.push({
      kind: 'no-pass-line',
      message:
        'Could not find a "<N> pass" summary line in the captured test output.',
      details: [],
    })
  } else if (passCount < passFloor) {
    violations.push({
      kind: 'below-pass-floor',
      message: `Pass count ${passCount} is below the ${profile} floor of ${passFloor}.`,
      details: [],
    })
  }

  return violations
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface ArtifactRead {
  /** File content, or `''` when the file could not be read. */
  readonly content: string
  /**
   * Set when the file could not be read (missing, unreadable, etc). `''` is
   * a legitimate empty-file content on success, so a separate field (rather
   * than treating `''` as failure) is what makes an empty-but-present file
   * distinguishable from a missing one.
   */
  readonly readError?: string
}

/**
 * Reads an artifact file, converting any read failure into a `readError`
 * instead of throwing or exiting. This is what lets a missing artifact be
 * evaluated as the contract failure it is (via {@link evaluate}, which
 * already treats empty JUnit/log content as `missing-files` /
 * `missing-exempt-skips` / `no-pass-line`) rather than surfacing as an
 * unrelated filesystem error -- the exact path the guard step's `failure()`
 * gating newly reaches when the suite step dies before writing its output.
 */
export function readArtifact(path: string): ArtifactRead {
  try {
    return { content: readFileSync(path, 'utf8') }
  } catch (err) {
    return {
      content: '',
      readError: `Could not read ${path}: ${errorMessage(err)}`,
    }
  }
}

const USAGE = [
  'Usage: bun scripts/host-contract-guard.ts --profile <profile> <junit-path> <log-path> [<junit-path> <log-path> ...]',
  '       bun scripts/host-contract-guard.ts files --profile <profile>',
  `Profiles: ${HOST_CONTRACT_PROFILES.join(', ')}`,
].join('\n')

/** Narrows a command-line value to a profile name. */
export function parseProfile(value: string): HostContractProfile | undefined {
  return HOST_CONTRACT_PROFILES.find((profile) => profile === value)
}

export interface ParsedCommandLine {
  readonly command: 'files' | 'check'
  readonly profile: HostContractProfile
  /** The arguments left once the command word and the profile flag are taken. */
  readonly rest: readonly string[]
}

/**
 * Splits the command line into a command (`files`, or the default check), the
 * required `--profile <p>` flag, and the remaining arguments. `undefined` for a
 * missing flag, a missing or unknown profile, or a repeated flag: the guard
 * never guesses a profile, since the wrong one would judge the wrong list.
 */
export function parseCommandLine(
  args: readonly string[],
): ParsedCommandLine | undefined {
  const command = args[0] === 'files' ? 'files' : 'check'
  const rest: string[] = []
  let profile: HostContractProfile | undefined
  let profileSeen = false
  const tokens = command === 'files' ? args.slice(1) : args
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) return undefined
    if (token !== '--profile') {
      rest.push(token)
      continue
    }
    if (profileSeen) return undefined
    profileSeen = true
    const value = tokens[index + 1]
    profile = value === undefined ? undefined : parseProfile(value)
    index += 1
  }
  if (profile === undefined) return undefined
  return { command, profile, rest }
}

interface ShardRead {
  readonly junit: ArtifactRead
  readonly log: ArtifactRead
}

/** Splits alternating `<junit> <log>` arguments into pairs; `undefined` on an odd or empty count. */
function pairArguments(
  args: readonly string[],
): { readonly junitPath: string; readonly logPath: string }[] | undefined {
  if (args.length === 0 || args.length % 2 !== 0) return undefined
  const pairs: { junitPath: string; logPath: string }[] = []
  for (let index = 0; index < args.length; index += 2) {
    const junitPath = args[index]
    const logPath = args[index + 1]
    if (junitPath === undefined || logPath === undefined) return undefined
    pairs.push({ junitPath, logPath })
  }
  return pairs
}

function reportReadErrors(read: ShardRead): boolean {
  if (read.junit.readError !== undefined) {
    console.error(read.junit.readError)
    console.error(
      'Treating this as the suite producing no test evidence, not as a guard pass.',
    )
  }
  if (read.log.readError !== undefined) {
    console.error(read.log.readError)
    console.error(
      'Treating this as the suite producing no pass-count evidence, not as a guard pass.',
    )
  }
  return read.junit.readError !== undefined || read.log.readError !== undefined
}

function usageError(): never {
  console.error(USAGE)
  process.exit(1)
}

interface CollectedShards {
  readonly shards: readonly EvaluateInput[]
  readonly hadReadError: boolean
}

/** Reads every report/log pair, printing a per-pair pass count when there are several. */
function collectShards(
  pairs: readonly { readonly junitPath: string; readonly logPath: string }[],
): CollectedShards {
  let hadReadError = false
  const shards: EvaluateInput[] = []
  for (const { junitPath, logPath } of pairs) {
    const read: ShardRead = {
      junit: readArtifact(junitPath),
      log: readArtifact(logPath),
    }
    hadReadError = reportReadErrors(read) || hadReadError
    const passCount = parseLogPassCount(read.log.content)
    if (pairs.length > 1) {
      console.log(
        `${logPath}: ${passCount === undefined ? 'no pass line' : `${passCount} pass`}`,
      )
    }
    shards.push({ parsed: parseJUnitXml(read.junit.content), passCount })
  }
  return { shards, hadReadError }
}

function runCheck(
  profile: HostContractProfile,
  pairs: readonly { readonly junitPath: string; readonly logPath: string }[],
): void {
  const { shards, hadReadError } = collectShards(pairs)
  const merged = mergeEvidence(shards)
  if (merged.passCount !== undefined) {
    console.log(
      `Observed ${profile} pass count: ${merged.passCount} (floor: ${PROFILE_PASS_FLOORS[profile]})`,
    )
  }

  const violations = evaluate(merged, profile)

  for (const violation of violations) {
    console.error(violation.message)
    for (const detail of violation.details) console.error(`  - ${detail}`)
  }

  if (hadReadError || violations.length > 0) process.exit(1)
  console.log(`host-contract skip/pass guard passed for ${profile}.`)
}

function main(): void {
  const parsedLine = parseCommandLine(process.argv.slice(2))
  if (parsedLine === undefined) usageError()
  const { command, profile, rest } = parsedLine

  if (command === 'files') {
    if (rest.length > 0) usageError()
    console.log(PROFILE_SUITE_FILES[profile].join('\n'))
    return
  }

  const pairs = pairArguments(rest)
  if (pairs === undefined) usageError()
  runCheck(profile, pairs)
}

if (import.meta.main) {
  main()
}
