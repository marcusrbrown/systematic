---
title: "feat: discovered skills as commands + systematic_skill permission parity"
type: feat
status: active
date: 2026-07-06
origin: docs/brainstorms/2026-07-06-discovered-skills-as-commands-requirements.md
---

# feat: Discovered Skills as Commands + `systematic_skill` Permission Parity

## Overview

Two independent v2 deliverables on `main`, shipped as **two separate PRs** from one reviewed brainstorm:

1. **Feature PR — discovered skills as commands.** Systematic already registers its bundled skills as slash commands. This extends the capability to skills OpenCode discovers from user/project roots: each becomes an invokable `/skill-name` command via the config hook. The command template is a one-line skill-tool shim (argument string wrapped as data); command-only skills (`disable-model-invocation: true`) are the sole inline-body exception. Because upstream skips skill-command registration for names already in `config.command`, Systematic's entries *replace* upstream's raw-body skill commands per name — upgrading typed invocation to a permission-gated skill-tool load. No client gating (impossible to double-list by construction); one feature toggle.

2. **Drift PR — `systematic_skill` permission parity.** Upstream's `skill` tool permission-gates every load via `ctx.ask` against `permission.skill` patterns; `systematic_skill` bypasses that system. Source-verified: plugin tool contexts DO expose `ask()` (bridged from the host tool context), so full allow/deny/ask parity is implementable. Also aligns file sampling behavior.

## Problem Frame

