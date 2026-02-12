---
title: Code Review Fixes for OCX Registry Support
date: 2026-02-11
category: code-quality
severity: medium
components:
  - tests/unit/registry.test.ts
  - scripts/build-registry.ts
  - registry/files/profiles/standalone/ocx.jsonc
  - registry/files/profiles/omo/ocx.jsonc
  - .github/workflows/docs.yaml
  - docs/src/content/docs/guides/ocx-registry.mdx
symptoms:
  - 6 lint warnings (5 cognitive complexity, 1 unused variable)
  - Missing semver validation allowing invalid version formats
  - Inconsistent registry URLs pointing to non-existent endpoints
  - CI workflow dependency on external jq binary
  - Missing update and troubleshooting sections in OCX guide
tags:
  - code-quality
  - ci
  - documentation
  - registry
  - validation
  - biome
  - testing
related_issues: []
---

# Code Review Fixes for OCX Registry Support

## Problem Statement

Code review of the `feat/add-ocx-support` branch identified Critical and Medium severity issues across 5 areas: test complexity warnings exceeding Biome's 15-point cognitive complexity threshold, missing semver validation in the build script's `--version` flag, registry URL inconsistencies using a non-existent `registry.fro.bot` subdomain, CI workflow dependency on jq for version resolution, and missing documentation sections for OCX registry maintenance. These manifested as lint failures preventing clean builds, potential acceptance of invalid version strings, broken registry connections, CI runner dependency issues, and incomplete user guidance.

**Trigger:** Post-implementation code review of the OCX registry support feature.

**Branch:** `feat/add-ocx-support`

**Baseline:** 6 lint warnings, 4 infos, 21 tests passing (452 assertions).

## Solutions

### 1. Test Complexity Reduction

**Root Cause:** Five test functions in `registry.test.ts` had nested loops and branching within error accumulation patterns, exceeding Biome's cognitive complexity threshold of 15 (scores ranged from 16 to 22). One unused variable also triggered a lint warning.

**Fix:** Extracted 4 helper functions to move complex logic out of test bodies:

```typescript
// Before: High complexity test with nested error accumulation
it('validates component files exist', () => {
  const errors: string[] = []
  for (const component of components) {
    for (const file of component.files) {
      const path = resolveComponentFilePath(component, file)
      if (!fs.existsSync(path)) {
        errors.push(`Missing file: ${path}`)
      }
    }
  }
  expect(errors).toEqual([])
})

// After: Helper extracts the complexity
function assertAllFilesExist(files: string[], baseDir: string): string[] {
  const errors: string[] = []
  for (const file of files) {
    const fullPath = path.join(baseDir, file)
    if (!fs.existsSync(fullPath)) {
      errors.push(`Missing file: ${fullPath}`)
    }
  }
  return errors
}

it('validates component files exist', () => {
  const errors: string[] = []
  for (const component of components) {
    errors.push(...assertAllFilesExist(component.files, component.dir))
  }
  expect(errors).toEqual([])
})
```

Fixed unused variable: `for (const [type, names] of Object.entries(...))` to `for (const names of Object.values(...))`.

**Verification:** 0 complexity warnings, 0 unused variable warnings, 21 tests still passing with 452 assertions.

**Commit:** `da39e3f refactor(tests): extract helpers to reduce complexity in registry tests`

### 2. Build Script Version Validation and Error Handling

**Root Cause:** The build script accepted any string as a `--version` flag value without validation. File reads in `buildPackument()` could throw on permission errors. No git tag fallback existed in the version resolution chain.

**Fix:** Three targeted additions:

```typescript
// Semver validation for explicit --version flag
const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/

function resolveVersion(explicit: string | null): string {
  if (explicit != null) {
    if (!SEMVER_REGEX.test(explicit)) {
      console.error(`Error: Invalid version format "${explicit}". Must be valid semver`)
      process.exit(1)
    }
    return explicit
  }

  // Git tag fallback (handles shallow clones, missing tags gracefully)
  try {
    const tag = execSync('git describe --tags --abbrev=0', {
      encoding: 'utf-8', cwd: PROJECT_ROOT
    }).trim()
    if (tag.length > 0) return tag
  } catch {
    // Fall through to package.json
  }

  // package.json fallback ... then '0.0.0-dev'
}

// File read error handling in buildPackument()
for (const file of files) {
  const sourcePath = resolveComponentFilePath(component, file)
  let content: Buffer
  try {
    content = fs.readFileSync(sourcePath)
  } catch {
    continue  // Skip file on read error (validation already checked existence)
  }
  // Process content...
}
```

**Resolution chain:** explicit `--version` -> git tag -> package.json -> `0.0.0-dev`

**Verification:** Valid semver accepted (exit 0), invalid rejected (exit 1), fallback works without flag.

**Commit:** `16c3917 fix(registry): add semver validation and file read error handling`

### 3. Registry URL Unification

**Root Cause:** Profile configuration files used `registry.fro.bot/systematic` which doesn't exist as a separate service. The canonical URL is `fro.bot/systematic`, with the registry at `/systematic/registry/`.

**Fix:** Simple find-and-replace across 3 files:

```jsonc
// Before
{ "url": "https://registry.fro.bot/systematic" }

// After
{ "url": "https://fro.bot/systematic" }
```

