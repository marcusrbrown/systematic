# Harnesses

This is the evidence registry for Systematic's harness-portability work. **Every tool or mechanism named here is backed by an in-repo path with line numbers, installed or cloned source, or an authoritative URL.** If the supplied research did not verify a capability, it is explicitly marked **UNVERIFIED**; absence of evidence is not evidence of absence.

**Tiers.** Tier 1 means Systematic ships a controlled adapter: OpenCode, Pi, and Claude Code. Tier 2 means the harness is documented for portability but has no Systematic adapter: Codex CLI, Gemini CLI, and GitHub Copilot.

## Capability matrix

The four capability rows use the vocabulary in the [OpenCode profile](skills/using-systematic/references/opencode-profile.md#L3-L8), [Pi profile](skills/using-systematic/references/pi-profile.md#L3-L8), and [Claude Code profile](skills/using-systematic/references/claude-code-profile.md#L5-L10).

| Capability | OpenCode (Tier 1) | Pi (Tier 1) | Claude Code (Tier 1) | Codex CLI (Tier 2) | Gemini CLI (Tier 2) | GitHub Copilot (Tier 2) |
|---|---|---|---|---|---|---|
| Subagent delegation | `task`, including `subagent_type`, resume, and background execution [OC-1] | Bounded built-in delegate: `systematic_delegate({agent, task})`; sequential, capped at 20 turns, depth-1, `noExtensions` [PI-1]. Optional mature delegation via pi-subagents (opt-in export; outside Systematic's bounded-delegate guarantees) [PI-7] | Name-based subagent dispatch (invoke a subagent by name in the prompt text); `context: fork` for skill-scoped forks; plugin agents ship in `agents/` [CC-1][CC-9] | **UNVERIFIED** [U] | **UNVERIFIED** [U] | Built-in/custom agents [GH-1][GH-2] |
| Blocking user interaction | `question` [OC-2] | No native blocking tool; numbered-chat fallback [PI-2] | `AskUserQuestion` [CC-2] | `request_user_input`; blocking and root-thread-only [CX-1][CX-2] | `ask_user`; pauses until answers [GE-1][GE-2] | No dedicated tool name verified; plan-mode clarification and `--no-ask-user` are documented [GH-3][GH-4] |
| Task tracking | `todowrite` [OC-3] | No native mechanism; visible list fallback [PI-2] | `TodoWrite` is deprecated/disabled by default; `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` replace it [CC-3][CC-4] | **UNVERIFIED** [U] | **UNVERIFIED** [U] | No `TodoWrite` equivalent verified; cloud-agent tasks/sessions API is documented [GH-5] |
| Skill loading | Skills become commands and `systematic_skill` is registered [OC-4][OC-5] | `systematic_skill` adapter and Pi-native activation [PI-3][PI-4] | Native Skill tool with `SKILL.md` discovery (`~/.claude/skills/`, `.claude/skills/`, plugin `skills/`); Systematic ships no `systematic_skill` tool on Claude Code [CC-5][CC-6][CC-9] | **UNVERIFIED** [U] | **UNVERIFIED** [U] | `SKILL.md` skills [GH-6] |
| Skills-file support | `SKILL.md` is loaded by the Systematic skill path [OC-4] | `pi.skills` ships `./skills`, including `SKILL.md` discovery [PI-4][PI-5] | `SKILL.md` and `.claude/skills/`; the plugin bundle is built and identifier-translated in CI from `skills/`, never committed [CC-5][CC-6][CC-9] | **UNVERIFIED** [U] | **UNVERIFIED** [U] | `SKILL.md` [GH-6] |

`[U]` means the capability was not checked in the supplied research pack. It is not a claim that the capability does not exist.

## OpenCode — Tier 1 shipped adapter

OpenCode is the primary controlled integration. Its profile defines delegation, blocking interaction, task tracking, and skill loading [OC-P]. The underlying source registers `task` with specialized-agent, resume, and background fields [OC-1], `question` as a user-facing tool [OC-2], and `todowrite` as a built-in tool [OC-3]. Systematic converts bundled skills into commands in `src/lib/config-handler.ts:467-485` and registers the skill tool in `src/lib/skill-tool.ts:41-101` [OC-4][OC-5]. Bundled agent markdown omits a model field by invariant [OC-6]; runtime configuration stays model-free unless user-owned config supplies an explicit overlay [OC-7].

Compatibility is direct: OpenCode consumes the concrete invocation language in the profile. The adapter is not a generic claim about other harnesses.

## Pi — Tier 1 shipped adapter

Pi's profile records degraded or unavailable native capabilities and explicit fallbacks [PI-P]. The adapter registers `systematic_skill` in `src/pi.ts:85-103` and `systematic_delegate` in `src/pi.ts:106-113` [PI-3]. Delegation is explicitly sequential (`executionMode: 'sequential'`), capped at `MAX_DELEGATE_TURNS = 20`, and guarded against re-entry in `src/lib/pi-delegate-tool.ts:14-18,245-249` [PI-1]. The child is spawned with `noExtensions: true`, bounding `systematic_delegate`'s own recursion; this does not bound end-to-end depth across a combined pi-subagents + Systematic path.

Optional mature delegation is available via [pi-subagents](https://github.com/tintinweb/pi-subagents) through an opt-in persona export: `systematic pi-subagents <preview|export|refresh|cleanup> --scope project|global`. This path is outside Systematic's bounded-delegate guarantees and governed by pi-subagents' own configuration. Tested against pi-subagents v0.14.3; versions outside the tested range are unsupported but nonfatal. Export writes are governed by a manifest (`.systematic-personas.json`) and an exclusive per-root mutation lock (`.systematic-personas.lock`) held for the duration of `export`/`refresh`/`cleanup`; a pre-existing lock is never auto-deleted — a reported lock requires manual verification that no operation is actually running before removal. No files are written without an explicit command [PI-7].

Systematic's own config (`systematic.json`/`.jsonc`) is the durable source of truth for exported personas; the generated persona files and manifest are a disposable projection. `export` computes and prints its per-file preflight actions (create/update/skip/refuse/remove) and target directory before any mutation, the same way `preview` does. `refresh` intentionally overwrites current manifest-owned generated files that have drifted from source — run `preview` first to see what would change. Project-scoped export (default) loads `user → project → custom` config for the current working directory; global-scoped export loads `user → custom` only and never absorbs cwd project overlays. Project-sourced `model` on the `categories`/`agents` overlay is rejected outright by config validation; project-sourced `thinking`, `tools`, and `skills` on the `pi_subagents` overlay are silently stripped before merge; `max_turns` is trust-any. pi-subagents v0.14.3 has no equivalent frontmatter fields for `temperature`, `top_p`, or `variant` — Systematic never emits them.

Every export/refresh/cleanup operation walks every path component from a scope-anchored root down to the target agents directory and fails closed if any intermediate component is a symlink or a non-directory: the project anchor is the current working directory, the default global anchor is the user's home directory, and when `PI_CODING_AGENT_DIR` is set the anchor is that variable's parent directory. Manifest entries must name files matching `systematic-*.md`; cleanup and stale-file removal delete a manifest-owned file only when its on-disk content hash still matches the manifest's recorded hash — if a generated file has drifted from what the manifest recorded, deletion refuses before any mutation and leaves both the file and the manifest untouched. Manifest content hashes are ownership/drift evidence only — they are not a cryptographic integrity or authenticity guarantee.

The package manifest exposes the extension and skills at `package.json:17-23`, with tests verifying both manifest entries and their packaged paths `tests/unit/package-exports.test.ts:42-66,241-267` [PI-4]. Pi's RPC/JSONL test fixture isolates its environment (`tests/integration/pi.test.ts:349-388`), and the installed runtime exposes environment-specific agent/session directories `node_modules/@earendil-works/pi-coding-agent/dist/config.js:396-398` [PI-5].

Pi does not consume `disabled_skills` or Systematic's OpenCode configuration: `src/pi.ts` constructs its skill resolver with a hardcoded empty disabled-skills list, so every bundled skill is available through `systematic_skill` regardless of what is disabled for OpenCode. Pi's skill loading also has no OpenCode-style permission gate — OpenCode's `skill-tool.ts` calls `context.ask({ permission: 'skill', ... })` before returning skill content, but Pi 0.80.6's extension API has no equivalent hook and Systematic's Pi tool implementation does not call one [PI-6]. Those are deliberate honesty boundaries, not implied parity.

## Claude Code — Tier 1 shipped adapter

Claude Code's profile records name-based subagent dispatch, `AskUserQuestion`, task tracking through `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate`, and native Skill/`SKILL.md` discovery [CC-P]. Systematic builds a self-contained plugin bundle in CI from `skills/` and `agents/` via `scripts/build-claude-code-plugin.ts`: it flattens agent personas, composes an output style from the using-systematic body plus the Claude Code profile, emits a declarative `SessionStart` hook, and translates every internal identifier (`ce:<name>`, `systematic:<category>:<name>`) into Claude Code's plugin-namespaced form (`systematic:<skill-dir>`, `systematic:<agent-stem>`), gated by an integrity check that fails the build on any leftover source-namespace or unresolved bare reference [CC-9]. The bundle is never committed to `main` — `claude-code/` is gitignored build staging — and CI publishes the built output to the orphan `claude-code-plugin` branch on every push to `main` [CC-11]. Users install it through the marketplace catalog checked into `main` at `.claude-plugin/marketplace.json`, which points the `systematic` plugin entry at the `claude-code-plugin` branch ref [CC-12]: `claude plugin marketplace add marcusrbrown/systematic` then `claude plugin install systematic@systematic`. The plugin has no version field; it is versioned by the source commit SHA baked into each publish commit.

Delegation is name-based: a prompt invokes a subagent by name (for example, "Use the systematic-implementer subagent to …") and Claude Code resolves it against the plugin's `agents/` directory; skills may additionally run scoped subagent forks via `context: fork` [CC-1]. `AskUserQuestion` is the blocking-interaction tool [CC-2]. `TodoWrite` is deprecated and disabled by default; `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` are the current task-tracking tools [CC-3][CC-4]. Skills are discovered natively from `SKILL.md` under `~/.claude/skills/`, `.claude/skills/`, and the plugin's own `skills/` directory through the built-in Skill tool; Systematic registers no `systematic_skill` tool on Claude Code, unlike its OpenCode and Pi adapters [CC-5][CC-6][CC-9].

Behavioral enforcement rides a plugin output style (`force-for-plugin: true`), which is the documented plugin-native channel that modifies the system prompt directly and auto-applies when the plugin is enabled. The `SessionStart` hook carries declarative session state only (a static skill/agent count and catalog) — imperative hook content is refused as prompt injection, so the hook does not attempt to inject behavioral instructions. Workflow content ships as native skills; agents ship as native subagents. The integration is deliberately layered rather than relying on one mechanism to do everything:

| Layer | Mechanism | Role |
|---|---|---|
| Enforcement | Plugin output style (`force-for-plugin: true`) | Authoritative, install-alone behavioral discipline |
| State | `SessionStart` hook | Declarative session facts (skill/subagent availability) only |
| Workflow | Native skills | Skill content and instructions, discovered natively |
| Agents | Native subagents | Persona dispatch by name |

Honest capability boundary: output-style enforcement is real and applies automatically on install, but it operates at the system-prompt level — the same layer as any other instruction the model receives — so it is strong guidance, not a hard gate the model cannot violate. Coverage also differs by surface: plugin-bundled hooks fire app-wide, including in Cowork, while a project-local `.claude/settings.json` hook fires in the Code tab but not in Cowork — state or enforcement reaching Cowork sessions has to come through the plugin, not a project-local hook. Integration coverage lives in `tests/integration/claude-code.test.ts` [CC-10].

## Codex CLI — Tier 2 documented portability target

The supplied evidence verifies only `request_user_input`: its definition names the tool [CX-1], and its handler blocks while restricting use to the root thread, rejecting subagents [CX-2]. Delegation, task tracking, skill loading, and skills-file support were not checked and remain **UNVERIFIED**. Systematic ships no Codex adapter or profile.

## Gemini CLI — Tier 2 documented portability target

The supplied evidence verifies `ask_user`: the official documentation says it pauses execution until answers arrive [GE-1], and the implementation defines `ASK_USER_TOOL_NAME` [GE-2]. Other capabilities, including delegation, task tracking, and skill-file support, were not checked and remain **UNVERIFIED**. Systematic ships no Gemini adapter or profile.

## GitHub Copilot — Tier 2 documented portability target

Copilot documents built-in agents and custom-agent invocation [GH-1][GH-2]. Its documented blocking behavior is plan-mode clarification, with `--no-ask-user` disabling asks; no dedicated blocking-tool name was verified [GH-3][GH-4]. The cloud-agent tasks/sessions API is documented, but no `TodoWrite` equivalent was verified [GH-5]. `SKILL.md` skills are documented [GH-6], as are instruction files including `AGENTS.md`, `.github/copilot-instructions.md`, and `.github/instructions/**/*.instructions.md` [GH-7][GH-8]. Systematic ships no Copilot adapter or profile.

## Similarities and differences

`SKILL.md` is the clearest cross-harness convergence: it is documented for Claude Code and Copilot, consumed by OpenCode's Systematic skill path, and shipped through Systematic's adapters for both Pi and Claude Code [OC-4][PI-4][CC-5][CC-9][GH-6]. `AGENTS.md` is also converging as an instruction-file convention: this repository uses it (`AGENTS.md:1-7`), and Copilot documents it [GH-7][GH-8].

Delegation semantics diverge materially: OpenCode supports parallel/background dispatch [OC-1], Pi's adapter is sequential-only [PI-1], Claude Code dispatches subagents by name and additionally supports skill-scoped `context: fork` [CC-1], and the remaining Tier 2 delegation claims are **UNVERIFIED**. Blocking input likewise ranges from native tools (`question`, `request_user_input`, `ask_user`, `AskUserQuestion`) to Pi's numbered-chat fallback and Copilot's plan-mode clarification [OC-2][PI-2][CC-2][CX-1][GE-1][GH-3].

## Maintenance

Update this file evidence-first: verify the implementation path and line range, installed/cloned source, or authoritative URL before adding a tool name. Re-check URLs when their pinned revision or behavior matters. Preserve **UNVERIFIED** when a capability has not been checked; do not fill gaps from intuition. Tier 1 changes require updating the corresponding profile and this registry together.

Migrated-skill discipline is enforced by the [content-integrity gate](scripts/content-integrity.ts); keep exact harness identifiers in the designated profile/evidence surfaces and follow the gate's allowlist policy rather than weakening the gate.

## Evidence registry

- **OC-P** — [OpenCode profile](skills/using-systematic/references/opencode-profile.md#L3-L8).
- **OC-1** — cloned OpenCode source, `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/tool/task.ts:24-62`.
- **OC-2** — cloned OpenCode source, `.slim/clonedeps/repos/anomalyco__opencode/packages/core/src/tool/question.ts:10-25`.
- **OC-3** — cloned OpenCode source, `.slim/clonedeps/repos/anomalyco__opencode/packages/core/src/tool/todowrite.ts:1-10`.
- **OC-4** — `src/lib/config-handler.ts:467-485`.
- **OC-5** — `src/lib/skill-tool.ts:41-101`.
- **OC-6** — `ARCHITECTURE.md:75-85` and `agents/`.
- **OC-7** — `src/lib/config-handler.ts:276-289`.
- **PI-P** — [Pi profile](skills/using-systematic/references/pi-profile.md#L3-L8).
- **PI-1** — `src/lib/pi-delegate-tool.ts:14-18,245-249,279-291`.
- **PI-2** — [Pi profile](skills/using-systematic/references/pi-profile.md#L5-L8).
- **PI-3** — `src/pi.ts:85-113`.
- **PI-4** — `package.json:17-23`; `tests/unit/package-exports.test.ts:42-66,241-267`.
- **PI-5** — `tests/integration/pi.test.ts:349-388`; installed Pi source `node_modules/@earendil-works/pi-coding-agent/dist/config.js:396-398`.
- **PI-6** — `src/pi.ts:59-60` (hardcoded empty disabled-skills list); OpenCode's contrasting permission gate at `src/lib/skill-tool.ts:86-87`.
- **PI-7** — `src/lib/pi-subagents-export.ts` (export lifecycle, manifest, rollback); `src/lib/pi-subagents-personas.ts` (curated persona list, compatibility screening); `src/cli.ts:48-68` (CLI surface: `pi-subagents preview|export|refresh|cleanup`). Tested interop contract: pi-subagents v0.14.3 (July 29, 2026).
- **CC-P** — [Claude Code profile](skills/using-systematic/references/claude-code-profile.md#L5-L10).
- **CC-1** — [Claude Code skills](https://code.claude.com/docs/en/skills) (`context: fork`); name-based subagent dispatch verified via `claude-code/agents/` and the plugin's invocation convention [CC-9].
- **CC-2** — [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference).
- **CC-3** — [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference).
- **CC-4** — [Claude Code todo tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking.md).
- **CC-5** — [Claude Code skills](https://code.claude.com/docs/en/skills).
- **CC-6** — [Claude Code Agent SDK skills](https://code.claude.com/docs/en/agent-sdk/skills.md).
- **CC-9** — `scripts/build-claude-code-plugin.ts:5-27,253-291,345-379` (builder, identifier translation, integrity gate); `.gitignore` (`claude-code/` gitignored build staging).
- **CC-10** — `tests/integration/claude-code.test.ts`.
- **CC-11** — `.github/workflows/main.yaml:263-338` (`publish-claude-code-plugin` job: builds, guards required artifacts, publishes to the orphan `claude-code-plugin` branch on push to `main`).
- **CC-12** — `.claude-plugin/marketplace.json:1-18` (marketplace catalog; `systematic` plugin entry sourced from the `claude-code-plugin` branch ref).
- **CX-1** — [Codex request_user_input definition](https://github.com/openai/codex/blob/35aaa5d9/codex-rs/tools/src/request_user_input_tool.rs).
- **CX-2** — [Codex request_user_input handler](https://github.com/openai/codex/blob/d47b755a/codex-rs/core/src/tools/handlers/request_user_input.rs).
- **GE-1** — [Gemini ask-user documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/ask-user.md).
- **GE-2** — [Gemini ask-user implementation](https://github.com/google-gemini/gemini-cli/blob/d2cd12a7/packages/core/src/tools/ask-user.ts).
- **GH-1** — [Copilot CLI built-in agents](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-custom-agents).
- **GH-2** — [Copilot CLI custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents).
- **GH-3** — [Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli).
- **GH-4** — [Copilot CLI automation](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically).
- **GH-5** — [Copilot cloud-agent tasks/sessions API](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api).
- **GH-6** — [Copilot CLI skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills).
- **GH-7** — [Copilot best-practices instructions](https://docs.github.com/en/copilot/get-started/best-practices).
- **GH-8** — [Copilot `AGENTS.md` support](https://github.blog/changelog/2025-08-28-copilot-coding-agent-now-supports-agents-md-custom-instructions/).
