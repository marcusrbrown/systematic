import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const CLEANUP_SKILL_PATH = path.join(
  REPO_ROOT,
  'skills/ce-review-cleanup/SKILL.md',
)
const REVIEW_SKILL_PATH = path.join(REPO_ROOT, 'skills/ce-review/SKILL.md')
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  'skills/ce-review/references/synthesis-artifact-contract.md',
)

function readIfExists(filePath: string): string | undefined {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined
}

describe('ce:review-cleanup skill contract', () => {
  test('SKILL.md exists with correct frontmatter identity', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text, `expected ${CLEANUP_SKILL_PATH} to exist`).toBeDefined()
    expect(text).toMatch(/^name:\s*ce:review-cleanup\s*$/m)
    expect(text).toMatch(/^description:\s*"Use when/m)
  })

  test('never invokes raw shell deletion; only the bundled helper deletes', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text).not.toMatch(/\brm\s+-[a-z]*f/i)
    expect(text).toContain(
      'node "$SKILL_DIR/scripts/cleanup.mjs" preview --root',
    )
    expect(text).toContain(
      'node "$SKILL_DIR/scripts/cleanup.mjs" execute --root',
    )
  })

  test('cleanup invocation lines match the actual cleanup.mjs argument parser', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text).toContain('--ack-offline')
    expect(text).toContain('--age')
    expect(text).toContain('--token')
    // Execute never recomputes age; the token alone carries the fixed cutoff.
    const executeLineMatch = text?.match(
      /node "\$SKILL_DIR\/scripts\/cleanup\.mjs" execute[^\n]*/,
    )
    expect(executeLineMatch).toBeTruthy()
    expect(executeLineMatch?.[0]).not.toContain('--age')
  })

  test('offline acknowledgment precedes preview, and preview precedes a separate deletion-approval question, which precedes execute', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    const body = text ?? ''
    const previewIdx = body.indexOf(
      'node "$SKILL_DIR/scripts/cleanup.mjs" preview --root',
    )
    const executeIdx = body.indexOf(
      'node "$SKILL_DIR/scripts/cleanup.mjs" execute --root',
    )
    expect(previewIdx).toBeGreaterThan(-1)
    expect(executeIdx).toBeGreaterThan(previewIdx)

    // Offline acknowledgment must be asked before the preview invocation.
    const offlineAckIdx = body
      .toLowerCase()
      .indexOf('stopped all review writers')
    expect(offlineAckIdx).toBeGreaterThan(-1)
    expect(offlineAckIdx).toBeLessThan(previewIdx)

    // A distinct deletion-approval ask must occur after preview and before execute.
    const deletionApprovalIdx = body
      .toLowerCase()
      .indexOf('separate, explicit deletion approval')
    expect(deletionApprovalIdx).toBeGreaterThan(previewIdx)
    expect(deletionApprovalIdx).toBeLessThan(executeIdx)
  })

  test('rejects treating the request, offline ack, or token as deletion approval', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text?.toLowerCase()).toMatch(
      /never treat[^.]*(offline acknowledgment|initial request|token)[^.]*as (deletion )?approval/,
    )
  })

  test('status is never a cleanup eligibility signal; only age and the offline precondition select candidates', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text?.toLowerCase()).toMatch(
      /status[^.]*is never[^.]*eligib(le|ility)/,
    )
  })

  test('age is required with no default and must be asked when missing', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text?.toLowerCase()).toContain('no default')
  })

  test('never dispatches a review mode or persona from the cleanup skill', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text).not.toMatch(/mode:(autofix|report-only|headless)/)
    expect(text).not.toMatch(/spawn|Stage 3|Stage 4|persona sub-agent/i)
    expect(text?.toLowerCase()).toContain('must never dispatch a review')
  })

  test('preview-stale (exit 3) requires a fresh preview and renewed approval, never an automatic retry', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text?.toLowerCase()).toContain('preview-stale')
    expect(text?.toLowerCase()).toMatch(/fresh preview[^.]*renewed approval/)
  })

  test('own script path anchor is present with a semicolon-terminated SKILL_DIR assignment', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text).toMatch(
      /SKILL_DIR="<skill directory stated when this skill loads>";/,
    )
    expect(text).not.toMatch(/\$\{?(?:CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT)\}?/)
  })
})

