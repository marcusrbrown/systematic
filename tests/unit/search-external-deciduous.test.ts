import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { runSearch } from '../../src/lib/search-core.js'
import { MAX_DISCOVERED_FILES, MAX_FILES } from '../../src/lib/search-corpus.js'
import {
  EXTERNAL_MAX_FILE_BYTES,
  loadExternalSources,
  type SourceLoad,
} from '../../src/lib/search-external.js'
import type { ActiveSource } from '../../src/lib/search-external-sources.js'
import {
  type ExternalEnv,
  makeExternalEnv,
  writeProjectSearch,
  writeUserSearch,
} from '../helpers/search-external-env.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const temp = createTempDirTracker()
afterEach(() => temp.cleanup())

const FIXTURE = path.resolve(
  import.meta.dirname,
  '../fixtures/search-external/deciduous',
)

function makeEnv(): ExternalEnv {
  return makeExternalEnv(temp)
}

function source(
  roots: readonly string[],
  overrides: Partial<ActiveSource> = {},
): ActiveSource {
  return {
    name: 'graph',
    format: 'deciduous',
    roots,
    origin: 'user',
    ...overrides,
  }
}

function load(
  env: ExternalEnv,
  active: ActiveSource,
  budgetBytes?: number,
): SourceLoad {
  const [only] = loadExternalSources({
    sources: [active],
    checkoutRoot: env.repo,
    budgetBytes,
  })
  if (only === undefined) throw new Error('no source load returned')
  return only
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function node(
  root: string,
  id: string,
  fields: Record<string, unknown> = {},
): void {
  write(
    root,
    `nodes/${id}.json`,
    JSON.stringify({ change_id: id, node_type: 'decision', ...fields }),
  )
}

function edge(
  root: string,
  id: string,
  from: string,
  to: string,
  rationale: string,
  fields: Record<string, unknown> = {},
): void {
  write(
    root,
    `edges/${id}.json`,
    JSON.stringify({
      edge_id: id,
      from_change_id: from,
      to_change_id: to,
      rationale,
      ...fields,
    }),
  )
}

function byPath(result: SourceLoad, relative: string) {
  const found = result.records.find(
    (candidate) => candidate.path === `${result.name}/${relative}`,
  )
  if (found === undefined) throw new Error(`no record ${relative}`)
  return found
}

describe('Deciduous loader: records', () => {
  test('keeps decision, option, outcome and goal nodes and never indexes action or observation nodes', () => {
    const env = makeEnv()
    const result = load(env, source([FIXTURE]))

    expect(result.state).toBe('loaded')
    expect(result.records.map((r) => r.path)).toEqual([
      'graph/nodes/dec-bare.json',
      'graph/nodes/dec-cache.json',
      'graph/nodes/dec-nodesc.json',
      'graph/nodes/goal-speed.json',
      'graph/nodes/opt-redis.json',
      'graph/nodes/out-latency.json',
    ])
    expect(result.records.map((r) => r.nodeType)).toEqual([
      'decision',
      'decision',
      'decision',
      'goal',
      'option',
      'outcome',
    ])
    const text = result.records.map((r) => `${r.title}\n${r.body}`).join('\n')
    expect(text).not.toContain('zebra')
    expect(text).not.toContain('aardvark')
  })

  test('a record carries its source, origin and node_type, and no status', () => {
    const env = makeEnv()
    const result = load(env, source([FIXTURE], { origin: 'user' }))
    const decision = byPath(result, 'nodes/dec-cache.json')

    expect(decision.source).toBe('graph')
    expect(decision.origin).toBe('user')
    expect(decision.nodeType).toBe('decision')
    expect(decision.status).toBeUndefined()
  })

  test('a decision is searchable and its hit shows the node_type, not pending', async () => {
    const env = makeEnv()
    writeUserSearch(env, {
      sources: [
        {
          name: 'graph',
          format: 'deciduous',
          roots: [FIXTURE],
          projects: [env.repo],
        },
      ],
    })
    const run = (query: string) =>
      runSearch(
        { query, kind: 'external' },
        { startDir: env.repo, configOptions: env.configOptions },
      )

    const decision = await run('write-through cache')
    expect(decision.ok).toBe(true)
    expect(decision.text).toContain('graph/nodes/dec-cache.json')
    expect(decision.text).toContain('node_type decision')
    expect(decision.text).not.toContain('pending')
    expect(decision.text).not.toContain('Status:')

    const action = await run('zebra')
    expect(action.text).not.toContain('graph/nodes/act-deploy.json')
    expect(action.text).not.toContain('graph/nodes/obs-note.json')
  })

  test('title falls back from title to the first description line to change_id', () => {
    const env = makeEnv()
    const result = load(env, source([FIXTURE]))

    expect(byPath(result, 'nodes/dec-cache.json').title).toBe(
      'Use a write-through cache',
    )
    expect(byPath(result, 'nodes/dec-nodesc.json').title).toBe(
      'Adopt the lemur retry policy',
    )
    expect(byPath(result, 'nodes/dec-bare.json').title).toBe('dec-bare')
  })

  test('a blank or non-string title falls through', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    node(root, 'blank', { title: '   ', description: 'Real first line' })
    node(root, 'numeric', { title: 42 })
    const result = load(env, source([root]))

    expect(byPath(result, 'nodes/blank.json').title).toBe('Real first line')
    expect(byPath(result, 'nodes/numeric.json').title).toBe('numeric')
  })
})

