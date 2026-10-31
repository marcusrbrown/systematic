import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSearch } from '../../src/lib/search-core.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const FIXTURES = path.join(ROOT_DIR, 'tests/fixtures/search-corpus')

interface Characterization {
  readonly requests: ReadonlyArray<{
    readonly query: string
    readonly limit: number
  }>
  readonly outputs: readonly string[]
}

const golden: Characterization = JSON.parse(
  fs.readFileSync(
    path.join(FIXTURES, 'lifecycle-characterization.json'),
    'utf8',
  ),
)

const temp = createTempDirTracker()
afterEach(() => temp.cleanup())

function copyLifecycleProject(): string {
  const root = temp.track(
    fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'search-lifecycle-golden-')),
    ),
  )
  fs.mkdirSync(path.join(root, '.git'))
  fs.cpSync(path.join(FIXTURES, 'lifecycle'), root, { recursive: true })
  return root
}

describe('solution lifecycle output is unchanged', () => {
  it('has one recorded output per request', () => {
    expect(golden.outputs).toHaveLength(golden.requests.length)
  })

  for (const [index, request] of golden.requests.entries()) {
    it(`renders ${JSON.stringify(request.query)} (limit ${request.limit}) byte for byte`, async () => {
      const recorded = golden.outputs[index]
      if (recorded === undefined) throw new Error('no recorded output')
      const root = copyLifecycleProject()
      const response = await runSearch(request, { startDir: root })
      expect(response.ok).toBe(true)
      expect(response.text).toBe(recorded)
    })
  }
})