describe('ce:review-cleanup skill contract -- target root consistency and field completeness', () => {
  test('identifies and fixes the target root before offline acknowledgment, and reuses the identical value for preview and execute', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    const body = text ?? ''
    const rootIdentifiedIdx = body.indexOf('TARGET_ROOT')
    const offlineAckIdx = body
      .toLowerCase()
      .indexOf('stopped all review writers')
    expect(rootIdentifiedIdx).toBeGreaterThan(-1)
    expect(rootIdentifiedIdx).toBeLessThan(offlineAckIdx)

    // Both invocations must reuse the exact same confirmed root expression.
    const previewLine = body.match(
      /node "\$SKILL_DIR\/scripts\/cleanup\.mjs" preview[^\n]*/,
    )?.[0]
    const executeLine = body.match(
      /node "\$SKILL_DIR\/scripts\/cleanup\.mjs" execute[^\n]*/,
    )?.[0]
    expect(previewLine).toContain('--root "$TARGET_ROOT"')
    expect(executeLine).toContain('--root "$TARGET_ROOT"')
  })

  test('never claims the root comes from the preview response -- the helper response has no root field', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text?.toLowerCase()).not.toMatch(
      /root[^.]*returned by (the )?preview/,
    )
  })

  test('preview presentation includes the bounded name field alongside displayId, label, and lastModified', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    const body = text ?? ''
    expect(body).toContain('`name`')
    expect(body).toContain('`displayId`')
    expect(body).toContain('`label`')
    expect(body).toContain('`lastModified`')
    // skippedUnknownUnsafe candidates carry a per-candidate reason.
    expect(body).toMatch(
      /skippedUnknownUnsafe[^.]*`reason`|`reason`[^.]*skippedUnknownUnsafe/,
    )
  })

  test('nothing-eligible reporting distinguishes excluded-recent from skipped-unknown/unsafe rather than a blanket recency claim', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    const body = text ?? ''
    const idx = body.indexOf('"nothing-eligible"')
    expect(idx).toBeGreaterThan(-1)
    const breakIdx = body.indexOf('\n\n', idx)
    const segment = body.slice(idx, breakIdx === -1 ? undefined : breakIdx)
    expect(segment.toLowerCase()).toMatch(/unsafe|unknown/)
  })

  test('JSON-escaped candidate names are rendered as-is, never decoded or reformatted into Markdown/terminal text', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text?.toLowerCase()).toMatch(
      /as-is[^.]*never decode|never decode[^.]*as-is/,
    )
  })

  test('command arguments are quoted model-filled values, not raw unquoted angle-bracket placeholders', () => {
    const text = readIfExists(CLEANUP_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text).not.toMatch(/--(root|age|token)\s+</)
  })
})

describe('ce:review producer -- ignore preparation gate', () => {
  test('invokes ensure-ignore.mjs before run-id mkdir in writing modes', () => {
    const text = readIfExists(REVIEW_SKILL_PATH)
    expect(text).toBeDefined()
    const body = text ?? ''
    const ignoreInvocationIdx = body.indexOf(
      'node "$SKILL_DIR/scripts/ensure-ignore.mjs" --root',
    )
    const mkdirIdx = body.indexOf(
      'mkdir -p ".context/systematic/ce-review/$RUN_ID"',
    )
    expect(ignoreInvocationIdx).toBeGreaterThan(-1)
    expect(mkdirIdx).toBeGreaterThan(-1)
    expect(ignoreInvocationIdx).toBeLessThan(mkdirIdx)
  })

  test('blocked or malformed ignore-preparation result blocks persistence without a silent report-only downgrade', () => {
    const text = readIfExists(REVIEW_SKILL_PATH)
    expect(text).toBeDefined()
    const lower = text?.toLowerCase() ?? ''
    expect(lower).toContain('blocked')
    expect(lower).not.toContain('silently downgrade')
    expect(lower).toMatch(/block(s)? persistence/)
  })

  test('a blocked ignore failure cannot be bypassed with an alternate base ref or direct shell command', () => {
    const text = readIfExists(REVIEW_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text?.toLowerCase()).toMatch(
      /(cannot|must not|never) be bypassed[^.]*(base:|direct shell|alternate)/,
    )
  })

  test('report-only continues to skip both run-id creation and the ignore helper entirely', () => {
    const text = readIfExists(REVIEW_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text).toMatch(
      /report-only.*skip.*(run-id generation|ignore preparation|ignore helper)/is,
    )
  })

  test('existing environment-value validation instructions remain present and unpruned', () => {
    const text = readIfExists(REVIEW_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text).toContain('environment-value')
  })

  test('ensure-ignore is invoked with the cwd-relative root, consistent with the cwd-relative RUN_ID mkdir', () => {
    const text = readIfExists(REVIEW_SKILL_PATH)
    expect(text).toBeDefined()
    expect(text).toContain(
      'node "$SKILL_DIR/scripts/ensure-ignore.mjs" --root "."',
    )
    expect(text).not.toMatch(/ensure-ignore\.mjs" --root\s+</)
  })
})

describe('synthesis-artifact-contract -- ignore-preparation reconciliation', () => {
  test('a prerequisite failure never fabricates or claims a validated run artifact', () => {
    const text = readIfExists(CONTRACT_PATH)
    expect(text).toBeDefined()
    const lower = text?.toLowerCase() ?? ''
    expect(lower).toMatch(/ignore preparation[^.]*block/)
    expect(lower).toContain('no artifact')
  })

  test('the existing environment-value validation and parent-side persistence rules remain intact', () => {
    const text = readIfExists(CONTRACT_PATH)
    expect(text).toBeDefined()
    expect(text).toContain('Environment-value validation')
    expect(text).toContain('Validation and persistence remain parent-side')
  })
})
