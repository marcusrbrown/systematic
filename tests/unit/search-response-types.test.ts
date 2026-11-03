import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSearch, type SearchResponse } from '../../src/lib/search-core.js'
import {
  makeExternalEnv,
  userSource,
  writeMarkdown,
  writeUserSearch,
} from '../helpers/search-external-env.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

// `SearchResponse` is a discriminated union on `selector`: a built-in response
// carries `result` and an external response carries `external`, and neither
// carries the other. The checks below are types, so `bun run typecheck:all`
// enforces them (the file is compiled with the tests); a violation is a compile
// error, not a test failure. Each assigns `true` to a type that is `true` only
// when the property holds, and `never` (so an error) when it does not.

type OkResponse = Extract<SearchResponse, { ok: true }>
type BuiltinResponse = Extract<SearchResponse, { selector: 'builtin' }>
type ExternalResponse = Extract<SearchResponse, { selector: 'external' }>
type FailedResponse = Extract<SearchResponse, { ok: false }>

/** `true` when `Condition` is the literal `true`; anything else is a compile error at the use site. */
type Holds<Condition extends true> = Condition
type Not<Flag extends boolean> = Flag extends true ? false : true
type Has<Branch, Key extends PropertyKey> = [Branch] extends [never]
  ? never
  : Key extends keyof Branch
    ? true
    : false

// Both branches exist (Has is `never` for an empty Extract, so a missing
// branch fails here too).
export type BuiltinBranchExists = Holds<
  [BuiltinResponse] extends [never] ? false : true
>
export type ExternalBranchExists = Holds<
  [ExternalResponse] extends [never] ? false : true
>

// A built-in response carries `result` and never `external`.
export type BuiltinHasResult = Holds<Has<BuiltinResponse, 'result'>>
export type BuiltinHasNoExternal = Holds<Not<Has<BuiltinResponse, 'external'>>>

// An external response carries `external` and never `result`.
export type ExternalHasExternal = Holds<Has<ExternalResponse, 'external'>>
export type ExternalHasNoResult = Holds<Not<Has<ExternalResponse, 'result'>>>

// Before narrowing, neither field is readable from a successful response.
export type OkHasNoSharedResult = Holds<Not<Has<OkResponse, 'result'>>>
export type OkHasNoSharedExternal = Holds<Not<Has<OkResponse, 'external'>>>

// A failure carries neither.
export type FailureHasNoResult = Holds<Not<Has<FailedResponse, 'result'>>>
export type FailureHasNoExternal = Holds<Not<Has<FailedResponse, 'external'>>>

// Every response has `text`, so a text-only consumer needs no narrowing.
export type EveryResponseHasText = Holds<
  [SearchResponse] extends [{ readonly text: string }] ? true : false
>

const temp = createTempDirTracker()

describe('SearchResponse discriminant at run time', () => {
  it('a built-in response carries result and not external; an external one the reverse', async () => {
    const env = makeExternalEnv(temp)
    try {
      const wiki = path.join(env.root, 'wiki')
      writeMarkdown(wiki, 'a.md', { title: 'A', body: 'needle' })
      writeUserSearch(env, { sources: [userSource(env, 'wiki', wiki)] })
      fs.mkdirSync(path.join(env.repo, 'docs/solutions'), { recursive: true })

      const builtin = await runSearch(
        { query: 'needle' },
        { startDir: env.repo, configOptions: env.configOptions },
      )
      const external = await runSearch(
        { query: 'needle', kind: 'external' },
        { startDir: env.repo, configOptions: env.configOptions },
      )
      const failed = await runSearch(
        { query: '' },
        { startDir: env.repo, configOptions: env.configOptions },
      )

      expect(builtin).toMatchObject({ ok: true, selector: 'builtin' })
      expect('result' in builtin).toBe(true)
      expect('external' in builtin).toBe(false)
      expect(external).toMatchObject({ ok: true, selector: 'external' })
      expect('external' in external).toBe(true)
      expect('result' in external).toBe(false)
      expect(failed.ok).toBe(false)
      expect('selector' in failed).toBe(false)
      expect('result' in failed || 'external' in failed).toBe(false)
    } finally {
      temp.cleanup()
    }
  })

  it('every external reply carries the external field, fixed replies included', async () => {
    const env = makeExternalEnv(temp)
    const bare = temp.track(
      fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-types-'))),
    )
    try {
      const noProject = await runSearch(
        { query: 'x', kind: 'external' },
        { startDir: bare, configOptions: env.configOptions },
      )
      const noSource = await runSearch(
        { query: 'x', kind: 'external' },
        { startDir: env.repo, configOptions: env.configOptions },
      )
      for (const response of [noProject, noSource]) {
        expect(response).toMatchObject({ ok: true, selector: 'external' })
        expect('result' in response).toBe(false)
      }
      expect(noProject.ok && noProject.selector === 'external').toBe(true)
      if (noProject.ok && noProject.selector === 'external') {
        expect(noProject.external).toEqual({
          kind: 'fixed',
          reply: { kind: 'no-project' },
        })
      }
      if (noSource.ok && noSource.selector === 'external') {
        expect(noSource.external).toEqual({
          kind: 'fixed',
          reply: { kind: 'no-active-source' },
        })
      }
    } finally {
      temp.cleanup()
    }
  })
})
