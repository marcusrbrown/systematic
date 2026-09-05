/**
 * Routing resolver: answers "what model and qualifier does target T get on
 * harness H, and from where" from a set of already-merged config overlays.
 *
 * Part of the model-config-profiles feature (plan
 * 2026-09-04-002-feat-model-config-profiles, Unit 3). One routing precedence,
 * shared by every consumer that needs to know an agent's effective model:
 * the OpenCode config hook, the Pi delegate tool, the Pi persona export, and
 * `config show` (Units 4-6). This module is pure — it takes already-merged
 * overlay data and returns a resolution; it never reads files, never throws,
 * and never calls `console.warn`. The post-merge qualifier-requires-model
 * invariant check and any warning emission live in the caller
 * (`src/lib/config.ts`), which has the `warningSink` this module deliberately
 * does not.
 */

import type {
  OverlayConfig,
  OverlayConfigMap,
  PiSubagentsOverlayMap,
  SourcedOverlayConfig,
  SourcedOverlayConfigMap,
} from './config.js'
import { isRecord } from './validation.js'

export type Harness = 'opencode' | 'pi'

/**
 * One resolution target: a bundled agent's bare file-stem key plus its
 * category, keyed the same way `agent-overlays.ts` keys bundled agents
 * (`resolveAgentOverlaySet`'s `agentsByTargetId` uses the qualified
 * `category/key` id internally; this module accepts the split form since
 * that's what a category-driven walk naturally produces).
 */
export interface RoutingTarget {
  readonly agentKey: string
  readonly category: string
}

/**
 * Where a resolved `model` or qualifier value came from.
 *
 * `form` is `'legacy-pi-subagents'` only for a `pi` harness qualifier
 * resolved from the deprecated `pi_subagents.<agents|categories>.<key>.thinking`
 * location (R5) — `model` and `variant` never resolve from there.
 */
export interface RoutingFieldSource {
  readonly level: 'agent' | 'category'
  readonly form: 'block' | 'flat' | 'legacy-pi-subagents'
}

export interface RoutingResolution {
  /**
   * `undefined` when no layer set a model at all (inherit from the parent
   * agent/session with no explicit source). `null` is itself a resolved
   * value meaning "inherit", explicitly set by some layer — it is NOT the
   * same as `undefined` and beats a lower layer's explicit model string,
   * per R3a/the plan's KTD on `model: null` precedence.
   */
  readonly model: string | null | undefined
  /** `undefined` when no layer set a qualifier for this harness. */
  readonly qualifier: string | undefined
  readonly source: {
    readonly model: RoutingFieldSource | undefined
    readonly qualifier: RoutingFieldSource | undefined
  }
  /**
   * True when the deprecated `pi_subagents.<key>.thinking` value is present
   * for this target (agent overlay checked before category, mirroring
   * `pi-subagents-export.ts`'s existing precedence) — regardless of whether
   * it actually won as `qualifier`'s source. Always `false` for the
   * `opencode` harness.
   *
   * R5 requires one deprecation warning whenever the legacy field is
   * present, even when a `pi.thinking` block is also set and wins (the user
   * still has stale config to migrate away from). Callers should branch on
   * this flag, not on `source.qualifier.form === 'legacy-pi-subagents'`, to
   * decide whether to warn — the latter is `true` only when legacy actually
   * supplied the resolved value.
   */
  readonly legacyPiSubagentsThinkingPresent: boolean
  /**
   * Which harness this resolution was computed for. Carried on the result
   * (not just the input) so `qualifierResolvesWithoutModel` can self-guard
   * against ever flagging a Pi resolution as a violation, regardless of
   * caller discipline — see that function's doc comment.
   */
  readonly harness: Harness
}

export interface ResolveRoutingInput {
  /** The `overlays` value `loadConfigWithSources` returns (agents/categories, already merged). */
  readonly overlays: SourcedOverlayConfigMap
  /** The merged `pi_subagents` overlays, for the legacy `thinking` fallback. */
  readonly piSubagentsOverlays: SourcedOverlayConfigMap
  readonly target: RoutingTarget
  readonly harness: Harness
}

function getOverlayValue(
  map: Record<string, { value: OverlayConfig }>,
  key: string,
): OverlayConfig | undefined {
  return map[key]?.value
}

