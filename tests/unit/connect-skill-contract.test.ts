/**
 * Contract tests for the `ce:connect` skill, its references and the
 * `connections-researcher` agent.
 *
 * Skill text is not code, so these tests pin the facts a run depends on: the
 * names the helper and the host guard key on, the exact terminal lines, the
 * mode tokens, and the limits the helper enforces. They do not show how a live
 * model behaves; the baseline and pressure runs recorded with the change do.
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { isValidAgentColor } from '../../src/lib/agent-colors.js'
import {
  buildAgentCatalog,
  resolveToolAllowlist,
} from '../../src/lib/agent-resolver.js'
import { CONNECT_HOSTS } from '../../src/lib/connect-config.js'
import {
  BATCH_VERSION,
  CANDIDATE_KINDS,
  CANDIDATE_LIMITS,
  NEXT_STEPS,
} from '../../src/lib/connect-helper-core.js'
import { REFUSAL_TEXT } from '../../src/lib/connect-import.js'
import { type PinProject, resolvePins } from '../../src/lib/connect-pins.js'
import { isGithubOwnerRepo } from '../../src/lib/connect-repo-identity.js'
import { parseFrontmatter } from '../../src/lib/frontmatter.js'
import { READ_ONLY_AGENT_NAMES } from '../../src/lib/opencode-v2-tool-guard.js'
import { CURATED_PERSONAS } from '../../src/lib/pi-subagents-personas.js'
import { SKILL_FRONTMATTER_FIELDS } from '../../src/lib/skills.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SKILL_DIR = path.join(ROOT, 'skills/ce-connect')
const AGENT_FILE = path.join(ROOT, 'agents/research/connections-researcher.md')

const skillText = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
const contractText = fs.readFileSync(
  path.join(SKILL_DIR, 'references/candidate-contract.md'),
  'utf8',
)
const outcomesText = fs.readFileSync(
  path.join(SKILL_DIR, 'references/headless-and-outcomes.md'),
  'utf8',
)
const agentText = fs.readFileSync(AGENT_FILE, 'utf8')
const guideText = fs.readFileSync(
  path.join(ROOT, 'docs/src/content/docs/guides/cross-project-connections.mdx'),
  'utf8',
)
const refreshText = fs.readFileSync(
  path.join(ROOT, 'skills/ce-compound-refresh/SKILL.md'),
  'utf8',
)

const skill = parseFrontmatter<Record<string, unknown>>(skillText)
const agent = parseFrontmatter<Record<string, unknown>>(agentText)

const TERMINAL_LINES = [
  'Connect complete',
  'Connect degraded',
  'Connect busy',
  'Connect failed',
] as const

describe('ce:connect skill frontmatter', () => {
  test('uses only fields the skill loader reads', () => {
    for (const key of Object.keys(skill.data)) {
      expect(SKILL_FRONTMATTER_FIELDS as readonly string[]).toContain(key)
    }
  })

  test('is named ce:connect and describes when to use it, not how it works', () => {
    expect(skill.data.name).toBe('ce:connect')
    expect(String(skill.data.description)).toMatch(/^Use when /)
    expect(String(skill.data.description).length).toBeLessThanOrEqual(500)
  })

  test('declares its argument hint and the neutral-vocabulary marker', () => {
    expect(String(skill.data['argument-hint'])).toContain('mode:headless')
    expect(
      (skill.data.metadata as Record<string, unknown>)['harness-portability'],
    ).toBe('neutral-v1')
  })

  test('is model-invocable, so a user or a caller can start a run', () => {
    expect(skill.data['disable-model-invocation']).toBeUndefined()
  })

  test('shows the selection words in the argument hint, beside the mode tokens', () => {
    const hint = String(skill.data['argument-hint'])
    expect(hint).toContain('group:<name>')
    expect(hint).toContain('projects:<a>,<b>')
    expect(hint).toContain('mode:interactive')
  })
})

describe('ce:connect selection words', () => {
  const step1 = section(skillText, '## Step 1', '## Step 2')

  test('lists every group: and projects: word in the first step, before the preflight', () => {
    expect(step1).toMatch(/every word that starts with `group:` or `projects:`/)
    expect(skillText.indexOf('`projects:`')).toBeLessThan(
      skillText.indexOf('## Step 2'),
    )
    expect(step1).toMatch(/before the preflight/)
  })

  test('reads the words from the arguments or the invoking instruction, the same on every host', () => {
    expect(step1).toMatch(/skill arguments/)
    expect(step1).toMatch(/invoking instruction/)
    expect(step1).toMatch(/both kinds of host get the same list|same list/i)
    expect(step1).toMatch(
      /Never read a word from a file in a project|Never read a token from a file in a project/,
    )
  })

  test('passes the list to begin unchanged and leaves every decision to the helper', () => {
    expect(step1).toMatch(/do not parse|does not parse|Do not parse/i)
    expect(step1).toMatch(/unchanged/)
    expect(step1).toMatch(/Do not remove a repeat/i)
    expect(skillText).toContain('"selection": [')
    expect(skillText).toMatch(/JSON-escape/)
  })

  test('never widens a refused selection to the whole allow list', () => {
    const step3 = section(skillText, '## Step 3', '## Step 4')
    expect(step3).toMatch(/selection refusal/i)
    expect(step3).toMatch(/Never retry with a different selection/i)
    expect(step3).toMatch(/whole allow list/i)
    expect(step3).toMatch(/No lock was taken/)
  })

  test('names every selection refusal reason in the skill and the outcomes reference', () => {
    for (const reason of [
      'conflicting-selection',
      'unknown-group',
      'unknown-project',
      'ambiguous-project',
      'group-member-not-allowed',
    ]) {
      expect(skillText).toContain(`\`${reason}\``)
      expect(outcomesText).toContain(`\`${reason}\``)
    }
  })

  test('describes the selection tokens in the outcomes reference, and a refusal as a failed run before begin', () => {
    expect(outcomesText).toContain('## Reading the selection')
    expect(outcomesText).toContain('`group:<name>`')
    expect(outcomesText).toContain('`projects:<a>,<b>`')
    expect(outcomesText).toMatch(/narrows the allow list and never widens it/i)
    expect(outcomesText).toMatch(/Connect failed/)
  })

  test('researcher dispatch lists the projects the run reads, not the whole allow list', () => {
    const step5 = section(skillText, '## Step 5', '## Step 6')
    expect(step5).toMatch(/`projects` of the `begin` answer/)
    expect(step5).toMatch(/every allowed project/i)
  })
})

describe('ce:connect fetch', () => {
  const step1 = section(skillText, '## Step 1', '## Step 2')
  const fetchSection = section(skillText, '### Fetch word', '## Step 2')

  test('shows the fetch word in the argument hint', () => {
    expect(String(skill.data['argument-hint'])).toContain('fetch:<run>')
  })

  test('lists every fetch: word in the first pass, before the preflight', () => {
    expect(step1).toContain('### Fetch word')
    expect(fetchSection).toMatch(/every word that starts with `fetch:`/)
    expect(fetchSection).toMatch(/same pass/)
    expect(skillText.indexOf('### Fetch word')).toBeLessThan(
      skillText.indexOf('## Step 2'),
    )
  })

  test('takes a numeric GitHub run id only, and counts identical repeats once', () => {
    expect(fetchSection).toMatch(/digits only/)
    expect(fetchSection).toMatch(/twice or more counts once/)
    expect(fetchSection).toContain('invalid-request: fetch: needs a numeric')
  })

  describe('the fetch value', () => {
    /** The pattern the skill states for a `fetch:` value, read from its own text so the test runs the rule the skill gives. */
    const valuePattern = (): RegExp => {
      const stated = fetchSection.match(/value must match `(\^[^`]+\$)`/)
      expect(stated).not.toBeNull()
      return new RegExp(stated?.[1] ?? '$^')
    }

    test('names the attempt form: a run, a dot and the attempt the candidate came from', () => {
      expect(String(skill.data['argument-hint'])).toContain(
        'fetch:<run>[.<attempt>]',
      )
      expect(fetchSection).toMatch(/`fetch:<run>\.<attempt>`/)
      expect(fetchSection).toMatch(
        /`fetch:<run>\.<attempt>`[^\n]*exactly that attempt/,
      )
    })

    test('keeps a bare fetch:<run> meaning the newest attempt of that run', () => {
      expect(fetchSection).toMatch(
        /bare `fetch:<run>`[^\n]*newest attempt of that run/,
      )
      expect(valuePattern().test('43525490720')).toBe(true)
    })

    test('accepts a run, or a run and an attempt, as positive integers', () => {
      const accepts = valuePattern()
      for (const value of ['1', '43525490720', '43525490720.1', '7.12']) {
        expect(accepts.test(value)).toBe(true)
      }
      expect(fetchSection).toMatch(/positive integer/)
    })

    test('rejects an attempt that is zero, padded, empty, signed or not a number', () => {
      const accepts = valuePattern()
      for (const value of [
        '',
        '0',
        '0.1',
        '900.0',
        '900.00',
        '900.01',
        '900.',
        '.1',
        '900.1.2',
        '900.-1',
        '900.+1',
        '900.1a',
        '900.1;id',
        '900 .1',
        `900.${'1'.repeat(11)}`,
        '1'.repeat(21),
      ]) {
        expect(accepts.test(value)).toBe(false)
      }
      expect(fetchSection).toContain(
        'invalid-request: fetch: needs a numeric GitHub run id',
      )
    })

    test('counts fetch:<run> and fetch:<run>.<attempt> as two different words', () => {
      expect(fetchSection).toMatch(
        /`fetch:<run>` and `fetch:<run>\.<attempt>` are different words/,
      )
    })
  })

  describe('the named fetch word', () => {
    /** The pattern the skill states for a named value, read from its own text. */
    const namedPattern = (): RegExp => {
      const stated = fetchSection.match(/named value must match `(\^[^`]+\$)`/)
      expect(stated).not.toBeNull()
      return new RegExp(stated?.[1] ?? '$^')
    }
    const LONGEST = `${'o'.repeat(39)}/${'r'.repeat(100)}`

    test('shows the named form in the argument hint, beside the bare one', () => {
      const hint = String(skill.data['argument-hint'])
      expect(hint).toContain('fetch:<owner>/<repo>:<run>.<attempt>')
      expect(hint).toContain('fetch:<run>[.<attempt>]')
    })

    test('names the form, requires the attempt and keeps a bare word meaning Systematic', () => {
      expect(fetchSection).toMatch(/`fetch:<owner>\/<repo>:<run>\.<attempt>`/)
      expect(fetchSection).toMatch(/attempt is required/)
      expect(fetchSection).toMatch(/bare word always means Systematic/)
      expect(fetchSection).toMatch(
        /bare word and a named word are different words/,
      )
    })

    test('accepts a named word with a repository, a run and an attempt', () => {
      const accepts = namedPattern()
      for (const value of [
        'fro-bot/agent:900.1',
        'Fro-Bot/Agent:900.12',
        'o/r:1.1',
        'owner/.github:7.2',
        `${LONGEST}:43525490720.1`,
      ]) {
        expect(accepts.test(value)).toBe(true)
      }
    })

    test('rejects a missing attempt, a bad repository and anything a run or attempt rule refuses', () => {
      const rejects = namedPattern()
      for (const value of [
        '',
        'fro-bot/agent',
        'fro-bot/agent:900',
        'fro-bot/agent:900.',
        'fro-bot/agent:0.1',
        'fro-bot/agent:900.0',
        'fro-bot/agent:900.01',
        'fro-bot/agent:900.1.2',
        'fro-bot/agent:900.1;id',
        'fro-bot/agent:900.1\n',
        ':900.1',
        '/agent:900.1',
        'fro-bot/:900.1',
        '-fro/agent:900.1',
        'fro-/agent:900.1',
        'fro_bot/agent:900.1',
        'fro-bot/..:900.1',
        'fro-bot/.:900.1',
        'fro-bot/agent/extra:900.1',
        'fro bot/agent:900.1',
        'fro-bot/agent :900.1',
        `${'o'.repeat(40)}/agent:900.1`,
        `fro-bot/${'r'.repeat(101)}:900.1`,
        `fro-bot/agent:${'1'.repeat(21)}.1`,
        `fro-bot/agent:900.${'1'.repeat(11)}`,
      ]) {
        expect(rejects.test(value), value).toBe(false)
      }
    })

    test("states the repository part by the helper's own rule", () => {
      const pattern = namedPattern()
      for (const repo of [
        'fro-bot/agent',
        'Fro-Bot/Agent',
        'o/r',
        'owner/.github',
        LONGEST,
        '',
        'fro-bot',
        'fro-bot/',
        '/agent',
        'fro-bot//agent',
        'fro bot/agent',
        'fro-bot/agent/extra',
        '-fro/agent',
        'fro-/agent',
        'fro_bot/agent',
        'fro-bot/..',
        'fro-bot/.',
        '../agent',
        `${'o'.repeat(40)}/agent`,
        `fro-bot/${'r'.repeat(101)}`,
        'fro-bot/agént',
      ]) {
        expect(pattern.test(`${repo}:900.1`), repo).toBe(
          isGithubOwnerRepo(repo),
        )
      }
    })

    test('refuses a malformed named word before any command, with its own line', () => {
      expect(fetchSection).toContain(
        'invalid-request: fetch: a named word is <owner>/<repo>:<run>.<attempt>',
      )
      expect(fetchSection).toMatch(/before any value reaches a command/)
    })

    test('names the remedy on the same line, so the stop stays two lines', () => {
      expect(fetchSection).toContain(
        'Supply `fetch:<owner>/<repo>:<run>.<attempt>` and try again.',
      )
      expect(fetchSection).toMatch(/on the same line/)
    })
  })

  test('stands alone: it conflicts with a selection and with a different fetch word', () => {
    expect(fetchSection).toContain(
      'conflicting-selection: fetch: cannot be combined with group: or projects:',
    )
    expect(fetchSection).toContain(
      'conflicting-selection: two different fetch: words',
    )
    expect(fetchSection).toMatch(/before any command/)
  })

  test('skips the run steps: no host, no agent, no question, no mode', () => {
    expect(fetchSection).toMatch(/skip Steps 2 to 7/)
    expect(fetchSection).toMatch(/dispatches no agent, asks nothing/)
    expect(fetchSection).toContain('references/fetch-and-import.md')
  })

  test('treats the downloaded record as data only the helper opens', () => {
    expect(skillText).toMatch(
      /downloaded for `fetch:` is data from outside this machine/,
    )
    expect(skillText).toMatch(/Only the helper opens it/)
  })
})

