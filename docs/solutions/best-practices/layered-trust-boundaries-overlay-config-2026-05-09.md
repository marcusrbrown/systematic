---
title: Trust-sensitive overlay fields in plugin configuration
date: 2026-05-09
category: best-practices
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
tags: [config, security, overlay, merge, allowlist, trust]
---

# Trust-sensitive overlay fields in plugin configuration

## Context

Systematic's first agent-overlay implementation (PR #343) merged top-level
`agents` and `categories` config maps from four sources with a uniform same-key
replacement rule: `$OPENCODE_CONFIG_DIR > project .opencode/systematic.json >
user ~/.config/opencode/systematic.json > defaults`. Whichever source had the
highest priority for a given key won — for *every* field on that key.

PR #344 review found this conflated two distinct trust profiles. Most overlay
fields are project-tunable — `temperature`, `top_p`, `mode`, `color`, `steps`,
`hidden`, exact-agent `disable` — the person editing project config typically
owns the runtime knob and tuning them is convenience, not policy. A small set
of fields are trust-sensitive: they affect provider routing, cost, privacy,
capability surface area, or data routing. Letting a committed-to-repo project
config silently route prompts to a different provider, or grant capability
access the user-level config explicitly denied, is a security regression
disguised as a convenience.

The committed-config-as-repo-artifact part is the lever. A teammate's
`.opencode/systematic.json` lands on your machine through `git pull`. If that
file can set `agents.<x>.model: provider/sketchy-model`, the user-level
config's intentional model choice has been silently overridden by code review.

## Guidance

Don't merge overlay fields uniformly. Identify the trust-sensitive subset and
enforce that at config-load time, not at config-application time:

1. **Define an explicit `SECURITY_OVERLAY_FIELDS` allowlist** of fields that
   only the user-level and `OPENCODE_CONFIG_DIR` sources may set or erase. In
   Systematic at HEAD this is exactly four fields:
   - `model` — provider routing, cost, data routing
   - `variant` — provider routing variant (per `README.md`, controls
     "provider routing/cost/privacy")
   - `permission` — tool/skill permission rules
   - `skills` — managed skill allowlist (translates to `permission.skill`)
2. **Reject project-source attempts to set protected fields** with an error
   that names the source path and config key. The error message should be
   actionable: "Field `agents.correctness-reviewer.model` is only valid in
   user config or OPENCODE_CONFIG_DIR config".
3. **Allow project sources to set non-protected fields** (`temperature`,
   `top_p`, `mode`, `color`, `steps`, `hidden`, exact-agent `disable`) since
   those don't carry the same trust weight.
4. **Replace-not-erase semantics**: a project same-key overlay must not be
   able to wipe a higher-trust field by writing the same agent key with that
   field absent. Field-aware merge: protected fields from higher-trust sources
   survive even when a lower-trust source replaces the same key wholesale.
5. **Test the security boundary explicitly**, not as a side effect. A project
   config file containing `agents.x.model: ...` must have a regression test
   that asserts it throws.
6. **When a new field gets proposed, classify it through this boundary first.**
   Future overlay fields like fallback chains or MCP-capability allowlists
   should be classified through this same trust-sensitive boundary before
   shipping. Don't let the field set drift implicitly.

## Why This Matters

- **Project config is collaborator-controlled, user config is user-controlled.**
  These are different trust contexts. A merge model that doesn't reflect that
  is broken by design, not by oversight.
- **The "convenience" framing hides cost.** Letting project config tune the
  runtime knobs of agents is convenience. Letting it choose providers is
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

### After (PR #344 — security-field guard)

The actual implementation in `src/lib/config.ts` rejects security fields at
load time when the source trust level is `'project'`, then preserves any
higher-trust security fields when project config replaces the same key:

```ts
const SECURITY_OVERLAY_FIELDS = new Set([
  'model',
  'variant',
  'permission',
  'skills',
])

interface SourcedOverlayConfig {
  value: Record<string, unknown>
  sourcePath: string
  keyPath: string
}

interface SourceInput {
  config: { agents?: Record<string, Record<string, unknown>> }
  path: string
  trust: 'default' | 'user' | 'project' | 'custom'
}

function rejectProjectSecurityOverlay(
  sourcePath: string,
  keyPath: string,
  value: Record<string, unknown>,
): void {
  for (const field of SECURITY_OVERLAY_FIELDS) {
    if (Object.hasOwn(value, field)) {
      throw new Error(
        `Invalid Systematic config in ${sourcePath}: ` +
          `${keyPath}.${field} is only valid in user config or ` +
          `OPENCODE_CONFIG_DIR config`,
      )
    }
  }
}

function preserveSecurityFields(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...next }
  for (const field of SECURITY_OVERLAY_FIELDS) {
    if (Object.hasOwn(previous, field)) {
      result[field] = previous[field]
    }
  }
  return result
}

function mergeOverlayMap(
  target: Record<string, SourcedOverlayConfig>,
  source: SourceInput,
): void {
  const overlayMap = source.config.agents
  if (!overlayMap) return

  for (const [key, value] of Object.entries(overlayMap)) {
    const keyPath = `agents.${key}`

    if (source.trust === 'project') {
      rejectProjectSecurityOverlay(source.path, keyPath, value)
    }

    const previous = target[key]
    const nextValue =
      source.trust === 'project' && previous
        ? preserveSecurityFields(previous.value, value)
        : value

    target[key] = {
      value: nextValue,
      sourcePath: source.path,
      keyPath,
    }
  }
}
```

The two invariants this teaches:

1. Project config may not set security fields. The throw at load time names
   both the source file and the config key path.
2. Project same-key replacement may not erase higher-trust security fields.
   When the project source replaces an existing entry, security fields from
   the previous (higher-trust) source are preserved into the new value.

User and `OPENCODE_CONFIG_DIR` (custom) config can still own those fields
freely.

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
(`only valid in user config or OPENCODE_CONFIG_DIR config`). Future readers
understand it's not a syntax check — it's a trust boundary.

## Related

- PR #343 (squash d5a3678) — initial overlay implementation, uniform merge
- PR #344 (squash 0fb3fbc) — security-field guard added; current
  `SECURITY_OVERLAY_FIELDS` set established
- PR #345 (squash 1eecfb0) — source-default model table; explicitly does
  NOT extend the security-field set (Systematic does not currently support
  `fallback_models` per `README.md` line 339)
- `src/lib/config.ts` — current implementation of the security-field guard
  (`SECURITY_OVERLAY_FIELDS` at line 67, used at lines 257 and 271)
- `tests/unit/config.test.ts` — regression coverage for the boundary