/**
 * `loadConfigWithSources` exposes the merged `agents`/`categories` routing
 * overlays in `SourcedOverlayConfigMap` form (value + source metadata), but
 * some callers (the Pi delegate tool, Pi persona export) only have a plain,
 * already-flattened overlay map on hand -- e.g. `SystematicConfig.pi_subagents`,
 * which retains no per-value source metadata past its own merge.
 * `resolveRouting`'s `piSubagentsOverlays` parameter only ever reads
 * `.value` off each entry (see `getOverlayValue` above), so wrapping each
 * plain value with placeholder source fields is a safe, purely-shape
 * adapter for feeding the resolver -- it never changes what resolves.
 * Exported so every consumer shares one implementation instead of each
 * defining its own copy.
 */
export function toSourcedOverlayMap(
  map: OverlayConfigMap | undefined,
): Record<string, SourcedOverlayConfig> {
  const result: Record<string, SourcedOverlayConfig> = {}
  if (!map) return result
  for (const [key, value] of Object.entries(map)) {
    result[key] = { value, sourcePath: '', keyPath: key }
  }
  return result
}

/**
 * Apply {@link toSourcedOverlayMap} to both halves of a plain
 * `pi_subagents`-shaped map (`{agents, categories}`), producing a
 * `SourcedOverlayConfigMap` ready to pass as `resolveRouting`'s
 * `piSubagentsOverlays` argument.
 */
export function toSourcedPiSubagentsOverlays(
  map: PiSubagentsOverlayMap | undefined,
): SourcedOverlayConfigMap {
  return {
    agents: toSourcedOverlayMap(map?.agents),
    categories: toSourcedOverlayMap(map?.categories),
  }
}

/**
 * Look up an agent's merged overlay value by bare key first, then by the
 * qualified `category/key` alias — mirrors the bare/qualified alias
 * resolution `resolveAgentOverlaySet`/`validateExactAgentOverlays` perform
 * against the bundled inventory, applied here directly to the raw merged
 * overlay map (this module has no inventory dependency).
 */
function lookupAgentOverlay(
  overlays: SourcedOverlayConfigMap,
  target: RoutingTarget,
): OverlayConfig | undefined {
  return (
    getOverlayValue(overlays.agents, target.agentKey) ??
    getOverlayValue(overlays.agents, `${target.category}/${target.agentKey}`)
  )
}

function readBlockField(
  overlay: OverlayConfig | undefined,
  blockKey: Harness,
  field: string,
): unknown {
  if (overlay === undefined) return undefined
  const block = overlay[blockKey]
  if (!isRecord(block)) return undefined
  return block[field]
}

function readFlatField(
  overlay: OverlayConfig | undefined,
  field: string,
): unknown {
  if (overlay === undefined) return undefined
  return overlay[field]
}

interface FieldCandidate {
  readonly value: unknown
  readonly source: RoutingFieldSource
}

/**
 * Narrow an arbitrary resolved `model` candidate to its runtime-checked
 * type instead of trusting a type assertion: a string stays a string, `null`
 * stays `null` (an explicit "inherit" value), and anything else (including
 * a candidate whose shape doesn't match, which Zod validation at the config
 * boundary should already have rejected) narrows to `undefined` (treated as
 * unset rather than surfaced as a malformed value).
 */
function narrowModelValue(value: unknown): string | null | undefined {
  if (typeof value === 'string') return value
  if (value === null) return null
  return undefined
}

/**
 * Narrow an arbitrary resolved qualifier candidate (`variant` or
 * `thinking`) the same way `narrowModelValue` does for `model`, minus the
 * `null` case — neither qualifier schema is nullable, so a non-string
 * candidate narrows straight to `undefined` (unset).
 */
function narrowQualifierValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Pick the first candidate (in precedence order) whose value is not
 * `undefined`. A candidate whose value is `null` still wins over a lower
 * candidate's explicit value — `null` is itself a resolved value ("inherit"),
 * distinct from "this layer didn't set the field at all".
 */
function resolveField(candidates: readonly FieldCandidate[]): {
  value: unknown
  source: RoutingFieldSource | undefined
} {
  for (const candidate of candidates) {
    if (candidate.value !== undefined) {
      return { value: candidate.value, source: candidate.source }
    }
  }
  return { value: undefined, source: undefined }
}

