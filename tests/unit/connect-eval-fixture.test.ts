/**
 * Fixture tests for the pre-registered `ce:connect` evaluation.
 *
 * The evaluation itself runs by hand against checkouts and model runs that stay
 * outside the repository. What lives in the repository, and what these tests pin,
 * is the part that must not drift once it is registered: the label file's shape,
 * the numeric thresholds, the synthetic corpora, the frozen skill, helper and
 * agent files, and the absence of private corpus text from every committed file.
 *
 * They do not show that the evaluation passes. They show the registration is
 * well formed and that nothing private was committed with it.
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractRule } from '../../src/lib/connect-helper-core.js'
import {
  BUILTIN_LEAK_PATTERNS,
  FROZEN_PATHS,
  findLeaks,
  frozenDigest,
  type Json,
  readPrivateTerms,
  validateLabels,
} from '../helpers/connect-eval-fixture.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const MANUAL_DIR = path.join(ROOT, 'tests/manual/connect-eval')
const FIXTURE_DIR = path.join(ROOT, 'tests/fixtures/connect-eval')
const SYNTHETIC_DIR = path.join(FIXTURE_DIR, 'synthetic')
const LABELS_FILE = path.join(FIXTURE_DIR, 'labels.json')
const MANIFEST_FILE = path.join(SYNTHETIC_DIR, 'manifest.json')
const PRE_REGISTRATION = path.join(MANUAL_DIR, 'PRE-REGISTRATION.md')
const README = path.join(MANUAL_DIR, 'README.md')

/** The numbers the registration must carry: precision floor, runs, repetitions, regression recall. */
const REGISTERED = {
  precisionMin: 0.7,
  seededFoundRuns: 3,
  repetitions: 3,
  regressionRecall: { found: 4, of: 4 },
} as const

function readJson(file: string): Json {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Json
}

function clone<T extends Json>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out.sort()
}

function committedEvalFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const dir of [MANUAL_DIR, FIXTURE_DIR]) {
    for (const file of listFiles(dir)) {
      files[path.relative(ROOT, file)] = fs.readFileSync(file, 'utf8')
    }
  }
  return files
}

const labels = readJson(LABELS_FILE)

describe('label file', () => {
  test('the committed file is well formed', () => {
    expect(validateLabels(labels)).toEqual([])
  })

  test('carries exactly the registered thresholds', () => {
    expect((labels as { thresholds?: unknown }).thresholds as unknown).toEqual(
      REGISTERED,
    )
  })

  test('a non-opaque id fails', () => {
    const bad = clone(labels) as { regression: { id: string }[] }
    bad.regression[0] = { ...bad.regression[0], id: 'release-notes-guardrail' }
    const problems = validateLabels(bad as unknown as Json)
    expect(problems.some((p) => p.includes('release-notes-guardrail'))).toBe(
      true,
    )
  })

  test('an id with the wrong group prefix fails', () => {
    const bad = clone(labels) as { seeded: { id: string }[] }
    bad.seeded[0] = { ...bad.seeded[0], id: 'r-09' }
    expect(validateLabels(bad as unknown as Json).length).toBeGreaterThan(0)
  })

  test('a duplicate id fails', () => {
    const bad = clone(labels) as { controls: { id: string }[] }
    bad.controls[1] = { ...bad.controls[1], id: bad.controls[0]?.id ?? 'c-01' }
    expect(
      validateLabels(bad as unknown as Json).some((p) =>
        p.includes('duplicate'),
      ),
    ).toBe(true)
  })

  test('a missing label fails', () => {
    const bad = clone(labels) as { regression: Record<string, unknown>[] }
    const { label: _dropped, ...withoutLabel } = bad.regression[2] ?? {}
    bad.regression[2] = withoutLabel
    const problems = validateLabels(bad as unknown as Json)
    expect(problems.some((p) => p.includes('label'))).toBe(true)
  })

  test('an unknown label value fails', () => {
    const bad = clone(labels) as { seeded: Record<string, unknown>[] }
    bad.seeded[0] = { ...bad.seeded[0], label: 'probably-fine' }
    expect(validateLabels(bad as unknown as Json).length).toBeGreaterThan(0)
  })

  test.each([
    ['precisionMin', 0.5],
    ['seededFoundRuns', 2],
    ['repetitions', 1],
    ['regressionRecall', { found: 3, of: 4 }],
  ])('a changed %s threshold fails', (field, value) => {
    const bad = clone(labels) as { thresholds: Record<string, unknown> }
    bad.thresholds[field] = value
    const problems = validateLabels(bad as unknown as Json)
    expect(problems.some((p) => p.includes(field))).toBe(true)
  })

  test('a missing threshold fails', () => {
    const bad = clone(labels) as { thresholds: Record<string, unknown> }
    delete bad.thresholds.precisionMin
    expect(
      validateLabels(bad as unknown as Json).some((p) =>
        p.includes('precisionMin'),
      ),
    ).toBe(true)
  })

  test('fresh-set labels cannot be filled in while the set is awaiting its labeler', () => {
    const bad = clone(labels) as {
      fresh: { status: string; labels: Record<string, unknown>[] }
    }
    bad.fresh.status = 'awaiting-labeler'
    bad.fresh.labels = [{ id: 'f-01', label: 'worth-promoting' }]
    expect(validateLabels(bad as unknown as Json).length).toBeGreaterThan(0)
  })

  test('a labeled fresh set accepts judged labels and rejects a false one', () => {
    const good = clone(labels) as {
      fresh: { status: string; labels: Record<string, unknown>[] }
    }
    good.fresh.status = 'labeled'
    good.fresh.labels = [
      { id: 'f-01', label: 'worth-promoting' },
      { id: 'f-02', label: 'real-not-worth' },
    ]
    expect(validateLabels(good as unknown as Json)).toEqual([])

    good.fresh.labels = [{ id: 'f-01', label: 'false' }]
    expect(validateLabels(good as unknown as Json).length).toBeGreaterThan(0)
  })
})

