import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '../integration/fixtures/receipt-workflow-host.ts',
)

// Locks Unit 2's load-bearing invariant: importing this fixture must never
// spawn bunx/opencode at module scope. `bun test tests/unit` (which the
// required `test` job runs, with no network and no launcher on PATH)
// imports this fixture indirectly through `receipt-workflow-host.test.ts`.
// The availability probe only runs behind the memoizing `isOpencodeAvailable()`
// function, called lazily by integration modules at their own scope — never
// by the fixture module itself. Driven as a child process so a stray spawn
// (which would need network or a real launcher and could hang or take
// seconds) shows up as elapsed wall time rather than a mocked assertion.
describe('receipt-workflow-host fixture import', () => {
  test('importing the fixture module does not spawn bunx/opencode at module scope', () => {
    const script = `
      const start = Date.now()
      await import(${JSON.stringify(pathToFileURL(FIXTURE_PATH).href)})
      const elapsedMs = Date.now() - start
      process.stdout.write('IMPORT_ELAPSED_MS:' + elapsedMs)
    `

    const result = spawnSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
      timeout: 10_000,
    })

    expect(result.status).toBe(0)

    const match = /IMPORT_ELAPSED_MS:(\d+)/.exec(result.stdout)
    expect(match).not.toBeNull()

    // A bunx probe (network fetch or launcher exec) takes hundreds of
    // milliseconds to tens of seconds; a pure module import completes in
    // low tens of milliseconds. 500ms leaves ample margin for CI jitter
    // while still catching a probe call reintroduced at module scope.
    const elapsedMs = Number(match?.[1])
    expect(elapsedMs).toBeLessThan(500)
  })
})
