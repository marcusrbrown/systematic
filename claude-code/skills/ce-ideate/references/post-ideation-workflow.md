# Post-Ideation Workflow

Read this file after Phase 2 ideation agents return and the orchestrator has merged and deduped their outputs into a master candidate list. Do not load before Phase 2 completes.

## Phase 3: Adversarial Filtering

Review every candidate idea critically. The orchestrator performs this filtering directly -- do not dispatch sub-agents for critique.

Do not generate replacement ideas in this phase unless explicitly refining.

For each rejected idea, write a one-line reason.

Rejection criteria:
- too vague
- not actionable
- duplicates a stronger idea
- not grounded in the stated context
- too expensive relative to likely value
- already covered by existing workflows or docs
- interesting but better handled as a brainstorm variant, not a product improvement
- **unjustified — no articulated warrant** (sub-agent failed to provide `direct:`, `external:`, or `reasoned:` justification, or the stated warrant does not actually support the claimed move)
- **below ambition floor** (fails the meeting-test: would not warrant team discussion — except when Phase 0.5 detected tactical focus signals, in which case this criterion is waived)
- **subject-replacement** (abandons or replaces the subject of ideation rather than operating on it — e.g., "pivot to an unrelated domain," "become a different organization")

Score survivors using a consistent rubric weighing: groundedness in stated context, **warrant strength** (`direct:` > `external:` > `reasoned:`; none excluded, but direct-evidence ideas score higher all else equal), expected value, novelty, pragmatism, leverage on future work, implementation burden, and overlap with stronger ideas.

Target output:
- keep 5-7 survivors by default
- if too many survive, run a second stricter pass
- if fewer than 5 survive, report that honestly rather than lowering the bar

## Phase 4: Present the Survivors

**Checkpoint B (V17).** Before presenting, write `<scratch-dir>/survivors.md` (using the absolute path captured in Phase 1) containing the survivor list plus key context (focus hint, grounding summary, rejection summary). This protects the post-critique state before the user reaches the persistence menu. Best-effort: if the write fails (disk full, permissions), log a warning and proceed; the checkpoint is not load-bearing. Reuses the same `<run-id>` and `<scratch-dir>` generated in Phase 1; not cleaned up at the end of the run (the run directory is preserved so the V15 cache remains reusable across run-ids in the same session — see Phase 6).

Present the surviving ideas to the user. The terminal review loop is a complete ideation cycle in itself — persistence is opt-in (Phase 5), and refinement happens in conversation with no file or network cost (Phase 6).

Present only the surviving ideas in structured form:

- title
- description
- **warrant** (tagged `direct:` / `external:` / `reasoned:`, with the quoted evidence, cited source, or written-out argument)
- rationale (how the warrant connects to the move's significance)
- downsides
- confidence score
- estimated complexity

Then include a brief rejection summary so the user can see what was considered and cut.

Keep the presentation concise. Allow brief follow-up questions and lightweight clarification.

## Phase 5: Persistence (Opt-In, Mode-Aware)

Persistence is opt-in. The terminal review loop is a complete ideation cycle. Refinement loops happen in conversation with no file or network cost. Persistence triggers only when the user explicitly chooses to save or hand off (selected in Phase 6).

When the user picks an option in Phase 6 that requires a durable record (Brainstorm, Save and end), ensure a record exists first. When the user chooses to keep refining, no record is needed unless the user asks.

**Mode-determined defaults:**

| Action | Repo mode default | Elsewhere mode default |
|---|---|---|
| Save | `docs/ideation/YYYY-MM-DD-<topic>-ideation.md` | Local file (custom path if no repo context) |
| Brainstorm handoff | `ce-brainstorm` | `ce-brainstorm` (universal-brainstorming) |
| End | Conversation only is fine | Conversation only is fine |

Both modes persist via local file save. Elsewhere mode without an obvious repo path should ask the user for a save location (current working directory, `/tmp`, or a custom path) using the same file structure as repo mode.

### 5.1 File Save (default for both modes)

1. Ensure `docs/ideation/` exists (repo mode) or confirm the chosen save location (elsewhere mode)
2. Choose the file path:
   - `docs/ideation/YYYY-MM-DD-<topic>-ideation.md` (repo mode)
   - `docs/ideation/YYYY-MM-DD-open-ideation.md` when no focus exists (repo mode)
   - user-selected path (elsewhere mode)
3. Write or update the ideation document

Use this structure and omit clearly irrelevant fields only when necessary:

```markdown
---
date: YYYY-MM-DD
topic: <kebab-case-topic>
focus: <optional focus hint>
mode: <repo-grounded | elsewhere-software | elsewhere-non-software>
---

# Ideation: <Title>

## Grounding Context
[Grounding summary from Phase 1 — labeled "Codebase Context" in repo mode, "Topic Context" in elsewhere mode]

## Ranked Ideas

### 1. <Idea Title>
**Description:** [Concrete explanation]
**Warrant:** [`direct:` / `external:` / `reasoned:` — the actual basis, quoted or cited]
**Rationale:** [How the warrant connects to the move's significance]
**Downsides:** [Tradeoffs or costs]
**Confidence:** [0-100%]
**Complexity:** [Low / Medium / High]
**Status:** [Unexplored / Explored]

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | <Idea> | <Reason rejected> |
```

If resuming:
- update the existing file in place
- preserve explored markers

## Phase 6: Refine or Hand Off

Ask what should happen next using the platform's blocking question tool: `question` in OpenCode (call `ToolSearch` with `select:question` first if its schema isn't loaded), `request_user_input` in Codex, `ask_user` in Gemini, `ask_user` in Pi (requires the `pi-ask-user` extension). Fall back to numbered options in chat only when no blocking tool exists in the harness or the call errors (e.g., Codex edit modes) — not because a schema load is required. Never silently skip the question.