interface ManifestEntry {
  readonly id: string
  readonly docs: readonly string[]
}

interface Manifest {
  readonly schemaVersion: number
  readonly root: string
  readonly seeds: readonly ManifestEntry[]
  readonly controls: readonly ManifestEntry[]
}

describe('synthetic corpora', () => {
  const manifest = readJson(MANIFEST_FILE) as unknown as Manifest
  const entries = [...manifest.seeds, ...manifest.controls]

  test('seed and control ids are the ones the label file names', () => {
    const labelled = labels as unknown as {
      seeded: { id: string }[]
      controls: { id: string }[]
    }
    expect(manifest.seeds.map((e) => e.id)).toEqual(
      labelled.seeded.map((e) => e.id),
    )
    expect(manifest.controls.map((e) => e.id)).toEqual(
      labelled.controls.map((e) => e.id),
    )
  })

  test('there are two or three seeded contradictions and at least as many controls', () => {
    expect(manifest.seeds.length).toBeGreaterThanOrEqual(2)
    expect(manifest.seeds.length).toBeLessThanOrEqual(3)
    expect(manifest.controls.length).toBeGreaterThanOrEqual(
      manifest.seeds.length,
    )
  })

  test('each entry is a pair of two distinct documents that exist', () => {
    for (const entry of entries) {
      expect(entry.docs).toHaveLength(2)
      expect(new Set(entry.docs).size).toBe(2)
      for (const doc of entry.docs) {
        const file = path.join(SYNTHETIC_DIR, manifest.root, doc)
        expect(fs.existsSync(file)).toBe(true)
      }
    }
  })

  test('every document under the corpus root is listed exactly once', () => {
    const listed = entries.flatMap((entry) => entry.docs).sort()
    const onDisk = listFiles(path.join(SYNTHETIC_DIR, manifest.root))
      .map((file) =>
        path.relative(path.join(SYNTHETIC_DIR, manifest.root), file),
      )
      .sort()
    expect(listed).toEqual(onDisk)
  })

  test('every document gives the helper a full rule: applies_when, Guidance and Prevention', () => {
    for (const entry of entries) {
      for (const doc of entry.docs) {
        const text = fs.readFileSync(
          path.join(SYNTHETIC_DIR, manifest.root, doc),
          'utf8',
        )
        const rule = extractRule(text, {
          project: '/synthetic',
          path: `${manifest.root}/${doc}`,
          sha256: '0'.repeat(64),
        })
        expect({
          doc,
          missing: rule.missing,
          parseError: rule.parseError,
        }).toEqual({
          doc,
          missing: [],
          parseError: false,
        })
        expect(rule.title).toBeDefined()
      }
    }
  })

  test('a document names no other document of its pair by path', () => {
    for (const entry of entries) {
      const [first, second] = entry.docs
      for (const [own, other] of [
        [first, second],
        [second, first],
      ] as const) {
        const text = fs.readFileSync(
          path.join(SYNTHETIC_DIR, manifest.root, own ?? ''),
          'utf8',
        )
        expect(text.includes(path.basename(other ?? ''))).toBe(false)
      }
    }
  })
})

