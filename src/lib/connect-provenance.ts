/**
 * The provenance decision of a named `ce:connect` fetch: did the scheduled run
 * of another repository call Systematic's reusable `connect.yaml` at a commit
 * on Systematic's default branch? The skill does the network part with the
 * user's own `gh` and sends the text it got here, so the choice of entry, the
 * shape of the hash and the compare verdict are code, not a model's reading of
 * JSON.
 *
 * Two questions, one function. With the attempt's `referenced_workflows` alone
 * it answers which commit to compare (`selected`). With the compare `status`
 * as well it answers whether that commit is on the default branch
 * (`accepted`). Every other case is a refusal that names one reason.
 *
 * Pure: no network, no file, no state. The verdict carries a reason or a hash
 * and never any of the input. Import rule: nothing, because the `ce:connect`
 * helper bundles it.
 */

export type ProvenanceVerdict =
  | { readonly status: 'selected'; readonly sha: string }
  | { readonly status: 'accepted'; readonly sha: string }
  | {
      readonly status: 'refused'
      readonly reason: 'provenance-unprovable' | 'not-a-connect-run'
    }

export interface ProvenanceInput {
  /** The text `gh api .../attempts/<n> --jq .referenced_workflows` printed. */
  readonly referencedWorkflows: unknown
  /** The text `gh api .../compare/main...<sha> --jq .status` printed, when the commit was compared. */
  readonly status?: unknown
}

/** Systematic's reusable workflow, split at the owner and repository: GitHub names them without regard to case. */
const OWNER_REPO = 'marcusrbrown/systematic'
/** The workflow file inside the repository. It is compared exactly. */
const WORKFLOW_FILE = '/.github/workflows/connect.yaml'
const FULL_SHA = /^[0-9a-f]{40}$/

const UNPROVABLE: ProvenanceVerdict = {
  status: 'refused',
  reason: 'provenance-unprovable',
}
const NOT_A_CONNECT_RUN: ProvenanceVerdict = {
  status: 'refused',
  reason: 'not-a-connect-run',
}

function parseList(text: unknown): readonly unknown[] | undefined {
  if (typeof text !== 'string') return undefined
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** The `path` of every entry, or `undefined` when any entry has no string `path`. */
function pathsOf(list: readonly unknown[]): string[] | undefined {
  const paths: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return undefined
    }
    const { path } = entry as { path?: unknown }
    if (typeof path !== 'string') return undefined
    paths.push(path)
  }
  return paths
}

/** The part of a workflow path before the `@`: the text after it is whatever the caller wrote. */
function workflowOf(path: string): string {
  const at = path.indexOf('@')
  return at === -1 ? path : path.slice(0, at)
}

function isSystematicConnect(path: string): boolean {
  const workflow = workflowOf(path)
  return (
    workflow.endsWith(WORKFLOW_FILE) &&
    workflow.slice(0, -WORKFLOW_FILE.length).toLowerCase() === OWNER_REPO
  )
}

export function verifyProvenance(input: ProvenanceInput): ProvenanceVerdict {
  const list = parseList(input.referencedWorkflows)
  if (list === undefined) return UNPROVABLE
  const paths = pathsOf(list)
  if (paths === undefined) return UNPROVABLE

  const matches = list.filter((_entry, index) => {
    const path = paths[index]
    return path !== undefined && isSystematicConnect(path)
  })
  if (matches.length === 0) return NOT_A_CONNECT_RUN
  if (matches.length > 1) return UNPROVABLE

  const { sha } = matches[0] as { sha?: unknown }
  if (typeof sha !== 'string' || !FULL_SHA.test(sha)) return UNPROVABLE

  if (input.status === undefined) return { status: 'selected', sha }
  return input.status === 'behind' || input.status === 'identical'
    ? { status: 'accepted', sha }
    : UNPROVABLE
}
