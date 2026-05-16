---
title: 'OpenCode plugin multi-source loading: per-load registration with marker-based bootstrap'
date: 2026-05-04
last_refreshed: 2026-05-16
category: integration-issues
problem_type: integration_issue
component: tooling
severity: medium
applies_when:
  - Designing an OpenCode plugin that may be loaded from multiple opencode.json sources in the same process
  - A plugin must inject content into the system prompt array idempotently across multiple registrations
  - A previous singleton pattern needs to be replaced with per-load registration without breaking single-source consumers
tags:
  - opencode
  - plugin-registration
  - multi-source-loading
  - bootstrap-injection
  - idempotency
  - marker-based
  - system-prompt
related_components:
  - tooling
  - plugin-runtime
---

# OpenCode plugin multi-source loading: per-load registration with marker-based bootstrap

## Problem

OpenCode plugins can be configured from multiple sources in the same process — typically a user-level
`~/.config/opencode/opencode.json` plus a project-level `<repo>/.opencode/opencode.json`. When a plugin
is referenced in both, OpenCode's plugin loader invokes the plugin factory once per source. For Systematic
specifically, a contributor working in the Systematic repo may have `@fro.bot/systematic` installed in
their user config AND `./src/index.ts` configured in their project config — different code, different
bundled assets, but the same plugin identity from OpenCode's perspective.