describe('pre-registration', () => {
  const text = fs.readFileSync(PRE_REGISTRATION, 'utf8')

  test.each([
    '## Status',
    '## Claim',
    '## Frozen design',
    '## Main sweep and seed check',
    '## Sweeps',
    '## Cost and time',
    '## Corpora and labeling',
    '## Thresholds',
    '## Repetitions and equivalence',
    '## Precision denominator',
    '## Stop rule',
    '## Regression check',
    '## Deviations',
    '## Real-use window',
  ])('has the %s section', (heading) => {
    expect(text.split('\n')).toContain(heading)
  })

  test('states the registered thresholds in words', () => {
    expect(text).toContain('0.7')
    expect(text).toContain('3 of 3')
    expect(text).toContain('4 of 4')
    expect(text).toContain('3 repetitions')
  })

  test('registers each repetition as one full sweep with a run cap', () => {
    expect(text).toContain('one full sweep')
    expect(text).toContain('the expected run count plus 2')
    expect(text).toContain('a fresh state directory')
    expect(text).toContain('any run of that sweep')
  })

  test('registers a main sweep for precision and a separate seed check for the seeds', () => {
    expect(text).toContain('one main sweep')
    expect(text).toContain('a seed check of 3 repetitions')
    expect(text).toContain('the seeded scratch copy of the fresh project alone')
    expect(text).toContain(
      'Every seeded contradiction must be found in 3 of 3 seed-check repetitions',
    )
  })

  test('says controls must not be reported and that a reported control is in the denominator', () => {
    expect(text).toContain(
      'No same-subject control may be reported in any seed-check repetition',
    )
    expect(text).toContain(
      'A reported control counts in the precision denominator, from the main sweep and from the seed check',
    )
  })

  test('states plainly why precision rests on one sweep', () => {
    expect(text).toContain('Precision rests on one full sweep')
    expect(text).toMatch(/because (?:a|each) full sweep costs/)
  })

  test('puts regression and fresh recall on the main sweep and keeps a miss from stopping the eval', () => {
    expect(text).toContain('comes from the main sweep')
    expect(text).toContain('does not stop the evaluation')
  })

  test('puts no probe corpus in the seed check', () => {
    expect(text).not.toContain('fewest learnings')
    expect(text).not.toContain('smaller corpus')
    expect(text).not.toContain('seed-check corpus')
    expect(text).toContain('one slice of 48')
  })

  test('sizes the seed check as about one run per repetition and the whole at about 5.5 hours', () => {
    expect(text).toContain('about 11 runs')
    expect(text).toContain('5.5 hours')
    expect(text).not.toMatch(/(?<![\d.])8\.5 hours/)
  })

  test('logs the transport fix made before the first model call, with the old and new kit digests', () => {
    const deviations = text.slice(
      text.indexOf('## Deviations'),
      text.indexOf('## Real-use window'),
    )
    expect(deviations).toContain('before the first model call')
    const registered = /^Scratch kit digest: sha256:([0-9a-f]{64})$/m.exec(
      text,
    )?.[1]
    const logged = [...deviations.matchAll(/sha256:([0-9a-f]{64})/g)].map(
      (m) => m[1],
    )
    expect(logged.length).toBeGreaterThanOrEqual(2)
    expect(logged[0]).toBe(registered)
    expect(new Set(logged).size).toBe(logged.length)
  })

  test('records a full revision and says what degraded means after rotation', () => {
    expect(
      /^- Revision the registration was prepared on: `[0-9a-f]{40}`/m.test(
        text,
      ),
    ).toBe(true)
    expect(text).toContain('does not mean the corpus was unread')
    expect(text).not.toContain('expected to end `degraded`')
  })

  test('names the frozen models and the host version', () => {
    expect(text).toContain('claude-sonnet-5-5')
    expect(text).toContain('gpt-5.6-luna')
    const pins = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, 'scripts/opencode-host-pins.json'),
        'utf8',
      ),
    ) as { v1: string }
    expect(text).toContain(`OpenCode v1 ${pins.v1}`)
  })

  test('names the fresh project only as one chosen by Marcus', () => {
    expect(text).toContain('a fresh project chosen by Marcus')
  })

  test('the frozen digest matches the skill, helper and agent files', () => {
    const match = /^Frozen files digest: sha256:([0-9a-f]{64})$/m.exec(text)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBe(frozenDigest(ROOT, FROZEN_PATHS))
  })

  test('the run-record template carries the fields every real run records', () => {
    for (const field of [
      'Date:',
      'Allowed projects (opaque):',
      'Outcome:',
      'Candidates proposed:',
      'Candidates promoted:',
      'Worth the time:',
    ]) {
      expect(text).toContain(field)
    }
  })

  test('states the five-run stop rule', () => {
    expect(text).toContain('first 5 real runs')
    expect(text).toContain('reconsidered, not tuned further')
  })

  test('the readme exists', () => {
    expect(fs.existsSync(README)).toBe(true)
  })
})