**Files changed:** `standalone/ocx.jsonc`, `omo/ocx.jsonc`, `standalone/AGENTS.md`

**Verification:** `grep -r 'registry\.fro\.bot'` returns 0 matches across registry and docs.

**Commit:** `f921e80 fix(registry): unify registry URLs to canonical fro.bot/systematic`

### 4. CI Version Resolution Simplification

**Root Cause:** The CI workflow used `jq -r .version package.json` to extract the version and pass it to the build script, creating an unnecessary dependency on the jq binary. The build script already had fallback logic that could handle this.

**Fix:** Removed jq usage, added `fetch-tags: true` for git tag resolution:

```yaml
# Before
- name: Checkout
  uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

- name: Build registry
  run: bun scripts/build-registry.ts --version $(jq -r .version package.json)

# After
- name: Checkout
  uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
  with:
    fetch-tags: true

- name: Build registry
  run: bun scripts/build-registry.ts
```

**Verification:** No `jq -r` references in workflows, `fetch-tags: true` present, YAML valid.

**Commit:** `3ce9a74 fix(ci): simplify registry version resolution and add docs improvements`

### 5. Documentation Updates

**Root Cause:** The OCX registry guide was missing operational sections for component maintenance and troubleshooting, leaving users without guidance after installation.

**Fix:** Added two new sections to `ocx-registry.mdx`:

- **Updating Components:** Commands for `ocx diff`, `ocx update` (single/all), version pinning, and a note about npm vs OCX update channels.
- **Troubleshooting:** 5 common issues: registry not found, component conflicts, profile failures, missing bootstrap injection, version mismatches.

**Verification:** `bun run docs:build` succeeds (55 pages built). Both sections present in guide.

**Commit:** `3ce9a74 fix(ci): simplify registry version resolution and add docs improvements`

## Prevention Strategies

### Test Complexity

- **Extract helpers early.** When error accumulation or validation loops appear in tests, extract immediately instead of letting complexity accumulate.
- **Pattern:** Helpers return error arrays (`string[]`), test bodies call helpers and assert on collected errors.
- **Threshold awareness:** Biome's `noExcessiveCognitiveComplexity` is set to 15. Functions hitting 12+ should be refactored proactively.

### Input Validation

- **Validate at entry points.** CLI arguments should be validated with clear error messages before any processing begins.
- **Use regex for simple formats.** Semver, URLs, and similar formats can be validated with regex without adding dependencies.
- **Fail fast with context.** Include the invalid value and expected format in error messages.

### URL Consistency

- **Single source of truth.** Registry URLs should be defined once and referenced everywhere.
- **Grep-based CI check.** Add a step that greps for known-bad URL patterns across config files.
- **Schema validation.** Profile JSONC files should be validated against a schema during build.

### CI Dependencies

- **Prefer built-in tools.** Node.js built-ins (`child_process`, `fs`) and git commands over external binaries.
- **Implement fallback chains.** Version resolution should degrade gracefully (git tag -> package.json -> default).
- **Audit CI workflows.** Periodically review `run:` commands for unnecessary external dependencies.

### Documentation Gaps

- **Feature checklist.** New features should include: usage docs, update instructions, and troubleshooting.
- **Docs build in CI.** `bun run docs:build` runs on every PR to catch broken documentation early.
- **Review as first-class.** Documentation review should be part of the PR process for new features.

## Code Review Checklist

For future OCX registry and build script changes:

- [ ] Test functions under 15 cognitive complexity
- [ ] CLI arguments validated with descriptive error messages
- [ ] Registry URLs consistent across all profile configs
- [ ] CI workflows use only essential external tools
- [ ] New features include update and troubleshooting documentation
- [ ] `bun run lint` shows 0 warnings
- [ ] `bun run docs:build` succeeds

## Related Resources

### Documentation
- [OCX Registry Guide](../../../src/content/docs/guides/ocx-registry.mdx)
- [Batch Import CEP Agents](../integration-issues/batch-import-cep-agents-to-systematic-20260210.md)
- [Converter Code Block Capitalization](../integration-issues/converter-code-block-tool-name-capitalization-20260210.md)
- [Structured Manual Override Tracking](../best-practices/structured-manual-override-tracking-Systematic-20260210.md)
- [Destructive to Non-destructive Converter](../best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md)

### Related Commits
- `3a25753` feat(registry): add OCX registry source and profiles
- `1484110` feat(registry): add build script and OCX documentation
- `0dc7502` ci(registry): integrate OCX registry build into docs deployment
- `ec54825` test(registry): add registry manifest validation tests

### Key Files
- `scripts/build-registry.ts` - Build script with version resolution and validation
- `tests/unit/registry.test.ts` - Registry test suite with extracted helpers
- `registry/registry.jsonc` - Registry source definition
- `.github/workflows/docs.yaml` - Docs deployment workflow

## Metrics

| Metric | Before | After |
|--------|--------|-------|
| Lint warnings | 6 | 0 |
| Lint infos | 4 | 4 |
| Test count | 21 | 21 |
| Assertions | 452 | 452 |
| CI external deps | jq | none |
| Doc sections | 7 | 9 |
| Commits | - | 4 |
| Files changed | - | 7 |
| Lines added | - | +195 |
| Lines removed | - | -56 |
