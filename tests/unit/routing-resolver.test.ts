import { describe, expect, test } from 'bun:test'
import type {
  OverlayConfig,
  SourcedOverlayConfig,
  SourcedOverlayConfigMap,
} from '../../src/lib/config.js'
import {
  collectLegacyPiSubagentsThinkingWarnings,
  formatLegacyPiSubagentsThinkingWarning,
  qualifierResolvesWithoutModel,
  type RoutingResolutionEntry,
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

  test('error-precursor: agents.x.pi.thinking with no model anywhere \u2192 qualifier resolves, model undefined', () => {
    const merged = overlays({ x: { pi: { thinking: 'high' } } })
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'pi',
    })
    expect(resolution.qualifier).toBe('high')
    expect(resolution.model).toBeUndefined()
    expect(qualifierResolvesWithoutModel(resolution)).toBe(true)
  })

  test('qualifierResolvesWithoutModel is false when model resolves to null (inherit counts as a model)', () => {
    const merged = overlays({ x: { model: null, variant: 'high' } })
    const resolution = resolveRouting({
      overlays: merged,
      piSubagentsOverlays: EMPTY_PI_SUBAGENTS,
      target: target('x', 'review'),
      harness: 'opencode',
    })
    expect(resolution.model).toBeNull()
    expect(resolution.qualifier).toBe('high')
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
})

describe('collectLegacyPiSubagentsThinkingWarnings', () => {
  function entry(
    agentKey: string,
    category: string,
    legacyPresent: boolean,
  ): RoutingResolutionEntry {
    return {
      target: target(agentKey, category),
      resolution: {
        model: 'anthropic/M',
        qualifier: undefined,
        source: { model: undefined, qualifier: undefined },
        legacyPiSubagentsThinkingPresent: legacyPresent,
      },
    }
  }

  test('two targets with legacy present \u2192 two warnings, one each', () => {
    const warnings = collectLegacyPiSubagentsThinkingWarnings([
      entry('x', 'review', true),
      entry('y', 'review', true),
    ])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('x')
    expect(warnings[1]).toContain('y')
  })

  test('same target resolved twice \u2192 still one warning', () => {
    const warnings = collectLegacyPiSubagentsThinkingWarnings([
      entry('x', 'review', true),
      entry('x', 'review', true),
    ])
    expect(warnings).toHaveLength(1)
  })

  test('entries with legacyPresent false produce no warnings', () => {
    const warnings = collectLegacyPiSubagentsThinkingWarnings([
      entry('x', 'review', false),
    ])
    expect(warnings).toHaveLength(0)
  })

  test('formatLegacyPiSubagentsThinkingWarning names the new location', () => {
    const message = formatLegacyPiSubagentsThinkingWarning(
      target('x', 'review'),
    )
    expect(message).toContain('agents.x.pi.thinking')
    expect(message).toContain('pi_subagents.agents.x.thinking')
  })
})