describe('Deciduous loader: rationale', () => {
  test('an incoming edge and an outgoing edge both put their rationale in the node body', () => {
    const env = makeEnv()
    const result = load(env, source([FIXTURE]))

    expect(byPath(result, 'nodes/dec-cache.json').body).toContain(
      'quokka throughput',
    )
    expect(byPath(result, 'nodes/dec-nodesc.json').body).toContain(
      'wombat constraint',
    )
  })

  test('edges are never records, and their rationale is searchable through the node', async () => {
    const env = makeEnv()
    writeUserSearch(env, {
      sources: [
        {
          name: 'graph',
          format: 'deciduous',
          roots: [FIXTURE],
          projects: [env.repo],
        },
      ],
    })
    const run = (query: string) =>
      runSearch(
        { query, kind: 'external' },
        { startDir: env.repo, configOptions: env.configOptions },
      )

    const incoming = await run('quokka')
    expect(incoming.text).toContain('graph/nodes/dec-cache.json')
    const outgoing = await run('wombat')
    expect(outgoing.text).toContain('graph/nodes/dec-nodesc.json')
    expect(incoming.text).not.toContain('edges/')
    const result = load(env, source([FIXTURE]))
    expect(result.records.some((r) => r.path.includes('/edges/'))).toBe(false)
  })

  test('the rationale text reaches the other endpoint only when that endpoint is a live node', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    node(root, 'a')
    node(root, 'b', { node_type: 'action' })
    node(root, 'gone', { deleted_at: '2026-01-01T00:00:00Z' })
    edge(root, 'live', 'a', 'b', 'with a live action')
    edge(root, 'dead', 'a', 'gone', 'with a tombstone')
    edge(root, 'missing', 'a', 'never-written', 'with an unknown node')
    const result = load(env, source([root]))

    const body = byPath(result, 'nodes/a.json').body
    expect(body).toContain('with a live action')
    expect(body).not.toContain('with a tombstone')
    expect(body).not.toContain('with an unknown node')
  })

  test('a node with deleted_at is skipped and an edge to or from it contributes nothing', () => {
    const env = makeEnv()
    const result = load(env, source([FIXTURE]))

    expect(result.records.some((r) => r.path.endsWith('dec-gone.json'))).toBe(
      false,
    )
    expect(byPath(result, 'nodes/dec-cache.json').body).not.toContain('narwhal')
  })

  test('an edge with deleted_at contributes nothing', () => {
    const env = makeEnv()
    const result = load(env, source([FIXTURE]))

    expect(byPath(result, 'nodes/dec-cache.json').body).not.toContain(
      'pangolin',
    )
  })

  test('a self edge contributes once and an edge with no rationale contributes nothing', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    node(root, 'a')
    edge(root, 'self', 'a', 'a', 'self-referencing')
    edge(root, 'blank', 'a', 'a', '   ')
    const result = load(env, source([root]))

    const body = byPath(result, 'nodes/a.json').body
    expect(body.match(/self-referencing/g)).toHaveLength(1)
  })

  test('rationale caps hold: 300 characters per edge, 20 edges per node, 2 KB per node', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    node(root, 'hub')
    node(root, 'peer', { node_type: 'action' })
    edge(root, 'long', 'hub', 'peer', `L${'x'.repeat(999)}`)
    const longResult = load(env, source([root]))
    const longBody = byPath(longResult, 'nodes/hub.json').body
    expect(longBody).toContain(`L${'x'.repeat(299)}`)
    expect(longBody).not.toContain(`L${'x'.repeat(300)}`)

    // 20 edges per node: edge 21 onwards is ignored.
    const many = path.join(env.root, 'many')
    node(many, 'hub')
    node(many, 'peer', { node_type: 'action' })
    for (let index = 0; index < 25; index++) {
      const id = `e${String(index).padStart(2, '0')}`
      edge(many, id, 'hub', 'peer', `rationale-${id}`)
    }
    const manyBody = byPath(load(env, source([many])), 'nodes/hub.json').body
    expect(manyBody.match(/rationale-e\d\d/g)).toHaveLength(20)
    expect(manyBody).toContain('rationale-e19')
    expect(manyBody).not.toContain('rationale-e20')

    // 2 KB per node: 20 edges of 300 characters would be 6000.
    const wide = path.join(env.root, 'wide')
    node(wide, 'hub')
    node(wide, 'peer', { node_type: 'action' })
    for (let index = 0; index < 20; index++) {
      const id = `e${String(index).padStart(2, '0')}`
      edge(wide, id, 'hub', 'peer', 'y'.repeat(300))
    }
    const wideBody = byPath(load(env, source([wide])), 'nodes/hub.json').body
    const yCount = wideBody.match(/y/g)?.length ?? 0
    expect(yCount).toBe(2048)
  })

  test('the description comes first and is kept whole', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    const description = `${'d'.repeat(5000)}-end`
    node(root, 'a', { description })
    node(root, 'b', { node_type: 'action' })
    edge(root, 'e', 'a', 'b', 'because')
    const body = byPath(load(env, source([root])), 'nodes/a.json').body

    expect(body.startsWith(description)).toBe(true)
    expect(body).toContain('because')
  })
})

