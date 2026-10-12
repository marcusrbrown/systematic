import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Locks the repository settings in .github/settings.yml that the gated release
 * pipeline depends on: the `main` ruleset (one approval on the latest push, no
 * bypass) and the `release-branch` ruleset (only the release App bypasses).
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

describe('settings: file shape', () => {
  test('there is no top-level environments key (the applier would delete them)', () => {
    expect(readSettings()).not.toHaveProperty('environments')
  })
})