Originally (PR #335), Systematic guarded the factory with `plugInOnce` — a process-level singleton that
returned the same hooks reference for every invocation. This prevented duplicate tool registration in the
TUI catalog, but it also collapsed both invocations onto whichever loaded first. In the contributor
scenario, that meant the user-config (npm) version silently shadowed the project (local source) version —
the dev workflow was broken in a way that looked like "it works" because OpenCode reported no errors.

PR #352 (v2.13.0) removed `plugInOnce` entirely. The current model is **per-load registration** with
**marker-based bootstrap idempotency**.

## Symptoms

**Pre-singleton (before PR #335):**

- `systematic_skill` appeared twice in the LLM-visible tool catalog
- `experimental.chat.system.transform` ran twice on every prompt
- Bootstrap content (`<SYSTEMATIC_WORKFLOWS>` block) stacked N times in the system prompt

**With the singleton (PR #335, before PR #352):**

- Only the first-loaded plugin's behavior was visible — the second source's code was silently shadowed
- A contributor with both npm and local-source configs saw the npm version's skills and bootstrap, never
  their local changes
- No error was surfaced; OpenCode reported a healthy plugin

**Root symptom that motivated the original singleton:**

```bash
# Before PR #335, dual-source config produced:
mise run opencode:doctor --only tools --full --format json \
  | jq '.[] | select(.label == "Tools").data | map(.id)
        | map(select(. == "systematic_skill")) | length'
# Output: 2
```

## Root Cause

The correct mental model: **each plugin source is a distinct registration**. Tools, hooks, and config
handlers should register N times — that is OpenCode's natural behavior. The one piece that genuinely
cannot be multiplied is bootstrap content in the chat system prompt, because it lands in the same
`output.system` array once per `experimental.chat.system.transform` invocation. N registrations stacking
the same block in every chat turn is the only real problem; everything else is fine when registrations
run independently.

PR #335's `plugInOnce` was an over-correction. It solved the bootstrap-stacking symptom by collapsing
every registration onto one — but at the cost of multi-source code visibility. The singleton's
deduplication of init work had no visible effect on the TUI tool catalog (OpenCode registers tools
per-source regardless of hooks reference identity), but it did collapse all loads onto whichever ran
first, silently shadowing later sources.

The actual problem was never "multiple registrations." It was "multiple bootstrap injections without a
replacement strategy."

## Solution

PR #352 (v2.13.0) removed `plugInOnce` entirely and introduced marker-based bootstrap idempotency.

### Per-load registration

Each factory invocation runs `initializePlugin(input)` independently:

```typescript
// src/index.ts
const SystematicPlugin: Plugin = async (input) => {
  return initializePlugin(input)  // Runs every time. No singleton.
}

export default SystematicPlugin
```

`initializePlugin` performs the full init sequence — `loadConfig`, `getBootstrapContent`,
`createConfigHandler`, `createSkillTool` — for every source that lists the plugin. No process-level
state, no `globalThis` slots, no shared mutable references.

### Marker-based bootstrap idempotency

`applyBootstrapContent` in `src/lib/bootstrap.ts` handles the one piece that must not multiply:

```typescript
// src/lib/bootstrap.ts
export const applyBootstrapContent = (
  output: { system: string[] },
  content: string,
): void => {
  // 1. Strip every complete <SYSTEMATIC_WORKFLOWS>...</SYSTEMATIC_WORKFLOWS> block
  //    from all system entries — including blocks from prior plugin invocations.
  for (let i = 0; i < output.system.length; i++) {
    output.system[i] = removeCompleteBootstrapBlocks(output.system[i])
  }

  // 2. Append one canonical block to output.system[0].
  //    Marker-based replacement is idempotent: N invocations converge on exactly
  //    one block in output.system[0], regardless of registration order.
  if (output.system.length === 0) {
    output.system.push(content)
    return
  }

  const first = output.system[0]
  output.system[0] = first.length > 0 ? `${first}\n\n${content}` : content
}
```

The system prompt array itself is the coordination point. The `<SYSTEMATIC_WORKFLOWS>` sentinel is unique
to Systematic; no other writer produces that tag. Strip-and-append is therefore safe and unambiguous.

## Why This Works

Each plugin source registers its own tools and hooks — OpenCode handles composition at the host level.
The only multiplied work is bootstrap injection, and marker-based replacement handles that idempotently:

- **First transform invocation:** no existing marker in `output.system`, append the block.
- **Second transform invocation:** existing marker found, strip the old block from all entries, append
  the new one to `output.system[0]`.
- **Last transform wins** (per OpenCode's FIFO transform-handler iteration), so the most-recently-loaded
  plugin's bootstrap content lands in the final prompt.

For multi-source contributors (e.g., npm + local source): the project-level `./src/index.ts` is declared
second in source order, so its `experimental.chat.system.transform` handler runs second. Its bootstrap
content wins. The contributor's local changes are visible.

For single-source consumers: per-load registration is transparent. One invocation, one registration, one
bootstrap block — identical to the pre-singleton behavior.

## Prevention

- **Trust the system prompt array as a coordination point.** Don't reach for `globalThis` or
  module-level singletons to enforce idempotency. The mutable state you're trying to coordinate is
  already in the array.

- **Mark injected content with a unique sentinel string.** `<SYSTEMATIC_WORKFLOWS>` is unique to
  Systematic; no other writer produces that tag. Replacement is then a deterministic strip-and-append.

- **Per-invocation independence is OpenCode's default.** Plugins should not fight it unless they have a
  specific shared resource (a singleton DB client, a long-lived TCP connection) — and even then, scope
  the sharing to that resource, not to the plugin factory itself.

- **Single-source consumers see no behavior change.** Per-load registration is transparent when there's
  only one source. Verify both the single-source and dual-source cases when changing registration logic.

- **Verify against the LLM-visible tool catalog, not just diagnostic logs.** The
  `opencode:doctor --only tools` command queries `client.tool.list({ provider, model })` — exactly what
  the LLM sees. Internal fingerprint probes only tell you a guard fired; they don't tell you the host
  stopped registering twice.

- **Don't transfer plugin singleton patterns from precedent without dual-source verification.** A pattern
  that works for a plugin listed only in user-level config will pass its own internal tests yet fail
  under dual-source listing. Always set up the dual-source case explicitly.

## Verification

The pattern is verified by:

1. **`tests/integration/opencode.test.ts`** — a `pinned package plus local source` test exercises the
   multi-source scenario and asserts that bootstrap content appears exactly once in the system prompt
   after both transform handlers have run.

2. **CI smoke test in `.github/workflows/main.yaml`** — runs the plugin under Node.js and asserts
   `Object.keys(import('./dist/index.js'))` equals `['default']` only (no named exports leak the
   singleton's old import pattern).

3. **`grep -rn plugInOnce src/`** returns 0 hits — sanity check that the singleton is fully gone.

```bash
# Confirm singleton is absent
grep -rn plugInOnce src/
# Expected: (no output)

# Confirm factory shape
node -e "import('./dist/index.js').then(m => console.log(Object.keys(m)))"
# Expected: [ 'default' ]
```

## Related

- `docs/solutions/best-practices/provider-availability-source-defaults-2026-05-12.md` — uses the same
  per-load registration model; provides Pattern 8 (discovery before validation), a sibling lifecycle
  ordering pattern
- `docs/solutions/integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md` —
  orthogonal export-shape contract at the same plugin boundary
- `docs/solutions/developer-experience/local-systematic-overrides-global-2026-05-14.md` — applies the
  per-load registration model to the project-overrides-user case
- `docs/brainstorms/2026-05-10-multi-load-plugin-registration-requirements.md` — design rationale
  (per-load registration; bootstrap idempotency via `<SYSTEMATIC_WORKFLOWS>` marker; system prompt array
  as coordination point; no global state)
- PR #335 — introduced `plugInOnce` singleton (later removed by PR #352)
- PR #352 (v2.13.0) — removed `plugInOnce`, introduced marker-based bootstrap idempotency
- `src/index.ts` — per-invocation `initializePlugin(input)`
- `src/lib/bootstrap.ts:applyBootstrapContent` — marker-based strip-and-replace
