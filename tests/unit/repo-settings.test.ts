import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Locks the repository settings in .github/settings.yml that the gated release
 * pipeline depends on: the `main` ruleset (one approval on the latest push, no
 * bypass), the `release-branch` ruleset (only the release App bypasses), and
 * the `v*` tag rulesets (only the release App creates a tag; no one moves or
 * deletes one).
 */

const SETTINGS_PATH = path.resolve(process.cwd(), '.github/settings.yml')

const RELEASE_APP_ID = 5287597
const GITHUB_ACTIONS_INTEGRATION_ID = 15368
const CODEQL_INTEGRATION_ID = 57789

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be a mapping`)
  return value
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a sequence`)
  return value
}

function readSettings(): RecordValue {
  return asRecord(yaml.load(fs.readFileSync(SETTINGS_PATH, 'utf8')), 'settings')
}

function getRuleset(name: string): RecordValue {
  const ruleset = asArray(readSettings().rulesets, 'rulesets')
    .map((entry, i) => asRecord(entry, `ruleset ${i}`))
    .find((entry) => entry.name === name)
  if (!ruleset) throw new Error(`ruleset not found: ${name}`)
  return ruleset
}

function getRule(ruleset: RecordValue, type: string): RecordValue {
  const rule = asArray(ruleset.rules, 'rules')
    .map((entry, i) => asRecord(entry, `rule ${i}`))
    .find((entry) => entry.type === type)
  if (!rule) throw new Error(`rule not found: ${type}`)
  return rule
}

function classicContexts(): readonly unknown[] {
  const main = asArray(readSettings().branches, 'branches')
    .map((entry, i) => asRecord(entry, `branch ${i}`))
    .find((entry) => entry.name === 'main')
  const protection = asRecord(main?.protection, 'protection')
  const checks = asRecord(
    protection.required_status_checks,
    'required_status_checks',
  )
  return asArray(checks.contexts, 'contexts')
}

function rulesetChecks(): readonly RecordValue[] {
  const parameters = asRecord(
    getRule(getRuleset('main'), 'required_status_checks').parameters,
    'parameters',
  )
  return asArray(parameters.required_status_checks, 'checks').map((c, i) =>
    asRecord(c, `check ${i}`),
  )
}