describe('frozen digest', () => {
  test('changes when any frozen file changes', () => {
    const base = frozenDigest(ROOT, FROZEN_PATHS)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-eval-'))
    try {
      for (const rel of FROZEN_PATHS) {
        const target = path.join(dir, rel)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(path.join(ROOT, rel), target)
      }
      expect(frozenDigest(dir, FROZEN_PATHS)).toBe(base)
      const first = path.join(dir, FROZEN_PATHS[0] ?? '')
      fs.appendFileSync(first, '\n')
      expect(frozenDigest(dir, FROZEN_PATHS)).not.toBe(base)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('does not depend on the order paths are listed in', () => {
    expect(frozenDigest(ROOT, [...FROZEN_PATHS].reverse())).toBe(
      frozenDigest(ROOT, FROZEN_PATHS),
    )
  })
})

describe('leak check', () => {
  test('a planted private corpus string fails', () => {
    const hits = findLeaks(
      { 'tests/fixtures/connect-eval/labels.json': 'see PLANTED-PRIVATE-SLUG' },
      ['PLANTED-PRIVATE-SLUG'],
    )
    expect(hits).toEqual([
      'tests/fixtures/connect-eval/labels.json: PLANTED-PRIVATE-SLUG',
    ])
  })

  test('a clean file passes', () => {
    expect(findLeaks({ 'a.md': 'nothing private here' }, ['PLANTED'])).toEqual(
      [],
    )
  })

  test('the built-in patterns catch a home path and a scratch path', () => {
    const hits = findLeaks(
      {
        'a.md': 'checkout at /Users/someone/src/project',
        'b.md': 'kept in .cache/systematic-scratch/anything',
      },
      [],
    )
    expect(hits).toHaveLength(2)
    expect(BUILTIN_LEAK_PATTERNS.length).toBeGreaterThanOrEqual(2)
  })

  test('an empty private term never matches everything', () => {
    expect(findLeaks({ 'a.md': 'text' }, [''])).toEqual([])
  })

  test('private terms are read one per line and blank lines are ignored', () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'connect-eval-')),
      'terms.txt',
    )
    try {
      fs.writeFileSync(file, 'alpha\n\n  beta  \n')
      expect(readPrivateTerms(file)).toEqual(['alpha', 'beta'])
      expect(readPrivateTerms(undefined)).toEqual([])
      expect(readPrivateTerms(`${file}.missing`)).toEqual([])
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  test('no committed evaluation file carries a private string, a home path or a scratch path', () => {
    const terms = readPrivateTerms(process.env.CONNECT_EVAL_PRIVATE_TERMS_FILE)
    expect(findLeaks(committedEvalFiles(), terms)).toEqual([])
  })

  test('the test and its helper carry no private term either', () => {
    const terms = readPrivateTerms(process.env.CONNECT_EVAL_PRIVATE_TERMS_FILE)
    const own = [
      'tests/unit/connect-eval-fixture.test.ts',
      'tests/helpers/connect-eval-fixture.ts',
    ]
    const files = Object.fromEntries(
      own.map((rel) => [rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')]),
    )
    expect(findLeaks(files, terms, { builtin: false })).toEqual([])
  })

  test('no committed evaluation file names an internal plan id', () => {
    const idPattern = /\b(?:KTD|AE|R|U)\d{1,2}\b/
    const offenders = Object.entries(committedEvalFiles())
      .filter(([, content]) => idPattern.test(content))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })
})
