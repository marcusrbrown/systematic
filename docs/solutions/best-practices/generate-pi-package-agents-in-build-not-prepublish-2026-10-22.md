---
title: Generate Pi package agents in the build, not in prepublishOnly
date: 2026-10-22
category: best-practices
module: pi-subagents
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - Shipping generated agent or persona files inside the npm package
  - The publish job installs with scripts disabled and publishes a prebuilt dist artifact
  - A committed fixture and the packaged copy must stay byte-identical
  - A host loads files from an installed package and the tests must prove the package is what it loaded
tags: [pi-subagents, npm-packaging, build-artifact, prepublish, package-agents, negative-control]
---

# Generate Pi package agents in the build, not in prepublishOnly

## Context

pi-subagents 0.22.0 and later load package agents. An installed Pi package can list agent directories
under `pi.subagents.agents` in its `package.json`, and pi-subagents loads the `.md` agent files in them
at the lowest precedence, below every local agent file
([0.22.0 changelog](https://github.com/tintinweb/pi-subagents/blob/v0.22.0/CHANGELOG.md)). It reads only
packages that Pi itself has installed through `settings.json` `packages[]`, never `node_modules`, and a
project-scope package stays invisible until the project is trusted.

Systematic ships its curated personas this way. The files have to be inside the published tarball, and
they must match the committed fixtures and a config-free `systematic pi-subagents export` byte for byte.

## Guidance

**Generate in `build` under `dist/`; do not commit the output.** The release publish job never runs
package scripts: it installs with `--ignore-scripts` and sets `npm_config_ignore_scripts` on the
semantic-release step (`.github/workflows/release.yaml`), and it publishes the `dist/` artifact the build
job uploaded. A `prepublishOnly` generator would silently never run. So the generator is the last step of
`build`:

```json
    "build": "bun run clean && bun build src/index.ts src/cli.ts --outdir dist --target bun --splitting --external @opencode-ai/plugin --external js-yaml && bun build src/pi.ts --outdir dist --target node --external @earendil-works/pi-coding-agent --external typebox --external jsonc-parser && tsc --emitDeclarationOnly && bun scripts/build-pi-package-agents.ts",
// ...
  "pi": {
    "extensions": [
      "./dist/pi.js"
    ],
    "skills": [
      "./skills"
    ],
    "subagents": {
      "agents": [
        "./dist/pi-subagents/agents"
      ]
    }
  },
```

**Render once, consume twice.** `buildPiPackageAgents` in `scripts/build-pi-package-agents.ts` calls
`generateAll` by default, the same function that produces `tests/fixtures/pi-subagents-personas/`. The
packaged build and the export share the exported `isWrittenEntry` predicate
(`src/lib/pi-subagents-personas.ts`); the fixture generator `scripts/generate-pi-subagents-personas.ts`
applies the same condition inline. A second copy of the render or of the condition lets the packaged
files, the fixtures and a config-free export drift with every test still green.

**Stage, then swap, and say what a failure leaves behind.** Files are written to a temporary sibling
directory and renamed into place, so a failure while staging leaves the previous directory untouched. The
target is removed just before the rename, so a failure in that window leaves no directory and fails the
build.

**Give the generator no destructive knobs.** The generator takes no output-path flag; a recursive delete
on a caller-supplied path is unsafe. Tests reach the write through the exported function's `outDir`
option instead.

**Prove the package is what the host loaded.** Unit and tarball tests prove the bytes; only a real host
proves discovery. `tests/integration/pi.test.ts` packs the tarball, installs it as a Pi package and calls
the pi-subagents `Agent` tool:

- project scope and global scope both dispatch `systematic-repo-research-analyst` with no export step, and
  the child request carries the packaged persona body;
- a negative control sets `packageAgents: false` in `subagents.json`, then requires at least one child
  request and asserts no request carries the persona body and the result carries pi-subagents'
  `Unknown agent type` note;
- a local `.pi/agents/systematic-repo-research-analyst.md` with a different body wins over the packaged
  copy.

The negative control has to demand a child request. Without that, a run where the call never reached a
subagent would pass it vacuously. Building the tarball without the `pi.subagents` key makes the
project-scope test fall back to `general-purpose`, so that test depends on the key.

## Why This Matters

Packaged files are also config-blind. pi-subagents offers no supported API for another extension to
filter its agent types, so `disabled_agents`, `agents.<name>.disable` and overlays in `systematic.json`
cannot reach a packaged persona. Systematic says so at startup instead (see the related warning doc), and
the user's controls are pi-subagents' own: `/agents → Disable` for one persona, or `packageAgents: false`
for all of them.

## When to Apply

- Any file a host loads from the installed package, not from Systematic's runtime: agent files, workflow
  scripts, prompt templates.
- Any generated artifact whose publish path runs with scripts disabled.
- Any feature whose only proof of discovery is a real host, where a test must show the behavior
  disappears when the package does.

## Examples

- `tests/unit/build-pi-package-agents.test.ts`: the written set equals the render, every file is
  byte-equal to its fixture, a stale file is swept, and a write that fails partway removes the staging
  directory and keeps the previous one.
- `tests/unit/package-exports.test.ts`: the tarball ships exactly the persona files under
  `package/dist/pi-subagents/agents/`, and every `pi.subagents.agents` path resolves inside it.
- `bun scripts/generate-pi-subagents-personas.ts --check` fails when the render drops a persona
  the fixtures still hold, so the fixture set is the oracle for the packaged set too.

## Related

- [Keep once-per-process Pi extension state on globalThis](pi-extension-warnings-once-per-process-2026-10-22.md)
- [Safe pi-subagents persona export lifecycle](../integration-issues/pi-subagents-export-config-security-lifecycle-2026-07-30.md)
- [Generated-artifact drift when bundled skill or agent content changes](../workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md)
- [Vendor an npm-packaged upstream skill as a generated, drift-guarded artifact](vendor-npm-packaged-skill-as-generated-artifact-2026-07-28.md)
- [Test packaged harness extensions against the real Pi runtime](pi-real-runtime-integration-harness-2026-07-16.md)
