---
title: Attribute diagnostics to the declaration that emitted them
date: 2026-11-05
category: best-practices
module: config-system
problem_type: design_pattern
component: configuration
severity: medium
applies_when:
  - "Two layers or files can declare an entry with the same name, and a later one replaces an earlier one by name"
  - "A tool shows each entry with its own warnings, or must withhold warnings that name an entry"
tags: [diagnostics, warnings, attribution, search-sources, config-show, layered-config, same-name]
---

# Attribute diagnostics to the declaration that emitted them

## Context

`systematic config show` lists every search source with its warnings. In #1295, source warnings were first attached to sources by source name. Names collide across layers by design, because replacement is name-matched. The PR review reproduced the result with same-name fixtures: a valid user source `notes` showed the "was dropped" warning of an invalid project entry also named `notes`, and a base/local replacement did the same.

## Guidance

Carry each warning with the declaration that produced it, as data, from the point of emission. Do not recover the owner later from a name.

- Validation records one outcome per entry, in array order. A kept outcome holds the validated entry object and its own warnings. A dropped outcome holds its label, reason and warnings (`SearchEntryOutcome`, `src/lib/search-user-config.ts:243-257`).
- The merge keeps entry objects, so a surviving entry traces back to its outcome by object identity. `inspectSearch` builds `warningsOfKept`, keyed by the kept entry object, and each row reads its warnings from it. A dropped declaration reads its own outcome and becomes its own `dropped invalid` row (`src/lib/search-external-sources.ts:492-515, 551-571`).
- The declaring file appears only as a path inside the message text. The origin layer of a user row comes from `sourceLayers`, not from the message (`src/lib/search-external-sources.ts:540-543`).
- A retained warning that no row claimed stays in the section list, so a replaced base entry's warning is not copied onto the `.local` row that replaced it. Warnings past the per-validation detail cap are counted, not kept (`src/lib/search-user-config.ts:237-257`).
- Grouping by entry also lets a caller act on the group. `withoutEntryWarnings` (new in #1299) removes every warning that belongs to an entry (`src/lib/search-user-config.ts:727-734`). It has two production callers. `forwardedProjectWarnings` in the external-source resolver uses it so a project that is not on the allow list forwards no warning that names one of its proposals (`src/lib/search-external-sources.ts:226-231`). `splitSearchBlock` in the full config loader uses it for a project that is not allowed (`src/lib/config.ts:1042-1063`). Inspection still shows those warnings.

## Why This Matters

- A name is not an identity when replacement is name-matched. A lookup by name on a merged set can reach a different declaration than the one that emitted the message.
- Misattribution sends the user to the wrong file. Across a trust boundary it is worse: a warning that names a proposal from a project that is not allowed must not reach a reply.
- Text matching remains in two places, and it is a collision risk. `inspectSearch` filters the section list by claimed message text (`src/lib/search-external-sources.ts:461-597`), and `withoutEntryWarnings` subtracts by message text. `displaySafe` cuts displayed paths at 200 characters, so two files sharing a long prefix can emit identical warnings for same-named entries (`src/lib/search-user-config.ts:265-286`).

## When to Apply

- A merged set where a later layer replaces an earlier entry by name, and a diagnostic is printed per entry or must be hidden for an untrusted source.
- **Tests for such a set need same-name fixtures across layers**, and alias fixtures wherever one physical file is reachable through two layers (see the related doc on observation metadata).

## Examples

The tests in `describe('a warning belongs to the declaration that produced it')` assert each row's own warning (`tests/unit/search-external-sources.test.ts:1523-1678`). They cover:

- a valid user source and an invalid project source of one name, which each keep their own warning while the section list stays empty;
- an invalid base entry beside a valid local entry, where the valid `user.local` row carries nothing from the base;
- a local entry that replaces a base entry, where the base warning goes to the section list and not onto the row;
- two entries of one name in one file, where the kept entry keeps its warning and the repeat keeps its own.

The end-to-end check runs the real CLI with a base, a local and a project entry all named `notes`. It asserts one warning per row, in JSON and in the human output (`tests/unit/cli.test.ts:2452-2546`).

The not-allowed case checks that the resolver's reply carries no warning that names a proposal, while `inspectSearch` still reports each warning on the right row (`tests/unit/search-external-sources.test.ts:1052-1130`).

## Related

- #1295 added the per-entry outcomes and `inspectSearch`. #1299 added `withoutEntryWarnings` and the not-allowed suppression.
- `docs/solutions/logic-errors/shared-config-file-hid-an-invalid-sibling-and-the-search-opt-out-2026-11-05.md`
- `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md`
