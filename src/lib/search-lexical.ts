/**
 * Lexical lane for durable-output search: tokenizer, natural log and BM25F.
 *
 * Pure and dependency-free: no I/O, no environment reads, no imports. Scores
 * must be bit-identical on Bun and Node, because the lexical lane is the part
 * of search that every surface shares. ECMAScript leaves `Math.log`
 * implementation-approximated and the two runtimes disagree on it, so this
 * module computes its own `ln` from + - * / only. By convention it also
 * avoids `Math.pow`, `**`, `exp`, `Intl`, `localeCompare`, `toLocale*`,
 * `Bun.` and `bun:`. Tests enforce the outcome (bit patterns under Node),
 * not the convention.
 */

/** Indexed fields in the fixed order used for summation. */
export const LEXICAL_FIELDS = [
  'title',
  'tags',
  'module',
  'symptoms',
  'applies_when',
  'component',
  'problem_type',
  'body',
] as const

export type LexicalField = (typeof LEXICAL_FIELDS)[number]

export interface Bm25fFieldParams {
  /** Field weight `w_f`. */
  readonly weight: number
  /** Length-normalisation strength `b_f`; 0 turns normalisation off. */
  readonly b: number
}

export interface Bm25fParams {
  readonly k1: number
  readonly fields: Readonly<Record<LexicalField, Bm25fFieldParams>>
}

/**
 * Starting values from the plan's Key Technical Decisions. This is the one
 * table the recall tuning edits. Metadata fields do not length-normalise;
 * the body does.
 */
export const BM25F_PARAMS = {
  k1: 1.2,
  fields: {
    title: { weight: 3, b: 0 },
    tags: { weight: 2.5, b: 0 },
    module: { weight: 2, b: 0 },
    symptoms: { weight: 3, b: 0 },
    applies_when: { weight: 2, b: 0 },
    component: { weight: 1.5, b: 0 },
    problem_type: { weight: 1.5, b: 0 },
    body: { weight: 1, b: 0.75 },
  },
} as const satisfies Bm25fParams

/** Unique query terms kept after truncation. */
export const MAX_QUERY_TERMS = 64

/**
 * Words are runs of ASCII `[a-z0-9]`. A run joined by `_` or `-` is one
 * identifier. Leading and trailing separators are not part of it.
 */
const IDENTIFIER_RUN = /[a-z0-9]+(?:[_-]+[a-z0-9]+)*/g
const WORD = /[a-z0-9]+/g

/**
 * Splits text into index terms. Lowercases, then emits ASCII `[a-z0-9]` runs.
 * A run joined by `_` or `-` also emits its whole joined identifier first, so
 * `foo_bar` yields `foo_bar`, `foo`, `bar`. Every other character splits, a
 * non-ASCII letter included (`naïve` yields `na`, `ve`, a documented limit).
 * No stemming, no stopwords, no camelCase split. Duplicates are kept so the
 * caller can count term frequency.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.toLowerCase().matchAll(IDENTIFIER_RUN)) {
    const run = match[0]
    const words = run.match(WORD)
    if (words === null) continue
    if (words.length === 1) {
      tokens.push(run)
      continue
    }
    tokens.push(run, ...words)
  }
  return tokens
}

/**
 * Unique query terms in first-seen order, truncated to `max`, then sorted by
 * code unit so summation order is fixed. `truncated` tells the caller to add
 * a note.
 */
export function uniqueQueryTerms(
  query: string,
  max: number = MAX_QUERY_TERMS,
): { readonly terms: string[]; readonly truncated: boolean } {
  const seen = new Set<string>()
  for (const token of tokenize(query)) seen.add(token)
  const all = [...seen]
  const truncated = all.length > max
  const terms = (truncated ? all.slice(0, max) : all).sort(compareCodeUnits)
  return { terms, truncated }
}

/** Code-unit order, which is what `<` on strings does. Never locale-aware. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

// fdlibm's split of ln 2: LN2_HI has its low 21 bits clear, so `k * LN2_HI` is
// exact for any exponent a double can have.
const LN2_HI = 0.6931471803691238
const LN2_LO = 1.9082149292705877e-10
const SQRT2 = Math.SQRT2
const SQRT_HALF = Math.SQRT1_2

/**
 * Natural logarithm using only + - * /. Scales the argument by exact powers
 * of two into [sqrt(1/2), sqrt(2)), then sums the atanh series
 * `ln m = 2 * atanh((m - 1) / (m + 1))` with a fixed number of terms and adds
 * `k * ln 2`. Relative error is near 1e-16 across the range search uses.
 * Returns -Infinity for 0, and NaN for a negative or NaN argument.
 */
