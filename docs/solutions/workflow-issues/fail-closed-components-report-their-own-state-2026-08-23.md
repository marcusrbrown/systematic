---
title: A fail-closed component reports its own state, not the failure that caused it
date: 2026-08-23
module: dependencies
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A dependency bump produces far more failures than its diff would suggest"
  - "A parser, loader, or classifier reports a fallback state instead of an error"
  - "Peer ranges or version numbers suggest an incompatibility not yet observed"
  - "A package changes major versions or publishes multiple module formats"
related_components:
  - tooling
  - testing_framework
tags:
  - renovate
  - dependency-upgrades
  - web-tree-sitter
  - js-yaml
  - wasm
  - package-exports
  - fail-closed
  - diagnosis
---

# A fail-closed component reports its own state, not the failure that caused it

## Context

Three Renovate PRs were failing at once. Two were misdiagnosed from version metadata
before anything was checked.

`web-tree-sitter` 0.25.10 → 0.26.12 failed 44 tests across the workflow-guard adapter,
the receipt operation adapters, and the receipt classifier. The obvious reading was a
grammar ABI mismatch: `tree-sitter-bash` tops out at 0.25.1 and peers on
`tree-sitter: ^0.25.0`, and both are pinned exactly on the 0.25 line.

That was wrong: 0.26 renamed the exported asset to `./web-tree-sitter.wasm`, and three
call sites still resolving the old subpath threw `ERR_PACKAGE_PATH_NOT_EXPORTED` before
`Parser.init()` ran.

`js-yaml` 4 → 5 failed four separate CI jobs. The obvious reading was that v5 had gone
ESM-only. Also wrong: v5 kept both formats but removed the *default export*, and all four
call sites used `import yaml from 'js-yaml'`.

## Guidance

### The failure signature belongs to the component, not the fault

The classifier fails closed by design. When it cannot parse, it returns
`outcome: "unavailable"` with `reasonCode: "parser-asset-unavailable"` and mints no
receipts. That is correct behavior — refusing to classify is safer than guessing.

But it means 44 assertions read:

```text
Expected: "accepted"
Received: "unavailable"
```

Nothing in that says *missing file*. It says the classifier declined, which reads like a
classification bug. The component reported its own state accurately and told you nothing
about why it was in that state.

When a fail-closed component reports degradation, treat the reported state as the last
link in the chain rather than the first. Find the earliest operation that failed — import,
asset resolution, initialization, parse, assertion — and start there.

### Failure breadth is not evidence of cause

`js-yaml` broke four CI jobs and a scattering of unrelated suites: the Pi entry point,
packaging, module resolution, several codegen scripts. That breadth suggested something
systemic about the module system.

It was one import line. `src/lib/frontmatter.ts` is the most-imported module in the
repository, so its failure prevented the module graph from constructing and unrelated
suites never ran. A wide blast radius measures how central the broken thing is, not how
large the break is.

### Check the export map, not the peer range

Check the installed package directly:

```bash
npm view web-tree-sitter@0.26.12 exports --json
node -e "const y=require('js-yaml'); console.log(Object.keys(y), y.default)"
```

`./tree-sitter.wasm` was gone and `./web-tree-sitter.wasm` had taken its place — the whole
defect, in one command, never touching ABI. And `y.default` is `undefined` under v5: not
ESM-only, just no default export.

### Disprove the version hypothesis directly

The ABI question was answerable directly:

```ts
const rt = Bun.fileURLToPath(import.meta.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const gr = Bun.fileURLToPath(import.meta.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
await Parser.init({ locateFile: () => rt })
const lang = await Language.load(gr)   // ABI 15
new Parser().setLanguage(lang)          // runtime accepts 13-15
```

The pinned grammar loads under the new runtime and parses a real command; the peer range
that looked prohibitive describes the native binding, not the WASM runtime.

### Check the behavior a major version kept, not just the API it changed

Converting four `js-yaml` imports would have compiled but shipped a regression:

```ts
load('')   // v4: {}   v5: throws YAMLException
```

`frontmatter.ts:54` depends on the v4 behavior and `tests/unit/frontmatter.test.ts:122-130`
pins it. An API migration that typechecks is not a behavioral migration.

## Why This Matters

Both hypotheses were reasonable — exact pins on a matching version line usually do mean a
coordinated pair — and neither survived a single command.

The cost of being wrong is asymmetric. Acting on the ABI hypothesis would have declined an
upgrade whose real fix was three path edits, waiting on a `tree-sitter-bash` release that
was never required. Acting on the ESM hypothesis would have sent the migration toward
module configuration and away from the break.

## When to Apply

Apply when a dependency bump produces failures disproportionate to its diff, when a parser
or loader reports a fallback state, when peer ranges suggest an incompatibility nobody has
observed, or when a package publishes multiple module formats or changes a major version.

This is not an argument against grouping. `web-tree-sitter` and `tree-sitter-bash` are now
grouped in Renovate — not for the ABI reason originally assumed, but because a runtime bump
can require call-site changes that cannot pass as a lone half.

## Examples

The asset rename, in full:

```
0.25.10   ./tree-sitter.wasm        ./debug/tree-sitter.wasm
0.26.12   ./web-tree-sitter.wasm    ./debug/web-tree-sitter.wasm
```

Three call sites resolved the old name:

```
src/lib/receipt-classifier.ts:638
tests/unit/receipt-classifier.test.ts:382
tests/unit/package-exports.test.ts:249
```

One sits inside a template literal, so a TypeScript structural search found only two of
three. Enumerate the matches and check the count.

## Related

- [Version-pinned evidence must be re-proven when the pinned runtime moves](version-pinned-evidence-must-be-reproven-2026-08-16.md)
  — the third PR in this batch was an OpenCode bump, and that document already covers it
  completely. It is the reason the bump went straight to the latest published version
  rather than the next patch: moving the pin costs a seventeen-minute real-host suite run,
  and landing one patch behind current would have meant paying it twice more.
- [A green release job is not evidence that anything was published](../integration-issues/green-job-is-not-proof-of-publication-2026-08-18.md)
  — the same shape at the CI layer: a reported state standing in for an unverified fact.
- [Availability guards must check executability, not PATH presence](../integration-issues/availability-guards-must-check-executability-2026-08-16.md)
  — a presence check that reports its own result rather than the underlying condition.
- PRs: #727 fixed, #733 declined, #856 superseded bump, #857 grouping.
