# Manual test scaffolding

Probes, smoke tests, and evaluation harnesses that are run by hand during
development — not part of the automated `bun test` suite and never shipped in the
npm package (which ships only `dist/`, `skills/`, `agents/`, and `ATTRIBUTIONS.md`).

## CodeQL does not scan this directory

`tests/manual/` is excluded from CodeQL via `paths-ignore` in
[`.github/codeql/codeql-config.yml`](../../.github/codeql/codeql-config.yml).

This is intentional: scaffolding here is sometimes *deliberately* imperfect. For
example, the `with-without-eval/oauth-seed/` app is a minimal, intentionally
unhardened Express app that an evaluation asks a model to secure — its missing
CSRF protection and session fixation are the eval premise, not bugs to fix.
Scanning it would generate noise alerts that mask real findings.

**Convention:** only put manual, non-shipped scaffolding here. Do **not** place
code under `tests/manual/` that is production-bound or that you expect CodeQL to
scan — it won't be. Production code and automated tests live elsewhere
(`src/`, `tests/unit/`, `tests/integration/`).

## Renovate does not manage dependencies here

Fixture manifests under `tests/` (e.g. `with-without-eval/oauth-seed/package.json`)
are excluded from Renovate via `ignorePaths` in
[`.github/renovate.json5`](../../.github/renovate.json5). Their dependency
versions are arbitrary and intentionally fixed; they are never installed in CI.
