---
title: "A report carrier changed beside its renderer ran ahead of the renderer the workflow pins, so late ticks would have been dropped until the pin moved"
date: 2026-11-20
category: integration-issues
module: ce-connect
problem_type: integration_issue
component: infrastructure
symptoms:
  - "A carrier that read only revision-tagged boxes would match nothing in a body written by the pinned renderer, so a late tick would not be copied onto the new report on every scheduled run, if the carrier shipped before the pin moved"
  - "A carrier that accepted legacy ticks through a heuristic could pair a tick with content it was not made for"
root_cause: config_error
resolution_type: code_fix
severity: medium
tags: [ce-connect, github-actions, version-skew, pinned-dependency, report-ticks, carrier, producer-consumer, test-pinning]
---

# A report carrier changed beside its renderer ran ahead of the renderer the workflow pins, so late ticks would have been dropped until the pin moved

## Problem

The `ce:connect` workflow runs two kinds of code. The report renderer and `apply-ticks` come from `@fro.bot/systematic@${SYSTEMATIC_VERSION}`, an exact release installed from npm (`.github/workflows/connect.yaml:40`, `SYSTEMATIC_VERSION`; `.github/workflows/connect.yaml:153-161`). The tick carrier is inline JavaScript written to disk by the `post` job from the checked-out workflow file (`.github/workflows/connect.yaml:980-1056`, `Install tick carrier`). A change that alters the box format and the carrier together therefore merges with a new carrier reading bodies that the old, pinned renderer still writes. That window lasts until the pin moves to a release with the new renderer. When this change was written the pin was `SYSTEMATIC_VERSION: "3.35.3"` (`.github/workflows/connect.yaml:40`), a release published before the change, so its renderer writes boxes with no revision.

This was found in review of the revision-binding change, before merge, by reading the pin. It was not seen on a scheduled run.

## Symptoms

- The first carrier change read only boxes whose marker has a revision suffix. A body from the pinned renderer has none, so the carrier would find no boxes in it. A late tick would not be copied onto the new report on every scheduled run, if the carrier shipped before the pin moved. This was found in review.
- Accepting a legacy tick (no revision) through a heuristic gave matches nobody could verify.

## What Didn't Work

- **Suffixed-only carry.** It is correct for the new renderer and silently drops every tick under the old one.
- **Accepting an unversioned tick when its candidate "had never reopened".** A cache rollback restores an older ledger, in which a candidate that did reopen has not reopened yet. A tick made on the later content then looks acceptable against the earlier content. Nothing in a box without a revision shows which content it was made for, so no condition on the ledger can recover that.

## Solution

The carrier copies the checkbox format and keeps both formats apart. The box pattern gains an optional revision group, and the key a tick is matched on includes the revision, or an empty string when the box has none (`.github/workflows/connect.yaml:988`, `BOX`; `.github/workflows/connect.yaml:1033-1034`, `key`):

```js
// A box with no revision (the format of the pinned renderer) carries only onto a box with none.
found.push({ index, ticked: box[1] !== ' ', key: box[3] + ':' + box[4] + ':' + (box[5] === undefined ? '' : box[5]) })
```

A late tick under the old renderer is carried between two old-format bodies. A tick never crosses between formats. The tick step does the rest:

- `judge` skips a tick whose box has no revision as `unversioned` and records nothing, whatever the ledger says (`src/lib/connect-ci.ts:1683-1687`).
- The `post` job prints how many ticks were skipped that way and tells the operator to tick the current report (`.github/workflows/connect.yaml:341`).
- The guide tells the operator to settle open rows on the current report before moving the pin ([Settle a candidate on a report](../../src/content/docs/guides/cross-project-connections.mdx)).

## Why This Works

The carrier's only job is to keep a tick on the same candidate at the same content. Keying on `status:id:revision` makes that literal: a legacy box is its own key, so a legacy tick can reach only a legacy box, and a tagged box can be reached only from the same revision. Recording is a separate step that refuses an unversioned tick outright, so a legacy tick that survives the carrier still cannot settle revised content.

## Prevention

- **Test the consumer against the old producer's output.** When a consumer ships beside a producer that a pin holds back, build the fixture bodies in the old producer's format. `decisionLine` called without a revision writes it (`src/lib/connect-ci.ts:112-120`). Run the real carrier on them and assert the late tick survives (`tests/unit/connect-workflow.test.ts:3208-3216`).
- **Test both crossings.** A tick on a box with no revision is not carried onto a box with one, and the reverse (`tests/unit/connect-workflow.test.ts:3218-3222`, `tests/unit/connect-workflow.test.ts:3224-3228`). The same revision carries, and another revision does not (`tests/unit/connect-workflow.test.ts:3230-3237`).
- **Test the rollout hazard, not just the format.** A legacy tick behind a cache rollback records nothing, whatever manifest ids it names. A legacy tick is skipped as `unversioned` whether or not the candidate ever reopened (`tests/unit/connect-ci.test.ts:2447-2465`, `tests/unit/connect-ci.test.ts:2467-2485`).
- **Treat a pin as a second deployment.** Ask which parts of a change run from the pin and which from the checkout, and what each side sees while only one of them has moved. The carrier is a copy of the renderer's box format, so a format change touches both and must be safe in both orders.

## Related

- [Ticks and decisions bound to a candidate id settled reopened candidates](../logic-errors/reopen-counter-reused-after-partial-failure-bind-decisions-to-a-content-revision-2026-11-20.md): the revision this carrier keys on.
- [Rows nobody can act on starved the report's size cap](../logic-errors/report-rows-nobody-can-act-on-starved-the-size-cap-2026-11-20.md): the other rollout consequence of making legacy rows non-actionable.
- [Bound the agent step below the job so a hung scheduled run still posts](../workflow-issues/bound-the-agent-step-below-the-job-so-a-scheduled-run-still-posts-2026-11-13.md): the same workflow, and attempt-pinned fetches and hand-offs between its jobs.
- [Promote a cross-project lesson in the target's own words](../best-practices/promote-a-cross-project-lesson-in-the-targets-own-words-2026-11-09.md): another producer that has to match the validation of its consumer.