describe('Deciduous loader: scale', () => {
  test('2,146 node files and 664 edge files load every decision-shaped node', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'big')
    const kept: string[] = []
    // Three of every four nodes are decision-shaped: 1,609 of 2,146.
    const types = ['decision', 'action', 'option', 'observation', 'outcome']
    const shaped = new Set(['decision', 'option', 'outcome', 'goal'])
    for (let index = 0; index < 2146; index++) {
      const id = `n${String(index).padStart(5, '0')}`
      const nodeType = types[index % types.length] ?? 'action'
      node(root, id, {
        node_type: nodeType,
        title: `Node ${index} widget`,
        description: `Body ${index}`,
      })
      if (shaped.has(nodeType)) kept.push(`graph/nodes/${id}.json`)
    }
    for (let index = 0; index < 664; index++) {
      const from = `n${String(index * 3).padStart(5, '0')}`
      const to = `n${String(index * 3 + 1).padStart(5, '0')}`
      edge(root, `e${String(index).padStart(4, '0')}`, from, to, 'linked')
    }

    const result = load(env, source([root]))

    expect(kept.length).toBeGreaterThan(1050)
    expect(result.state).toBe('loaded')
    expect(result.records.map((r) => r.path)).toEqual(kept)
    expect(result.warnings.join('\n')).not.toContain('limit')
  })

  test('filtered nodes and edge files do not consume the record cap', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    // 2,500 non-decision nodes first in name order, then 5 decisions.
    for (let index = 0; index < MAX_FILES + 500; index++) {
      node(root, `a${String(index).padStart(5, '0')}`, { node_type: 'action' })
    }
    for (let index = 0; index < 5; index++) node(root, `z${index}`)
    const result = load(env, source([root]))

    expect(result.records.map((r) => r.path)).toEqual(
      [0, 1, 2, 3, 4].map((index) => `graph/nodes/z${index}.json`),
    )
  })

  test('MAX_FILES bounds the kept records and the cut is named', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    for (let index = 0; index < MAX_FILES + 3; index++) {
      node(root, `d${String(index).padStart(5, '0')}`)
    }
    const result = load(env, source([root]))

    expect(result.records).toHaveLength(MAX_FILES)
    expect(result.records[0]?.path).toBe('graph/nodes/d00000.json')
    expect(result.warnings.join('\n')).toContain(
      `graph: record limit of ${MAX_FILES} reached; skipped 3 records`,
    )
  })

  test('MAX_DISCOVERED_FILES bounds the files scanned, nodes first, and the cut is named', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    fs.mkdirSync(path.join(root, 'nodes'), { recursive: true })
    fs.mkdirSync(path.join(root, 'edges'), { recursive: true })
    // Empty files keep the fixture cheap; they are malformed and skipped.
    for (let index = 0; index < MAX_DISCOVERED_FILES - 1; index++) {
      fs.writeFileSync(
        path.join(root, 'nodes', `n${String(index).padStart(5, '0')}.json`),
        '{}',
      )
    }
    node(root, 'zz-last-node')
    for (let index = 0; index < 5; index++) {
      fs.writeFileSync(path.join(root, 'edges', `e${index}.json`), '{}')
    }
    const result = load(env, source([root]))

    // 8,000 node files fill the scan, so the edge folder is cut off entirely.
    expect(result.records.map((r) => r.path)).toEqual([
      'graph/nodes/zz-last-node.json',
    ])
    expect(result.warnings.join('\n')).toContain(
      `graph: scan limit of ${MAX_DISCOVERED_FILES} files reached`,
    )
  })
})

