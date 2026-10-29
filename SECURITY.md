# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately. Do not open a public issue for a suspected vulnerability.

- Use [GitHub's private vulnerability reporting](https://github.com/marcusrbrown/systematic/security/advisories/new) to open a confidential advisory, **or**
- Email **contact@marcusrbrown.com** with the details.

Include the affected component, the version, and reproduction steps or a proof of concept where possible. Components are:

- the `@fro.bot/systematic` plugin for OpenCode or Pi
- the `systematic` CLI
- the Claude Code plugin
- the OCX registry at `fro.bot/systematic`
- a bundled skill, agent or script

You will receive an acknowledgement, and fixes for confirmed issues are coordinated privately before disclosure.

Bundled skills include shell scripts that agents run, such as `skills/git-worktree/scripts/`. Report command injection or unsafe file handling in them like any other vulnerability. Report vulnerabilities in OpenCode, Pi, Claude Code or OCX themselves to those projects.

## Supported Versions

Only the most recent release receives security fixes.

| Version        | Supported |
| -------------- | --------- |
| Latest release | ✅        |
| Older releases | ❌        |

## Verifying a Release

GitHub Actions publishes every npm release from this repository's `release.yaml` workflow on `main`. It uses npm trusted publishing (OIDC) and attaches SLSA provenance. No npm token exists.

To check a version, first verify its signatures and provenance in a project that has it installed:

```bash
npm audit signatures
```

`@fro.bot/systematic` must be counted under "verified attestations". That confirms the provenance is signed and bound to the package you installed.

Then read the build source the provenance records:

```bash
curl -s "https://registry.npmjs.org/-/npm/v1/attestations/@fro.bot%2fsystematic@<version>" \
  | jq -r '.attestations[] | select(.predicateType == "https://slsa.dev/provenance/v1")
      | .bundle.dsseEnvelope.payload' | base64 -d \
  | jq -r '.predicate.buildDefinition.externalParameters.workflow | "\(.repository) \(.path) \(.ref)"'
# https://github.com/marcusrbrown/systematic .github/workflows/release.yaml refs/heads/main
```

The package page on npmjs.com shows the same source under Provenance. A version without verified provenance, or with a different repository or workflow, was not published by this project.

[RELEASING.md](RELEASING.md) describes the release process. The project's supply-chain posture is tracked publicly by [OpenSSF Scorecard](https://securityscorecards.dev/viewer/?uri=github.com/marcusrbrown/systematic).
