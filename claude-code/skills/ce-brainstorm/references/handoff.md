# Handoff

This content is loaded when Phase 4 begins — after the requirements document is written.

---

#### 4.1 Present Next-Step Options

The Phase 4 menu's visible option count varies by state: no requirements doc hides the review option, unresolved `Resolve Before Planning` hides `Plan implementation` and `Build it now`, a failing direct-to-work gate hides `Build it now`. Count the visible options for the current state and choose the rendering mode accordingly:

- **4 or fewer visible:** use the platform's blocking question tool (`question` in OpenCode — call `ToolSearch` with `select:question` first if its schema isn't loaded; `request_user_input` in Codex; `ask_user` in Gemini, `ask_user` in Pi (requires the `pi-ask-user` extension)). This is the default.
- **5 or more visible:** render as a numbered list in chat. This is the narrow option-overflow fallback; trimming would hide legitimate choices (plan, review, build, refine, pause are all distinct destinations). Include a hint that free-form input is accepted ("Pick a number or describe what you want.") so the numbered list retains the blocking tool's open-endedness.

Never silently skip the question.

If `Resolve Before Planning` contains any items:
- Ask the blocking questions now, one at a time, by default
- If the user explicitly wants to proceed anyway, first convert each remaining item into an explicit decision, assumption, or `Deferred to Planning` question
- If the user chooses to pause instead, present the handoff as paused or blocked rather than complete
- Do not offer the `Plan implementation` or `Build it now` options while `Resolve Before Planning` remains non-empty

In both preambles below, the "Pick a number or describe what you want." hint applies only in numbered-list mode. When using the blocking tool, omit that line and pass the remaining stem as the question.

**Path format:** Use absolute paths for chat-output file references — relative paths are not auto-linked as clickable in most terminals.

**Preamble when no blocking questions remain:**

```
Brainstorm complete.

Requirements doc: <absolute path to requirements doc>  # omit line if no doc was created

What would you like to do next? (Pick a number or describe what you want.)
```

**Preamble when blocking questions remain and user wants to pause:**

```
Brainstorm paused. Planning is blocked until the remaining questions are resolved.

Requirements doc: <absolute path to requirements doc>  # omit line if no doc was created

What would you like to do next? (Pick a number or describe what you want.)
```

Present only the options that apply. Renumber so visible options stay contiguous starting at 1.

1. **Plan implementation with `ce-plan` (Recommended)** - Move to `ce-plan` for structured implementation planning. Shown only when `Resolve Before Planning` is empty.
2. **Agent review of requirements doc with `ce-doc-review`** - Dispatch reviewer agents to check the doc for coherence, feasibility, scope, and other persona-specific issues; auto-apply safe fixes; route remaining findings interactively. Shown only when a requirements document exists.
3. **Build it now with `ce-work` (skip planning)** - Skip planning and move to `ce-work`; suited to lightweight, well-defined changes. Shown only when `Resolve Before Planning` is empty **and** scope is lightweight, success criteria are clear, scope boundaries are clear, and no meaningful technical or research questions remain (the "direct-to-work gate").
4. **More clarifying questions to sharpen the doc** - Keep refining scope, edge cases, constraints, and preferences through further dialogue. Always shown.
5. **Done for now** - Pause; the requirements doc is saved and can be resumed later. Always shown.

**Post-review nudge (subsequent rounds only):** If the user has already run `ce-doc-review` this session and residual P0/P1 findings remain unaddressed, add a one-line prose nudge adjacent to the menu (e.g., "Document review flagged 2 P1 findings you may want to address — pick \"Agent review of requirements doc\" to run another pass."). Reference the option by label, not number: the menu renumbers when `Resolve Before Planning` hides `Plan implementation` and `Build it now`, so a hardcoded option number can point users at the wrong action. Do not add a separate menu option; reuse the existing agent-review option.

#### 4.2 Handle the Selected Option

Selections may be the literal option label (when the user types the label or a close paraphrase) or the option number. Match numbers against the currently-rendered (post-trim) list. Free-form input that doesn't match an option or describe an alternative action should be treated as clarification — ask a follow-up rather than guessing.

**If user selects "Plan implementation with `ce-plan` (Recommended)":**

Immediately load the `ce-plan` skill in the current session. Pass the requirements document path when one exists; otherwise pass a concise summary of the finalized brainstorm decisions. Do not print the closing summary first.

**If user selects "Agent review of requirements doc with `ce-doc-review`":**

Load the `ce-doc-review` skill, passing the requirements document path as the argument. When ce-doc-review returns "Review complete", return to the Phase 4 options and re-render the menu (the doc may have changed, so re-evaluate `Resolve Before Planning`, direct-to-work gate, and residual findings). If residual P0/P1 findings remain unaddressed, include the post-review nudge above the menu. Do not show the closing summary yet.

**If user selects "Build it now with `ce-work` (skip planning)":**

Immediately load the `ce-work` skill in the current session using the finalized brainstorm output as context. If a compact requirements document exists, pass its path. Do not print the closing summary first.

**If user selects "More clarifying questions to sharpen the doc":** Return to Phase 1.3 (Collaborative Dialogue) and continue asking the user clarifying questions one at a time to further refine scope, edge cases, constraints, and preferences. Continue until the user is satisfied, then return to Phase 4. Do not show the closing summary yet.

**If user selects "Done for now":** Display the closing summary (see 4.3) and end the turn.

#### 4.3 Closing Summary

Use the closing summary only when this run of the workflow is ending or handing off, not when returning to the Phase 4 options.

When complete and ready for planning, display:

```text
Brainstorm complete!

Requirements doc: docs/brainstorms/YYYY-MM-DD-<topic>-requirements.md  # if one was created

Key decisions:
- [Decision 1]
- [Decision 2]

Recommended next step: `ce-plan`
```

If the user pauses with `Resolve Before Planning` still populated, display:

```text
Brainstorm paused.

Requirements doc: docs/brainstorms/YYYY-MM-DD-<topic>-requirements.md  # if one was created

Planning is blocked by:
- [Blocking question 1]
- [Blocking question 2]

Resume with `ce-brainstorm` when ready to resolve these before planning.
```
