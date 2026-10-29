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

Every npm release is published from this repository by GitHub Actions, through npm trusted publishing (OIDC), with SLSA provenance. No npm token exists. To check that a version came from this repository:

```bash
npm view @fro.bot/systematic@<version> _npmUser.email
# npm-oidc-no-reply@github.com
npm view @fro.bot/systematic@<version> dist.attestations.provenance.predicateType
# https://slsa.dev/provenance/v1
```

[RELEASING.md](RELEASING.md) describes the release process. The project's supply-chain posture is tracked publicly by [OpenSSF Scorecard](https://securityscorecards.dev/viewer/?uri=github.com/marcusrbrown/systematic).
