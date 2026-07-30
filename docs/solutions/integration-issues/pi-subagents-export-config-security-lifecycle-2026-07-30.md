---
title: Safe pi-subagents persona export lifecycle
date: 2026-07-30
category: integration-issues
module: pi-subagents
problem_type: integration_issue
component: tooling
symptoms:
  - Pi users had to copy Systematic personas manually to use them through pi-subagents
  - Generated persona edits were overwritten by refresh and could not serve as durable configuration
  - Export and cleanup needed to distinguish Systematic-owned files from user-owned files before mutation
  - Project config needed to be prevented from granting protected pi-subagents capabilities
root_cause: scope_issue
resolution_type: code_fix
severity: high
related_components:
  - config
  - cli
  - testing_framework
  - documentation
tags: [pi-subagents, persona-export, config-overlay, manifest, filesystem-safety, trust-boundary, integration-testing]
---

# Safe pi-subagents persona export lifecycle

## Problem

Systematic needed an explicit, opt-in way to project selected bundled personas into
`@tintinweb/pi-subagents@0.14.3` without making generated Markdown the source of truth, allowing
project config to grant protected capabilities, or risking damage to user-owned files during export,
refresh, and cleanup.

This solution covers the persona export, configuration, ownership, and filesystem-safety lifecycle.
It does not provide runtime `pi.events` detection or claim a global bound over arbitrary
pi-subagents nesting.

## Symptoms

- Pi users had to manually copy Systematic personas into a pi-subagents agents directory.
- Manual edits to generated files disappeared on refresh because those files are disposable
  projections, not durable configuration.
- A filename prefix alone could not prove ownership safely enough for overwrite or deletion.
- Reading the manifest before locking, or checking a path before reading or deleting it, left
  time-of-check/time-of-use windows.
- Uniform config merging could let project-controlled config select models or grant `thinking`,
  `tools`, or `skills` capabilities.
- A simulated integration harness could pass while the real pi-subagents `Agent` path failed.

## What Didn't Work

- **Manual edits as configuration.** `refresh` intentionally regenerates manifest-owned files from
  Systematic source, so durable overrides must live in Systematic config.
- **A simulated pi-subagents stand-in.** It could not prove discovery, nested extension loading, or
  the real v0.14.3 `Agent` execution path.
- **Manifest reads before the mutation lock.** Another process could change ownership state between
  planning and mutation.
- **Manifest membership without hash verification.** A file could change after planning and then be
  deleted as though it were still generated content.
- **Lexical path checks alone.** Symlinked ancestors or a canonical root outside the scope anchor
  could escape the intended project or global directory.
- **Treating “no creates or updates” as no work.** Remove-only export plans were skipped instead of
  deleting stale manifest-owned files.
- **Probabilistic race tests.** Infinite filesystem churn and large polling loops were too flaky and
  expensive to keep as regression coverage.

## Solution

### Keep export explicit

The CLI exposes four operations for project or global scope:

```text
systematic pi-subagents preview  --scope project|global
systematic pi-subagents export   --scope project|global
systematic pi-subagents refresh  --scope project|global
systematic pi-subagents cleanup  --scope project|global
```

`preview` is read-only. `export` prints the same per-file preflight actions before mutation.
`refresh` rewrites current manifest-owned projections but does not delete stale entries. `cleanup`
removes only files proven to be owned by the manifest.

### Screen portable personas before rendering

`src/lib/pi-subagents-personas.ts` owns the curated persona list and compatibility screening.
Exported filenames are deterministic and constrained to `systematic-*.md`; critical Systematic-only
coupling and filename collisions fail generation.

```ts
const filename = `systematic-${sanitizeName(name)}.md`
const compatibility = classifyCompatibility(source)

if (compatibility.severity === 'critical') {
  return { filename, status: 'excluded-critical', reason }
}
```

Generation emits portable content first. Configuration overlays are applied afterward so source
personas remain model-free and reusable across harnesses.

### Keep Systematic and Pi-native config separate

Durable customization lives in `systematic.json` or `systematic.jsonc`:

```text
categories / agents:
  model

pi_subagents.categories / pi_subagents.agents:
  thinking
  max_turns
  tools
  skills
```

Category values apply first; per-agent values override them field by field. A winning
`model: null` omits the model rather than falling through to a lower-priority value.

