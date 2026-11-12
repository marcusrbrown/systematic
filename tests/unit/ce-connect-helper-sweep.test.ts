/**
 * Coverage rotation across runs. A run is offered a slice of the rule index
 * (families per run times rules per family). The slice starts with the rules
 * never covered or changed since they were covered, then the least recently
 * covered. Coverage is recorded only for a committed run.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  type HelperDeps,
  type HelperResult,
  runHelperOp,
} from '../../src/ce-connect-helper.js'
import type { HostSupportRow } from '../../src/lib/connect-config.js'
import { ruleIdFor } from '../../src/lib/connect-helper-core.js'
import { cleanupTempDirs, git, makeDir } from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

type Json = Record<string, unknown>

const SUPPORTED: HostSupportRow = {
  host: 'opencode-v2',
  version: '9999.0.0',
  observedBy: 'tests/unit/ce-connect-helper-sweep.test.ts',
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function realTemp(prefix: string): string {
  return fs.realpathSync(makeDir(prefix))
}

function learning(project: string, name: string, edit = 0): string {
  return [
    '---',
    `title: ${project} ${name} rule`,
    `applies_when: ${project} ${name} situation`,
    '---',
    '',
    '## Guidance',
    '',
    `Follow the ${project} ${name} guidance (revision ${edit}).`,
    '',
  ].join('\n')
}

function createProject(label: string, names: readonly string[]): string {
  const work = path.join(realTemp('connect-sweep-project-'), label)
  fs.mkdirSync(work, { recursive: true })
  git(work, ['init', '-q', '-b', 'main'])
  git(work, ['config', 'gc.auto', '0'])
  git(work, ['config', 'maintenance.auto', 'false'])
  for (const name of names) {
    const file = path.join(work, 'docs', 'solutions', `${name}.md`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, learning(label, name))
    git(work, ['add', '-f', '--', `:(literal)docs/solutions/${name}.md`])
  }
  git(work, ['commit', '-q', '-m', 'base', '--no-verify', '--allow-empty'])
  return work
}

const NAMES = ['one', 'two', 'three', 'four'] as const

interface World {
  readonly alpha: string
  readonly beta: string
  readonly stateRoot: string
  readonly configFile: string
  readonly deps: HelperDeps
}

function writeConfig(
  world: Pick<World, 'alpha' | 'beta' | 'configFile'>,
  groups: Record<string, string[]>,
): void {
  fs.writeFileSync(
    world.configFile,
    JSON.stringify({
      connect: { allow_projects: [world.alpha, world.beta], groups },
    }),
  )
}

/** Two projects with four learnings each: eight rules, four per run. */
function buildWorld(): World {
  const alpha = createProject('alpha', NAMES)
  const beta = createProject('beta', NAMES)
  const home = realTemp('connect-sweep-home-')
  const userConfigDir = path.join(home, '.config', 'opencode')
  fs.mkdirSync(userConfigDir, { recursive: true })
  const configFile = path.join(userConfigDir, 'systematic.json')
  writeConfig(
    { alpha, beta, configFile },
    { solo: [alpha], 'solo-again': [alpha], pair: [alpha, beta] },
  )
  const stateHome = path.join(realTemp('connect-sweep-state-'), 'xdg')
  // A clock that moves on every read, so two runs never share a coverage time.
  let clock = Date.now()
  return {
    alpha,
    beta,
    configFile,
    stateRoot: path.join(stateHome, 'systematic', 'connect'),
    deps: {
      env: { XDG_STATE_HOME: stateHome },
      homeDir: home,
      config: { homeDir: home, userConfigDir, customConfigDir: null },
      hostTable: [SUPPORTED],
      holderPid: process.pid,
      now: () => {
        clock += 1000
        return clock
      },
      bounds: { maxFamiliesPerRun: 2, maxRulesPerFamily: 2 },
    },
  }
}