/**
 * Resolve `model` per R3a: agent block > agent flat > category block >
 * category flat. Independent of harness only in that the block queried is
 * `overlay[harness]` — `model` inside `opencode`/`pi` blocks is itself
 * harness-specific (an `opencode.model` does not apply on `pi`, and vice
 * versa), so this is called once per harness with that harness's block.
 * Used for the `pi` harness only — `opencode` uses
 * `resolveOpencodeModelAndVariant`, which couples model and variant
 * resolution together (see that function's doc comment for why).
 */
function resolveModel(
  agentOverlay: OverlayConfig | undefined,
  categoryOverlay: OverlayConfig | undefined,
  harness: Harness,
): {
  value: string | null | undefined
  source: RoutingFieldSource | undefined
} {
  const { value, source } = resolveField([
    {
      value: readBlockField(agentOverlay, harness, 'model'),
      source: { level: 'agent', form: 'block' },
    },
    {
      value: readFlatField(agentOverlay, 'model'),
      source: { level: 'agent', form: 'flat' },
    },
    {
      value: readBlockField(categoryOverlay, harness, 'model'),
      source: { level: 'category', form: 'block' },
    },
    {
      value: readFlatField(categoryOverlay, 'model'),
      source: { level: 'category', form: 'flat' },
    },
  ])
  const narrowedValue = narrowModelValue(value)
  return {
    value: narrowedValue,
    source: narrowedValue === undefined ? undefined : source,
  }
}

/**
 * The four `model`/`variant` layers in specificity order, most specific
 * first — shared by `resolveOpencodeModelAndVariant` so the layer INDEX
 * (not just its identity) is comparable: "a candidate layer is at least as
 * specific as L" means "its index in this array is <= L's index".
 */
const OPENCODE_MODEL_VARIANT_LAYERS: readonly RoutingFieldSource[] = [
  { level: 'agent', form: 'block' },
  { level: 'agent', form: 'flat' },
  { level: 'category', form: 'block' },
  { level: 'category', form: 'flat' },
]

function readOpencodeLayerField(
  agentOverlay: OverlayConfig | undefined,
  categoryOverlay: OverlayConfig | undefined,
  layer: RoutingFieldSource,
  field: 'model' | 'variant',
): unknown {
  const overlay = layer.level === 'agent' ? agentOverlay : categoryOverlay
  return layer.form === 'block'
    ? readBlockField(overlay, 'opencode', field)
    : readFlatField(overlay, field)
}

/**
 * Resolve OpenCode's `model` and `variant` TOGETHER -- resolving `variant`
 * fully independently of `model` would let a less-specific layer's stale
 * `variant` leak past a more-specific layer's `model`, and would make a
 * qualifier-without-model config error unreachable in cases `main`
 * correctly rejects.
 *
 * Let L be the index (in `OPENCODE_MODEL_VARIANT_LAYERS`, most specific
 * first) of the most specific layer that sets `model` as an own property
 * (a string or explicit `null`). `variant` may only be taken from a layer
 * at least as specific as L — index <= L — restoring `main`'s "a higher
 * layer's model, set without a variant, clears a lower layer's stale
 * variant" behavior, while still allowing a MORE specific layer to set
 * `variant` alone over a LESS specific layer's `model` (R3b: e.g. an agent
 * `opencode.variant` over a flat category `model`).
 *
 * If the model at L is `null` (explicit inherit), `variant` is dropped
 * entirely regardless of what any layer sets — inheriting the parent's
 * model means inheriting its variant too; there is no "inherited model,
 * explicit variant" combination.
 *
 * If NO layer sets a model at all, `variant` still resolves via its own
 * full precedence (unconstrained by any L) so a variant-with-no-model
 * anywhere is still detectable and rejected by `qualifierResolvesWithoutModel`
 * — this is the one case `main` already treated as an error, and this fix
 * preserves it.
 *
 * `source` reflects what was ACTUALLY used: a variant dropped by either
 * rule above reports `qualifier: undefined` and no source, never a stale
 * layer identity.
 */