Upstream registers every discovered skill as a server-side command (`source: "skill"`, raw SKILL.md body as template) but the TUI intentionally hides them from `/` autocomplete (maintainer-confirmed; parity PR stale-closed). Source verification this session: typed `/skill-name` DOES execute (the TUI submit path checks the unfiltered command list — `packages/tui/src/component/prompt/index.tsx:1065-1115`) — so the feature's value is (a) autocomplete discoverability, (b) upgraded invocation semantics (shim + permission gate instead of upstream's raw body inline), (c) argument-as-data handling, (d) `disable-model-invocation` command-only semantics (Claude Code parity nobody ships, demanded upstream in #12109).

Separately, a user who configures `permission: { skill: { "internal-*": "deny" } }` still gets those skills loaded through `systematic_skill` — a real permission bypass (upstream gates at `tool/skill.ts:28-33`; Systematic has no equivalent).

See origin: `docs/brainstorms/2026-07-06-discovered-skills-as-commands-requirements.md` for full research provenance (upstream history, prior-art table, verified facts F1–F7).

## Requirements Trace

Carried from the origin brainstorm:

- R1. Discover non-bundled skills from the six upstream-documented roots (project `.opencode/skills/`, global `~/.config/opencode/skills/`, project+global `.claude/skills/` and `.agents/skills/`; project paths walk up to the git worktree root).
- R2. Register each as `config.command[name]` under the bare skill name; duplicate names across roots resolve to the same winner upstream's skill tool resolves (later-discovered wins), never an independent precedence scheme.
- R3. Model-invocable skills get a one-line skill-tool shim template; the argument string is wrapped as data in a `<user-request>` block (existing `skill-loader.ts` pattern), never concatenated into instruction text.
- R4. Existing `config.command` entries always win; bundled `systematic:`/`ce:` command registration is untouched.
- R5. Dropped — no client gating (Systematic's entries replace upstream's skill-sourced entries by name on every client; double-listing impossible by construction).
- R6. `disable-model-invocation: true` = command-only: registers as a command with an **inline-body** template (the sole R3 exception), excluded from model-facing exposure.
- R7. A config toggle (`skills_as_commands`, default on) disables the feature entirely; graceful degradation if upstream converges.
- R8. No filesystem writes; everything happens in the config hook.
- R9. Only names matching the upstream regex (`^[a-z0-9]+(-[a-z0-9]+)*$`) register; invalid names skip with a debug note, never a crash.
- R10. `systematic_skill` loads respect `permission.skill` semantics (allow/deny/ask). Source-verified feasible: plugin tool execute context exposes `ask()`. Fail-closed if ask cannot prompt in some context: `ask` patterns treat as `deny` with a warning, never downgrade to allow.
- R11. File sampling aligns with upstream (hidden files included, deterministic ordering, limit 10, no silently swallowed errors).
- R12. Deprecation-warning behavior untouched (v3 deletes it).
- R13. Two separate PRs: feature (R1–R9), drift (R10–R12).
- R14. Committed docs cover discovery roots, naming, collision policy, the toggle, command-only semantics, and the honest upstream/trust context.

## Scope Boundaries

- No trust gate beyond upstream's (upstream registers the same project-root content ungated; commands are human-invoked). Docs state this trust model plainly (R14).
- No dispatcher command, no filesystem writes, no prefix option, no remote-skill (`config.skills.urls`) support in v1.
- No changes to bundled-skill command registration or the bootstrap catalog.
- No Pi-side work (v3 track).

### Deferred to Separate Tasks

- Prefix option for injected commands: only if users ask.
- Remote skills (`config.skills.urls`) as command sources: future iteration.
- Claude Code named-argument frontmatter (`arguments: [issue, branch]` → `$issue`): follow-up if demand appears.

## Context & Research

### Relevant Code and Patterns

- `src/lib/config-handler.ts` — `collectSkillsAsCommands()` (bundled-skill command emission to mirror), the `config.command` merge that preserves user entries (`isSystematicOwnedCommandKey`), and `registerSkillsPaths()`.
- `src/lib/skills.ts` — `findSkillsInDir`, `extractFrontmatter` (already parses `disable-model-invocation`, `allowed-tools`, `argument-hint`, etc. from the Claude Code compat work #43).
- `src/lib/skill-loader.ts` — the `<skill-instruction>`/`<user-request>` wrapped-template pattern (R3's argument-as-data model).
- `src/lib/skill-tool.ts` — `systematic_skill` implementation (drift PR target); `src/lib/config-schema.ts` for the new toggle field.
- Upstream (local clone v1.17.6, re-verify at v1.17.13): `packages/opencode/src/skill/index.ts:185-227` (discovery roots + later-wins duplicate handling), `command/index.ts:142-153` (skill-command registration skips existing names), `tool/skill.ts:28-33` (the `ctx.ask` permission gate to mirror), `packages/plugin/src/tool.ts:3-20` + `opencode/src/tool/registry.ts:132-143` (plugin tool `ask()` bridge), `tui/.../prompt/index.tsx:1065-1115` (typed-command execution path).

### Institutional Learnings

- `docs/solutions/integration-issues/opencode-plugin-hook-silent-defect-swallow-2026-05-19.md` — config-hook code must not throw; discovery failures degrade to skipping, never abort plugin load.
- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md` — hooks run per-source; command emission must be idempotent.
- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md` — if the runtime drops invalid-name skills silently (R9), no gate mirror is needed (user content, not bundled), but the drop must be observable (debug note).
- Prior art (origin doc): opencode-claude-code-bridge (shim), mem0 plugin (config.command mutation), upstream's own collision policy.

## Key Technical Decisions

- **Reuse Systematic's own discovery walker over the six roots** rather than trying to read upstream's discovered-skill list: the config hook receives config, not upstream's runtime skill registry — there is no API to consume it at config time. Mirror upstream's discovery order and later-wins duplicate rule exactly so the command winner matches the skill tool's winner (R2).
- **Replace-by-name is the collision story.** Upstream registers skill commands only for names NOT already in `config.command` — so emitting our entries in the config hook means every client sees exactly one command per skill name, ours. User-defined commands still beat ours (R4) because we skip names present in the user's config before merge.
- **Shim for model-invocable, inline for command-only** (R3/R6) — pinned at brainstorm review; no third path.
- **Toggle in the existing config schema** (`skills_as_commands: boolean`, default `true`), not trust-protected (not in `SECURITY_OVERLAY_FIELDS` — it's a UX preference, not a security boundary).
- **Permission parity uses the bridged `ask()`** (R10) — same semantics as upstream's gate: patterns from `permission.skill`, `always` on allow. Static config reading is the fallback only if `ask()` proves unusable in some agent context; then `ask`→`deny` fail-closed.

## Open Questions

### Resolved During Planning

- Typed `/skill-name` execution: works today (source-verified) — value framing updated accordingly.
- Plugin `ask()` availability: confirmed at `packages/plugin/src/tool.ts:3-20`.
- Client gating: dropped (replace-by-name makes double-listing impossible).
- Discovery reuse vs re-walk: re-walk, mirroring upstream's order + later-wins rule (no config-time API to upstream's registry).

### Deferred to Implementation

- Whether the config hook's cwd is reliably the project directory for the worktree-upward walk (verify against the plugin input's `directory`).
- Exact debug-note channel for R9 skips (existing `[systematic]` logger vs silent).
- v1.17.13 line-number re-verification of the five upstream reference points.

## Implementation Units

- [ ] **Unit 1: Discovery of non-bundled skills across the six roots**

**Goal:** A pure function that discovers user/project skills exactly as upstream does — same roots, same order, same later-wins duplicate rule — returning name, description, frontmatter (incl. `disable-model-invocation`), and body path.

**Requirements:** R1, R2 (precedence), R9

**Dependencies:** None

**Files:**
- Create: `src/lib/discovered-skills.ts`
- Test: `tests/unit/discovered-skills.test.ts`

**Approach:**
- Reuse `walkDir`/`findSkillsInDir` machinery where it fits; the six roots and upward walk are new logic. Skip Systematic's own bundled dir (those are handled by the existing path).
- Order: global claude → global agents → project walk (claude/agents) → opencode config dirs — matching `skill/index.ts:185-227`; later discovery overwrites earlier per name.
- Invalid names (regex fail) and unreadable dirs skip with a debug note; discovery never throws (hook-defect learning).

**Execution note:** Test-first — the precedence and root-ordering rules are the regression surface.

**Test scenarios:**
- Happy path: a skill in `.opencode/skills/` is discovered with correct name/description/body path.
- Precedence: same name in global `.claude/skills/` and project `.agents/skills/` → project wins (later-discovered), matching upstream's winner.
- Edge: name violating the regex is skipped with a note; a root that doesn't exist is skipped silently.
- Edge: worktree-upward walk stops at the git root; skills above it are not discovered.
- Error path: unreadable SKILL.md (permission denied) skips that skill, discovery completes.

**Verification:** unit tests green; discovery output for a fixture tree matches upstream's documented winner for every duplicate case.

- [ ] **Unit 2: Command emission in the config hook**

**Goal:** Convert discovered skills into `config.command` entries — shim template for model-invocable, inline body for command-only — behind the `skills_as_commands` toggle, never clobbering existing commands.

**Requirements:** R2, R3, R4, R6, R7, R8

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/config-handler.ts` (new emission step alongside `collectSkillsAsCommands`), `src/lib/config-schema.ts` (+ `skills_as_commands` field), `src/lib/removed-names.ts` untouched
- Test: `tests/unit/config-handler.test.ts`, `tests/unit/config-schema.test.ts`

**Approach:**
- Shim template wraps `$ARGUMENTS` in the `<user-request>` block pattern from `skill-loader.ts`; instructs loading via the `skill` tool (upstream's, not `systematic_skill` — discovered skills are upstream-registered skills).
- Command-only skills inline the SKILL.md body (sole exception, R6); their `$ARGUMENTS` handling follows upstream command substitution (F4).
- Skip any name already present in user `config.command` BEFORE merge (R4); bundled `systematic:`/`ce:` paths untouched.
- Toggle default true; `false` emits nothing.
- Regenerate the JSON schema for the new config field (`bun scripts/generate-config-schema.ts`).

**Test scenarios:**
- Happy path: discovered model-invocable skill → command entry with shim template + description.
- Happy path: command-only skill → inline-body template, and it is excluded from any model-facing exposure Systematic controls.
- Collision: user-defined command of the same name survives untouched.
- Toggle: `skills_as_commands: false` → zero injected entries; bundled commands unaffected.
- Idempotency: running the hook twice yields identical config (duplicate-registration learning).
- Schema: new field validates; unknown values rejected.

**Verification:** unit suite green; schema drift check passes; a fixture project shows `/skill-name` entries in emitted config exactly once per skill.

- [ ] **Unit 3: Docs for the feature**

**Goal:** Committed docs covering discovery roots, naming, replace-by-name collision policy, the toggle, command-only semantics, and the honest upstream/trust framing.

**Requirements:** R14

**Dependencies:** Units 1–2

**Files:**
- Create/Modify: a docs page under `docs/src/content/docs/` (guides), linked from nav
- Modify: `docs/src/content/docs/reference/configuration.mdx` regen picks up the new field (`bun run docs:generate`)

**Test scenarios:**
- Test expectation: none — docs content; `bun run docs:build` green is the gate.

**Verification:** docs build passes; page states the trust model and upstream context plainly.

- [ ] **Unit 4 (separate PR): `systematic_skill` permission parity + sampling alignment**

**Goal:** `systematic_skill` loads gate through `permission.skill` semantics via the bridged `ask()`; file sampling matches upstream behavior.

**Requirements:** R10, R11, R12

**Dependencies:** None (independent of Units 1–3; separate PR)

**Files:**
- Modify: `src/lib/skill-tool.ts`
- Test: `tests/unit/skill-tool.test.ts`

**Approach:**
- Mirror upstream's gate: `ctx.ask({ permission: "skill", patterns: [name], always: [name] })` semantics before loading; deny → actionable error naming the pattern; ask → prompt (or fail-closed deny with warning if prompting is unavailable in context).
- Sampling: include hidden files, deterministic sort, limit 10, surface (don't swallow) read errors as a note.
- Do not touch deprecation handling (R12).

**Execution note:** Test-first on the deny path — assert a `"internal-*": "deny"` pattern blocks the load before wiring the ask bridge.

**Test scenarios:**
- Happy path: no permission config → loads as today.
- Deny: `"internal-*": "deny"` blocks `internal-docs` with an error naming the pattern.
- Ask: an ask-pattern routes through `ask()`; if the context cannot prompt, the load is denied with a warning (never silently allowed).
- Allow-precedence: patterns follow OpenCode's last-match-wins semantics (memory: findLast).
- Sampling: hidden file appears in `<skill_files>`; unreadable file yields a note, not silence; order deterministic.

**Verification:** unit suite green; manual probe with a permission-configured fixture confirms deny/ask behavior end-to-end.

## System-Wide Impact

- **Interaction graph:** config hook emission order matters — discovered-skill commands must merge after user config is read (to skip existing names) and never touch bundled command emission.
- **Error propagation:** discovery and emission never throw (hook-defect swallow); the drift PR's deny path throws an actionable tool error (correct — tool errors surface to the model).
- **API surface parity:** new config field `skills_as_commands` (schema + docs regen); no CLI changes.
- **Unchanged invariants:** `src/index.ts` exports only `default`; bundled command registration; `SECURITY_OVERLAY_FIELDS` untouched (the toggle is not trust-protected).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Upstream changes discovery roots/order in a future release | Roots + order pinned in one module (Unit 1) with tests naming upstream as the contract; re-verify at version bumps |
| Upstream flips the TUI filter → our entries become redundant | Replace-by-name means still exactly one entry per skill; toggle removes ours entirely |
| Replace-by-name suppresses upstream's skill command even when our shim misbehaves | Shim is one line and tested; toggle restores upstream behavior instantly |
| `ask()` behavior differs at v1.17.13 | Deferred re-verification item; fail-closed fallback specified (ask→deny with warning) |
| Config-hook cwd ≠ project dir for the upward walk | Deferred check against plugin input `directory`; tests use explicit roots |

## Documentation / Operational Notes

- Feature PR: `feat:` (minor). Drift PR: `fix:` (patch — closes a real permission bypass).
- Sequence: drift PR can land first (independent); feature PR's docs mention the permission gate the drift PR adds — land drift first for docs accuracy.

## Sources & References

- **Origin document:** docs/brainstorms/2026-07-06-discovered-skills-as-commands-requirements.md
- Upstream refs: packages/opencode/src/skill/index.ts, command/index.ts, tool/skill.ts, packages/plugin/src/tool.ts, packages/tui/src/component/prompt/index.tsx (local clone v1.17.6)
- Systematic: src/lib/config-handler.ts, src/lib/skills.ts, src/lib/skill-loader.ts, src/lib/skill-tool.ts, src/lib/config-schema.ts
- Upstream history: PR #11390, #12109, #11547, #22129, #23987, #29567
