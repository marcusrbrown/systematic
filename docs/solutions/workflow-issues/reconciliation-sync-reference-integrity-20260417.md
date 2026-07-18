---
title: 'Reconciliation-Only Sync Creates Phantom References When Upstream Adds New Agents'
date: 2026-04-17
severity: high
category: workflow-issues
component: content-integrity-gate
tags:
  - reference-integrity
  - phantom-references
  - slack-researcher
  - content-integrity
  - content-integrity-gate
last_refreshed: 2026-05-16
environment: 'Systematic plugin / CEP upstream sync / reconciliation-only policy'
symptoms:
  - 'Three bundled skills (`ce-brainstorm`, `ce-ideate`, `ce-plan`) dispatch `systematic:research:slack-researcher` but no such agent exists in `agents/research/`'
  - 'Runtime failure when user has Slack MCP tools configured and the skill triggers the dispatch branch'
  - 'No build-time or test-time signal — markdown content is not validated against filesystem'
  - 'Issue not surfaced by any CI check; caught only by a ce:review pass post-hoc'
root_cause: 'The reconciliation-only sync policy treats each CEP definition independently and does NOT validate reference integrity between updated and new definitions. When CEP upstream added a new `slack-researcher` agent AND updated three existing skills (`ce-brainstorm`, `ce-ideate`, `ce-plan`) to dispatch it, the sync policy imported the skill content updates (classified as "hash changes" in bucket 1) but skipped the new agent (classified as "new upstream" in bucket 2, explicitly out of scope for reconciliation-only). The three skills ended up with dangling references to an agent that was never imported.'
resolution_type: workflow_improvement
confidence: verified
related:
  - docs/solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-20260417.md
  - docs/solutions/workflow-patterns/truth-reset-scope-split-20260417.md
  - docs/solutions/best-practices/qualified-persona-ids-are-canonical-validated-references-2026-07-17.md
---

# Reconciliation-Only Sync Creates Phantom References When Upstream Adds New Agents

## Problem

The April 17, 2026 final CEP reconciliation sync executed the brainstorm's "reconciliation only — skip the 12 new upstream items" policy. The sync pulled 63 hash updates (definitions already tracked, content drifted) but skipped 12 new definitions that CEP had added upstream since the previous sync.

Three of the 63 updated skills (`ce-brainstorm`, `ce-ideate`, `ce-plan`) had been modified upstream to add new dispatch branches referencing a `systematic:research:slack-researcher` agent. That agent was in the skipped "new upstream" bucket. Result: three skills now contained executable dispatch directives pointing to an agent file that doesn't exist on disk.

## Symptoms

- Skill content contains `` Dispatch `systematic:research:slack-researcher` with ... `` in conditional branches
- `find agents -name '*slack*'` returns empty
- Agent-native reviewer flagged this as P1 during `ce:review` on the PR
- Runtime effect: when a user has Slack MCP tools and triggers the "Tools available + user asked" branch in the skill, the dispatch will fail (tool-not-found) or throw
- No test catches it because skill content is not validated against the filesystem

## What Didn't Work

**Assumption: "reconciliation-only means no new content."** True at the per-definition level, but false at the reference-graph level. The reconciliation policy focused on which *definitions* to import, but ignored that updated definitions could contain *references* to skipped definitions.

**Assumption: "the batch sed / grep verification would catch dangling refs."** The verification grep only looked for stale CEP strings (e.g., `compound-engineering:`, `Claude Code`, `CLAUDE.md`). It had no check that every `systematic:*` reference on the "Systematic side" of a converted skill resolves to an existing file.

**Assumption: "if content is syntactically valid markdown, it's fine to ship."** Markdown validity says nothing about whether the dispatch targets it instructs an orchestrator to use actually exist.

## Solution

**Short-term fix applied:** imported the missing agent from CEP upstream (`agents/research/slack-researcher.md`), applied CEP→Systematic conversions (`Claude Code` → `OpenCode`, `model: sonnet` → `model: inherit` to match Systematic's research-agent convention), and verified the three dispatch refs now resolve.

```bash
# Fetch upstream agent
curl -sL https://raw.githubusercontent.com/EveryInc/compound-engineering-plugin/main/plugins/compound-engineering/agents/research/slack-researcher.md

# Apply conversions, save to agents/research/slack-researcher.md
# Verify resolution
for skill in skills/ce-brainstorm skills/ce-ideate skills/ce-plan; do
  grep -l 'systematic:research:slack-researcher' "$skill/SKILL.md" && \
    [ -f agents/research/slack-researcher.md ] && echo "RESOLVED"
done
```

## Why This Works

The agent file's presence satisfies the orchestrator's lookup path when one of the three skills triggers the dispatch branch. The conversion from `model: sonnet` to `model: inherit` aligns with Systematic's convention for research agents (all six existing research agents use `inherit`).

## Prevention

**Validate reference integrity after any sync or bulk conversion.** Add a post-sync step that greps updated definitions for `systematic:*` agent/skill refs and verifies each resolves to an existing file:

```bash
# Reference integrity check (bash/zsh compatible)
MISSING=0
while IFS= read -r ref; do
  # Extract the systematic:category:name part
  # Examples:
  #   systematic:research:slack-researcher → agents/research/slack-researcher.md
  #   systematic:review:correctness-reviewer → agents/review/correctness-reviewer.md
  #   systematic:workflow:pr-comment-resolver → agents/workflow/pr-comment-resolver.md
  path=$(echo "$ref" | sed 's|^systematic:|agents/|; s|:|/|' | awk '{print $1".md"}')
  if [ ! -f "$path" ]; then
    echo "MISSING: $ref (expected at $path)"
    MISSING=$((MISSING+1))
  fi
done < <(grep -rhoE 'systematic:(research|review|workflow|design|docs|document-review):[a-z0-9-]+' skills/ agents/ | sort -u)

[ $MISSING -gt 0 ] && echo "FAIL: $MISSING phantom refs" && exit 1
```

This logic is now implemented in `scripts/content-integrity.ts` (the `checkReferenceIntegrity` check) and runs on every CI build.

**If doing future reconciliation-only syncs**, always include this step — either in the sync tooling itself, or as a post-sync verification in the calling workflow. The sync tooling that previously existed (`convert-cc-defs` skill, `check-cep-upstream.ts` script) never had a reference-integrity step. The CLI `convert` command, which remains available for ad-hoc conversions, also does not check reference integrity — callers must do this themselves.

**CI drift gate should include reference integrity** (not just string patterns). This is now implemented in `scripts/content-integrity.ts`, which runs on every CI build and asserts:

1. Zero known-stale CEP/CC patterns in actionable source files
2. Every `systematic:*` reference resolves to an existing file

**Prefer explicit import over implicit reference** when pulling upstream updates. If an update introduces a new reference that doesn't resolve locally, either:
- Import the referenced definition (and its transitive refs), or
- Scrub the reference from the updated content

Leaving a dangling reference and hoping runtime catches it is the failure mode this doc exists to prevent.

**Corollary — the qualified form is the form to preserve.** Because `checkReferenceIntegrity` validates `systematic:<category>:<name>` against real agent files, that qualified form must not be "cleaned up" to bare names during unrelated refactors — doing so silently removes the validation coverage this doc established. See `docs/solutions/best-practices/qualified-persona-ids-are-canonical-validated-references-2026-07-17.md`.