describe('ce:connect fetch reference', () => {
  const text = fs.readFileSync(
    path.join(SKILL_DIR, 'references/fetch-and-import.md'),
    'utf8',
  )
  const order = (a: string, b: string): boolean =>
    text.indexOf(a) !== -1 && text.indexOf(a) < text.indexOf(b)

  test('checks the workflow and the event before it downloads anything', () => {
    expect(text).toContain('.github/workflows/connect.yaml')
    expect(text).toMatch(/`schedule` or `workflow_dispatch`/)
    expect(text).toContain(
      'gh api --hostname github.com "repos/marcusrbrown/systematic/actions/runs/',
    )
    expect(text).toMatch(/`gh run view --json` has no workflow path/)
    expect(order('### 2. Check the run', '### 5. Download')).toBe(true)
    expect(order('unsupported-run-event', 'gh run download')).toBe(true)
    expect(order('not-a-connect-run', 'gh run download')).toBe(true)
  })

  test('fixes the repository of a bare word and takes no repository from the record', () => {
    expect(text).toMatch(
      /The repository of a bare word is fixed: `marcusrbrown\/systematic`/,
    )
    expect(text).toMatch(/Never take a repository, a path or a workflow name/)
    expect(text).toMatch(/never from a downloaded file/)
  })

  describe('the artifact choice', () => {
    const choose = section(text, '### 4. Choose the artifact', '### 5.')

    test('with a bare run, picks the highest attempt of connect-run-<run>-<attempt> for that run id', () => {
      expect(text).toContain('connect-run-<run>-<attempt>')
      expect(choose).toMatch(/With a bare `fetch:<run>`/)
      expect(choose).toMatch(/highest attempt/)
      expect(choose).toContain('connect-run-<run>-2')
    })

    test('with an attempt, downloads exactly connect-run-<run>-<attempt> and no other', () => {
      expect(choose).toMatch(/With `fetch:<run>\.<attempt>`/)
      expect(choose).toMatch(
        /download exactly `connect-run-<run>-<attempt>` with that attempt/,
      )
      expect(choose).toMatch(/Do not pick the highest attempt/)
    })

    test('stops with a fixed reason when the named attempt is missing or expired, and never falls back', () => {
      expect(choose).toMatch(
        /named attempt[^\n]*stop with `artifact-not-found`/,
      )
      expect(choose).toMatch(/named attempt[^\n]*stop with `artifact-expired`/)
      expect(choose).toMatch(/never fall back to another attempt/i)
      expect(choose).not.toMatch(
        /(?:missing|expired)[^\n]*(?:use|take|pick|download) the (?:newest|highest|next|earlier|later)/i,
      )
    })

    test('looks an explicit attempt up by its exact name, for a named word and for a bare run with an attempt', () => {
      expect(choose).toContain(
        'gh api --hostname github.com "repos/<repo>/actions/runs/<run>/artifacts?name=connect-run-<run>-<attempt>"',
      )
      expect(choose).toMatch(
        /named word or an explicit attempt[^\n]*exact name/i,
      )
      expect(choose).not.toMatch(/--paginate[^\n]*name=connect-run/)
    })

    test('paginates the artifact list for a bare run, which has to find the newest attempt', () => {
      expect(choose).toContain(
        'gh api --hostname github.com --paginate "repos/<repo>/actions/runs/<run>/artifacts?per_page=100"',
      )
      expect(choose).toMatch(/--paginate[\s\S]*bare `fetch:<run>`/)
      expect(choose).toMatch(/one JSON object per line/)
      expect(choose).toMatch(/empty output with a zero exit is an answer/i)
      // The old one-page call must be gone.
      expect(choose).not.toMatch(/artifacts\?per_page=100" --jq '\[/)
    })

    test('hands import the run id only: the record carries no attempt to check', () => {
      expect(text).toMatch(/record carries no attempt/)
      expect(text).not.toMatch(/"provenance": \{[^}]*attempt/)
    })
  })

  test('downloads into a fresh directory it removes afterward, and never opens the record itself', () => {
    expect(text).toContain('mktemp -d')
    expect(text).toContain(
      'gh run download <run> --repo github.com/marcusrbrown/systematic',
    )
    expect(text).toContain('gh run download <run> --repo github.com/<repo>')
    expect(text).toMatch(/Remove `<DEST>`/)
    expect(text).toMatch(/Do not open it and do not list the directory/)
    expect(text).toMatch(/holds one file, `run.json`, at its root/)
  })

  test('hands the helper a directory and where the run came from, and asks nothing', () => {
    expect(text).toContain('connect.mjs" import')
    expect(text).toContain('"provenance": {"repo": "<repo>"')
    expect(text).toMatch(
      /`<repo>` is `marcusrbrown\/systematic` for a bare word/,
    )
    expect(text).toMatch(/dispatches no agent, asks nothing/)
    expect(text).toMatch(/never touches the network/)
  })

  test('prints its own reason for a missing artifact, an expired one and an unauthenticated gh', () => {
    for (const reason of [
      'artifact-not-found',
      'artifact-expired',
      'gh-not-authenticated',
      'not-a-connect-run',
      'unsupported-run-event',
    ]) {
      expect(text).toContain(`\`${reason}\``)
    }
    expect(text).toMatch(/tick Rejected in the scheduled run's report/)
  })

  test('prints its own line for an artifact list that failed, and never reads it as a missing artifact', () => {
    expect(text).toContain('`artifact-list-failed`')
    expect(text).toMatch(/non-zero exit/)
    expect(text).toMatch(/output is not a JSON array/)
    expect(text).toMatch(/Never read a failed call as `artifact-not-found`/)
    expect(text).toMatch(/The call succeeded and no name matches/)
    expect(order('`artifact-list-failed`', '`artifact-not-found`')).toBe(true)
    expect(text).toMatch(/\| `artifact-list-failed` \|/)
  })

  test('ends with Connect failed and helper-unavailable when node, the helper file or the answer is missing', () => {
    expect(text).toMatch(/If `node` is missing, the helper file is gone/)
    expect(text).toMatch(/`import` prints no JSON answer/)
    expect(text).toMatch(
      /print `helper-unavailable` and its hint, then `Connect failed`/,
    )
    expect(text).toMatch(/\| `helper-unavailable` \|/)
    expect(order('### 6. Import', '### 7. Report')).toBe(true)
    expect(order('`helper-unavailable` and its hint', '### 7. Report')).toBe(
      true,
    )
  })

  test('prints the reason and the fields that say what to fix when import is refused', () => {
    const failedLine = text
      .split('\n')
      .find((line) => line.startsWith('- `failed`'))
    expect(failedLine).toBeDefined()
    for (const field of [
      '`reason`',
      '`detail`',
      '`unmatched`',
      '`configWarnings`',
    ]) {
      expect(failedLine).toContain(field)
    }
    expect(failedLine).toMatch(/Then print `Connect failed`/)
  })

  test('names every reason the helper can answer, and every candidate refusal it can print', () => {
    for (const reason of [
      'record-missing',
      'record-symlink',
      'record-not-regular',
      'record-unreadable',
      'record-too-large',
      'record-malformed',
      'record-schema-version',
      'directory-unreadable',
      'ledger-unreadable',
      'state-root-refused',
      'no-allowed-projects',
    ]) {
      expect(text).toContain(`\`${reason}\``)
    }
    for (const reason of Object.keys(REFUSAL_TEXT)) {
      expect(text).toContain(`\`${reason}\``)
    }
  })

  test('prints the helper summary unchanged and ends with its final line', () => {
    expect(text).toMatch(
      /Print the `summary` as the helper wrote it, unchanged/,
    )
    expect(text).toMatch(/Never retype, shorten or build one/)
    expect(text).toMatch(/Print `finalLine` last, with nothing after it/)
    expect(text).toMatch(/Never run `ledger unlock` on a `busy` answer/)
  })

  test('is linked from the skill and described in the outcomes reference', () => {
    expect(skillText).toContain('references/fetch-and-import.md')
    expect(outcomesText).toContain('## Reading a fetch')
    expect(outcomesText).toContain('`fetch:<run>`')
    expect(outcomesText).toContain('`fetch:<owner>/<repo>:<run>.<attempt>`')
    expect(outcomesText).toMatch(/named word without an attempt/i)
    expect(outcomesText).toMatch(/`import` answered `complete`/)
    expect(outcomesText).toMatch(/`import` answered `degraded`/)
  })
})

describe('ce:connect named fetch reference', () => {
  const text = fs.readFileSync(
    path.join(SKILL_DIR, 'references/fetch-and-import.md'),
    'utf8',
  )
  const at = (needle: string): number => {
    const found = text.indexOf(needle)
    expect(found, needle).not.toBe(-1)
    return found
  }
  const before = (a: string, b: string): boolean => at(a) < at(b)
  const resolve = section(text, '### 1. Resolve the repository', '### 2.')
  const check = section(text, '### 2. Check the run', '### 3.')
  const bareCheck = section(check, '#### Bare word', '#### Named word')
  const namedCheck = check.slice(check.indexOf('#### Named word'))
  const prove = section(text, '### 3. Prove the provenance', '### 4.')
  const choose = section(text, '### 4. Choose the artifact', '### 5.')
  const reasons = section(
    text,
    '## Reasons the skill prints',
    '## Reasons a candidate is refused',
  )

  test('states the named grammar with the attempt required, and a bare word as Systematic', () => {
    expect(text).toContain('`fetch:<owner>/<repo>:<run>.<attempt>`')
    expect(text).toMatch(/attempt is required/)
    expect(text).toMatch(/A bare word means Systematic/)
  })

  test('runs the steps in the order: origin, run, provenance, artifact, download, import, report', () => {
    const headings = [
      '### 1. Resolve the repository',
      '### 2. Check the run, before any download',
      '### 3. Prove the provenance',
      '### 4. Choose the artifact',
      '### 5. Download into a fresh directory',
      '### 6. Import',
      '### 7. Report',
    ]
    headings.slice(1).forEach((heading, i) => {
      expect(before(headings[i] ?? '', heading), heading).toBe(true)
    })
  })

  describe('the allowed origins, asked before any call or download', () => {
    test('asks the helper for the allowed origins before the first gh command', () => {
      expect(resolve).toContain('connect.mjs" allowed-origins')
      expect(
        before('connect.mjs" allowed-origins', 'gh api --hostname github.com'),
      ).toBe(true)
      expect(
        before(
          'connect.mjs" allowed-origins',
          'gh run download <run> --repo github.com/<repo>',
        ),
      ).toBe(true)
      expect(resolve).not.toMatch(/gh (?:api|run) /)
    })

    test('matches the named repository to an origin without regard to case', () => {
      expect(resolve).toMatch(
        /`Fro-Bot\/Agent` matches the origin `fro-bot\/agent`/,
      )
    })

    test('compares the lowercase word with the origins and uses that form from then on', () => {
      expect(resolve).toMatch(/lowercase/)
      expect(resolve).toMatch(/`origins`/)
    })

    test('refuses a repository that is not an allowed origin, downloads nothing and names the remedy', () => {
      expect(resolve).toContain('`origin-not-allowed`')
      expect(resolve).toMatch(/Nothing was downloaded/)
      expect(resolve).toMatch(/allow-list a checkout of that repository/)
      expect(resolve).toMatch(/no `gh` command/)
    })

    test('stops on an origin two allowed checkouts share, as import would refuse it', () => {
      expect(resolve).toContain('`ambiguous`')
      expect(resolve).toContain('`repo-ambiguous`')
    })

    test('treats an unusable helper as helper-unavailable and never reads the config itself', () => {
      expect(resolve).toContain('`helper-unavailable`')
      expect(resolve).toMatch(/Never read the configuration yourself/)
    })

    test('does not print a local path', () => {
      expect(resolve).toMatch(/never prints a local path/i)
    })

    test('stops on an answer that is not ok or has no origins, reports the reason and runs no gh command', () => {
      expect(resolve).toMatch(/`ok: false`/)
      expect(resolve).toMatch(/without `origins`/)
      expect(resolve).toMatch(/helper's `reason`[^\n]*without running `gh`/)
    })
  })

  describe('every call is bound to github.com', () => {
    test('every gh api call names --hostname github.com, for a bare and a named word', () => {
      const calls = [...text.matchAll(/gh api\b[^\n]*/g)].map((m) => m[0])
      // run (bare), run (named), attempt, compare, artifact lookup, artifact list
      expect(calls.length).toBeGreaterThanOrEqual(6)
      for (const call of calls) {
        expect(call).toMatch(/^gh api --hostname github\.com /)
      }
    })

    test('every download names the repository as github.com/<owner>/<repo>, the bare Systematic download too', () => {
      const downloads = [...text.matchAll(/gh run download <run>[^\n]*/g)].map(
        (m) => m[0],
      )
      expect(downloads.length).toBe(2)
      for (const download of downloads) {
        expect(download).toMatch(
          / --repo github\.com\/(?:<repo>|marcusrbrown\/systematic) /,
        )
      }
      expect(text).not.toMatch(/--repo (?!github\.com\/)/)
    })

    test('says in one line why: the allow-list origin is a github.com origin', () => {
      expect(text).toMatch(
        /allow-list origin is a github\.com origin[^\n]*`GH_HOST` or a GHE remote must not redirect the checks/,
      )
    })
  })

  describe('a named word: the run', () => {
    test('reads the run of the named repository and accepts only schedule and workflow_dispatch', () => {
      expect(namedCheck).toContain(
        'gh api --hostname github.com "repos/<repo>/actions/runs/<run>"',
      )
      expect(namedCheck).toMatch(/`schedule` or `workflow_dispatch`/)
      expect(namedCheck).toContain('`unsupported-run-event`')
      expect(namedCheck).toContain('`run-not-found`')
      expect(namedCheck).toContain('`gh-not-authenticated`')
    })

    test("trusts no path of the run: a wrapper's own path proves nothing", () => {
      expect(namedCheck).toMatch(/wrapper's own path proves nothing/)
      expect(namedCheck).not.toContain('.github/workflows/connect')
    })
  })

  describe('a named word: the provenance of the exact attempt', () => {
    const SELECT = 'connect.mjs" verify-provenance <<'
    const CONFIRM = 'connect.mjs" verify-provenance --status'

    test('reads the named attempt first and stops when it does not exist', () => {
      expect(prove).toContain('actions/runs/<run>/attempts/<attempt>')
      expect(prove).toMatch(/attempt does not exist[^\n]*`run-not-found`/)
      expect(
        before('actions/runs/<run>/attempts/<attempt>', 'compare/main...<sha>'),
      ).toBe(true)
    })

    test('sends the text gh printed to the helper and never judges the list itself', () => {
      expect(prove).toContain(SELECT)
      expect(prove).toMatch(/the text `gh` printed, unchanged/)
      expect(prove).toMatch(/Never judge `referenced_workflows` yourself/)
      expect(prove).toMatch(
        /Never read the list, pick an entry or check a hash/i,
      )
      expect(before('actions/runs/<run>/attempts/<attempt>', SELECT)).toBe(true)
      expect(before(SELECT, 'compare/main...<sha>')).toBe(true)
    })

    test('describes what the helper decides without handing the decision back to the agent', () => {
      expect(prove).toContain(
        'marcusrbrown/systematic/.github/workflows/connect.yaml',
      )
      expect(prove).toMatch(/without regard to case/)
      expect(prove).toMatch(/40 lowercase hex/)
      expect(prove).toMatch(/never by position/i)
      expect(prove).not.toMatch(/Take the entries whose/)
      expect(prove).not.toMatch(/Match on that path/)
    })

    test('compares the default branch with the sha the helper named, in that direction', () => {
      expect(prove).toContain(
        'gh api --hostname github.com "repos/marcusrbrown/systematic/compare/main...<sha>" --jq .status',
      )
      expect(text).not.toContain('<sha>...main')
      expect(prove).toMatch(/`sha` the helper answered/)
      expect(prove).toMatch(/Never swap the two sides/)
    })

    test('sends the same text again with the compare status and goes on only on an accepted answer', () => {
      expect(prove).toContain(CONFIRM)
      expect(prove).toMatch(/the same text again/)
      expect(prove).toMatch(/`stage: "accepted"`/)
      expect(before('compare/main...<sha>', CONFIRM)).toBe(true)
      expect(before(CONFIRM, '### 4. Choose')).toBe(true)
      expect(prove).toMatch(/404[^\n]*`provenance-unprovable`/)
    })

    test('stops with the helper reason and a remedy when the helper refuses, and downloads nothing', () => {
      expect(prove).toMatch(/`ok: false`/)
      expect(prove).toContain('`provenance-unprovable`')
      expect(prove).toContain('`not-a-connect-run`')
      expect(prove).toMatch(/never download/i)
      expect(prove).toMatch(/without running `gh`/)
    })

    test('stops on a helper answer that is not one of its two refusals, with the helper reason', () => {
      expect(prove).toMatch(/any other `reason`/)
      expect(prove).toContain('`helper-unavailable`')
    })

    test('finishes before any download', () => {
      expect(before('### 3. Prove the provenance', '### 5. Download')).toBe(
        true,
      )
      expect(before('`provenance-unprovable`', 'gh run download <run>')).toBe(
        true,
      )
    })
  })

  describe('a bare word', () => {
    test('stays on the fixed repository and skips the origin check and the provenance proof', () => {
      expect(resolve).toMatch(/bare word[^\n]*skip to step 2/i)
      expect(bareCheck).toContain(
        'gh api --hostname github.com "repos/marcusrbrown/systematic/actions/runs/<run>"',
      )
      expect(bareCheck).toMatch(/skip step 3/i)
    })

    test('accepts a direct run and a wrapper run by the top-level path, with any @ref dropped', () => {
      expect(bareCheck).toContain('`.github/workflows/connect.yaml`')
      expect(bareCheck).toContain('`.github/workflows/connect-scheduled.yaml`')
      expect(bareCheck).toMatch(/Drop a trailing `@<ref>`/)
    })

    test('refuses any other workflow path and any other event', () => {
      expect(bareCheck).toMatch(/Any other path[^\n]*`not-a-connect-run`/)
      expect(bareCheck).toContain('`.github/workflows/fro-bot.yaml`')
      expect(bareCheck).toMatch(/`schedule` or `workflow_dispatch`/)
      expect(bareCheck).toContain('`unsupported-run-event`')
    })

    test('never reads referenced_workflows or an attempt record', () => {
      expect(text).toMatch(/A bare word never reads `referenced_workflows`/)
      expect(bareCheck).not.toContain('referenced_workflows')
      expect(bareCheck).not.toContain('attempts/')
      expect(resolve).not.toContain('referenced_workflows')
      expect(text.indexOf('--jq .referenced_workflows')).toBeGreaterThan(
        text.indexOf('### 3. Prove the provenance'),
      )
    })

    test('keeps the newest-attempt rule for a bare run with no attempt', () => {
      expect(choose).toMatch(/With a bare `fetch:<run>`[^\n]*highest attempt/)
    })
  })

  test('downloads the exact attempt of a named word and never falls back to another', () => {
    expect(choose).toMatch(
      /With `fetch:<owner>\/<repo>:<run>\.<attempt>`[^\n]*exactly `connect-run-<run>-<attempt>`/,
    )
    expect(choose).toMatch(/repos\/<repo>\/actions\/runs\/<run>\/artifacts/)
    expect(choose).toMatch(/never fall back to another attempt/i)
  })

  test('imports with the named repository, and says the commit is the caller wrapper commit', () => {
    expect(text).toMatch(
      /`<repo>` is `marcusrbrown\/systematic` for a bare word/,
    )
    expect(text).toMatch(/named repository for a named word/)
    expect(text).toMatch(
      /`head_sha`[^\n]*(?:caller|wrapper)[^\n]*not the callee/i,
    )
  })

  test('lets the import check the candidate projects after a named fetch passes', () => {
    expect(text).toMatch(
      /`import` still checks every project[^\n]*its own check/,
    )
    expect(text).toContain('`repo-not-allowed`')
  })

  test('gives a remedy for provenance-unprovable, in the step and in the table', () => {
    const row = reasons
      .split('\n')
      .find((line) => line.includes('| `provenance-unprovable` |'))
    for (const place of [prove, row ?? '']) {
      expect(place).toMatch(
        /calls `marcusrbrown\/systematic\/\.github\/workflows\/connect\.yaml` at a commit on Systematic's `main`/,
      )
      expect(place).toMatch(/try again later/i)
    }
  })

  test('says under the reasons table which client version fetches a connect-scheduled.yaml run, with no version number', () => {
    const after = section(
      text,
      '## Reasons the skill prints',
      '## Reasons a candidate is refused',
    )
    const note =
      after
        .split('\n')
        .find(
          (line) =>
            !line.startsWith('|') && line.includes('connect-scheduled.yaml'),
        ) ?? ''
    expect(note).toMatch(/release that includes this change/)
    expect(note).toMatch(/`not-a-connect-run`/)
    expect(note).toMatch(/runs of `connect.yaml` fetch on any version/i)
    expect(note).not.toMatch(/\d+\.\d+/)
    // The note sits below the table, not inside it.
    expect(note).not.toBe('')
    expect(after.indexOf(note)).toBeGreaterThan(
      after.indexOf('| `download-failed` |'),
    )
  })

  test('documents each new and reused stop reason in the reasons table', () => {
    for (const reason of [
      'origin-not-allowed',
      'provenance-unprovable',
      'repo-ambiguous',
      'not-a-connect-run',
      'run-not-found',
    ]) {
      expect(reasons, reason).toMatch(new RegExp(`\\| \`${reason}\` \\|`))
    }
  })
})

describe('ce:connect modes and terminal lines', () => {
  test('accepts exactly mode:headless and mode:interactive', () => {
    expect(skillText).toContain('`mode:headless`')
    expect(skillText).toContain('`mode:interactive`')
  })

  test('reads the mode from the invoking instruction when the host passes no arguments', () => {
    expect(skillText).toMatch(/invoking instruction/)
  })

  test('counts a repeated token once and stops on a conflict or an unknown token before dispatch', () => {
    expect(skillText).toMatch(/same `mode:` token (twice|more than once)/i)
    expect(skillText).toMatch(/conflicting mode/i)
    expect(skillText).toMatch(/unknown `mode:` token/i)
    expect(skillText).toMatch(/before (any )?(dispatch|the researcher)/i)
  })

  test('names the four terminal lines in the skill and in the outcomes reference', () => {
    for (const line of TERMINAL_LINES) {
      expect(skillText).toContain(`\`${line}\``)
      expect(outcomesText).toContain(`\`${line}\``)
    }
  })

  test('puts the reason and the artifact path before the final line', () => {
    expect(outcomesText).toMatch(/lines just before the final line/)
  })

  test('tells an unattended run to allow the state directory in the host permission config', () => {
    expect(outcomesText).toMatch(/external_directory/)
    expect(outcomesText).toMatch(/state directory/)
  })

  test('headless asks nothing and makes no offer after the digest', () => {
    expect(skillText).toMatch(/Headless mode asks no question/i)
    expect(outcomesText).toMatch(/headless/i)
  })

  test('refuses an unsupported or unobserved host in headless and asks consent in interactive', () => {
    expect(skillText).toMatch(/consent-required/)
    expect(skillText).toMatch(/unsupported-host/)
    expect(skillText).toContain('"consent": true')
  })
})

describe('ce:connect run protocol', () => {
  test('reports every host id the helper table knows, with the version command for each', () => {
    for (const host of CONNECT_HOSTS) expect(skillText).toContain(`\`${host}\``)
    expect(skillText).toMatch(/--version/)
  })

  test('says a missing or unobservable version is left out, never guessed', () => {
    expect(skillText).toMatch(/never guess/i)
  })

  test('passes the version string exactly as printed, leaving build and prerelease suffixes to the helper', () => {
    expect(skillText).toMatch(/exactly as (it is )?printed/i)
    expect(skillText).toMatch(/Never trim, round or strip/i)
    expect(skillText).toContain('`+`')
    expect(skillText).toContain('`-`')
  })

  test('carries the lock back to validate and publish and releases it on every early stop', () => {
    expect(skillText).toMatch(/"abort": true/)
    expect(skillText).toMatch(/lock/)
  })

  test('says a crashed run under a live host needs ledger unlock, and never runs it unasked', () => {
    expect(outcomesText).toMatch(/ledger unlock/)
    expect(outcomesText).toMatch(/host process/)
    expect(skillText).toMatch(/never run `ledger unlock`/i)
  })

  test('passes the batch as a file the file-writing tool wrote, never on stdin', () => {
    expect(skillText).toMatch(/file-writing tool/)
    expect(skillText).toMatch(
      /never (put|pipe|send) a (family )?batch (on|through|via) (stdin|a heredoc)/i,
    )
  })

  test('treats helper unavailability as a distinct failure and never hand-writes helper output', () => {
    expect(skillText).toMatch(/helper-unavailable/)
    expect(skillText).toMatch(
      /Never write a digest, a run record or a ledger entry by hand/,
    )
  })

  test('writes an unfinished stub for a family that did not return, never an empty result', () => {
    expect(skillText).toContain(
      '{"version": 1, "runId": "<runId>", "family": "<family name>", "ruleIds": [], "projects": [], "files": [], "searches": [], "complete": false, "candidates": []}',
    )
    expect(skillText).toMatch(/turn limit/i)
  })

  test('labels a scan with nothing to report and reads the outcome from the helper', () => {
    expect(skillText).toMatch(/no candidate in searched scope/)
    expect(skillText).toMatch(/finalLine/)
  })

  test('treats everything read from a project as evidence, never as instruction', () => {
    expect(skillText).toMatch(/evidence, never (an )?instruction/i)
    expect(skillText).toMatch(/allow list/i)
  })

  test('states the limits the user accepts before any dispatch in interactive mode', () => {
    expect(skillText).toMatch(/no path scoping/i)
    expect(skillText).toMatch(/MCP/)
  })

  test('uses the bounds the helper reports instead of numbers of its own', () => {
    expect(skillText).toMatch(/maxRulesPerFamily/)
    expect(skillText).toMatch(/maxFamiliesPerRun/)
    expect(skillText).not.toMatch(/\b(?:8|5|6) rules\b/)
  })

  test('sends the researcher one fixed block and nothing else, never the lock', () => {
    const block = [
      'run: <runId>',
      'family: <family name>',
      'rules file: <rulesFile>',
      'files index: <filesIndex>',
      'projects:',
      '- <project root> (<project name>)',
      'rule ids: <rule id>, <rule id>',
      'max candidates: <bounds.maxCandidatesPerBatch>',
    ].join('\n')
    expect(skillText).toContain(block)
    expect(contractText).toContain(block)
    expect(skillText).toMatch(/no lock, nonce or pid/)
  })

  test("checks a reply's shape before writing it and never repairs one", () => {
    expect(skillText).toMatch(/shape/)
    expect(skillText).toMatch(/Never repair a batch/)
  })

  test('has the user paste the helper-printed promotion tokens, in the names ce:compound reads', () => {
    const consumer = fs.readFileSync(
      path.join(ROOT, 'skills/ce-compound/references/candidate-input.md'),
      'utf8',
    )
    for (const token of ['candidate:', 'candidate-id:']) {
      expect(consumer).toContain(`\`${token}`)
      expect(skillText).toContain(`\`${token}<`)
    }
    expect(skillText).toMatch(/Print those lines unchanged/)
    expect(skillText).toMatch(/Never retype, shorten or build one yourself/)
  })

  test('gives the host permission line an unattended run needs, naming the state directory and leaving the write to the user', () => {
    expect(outcomesText).toContain('"external_directory"')
    expect(outcomesText).toContain('<state directory>/*')
    expect(outcomesText).toContain('$XDG_STATE_HOME/systematic/connect')
    expect(outcomesText).toMatch(/never writes this line for the user/i)
  })

  test('links the two references it ships', () => {
    expect(skillText).toContain('references/candidate-contract.md')
    expect(skillText).toContain('references/headless-and-outcomes.md')
  })

  test('uses no harness-specific skill directory variable', () => {
    for (const text of [skillText, contractText, outcomesText]) {
      expect(text).not.toMatch(/CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT/)
    }
  })
})

function section(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  const end = text.indexOf(to, start + from.length)
  if (start === -1 || end === -1) throw new Error(`no section ${from}`)
  return text.slice(start, end)
}

describe('ce:connect decide binds a decision to the digest revision', () => {
  const step7 = section(skillText, '## Step 7', '## Final line')
  const decideBlock =
    /connect\.mjs" decide <<'(JSON_[0-9a-f]+)'\n([\s\S]*?)\n\1\n/.exec(
      step7,
    )?.[2] ?? ''
  const paragraph = step7
    .split('\n\n')
    .find((text) => text.startsWith('Always send `revision`'))

  test('sends revision in the decide request, beside the id, status and reason', () => {
    expect(decideBlock).toContain('"id"')
    expect(decideBlock).toContain('"status"')
    expect(decideBlock).toContain('"reason"')
    expect(decideBlock).toContain('"revision": "<revision>"')
    expect(decideBlock).not.toMatch(/generation/i)
  })

  test('takes the value from the Revision line of the candidate, exactly as shown', () => {
    if (paragraph === undefined) throw new Error('no revision paragraph')
    expect(paragraph).toMatch(/12-character value on the `Revision:` line/)
    expect(paragraph).toMatch(/digest/)
    expect(paragraph).toMatch(/exactly as shown/)
    expect(paragraph).toMatch(/never one of your own/)
  })

  test('on stale-revision prints the hint and does not retry', () => {
    if (paragraph === undefined) throw new Error('no revision paragraph')
    expect(paragraph).toMatch(/`reason` `stale-revision`/)
    expect(paragraph).toMatch(/nothing was recorded/i)
    expect(paragraph).toMatch(/Print its `hint`/)
    expect(paragraph).toMatch(/do not retry/i)
  })

  test('does not mention generations any more', () => {
    expect(skillText).not.toMatch(/generation/i)
  })
})

describe('ce:connect rotation across runs', () => {
  const step4 = section(skillText, '## Step 4', '## Step 5')

  test('groups only the rules the helper offered, and every one of them', () => {
    expect(step4).toContain('offeredCount')
    expect(step4).toContain('offeredRuleIds')
    expect(step4).toMatch(/Group only the offered rules/)
    expect(step4).toMatch(/every offered rule/i)
    expect(step4).toMatch(/exactly one family/i)
  })

  test('reads the offered rules from the head of the rule overview and leaves the later ones out', () => {
    expect(step4).toContain('`offered`')
    expect(step4).toContain('`later`')
    expect(step4).toMatch(/first `offeredCount` lines/)
    expect(step4).toMatch(/never add a rule marked `later`/i)
  })

  test('does not let the model choose which rules to cover', () => {
    expect(step4).toMatch(/do(es)? not choose which rules/i)
    expect(step4).not.toMatch(/prefer groups that span/i)
    expect(step4).not.toMatch(/rules you leave out/i)
    expect(step4).not.toMatch(/leave (a rule |rules )?out/i)
  })

  test('keeps grouping by shared subject, within the bounds the helper reports', () => {
    expect(step4).toMatch(/shared subject/)
    expect(step4).toContain('applies_when')
    expect(step4).toContain('bounds.maxRulesPerFamily')
    expect(step4).toContain('bounds.maxFamiliesPerRun')
  })

  test('tells the researcher to search every allowed project, rules from later slices included', () => {
    const step5 = section(skillText, '## Step 5', '## Step 6')
    expect(step5).toMatch(/every allowed project/i)
    expect(step5).toMatch(/marked `later`/)
    expect(step5).toMatch(/contradiction/i)
    // The agent already does so: it searches the other allowed projects whatever their rules.
    expect(agent.body).toMatch(/Search the other allowed projects/)
    expect(agent.body).toMatch(/A project other than the rule's own/)
  })

  test('reports the sweep progress from the helper and keeps it in the printed summary', () => {
    expect(skillText).toContain('`sweep`')
    expect(skillText).toMatch(/covered X of Y rules/)
    expect(skillText).toMatch(/Print the `summary` as the helper wrote it/)
  })

  test('defines complete as the offered slice covered, and a partly covered corpus as progress', () => {
    const row = outcomesText
      .split('\n')
      .find((line) => line.startsWith('| `Connect complete`'))
    expect(row).toMatch(/offered/i)
    expect(row).toMatch(/nothing failed/i)
    expect(row).toMatch(/not (a )?degrad/i)
    expect(outcomesText).toMatch(/sweep progress/i)
    expect(outcomesText).toMatch(/covered X of Y rules/)
    expect(outcomesText).toMatch(/runs left/)
    expect(outcomesText).toMatch(/least recently covered/i)
  })

  test('says the rules a run leaves for later do not degrade it', () => {
    expect(outcomesText).toMatch(
      /rules (that are )?not offered .*(not|never) .*degrad/i,
    )
  })

  test('says ledger clear starts the sweep over', () => {
    expect(outcomesText).toMatch(/ledger clear/)
    expect(outcomesText).toMatch(/starts? (the sweep )?over/i)
  })

  test('describes the columns of the rule overview, ending with the project key, in the contract reference', () => {
    expect(contractText).toContain('rule overview')
    expect(contractText).toContain('`offered`')
    expect(contractText).toContain('`later`')
    expect(contractText).toMatch(/a mark and the project key/)
  })
})

describe('candidate contract reference', () => {
  test('states the batch version the helper accepts', () => {
    expect(contractText).toContain(`"version": ${BATCH_VERSION}`)
  })

  test('lists every candidate kind and next step the helper accepts', () => {
    for (const kind of CANDIDATE_KINDS)
      expect(contractText).toContain(`\`${kind}\``)
    for (const step of NEXT_STEPS) expect(contractText).toContain(`\`${step}\``)
  })

  test('states every field limit the helper enforces, in its table', () => {
    for (const [name, value] of Object.entries(CANDIDATE_LIMITS)) {
      expect(contractText).toContain(`| \`${name}\` | ${value} |`)
    }
  })

  test('names every batch and candidate field', () => {
    for (const field of [
      'runId',
      'family',
      'ruleIds',
      'projects',
      'files',
      'searches',
      'complete',
      'candidates',
      'kind',
      'reason',
      'ruleId',
      'target',
      'title',
      'summary',
      'nextStep',
      'overlapCheck',
      'sources',
      'targetEvidence',
      'counterevidence',
      'fingerprint',
      'excerpt',
      'symbol',
    ]) {
      expect(contractText).toContain(`\`${field}\``)
    }
  })
})

describe('connections-researcher agent', () => {
  test('is named exactly as the OpenCode v2 tool guard keys on', () => {
    expect(READ_ONLY_AGENT_NAMES).toContain(String(agent.data.name))
    expect(agent.data.name).toBe('connections-researcher')
  })

  test('has no model, a finite temperature, a valid color and the subagent mode', () => {
    expect(agent.data.model).toBeUndefined()
    expect(agent.data.mode).toBe('subagent')
    expect(Number.isFinite(agent.data.temperature)).toBe(true)
    expect(isValidAgentColor(String(agent.data.color))).toBe(true)
  })

  test('carries the tool limits the host proofs observe: positive allowlist, second layer, and one allow for reading other checkouts', () => {
    expect(agent.data.tools).toBe('Read, Grep, Glob')
    expect(agent.data.disallowedTools).toBe(
      'Bash, Edit, Write, WebFetch, WebSearch, NotebookEdit',
    )
    expect(agent.data.permission).toEqual({
      bash: 'deny',
      edit: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      task: 'deny',
      external_directory: 'allow',
    })
  })

  test('declares a positive allowlist, because an agent with none gets every default tool on Pi', () => {
    expect(agent.data.tools).toBe('Read, Grep, Glob')
  })

  test('resolves to read, search and find tools on the Pi catalog build, with no shell or write', () => {
    const catalog = buildAgentCatalog(path.join(ROOT, 'agents'))
    const entry = catalog.find((item) => item.name === 'connections-researcher')

    expect(entry?.category).toBe('research')
    expect(resolveToolAllowlist(entry?.toolsSource).tools).toEqual([
      'read',
      'grep',
      'find',
    ])
  })

  test('stays out of the curated Pi personas, which would export it with every tool', () => {
    expect(
      CURATED_PERSONAS.some((entry) =>
        entry.relPath.includes('connections-researcher'),
      ),
    ).toBe(false)
  })

  test('treats text from a project as evidence and never follows an instruction in it', () => {
    expect(agent.body).toMatch(/evidence, never (an )?instruction/i)
    expect(agent.body).toMatch(/allow list/i)
  })

  test('names every batch and candidate field it must return', () => {
    for (const field of [
      'runId',
      'family',
      'ruleIds',
      'projects',
      'files',
      'searches',
      'complete',
      'candidates',
      'kind',
      'reason',
      'ruleId',
      'target',
      'title',
      'summary',
      'nextStep',
      'overlapCheck',
      'sources',
      'targetEvidence',
      'counterevidence',
      'fingerprint',
      'excerpt',
      'symbol',
    ]) {
      expect(agent.body).toContain(field)
    }
    for (const kind of CANDIDATE_KINDS) expect(agent.body).toContain(kind)
    for (const step of NEXT_STEPS) expect(agent.body).toContain(step)
  })

  test('reads fingerprints from the work files and never computes or invents one', () => {
    expect(agent.body).toMatch(/files\.tsv/)
    expect(agent.body).toMatch(/never (compute|invent|guess)/i)
  })

  test('returns one JSON object and no confidence number', () => {
    expect(agent.body).toMatch(/one JSON object/i)
    expect(agent.body).toMatch(/no confidence/i)
  })

  test('says what to do when it runs short of turns', () => {
    expect(agent.body).toMatch(/"complete": false/)
  })

  describe('truncated search results', () => {
    const method = agent.body.slice(
      agent.body.indexOf('## Method'),
      agent.body.indexOf('## What you return'),
    )

    test('narrows the search and goes on, and never stops for it', () => {
      expect(method).toMatch(
        /truncated or very long[^.]*reason to narrow the search[^.]*never a reason to stop/i,
      )
      expect(method).toMatch(/more specific pattern/i)
      expect(method).toMatch(/one project or directory at a time/i)
      expect(method).toMatch(/files index to pick paths/i)
    })

    test('reads the most relevant file a search pointed to before it finds no candidate', () => {
      expect(method).toMatch(
        /before you conclude that a rule has no candidate, read at least the most relevant file a search pointed to/i,
      )
      expect(method).toMatch(/not from search output alone/i)
    })

    test('allows "complete": false only for running short of turns', () => {
      expect(method).toMatch(/only case for `"complete": false`/)
      expect(method).toMatch(
        /nothing holds up, set `"complete": true` with no candidates/,
      )
      expect(method).toMatch(/at most 20 turns in total/)
    })
  })

  test('has no SKILL_DIR or script path, because it cannot reach the skill directory', () => {
    expect(agentText).not.toMatch(/SKILL_DIR|connect\.mjs/)
  })

  describe('free-text caps', () => {
    const lineWith = (needle: string): string =>
      agent.body.split('\n').find((line) => line.includes(needle)) ?? ''
    const titleLine = lineWith('"title": "<')
    const summaryLine = lineWith('"summary": "<')
    const overlapLine = lineWith('"overlapCheck": {')
    const afterTemplate = agent.body.slice(
      agent.body.indexOf('- `ruleIds` lists'),
    )

    test('states the cap next to each free-text field in the output template', () => {
      expect(titleLine).toMatch(
        new RegExp(`at most ${CANDIDATE_LIMITS.title} characters`),
      )
      expect(summaryLine).toMatch(
        new RegExp(`at most ${CANDIDATE_LIMITS.summary} characters`),
      )
      expect(overlapLine).toMatch(
        new RegExp(`at most ${CANDIDATE_LIMITS.query} characters`),
      )
      expect(overlapLine).toMatch(
        new RegExp(`at most ${CANDIDATE_LIMITS.note} characters`),
      )
    })

    test('gives a target below the cap so a draft lands inside it', () => {
      expect(titleLine).toMatch(/under about 120/)
      expect(summaryLine).toMatch(/about 4 short sentences/)
      expect(summaryLine).toMatch(/about 600 characters/)
    })

    test('measures each title, summary and note before answering and cuts one that is over', () => {
      expect(afterTemplate).toMatch(
        /before you answer[^.]*(measure|count)[^.]*title[^.]*summary[^.]*note/i,
      )
      expect(afterTemplate).toMatch(
        /over its cap[^.]*cut it[^.]*already in (the|an) excerpt/i,
      )
      expect(afterTemplate).toMatch(/never answer with an over-length field/i)
    })

    test('gives the reason: the helper drops the whole candidate and the finding is lost', () => {
      expect(afterTemplate).toMatch(
        /helper drops the whole candidate[^.]*finding is lost/i,
      )
    })

    test('returns at most one candidate per rule and target, folding several gaps into its target evidence', () => {
      expect(afterTemplate).toMatch(
        /at most one candidate (for|per) (each|every) rule and target/i,
      )
      expect(afterTemplate).toMatch(
        /several gaps in the same target[^.]*that one candidate[^.]*own `targetEvidence` entry/i,
      )
      expect(afterTemplate).toMatch(
        /summary within its cap[^.]*duplicate[^.]*finding is lost/i,
      )
    })

    test('every cap number in the prompt equals CANDIDATE_LIMITS, so the two cannot drift', () => {
      const capSentence = lineWith('Free text (`title`')
      const stated = {
        title: /title (\d+) characters/,
        summary: /summary (\d+)/,
        note: /note (\d+)/,
        query: /query (\d+)/,
      } as const
      for (const [name, pattern] of Object.entries(stated)) {
        const match = capSentence.match(pattern)
        expect(match?.[1]).toBe(
          String(CANDIDATE_LIMITS[name as keyof typeof stated]),
        )
      }
      const template = [titleLine, summaryLine, overlapLine].join('\n')
      const templateCaps = [...template.matchAll(/at most (\d+) characters/g)]
        .map((match) => Number(match[1]))
        .sort((a, b) => a - b)
      expect(templateCaps).toEqual(
        [
          CANDIDATE_LIMITS.title,
          CANDIDATE_LIMITS.summary,
          CANDIDATE_LIMITS.note,
          CANDIDATE_LIMITS.query,
        ].sort((a, b) => a - b),
      )
    })
  })
})

describe('code-mismatch kind in the researcher prompt and the contract text', () => {
  test('the candidate contract states the reasons, the evidence rules and the handoff for the kind', () => {
    expect(contractText).toContain('`code-mismatch`')
    expect(contractText).toContain('`stale`')
    expect(contractText).toContain('`unscoped`')
    expect(contractText).toMatch(
      /`code-mismatch`[^\n]*one source[^\n]*learning in the target/i,
    )
    expect(contractText).toMatch(/`start` and `end`/)
    expect(contractText).toMatch(
      /`refresh-learning`[^\n]*at least one `counterevidence`/,
    )
    expect(contractText).toMatch(/\/ce:compound-refresh path:/)
  })

  test('the researcher prompt teaches the method: a present-tense claim, checked against code at the governing revision', () => {
    expect(agent.body).toMatch(/present-tense claim/)
    expect(agent.body).toMatch(/governing revision/)
    expect(agent.body).toMatch(/pins?\b/i)
    expect(agent.body).toMatch(/true at the pin is never `stale`/)
  })

  test('the researcher prompt checks several claims of a learning and sends one code-mismatch candidate per claim and reason', () => {
    const lineWith = (needle: string): string =>
      agent.body.split('\n').find((line) => line.includes(needle)) ?? ''
    const method = lineWith('Code-mismatch test.')
    expect(method).not.toMatch(/Check one such claim/i)
    expect(method).toMatch(
      /Check the present-tense claims[^.]*(within|bounded by)[^.]*(turns|bounds)/i,
    )
    const limit = lineWith('at most one candidate for each rule and target')
    expect(limit).toMatch(
      /`contradiction` and `transferable-lesson`[^.]*at most one candidate for each rule and target/i,
    )
    expect(limit).toMatch(
      /`code-mismatch`[^.]*separate candidate for each claim and reason/i,
    )
  })

  test('the researcher prompt skips a learning that describes past behaviour on purpose', () => {
    expect(agent.body).toMatch(
      /deliberately describes? (what was|past behaviou?r)|describes past behaviou?r/i,
    )
    expect(agent.body).toMatch(/never a candidate|is not a candidate/i)
  })

  test('the researcher prompt requires positive evidence and rejects an absence or a different spelling', () => {
    expect(agent.body).toMatch(/positive[^.]*excerpt/i)
    expect(agent.body).toMatch(/empty search|search that found nothing/i)
    expect(agent.body).toMatch(
      /different spelling[^.]*not (enough|evidence)|merely spells/i,
    )
  })

  test('the researcher prompt shows a dependency pin as a cited excerpt or an unverified note, else investigate', () => {
    expect(agent.body).toMatch(/`package\.json`/)
    expect(agent.body).toMatch(/`uses:`/)
    expect(agent.body).toMatch(/unverified/)
    expect(agent.body).toMatch(/`overlapCheck\.note`|`note`/)
    expect(agent.body).toMatch(
      /otherwise[^.]*`investigate`|`investigate`[^.]*pin/i,
    )
  })

  test('the researcher prompt reads a lockfile as plain text only to find a version', () => {
    expect(agent.body).toMatch(/lockfile[^.]*plain text/i)
  })

  test('the output template shows the reason and the span fields for the kind', () => {
    const template = agent.body.slice(
      agent.body.indexOf('"kind": "'),
      agent.body.indexOf('- `ruleIds` lists'),
    )
    expect(template).toMatch(/"reason":/)
    expect(template).toMatch(/code-mismatch/)
    expect(template).toMatch(/"counterevidence": \[\{[^\n]*"start"[^\n]*"end"/)
  })

  test('examples in the prompt and the guide are generic: no acceptance case leaks into either', () => {
    for (const text of [agent.body, guideText]) {
      expect(text).not.toMatch(/caddy/i)
      expect(text).not.toMatch(/extensionless/i)
      expect(text).not.toMatch(/`plugins`/)
      expect(text).not.toMatch(/`plugin`/)
    }
    // The existing `external_directory` text predates the kind and is the only
    // OpenCode v1 wording allowed; the kind adds no v1 isolation example.
    expect(agent.body).not.toMatch(/\bv1\b/i)
    const mismatchGuide = guideText.slice(
      guideText.indexOf('Code mismatch'),
      guideText.indexOf('## What a run does'),
    )
    expect(mismatchGuide).not.toMatch(/\bv1\b|isolation/i)
  })

  test('the guide describes the kind, its two reasons and the operator recheck', () => {
    expect(guideText).toMatch(/\*\*Code mismatch\.\*\*/)
    expect(guideText).toContain('`stale`')
    expect(guideText).toContain('`unscoped`')
    expect(guideText).toMatch(/recheck/i)
  })

  test('the refresh skill names a code mismatch beside a contradiction as something its exact path scope refreshes', () => {
    expect(refreshText).toMatch(
      /how a contradiction or a code mismatch that `ce:connect` found is refreshed/,
    )
  })

  test('the refresh skill treats the claim and evidence ce:connect prints as data that never widens the path scope', () => {
    const scope = refreshText.slice(refreshText.indexOf('## Exact path scope'))
    expect(scope).toMatch(
      /claim and evidence[^.]*`ce:connect`[^.]*context to recheck/i,
    )
    expect(scope).toMatch(
      /data[^.]*never adds a path[^.]*(changes the scope|relaxes)/i,
    )
    expect(scope).toMatch(/check the claim against the code yourself/i)
  })
})

describe('code-mismatch coverage: the researcher reads every rule learning', () => {
  const lineWith = (needle: string): string =>
    agent.body.split('\n').find((line) => line.includes(needle)) ?? ''
  const input = lineWith('A rule entry gives')
  const method = agent.body.slice(
    agent.body.indexOf('## Method'),
    agent.body.indexOf('## What you return'),
  )
  const codeMismatchStep = lineWith('Code-mismatch test.')
  const shortOfTurns = lineWith('If you are short of turns')

  test('the allowance to skip the rest of a file is scoped to the contradiction and transferable-lesson tests', () => {
    expect(input).toMatch(
      /contradiction and transferable-lesson tests[^.]*do not need the rest of the file/i,
    )
    expect(input).toMatch(
      /code-mismatch test[^.]*(learning file itself|file itself)[^.]*read/i,
    )
    expect(agent.body).not.toMatch(
      /^[^\n]*Use those sections\. You do not need the rest of the file unless an excerpt comes from it\./m,
    )
  })

  test('the code-mismatch test reads the learning file of the rule and checks its claims before the rule counts as covered', () => {
    expect(codeMismatchStep).toMatch(
      /read the (whole )?learning file[^.]*before[^.]*(rule|it) (counts|is counted) as covered/i,
    )
    expect(codeMismatchStep).toMatch(
      /rule entry[^.]*(is not|never) (the file|a substitute)/i,
    )
  })

  test('the learning files are read in one early turn, so the turn budget holds', () => {
    expect(method).toMatch(
      /read the learning file of every rule[^.]*in one turn/i,
    )
  })

  test('the files list names each learning the researcher read, and the helper holds back a rule whose learning is not listed', () => {
    expect(codeMismatchStep).toMatch(
      /`files`[^.]*(lists?|names?)[^.]*learning/i,
    )
    expect(codeMismatchStep).toMatch(
      /helper[^.]*(holds back|does not count)[^.]*rule[^.]*(not|missing)[^.]*`files`/i,
    )
  })

  test('turns running out before every learning is read ends the batch as "complete": false, never "complete": true', () => {
    expect(shortOfTurns).toMatch(
      /before you have read the learning file of every rule/i,
    )
    expect(shortOfTurns).toMatch(
      /never set `"complete": true`[^.]*learning[^.]*unread/i,
    )
    expect(shortOfTurns).toMatch(/only case for `"complete": false`/)
  })

  test('the files cap in the prompt equals the cap in the contract, and the learnings are listed first', () => {
    const contractCap = contractText.match(/\| `files` \|[^|]*up to (\d+)/)?.[1]
    expect(contractCap).toBe('50')
    const stated = agent.body.match(/`files`[^.]*at most (\d+) entries/)?.[1]
    expect(stated).toBe(contractCap)
    expect(agent.body).toMatch(/`files`[^.]*learnings? first/i)
  })

  test('the contract text says coverage needs the learning in `files`', () => {
    const coverage = contractText.slice(
      contractText.indexOf('Coverage is checked'),
      contractText.indexOf('## A candidate'),
    )
    expect(coverage).toMatch(
      /complete batch[^.]*names[^.]*learning[^.]*`files`[^.]*(not covered|degrade)/i,
    )
    expect(contractText).toMatch(/\| `complete` \|[^\n]*every rule's learning/i)
  })
})

describe('code-mismatch judgement: a contract is not stale for an implementation detail', () => {
  const step = agent.body
    .split('\n')
    .find((line) => line.includes('Code-mismatch test.'))
  const section = agent.body.slice(
    agent.body.indexOf('5. Code-mismatch test.'),
    agent.body.indexOf('6. For each candidate'),
  )

  test('a claim about a documented contract is not stale because an implementation detail differs', () => {
    expect(step).toBeDefined()
    expect(section).toMatch(
      /claim about a documented contract or interface[^.]*not `stale` merely because an implementation detail differs/i,
    )
    expect(section).toMatch(/sort order/i)
  })

  test('positive evidence must contradict the contract itself, else the next step is investigate', () => {
    expect(section).toMatch(
      /positive evidence[^.]*contradict the contract itself[^.]*`investigate`/i,
    )
  })
})

describe('ce:connect pin hints: the skill copies the helper lines, as data, by project key', () => {
  const step3 = section(skillText, '## Step 3', '## Step 4')
  const step4 = section(skillText, '## Step 4', '## Step 5')
  const step5 = section(skillText, '## Step 5', '## Step 6')
  const step7 = section(skillText, '## Step 7', '## Final line')
  const baseBlock = [
    'rule ids: <rule id>, <rule id>',
    'max candidates: <bounds.maxCandidatesPerBatch>',
  ].join('\n')
  const hintParagraph = section(step5, 'Pin hints.', 'Wait for the reply')
  const hintBlock = /```text\n(rule ids:[\s\S]*?)\n```/.exec(hintParagraph)?.[1]

  test('step 3 lists pinHints and pinNotes among the fields of a begun answer, and the limits statement shows the notes', () => {
    const fields = step3.slice(step3.indexOf('- `begun`'))
    expect(fields.split('\n')[0]).toContain('`pinHints`')
    expect(fields.split('\n')[0]).toContain('`pinNotes`')
    const limits = step3.slice(step3.indexOf('### Interactive mode'))
    expect(limits).toContain('`pinNotes`')
    expect(limits).toMatch(/why a declared pin gave no line/i)
  })

  test('step 4 says the last overview column is the rule project key, which step 5 matches on', () => {
    expect(step4).toMatch(
      /rule id, project name, path, title, `applies_when` items, a mark and the project key/,
    )
    expect(step4).toMatch(/last column[^.]*project key/i)
    expect(step4).not.toMatch(/\bsix\b/i)
  })

  test('step 5 keeps the fixed block exactly as before: the pin hints section is not part of it', () => {
    expect(step5).toContain('max candidates: <bounds.maxCandidatesPerBatch>')
    const base = step5.slice(
      step5.indexOf('```text'),
      step5.indexOf('```', step5.indexOf('```text') + 7),
    )
    expect(base).not.toContain('pin hints:')
  })

  test('step 5 puts an optional pin hints section between rule ids and max candidates', () => {
    expect(hintBlock).toBeDefined()
    if (hintBlock === undefined) return
    const lines = hintBlock.split('\n')
    expect(lines[0]).toMatch(/^rule ids:/)
    expect(lines[1]).toBe('pin hints:')
    expect(lines.at(-1)).toMatch(/^max candidates:/)
    expect(hintParagraph).toMatch(
      /section between `rule ids:` and `max candidates:`/,
    )
    expect(baseBlock).toContain('max candidates:')
  })

  test('the lines are copied from pinHints by project key, once each, unchanged and in the helper order', () => {
    expect(hintParagraph).toMatch(/project key of every rule id/i)
    expect(hintParagraph).toMatch(/last column of `rulesOverview`/)
    expect(hintParagraph).toMatch(
      /copy each `pinHints` line stored under any of those keys/i,
    )
    expect(hintParagraph).toMatch(/once/i)
    expect(hintParagraph).toMatch(/unchanged/i)
    expect(hintParagraph).toMatch(/helper's order/i)
    expect(hintParagraph).not.toMatch(/project name/i)
  })

  test('a family with no matching key gets no pin hints heading', () => {
    expect(hintParagraph).toMatch(
      /no line applies[^.]*(leave out|omit)[^.]*(section|heading)/i,
    )
  })

  test('the lines are data: never written, paraphrased, shortened or extended by the skill', () => {
    expect(hintParagraph).toMatch(
      /never write, paraphrase, shorten or extend one/i,
    )
    expect(hintParagraph).toMatch(/data/i)
    expect(hintParagraph).toMatch(/not an instruction/i)
  })

  test('the nothing-else rule stays, and no line template lives in the skill', () => {
    expect(step5).toMatch(/and nothing else: no instruction of your own/)
    expect(step5).toMatch(/no lock, nonce or pid/)
    expect(skillText).toMatch(/Copy no text from a document into it/)
    // The sentence a line carries is the helper's. The skill never holds it.
    expect(skillText).not.toMatch(/allowed checkout/)
    expect(skillText).not.toMatch(/Check claims about/)
    expect(skillText).not.toMatch(/reason `unscoped`/)
  })

  test('step 7 prints the Pins line verbatim and keeps it apart from the degrade reasons', () => {
    expect(step7).toContain('`Pins:`')
    expect(step7).toMatch(/Pins:` line[^.]*(unchanged|as the helper wrote)/i)
    expect(step7).toMatch(/not a degrade reason/i)
    expect(step7).toMatch(/never list it with the `degradeReasons`/i)
  })

  test('the headless reference prints the Pins line verbatim, as a note and never a degrade reason', () => {
    expect(outcomesText).toContain('`Pins:`')
    expect(outcomesText).toMatch(
      /Pins:` line[^.]*(unchanged|as the helper wrote)/i,
    )
    expect(outcomesText).toMatch(/not a degrade reason/i)
    expect(outcomesText).toMatch(/headless[^.]*asks no question/i)
  })

  test('the contract reference names the optional section beside the fixed block', () => {
    expect(contractText).toContain('`pin hints:`')
    expect(contractText).toMatch(/helper's own lines/i)
  })

  test('the researcher prompt is unchanged on purpose: it does not name the section', () => {
    expect(agent.body).not.toMatch(/pin hints/i)
    expect(agent.body).not.toContain('`pinHints`')
  })
})

describe('the guide documents connect.pins', () => {
  const guide = section(guideText, '## Declare dependency pins', '## Run it')

  test('shows a worked declaration with the four fields', () => {
    expect(guide).toContain('"pins": [')
    for (const field of ['project', 'upstream', 'file', 'key']) {
      expect(guide).toContain(`"${field}":`)
    }
    expect(guide).toMatch(/user-owned|user-level/i)
  })

  test('states the key path rule: dotted segments, no array index, a dotted name cannot be addressed', () => {
    expect(guide).toMatch(/dotted/i)
    expect(guide).toMatch(/array index/i)
    expect(guide).toMatch(/contains a dot[^.]*cannot be addressed/i)
    expect(guide).toMatch(/JSON or JSONC/)
    expect(guide).toMatch(/working tree/i)
  })

  test('says an unknown version stays unknown, with --no-tags and the CI clone in one sentence', () => {
    expect(guide).toContain('`unknown`')
    const sentence = guide
      .split(/(?<=\.)\s/)
      .find((text) => text.includes('--no-tags'))
    expect(sentence).toBeDefined()
    expect(sentence).toMatch(/scheduled workflow/i)
    expect(sentence).toMatch(/always `unknown`/)
    expect(guide).toMatch(/stored in a pack/i)
    expect(guide).toMatch(/is at/i)
    expect(guide).toMatch(/context, not attestation/i)
  })

  test('says a pin with no selected matching checkout is silent and opens nothing', () => {
    expect(guide).toMatch(/dropped silently/i)
    expect(guide).toMatch(/no note/i)
    expect(guide).toMatch(/opens nothing/i)
  })

  test('gives the root charset and that a root outside it gets no line', () => {
    expect(guide).toContain('[A-Za-z0-9._/-]')
    expect(guide).toMatch(/256/)
    expect(guide).toMatch(/gets no line/i)
  })

  test('lists every note code the helper can return', () => {
    for (const code of [
      'pin-file-missing',
      'pin-file-too-large',
      'pin-file-invalid',
      'pin-key-absent',
      'pin-value-invalid',
      'pin-conflict',
      'hints-truncated',
      'notes-truncated',
    ]) {
      expect(guide).toContain(`\`${code}\``)
    }
    expect(guide).toContain('`Pins:`')
    expect(guide).toMatch(/do(es)? not degrade|never degrade/i)
  })

  test('says a line is a hint, not evidence, and that a missing line is not an error', () => {
    expect(guide).toMatch(/hint, not evidence/i)
    expect(guide).toMatch(/not an error/i)
  })

  test('shows the line exactly as the helper renders it', () => {
    const project: PinProject = {
      entry: '~/src/github.com/me/app',
      root: '/home/me/src/github.com/me/app',
      key: '0123456789ab',
    }
    const checkout: PinProject = {
      entry: '~/src/github.com/upstream-org/host-lib-old',
      root: '/home/me/src/github.com/upstream-org/host-lib-old',
      key: 'ba9876543210',
      repo: 'upstream-org/host-lib',
      commit: 'a'.repeat(40),
    }
    const { hints } = resolvePins(
      [
        {
          project: project.entry,
          upstream: 'upstream-org/host-lib',
          file: 'config/pins.json',
          key: 'host.version',
        },
      ],
      [project, checkout],
      {
        readPin: () => ({ kind: 'ok', value: '2.3.2' }),
        readTag: () => ({ kind: 'tag', name: '1.4.0' }),
      },
    )
    const [line] = hints[project.key] ?? []
    expect(line).toBeDefined()
    expect(guide).toContain(`${line}`)
  })

  test('uses no acceptance-case example', () => {
    expect(guide).not.toMatch(/caddy|extensionless|`plugins?`/i)
  })
})
