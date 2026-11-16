---
title: A scanner exception names exactly what it excuses, says why, and has a test that fails when it widens or goes stale
date: 2026-11-16
category: best-practices
module: security-scanning
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Adding a path to a code scanner's ignore list, such as CodeQL `paths-ignore`"
  - "Telling an automated reporter that a known advisory is accepted and should stop escalating"
  - "A scanner reports many alerts on generated or third-party code that cannot be fixed at its source"
  - "An exception is easier to write as a glob or a class than as a list of the real cases"
tags: [codeql, paths-ignore, advisories, accepted-risk, generated-code, fro-bot, security-scanning, test-pinned]
---

# A scanner exception names exactly what it excuses, says why, and has a test that fails when it widens or goes stale

## Context

Two exceptions to automated security reporting landed on the same day, for the same reason: a scanner kept reporting things that are not defects in code the project owns.

- CodeQL reported 31 open alerts on the two bundled helper scripts, `skills/ce-connect/scripts/connect.mjs` and `skills/ce-review/scripts/validate-review.mjs`. They are built by `Bun.build` from `src/`, which CodeQL already analyses, plus inlined zod, js-yaml and jsonc-parser. The alerts traced to that third-party code or to exported bindings the bundler made local (#1402).
- The daily Fro Bot report escalated the same High advisories every day. None of them reaches the published package: they live in the dev toolchain, in nested copies, or in tools embedded in the release runner's npm (#1401).

Both fixes silence something. A silence that is wider than its reason hides real findings later, and nothing reports a hidden finding. The two changes avoid that in the same three ways.

## Guidance

An exception to a scanner is exact, justified and pinned by a test.

### Exact

Name the path, the advisory id, the package and the version. Do not use a pattern or a category when a list of the real cases is short.

- The CodeQL config ignores two files, not a `skills/*/scripts` glob (`.github/codeql/codeql-config.yml:13-17`, `paths-ignore`). The glob would also have hidden `skills/ce-review-cleanup/scripts/cleanup.mjs`, which is hand-written. CodeQL does analyse it: alert #60 was `js/file-system-race` on that file, and it was triaged and dismissed as a false positive. A glob would have made that triage impossible, and the same for the next alert on a hand-written script.
- The advisory exception lists each id with the package and version it applies to, for example `GHSA-r292-9mhp-454m (tar 7.5.19)` (`.github/workflows/fro-bot.yaml:213-236`, `ACCEPTED RISKS`). An exception for "dev dependencies" would also excuse the next advisory in a dev dependency.

### Justified, next to the exception

The reason is written where the exception is, so a later reader can check it against the code.

- The ignore list carries a comment per entry: the bundles are generated from scanned source and inlined third-party code (`.github/codeql/codeql-config.yml:15`, comment above the bundle entries), and `tests/manual` is a deliberately imperfect seed app that an evaluation asks a model to harden (`.github/codeql/codeql-config.yml:8-12`).
- The `ACCEPTED RISKS` block says what was checked: that none of the packages is in `dependencies`, the `npm pack` file list, `dist/`, the bundled skill scripts or the docs deploy. It says where each one lives, and what makes the shipped copy safe where there is one (the shipped zod is 4.6.7, which is patched).

### Ends when the evidence ends

The advisory block says when the exception stops: escalate again only on new evidence, meaning the package reaches a shipped artifact or a runtime dependency, or a newer advisory appears for the same package. When the installed version moves outside an advisory's range, the advisory is reported as resolved (`.github/workflows/fro-bot.yaml:232-236`, `Escalate again only on new evidence`). The exception follows the reason it was granted for, not a date.

### Pinned by a test

**CodeQL list.** `tests/unit/codeql-config.test.ts` requires every ignored path to be a generated surface output (`GENERATED_SURFACES` in `scripts/lib/generated-surfaces.ts`) or the one allowlisted exception (`tests/unit/codeql-config.test.ts:20`, `NON_GENERATED_ALLOWLIST`). It also requires both bundles to exist, and no ignored entry to cover a file under `src/`. A hand-written script cannot be added without editing the allowlist, which is where a reviewer sees it.

**Advisory block.** `tests/unit/fro-bot-workflow.test.ts:1184` (`records accepted High advisories so they stop escalating`) checks the block's position in the prompt, the fragments that say what happens (`Report these under Security as accepted`, `Escalate again only on new evidence`, `report that advisory as resolved`), and that each listed id is present. It catches a removed id but not an added one: an extra id passes (`tests/unit/fro-bot-workflow.test.ts:1192-1209`), so adding an advisory is a review decision, not a test failure.

## Related

- [`measure-a-source-scanner-blind-spots-2026-09-07.md`](measure-a-source-scanner-blind-spots-2026-09-07.md): the other side of scanner trust. This doc keeps a scanner's silences honest; that one measures what the scanner cannot see.
- #1401 (accepted advisories), #1402 (CodeQL ignore list).
