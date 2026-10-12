# Releasing

Maintainer runbook for `@fro.bot/systematic`. Workflows: `release.yaml` (pipeline), `release-gate.yaml` (scheduled approval), `main.yaml` (`legacy-release`, `release-mode`).

## How a release happens

Merging a feature PR never publishes.

1. After each push to `main`, `release.yaml` renders the pending release and keeps one PR open: head branch `release/pending`, title `chore(release): vX.Y.Z`. Its only change is `CHANGELOG.md`. If nothing is releasable, the PR is closed.
2. The PR ships when it merges with an approval on its exact head. The approval comes from either:
   - the maintainer (`marcusrbrown`), or
   - the release gate (`release-gate.yaml`, Fro Bot), Wednesday and Sunday at 15:00 UTC, once required checks pass.
3. The merge push runs `publish`: it re-verifies the merge and the approval, then runs semantic-release with the approved changelog entry as the notes. It publishes to npm with trusted publishing, then `confirm` checks the result.
4. The published release then triggers `release-notes.yaml` (narrative), `docs.yaml` (docs deploy) and `publish-claude-code-plugin.yaml` (the `claude-code-plugin` branch).

If `main` moves after a release merge but before `publish` runs, publish refuses (`superseded`) and the next release PR carries the change.

A publish that fails before it creates the tag is retried by the hourly reconcile while `main` is unchanged. Once `main` moves, the next release PR re-proposes the commits and needs a fresh approval.

## Release mode

`RELEASE_MODE` selects the publish path. It must be exactly `legacy` or `gated`; any other value (unset, empty, `Gated`) fails the run and nothing publishes.

```bash
gh variable set RELEASE_MODE --body gated    # approval-gated pipeline
gh variable set RELEASE_MODE --body legacy   # rollback: publish on every releasable push to main
gh variable get RELEASE_MODE
```

Assumption: only repository admins can set repository variables. Verify that in the repository settings before relying on it as a control.

In `legacy` mode the `legacy-release` job in `main.yaml` publishes, and `release.yaml` only writes a preview to its job summary.

## Main branch ruleset

`.github/settings.yml` defines a `main` ruleset with no bypass actors.

- Every PR into `main` needs one approval on its latest push. A new push dismisses earlier approvals, and an author cannot approve their own PR.
- Fro Bot approves the maintainer's PRs, the maintainer approves Renovate PRs, and the maintainer or the gate approves the release PR.
- Escape hatch: an admin can edit or disable the `main` ruleset under Settings → Rules.

## Release entry on main with no publish

The `Refresh release PR` job fails with `Rendered CHANGELOG.md matches main; a release entry is already on main without a publish`. It never opens an empty release PR.

This happens when a release PR merged but its publish failed, and another merge then landed. That leaves a changelog entry on `main` with no tag.

To recover:

1. Land any new commit on `main`, for example a `chore:` commit.
2. Its subject changes the rendered entry, so the refresh opens a new release PR.
3. Approve that PR. The gate or the maintainer can do it.

If that does not work, an admin removes the stale entry from `CHANGELOG.md` in a normal PR.

If the tag exists but npm does not have the package, use the break-glass section below instead.

## Hold and unhold

```bash
gh variable set RELEASE_HOLD --body true
gh variable delete RELEASE_HOLD
```

While `RELEASE_HOLD` is `true`, the gate skips and only a maintainer approval can publish.

## Run the gate on demand

```bash
gh workflow run release-gate.yaml
```

Only the maintainer's dispatch proceeds; a dispatch by anyone else is skipped. The gate approves only when the required checks are green on the release PR.

## Reconcile

If a merge's push run did not publish or refresh the PR, re-run the pipeline against the current `main`:

```bash
gh workflow run release.yaml
```

The pipeline also reconciles itself hourly.

## Re-narrate, redeploy docs, republish the Claude plugin

Each takes an existing published tag. Docs and the plugin accept only the repository's latest release.

```bash
gh workflow run release-notes.yaml -f tag=vX.Y.Z
gh workflow run docs.yaml -f tag=vX.Y.Z
gh workflow run publish-claude-code-plugin.yaml -f tag=vX.Y.Z
```

## Verify a publish

A green job alone is not proof. The `confirm` job runs these checks; run them by hand when in doubt.

```bash
npm view @fro.bot/systematic@X.Y.Z version
npm view @fro.bot/systematic@X.Y.Z _npmUser --json
gh release view vX.Y.Z --json author,tagName
```

`_npmUser.email` must be `npm-oidc-no-reply@github.com`. That means npm trusted publishing was used; any other value means the package was published with a token.

## Break-glass: tag created, npm publish failed

Admin only. Use this when the `vX.Y.Z` tag and release exist but the package is not on npm.

1. Confirm the version is absent. This must fail with a 404:

   ```bash
   npm view @fro.bot/systematic@X.Y.Z version
   ```

2. Delete the GitHub release and its tag:

   ```bash
   gh release delete vX.Y.Z --cleanup-tag
   ```

3. Reconcile (see above). If `main` has moved past the release merge, publish refuses as superseded; the next release PR then carries the same changes, and the version is recomputed because the tag is gone.

Never delete a release whose version is on npm.

## Cutover checklist

Before setting `RELEASE_MODE` to `gated`:

- [ ] The `main` ruleset requiring one approving review, provided by `.github/settings.yml`, is active under Settings → Rules.
- [ ] Fro Bot has been seen approving a maintainer PR.
- [ ] `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY` and the `release` environment are in place; `NPM_TOKEN` is only a fallback.
- [ ] The release App has the Variables: read repository permission, so publish can read the live `RELEASE_HOLD`.

After the first gated release, check:

- [ ] `confirm` is green.
- [ ] `_npmUser.email` is `npm-oidc-no-reply@github.com`.
- [ ] The `claude-code-plugin` branch points at the new version.
- [ ] The docs site shows the new version.
- [ ] The release body starts with `## What's new` (the narrative landed).
