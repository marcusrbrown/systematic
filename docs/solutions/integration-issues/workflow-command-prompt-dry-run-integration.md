---
title: Workflow command dry-run prompt integration
date: 2026-02-16
category: integration-issues
status: stale
stale_reason: "The /sync-cep workflow this doc was written against was deleted in April 2026. The generic dry-run safety lessons (align test invocation with workflow invocation; deny edit permissions in dry-run test config; keep dry-run prompt minimal) still apply to any future workflow command that supports a dry-run mode, but the specific implementation details documented here reference removed infrastructure. A focused replacement following ce:compound would be more useful than further patching this doc."
stale_date: 2026-05-16
component: sync-cep workflow + OpenCode command
symptoms:
  - Dry-run output continued into live-sync guidance
  - Integration test runs modified sync-manifest.json
  - Workflow prompt behavior diverged from local test invocation
root_cause: >-
  Dry-run relied on prompt-only stopping rules while CI still executed a live
  agent step and tests invoked commands differently than the workflow. The test
  harness allowed edits, so dry-run could mutate the manifest during runs.
resolution: >-
  Align workflow prompt shape with command invocation, remove duplicate dry-run
  bot, and enforce no-edit permissions in test OpenCode config. Use the command
  frontmatter when building test config so tests match real command settings.
---

**Note (2026-05-16):** The `/sync-cep` workflow this doc was written against was deleted in April 2026. The generic lessons about dry-run safety (align test invocation with workflow invocation, deny edit permissions, keep prompts minimal) still apply. The implementation specifics below reference removed infrastructure (`/sync-cep`, `sync-manifest.json`, `convert-cc-defs`) and are preserved for historical context.

## Problem
The `/sync-cep` dry-run did not consistently stop after the summary. In CI and
tests, the run would continue into follow-up guidance or attempt live changes.
One test run even modified `sync-manifest.json`.

## Root Cause
- Dry-run was enforced only by prompt text (no mechanical stop), while the
  workflow still ran a live agent step in all cases.
- Test harness used a different invocation (`--command`) than the workflow,
  so command parsing and prompt structure diverged.
- Test OpenCode config allowed edits, letting dry-run mutate files.

## Solution
1. **Align workflow invocation and prompt**
   - Use a single agent step in the workflow.
   - Keep the prompt in the same shape as the test harness (command line first,
     then precheck summary).
   - Add a headless CI note so the model doesn’t expect interactive follow-up.

2. **Match test config to command frontmatter**
   - Parse `.opencode/commands/sync-cep.md` frontmatter for description/model/
     subtask fields, and pass those into the OpenCode config used in tests.
   - Use the command body directly as the template (no extra wrapper).

3. **Prevent test writes**
   - Deny `edit` permission in the OpenCode test config so dry-run cannot
     modify `sync-manifest.json`.

## Key Changes (examples)

**Workflow prompt alignment (headless CI note):**
```
/sync-cep <scope> [--dry-run]

<precheck-summary>
{...}
</precheck-summary>

Note: headless CI run — user will not see live output.
```

**Test OpenCode config uses command frontmatter + denies edits:**
```
command:
  sync-cep:
    template: <command body from sync-cep.md>
    description: <frontmatter.description>
    model: <frontmatter.model>
    subtask: <frontmatter.subtask>
agent:
  build:
    permission:
      edit: deny
```

## Verification
- `bun test tests/integration/opencode.test.ts` passes without modifying
  `sync-manifest.json`.
- Dry-run outputs remain summary-only and avoid tool invocations.

## Prevention
- **Always align test invocation with workflow invocation.** If CI passes a
  prompt directly (no `--command`), the test should do the same.
- **Deny edit permissions in dry-run tests.** This prevents accidental file
  mutations even when prompt compliance slips.
- **Keep dry-run prompt minimal.** Avoid additional prose that can introduce
  contradictory instructions.

## Related References
- `docs/plans/2026-02-15-feat-automated-resync-workflow-plan.md`
- `docs/solutions/integration-issues/converter-code-block-tool-name-capitalization-20260210.md`
- `docs/solutions/test-failures/unit-suite-rewrites-repo-file-trap-2026-07-17.md` — sibling verification-side-effect trap: the unit suite itself mutating a committed file during a fix's verification run.
