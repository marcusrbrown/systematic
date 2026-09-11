import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function fencedBlocks(text: string): string[] {
  const blocks: string[] = []
  let current: string[] | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      if (current === undefined) {
        current = []
      } else {
        blocks.push(current.join('\n'))
        current = undefined
      }
      continue
    }
    current?.push(line)
  }
  return blocks
}

const SKILL = read('skills/ce-review/SKILL.md')
const SKILL_NORM = normalize(SKILL)
const SYNTH = read('skills/ce-review/references/synthesis-artifact-contract.md')
const SYNTH_NORM = normalize(SYNTH)
const OUTPUT = read('skills/ce-review/references/review-output-template.md')
const OUTPUT_NORM = normalize(OUTPUT)
const SUBAGENT = read('skills/ce-review/references/subagent-template.md')
const SUBAGENT_NORM = normalize(SUBAGENT)
const HARNESSES_NORM = normalize(read('HARNESSES.md'))

const rawValidatorBlock = fencedBlocks(SKILL).find((block) =>
  block.includes('validate-review.mjs" return'),
)

describe('ce:review raw-return admission contract', () => {
  test('feeds returned payloads to the skill-local validator before parsing or screening', () => {
    expect(rawValidatorBlock).toBeDefined()
    expect(SKILL_NORM).toContain(
      'node "$SKILL_DIR/scripts/validate-review.mjs" return',
    )
    expect(SKILL_NORM).toMatch(
      /before (?:parsing|any field parse|environment-value screening|synthesis|persistence)/i,
    )
  })

  test('the raw-validator block is self-contained and stdin-only', () => {
    const block = rawValidatorBlock ?? ''
    // Model-filled SKILL_DIR anchor with a terminating semicolon.
    expect(block).toMatch(/SKILL_DIR="[^"]*";/)
    // Single-quoted heredoc delimiter: no shell interpolation of the payload.
    expect(block).toMatch(/<<'[A-Z0-9_]+'/)
    // Payload never appears in argv: the node command line carries no JSON.
    const nodeLine = block
      .split('\n')
      .find((line) => line.includes('validate-review.mjs" return'))
    expect(nodeLine).toBeDefined()
    expect(nodeLine).not.toContain('{')
  })

  test('explicitly forbids interpolation and command substitution for the payload', () => {
    expect(SKILL_NORM).toMatch(/single-quoted heredoc/i)
    expect(SKILL_NORM).toMatch(/command substitution/i)
  })

  test('maps lifecycle and validator exits to dispatch outcomes', () => {
    for (const token of ['never_returned', 'malformed', 'empty', 'findings']) {
      expect(SKILL_NORM).toContain(token)
    }
    // exit 0 -> admitted then screened; exit 1 -> malformed; exit 2 -> unavailable
    expect(SKILL_NORM).toMatch(/exit 0/i)
    expect(SKILL_NORM).toMatch(/exit 1/i)
    expect(SKILL_NORM).toMatch(/exit 2/i)
    expect(SKILL_NORM).toMatch(/validation unavailable/i)
    // never_returned is a lifecycle fact, not a validator result
    expect(SKILL_NORM).toMatch(
      /never_returned[^.]*lifecycle|lifecycle[^.]*never_returned/i,
    )
    // unavailable must be explicitly distinct from malformed/never_returned
    expect(SKILL_NORM).toMatch(
      /validation unavailable[^.]*(?:not|never)[^.]*(?:malformed|never_returned)|(?:not|never)[^.]*(?:malformed|never_returned)[^.]*validation unavailable/i,
    )
  })

  test('binds the admitted return reviewer to the dispatched persona before screening or persistence', () => {
    for (const doc of [SKILL_NORM, SYNTH_NORM]) {
      // The parent must compare the returned identity to the dispatch identity.
      expect(doc).toMatch(
        /reviewer[^.]*(?:equals|matches|match)[^.]*dispatched persona/i,
      )
      // A mismatch is rejected or degraded before persistence/synthesis.
      expect(doc).toMatch(
        /identity mismatch[^.]*(?:reject|malformed|degrad)|(?:reject|malformed|degrad)[^.]*identity mismatch/i,
      )
    }

    // The binding gate lives in the raw-admission stage, before synthesis.
    const identityIndex = SKILL_NORM.search(/dispatch identity binding/i)
    const mergeIndex = SKILL_NORM.search(/### Stage 5: Merge findings/i)
    expect(identityIndex).toBeGreaterThanOrEqual(0)
    expect(mergeIndex).toBeGreaterThan(identityIndex)
  })

  test('orders identity binding after structural admission/parse and before screening, persistence, and synthesis', () => {
    const admissionIndex = SKILL_NORM.search(/structurally admitted/i)
    const parseIndex = SKILL_NORM.search(
      /parse the already structurally validated JSON/i,
    )
    const identityIndex = SKILL_NORM.search(/dispatch identity binding/i)
    // Anchor screening/persistence to the Stage 5 fixed-order restatement.
    // The earlier exit-0 paragraph mentions screening and persistence before
    // the identity gate is defined, so its offsets cannot prove that the gate
    // precedes them; the restatement states the required order explicitly.
    const screenIndex = SKILL_NORM.search(
      /run the unchanged environment-value screen/i,
    )
    const persistIndex = SKILL_NORM.search(
      /only then add parent annotations, persist, or synthesize/i,
    )
    const synthesisIndex = SKILL_NORM.search(/### Stage 5: Merge findings/i)

    expect(admissionIndex).toBeGreaterThanOrEqual(0)
    expect(identityIndex).toBeGreaterThanOrEqual(0)
    expect(synthesisIndex).toBeGreaterThanOrEqual(0)
    expect(parseIndex).toBeGreaterThan(admissionIndex)
    expect(identityIndex).toBeGreaterThan(parseIndex)
    expect(screenIndex).toBeGreaterThan(identityIndex)
    expect(persistIndex).toBeGreaterThan(screenIndex)
    expect(synthesisIndex).toBeGreaterThan(identityIndex)
  })

  test('coverage distinguishes every admission state without new artifact fields', () => {
    for (const token of [
      'findings',
      'empty',
      'malformed',
      'never_returned',
      'environment-screen',
      'validation unavailable',
    ]) {
      expect(`${OUTPUT_NORM} ${SKILL_NORM}`).toContain(token)
    }
    expect(SYNTH_NORM).toContain('schema_version')
  })

  test('aggregate validation resolves the skill-local helper first', () => {
    expect(SYNTH_NORM).toContain(
      'node "$SKILL_DIR/scripts/validate-review.mjs" artifact',
    )
    // Existing fallbacks and semantics remain documented.
    expect(SYNTH_NORM).toContain('systematic-validate-review-artifact')
    expect(SYNTH_NORM).toContain('systematic validate-review-artifact')
    expect(SYNTH_NORM).toContain('--allow-outside-artifact-root')
    expect(SYNTH_NORM).toContain('legacy')
  })

  test('report-only performs validation in memory and writes nothing', () => {
    expect(SKILL_NORM).toMatch(
      /report-only[^.]*(?:in memory|no run directory|writes no)/i,
    )
    expect(SYNTH_NORM).toMatch(/report-only[^.]*no artifact/i)
  })

  test('the raw return schema is the findings schema contract, not the aggregate artifact', () => {
    // Structural validity never implies evidence validity.
    expect(SUBAGENT_NORM).toMatch(/parent-owned/i)
    expect(SKILL_NORM).toMatch(
      /structural[^.]*(?:not|never)[^.]*evidence|structural[^.]*evidence validity/i,
    )
  })

  test('requires a fresh, verified, collision-free heredoc delimiter', () => {
    for (const doc of [SKILL_NORM, SYNTH_NORM]) {
      expect(doc).toMatch(/fresh delimiter/i)
      expect(doc).toMatch(/safe token alphabet/i)
      expect(doc).toMatch(/absent as a complete line/i)
      expect(doc).toMatch(/never reuse a fixed delimiter/i)
      // The old fixed token must not be documented as the delimiter anywhere.
      expect(doc).not.toContain('SYSTEMATIC_REVIEW_RETURN_EOF')
    }
  })

  test('a documented fixed delimiter cannot terminate an adversarial payload', () => {
    const block = rawValidatorBlock ?? ''
    const delimiterMatch = block.match(/<<'([^']*)'\s*\n/)
    expect(delimiterMatch).not.toBeNull()
    const documentedDelimiter = delimiterMatch?.[1] ?? ''
    expect(documentedDelimiter.length).toBeGreaterThan(0)
    expect(documentedDelimiter).toMatch(/^[A-Za-z0-9_]+$/)

    const projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ce-review-heredoc-'),
    )
    const canary = path.join(projectDir, 'heredoc-canary')
    try {
      const skillDir = path.join(REPO_ROOT, 'skills/ce-review')
      // Adversarial payload: partial JSON, the long-documented fixed delimiter
      // as a complete line, then a canary shell command. The canary and skill
      // directory travel through the child environment so no uncontrolled
      // absolute path is interpolated into a shell command string (CodeQL
      // js/shell-command-injection-from-environment).
      const payload = [
        '{ "reviewer": "correctness",',
        'SYSTEMATIC_REVIEW_RETURN_EOF',
        'touch "$CANARY"',
      ].join('\n')
      const script = [
        `node "$SKILL_DIR/scripts/validate-review.mjs" return <<'${documentedDelimiter}'`,
        payload,
        documentedDelimiter,
      ].join('\n')

      const result = spawnSync('sh', [], {
        cwd: projectDir,
        encoding: 'utf8',
        env: { ...process.env, CANARY: canary, SKILL_DIR: skillDir },
        input: script,
        timeout: 30_000,
      })

      // Safe outcome: the payload never escapes the heredoc, so the canary is
      // never touched and the validator exits 1 on the malformed JSON.
      expect(fs.existsSync(canary)).toBe(false)
      expect(result.status).toBe(1)
    } finally {
      fs.rmSync(projectDir, { force: true, recursive: true })
    }
  })

  test('orders parent parsing after validator admission and before environment screening', () => {
    // The contradictory ordering (screen before parse) must never reappear.
    expect(SKILL_NORM).not.toMatch(/clean environment screen, parse/i)
    expect(SKILL_NORM).not.toMatch(
      /environment-value screen[^.]*before[^.]*parse/i,
    )

    for (const doc of [SKILL_NORM, SYNTH_NORM]) {
      const parseIndex = doc.search(
        /parse the already structurally validated JSON/i,
      )
      const screenIndex = doc.search(/environment-value screen/i)
      expect(parseIndex).toBeGreaterThanOrEqual(0)
      expect(screenIndex).toBeGreaterThanOrEqual(0)
      expect(parseIndex).toBeLessThan(screenIndex)
    }

    // Exit 1 forbids parent parse/screen/persist.
    expect(SKILL_NORM).toMatch(/exit 1[^.]*(?:do not|never)[^.]*parse/i)
  })

  test('the artifact helper block assigns and passes a quoted artifact path', () => {
    const block = fencedBlocks(SYNTH).find((candidate) =>
      candidate.includes('validate-review.mjs" artifact'),
    )
    expect(block).toBeDefined()
    const text = block ?? ''

    // Self-contained assignment in the same block, terminated with `;`.
    expect(text).toMatch(/ARTIFACT_PATH="[^"]*";/)
    // The invocation passes the quoted variable, never an unquoted placeholder.
    expect(text).not.toMatch(/artifact\s+<path>/)
    const invocation = text
      .split('\n')
      .find((line) => line.includes('validate-review.mjs" artifact'))
    expect(invocation).toBeDefined()
    expect(invocation).toContain('"$ARTIFACT_PATH"')
    expect(invocation).not.toContain('<path>')
  })

  test('HARNESSES.md records only proven validator paths', () => {
    expect(HARNESSES_NORM).toContain(
      'skills/ce-review/scripts/validate-review.mjs',
    )
    expect(HARNESSES_NORM).toMatch(/npm|OpenCode|Pi/)
    expect(HARNESSES_NORM).toMatch(/OCX/)
    expect(HARNESSES_NORM).toMatch(/Claude Code/)
    expect(HARNESSES_NORM).toMatch(/scripted/i)
    expect(HARNESSES_NORM).toMatch(
      /(?:not|no)[^.]*(?:live|real)[^.]*(?:Pi|OCX|Claude)/i,
    )
  })
})

