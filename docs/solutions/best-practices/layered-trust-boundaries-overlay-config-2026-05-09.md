---
title: Layered trust boundaries for plugin overlay configuration fields
date: 2026-05-09
category: docs/solutions/best-practices/
module: config-system
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - Designing config overlays where multiple sources can contribute (defaults, user, project, env)
  - Adding a new field that affects model selection, permissions, capabilities, or data routing
  - Reviewing a config-merge implementation that treats all overlay fields uniformly
  - Allowing project-local config files (which collaborators commit to a repo) to set policy
related_components:
  - tooling
  - authentication
tags: [config, security, trust-boundaries, overlay, merge, policy]
---

# Layered trust boundaries for plugin overlay configuration fields

## Context

Systematic's first agent-overlay implementation (PR #343) merged top-level
`agents` and `categories` config maps from four sources with a uniform same-key
replacement rule: `$OPENCODE_CONFIG_DIR > project .opencode/systematic.json >
user ~/.config/opencode/systematic.json > defaults`. Whichever source had the
highest priority for a given key won — for *every* field on that key.

PR #344 review found this conflated two distinct trust profiles. Some overlay
fields are **presentational** (`color`, `hidden`, `description-suffix`) — the
person editing project config typically owns the visual experience and should
be able to set them. Other fields are **policy** (`model`, `permission`,
`skills`, eventually `mcps`, `fallback_models`) — they affect cost, privacy,
data routing, and capability surface area. Letting a committed-to-repo project
config silently route prompts to a different provider, or grant capability
access the user-level config explicitly denied, is a security regression
disguised as a convenience.

The committed-config-as-repo-artifact part is the lever. A teammate's
`.opencode/systematic.json` lands on your machine through `git pull`. If that
file can set `agents.<x>.model: provider/sketchy-model`, the user-level
config's intentional model choice has been silently overridden by code review.

## Guidance

Don't merge overlay fields uniformly. Split fields by trust profile and
enforce that at config-load time, not later:

1. **Define an explicit `PROTECTED_OVERLAY_FIELDS` allow-list** of fields that
   only the user-level and `OPENCODE_CONFIG_DIR` sources may set or erase. In
   Systematic this currently includes `model`, `fallback_models`, `permission`,
   `skills`, and `mcps`.
2. **Reject project-source attempts to set protected fields** with an error
   that names the source path and config key. The error message should be
   actionable: "Field `agents.correctness-reviewer.model` is only valid in
   user config or OPENCODE_CONFIG_DIR config; project config cannot set or
   erase model routing policy."
3. **Allow project sources to set non-protected fields** (`temperature`,
   `top_p`, `mode`, `color`, `steps`, `hidden`, `variant`, `disable`) since
   those don't carry the same trust weight.
4. **Replace-not-erase semantics**: a project same-key overlay must not be
   able to wipe a higher-trust field by writing the same agent key with that
   field absent. Field-aware merge: protected fields from higher-trust sources
   survive even when a lower-trust source replaces the same key wholesale.
5. **Field-aware fallback chains**: a stronger explicit `model` from a
   higher-trust source suppresses a weaker source's `fallback_models` unless
   the same stronger source also provides `fallback_models` — otherwise source
   defaults could route fallback traffic after a user-selected primary.
6. **Test the security boundary explicitly**, not as a side effect. A project
   config file containing `agents.x.model: ...` must have a regression test
   that asserts it throws.

## Why This Matters

- **Project config is collaborator-controlled, user config is user-controlled.**
  These are different trust contexts. A merge model that doesn't reflect that
  is broken by design, not by oversight.
- **The "convenience" framing hides cost.** Letting project config tune the
  visual treatment of agents is convenience. Letting it choose providers is
  silent policy override. Splitting the fields keeps the convenience without
  the override.