function resolveOpencodeModelAndVariant(
  agentOverlay: OverlayConfig | undefined,
  categoryOverlay: OverlayConfig | undefined,
): {
  model: string | null | undefined
  modelSource: RoutingFieldSource | undefined
  qualifier: string | undefined
  qualifierSource: RoutingFieldSource | undefined
} {
  const modelLayerIndex = OPENCODE_MODEL_VARIANT_LAYERS.findIndex(
    (layer) =>
      readOpencodeLayerField(agentOverlay, categoryOverlay, layer, 'model') !==
      undefined,
  )
  const rawModel =
    modelLayerIndex === -1
      ? undefined
      : readOpencodeLayerField(
          agentOverlay,
          categoryOverlay,
          OPENCODE_MODEL_VARIANT_LAYERS[modelLayerIndex],
          'model',
        )
  const model = narrowModelValue(rawModel)
  const hasModel = model !== undefined
  const modelSource = hasModel
    ? OPENCODE_MODEL_VARIANT_LAYERS[modelLayerIndex]
    : undefined

  let qualifier: string | undefined
  let qualifierSource: RoutingFieldSource | undefined

  if (model !== null) {
    const eligibleLayerCount = hasModel
      ? modelLayerIndex + 1
      : OPENCODE_MODEL_VARIANT_LAYERS.length
    for (let i = 0; i < eligibleLayerCount; i++) {
      const layer = OPENCODE_MODEL_VARIANT_LAYERS[i]
      const narrowed = narrowQualifierValue(
        readOpencodeLayerField(agentOverlay, categoryOverlay, layer, 'variant'),
      )
      if (narrowed !== undefined) {
        qualifier = narrowed
        qualifierSource = layer
        break
      }
    }
  }

  return { model, modelSource, qualifier, qualifierSource }
}

/**
 * Resolve the Pi qualifier (`thinking`): agent block > category block, then
 * (only if still unresolved) the legacy `pi_subagents` location, agent
 * before category. There is no flat `thinking` field — `thinking` only ever
 * lives inside the `pi` block or the legacy `pi_subagents` map. `thinking`
 * never surfaces on `opencode`.
 *
 * Also computes `legacyPresent` independently of which value wins: R5
 * requires a deprecation warning whenever the legacy field is set at all,
 * even when a `pi.thinking` block also exists and takes precedence over it.
 */
function resolvePiThinking(
  agentOverlay: OverlayConfig | undefined,
  categoryOverlay: OverlayConfig | undefined,
  piSubagentsOverlays: SourcedOverlayConfigMap,
  target: RoutingTarget,
): {
  value: string | undefined
  source: RoutingFieldSource | undefined
  legacyPresent: boolean
} {
  const blockResolution = resolveField([
    {
      value: readBlockField(agentOverlay, 'pi', 'thinking'),
      source: { level: 'agent', form: 'block' },
    },
    {
      value: readBlockField(categoryOverlay, 'pi', 'thinking'),
      source: { level: 'category', form: 'block' },
    },
  ])

  const legacyAgentThinking = getOverlayValue(
    piSubagentsOverlays.agents,
    target.agentKey,
  )?.thinking
  const legacyCategoryThinking = getOverlayValue(
    piSubagentsOverlays.categories,
    target.category,
  )?.thinking
  const legacyValue =
    legacyAgentThinking !== undefined
      ? legacyAgentThinking
      : legacyCategoryThinking
  const legacyPresent = legacyValue !== undefined

  const narrowedBlockValue = narrowQualifierValue(blockResolution.value)
  if (narrowedBlockValue !== undefined) {
    return {
      value: narrowedBlockValue,
      source: blockResolution.source,
      legacyPresent,
    }
  }

  const narrowedLegacyValue = narrowQualifierValue(legacyValue)
  if (narrowedLegacyValue !== undefined) {
    return {
      value: narrowedLegacyValue,
      source: {
        level: legacyAgentThinking !== undefined ? 'agent' : 'category',
        form: 'legacy-pi-subagents',
      },
      legacyPresent,
    }
  }

  return { value: undefined, source: undefined, legacyPresent }
}

/**
 * Resolve the effective `{ model, qualifier, source }` for one target on one
 * harness. Pure — same inputs always produce the same output; no I/O, no
 * console output, no throwing.
 */