describe('Deciduous loader: order and determinism', () => {
  test('node files are opened before edge files, in code-unit order, with no path sort across folders', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    node(root, 'b-node')
    node(root, 'a-node')
    node(root, 'B-upper')
    edge(root, 'a-edge', 'a-node', 'b-node', 'r1')
    edge(root, 'Z-edge', 'a-node', 'B-upper', 'r2')

    const spy = spyOn(fs, 'readFileSync')
    try {
      load(env, source([root]))
      const opened = spy.mock.calls
        .map((call) => String(call[0]))
        .filter((file) => file.startsWith(fs.realpathSync(root)))
        .map((file) => path.relative(fs.realpathSync(root), file))
      expect(opened).toEqual([
        'nodes/B-upper.json',
        'nodes/a-node.json',
        'nodes/b-node.json',
        'edges/Z-edge.json',
        'edges/a-edge.json',
      ])
    } finally {
      spy.mockRestore()
    }
  })

  test('repeated loads are identical', () => {
    const env = makeEnv()
    const first = load(env, source([FIXTURE]))
    const second = load(env, source([FIXTURE]))

    expect(second).toEqual(first)
  })
})

describe('Deciduous loader: states and skips', () => {
  test('a missing root is missing', () => {
    const env = makeEnv()
    const result = load(env, source([path.join(env.root, 'nowhere')]))

    expect(result.state).toBe('missing')
    expect(result.records).toEqual([])
  })

  test('a root with no nodes/ is empty with a warning', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    fs.mkdirSync(path.join(root, 'edges'), { recursive: true })
    const result = load(env, source([root]))

    expect(result.state).toBe('empty')
    expect(result.warnings.join('\n')).toContain('graph: no nodes/ folder')
  })

  test('no edges/ yields records without rationale and a warning', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    node(root, 'a', { title: 'Alone' })
    const result = load(env, source([root]))

    expect(result.state).toBe('loaded')
    expect(result.records).toHaveLength(1)
    expect(result.warnings.join('\n')).toContain('graph: no edges/ folder')
  })

  test('a root whose nodes hold nothing decision-shaped is empty', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    node(root, 'a', { node_type: 'action' })
    fs.mkdirSync(path.join(root, 'edges'), { recursive: true })
    const result = load(env, source([root]))

    expect(result.state).toBe('empty')
  })

  test('malformed JSON, a symlinked file and a bad id are skipped and aggregated; good records stay', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    node(root, 'good')
    write(root, 'nodes/broken.json', '{ not json')
    write(root, 'nodes/array.json', '[]')
    write(root, 'nodes/..hidden.json', '{}')
    write(root, 'nodes/has space.json', '{}')
    write(root, `nodes/${'a'.repeat(65)}.json`, '{}')
    write(root, 'nodes/ignored.txt', 'x')
    fs.mkdirSync(path.join(root, 'nodes/sub'))
    write(
      root,
      'nodes/sub/deep.json',
      JSON.stringify({ change_id: 'deep', node_type: 'decision' }),
    )
    const outside = path.join(env.root, 'outside.json')
    fs.writeFileSync(
      outside,
      JSON.stringify({ change_id: 'linked', node_type: 'decision' }),
    )
    fs.symlinkSync(outside, path.join(root, 'nodes/linked.json'))
    write(root, 'edges/ok.json', '{ broken')
    const spy = spyOn(fs, 'readFileSync')
    let opened: string[]
    let result: SourceLoad
    try {
      result = load(env, source([root]))
      opened = spy.mock.calls.map((call) => String(call[0]))
    } finally {
      spy.mockRestore()
    }

    expect(result.records.map((r) => r.path)).toEqual(['graph/nodes/good.json'])
    // A name outside the id charset and a symlink are never opened.
    for (const file of opened) {
      expect(file).not.toContain('has space')
      expect(file).not.toContain('..hidden')
      expect(file).not.toContain('linked.json')
    }
    const warnings = result.warnings.join('\n')
    expect(warnings).toContain('graph: skipped 3 files with an id outside')
    expect(warnings).toContain('graph: skipped 3 files with invalid JSON')
    expect(warnings).toContain('graph: skipped 1 symlink')
    expect(warnings).not.toContain('outside.json')
    expect(warnings).not.toContain('has space')
  })

  test('an id with a path separator or dot dot never opens a file and appears in no path', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    node(root, 'good')
    // A node whose content names a path-shaped change_id.
    write(
      root,
      'nodes/evil.json',
      JSON.stringify({ change_id: '../../etc/passwd', node_type: 'decision' }),
    )
    write(
      root,
      'nodes/evil2.json',
      JSON.stringify({ change_id: 'a/b', node_type: 'decision' }),
    )
    // An edge whose content names path-shaped endpoints.
    edge(root, 'e1', '../../secret', 'good', 'sneaky')
    edge(root, 'e2', 'good', '../nodes/good', 'sneaky too')
    const secret = path.join(env.root, 'secret.json')
    fs.writeFileSync(secret, '{}')

    const spy = spyOn(fs, 'readFileSync')
    try {
      const result = load(env, source([root]))
      const opened = spy.mock.calls.map((call) => String(call[0]))
      for (const file of opened) {
        expect(file).not.toContain('..')
        expect(file).not.toBe(secret)
      }
      expect(result.records.map((r) => r.path)).toEqual([
        'graph/nodes/good.json',
      ])
      expect(result.records[0]?.body).not.toContain('sneaky')
      for (const record of result.records) {
        expect(record.path).not.toContain('..')
        expect(record.path).not.toContain('passwd')
      }
    } finally {
      spy.mockRestore()
    }
  })

  test('a duplicate change_id keeps the first', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    write(
      root,
      'nodes/a-first.json',
      JSON.stringify({
        change_id: 'same',
        node_type: 'decision',
        title: 'First',
      }),
    )
    write(
      root,
      'nodes/b-second.json',
      JSON.stringify({
        change_id: 'same',
        node_type: 'decision',
        title: 'Second',
      }),
    )
    const result = load(env, source([root]))

    expect(result.records.map((r) => r.title)).toEqual(['First'])
    expect(result.warnings.join('\n')).toContain(
      'graph: skipped 1 node with a duplicate change_id',
    )
  })

  test('a file over the per-file cap is skipped unopened and named', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    node(root, 'good')
    node(root, 'big', { description: 'x'.repeat(EXTERNAL_MAX_FILE_BYTES) })
    const result = load(env, source([root]))

    expect(result.records.map((r) => r.path)).toEqual(['graph/nodes/good.json'])
    expect(result.warnings.join('\n')).toContain(
      `graph: skipped 1 file larger than ${EXTERNAL_MAX_FILE_BYTES} bytes`,
    )
  })

  test('a source that does not fit the read budget is dropped whole before any file is read', () => {
    const env = makeEnv()
    const root = path.join(env.root, 'graph')
    node(root, 'good')
    const spy = spyOn(fs, 'readFileSync')
    try {
      const result = load(env, source([root]), 10)
      const opened = spy.mock.calls
        .map((call) => String(call[0]))
        .filter((file) => file.includes('graph'))

      expect(result.state).toBe('dropped')
      expect(result.records).toEqual([])
      expect(opened).toEqual([])
      expect(result.warnings.join('\n')).toContain('read budget')
    } finally {
      spy.mockRestore()
    }
  })

  test('a root or nodes folder that is a symlink is never followed', () => {
    const env = makeEnv()
    const real = path.join(env.root, 'real')
    node(real, 'good')
    const linkedRoot = path.join(env.root, 'linked-root')
    fs.symlinkSync(real, linkedRoot)
    // A user root is followed once...
    expect(load(env, source([linkedRoot])).records).toHaveLength(1)

    // ...but a symlinked nodes/ inside a root is not.
    const root = path.join(env.root, 'graph')
    fs.mkdirSync(root, { recursive: true })
    fs.symlinkSync(path.join(real, 'nodes'), path.join(root, 'nodes'))
    const result = load(env, source([root]))
    expect(result.state).toBe('empty')
    expect(result.records).toEqual([])
  })

  test('a project root that is a symlink, or resolves outside the checkout, drops the source', () => {
    const env = makeEnv()
    const outside = path.join(env.root, 'outside-graph')
    node(outside, 'secret')
    fs.symlinkSync(outside, path.join(env.repo, 'linked'))
    fs.mkdirSync(path.join(env.repo, 'sub'), { recursive: true })
    fs.symlinkSync(outside, path.join(env.repo, 'sub/escape'))

    const direct = load(
      env,
      source([path.join(env.repo, 'linked')], { origin: 'project' }),
    )
    const nested = load(
      env,
      source([path.join(env.repo, 'sub/escape')], { origin: 'project' }),
    )

    expect(direct.state).toBe('dropped')
    expect(nested.state).toBe('dropped')
    expect(direct.records).toEqual([])
    expect(nested.records).toEqual([])
  })

  test('several roots merge into one set; the first root keeps a repeated path', () => {
    const env = makeEnv()
    const one = path.join(env.root, 'one')
    const two = path.join(env.root, 'two')
    node(one, 'a', { title: 'From one' })
    node(two, 'a', { title: 'From two' })
    node(two, 'b', { title: 'Only two' })
    const result = load(env, source([one, two]))

    expect(result.records.map((r) => r.title)).toEqual(['From one', 'Only two'])
  })
})

