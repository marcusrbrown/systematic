import { describe, expect, test } from 'bun:test'
import type {
  OverlayConfig,
  SourcedOverlayConfig,
  SourcedOverlayConfigMap,
} from '../../src/lib/config.js'
import {
  collectWrittenLegacyPiSubagentsThinkingWarnings,
  formatWrittenLegacyPiSubagentsThinkingWarning,
  qualifierResolvesWithoutModel,
  type RoutingTarget,
  resolveRouting,
} from '../../src/lib/routing-resolver.js'

function overlay(value: OverlayConfig): SourcedOverlayConfig {
  return { value, sourcePath: '/fake/systematic.json', keyPath: 'fake' }
}

function overlays(
  agents: Record<string, OverlayConfig>,
  categories: Record<string, OverlayConfig> = {},
): SourcedOverlayConfigMap {
  return {
    agents: Object.fromEntries(
      Object.entries(agents).map(([k, v]) => [k, overlay(v)]),
    ),
    categories: Object.fromEntries(
      Object.entries(categories).map(([k, v]) => [k, overlay(v)]),
    ),
  }
}

const EMPTY_PI_SUBAGENTS: SourcedOverlayConfigMap = {
  agents: {},
  categories: {},
}

function target(agentKey: string, category: string): RoutingTarget {
  return { agentKey, category }
}