describe('settings: main ruleset', () => {
  test('is an active branch ruleset on the default branch', () => {
    const ruleset = getRuleset('main')
    expect(ruleset.target).toBe('branch')
    expect(ruleset.enforcement).toBe('active')
    expect(ruleset.conditions).toEqual({
      ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
    })
  })

  test('has no bypass actors', () => {
    expect(getRuleset('main').bypass_actors).toEqual([])
  })

  test('has the history-protection rules', () => {
    const types = asArray(getRuleset('main').rules, 'rules').map(
      (rule) => asRecord(rule, 'rule').type,
    )
    expect(types).toContain('deletion')
    expect(types).toContain('non_fast_forward')
    expect(types).toContain('required_linear_history')
  })

  test('required check contexts exactly equal the classic protection contexts', () => {
    const contexts = rulesetChecks().map((check) => check.context)
    expect([...contexts].sort()).toEqual([...classicContexts()].sort())
    expect(new Set(contexts).size).toBe(contexts.length)
  })

  test('Host Contract is a required check in both the ruleset and the classic protection', () => {
    const check = rulesetChecks().find((c) => c.context === 'Host Contract')
    expect(check).toBeDefined()
    expect(check?.integration_id).toBe(GITHUB_ACTIONS_INTEGRATION_ID)
    expect(classicContexts()).toContain('Host Contract')
  })

  // The required check must report on every run: a skipped job reads as
  // success, so the aggregator carries `if: always()` and nothing narrower.
  // Anything else (a path filter, `success()`, `always() && ...`) could skip
  // the job and leave the required context unreported.
  function isExactlyAlways(condition: unknown): boolean {
    if (typeof condition !== 'string') return false
    const text = condition.trim()
    const wrapped = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(text)
    return (wrapped?.[1] ?? text).trim() === 'always()'
  }

  test('the required Host Contract check is reported on every pull request and push', () => {
    // A required check that never reports blocks merges forever. Exactly one
    // job must carry that display name, it must run unconditionally
    // (`if: always()`), and the workflow must have no workflow-level path
    // filter (which would suppress the whole run).
    const workflow = asRecord(
      yaml.load(
        fs.readFileSync(
          path.resolve(process.cwd(), '.github/workflows/main.yaml'),
          'utf8',
        ),
        { schema: yaml.JSON_SCHEMA },
      ),
      'main.yaml',
    )
    const jobs = asRecord(workflow.jobs, 'jobs')
    const named = Object.entries(jobs).filter(
      ([, job]) => asRecord(job, 'job').name === 'Host Contract',
    )
    expect(named.map(([id]) => id)).toEqual(['host-contract'])
    expect(isExactlyAlways(asRecord(named[0]?.[1], 'job').if)).toBe(true)

    const on = asRecord(workflow.on, 'on')
    for (const event of ['pull_request', 'push']) {
      const trigger = asRecord(on[event], event)
      expect(trigger, event).not.toHaveProperty('paths')
      expect(trigger, event).not.toHaveProperty('paths-ignore')
    }
  })

  test.each([
    { label: 'always()', condition: 'always()', accepted: true },
    {
      label: 'always() in an expression wrapper',
      condition: `$${'{{'} always() }}`,
      accepted: true,
    },
    { label: 'no condition', condition: undefined, accepted: false },
    { label: 'success()', condition: 'success()', accepted: false },
    { label: '!cancelled()', condition: '!cancelled()', accepted: false },
    {
      label: 'always() with a further clause',
      condition: "always() && github.event_name == 'pull_request'",
      accepted: false,
    },
    {
      label: 'a gate output',
      condition: "needs.host-contract-gate.outputs.run == 'true'",
      accepted: false,
    },
  ])(
    'the job-level condition check accepts only exactly always(): $label is $accepted',
    ({ condition, accepted }) => {
      expect(isExactlyAlways(condition)).toBe(accepted)
    },
  )

  test('every check has an integration_id, and CodeQL maps to 57789', () => {
    for (const check of rulesetChecks()) {
      const expected =
        check.context === 'CodeQL'
          ? CODEQL_INTEGRATION_ID
          : GITHUB_ACTIONS_INTEGRATION_ID
      expect(check.integration_id, String(check.context)).toBe(expected)
    }
  })

  test('requires an up-to-date branch for status checks', () => {
    const parameters = asRecord(
      getRule(getRuleset('main'), 'required_status_checks').parameters,
      'parameters',
    )
    expect(parameters.strict_required_status_checks_policy).toBe(true)
    expect(parameters.do_not_enforce_on_create).toBe(false)
  })

  test('the pull_request rule needs 1 approval, dismisses stale approvals, and requires last-push approval', () => {
    const parameters = asRecord(
      getRule(getRuleset('main'), 'pull_request').parameters,
      'parameters',
    )
    expect(parameters.required_approving_review_count).toBe(1)
    expect(parameters.dismiss_stale_reviews_on_push).toBe(true)
    expect(parameters.require_last_push_approval).toBe(true)
    expect(parameters.require_code_owner_review).toBe(false)
    expect(parameters.required_review_thread_resolution).toBe(false)
    expect(parameters.allowed_merge_methods).toEqual(['squash'])
  })
})

describe('settings: release-branch ruleset', () => {
  test('the only bypass actor is the release App', () => {
    const actors = asArray(getRuleset('release-branch').bypass_actors, 'actors')
    expect(actors).toHaveLength(1)
    expect(asRecord(actors[0], 'actor').actor_id).toBe(RELEASE_APP_ID)
  })
})

function ruleTypes(ruleset: RecordValue): readonly unknown[] {
  return asArray(ruleset.rules, 'rules').map(
    (rule) => asRecord(rule, 'rule').type,
  )
}

describe('settings: release tag rulesets', () => {
  test.each(['release-tags-create', 'release-tags-protect'])(
    '%s is an active tag ruleset on refs/tags/v*',
    (name) => {
      const ruleset = getRuleset(name)
      expect(ruleset.target).toBe('tag')
      expect(ruleset.enforcement).toBe('active')
      expect(ruleset.conditions).toEqual({
        ref_name: { include: ['refs/tags/v*'], exclude: [] },
      })
    },
  )

  test('release-tags-create blocks creation and only the release App bypasses', () => {
    const ruleset = getRuleset('release-tags-create')
    expect(ruleTypes(ruleset)).toEqual(['creation'])
    expect(ruleset.bypass_actors).toEqual([
      {
        actor_id: RELEASE_APP_ID,
        actor_type: 'Integration',
        bypass_mode: 'always',
      },
    ])
  })

  test('release-tags-protect blocks update and deletion with no bypass', () => {
    const ruleset = getRuleset('release-tags-protect')
    expect([...ruleTypes(ruleset)].sort()).toEqual(['deletion', 'update'])
    expect(ruleset.bypass_actors).toEqual([])
  })

  test('the rulesets array names exactly the rulesets the applier should keep', () => {
    const names = asArray(readSettings().rulesets, 'rulesets').map(
      (entry) => asRecord(entry, 'ruleset').name,
    )
    expect([...names].sort()).toEqual([
      'main',
      'release-branch',
      'release-tags-create',
      'release-tags-protect',
    ])
  })
})

describe('settings: file shape', () => {
  test('there is no top-level environments key (the applier would delete them)', () => {
    expect(readSettings()).not.toHaveProperty('environments')
  })
})