describe('Deciduous loader: module rules', () => {
  test('search-external-deciduous.ts never imports the dispatcher or config', () => {
    const text = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        '../../src/lib/search-external-deciduous.ts',
      ),
      'utf8',
    )
    const specifiers = [...text.matchAll(/from '([^']+)'/g)].map(
      (match) => match[1],
    )

    expect(specifiers).not.toContain('./search-external.js')
    expect(specifiers).not.toContain('./config.js')
    expect(specifiers).not.toContain('./config-schema.js')
  })
})

describe('Deciduous loader: the whole per-call path', () => {
  test('a project that proposes .deciduous/sync with an allow entry produces records, and the dropped state is gone', async () => {
    const env = makeEnv()
    const sync = path.join(env.repo, '.deciduous/sync')
    node(sync, 'dec-use-cache', {
      title: 'Cache the lookups',
      description: 'The marmot lookup path is slow.',
    })
    node(sync, 'act-x', { node_type: 'action' })
    edge(sync, 'e1', 'act-x', 'dec-use-cache', 'because the ocelot benchmark')
    writeProjectSearch(env, {
      sources: [
        { name: 'graph', format: 'deciduous', roots: ['.deciduous/sync'] },
      ],
    })
    writeUserSearch(env, { allow_project_sources: [env.repo] })

    const response = await runSearch(
      { query: 'ocelot', kind: 'external' },
      { startDir: env.repo, configOptions: env.configOptions },
    )

    expect(response.ok).toBe(true)
    expect(response.text).toContain('graph (project): ')
    expect(response.text).toContain('graph/nodes/dec-use-cache.json')
    expect(response.text).toContain('node_type decision')
    expect(response.text).not.toContain('not supported yet')
    expect(response.text).not.toContain('dropped')
  })
})