describe('resolveRouting', () => {
  test('happy: agent flat model + category opencode.model \u2192 agent flat wins (AE5a)', () => {
    const merged = overlays(
      { oracle: { model: 'anthropic/agent-flat' } },
      { review: { opencode: { model: 'anthropic/category-block' } } },
    )
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('oracle', 'review'),
      harness: 'opencode',
    })
    expect(resolution.model).toBe('anthropic/agent-flat')
    expect(resolution.source.model).toEqual({ level: 'agent', form: 'flat' })
  })

  test('happy: base agent model + profile-only pi.thinking \u2192 base model with that thinking on pi (AE5)', () => {
    // "profile-only pi.thinking" is represented here as the already-merged
    // overlay carrying both fields -- the profile-merge mechanics that
    // combine a base model with a profile's pi.thinking fragment are Unit
    // 2's concern (mergeProfileOverlayValue); this resolver only sees the
    // post-merge result.
    const merged = overlays({
      oracle: { model: 'anthropic/base-model', pi: { thinking: 'high' } },
    })
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('oracle', 'review'),
      harness: 'pi',
    })
    expect(resolution.model).toBe('anthropic/base-model')
    expect(resolution.qualifier).toBe('high')
    expect(resolution.source.qualifier).toEqual({
      level: 'agent',
      form: 'block',
    })
  })

  test('happy: profile categories.review.pi.model + base agents.oracle.model \u2192 oracle\u2019s own model wins on pi (agent level beats category)', () => {
    const merged = overlays(
      { oracle: { model: 'anthropic/oracle-own' } },
      { review: { pi: { model: 'anthropic/category-pi' } } },
    )
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('oracle', 'review'),
      harness: 'pi',
    })
    expect(resolution.model).toBe('anthropic/oracle-own')
    expect(resolution.source.model).toEqual({ level: 'agent', form: 'flat' })
  })

  test('edge: agents.x.pi.model: null over a category explicit model \u2192 inherit (null wins, source agent/block)', () => {
    const merged = overlays(
      { x: { pi: { model: null } } },
      { review: { model: 'anthropic/category-explicit' } },
    )
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'pi',
    })
    expect(resolution.model).toBeNull()
    expect(resolution.source.model).toEqual({ level: 'agent', form: 'block' })
  })

  test('edge: base agents.x.opencode.model: M + flat agents.x.model: null \u2192 opencode gets M (block beats flat), pi inherits (null)', () => {
    const merged = overlays({
      x: { model: null, opencode: { model: 'anthropic/M' } },
    })
    const opencodeResolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'opencode',
    })
    expect(opencodeResolution.model).toBe('anthropic/M')
    expect(opencodeResolution.source.model).toEqual({
      level: 'agent',
      form: 'block',
    })

    const piResolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'pi',
    })
    expect(piResolution.model).toBeNull()
    expect(piResolution.source.model).toEqual({ level: 'agent', form: 'flat' })
  })

  test('edge: opencode.variant set, pi block absent \u2192 pi qualifier is undefined, never "variant"', () => {
    const merged = overlays({
      x: { model: 'anthropic/M', opencode: { variant: 'v2' } },
    })
    const piResolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'pi',
    })
    expect(piResolution.qualifier).toBeUndefined()

    const opencodeResolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'opencode',
    })
    expect(opencodeResolution.qualifier).toBe('v2')
  })

  test('variant never surfaces on pi even when both agent variant (flat) and pi.model are set', () => {
    const merged = overlays({
      x: { model: 'anthropic/M', variant: 'v2' },
    })
    const piResolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'pi',
    })
    expect(piResolution.qualifier).toBeUndefined()
  })

  test('thinking never surfaces on opencode', () => {
    const merged = overlays({
      x: { model: 'anthropic/M', pi: { thinking: 'high' } },
    })
    const opencodeResolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'opencode',
    })
    expect(opencodeResolution.qualifier).toBeUndefined()
  })

  // A category sets BOTH model and variant; a more specific agent layer
  // sets only model. The more specific model wins AND clears the less
  // specific layer's stale variant -- a category variant is not implicitly
  // "inherited" by an agent that overrides the category's model.
  test('category model+variant, agent overrides model only \u2192 agent model wins, category variant is dropped', () => {
    const merged = overlays(
      { 'correctness-reviewer': { model: 'openai/gpt-5' } },
      { review: { model: 'openai/gpt-4o', variant: 'v1' } },
    )
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('correctness-reviewer', 'review'),
      harness: 'opencode',
    })
    expect(resolution.model).toBe('openai/gpt-5')
    expect(resolution.qualifier).toBeUndefined()
    expect(resolution.source.qualifier).toBeUndefined()
  })

  // Same scenario, but the agent overrides with an explicit `model: null`
  // (inherit) instead of a concrete model -- neither model nor variant
  // should resolve.
  test('category model+variant, agent overrides with model: null \u2192 neither model nor variant resolve', () => {
    const merged = overlays(
      { 'correctness-reviewer': { model: null } },
      { review: { model: 'openai/gpt-4o', variant: 'v1' } },
    )
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('correctness-reviewer', 'review'),
      harness: 'opencode',
    })
    expect(resolution.model).toBeNull()
    expect(resolution.qualifier).toBeUndefined()
  })

  // R3b: a MORE specific layer may still set variant alone over a LESS
  // specific layer's model -- the opposite direction from the scenario
  // above. An agent-level opencode.variant with no agent model, over a flat
  // agent model, is still "at least as specific as" the model's layer
  // (agent flat), so it survives.
  test('R3b: agents.x.opencode.variant + flat agents.x.model \u2192 flat model wins, block variant survives (more specific than the model layer)', () => {
    const merged = overlays({
      x: { model: 'anthropic/M', opencode: { variant: 'high' } },
    })
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'opencode',
    })
    expect(resolution.model).toBe('anthropic/M')
    expect(resolution.qualifier).toBe('high')
    expect(resolution.source.qualifier).toEqual({
      level: 'agent',
      form: 'block',
    })
  })

  test('error-precursor: agents.x.variant with no model anywhere \u2192 qualifier resolves, model undefined', () => {
    const merged = overlays({ x: { variant: 'high' } })
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'opencode',
    })
    expect(resolution.qualifier).toBe('high')
    expect(resolution.model).toBeUndefined()
    expect(qualifierResolvesWithoutModel(resolution)).toBe(true)
  })

  // Pi's `thinking` is independent of `model` by design -- it applies to
  // whatever model the delegate ends up running, including one inherited
  // from the parent session, and `resolvePersonaRouting` already applies
  // `thinkingLevel` regardless of where `model` came from. "thinking with
  // no model anywhere" is therefore a normal, valid configuration on Pi,
  // never a `qualifierResolvesWithoutModel` violation -- unlike the
  // opencode `variant` case immediately above, which is still correctly
  // rejected.
  test('agents.x.pi.thinking with no model anywhere \u2192 resolves fine, never a violation (thinking is model-independent)', () => {
    const merged = overlays({ x: { pi: { thinking: 'high' } } })
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'pi',
    })
    expect(resolution.qualifier).toBe('high')
    expect(resolution.model).toBeUndefined()
    expect(qualifierResolvesWithoutModel(resolution)).toBe(false)
  })

  // An explicit `model: null` at the SAME layer as `variant` means
  // "inherit the parent's model AND variant" -- there is no "inherited
  // model, explicit variant" combination, so the variant set alongside a
  // null model at the same fragment is dropped, not preserved. (A
  // `variant` from a MORE specific layer than the null model still
  // survives -- see the R3b test below.)
  test('model: null and variant in the SAME fragment \u2192 variant is dropped (null model means inherit variant too)', () => {
    const merged = overlays({ x: { model: null, variant: 'high' } })
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'opencode',
    })
    expect(resolution.model).toBeNull()
    expect(resolution.qualifier).toBeUndefined()
    expect(resolution.source.qualifier).toBeUndefined()
    expect(qualifierResolvesWithoutModel(resolution)).toBe(false)
  })

  describe('R5: legacy pi_subagents.thinking fallback', () => {
    test('legacy thinking present, no pi block \u2192 resolves to legacy value, source legacy, legacyPresent true', () => {
      const merged = overlays({ x: { model: 'anthropic/M' } })
      const legacy = overlays({ x: { thinking: 'low' } })
      const resolution = resolveRouting({
        overlays: merged,
        piSubagentsOverlays: legacy,
        target: target('x', 'review'),
        harness: 'pi',
      })
      expect(resolution.qualifier).toBe('low')
      expect(resolution.source.qualifier).toEqual({
        level: 'agent',
        form: 'legacy-pi-subagents',
      })
      expect(resolution.legacyPiSubagentsThinkingPresent).toBe(true)
    })

    test('both set and disagreeing: pi block wins the resolved value, legacyPresent is still true', () => {
      const merged = overlays({
        x: { model: 'anthropic/M', pi: { thinking: 'high' } },
      })
      const legacy = overlays({ x: { thinking: 'low' } })
      const resolution = resolveRouting({
        overlays: merged,
        piSubagentsOverlays: legacy,
        target: target('x', 'review'),
        harness: 'pi',
      })
      expect(resolution.qualifier).toBe('high')
      expect(resolution.source.qualifier).toEqual({
        level: 'agent',
        form: 'block',
      })
      expect(resolution.legacyPiSubagentsThinkingPresent).toBe(true)
    })

    test('legacy category form is consulted when no legacy agent value is set', () => {
      const merged = overlays({ x: { model: 'anthropic/M' } })
      const legacy = overlays({}, { review: { thinking: 'medium' } })
      const resolution = resolveRouting({
        overlays: merged,
        piSubagentsOverlays: legacy,
        target: target('x', 'review'),
        harness: 'pi',
      })
      expect(resolution.qualifier).toBe('medium')
      expect(resolution.source.qualifier).toEqual({
        level: 'category',
        form: 'legacy-pi-subagents',
      })
    })

    test('legacy agent form takes precedence over legacy category form', () => {
      const merged = overlays({ x: { model: 'anthropic/M' } })
      const legacy = overlays(
        { x: { thinking: 'high' } },
        { review: { thinking: 'low' } },
      )
      const resolution = resolveRouting({
        overlays: merged,
        piSubagentsOverlays: legacy,
        target: target('x', 'review'),
        harness: 'pi',
      })
      expect(resolution.qualifier).toBe('high')
      expect(resolution.source.qualifier).toEqual({
        level: 'agent',
        form: 'legacy-pi-subagents',
      })
    })

    test('opencode harness never reports legacyPiSubagentsThinkingPresent', () => {
      const merged = overlays({ x: { model: 'anthropic/M' } })
      const legacy = overlays({ x: { thinking: 'low' } })
      const resolution = resolveRouting({
        overlays: merged,
        piSubagentsOverlays: legacy,
        target: target('x', 'review'),
        harness: 'opencode',
      })
      expect(resolution.legacyPiSubagentsThinkingPresent).toBe(false)
    })
  })

  describe('bare vs qualified agent overlay key lookup', () => {
    test('resolves via a bare agent overlay key', () => {
      const merged = overlays({ oracle: { model: 'anthropic/bare' } })
      const resolution = resolveRouting({
        overlays: merged,
        piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
        target: target('oracle', 'review'),
        harness: 'opencode',
      })
      expect(resolution.model).toBe('anthropic/bare')
    })

    test('resolves via a qualified category/name overlay key', () => {
      const merged = overlays({
        'review/oracle': { model: 'anthropic/qualified' },
      })
      const resolution = resolveRouting({
        overlays: merged,
        piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
        target: target('oracle', 'review'),
        harness: 'opencode',
      })
      expect(resolution.model).toBe('anthropic/qualified')
    })
  })

  test('no overlay data anywhere \u2192 model and qualifier both undefined, no violation', () => {
    const resolution = resolveRouting({
      overlays: overlays({}, {}),
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('oracle', 'review'),
      harness: 'opencode',
    })
    expect(resolution.model).toBeUndefined()
    expect(resolution.qualifier).toBeUndefined()
    expect(qualifierResolvesWithoutModel(resolution)).toBe(false)
  })

  // Runtime narrowing instead of casts. Config
  // values are Zod-validated at the config-load boundary, so a non-string
  // `model` can never reach the resolver from real JSONC input -- this test
  // feeds one in programmatically (bypassing that boundary entirely, the
  // way a future consumer with different validation might) to prove the
  // resolver narrows defensively instead of trusting a cast.
  test('a non-string model value narrows to undefined instead of being cast through', () => {
    const merged = overlays({ x: { model: 42 } })
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'opencode',
    })
    expect(resolution.model).toBeUndefined()
    expect(resolution.source.model).toBeUndefined()
  })
})