export function resolveRouting(input: ResolveRoutingInput): RoutingResolution {
  const { overlays, piSubagentsOverlays, target, harness } = input
  const agentOverlay = lookupAgentOverlay(overlays, target)
  const categoryOverlay = getOverlayValue(overlays.categories, target.category)

  if (harness === 'opencode') {
    const resolution = resolveOpencodeModelAndVariant(
      agentOverlay,
      categoryOverlay,
    )
    return {
      model: resolution.model,
      qualifier: resolution.qualifier,
      source: {
        model: resolution.modelSource,
        qualifier: resolution.qualifierSource,
      },
      legacyPiSubagentsThinkingPresent: false,
      harness,
    }
  }

  // Pi: model and thinking resolve INDEPENDENTLY. Unlike opencode's variant,
  // Pi's thinking level applies to whatever model the delegate ends up
  // running, including a model inherited from the parent session/agent when
  // no layer sets one at all -- exactly how `main` treated
  // `pi_subagents.thinking` and how `resolvePersonaRouting` already applies
  // `thinkingLevel` at dispatch time regardless of where `model` came from.
  // There is no model/qualifier coupling to enforce here.
  const modelResolution = resolveModel(agentOverlay, categoryOverlay, harness)
  const qualifierResolution = resolvePiThinking(
    agentOverlay,
    categoryOverlay,
    piSubagentsOverlays,
    target,
  )
  return {
    model: modelResolution.value,
    qualifier: qualifierResolution.value,
    source: {
      model: modelResolution.source,
      qualifier: qualifierResolution.source,
    },
    legacyPiSubagentsThinkingPresent: qualifierResolution.legacyPresent,
    harness,
  }
}

/**
 * True when the OpenCode `variant` resolved but no model resolved at any
 * layer (`model` is `undefined` — `null` counts as a resolved model meaning
 * "inherit", so it does NOT trigger this). Used by the loader's post-merge
 * check to raise a config error naming the target and harness (R3b).
 *
 * ALWAYS false for the `pi` harness: Pi's `thinking` qualifier is
 * independent of `model` by design (see `resolveRouting`'s Pi branch) — it
 * applies to whatever model the delegate ends up running, including one
 * inherited from the parent session, so "thinking with no model anywhere"
 * is a normal, valid configuration, not an error. This function self-guards
 * on `resolution.harness` rather than relying on every caller to only ever
 * invoke it for opencode resolutions.
 */
export function qualifierResolvesWithoutModel(
  resolution: RoutingResolution,
): boolean {
  if (resolution.harness !== 'opencode') return false
  return resolution.qualifier !== undefined && resolution.model === undefined
}

/**
 * Format the one-line deprecation message for a WRITTEN
 * `pi_subagents.<scope>.<key>.thinking` field, naming the exact path the
 * user wrote and the replacement path it should move to. `scope` is
 * `'agents'` or `'categories'`, matching whichever map the field was
 * actually written under -- a category-level write is never renamed to
 * look like an agent-level path (or vice versa).
 */
export function formatWrittenLegacyPiSubagentsThinkingWarning(
  scope: 'agents' | 'categories',
  key: string,
): string {
  const writtenPath = `pi_subagents.${scope}.${key}.thinking`
  const replacementPath = `${scope}.${key}.pi.thinking`
  return (
    `[systematic] ${writtenPath} is deprecated; set ${replacementPath} instead. The legacy value is ` +
    'honoured only when the new location is unset, and support for it will be removed in a future release.'
  )
}

/**
 * Collect one deprecation-warning message per WRITTEN
 * `pi_subagents.<scope>.<key>.thinking` field found directly in the merged
 * `pi_subagents` overlays -- NOT one per agent the field happens to
 * resolve for. A category-level write (`pi_subagents.categories.<c>.thinking`)
 * fans out to every bundled agent in that category when resolved through
 * `resolveRouting` (by design -- that is how the legacy fallback applies),
 * but the user only wrote ONE field, so they should see exactly ONE
 * warning naming exactly the field they wrote, not N warnings each naming
 * an agent-level path they never touched. The warning fires whenever the
 * field is written, regardless of whether a higher-priority `pi.thinking`
 * block ends up winning for any given agent -- a written legacy field is
 * always deprecated, whether or not it is currently shadowed.
 */
export function collectWrittenLegacyPiSubagentsThinkingWarnings(
  piSubagentsOverlays: SourcedOverlayConfigMap,
): string[] {
  const warnings: string[] = []
  for (const scope of ['agents', 'categories'] as const) {
    for (const [key, overlay] of Object.entries(piSubagentsOverlays[scope])) {
      if (
        !isRecord(overlay.value) ||
        !Object.hasOwn(overlay.value, 'thinking')
      ) {
        continue
      }
      warnings.push(formatWrittenLegacyPiSubagentsThinkingWarning(scope, key))
    }
  }
  return warnings
}