Trust rules are field-specific:

- project `model` is rejected;
- project `thinking`, `tools`, and `skills` are stripped;
- project `max_turns` is allowed;
- `temperature`, `top_p`, and OpenCode `variant` are never translated into pi-subagents fields.

Project export loads user, project, then custom config. Global export loads user and custom config
only, so the current repository cannot influence a global persona export.

### Track narrow ownership with a manifest and lock

Each agents root uses:

```text
.systematic-personas.json
.systematic-personas.lock
```

`export`, `refresh`, and `cleanup` hold the exclusive lock while reading the authoritative manifest,
planning, and mutating. A pre-existing lock is never auto-deleted.

Manifest entries must use safe basenames in the `systematic-*.md` namespace. Manifest membership is
necessary but not sufficient for deletion: the current file hash must still match the recorded
generated hash.

### Bound filesystem operations

Every export operation resolves paths from a trusted scope anchor: project cwd for project exports,
or the resolved global Pi directory for global exports. Lexical and canonical checks refuse roots or
manifest entries that escape that boundary.

Manifest handling is fail-closed. Malformed manifests, unsafe filenames, symlinked roots or
manifests, and path identity changes abort before mutation. Manifest contents are parsed from one
opened descriptor rather than checking and then reading the path again. `O_NOFOLLOW` rejects
symlinks where available; fallback platforms verify that the path still identifies the opened
regular file.

### Make mutations transactional and recheck before unlink

Writes and deletes run through one rollback-protected batch. If any write or delete fails,
previously watched files are restored and rollback failures are reported explicitly.

Deletion rechecks the manifest hash inside the unlink closure, immediately before mutation:

```ts
assertHashMatchesOrThrow(filePath, entry.hash, entry.filename, 'delete')
fs.unlinkSync(filePath)
```

This check applies both to `cleanup` and stale-file removal during `export`.

### Execute the exported artifact through the real runtime

`tests/integration/pi.test.ts` uses the pinned real `@tintinweb/pi-subagents@0.14.3` package.

One test exports `systematic-repo-research-analyst` and verifies that the real pi-subagents `Agent`
discovers and executes the exported persona. A separate combined-path test verifies that one
pi-subagents `Agent` call can invoke a nested `systematic_delegate` call whose child is created with
`noExtensions: true`.

These tests prove the supported exported-persona path and the characterized combined-delegation
path. They do not provide future runtime `pi.events` detection or prove a universal nesting bound.

## Why This Works

Systematic source plus Systematic config remain the durable authority; exported Markdown stays a
replaceable projection. Ownership requires all of the relevant evidence: a valid manifest entry, a
generated namespace filename, a root-bounded path, and a matching content hash at deletion time.

Locking keeps manifest state coherent across Systematic mutations. Canonical path checks and
descriptor-based reads prevent path substitution from turning ownership metadata into an escape.
Transactional rollback keeps a failed batch from leaving files and manifest state out of sync.
Field-aware trust rules preserve useful project customization without allowing repository-controlled
config to grant provider routing or Pi capabilities.

Finally, the real v0.14.3 integration test verifies the installed runtime contract rather than only
the generator's internal representation.

## Prevention

- Keep persona filenames deterministic, collision-checked, and limited to `systematic-*.md`.
- Treat generated files as projections; store durable overrides in config.
- Classify every new overlay field by trust level before adding it to merge logic.
- Read the ownership manifest inside the exclusive mutation lock.
- Validate lexical and canonical containment before mutation.
- Snapshot all watched paths before the first write or delete.
- Recheck content hashes in the unlink operation, not only during planning.
- Keep absent-root cleanup idempotent without weakening checks for existing symlinked roots.
- Test malformed manifests, hostile filenames, lock contention, rollback, remove-only plans, and
  symlinked roots, ancestors, and manifests.
- Exercise exported personas through the exact pinned pi-subagents runtime rather than a stand-in.

## Related Issues

- [Trust-sensitive overlay fields in plugin configuration](../best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md)
- [Test packaged harness extensions against the real Pi runtime](../best-practices/pi-real-runtime-integration-harness-2026-07-16.md)
- [Isolate harness subprocess and packaged-runtime fixtures](isolated-opencode-subprocess-fixtures-2026-05-14.md)
- [Verify installed artifacts, not just build gates](../workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md)
