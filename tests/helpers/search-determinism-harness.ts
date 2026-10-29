// Shared by tests/unit/search-determinism.test.ts. It runs in-process under
// Bun and, bundled with target 'node', under a real Node binary. It must stay
// free of anything runtime-specific: the test compares what each runtime
// computes, bit for bit.
import {
  buildLexicalIndex,
  type LexicalDocument,
  ln,
  searchLexical,
  tokenize,
  uniqueQueryTerms,
} from '../../src/lib/search-lexical.js'

const view = new DataView(new ArrayBuffer(8))

/** Float64 bit pattern as 16 hex digits, so a one-ulp drift is visible. */
export function bitsOf(value: number): string {
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

const CORPUS: readonly LexicalDocument[] = [
  {
    id: 'docs/solutions/best-practices/a-perfect-measurement-2026-08-16.md',
    fields: {
      title: 'A perfect measurement means a broken instrument',
      tags: 'measurement, testing, false-confidence',
      module: 'quality-gates',
      symptoms: 'the gate always passes and never catches a regression',
      applies_when: 'a check has never failed',
      component: 'testing_framework',
      problem_type: 'best_practice',
      body: 'A gate that cannot fail proves nothing. Mutate the code and watch the check go red.',
    },
  },
  {
    id: 'docs/solutions/build-errors/node-bundle-crash-2026-09-01.md',
    fields: {
      title: 'Bundled bin crashes from a foreign directory',
      tags: 'bun, node, bundle, umd',
      module: 'claude-code-bin',
      symptoms: 'TypeError at startup when run outside the repository',
      component: 'tooling',
      problem_type: 'build_error',
      body: 'The UMD build of jsonc-parser reads a sibling file. Alias the ESM build with onResolve.',
    },
  },
  {
    id: 'docs/solutions/workflow-issues/registry-drift-2026-05-20.md',
    fields: {
      title: 'Registry drift on skill description change',
      tags: 'registry, drift, generated-surfaces',
      module: 'registry',
      symptoms:
        'CI fails with registry drift after editing a skill description',
      component: 'build',
      problem_type: 'workflow_issue',
      body: 'Run surfaces:affected --run before committing. src/lib/x.ts is not involved.',
    },
  },
  {
    id: 'docs/solutions/integration-issues/Z-upper-case-path-2026-07-14.md',
    fields: {
      title: 'Adapter parity contract tests',
      tags: 'parity, adapters',
      body: 'Test each adapter directly; a shared core test does not prove parity.',
    },
  },
  {
    id: 'docs/solutions/integration-issues/a-lower-case-path-2026-07-14.md',
    fields: {
      title: 'Adapter parity contract tests',
      tags: 'parity, adapters',
      body: 'Test each adapter directly; a shared core test does not prove parity.',
    },
  },
  {
    id: 'docs/solutions/logic-errors/empty-body.md',
    fields: { title: 'Only a title' },
  },
  {
    id: 'docs/solutions/logic-errors/long-body-2026-10-01.md',
    fields: {
      title: 'Retry storm after timeout',
      symptoms: 'connection reset during retry storm',
      body: Array.from(
        { length: 40 },
        (_, i) => `retry attempt ${String(i)} timed out against the database`,
      ).join('. '),
    },
  },
  {
    id: 'docs/solutions/logic-errors/short-body-2026-10-02.md',
    fields: {
      title: 'Retry storm after timeout',
      body: 'retry timed out against the database',
    },
  },
]

const QUERIES: readonly string[] = [
  'broken instrument gate always passes',
  'bundle crashes outside the repository',
  'registry drift after editing a skill',
  'adapter parity',
  'retry storm database timeout',
  'foo_bar a-perfect-measurement v2',
  'nothing matches this absurd query xyzzy',
  'src/lib/x.ts',
]

const SWEEP_SIZES: readonly number[] = [1, 2, 50, 126, 2000]

/** One line per computed value, so a mismatch names the first divergence. */
export function computeDeterminismReport(): string[] {
  const lines: string[] = []

  for (const n of SWEEP_SIZES) {
    const upper = 2 * n + 2
    for (let x = 1; x <= upper; x += upper / 997) {
      lines.push(`ln ${String(x)} ${bitsOf(ln(x))}`)
    }
    for (let df = 0; df <= n; df += Math.max(1, Math.floor(n / 50))) {
      const arg = 1 + (n - df + 0.5) / (df + 0.5)
      lines.push(`idf n=${String(n)} df=${String(df)} ${bitsOf(ln(arg))}`)
    }
  }
  for (const eps of [1e-3, 1e-6, 1e-9, 1e-12, 2 ** -40]) {
    lines.push(`ln 1+${String(eps)} ${bitsOf(ln(1 + eps))}`)
  }

  for (const doc of CORPUS) {
    for (const [name, text] of Object.entries(doc.fields)) {
      lines.push(`tokens ${doc.id} ${name} ${tokenize(text).join('|')}`)
    }
  }

  const index = buildLexicalIndex(CORPUS)
  for (const query of QUERIES) {
    const { terms } = uniqueQueryTerms(query)
    lines.push(`terms ${query} => ${terms.join('|')}`)
    for (const hit of searchLexical(index, terms)) {
      lines.push(`score ${query} ${hit.id} ${bitsOf(hit.score)}`)
    }
  }

  return lines
}
