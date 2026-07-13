---
title: Isolate OpenCode subprocess integration fixtures
date: 2026-05-14
last_updated: 2026-07-13
category: integration-issues
module: opencode integration tests
problem_type: integration_issue
component: testing_framework
symptoms:
  - Live OpenCode integration tests can read user-installed Systematic plugins instead of the checkout under test
  - Test runs can write sessions or state into the real project `.opencode` directory
  - Mixed installed-version behavior can happen accidentally instead of through an explicit compatibility scenario
  - Packaged-runtime tests can exercise stale `dist` output when `npm pack` runs without an explicit build
  - OpenCode can catch a plugin initialization failure and exit successfully, making exit code alone a false success signal
root_cause: test_isolation
resolution_type: test_fix
severity: medium
tags: [opencode, integration-tests, fixture-isolation, subprocess, npm-pack, packaged-artifact, plugin-loader, runtime-boundary]
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
- Running `npm pack` without first building can package stale `dist` files; this repository's `prepublishOnly` script is not an `npm pack` build guarantee.
- Loading `dist/index.js` directly does not exercise package-root resolution or prove that the expected files reached the tarball.
- Requiring a nonzero child-process exit for invalid plugin config does not match OpenCode 1.17.18. The host catches plugin-factory failures, logs them, omits the hooks, and exits zero.

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

Add a separate packaged-artifact path when the package boundary is the behavior under test. Build explicitly, pack once for the suite, then extract the same tarball into a fresh fixture for each test:

```ts
beforeAll(() => {
  assertSuccessful(Bun.spawnSync(['bun', 'run', 'build'], { cwd: REPO_ROOT }))
  packedTarballPath = npmPackOnce()
})

beforeEach(() => {
  fixture = createIsolatedFixture()
  pluginUrl = extractPackageRootIntoFixture(fixture, packedTarballPath)
})
```

Load the extracted package directory rather than `dist/index.js` so Node resolves the package's real `main` entry. Read runtime dependency names from the extracted `package.json`, create scoped parent directories when needed, and link those dependencies into the isolated fixture. This keeps the test offline and verifies packaged files, package metadata, and runtime loading. It does **not** verify registry dependency resolution or a clean consumer install.

Prove successful registration through behavior, not just the absence of errors. The packaged-runtime fixture uses a probe plugin's `tool.definition` hook to capture the `systematic_skill` description, then asserts both surviving catalog membership and removed-name absence. It also invokes a surviving skill through the real OpenCode model path.

Match failure assertions to the host contract. For OpenCode 1.17.18, invalid plugin config is caught at the plugin boundary:

```ts
expect(result.exitCode).toBe(0)
expect(result.stderr).toContain('failed to load plugin')
expect(result.stderr).toContain('Invalid Systematic config in')
```

Keep direct unit coverage for Systematic's own throw contract. The black-box test verifies how the pinned OpenCode host reports that failure.

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

The packaged-artifact scenario closes a different gap: it validates the output of the real build-and-pack pipeline through package-root resolution. Building before packing prevents stale `dist` state from masquerading as a passing package test. Reusing one tarball controls setup cost, while per-test extraction preserves runtime isolation.

OpenCode's successful process exit only describes the host process. It does not prove that a plugin factory or hook completed. Exact loader diagnostics plus positive registration probes distinguish a healthy plugin from a caught-and-logged failure. Each probe starts a fresh OpenCode process because active processes cache loaded plugin instances.

## Prevention

- Treat live CLI integration tests as subprocess sandbox tests, not just command-output assertions.
- Override `HOME`, all XDG roots, `OPENCODE_CONFIG_DIR`, and `OPENCODE_CONFIG_CONTENT` together.
- Use an env allowlist; never forward parent `npm_config_*`, OpenCode config, or token-bearing values by default.
- Redact token-like env values from failure diagnostics and test the redaction path directly.
- Make mixed installed-version probes opt-in and fixture-scoped.
- When guarding against project contamination, snapshot recursively and compare file contents, not just top-level entries.
- Run the build explicitly before `npm pack`; do not infer freshness from a lifecycle script name.
- Pack once per suite, but extract into a fresh fixture for each test.
- Load the package root so package metadata participates in resolution.
- Assert a positive registration marker such as `tool.definition`; process exit zero is not proof that plugin initialization succeeded.
- Keep the offline dependency-linking boundary explicit: it validates the packed plugin, not registry installation behavior.
- Use a fresh OpenCode process when validating a rebuilt plugin.

## Related Issues

- `tests/integration/opencode.test.ts`
- `docs/plans/2026-05-14-001-fix-isolated-opencode-integration-plan.md`
- `docs/plans/2026-07-06-002-feat-v3-cleanup-release-plan.md`
- `docs/solutions/integration-issues/opencode-plugin-hook-silent-defect-swallow-2026-05-19.md`
- `docs/solutions/integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md`
- [PR #617: Validate the packaged v3 runtime](https://github.com/marcusrbrown/systematic/pull/617)