describe('persisted validation_unavailable outcome (KTD8 amendment)', () => {
  test('persists validation_unavailable for a returned-but-unverifiable reviewer', () => {
    for (const doc of [SKILL_NORM, SYNTH_NORM]) {
      expect(doc).toContain('validation_unavailable')
    }
    // Updated from the preinitialized never_returned, never omitted/left behind.
    expect(SYNTH_NORM).toMatch(
      /validation_unavailable[^.]*never_returned|never_returned[^.]*validation_unavailable/i,
    )
    expect(SYNTH_NORM).toMatch(
      /every selected persona|all selected personas|each selected persona/i,
    )
    expect(SYNTH_NORM).toMatch(/degraded/i)
  })

  test('keeps schema_version 1 without a migration for the additive enum', () => {
    expect(SYNTH_NORM).toMatch(/validation_unavailable/)
    expect(SYNTH_NORM).toMatch(/additive|no migration|no new field/i)
    expect(SYNTH_NORM).toMatch(/schema[_\s-]?version[^.]*1/i)
  })

  test('the rejected ledger excludes validation_unavailable', () => {
    const combined = `${SYNTH_NORM} ${SKILL_NORM}`
    expect(combined).toMatch(
      /rejected[^.]*never_returned[^.]*(?:empty|validation_unavailable)|rejected[^.]*validation_unavailable/i,
    )
  })

  test('rejected-summary rows separate the writer contract from reader leniency', () => {
    // Writer contract: only findings/malformed may author a rejected summary.
    expect(SYNTH_NORM).toMatch(
      /new writers[^.]*rejected-summary row only for `findings` or `malformed`/i,
    )
    // Reader contract: historical `empty` and `never_returned` rows are accepted
    // for backward compatibility, explicitly not as authoring permission.
    expect(SYNTH_NORM).toMatch(
      /validator[^.]*continues to accept a historical `(?:empty|never_returned)`[^.]*backward compatibility/i,
    )
    expect(SYNTH_NORM).toMatch(/reader leniency is not authoring permission/i)
    // `validation_unavailable` is additive to this contract, so no historical
    // artifact can carry it: the reader rejects it outright.
    expect(SYNTH_NORM).toMatch(
      /validator rejects (?:a )?rejected-summary row for `validation_unavailable`[^.]*writers must never emit/i,
    )
  })

  test('risk-critical fail-closed blocking covers validation_unavailable', () => {
    expect(SYNTH_NORM).toMatch(
      /risk-critical[\s\S]{0,700}validation_unavailable/i,
    )
  })

  test('withheld reviewer reports exact unavailability and what was withheld', () => {
    expect(SKILL_NORM).toMatch(
      /validation unavailable[\s\S]{0,200}withheld|withhold[\s\S]{0,200}validation unavailable/i,
    )
    expect(OUTPUT_NORM).toContain('validation_unavailable')
  })
})

describe('core-plus-risk selection (U6 acceptance)', () => {
  test('selects exactly the three core reviewers before conditionals', () => {
    expect(SKILL_NORM).toMatch(
      /exactly the three always-on personas: `correctness`, `testing`, and `project-standards`/i,
    )
    // Reviewer count is an outcome, not a manufactured floor.
    expect(SKILL_NORM).toMatch(
      /reviewer count is an outcome, not a target or a success metric/i,
    )
  })

  test('all four modes share the selection policy and probes stay separate', () => {
    expect(SKILL_NORM).toMatch(/same reviewer-selection policy/i)
    expect(SKILL_NORM).toMatch(/execution probe[^.]*separate parent decision/i)
    expect(SKILL_NORM).toMatch(/probe[^.]*permission boundary/i)
  })
})
