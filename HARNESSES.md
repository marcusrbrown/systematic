# Harnesses

This is the evidence registry for Systematic's harness-portability work. **Every tool or mechanism named here is backed by an in-repo path with line numbers, installed or cloned source, or an authoritative URL.** If the supplied research did not verify a capability, it is explicitly marked **UNVERIFIED**; absence of evidence is not evidence of absence.

**Tiers.** Tier 1 means Systematic ships a controlled adapter: OpenCode, Pi, and Claude Code. Tier 2 means the harness is documented for portability but has no Systematic adapter: Codex CLI, Gemini CLI, and GitHub Copilot.

## Capability matrix

The four capability rows use the vocabulary in the [OpenCode profile](skills/using-systematic/references/opencode-profile.md#L3-L8), [Pi profile](skills/using-systematic/references/pi-profile.md#L3-L8), and [Claude Code profile](skills/using-systematic/references/claude-code-profile.md#L5-L10).

| Capability | OpenCode (Tier 1) | Pi (Tier 1) | Claude Code (Tier 1) | Codex CLI (Tier 2) | Gemini CLI (Tier 2) | GitHub Copilot (Tier 2) |
|---|---|---|---|---|---|---|
| Subagent delegation | `task`, including `subagent_type`, resume, and background execution [OC-1] | Bounded built-in delegate: `systematic_delegate({agent, task})`; sequential, capped at 20 turns, depth-1, `noExtensions` [PI-1]. Optional mature delegation via pi-subagents (installed package personas, opt-in export for overlays; outside Systematic's bounded-delegate guarantees) [PI-7] | Name-based subagent dispatch (invoke a subagent by name in the prompt text); `context: fork` for skill-scoped forks; plugin agents ship in `agents/` [CC-1][CC-9] | **UNVERIFIED** [U] | **UNVERIFIED** [U] | Built-in/custom agents [GH-1][GH-2] |
| Blocking user interaction | `question` [OC-2] | No native blocking tool; numbered-chat fallback [PI-2] | `AskUserQuestion` [CC-2] | `request_user_input`; blocking and root-thread-only [CX-1][CX-2] | `ask_user`; pauses until answers [GE-1][GE-2] | No dedicated tool name verified; plan-mode clarification and `--no-ask-user` are documented [GH-3][GH-4] |
| Task tracking | `todowrite` [OC-3] | No native mechanism; visible list fallback [PI-2] | `TodoWrite` is deprecated/disabled by default; `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` replace it [CC-3][CC-4] | **UNVERIFIED** [U] | **UNVERIFIED** [U] | No `TodoWrite` equivalent verified; cloud-agent tasks/sessions API is documented [GH-5] |
| Skill loading | Skills become commands and `systematic_skill` is registered [OC-4][OC-5] | `systematic_skill` adapter and Pi-native activation [PI-3][PI-4] | Native Skill tool with `SKILL.md` discovery (`~/.claude/skills/`, `.claude/skills/`, plugin `skills/`); Systematic ships no `systematic_skill` tool on Claude Code [CC-5][CC-6][CC-9] | **UNVERIFIED** [U] | **UNVERIFIED** [U] | `SKILL.md` skills [GH-6] |
| Skills-file support | `SKILL.md` is loaded by the Systematic skill path [OC-4] | `pi.skills` ships `./skills`, including `SKILL.md` discovery [PI-4][PI-5] | `SKILL.md` and `.claude/skills/`; the plugin bundle is built and identifier-translated in CI from `skills/`, never committed [CC-5][CC-6][CC-9] | **UNVERIFIED** [U] | **UNVERIFIED** [U] | `SKILL.md` [GH-6] |

`[U]` means the capability was not checked in the supplied research pack. It is not a claim that the capability does not exist.

## OpenCode — Tier 1 shipped adapter

OpenCode is the primary controlled integration. Its profile defines delegation, blocking interaction, task tracking, and skill loading [OC-P]. The underlying source registers `task` with specialized-agent, resume, and background fields [OC-1], `question` as a user-facing tool [OC-2], and `todowrite` as a built-in tool [OC-3]. Systematic converts bundled skills into commands in `src/lib/config-handler.ts:467-485` and registers the skill tool in `src/lib/skill-tool.ts:41-101` [OC-4][OC-5]. Bundled agent markdown omits a model field by invariant [OC-6]; runtime configuration stays model-free unless user-owned config supplies an explicit overlay [OC-7].

Compatibility is direct: OpenCode consumes the concrete invocation language in the profile. The adapter is not a generic claim about other harnesses.

## Pi — Tier 1 shipped adapter

Pi's profile records degraded or unavailable native capabilities and explicit fallbacks [PI-P]. The adapter registers `systematic_skill` in `src/pi.ts:217-236` and `systematic_delegate` in `src/pi.ts:238-263` [PI-3]. Delegation is explicitly sequential (`executionMode: 'sequential'`), capped at `MAX_DELEGATE_TURNS = 20`, and guarded against re-entry in `src/lib/pi-delegate-tool.ts:14-18,245-249` [PI-1]. The child is spawned with `noExtensions: true`, bounding `systematic_delegate`'s own recursion; this does not bound end-to-end depth across a combined pi-subagents + Systematic path.

Optional mature delegation is available via [pi-subagents](https://github.com/tintinweb/pi-subagents). It is outside Systematic's bounded-delegate guarantees and governed by pi-subagents' own configuration. Tested against pi-subagents 0.22.0 on Pi 1.3.0; versions outside the tested range are unsupported but nonfatal. pi-subagents reaches Systematic's personas by two paths:

- **Installed package.** The package declares `pi.subagents.agents` at `package.json:24-28`, pointing at `dist/pi-subagents/agents/`. `scripts/build-pi-package-agents.ts` writes that directory at build time from the same render the export uses, so the 29 curated personas it ships are byte-equal to the committed fixtures (`tests/unit/package-exports.test.ts:289-344`) [PI-7]. pi-subagents 0.22 is the first release that reads package-declared agents. It reads them from the packages in Pi's `settings.json` `packages[]`, global and project, and never from `node_modules`, because the only scan is Pi's own configured-package list (`node_modules/@tintinweb/pi-subagents/dist/package-resources.js:327-341`). It sees a project-scope package only after the project is trusted: the trust flag starts `false` (`node_modules/@tintinweb/pi-subagents/dist/package-resources.js:90`), is passed to `SettingsManager.create` when the package list is read (`node_modules/@tintinweb/pi-subagents/dist/package-resources.js:332`), and keys the scan (`node_modules/@tintinweb/pi-subagents/dist/package-resources.js:432`). An installed Systematic therefore exposes `systematic-<name>` types with plain defaults and no export step. `pi -e` does not, because it is not in `packages[]`, and neither does a git install, which has no built `dist/`. `tests/integration/pi.test.ts:1550-1652` pins dispatch from the package at project and global scope, the `packageAgents: false` switch in `subagents.json`, and local precedence [PI-7].
- **Export.** `systematic pi-subagents <preview|export|refresh|cleanup> --scope project|global` writes flat files that carry `systematic.json` overlays. Package agents load first, so a local file of the same name outranks the packaged one (`node_modules/@tintinweb/pi-subagents/dist/custom-agents.js:36-39,59-64`). No files are written without an explicit command [PI-7].

Packaged personas are config-blind. The only function that sets pi-subagents' agent registry, `registerAgents` (`node_modules/@tintinweb/pi-subagents/dist/agent-types.js:65`), is called only from its own `dist/index.js:361`, so another extension cannot register or filter agent types. Overlays, `disabled_agents` and `agents.<name>.disable` therefore cannot reach a packaged file. `src/pi.ts:165-179` warns once at startup when either is configured. pi-subagents' own `/agents → Disable` turns off one packaged persona, and `packageAgents: false` in `subagents.json` turns off all of them (`node_modules/@tintinweb/pi-subagents/dist/settings.js:133-135`). A top-level `Agent` call runs in the background unless it passes `run_in_background: false` (`node_modules/@tintinweb/pi-subagents/dist/index.js:1187`).

Export writes are governed by a manifest (`.systematic-personas.json`) and an exclusive per-root mutation lock (`.systematic-personas.lock`) held for the duration of `export`/`refresh`/`cleanup`; a pre-existing lock is never auto-deleted — a reported lock requires manual verification that no operation is actually running before removal. The export honors the same disable settings as the rest of Systematic: a persona disabled by `disabled_agents` (bare name or `category/name`) or by an `agents.<name>.disable` overlay is not exported [PI-6].

Systematic's own config (`systematic.json`/`.jsonc`) is the durable source of truth for exported personas; the generated persona files and manifest are a disposable projection. `export` computes and prints its per-file preflight actions (create/update/skip/refuse/remove), a summary and the target directory before any mutation, the same way `preview` does, and lists any files edited since export after them under "Still active in pi-subagents". `refresh` intentionally overwrites current manifest-owned generated files that have drifted from source, and removes manifest-owned files that are unchanged and no longer wanted (a disabled persona, or one dropped from the curated set) — run `preview` first to see what would change. Project-scoped export (default) loads `user → project → custom` config for the current working directory; global-scoped export loads `user → custom` only and never absorbs cwd project overlays. Project-sourced `model` on the `categories`/`agents` overlay is rejected outright by config validation; project-sourced `thinking`, `tools`, and `skills` on the `pi_subagents` overlay are silently stripped before merge; `max_turns` is trust-any. pi-subagents 0.22.0 has no equivalent frontmatter fields for `temperature`, `top_p`, or `variant` (its loader, `node_modules/@tintinweb/pi-subagents/dist/custom-agents.js`, reads none of them) — Systematic never emits them, so an authored `temperature` or `mode` does not carry over to Pi.

Every export/refresh/cleanup operation walks every path component from a scope-anchored root down to the target agents directory and fails closed if any intermediate component is a symlink or a non-directory: the project anchor is the current working directory, the default global anchor is the user's home directory, and when `PI_CODING_AGENT_DIR` is set the anchor is that variable's parent directory. Manifest entries must name files matching `systematic-*.md`. `cleanup` deletes a manifest-owned file only when its on-disk content hash still matches the manifest's recorded hash — if a generated file has drifted from what the manifest recorded, `cleanup` refuses before any mutation and leaves both the file and the manifest untouched, and the user reverts the file to its exported content or deletes it by hand before running it again. `export` and `refresh` apply the same hash check to files that are no longer wanted, but a drifted file is left in place and reported as still active, and its previous manifest entry is kept unchanged, so a hand-edit never aborts the run. Manifest content hashes are ownership/drift evidence only — they are not a cryptographic integrity or authenticity guarantee.

The package manifest exposes the extension and skills at `package.json:17-23` (and the packaged personas at `package.json:24-28`), with tests verifying both manifest entries and their packaged paths `tests/unit/package-exports.test.ts:64-84,268-288` [PI-4]. Pi's RPC/JSONL test fixture isolates its environment (`tests/integration/pi.test.ts:349-388`), and the installed runtime exposes environment-specific agent/session directories `node_modules/@earendil-works/pi-coding-agent/dist/config.js:396-398` [PI-5].

Pi honors Systematic's disable settings. `src/pi.ts` loads the merged config once at extension start and passes `disabled_skills` to the skill resolver, so a disabled skill is absent from the `systematic_skill` description and parameter hint and fails to load as unknown. The same list reaches Pi's bootstrap, which drops the worktree placement rule when `git-worktree` is disabled; nothing else from the config reaches the bootstrap, so Pi still ignores `bootstrap.enabled` and `bootstrap.file` and carries the rule even when `bootstrap.file` is set [PI-8]. It filters the `systematic_delegate` catalog with `isAgentDisabled`, so a persona disabled by `disabled_agents` (bare name or `category/name`) or by an `agents.<name>.disable` overlay disappears from the tool's description, hint and lookup. The pi-subagents export applies the same predicate, and `tests/unit/disable-parity.test.ts` pins it to what OpenCode's config handler omits [PI-6]. Settings are read at extension start, so a Pi restart applies a change. Pi's `systematic_skill` takes a single `name` parameter and no arguments (`src/pi.ts:222-226`) [PI-3], so a skill that needs arguments, such as `mode:embed` and image paths for `pr-attachments`, reads them from the invoking instruction text instead; OpenCode and Claude Code can also pass skill arguments. Pi's own skill discovery is a separate path: `pi.skills` ships the whole `./skills` directory and Pi's `/skill:name` commands, so those still list and load disabled skills [PI-4], [PI-5]. Pi's skill loading also has no OpenCode-style permission gate — OpenCode's `skill-tool.ts` calls `context.ask({ permission: 'skill', ... })` before returning skill content, but Pi 0.80.6's extension API has no equivalent hook and Systematic's Pi tool implementation does not call one [PI-6]. Those are deliberate honesty boundaries, not implied parity.

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

Honest capability boundary: output-style enforcement is real and applies automatically on install, but it operates at the system-prompt level — the same layer as any other instruction the model receives — so it is strong guidance, not a hard gate the model cannot violate. Coverage also differs by surface: plugin-bundled hooks fire app-wide, including in Cowork, while a project-local `.claude/settings.json` hook fires in the Code tab but not in Cowork — state or enforcement reaching Cowork sessions has to come through the plugin, not a project-local hook. The output style is also static and the build reads no user config, so it cannot follow `disabled_skills`: it always carries the worktree placement rule, even when `git-worktree` is disabled [CC-13]. Integration coverage lives in `tests/integration/claude-code.test.ts` [CC-10].

## Worktree placement rule — bootstrap paths

One short rule ships in the shared bootstrap: create a worktree at `.worktrees/<branch>` under the main repository root with the `git-worktree` skill's script, and follow a different location or tool when the user or a project instruction names one. The script (`skills/git-worktree/scripts/worktree-manager.sh`) is small and non-interactive: `create`, `list`, `switch`, `copy-env` and `cleanup`, with exit codes 0 ok, 1 error, 2 usage and 3 refused, and no stdin reads. `create` places the worktree at `.worktrees/<branch>` under the main root, writes `.worktrees/.gitignore` and never edits the root `.gitignore`, and fails closed on a bare, separate-git-dir or submodule layout; `cleanup` reports and removes only named clean worktrees [WT-2]. The rule lives in `skills/using-systematic/references/worktree-placement.md` and holds no harness identifiers [WT-1]. Each adapter composes it differently:

- **OpenCode.** `src/index.ts` always supplies the rule, and `getBootstrapContent` omits it when `git-worktree` is in `disabled_skills`. It sits after the usage template and before the capability profile. `bootstrap.enabled: false` returns no bootstrap, and an existing `bootstrap.file` is returned verbatim with no rule, because the user owns that file [OC-8].
- **Pi.** The extension supplies the rule and passes `disabled_skills`, and nothing else from the config. The rule is therefore present unless `git-worktree` is disabled, including when `bootstrap.file` is set, because Pi never reads that setting [PI-8].
- **Claude Code.** The output style is static, so it always carries the rule between the using-systematic body and the profile. The build fails when the rule file is missing [CC-13].

Tests drive the real OpenCode plugin init and the real Pi extension init under an isolated home and the real config loader, and pin the built Claude Code output style byte for byte. The script's behavior is covered by unit tests against real throwaway git repositories, also run under stock macOS `/bin/bash` 3.2 [WT-2]. Together these are package-level evidence: no live OpenCode, Pi or Claude Code session has created a worktree from a build carrying the rule.

## Review synthesis pipeline validator — packaged paths

The raw-return validator and the four-phase synthesis pipeline (`screen`, `prepare`, `merge`,
`finalize`) ship as one self-contained Node bundle,
`skills/ce-review/scripts/validate-review.mjs`, generated from
`src/ce-review-validator.ts` by `scripts/generate-ce-review-validator.ts` and
gated by `bun run ce-review-validator:drift` (run by `bun run surfaces:drift`). The bundle dispatches six subcommands (`return`,
`artifact`, `screen`, `prepare`, `merge`, `finalize`) through one shared exit-code vocabulary (0
ok, 1 rejection/oversized/invalid UTF-8, 2 usage/TTY/read failure) and one exception boundary;
`merge` and `finalize` run through one shared strict-JSON stdin runner bounded by
`AGGREGATE_STDIN_BYTE_CAP`. Recorded execution evidence for this surface:

- **npm / OpenCode / Pi package layout** — real Node execution from an extracted
  `npm pack --ignore-scripts` archive, resolving the script through its packaged
  `skills/ce-review` directory [RV-1].
- **OCX-selected tree** — real Node execution from the `ce-review` component's
  declared file selection [RV-1].
- **Claude Code generated bundle** — real Node execution from the output written
  by `generatePluginFiles`/`writePluginFiles` [RV-1].
- **OpenCode scripted host** — a real scripted-host session loads the packaged
  `ce:review` skill and invokes the packaged script's `return` subcommand through
  its `SKILL_DIR` anchor [RV-2].

No live Pi, OCX, or Claude Code runtime host was executed for this check; those
layouts are proven by package-tree execution under real Node, not by running the
harness. This is package-tree execution plus one real OpenCode scripted host,
not cross-harness runtime parity.

## PR attachments helper — packaged paths

The `pr-attachments` skill ships one self-contained Node helper,
`skills/pr-attachments/scripts/pr-attachments.mjs`. It imports only `node:` builtins and has no
relative imports. Eight subcommands (`classify`, `splice`, `extract`, `urls`, `repin-rewrite`,
`pins`, `cleanup-set`, `verify`) each read one JSON object on stdin and write one JSON object on
stdout, with exit code 0 for success, 1 for a domain failure and 2 for a usage error. The skill
invokes the helper as `node "$SKILL_DIR/scripts/pr-attachments.mjs"`, so the file mode bit is not
part of the contract. The helper needs `node` 18+ on PATH. A Bun-only OpenCode install does not
have it, and the skill stops with its state reported rather than running the helper's work by hand.
Recorded execution evidence for this surface:

- **npm / OpenCode / Pi package layout** — real Node execution from an extracted
  `npm pack --ignore-scripts` archive, resolving the helper through its packaged
  `skills/pr-attachments` directory [PA-1].
- **OCX-selected tree** — real Node execution from the `pr-attachments` component's declared file
  selection, with a negative control for a selection that omits the helper [PA-1].
- **Claude Code generated bundle** — real Node execution from the output written by
  `generatePluginFiles`/`writePluginFiles`, with the helper byte-identical to source [PA-1].
- **Skill contract** — `SKILL.md` is parsed as data: the mode and dispatch tables, the `SKILL_DIR`
  anchor in every fenced block, the publishing order, and the bans on force-pushes, blanket staging,
  inline bodies and hand-run `git rm` [PA-2].
- **Offline dry run** — the fenced blocks of `SKILL.md` run against a temporary repository with a
  local bare remote and the real helper: the pathspec commit, the file-set assertion, the explicit
  refspec push, the rejected non-fast-forward push, carry mode and cleanup [PA-3]. Git attributes are
  covered the same way: `docs/evidence/** text eol=lf` stops at the guard, `core.autocrlf` and a
  rewriting commit hook are caught by the staged and committed blob checks, and none of them reaches
  the remote. A merge that resolved an image selects the merge as the pin, not its parent. The
  private-repository blob check runs against a stand-in `gh` that answers from the local repository:
  match, mismatch, absent file, bounded retries and the `local` expectation used by re-pin mode.

One live OpenCode session ran a build of this branch, loaded as a `file://` plugin with isolated
config and no user-global plugins. It loaded `systematic:pr-attachments` through `systematic_skill`,
ran `classify` against a public pull request, and asked the scrub confirmation before any commit or
push. It stopped there. The remote branch and the pull request body were unchanged afterwards. The
PR flow, re-pin, the `--body-file` round trip and the private-repository blob form were also run by
hand against real GitHub repositories, which exercised GitHub's raw-content serving. None of that
live evidence is reproduced by the test suite.

The offline dry run uses no real `gh` and no network. The helper's `verify` subcommand is tested
against a local HTTP server (`tests/unit/pr-attachments-verify.test.ts`). No live Pi, OCX or Claude
Code host was executed. `SKILL_DIR` resolution on Pi and Claude Code is evidenced from the package
tree only. These layouts are proven by package-tree execution under real Node and by a scripted run
of the skill's own commands, plus one live OpenCode run, not cross-harness runtime parity.

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
- **OC-6** — `ARCHITECTURE.md:158-164` and `agents/`.
- **OC-7** — `src/lib/config-handler.ts:276-289`.
- **OC-8** — `src/index.ts:60-70` (the rule is always supplied to `getBootstrapContent` together with the loaded config); `src/lib/bootstrap.ts:142-157` (`readWorktreePlacementRule`), `:241-250` (`bootstrap.enabled` and `bootstrap.file` return before the rule is composed), `:262-266` (the rule is omitted when `disabled_skills` contains `git-worktree`), `:276` (placement after the usage template and before the profile); `tests/unit/bootstrap.test.ts:979-1178` (real `loadConfig`: default, `git-worktree` disabled, another skill disabled, qualified name rejected, `bootstrap.enabled: false`, existing and missing `bootstrap.file`); `tests/unit/plugin.test.ts:1400-1499` (real plugin init).
- **PI-P** — [Pi profile](skills/using-systematic/references/pi-profile.md#L3-L8).
- **PI-1** — `src/lib/pi-delegate-tool.ts:14-18,245-249,279-291`.
- **PI-2** — [Pi profile](skills/using-systematic/references/pi-profile.md#L5-L8).
- **PI-3** — `src/pi.ts:217-263`.
- **PI-4** — `package.json:17-23`; `tests/unit/package-exports.test.ts:64-84,268-288`.
- **PI-5** — `tests/integration/pi.test.ts:349-388`; installed Pi source `node_modules/@earendil-works/pi-coding-agent/dist/config.js:396-398`.
- **PI-6** — `src/pi.ts:181-186` (merged `disabled_skills` passed to the skill resolver); `src/pi.ts:242-251` (`systematic_delegate` catalog filtered with `isAgentDisabled`); `src/lib/config.ts:2103-2115` (`isAgentDisabled`); `src/lib/pi-subagents-export.ts:857-893` (`generateEntries` applies it to the export); `tests/unit/disable-parity.test.ts` (parity with OpenCode's config handler); OpenCode's contrasting permission gate at `src/lib/skill-tool.ts:191-196`.
- **PI-7** — `package.json:24-28` (the `pi.subagents.agents` declaration); `scripts/build-pi-package-agents.ts` (writes `dist/pi-subagents/agents/` at build time); `tests/unit/package-exports.test.ts:76-83,289-344` (manifest key, `pi-package` keyword, packed files byte-equal to the fixtures); `tests/integration/pi.test.ts:1550-1652` (real Pi host: dispatch from the package at project and global scope, the `packageAgents: false` fallback to `general-purpose`, and a local file outranking the packaged one); `node_modules/@tintinweb/pi-subagents/dist/package-resources.js:90,327-341,432` (which packages are read, trust), `node_modules/@tintinweb/pi-subagents/dist/custom-agents.js:36-39,59-64` (precedence), `node_modules/@tintinweb/pi-subagents/dist/settings.js:133-135` (`packageAgents` gate), `node_modules/@tintinweb/pi-subagents/dist/index.js:361,1187` (registry setter and background default), `node_modules/@tintinweb/pi-subagents/dist/agent-types.js:65` (`registerAgents`); `src/lib/pi-subagents-export.ts` (export lifecycle, manifest, rollback, stale-file removal and retention); `src/lib/pi-subagents-personas.ts` (curated persona list, compatibility screening); `src/cli.ts:1080-1106` (CLI surface: `pi-subagents preview|export|refresh|cleanup`). Tested interop contract: pi-subagents 0.22.0 on Pi 1.3.0.
- **PI-8** — `src/pi.ts:188-203` (rule supplied, `piConfig.disabled_skills` the only config passed); `src/lib/bootstrap.ts:175-195` (`computeBootstrapContentSafe` keeps `bootstrap.enabled` and `bootstrap.file` at their defaults); `tests/unit/pi.test.ts:1314-1444` (real extension init: default, `git-worktree` disabled, `bootstrap.file` set, `bootstrap.enabled: false`, foreign prompt text kept and not doubled).
- **CC-P** — [Claude Code profile](skills/using-systematic/references/claude-code-profile.md#L5-L10).
- **CC-1** — [Claude Code skills](https://code.claude.com/docs/en/skills) (`context: fork`); name-based subagent dispatch verified via `claude-code/agents/` and the plugin's invocation convention [CC-9].
- **CC-2** — [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference).
- **CC-3** — [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference).
- **CC-4** — [Claude Code todo tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking.md).
- **CC-5** — [Claude Code skills](https://code.claude.com/docs/en/skills).
- **CC-6** — [Claude Code Agent SDK skills](https://code.claude.com/docs/en/agent-sdk/skills.md).
- **CC-9** — `scripts/build-claude-code-plugin.ts:5-28,256-368,374-418` (builder, identifier translation, integrity gate); `.gitignore` (`claude-code/` gitignored build staging).
- **CC-10** — `tests/integration/claude-code.test.ts`.
- **CC-11** — `.github/workflows/main.yaml:263-338` (`publish-claude-code-plugin` job: builds, guards required artifacts, publishes to the orphan `claude-code-plugin` branch on push to `main`).
- **CC-12** — `.claude-plugin/marketplace.json:1-18` (marketplace catalog; `systematic` plugin entry sourced from the `claude-code-plugin` branch ref).
- **CC-13** — `scripts/build-claude-code-plugin.ts:129-157` (the rule file is read after the using-systematic and profile checks, fails the build when missing, and sits between the body and the profile); `tests/unit/build-claude-code-plugin.test.ts:491-514` and the byte-exact output-style fixture in the same file; `tests/integration/claude-code.test.ts:140-162` (real build: the rule appears exactly once between the body and the profile).
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
- **RV-1** — `tests/unit/ce-review-validator-packaging.test.ts` (real Node execution from the npm/OpenCode/Pi package tree, the OCX-selected tree, and the Claude Code generated bundle).
- **RV-2** — `tests/integration/ce-review-return-validation.test.ts` (real OpenCode scripted host invoking the packaged `skills/ce-review/scripts/validate-review.mjs` through its `SKILL_DIR` anchor).
- **PA-1** — `tests/unit/pr-attachments-packaging.test.ts` (real Node execution of `skills/pr-attachments/scripts/pr-attachments.mjs` from the npm-packed archive, the OCX-selected tree and the Claude Code generated bundle; nothing under `docs/evidence/` ships).
- **PA-2** — `tests/unit/pr-attachments-contract.test.ts` (`skills/pr-attachments/SKILL.md` contract: modes, argument dispatch, `SKILL_DIR` anchor, publishing order, bans).
- **PA-3** — `tests/unit/pr-attachments-dry-run.test.ts` (the skill's fenced blocks run offline against a temporary repository and a local bare remote, with the real helper).
- **WT-1** — `skills/using-systematic/references/worktree-placement.md` (the rule text); `tests/unit/bootstrap.test.ts:1043-1092` (exact text, at most 350 bytes, names `git-worktree` and `.worktrees/<branch>`, keeps the raw-add ban and the carve-out sentence, no harness identifiers, no `CLAUDE.md` literal).
- **WT-2** — `skills/git-worktree/scripts/worktree-manager.sh` (the script); `tests/unit/git-worktree-manager.test.ts` and `tests/unit/git-worktree-cleanup.test.ts` (placement from the root, a subdirectory and a linked worktree, refused layouts, ignore policy, base resolution, `--no-track`, `list`, `switch`, `copy-env`, `cleanup`; real git in throwaway repositories with a bare `origin`, `TEST_BASH=/bin/bash` runs them under bash 3.2); `tests/unit/git-worktree-skills-contract.test.ts` (the safety and routing terms in `skills/git-worktree/SKILL.md` and the pointers in `ce-review`, `orchestrating-subagents` and `git-clean-gone-branches`). Package probe: the plugin-init, Pi-init and built-output-style tests cited by WT-1, OC-8, PI-8 and CC-13. No live session has run.
