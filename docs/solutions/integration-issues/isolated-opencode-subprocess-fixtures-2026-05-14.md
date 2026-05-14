---
title: Isolate OpenCode subprocess integration fixtures
date: 2026-05-14
category: integration-issues
module: opencode integration tests
problem_type: integration_issue
component: testing_framework
symptoms:
  - Live OpenCode integration tests can read user-installed Systematic plugins instead of the checkout under test
  - Test runs can write sessions or state into the real project `.opencode` directory
  - Mixed installed-version behavior can happen accidentally instead of through an explicit compatibility scenario
root_cause: test_isolation
resolution_type: test_fix
severity: medium
tags: [opencode, integration-tests, fixture-isolation, subprocess]
---

# Isolate OpenCode subprocess integration fixtures

## Problem

Live `opencode run` integration tests need to verify the current checkout, not whatever Systematic version is installed in user config. They also must not leave session/config/cache artifacts in the real project or user OpenCode directories.

## Symptoms

- Running the tests creates OpenCode sessions visible in the project TUI session list.
- A globally installed `@fro.bot/systematic` can participate in a test unintentionally.
- A test that appears to verify local behavior may actually be observing mixed local + installed plugin behavior.
- Containment checks that only compare top-level `.opencode` entries miss nested writes or file modifications.

## What Didn't Work

- Setting only `OPENCODE_CONFIG_DIR` is too narrow. OpenCode and plugins also resolve paths through `HOME` and XDG base directories.
- Letting user config load implicitly creates accidental mixed-version coverage instead of a controlled compatibility test.
- Top-level `.opencode` snapshots miss mutations inside existing directories.
- Capturing only final prompt text cannot distinguish normal chat transforms from title-generation transforms.

## Solution

Use a per-test temp project and fully isolated OpenCode environment for every live subprocess test:

```ts
const childEnv = buildChildEnv({
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_PRUNE: '1',
  ...extraEnv,
  HOME: fixture.homeDir,
  XDG_CONFIG_HOME: fixture.xdgConfigHome,
  XDG_DATA_HOME: fixture.xdgDataHome,
  XDG_CACHE_HOME: fixture.xdgCacheHome,
  XDG_STATE_HOME: fixture.xdgStateHome,
  OPENCODE_CONFIG_DIR: fixture.configDir,
  OPENCODE_CONFIG_CONTENT: configContent,
})
```

The important ordering is deliberate: caller-provided `extraEnv` can add fixture-scoped values such as npm cache/prefix paths, but mandatory fixture roots and `OPENCODE_CONFIG_CONTENT` are written last so parent env poison cannot override them.

Default integration tests should load the current checkout explicitly:

```ts
function buildSourceLocalConfig(): string {
  return JSON.stringify({
    plugin: [`file://${path.join(REPO_ROOT, 'src/index.ts')}`],
  })
}
```

Keep mixed installed-version checks explicit and gated:

```ts
const MIXED_VERSION_ENABLED = process.env.SYSTEMATIC_MIXED_VERSION_TEST === '1'

function buildMixedVersionConfig(probePluginUrl: string): string {
  return JSON.stringify({
    plugin: ['@fro.bot/systematic@2.14.1', localSource, probePluginUrl],
  })
}
```

Add a probe plugin when asserting hook behavior. For OpenCode v1.14.41, normal chat system transforms receive `{ sessionID, model }`, while title-generation transforms receive `{ model }`. Capture enough metadata to assert the contract separately:

- chat transforms contain exactly one `SYSTEMATIC_WORKFLOWS` block in `system[0]`
- title-generation transforms contain zero `SYSTEMATIC_WORKFLOWS` blocks
- `systematic_skill` tool definitions stay deterministic across duplicate registrations

Finally, protect the real repo by snapshotting `.opencode` recursively with content hashes and symlink targets. Compare sorted snapshot entries after the subprocess run. If `.opencode` did not exist before the test, assert it still does not exist afterward.

## Why This Works

OpenCode subprocesses inherit their filesystem and plugin identity from environment variables. Isolating only one config variable leaves fallback paths open through `HOME`, XDG directories, cache directories, or project `.opencode` state. A complete fixture makes the subprocess operate inside a disposable sandbox while still allowing authentication variables required by the selected test model.

Explicit source-local and mixed-version scenarios keep the test's claim honest. The default path verifies the checkout under test. The gated mixed-version path verifies interoperability with the globally published version only when intentionally requested.

## Prevention

- Treat live CLI integration tests as subprocess sandbox tests, not just command-output assertions.
- Override `HOME`, all XDG roots, `OPENCODE_CONFIG_DIR`, and `OPENCODE_CONFIG_CONTENT` together.
- Use an env allowlist; never forward parent `npm_config_*`, OpenCode config, or token-bearing values by default.
- Redact token-like env values from failure diagnostics and test the redaction path directly.
- Make mixed installed-version probes opt-in and fixture-scoped.
- When guarding against project contamination, snapshot recursively and compare file contents, not just top-level entries.

## Related Issues

- `tests/integration/opencode.test.ts`
- `docs/plans/2026-05-14-001-fix-isolated-opencode-integration-plan.md`