describe('collectWrittenLegacyPiSubagentsThinkingWarnings', () => {
  function piSubagentsOverlaysWith(
    agents: Record<string, OverlayConfig>,
    categories: Record<string, OverlayConfig> = {},
  ): SourcedOverlayConfigMap {
    const wrap = (
      map: Record<string, OverlayConfig>,
      scope: 'agents' | 'categories',
    ): Record<string, SourcedOverlayConfig> =>
      Object.fromEntries(
        Object.entries(map).map(([key, value]) => [
          key,
          {
            value,
            sourcePath: '/fake/systematic.json',
            keyPath: `pi_subagents.${scope}.${key}`,
          },
        ]),
      )
    return {
      agents: wrap(agents, 'agents'),
      categories: wrap(categories, 'categories'),
    }
  }

  test('two written agent-level fields \u2192 two warnings, one each naming the exact written path', () => {
    const warnings = collectWrittenLegacyPiSubagentsThinkingWarnings(
      piSubagentsOverlaysWith({
        x: { thinking: 'low' },
        y: { thinking: 'high' },
      }),
    )
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('pi_subagents.agents.x.thinking')
    expect(warnings[1]).toContain('pi_subagents.agents.y.thinking')
  })

  // Dedup by the WRITTEN field, not by every agent a category-level write
  // happens to resolve for: a single category-level write is ONE field,
  // so it must produce exactly ONE warning naming exactly the category
  // path the user wrote, never one per bundled agent in that category.
  test('one written category-level field \u2192 exactly one warning naming the category path, not an agent path', () => {
    const warnings = collectWrittenLegacyPiSubagentsThinkingWarnings(
      piSubagentsOverlaysWith({}, { review: { thinking: 'low' } }),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('pi_subagents.categories.review.thinking')
    expect(warnings[0]).toContain('categories.review.pi.thinking')
  })

  test('a field written without `thinking` produces no warning', () => {
    const warnings = collectWrittenLegacyPiSubagentsThinkingWarnings(
      piSubagentsOverlaysWith({ x: { max_turns: 10 } }),
    )
    expect(warnings).toHaveLength(0)
  })

  test('formatWrittenLegacyPiSubagentsThinkingWarning names the written path and the replacement, agent form', () => {
    const message = formatWrittenLegacyPiSubagentsThinkingWarning('agents', 'x')
    expect(message).toContain('pi_subagents.agents.x.thinking')
    expect(message).toContain('agents.x.pi.thinking')
  })

  test('formatWrittenLegacyPiSubagentsThinkingWarning names the written path and the replacement, category form', () => {
    const message = formatWrittenLegacyPiSubagentsThinkingWarning(
      'categories',
      'review',
    )
    expect(message).toContain('pi_subagents.categories.review.thinking')
    expect(message).toContain('categories.review.pi.thinking')
  })
})
