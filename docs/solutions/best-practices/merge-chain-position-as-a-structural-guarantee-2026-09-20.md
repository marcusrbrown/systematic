---
title: Express a fill-gaps-only guarantee as merge position, not a policy check
date: 2026-09-20
category: best-practices
module: config-system
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - One config source should fill gaps without ever overriding a higher-trust source
  - Adding a new contributor tier to an existing overlay merge chain
  - Choosing between whole-entry replacement and field-additive merging
  - Reviewing a guarantee that no single predicate enforces
related_components:
  - tooling
tags: [config, merge, overlay, precedence, trust, invariant, advisory]
---

# Express a fill-gaps-only guarantee as merge position, not a policy check

## Context

Systematic let a repository define model-routing profile bundles, gated behind a
user-owned `allow_project_profiles` opt-in. The guarantee the feature had to provide:

> A project-defined bundle supplies routing **only where user-owned config is
> silent**. It can never override, and never partially clobber, a value the user set.

The obvious implementation is a conditional — when merging a project-sourced bundle,
check whether the user already set this field and skip if so. That check would live
in the merge function, would need to be correct for flat fields and for nested
harness blocks, and would be one `!` away from inverting.

## Guidance

Express the guarantee as **chain position plus merge granularity**, so no predicate
is required.

`buildOverlaySources` (`src/lib/config.ts:1598`) decides position by provenance:

```ts
const ordered =
  profileEntry !== null && bundleSourceTrust === 'project'
    ? [profileEntry, userSource, projectSource, customSource]
    : [userSource, profileEntry, projectSource, customSource]
```

A user- or custom-authored bundle keeps its historical position *after* user base —
it is authoritative and overrides, which is the point of a profile. A project-sourced
bundle goes *first*, so user base merges over it.

The merge itself is field-additive (`mergeProfileOverlayValue`,
`src/lib/config.ts:2524`):

```ts
const result: OverlayConfig = { ...previous, ...next }
for (const blockKey of HARNESS_BLOCK_KEYS) {
  const previousBlock = previous[blockKey]
  const nextBlock = next[blockKey]
  if (isRecord(previousBlock) && isRecord(nextBlock)) {
    result[blockKey] = { ...previousBlock, ...nextBlock }
  }
}
```

`next` wins each field it sets; `previous` survives wherever `next` is silent. That
single property makes one function serve both directions purely by argument order:

| Chain | `previous` | `next` | Winner |
|---|---|---|---|
| Normal (user/custom bundle) | user base | profile bundle | profile — unchanged behavior |
| Advisory (project bundle) | project bundle | user overlay | user, project fills gaps |

`resolveOverlayEntryValue` (`src/lib/config.ts:2420`) routes to it with a per-source
branch, not a per-field test.

## Why This Matters

**The rejected alternative fails concretely, not theoretically.** With whole-entry
replacement, a user who sets only `opencode.variant` on an agent whose project bundle
sets `opencode.model` erases the model. That leaves a qualifier with no model, which
`assertRoutingInvariants` rejects — so customising one field fails the entire config
load, and with it plugin init. Pinned at `tests/unit/config.test.ts:4461`.

**There is no policy check to forget, invert, or skip.** A field the user set wins
because of where the objects sit in the chain.

**The cost is non-locality, and it is real.** The guarantee now depends on two code
sites with nothing connecting them. A future edit to either — reordering the chain,
or changing the merge function's direction — breaks the guarantee with no local
signal. `ARCHITECTURE.md` states this plainly rather than implying the invariant is
enforced:

> The advisory guarantee described here follows from this
> chain-position-plus-field-additive-merge combination as implemented; it is not
> enforced by any separate check.

That honesty is load-bearing. A reader who believes an invariant is enforced will not
check it.

**Non-local guarantees need tests at each site.** Two tests pin the two halves, each
verified red-then-green:

- `tests/unit/config.test.ts:4415` fails if a project-sourced bundle stops being
  placed ahead of user base. Flipping the condition produces
  `Expected: "a/user-wins" / Received: "a/project-loses"` — it fails for the right
  reason, not incidentally.
- `tests/unit/config.test.ts:4461` fails if the field-additive branch is removed,
  throwing on a variant with no model.

A test that passes for several different implementations is not pinning anything.
Verify red before trusting green.

## When to Apply

Use position-as-guarantee when:

- The rule is genuinely about precedence between layers, so order already carries it.
- The merge primitive is directional, so one function covers both cases.
- You can afford tests at each participating site.

Prefer an explicit check when:

- The rule is conditional on something other than layer identity.
- The chain is assembled in more than one place, or by callers you do not control.
- The non-locality would not be discoverable by a reader of either site.

Note the asymmetry this leaves behind. `resolveOverlayEntryValue` field-merges for
the `profile-bundle` pseudo-source, for `project` trust (via `preserveSecurityFields`),
and — new here — for `user`. `custom` is the one tier that still whole-replaces, so
the same trap case reproduces with a custom overlay against a project bundle. That is pre-existing behavior for user-defined profiles,
and it is pinned as a known asymmetry rather than silently tolerated
(`tests/unit/config.test.ts`, the `KNOWN ASYMMETRY` test). When a pattern applies to
some tiers and not others, document which.

## Examples

Whole-entry replacement, and the failure it causes:

```ts
// project bundle: { opencode: { model: 'a/model' } }
// user overlay:   { opencode: { variant: 'high' } }
const merged = next
// => { opencode: { variant: 'high' } }  — model erased
// => assertRoutingInvariants throws: qualifier resolves, no model at any layer
// => loadConfig fails, plugin init fails
```

Field-additive, one level into harness blocks:

```ts
const merged = {
  ...previous,
  ...next,
  opencode: { ...previous.opencode, ...next.opencode },
}
// => { opencode: { model: 'a/model', variant: 'high' } }  — both survive
```

## Related

- [`layered-trust-boundaries-overlay-config-2026-05-09.md`](./layered-trust-boundaries-overlay-config-2026-05-09.md)
  — which overlay fields are trust-sensitive and why a committed project config may
  not set them. That doc establishes the boundary; this one is about expressing a
  relaxation of it without a policy check.
- [`../developer-experience/local-systematic-overrides-global-2026-05-14.md`](../developer-experience/local-systematic-overrides-global-2026-05-14.md)
  — precedence behavior between local and global config.