- **Detection must be fail-fast, not best-effort.** If you check trust at
  config-application time (during the plugin `config(cfg)` hook), invalid
  policy may have already partially mutated `config.agent`, `config.command`,
  `config.skills.paths`, or `config.mcp`. Validate before any mutation; build
  staged copies and assign once.
- **Field-aware merge protects the user from their own collaborators.** Even
  with good intent, a teammate adding `agents.<x>.model: their-favorite-model`
  to project config shouldn't override a user-level deny — and shouldn't
  succeed silently.

## When to Apply

- Adding a new overlay field to any plugin that loads config from multiple
  sources at different trust levels
- Reviewing existing overlay merge logic before shipping security-sensitive
  features (model routing, capability allowlists, permission rules)
- Designing a fallback chain or model-selection feature where users will
  naturally want to express "my user config picks A, never anything else"
- Auditing whether a "convenience" config feature crosses into "policy"

## Examples

### Before (PR #343 — uniform same-key replacement)

```ts
// Same-key replacement at every source priority.
function mergeOverlayMaps(sources) {
  const result = {}
  for (const source of sources) { // ordered weakest-to-strongest
    for (const [key, value] of Object.entries(source.agents ?? {})) {
      result[key] = value // wholesale replacement, all fields
    }
  }
  return result
}

// Project config can set model, permission, skills, etc. with no resistance.
```

### After (PR #344 — protected-field guard)

```ts
const PROTECTED_OVERLAY_FIELDS = [
  'model',
  'fallback_models',
  'permission',
  'skills',
  'mcps',
] as const

function loadProjectConfig(path) {
  const raw = readJSON(path)
  // Reject protected fields at load time, before any merge.
  for (const [key, value] of Object.entries(raw.agents ?? {})) {
    for (const field of PROTECTED_OVERLAY_FIELDS) {
      if (field in value) {
        throw new Error(
          `Field 'agents.${key}.${field}' in ${path} is only valid in ` +
          `user config or OPENCODE_CONFIG_DIR config; ` +
          `project config cannot set or erase model routing policy.`
        )
      }
    }
  }
  return raw
}

// Field-aware merge preserves higher-trust protected fields even when
// a lower-trust source replaces the same key wholesale.
function mergeOverlayMaps(sources) {
  const result = {}
  for (const source of sources) { // ordered weakest-to-strongest
    for (const [key, incoming] of Object.entries(source.agents ?? {})) {
      const existing = result[key]
      if (!existing) { result[key] = incoming; continue }
      // Lower-trust replacement: keep higher-trust protected fields.
      const merged = { ...incoming }
      if (source.trust < existing.trust) {
        for (const field of PROTECTED_OVERLAY_FIELDS) {
          if (field in existing) merged[field] = existing[field]
        }
      }
      result[key] = merged
    }
  }
  return result
}
```

### Test scenario that names the boundary

```ts
test('project overlays reject model: null as security field violation', () => {
  const projectConfigPath = path.join(testDir, '.opencode/systematic.json')
  fs.writeFileSync(
    projectConfigPath,
    JSON.stringify({ agents: { 'correctness-reviewer': { model: null } } }),
  )
  expect(() => loadConfigWithSources(testDir)).toThrow(projectConfigPath)
  expect(() => loadConfigWithSources(testDir)).toThrow(
    /only valid in user config or OPENCODE_CONFIG_DIR config/,
  )
})
```

The test names the threat (`security field violation`) and the policy
(`project ... cannot set or erase model routing policy`). Future readers
understand it's not a syntax check — it's a trust boundary.

## Related

- PR #343 (squash d5a3678) — initial overlay implementation, uniform merge
- PR #344 (squash 0fb3fbc) — trust-boundary hardening
- PR #345 (squash 1eecfb0) — extended `PROTECTED_OVERLAY_FIELDS` to include
  `fallback_models` for the source-default model chain feature
- `src/lib/config.ts` — current implementation of the protected-field guard
- `tests/unit/config.test.ts` — regression coverage for the boundary