function ok(result: HelperResult): Json {
  if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result.body)}`)
  return result.body
}

interface Started {
  readonly body: Json
  readonly runId: string
  readonly workDir: string
  readonly lock: { nonce: string; pid: number }
  readonly offered: string[]
}

function start(world: World, selection: readonly string[] = []): Started {
  const body = ok(
    runHelperOp(
      'begin',
      {
        host: 'opencode-v2',
        version: '9999.0.0',
        mode: 'headless',
        ...(selection.length === 0 ? {} : { selection }),
      },
      world.deps,
    ),
  )
  return {
    body,
    runId: body.runId as string,
    workDir: body.workDir as string,
    lock: body.lock as { nonce: string; pid: number },
    offered: body.offeredRuleIds as string[],
  }
}

function batch(
  world: World,
  run: Started,
  ruleIds: readonly string[],
  over: Json = {},
): Json {
  return {
    version: 1,
    runId: run.runId,
    family: 'family',
    ruleIds,
    projects: [world.alpha, world.beta],
    files: [],
    searches: ['search'],
    complete: true,
    candidates: [],
    ...over,
  }
}

function writeBatch(run: Started, name: string, body: Json): string {
  const file = path.join(run.workDir, name)
  fs.writeFileSync(file, JSON.stringify(body))
  return file
}

function validate(world: World, run: Started, files: string[]): Json {
  return ok(
    runHelperOp(
      'validate',
      { runId: run.runId, lock: run.lock, batches: files },
      world.deps,
    ),
  )
}

function publish(world: World, run: Started, extra: Json = {}): Json {
  return ok(
    runHelperOp(
      'publish',
      { runId: run.runId, lock: run.lock, ...extra },
      world.deps,
    ),
  )
}

/** Two families that between them name `covered`. */
function runCovering(
  world: World,
  covered: (offered: string[]) => string[] = (offered) => offered,
  selection: readonly string[] = [],
): { run: Started; validated: Json; published: Json } {
  const run = start(world, selection)
  const ids = covered(run.offered)
  const half = Math.ceil(ids.length / 2)
  const projects = (run.body.projects as Array<{ root: string }>).map(
    (project) => project.root,
  )
  const files = [ids.slice(0, half), ids.slice(half)]
    .filter((group) => group.length > 0)
    .map((group, index) =>
      writeBatch(
        run,
        `family-${index + 1}.json`,
        batch(world, run, group, { family: `family ${index + 1}`, projects }),
      ),
    )
  const validated = validate(world, run, files)
  const published = publish(world, run)
  return { run, validated, published }
}

function labelOf(world: World, id: string): string {
  for (const [label, root] of [
    ['alpha', world.alpha],
    ['beta', world.beta],
  ] as const) {
    for (const name of NAMES) {
      if (ruleIdFor(root, `docs/solutions/${name}.md`) === id) {
        return `${label}/${name}`
      }
    }
  }
  return id
}

function labels(world: World, ids: readonly string[]): string[] {
  return ids.map((id) => labelOf(world, id))
}

function ledgerFile(world: World): Json {
  return JSON.parse(
    fs.readFileSync(path.join(world.stateRoot, 'ledger.json'), 'utf8'),
  ) as Json
}

function coveredIds(world: World): string[] {
  if (!fs.existsSync(path.join(world.stateRoot, 'ledger.json'))) return []
  const coverage = (ledgerFile(world).coverage ?? []) as Array<{
    ruleId: string
  }>
  return coverage.map((item) => item.ruleId)
}

function commit(root: string, message: string): void {
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', message, '--no-verify'])
}

// ── The offered slice ───────────────────────────────────────────────────────

describe('the offered slice', () => {
  it('offers at most families per run times rules per family, spread across projects', () => {
    const world = buildWorld()
    const run = start(world)

    expect(run.body.ruleCount).toBe(8)
    expect(run.body.offeredCount).toBe(4)
    expect(run.offered).toHaveLength(4)
    expect(new Set(labels(world, run.offered))).toEqual(
      new Set(['alpha/four', 'alpha/one', 'beta/four', 'beta/one']),
    )
  })

  it('offers the whole index when it fits in one slice', () => {
    const world = buildWorld()
    const run = (() => {
      const body = ok(
        runHelperOp(
          'begin',
          { host: 'opencode-v2', version: '9999.0.0', mode: 'headless' },
          {
            ...world.deps,
            bounds: { maxFamiliesPerRun: 6, maxRulesPerFamily: 8 },
          },
        ),
      )
      return body
    })()
    expect(run.offeredCount).toBe(8)
  })

  it('offers the same slice, in the same order, to every run that starts from the same state', () => {
    const world = buildWorld()
    const first = start(world)
    ok(
      runHelperOp(
        'publish',
        { runId: first.runId, lock: first.lock, abort: true },
        world.deps,
      ),
    )
    const second = start(world)
    expect(second.offered).toEqual(first.offered)
  })

  it('marks the offered rules in rules.tsv, lists them first, and keeps the other rules', () => {
    const world = buildWorld()
    const run = start(world)
    const lines = fs
      .readFileSync(run.body.rulesOverview as string, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => line.split('\t'))

    expect(lines).toHaveLength(8)
    for (const cells of lines) expect(cells).toHaveLength(6)
    expect(lines.slice(0, 4).map((cells) => cells[0])).toEqual(run.offered)
    expect(lines.slice(0, 4).map((cells) => cells[5])).toEqual([
      'offered',
      'offered',
      'offered',
      'offered',
    ])
    expect(lines.slice(4).map((cells) => cells[5])).toEqual([
      'later',
      'later',
      'later',
      'later',
    ])
    expect(new Set(lines.map((cells) => cells[0])).size).toBe(8)
  })

  it('reports the sweep before the run in the begin answer', () => {
    const world = buildWorld()
    const run = start(world)
    expect(run.body.sweep).toEqual({
      total: 8,
      covered: 0,
      sliceSize: 4,
      runsLeft: 2,
    })
  })
})

// ── Rotation ────────────────────────────────────────────────────────────────

describe('rotation across runs', () => {
  it('offers uncovered rules next, then wraps to the least recently covered', () => {
    const world = buildWorld()
    const first = runCovering(world)
    const second = runCovering(world)
    const third = runCovering(world)

    const seen = new Set<string>()
    for (const id of first.run.offered) seen.add(id)
    expect(second.run.offered.some((id) => seen.has(id))).toBe(false)
    for (const id of second.run.offered) seen.add(id)
    expect(seen.size).toBe(8)
    // Everything is covered: the third run starts again with the oldest.
    expect(third.run.offered).toEqual(first.run.offered)
    expect(third.run.body.sweep).toMatchObject({ covered: 8, runsLeft: 0 })
  })

  it('records coverage for the offered rules a committed run covered', () => {
    const world = buildWorld()
    const { run, published } = runCovering(world)

    expect(published.outcome).toBe('complete')
    const coverage = ledgerFile(world).coverage as Array<Json>
    expect(coverage.map((item) => item.ruleId).sort()).toEqual(
      [...run.offered].sort(),
    )
    for (const item of coverage) {
      expect(item.runId).toBe(run.runId)
      expect(item.hash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('offers again a rule a degraded run left uncovered, before any covered rule', () => {
    const world = buildWorld()
    const first = runCovering(world, (offered) => offered.slice(0, 3))
    const left = first.run.offered[3] as string
    const covered = first.run.offered.slice(0, 3)
    expect(first.published.outcome).toBe('degraded')
    expect(coveredIds(world).sort()).toEqual([...covered].sort())

    const second = start(world)
    expect(second.offered).toContain(left)
    for (const id of second.offered) expect(covered).not.toContain(id)
  })

  it('does not record coverage from an incomplete family', () => {
    const world = buildWorld()
    const run = start(world)
    const [a, b, c, d] = run.offered as [string, string, string, string]
    const done = writeBatch(run, 'family-1.json', batch(world, run, [a, b]))
    const cut = writeBatch(
      run,
      'family-2.json',
      batch(world, run, [c, d], { complete: false }),
    )
    validate(world, run, [done, cut])
    const published = publish(world, run)

    expect(published.outcome).toBe('degraded')
    expect(coveredIds(world).sort()).toEqual([a, b].sort())
  })

  it('re-offers a rule whose learning changed since it was covered', () => {
    const world = buildWorld()
    runCovering(world)
    runCovering(world)
    const edited = path.join(world.alpha, 'docs/solutions/three.md')
    fs.writeFileSync(edited, learning('alpha', 'three', 1))
    commit(world.alpha, 'edit')

    const run = start(world)
    expect(run.offered[0]).toBe(
      ruleIdFor(world.alpha, 'docs/solutions/three.md'),
    )
    expect(run.body.sweep).toMatchObject({ total: 8, covered: 7, runsLeft: 1 })
  })

  it('drops the coverage of a rule whose learning disappeared', () => {
    const world = buildWorld()
    runCovering(world)
    const gone = ruleIdFor(world.alpha, 'docs/solutions/one.md')
    expect(coveredIds(world)).toContain(gone)

    git(world.alpha, ['rm', '-q', 'docs/solutions/one.md'])
    commit(world.alpha, 'remove')
    runCovering(world)

    expect(coveredIds(world)).not.toContain(gone)
    expect(coveredIds(world)).toHaveLength(7)
  })

  it('ignores a rule id in a batch that the run was not offered', () => {
    const world = buildWorld()
    const run = start(world)
    const later = ruleIdFor(world.beta, 'docs/solutions/two.md')
    expect(run.offered).not.toContain(later)
    const file = writeBatch(
      run,
      'family-1.json',
      batch(world, run, [...run.offered, later]),
    )
    validate(world, run, [file])
    publish(world, run)

    expect(coveredIds(world)).not.toContain(later)
    expect(coveredIds(world)).toHaveLength(4)
  })
})

// ── Coverage is recorded on commit only ─────────────────────────────────────

describe('coverage and an unfinished run', () => {
  it('records nothing for an aborted run', () => {
    const world = buildWorld()
    const run = start(world)
    const file = writeBatch(
      run,
      'family-1.json',
      batch(world, run, run.offered),
    )
    validate(world, run, [file])
    publish(world, run, { abort: true })

    expect(coveredIds(world)).toEqual([])
    expect(start(world).offered).toEqual(run.offered)
  })

  it('records nothing for a run that is validated and never published', () => {
    const world = buildWorld()
    const run = start(world)
    const file = writeBatch(
      run,
      'family-1.json',
      batch(world, run, run.offered),
    )
    validate(world, run, [file])
    ok(runHelperOp('ledger-unlock', {}, world.deps))

    expect(coveredIds(world)).toEqual([])
    expect(start(world).offered).toEqual(run.offered)
  })

  it('records nothing when validate fails on a malformed batch', () => {
    const world = buildWorld()
    const run = start(world)
    const file = path.join(run.workDir, 'family-1.json')
    fs.writeFileSync(file, '{ nope')
    const failed = runHelperOp(
      'validate',
      { runId: run.runId, lock: run.lock, batches: [file] },
      world.deps,
    )
    expect(failed.ok).toBe(false)
    expect(coveredIds(world)).toEqual([])
  })
})

// ── Outcomes ────────────────────────────────────────────────────────────────

describe('outcome and rules that were not offered', () => {
  it('ends complete when the offered slice is covered, though most of the index is not', () => {
    const world = buildWorld()
    const { validated, published } = runCovering(world)

    expect(validated.pendingOutcome).toBe('complete')
    expect(validated.degradeReasons).toEqual([])
    expect((validated.coverage as Json).uncoveredRuleIds).toEqual([])
    expect(published.outcome).toBe('complete')
    expect(published.finalLine).toBe('Connect complete')
  })

  it('degrades when an offered rule is in no complete family', () => {
    const world = buildWorld()
    const { validated, published } = runCovering(world, (offered) =>
      offered.slice(1),
    )
    expect(validated.pendingOutcome).toBe('degraded')
    expect(validated.degradeReasons).toContain('uncovered-rules')
    expect(published.outcome).toBe('degraded')
  })

  it('still degrades when a project is untouched', () => {
    const world = buildWorld()
    const run = start(world)
    const file = writeBatch(
      run,
      'family-1.json',
      batch(world, run, run.offered, { projects: [world.alpha] }),
    )
    const validated = validate(world, run, [file])
    expect(validated.degradeReasons).toContain('untouched-project')
  })

  it('does not name a rule that was not offered among the rules left uncovered', () => {
    const world = buildWorld()
    const { published } = runCovering(world, (offered) => offered.slice(1))
    const digest = fs.readFileSync(published.digestPath as string, 'utf8')
    const later = ruleIdFor(world.beta, 'docs/solutions/two.md')
    expect(digest).not.toContain(later)
  })
})

// ── Progress ────────────────────────────────────────────────────────────────

describe('sweep progress', () => {
  const LINE =
    'Sweep: covered 4 of 8 rules (current hashes); this run covered 4; about 1 run left in the sweep.'

  it('puts the progress in the digest header', () => {
    const world = buildWorld()
    const { published } = runCovering(world)
    const digest = fs.readFileSync(published.digestPath as string, 'utf8')
    const header = digest.slice(0, digest.indexOf('## Candidates'))
    expect(header).toContain(LINE)
  })

  it('puts the progress in the publish summary', () => {
    const world = buildWorld()
    const { published } = runCovering(world)
    expect(published.summary).toContain(LINE)
  })

  it('records the progress in the run record', () => {
    const world = buildWorld()
    const { published } = runCovering(world)
    const record = JSON.parse(
      fs.readFileSync(published.runRecordPath as string, 'utf8'),
    ) as Json
    expect(record.sweep).toEqual({
      total: 8,
      covered: 4,
      coveredThisRun: 4,
      runsLeft: 1,
    })
    expect((record.counts as Json).offered).toBe(4)
  })

  it('counts only the rules a degraded run covered', () => {
    const world = buildWorld()
    const { published, validated } = runCovering(world, (offered) =>
      offered.slice(0, 3),
    )
    expect(validated.sweep).toMatchObject({ covered: 3, coveredThisRun: 3 })
    expect(published.summary).toContain(
      'covered 3 of 8 rules (current hashes); this run covered 3; about 2 runs left',
    )
  })

  it('reports a finished sweep and what the next run does', () => {
    const world = buildWorld()
    runCovering(world)
    const { published } = runCovering(world)
    expect(published.summary).toContain('covered 8 of 8 rules (current hashes)')
    expect(published.summary).toContain('sweep is complete')
  })

  it('shows how many rules the ledger holds coverage for', () => {
    const world = buildWorld()
    runCovering(world)
    const shown = ok(runHelperOp('ledger-show', {}, world.deps))
    expect(shown.coverage).toEqual({
      rules: 4,
      namespaces: [{ selection: 'all', rules: 4 }],
    })
  })
})

// ── ledger clear ────────────────────────────────────────────────────────────

describe('ledger clear', () => {
  it('clears coverage with the ledger, so the sweep starts over', () => {
    const world = buildWorld()
    const first = runCovering(world)
    const second = runCovering(world)
    expect(second.run.offered).not.toEqual(first.run.offered)

    ok(runHelperOp('ledger-clear', {}, world.deps))
    expect(coveredIds(world)).toEqual([])
    const again = start(world)
    expect(again.offered).toEqual(first.run.offered)
    expect(again.body.sweep).toMatchObject({ covered: 0 })
  })
})

// ── Coverage per selection ──────────────────────────────────────────────────

interface LedgerCoverage {
  readonly ruleId: string
  readonly runId: string
  readonly selection?: string
}

function coverageRecords(world: World): LedgerCoverage[] {
  if (!fs.existsSync(path.join(world.stateRoot, 'ledger.json'))) return []
  return (ledgerFile(world).coverage ?? []) as LedgerCoverage[]
}

function idsIn(world: World, selection: string | undefined): string[] {
  return coverageRecords(world)
    .filter((item) => item.selection === selection)
    .map((item) => item.ruleId)
    .sort()
}

function selectionIdOf(run: Started): string {
  return (run.body.selection as Json).id as string
}

function abort(world: World, run: Started): void {
  ok(
    runHelperOp(
      'publish',
      { runId: run.runId, lock: run.lock, abort: true },
      world.deps,
    ),
  )
}

function beginSnapshot(run: Started): {
  coverageScope: { pruneUnattributed: boolean }
} {
  return JSON.parse(
    fs.readFileSync(path.join(run.workDir, 'begin.json'), 'utf8'),
  ) as { coverageScope: { pruneUnattributed: boolean } }
}

function alphaIds(world: World): string[] {
  return NAMES.map((name) =>
    ruleIdFor(world.alpha, `docs/solutions/${name}.md`),
  ).sort()
}

describe('coverage per selection', () => {
  it('does not count a rule a group run covered as covered for a run with no selection', () => {
    const world = buildWorld()
    const group = runCovering(world, undefined, ['group:solo'])
    expect(group.run.body.sweep).toEqual({
      total: 4,
      covered: 0,
      sliceSize: 4,
      runsLeft: 1,
    })
    expect(group.run.offered.slice().sort()).toEqual(alphaIds(world))

    const plain = runCovering(world)
    expect(plain.run.body.sweep).toEqual({
      total: 8,
      covered: 0,
      sliceSize: 4,
      runsLeft: 2,
    })
    expect(plain.run.offered).toContain(
      ruleIdFor(world.alpha, 'docs/solutions/one.md'),
    )
    expect(plain.published.summary).toContain(
      'Sweep: covered 4 of 8 rules (current hashes); this run covered 4; about 1 run left in the sweep.',
    )
  })

  it('keeps a group sweep of its own: the second run offers what the first did not, and the line counts the group', () => {
    const world = buildWorld()
    const first = runCovering(world, undefined, ['group:pair'])
    const second = runCovering(world, undefined, ['group:pair'])

    expect(
      second.run.offered.some((id) => first.run.offered.includes(id)),
    ).toBe(false)
    expect(second.run.body.sweep).toMatchObject({ total: 8, covered: 4 })
    expect(second.published.summary).toContain(
      'Sweep: covered 8 of 8 rules (current hashes); this run covered 4; the sweep is complete',
    )
  })

  it('counts only the rules of the group in its sweep line', () => {
    const world = buildWorld()
    const first = runCovering(world, undefined, ['group:solo'])
    expect(first.published.summary).toContain(
      'Sweep: covered 4 of 4 rules (current hashes); this run covered 4; the sweep is complete',
    )
    const next = start(world, ['group:solo'])
    expect(next.body.sweep).toMatchObject({ total: 4, covered: 4, runsLeft: 0 })
    abort(world, next)
  })

  it('shares one sweep between groups and picks with the same members, and starts fresh when a member is added', () => {
    const world = buildWorld()
    const first = runCovering(world, undefined, ['group:solo'])

    const sameMembers = start(world, ['group:solo-again'])
    expect(sameMembers.body.sweep).toMatchObject({ total: 4, covered: 4 })
    expect(selectionIdOf(sameMembers)).toBe(selectionIdOf(first.run))
    abort(world, sameMembers)

    const picked = start(world, ['projects:alpha'])
    expect(picked.body.sweep).toMatchObject({ total: 4, covered: 4 })
    abort(world, picked)

    writeConfig(world, { solo: [world.alpha, world.beta] })
    const grown = start(world, ['group:solo'])
    expect(grown.body.sweep).toMatchObject({ total: 8, covered: 0 })
    abort(world, grown)
  })

  it('gives a group of the whole allow list a namespace of its own, and never prunes for it', () => {
    const world = buildWorld()
    const group = runCovering(world, undefined, ['group:pair'])
    const id = selectionIdOf(group.run)
    expect(coverageRecords(world).every((item) => item.selection === id)).toBe(
      true,
    )
    expect(coverageRecords(world)).toHaveLength(4)

    const grouped = start(world, ['group:pair'])
    expect(beginSnapshot(grouped).coverageScope.pruneUnattributed).toBe(false)
    abort(world, grouped)
    const plain = start(world)
    expect(plain.body.sweep).toMatchObject({ total: 8, covered: 0 })
    expect(beginSnapshot(plain).coverageScope.pruneUnattributed).toBe(true)
    abort(world, plain)
  })

  it('keeps the coverage of projects a group run did not select, and a later run with no selection prunes only what it reads', () => {
    const world = buildWorld()
    runCovering(world)
    const kept = idsIn(world, undefined)
    expect(kept).toHaveLength(4)
    const betaKept = kept.filter((id) => !alphaIds(world).includes(id))
    expect(betaKept).toHaveLength(2)

    const group = runCovering(world, undefined, ['group:solo'])
    expect(idsIn(world, undefined)).toEqual(kept)
    expect(idsIn(world, selectionIdOf(group.run))).toEqual(alphaIds(world))

    const gone = ruleIdFor(world.beta, 'docs/solutions/one.md')
    expect(kept).toContain(gone)
    git(world.beta, ['rm', '-q', 'docs/solutions/one.md'])
    commit(world.beta, 'remove')
    runCovering(world)

    expect(idsIn(world, undefined)).not.toContain(gone)
    expect(idsIn(world, selectionIdOf(group.run))).toEqual(alphaIds(world))
  })

  it('migrates a version 1 ledger on the first write and honours the coverage it holds', () => {
    const world = buildWorld()
    const first = runCovering(world)
    const file = path.join(world.stateRoot, 'ledger.json')
    const written = ledgerFile(world)
    expect(written.version).toBe(2)
    fs.writeFileSync(file, JSON.stringify({ ...written, version: 1 }))

    const second = runCovering(world)

    expect(
      second.run.offered.some((id) => first.run.offered.includes(id)),
    ).toBe(false)
    expect(second.run.body.sweep).toMatchObject({ covered: 4 })
    expect(ledgerFile(world).version).toBe(2)
    expect(coverageRecords(world)).toHaveLength(8)
  })

  it('refuses a ledger of an unknown version and leaves it as it was', () => {
    const world = buildWorld()
    runCovering(world)
    const file = path.join(world.stateRoot, 'ledger.json')
    const text = JSON.stringify({ ...ledgerFile(world), version: 3 })
    fs.writeFileSync(file, text)

    const result = runHelperOp(
      'begin',
      { host: 'opencode-v2', version: '9999.0.0', mode: 'headless' },
      world.deps,
    )

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result.body)).toContain('ledger-unreadable')
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
    expect(fs.existsSync(path.join(world.stateRoot, 'lock'))).toBe(false)
  })

  it('lists the coverage of every selection in ledger show, and ledger clear removes all of it', () => {
    const world = buildWorld()
    const group = runCovering(world, undefined, ['group:solo'])
    runCovering(world)
    runCovering(world, undefined, ['projects:beta'])

    const shown = ok(runHelperOp('ledger-show', {}, world.deps))
    const coverage = shown.coverage as {
      rules: number
      namespaces: Array<Json>
    }
    expect(coverage.rules).toBe(12)
    expect(coverage.namespaces).toHaveLength(3)
    expect(coverage.namespaces[0]).toEqual({ selection: 'all', rules: 4 })
    const byId = new Map(
      coverage.namespaces.map((item) => [item.selection, item]),
    )
    expect(byId.get(selectionIdOf(group.run))).toEqual({
      selection: selectionIdOf(group.run),
      rules: 4,
      label: 'group:solo',
    })
    const picked = coverage.namespaces.find(
      (item) => item.label === 'projects:beta',
    )
    expect(picked).toMatchObject({ rules: 4 })

    ok(runHelperOp('ledger-clear', {}, world.deps))
    expect(coverageRecords(world)).toEqual([])
    const again = start(world, ['group:solo'])
    expect(again.body.sweep).toMatchObject({ covered: 0 })
    abort(world, again)
  })
})