export function ln(x: number): number {
  if (Number.isNaN(x) || x < 0) return Number.NaN
  if (x === 0) return Number.NEGATIVE_INFINITY
  if (x === Number.POSITIVE_INFINITY) return x

  let m = x
  let k = 0
  while (m >= SQRT2) {
    m /= 2
    k += 1
  }
  while (m < SQRT_HALF) {
    m *= 2
    k -= 1
  }

  const s = (m - 1) / (m + 1)
  const s2 = s * s
  // 1 + s2/3 + s2^2/5 + ... + s2^11/25, by Horner. |s| <= 0.1716, so the
  // first omitted term is below 1e-19.
  let series = 1 / 25
  for (let d = 23; d >= 1; d -= 2) series = series * s2 + 1 / d
  const small = 2 * s * series

  return k * LN2_HI + (k * LN2_LO + small)
}

export interface LexicalDocument {
  /** Root-relative path. Equal scores order by the code units of this. */
  readonly id: string
  readonly fields: Readonly<Partial<Record<LexicalField, string>>>
}

interface FieldStats {
  readonly tf: Map<string, number>
  readonly length: number
}

interface IndexedDocument {
  readonly id: string
  /** Aligned with `LEXICAL_FIELDS`. */
  readonly fields: readonly FieldStats[]
}

export interface LexicalIndex {
  readonly params: Bm25fParams
  readonly docs: readonly IndexedDocument[]
  /** Documents in which a term appears in any field. */
  readonly documentFrequency: ReadonlyMap<string, number>
  /** Mean field length, aligned with `LEXICAL_FIELDS`. */
  readonly averageLength: readonly number[]
}

export interface LexicalHit {
  readonly id: string
  readonly score: number
}

/** Builds the index over documents with named fields. Pure. */
export function buildLexicalIndex(
  documents: readonly LexicalDocument[],
  params: Bm25fParams = BM25F_PARAMS,
): LexicalIndex {
  const documentFrequency = new Map<string, number>()
  const totals = LEXICAL_FIELDS.map(() => 0)
  const docs: IndexedDocument[] = []

  for (const document of documents) {
    const seenInDocument = new Set<string>()
    const fields = LEXICAL_FIELDS.map((field, fieldIndex): FieldStats => {
      const tokens = tokenize(document.fields[field] ?? '')
      const tf = new Map<string, number>()
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1)
        seenInDocument.add(token)
      }
      totals[fieldIndex] = (totals[fieldIndex] ?? 0) + tokens.length
      return { tf, length: tokens.length }
    })
    for (const term of seenInDocument) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
    docs.push({ id: document.id, fields })
  }

  const count = docs.length
  const averageLength = totals.map((total) => (count === 0 ? 0 : total / count))
  return { params, docs, documentFrequency, averageLength }
}

/** Weighted term frequency of one term in one document, fields in fixed order. */
function weightedFrequency(
  index: LexicalIndex,
  document: IndexedDocument,
  term: string,
): number {
  let total = 0
  for (let i = 0; i < LEXICAL_FIELDS.length; i++) {
    const field = LEXICAL_FIELDS[i]
    const stats = document.fields[i]
    const tf = stats?.tf.get(term)
    if (field === undefined || stats === undefined || tf === undefined) continue
    const { weight, b } = index.params.fields[field]
    const average = index.averageLength[i] ?? 0
    // tf > 0 means the field is non-empty, so `average` is positive.
    const normalisation = 1 - b + b * (stats.length / average)
    total += (weight * tf) / normalisation
  }
  return total
}

/**
 * BM25F. For each term, a length-normalised weighted term frequency is summed
 * over fields and saturated with `k1`, then scaled by
 * `ln(1 + (N - df + 0.5) / (df + 0.5))`. Terms are deduplicated and sorted by
 * code unit here, and fields are summed in `LEXICAL_FIELDS` order, so the
 * score does not depend on the order the caller supplied terms in. Returns
 * documents with a positive score, best first, ties by code-unit path.
 */
export function searchLexical(
  index: LexicalIndex,
  terms: readonly string[],
): LexicalHit[] {
  const total = index.docs.length
  const weighted: Array<{ readonly term: string; readonly idf: number }> = []
  for (const term of [...new Set(terms)].sort(compareCodeUnits)) {
    const df = index.documentFrequency.get(term)
    if (df === undefined) continue
    weighted.push({ term, idf: ln(1 + (total - df + 0.5) / (df + 0.5)) })
  }

  const { k1 } = index.params
  const hits: LexicalHit[] = []
  for (const document of index.docs) {
    let score = 0
    for (const { term, idf } of weighted) {
      const wtf = weightedFrequency(index, document, term)
      if (wtf === 0) continue
      score += (idf * wtf) / (k1 + wtf)
    }
    if (score > 0) hits.push({ id: document.id, score })
  }

  return hits.sort((a, b) => b.score - a.score || compareCodeUnits(a.id, b.id))
}
