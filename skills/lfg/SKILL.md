---
name: lfg
description: Full autonomous engineering workflow
argument-hint: '[feature description]'
disable-model-invocation: true
---

CRITICAL: You MUST execute every step below IN ORDER. Do NOT skip any step. Do NOT jump ahead to coding or implementation. The plan phase (steps 2-3) MUST be completed and verified BEFORE any work begins. Violating this order produces bad output.

1. **Optional:** If the `ralph-wiggum` skill is available, run `/ralph-wiggum:ralph-loop "finish all slash commands" --completion-promise "DONE"`. If not available or it fails, skip and continue to step 2 immediately.

2. `/workflows:plan $ARGUMENTS`

   GATE: STOP. Verify that `/workflows:plan` produced a plan file in `docs/plans/`. If no plan file was created, run `/workflows:plan $ARGUMENTS` again. Do NOT proceed to step 3 until a written plan exists.

3. `/systematic:deepen-plan`

   GATE: STOP. Confirm the plan has been deepened and updated. The plan file in `docs/plans/` should now contain additional detail. Do NOT proceed to step 4 without a deepened plan.

4. `/workflows:work`

   GATE: STOP. Verify that implementation work was performed - files were created or modified beyond the plan. Do NOT proceed to step 5 if no code changes were made.

5. `/workflows:review`

6. `/systematic:resolve_todo_parallel`

7. `/systematic:test-browser`

8. `/systematic:feature-video`

9. Output `<promise>DONE</promise>` when video is in PR

Start with step 2 now (or step 1 if ralph-wiggum is available). Remember: plan FIRST, then work. Never skip the plan.