**Question:** "What should the agent do next?"

Offer these three options (labels are self-contained with the distinguishing word front-loaded so options stay distinct when truncated):

1. **Refine the ideation in conversation (or stop here — no save)** — add ideas, re-evaluate, or deepen analysis. No file side effects; ending the conversation at any point after this pick is a valid no-save exit.
2. **Brainstorm a selected idea** — load `ce-brainstorm` with the chosen idea as the seed. The orchestrator first writes a durable record using the mode default in Phase 5.
3. **Save and end** — persist the ideation to a local file using the mode default (Phase 5.1), then end.

No-save exit is supported without a dedicated menu option. Pick option 1 and stop the conversation, or use the question tool's free-text escape to say so directly — persistence is opt-in and the terminal review loop is already a complete ideation cycle.

Do not delete the run's scratch directory (`<scratch-dir>` resolved in Phase 1) on completion. The V15 web-research cache is session-scoped and reused across run-ids by later ideation invocations in the same session (see `references/web-research-cache.md`); per-run cleanup would defeat that reuse. Checkpoint A (`raw-candidates.md`) and Checkpoint B (`survivors.md`) are cheap to leave behind and follow the repo's Scratch Space cross-invocation-reusable convention — OS handles eventual cleanup.

### 6.1 Refine the Ideation in Conversation

Route refinement by intent:

- `add more ideas` or `explore new angles` -> return to Phase 2
- `re-evaluate` or `raise the bar` -> return to Phase 3
- `dig deeper on idea #N` -> expand only that idea's analysis

No persistence triggers during refinement. The user can choose Save and end (or Brainstorm) when they are ready to persist.

Ending after refinement — or without any refinement at all — is a valid no-save exit. There is no required next step; stopping the conversation here leaves no durable artifact, which matches the opt-in persistence contract.

### 6.2 Brainstorm a Selected Idea

- Write or update the durable record per the mode default in Phase 5 (5.1 file save)
- Mark the chosen idea as `Explored` in the saved record
- Load the `ce-brainstorm` skill with the chosen idea as the seed

**Repo mode only:** do **not** skip brainstorming and go straight to `ce-plan` from ideation output — `ce-plan` wants brainstorm-grounded requirements. In elsewhere modes, ideation is a legitimate terminal state; brainstorming is optional deeper development of one idea, not a required next rung on an implementation ladder that does not exist in these modes.

### 6.3 Save and End

Persist via the mode default (5.1), then end. If the user instead asked to use a non-default destination (custom path), honor that explicit request.

- offer to commit only the ideation doc (repo mode)
- do not create a branch
- do not push
- if the user declines, leave the file uncommitted

After the file save (and optional commit), end the session — do not return to the Phase 6 menu.

## Quality Bar

Before finishing, check:

- the idea set is grounded in the stated context (codebase in repo mode; user-supplied context in elsewhere mode)
- **every surviving idea has articulated warrant** (`direct:`, `external:`, or `reasoned:`) that actually supports the claimed move — speculation dressed as ambition was rejected, with reasons
- **every surviving idea passes the meeting-test** unless Phase 0.5 detected tactical focus signals that waived the floor
- **no surviving idea replaces the subject** rather than operating on it
- the candidate list was generated before filtering
- the original many-ideas -> critique -> survivors mechanism was preserved
- if sub-agents were used, they improved diversity without replacing the core workflow
- every rejected idea has a reason
- survivors are materially better than a naive "give me ideas" list
- persistence followed user choice — terminal-only sessions did not write a file
- when persistence did trigger, the mode default was respected unless the user explicitly overrode it
- acting on an idea routes to `ce-brainstorm`, not directly to implementation
