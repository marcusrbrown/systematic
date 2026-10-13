# Releasing

Maintainer runbook for `@fro.bot/systematic`. Workflows: `release.yaml` (pipeline), `release-gate.yaml` (scheduled approval). `main.yaml` runs checks only and never publishes.

## How a release happens

Merging a feature PR never publishes.

1. After each push to `main`, `release.yaml` renders the pending release and keeps one PR open: head branch `release/pending`, title `chore(release): vX.Y.Z`. Its only change is `CHANGELOG.md`. If nothing is releasable, the PR is closed.
2. The PR ships when it merges with an approval on its exact head. The approval comes from either:
   - the maintainer (`marcusrbrown`), or
   - the release gate (`release-gate.yaml`, Fro Bot), Wednesday and Sunday at 15:00 UTC, once required checks pass.
3. The merge push runs `publish`: it re-verifies the merge and the approval, then runs semantic-release with the approved changelog entry as the notes. It publishes to npm with trusted publishing (OIDC), then creates the GitHub release. The release exists only if the npm publish succeeded.
4. The published release then triggers `release-notes.yaml` (narrative), `docs.yaml` (docs deploy) and `publish-claude-code-plugin.yaml` (the `claude-code-plugin` branch).

If `main` moves after a release merge but before `publish` runs, publish refuses (`superseded`) and the next release PR carries the change.

A publish that fails before it creates the tag can be retried while `main` still points at the release merge: re-run the failed `Release` run, or dispatch `release.yaml` (see Recovery). Once `main` moves, the next release PR re-proposes the commits and needs a fresh approval.

## Publish path

Publishing happens only by merging the release PR. There is no other publish path, no mode switch and no npm token: the `publish` job in `release.yaml` authenticates to npm through OIDC alone (`id-token: write` plus the `release` environment).

If the npm trusted publisher is misconfigured, the publish fails before it tags. Correct the trusted-publisher config on npmjs.com, then re-run the pipeline (see Recovery).

The follow-on workflows (`release-notes.yaml`, `docs.yaml`, `publish-claude-code-plugin.yaml`) do not query npm. They require a release authored by the release App, and that release is created only after the npm publish.

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

If the tag exists but npm does not have the package, use the break-glass sections below instead.

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

## Recovery

There is no scheduled retry. If a merge's push run failed or did not publish or refresh the PR, re-run the failed `Release` run, or dispatch the pipeline against the current `main`:

```bash
gh workflow run release.yaml
```

Retrying a publish works only while `main` still points at the release merge. A publish run on a later `main` refuses the stale release merge (`superseded`). Refreshing the release PR works on any `main`: a run on an ordinary merge skips publishing and still renders and refreshes the PR.

## Re-narrate, redeploy docs, republish the Claude plugin

Each takes an existing published tag. Docs and the plugin accept only the repository's latest release.

```bash
gh workflow run release-notes.yaml -f tag=vX.Y.Z
gh workflow run docs.yaml -f tag=vX.Y.Z
gh workflow run publish-claude-code-plugin.yaml -f tag=vX.Y.Z
```

## Verify a publish

A green job alone is not proof. Run these checks by hand when in doubt.

```bash
npm view @fro.bot/systematic@X.Y.Z version
npm view @fro.bot/systematic@X.Y.Z _npmUser --json
gh release view vX.Y.Z --json author,tagName
```

`_npmUser.email` must be `npm-oidc-no-reply@github.com`. That means npm trusted publishing was used; any other value means the package was published with a token.

## Break-glass: partial publishes

Admin only. semantic-release runs in this order: `verifyConditions` (the npm OIDC exchange), then it creates and pushes the `vX.Y.Z` tag, then npm publishes, then the GitHub release is created. A failed OIDC exchange stops before the tag, so nothing is left behind; correct the trusted-publisher config and re-run. Two partial states remain.

### Tag pushed, npm upload failed

The tag exists, but npm has no `X.Y.Z` and there is no GitHub release. A re-run or dispatch refuses this state rather than publish over an existing tag.

1. Confirm npm has no such version: `npm view @fro.bot/systematic@X.Y.Z version` must fail with a 404. If it returns the version, this is the next state; stop.
2. Delete the stranded tag: `git push origin :refs/tags/vX.Y.Z`.
3. Re-run the failed `release.yaml` run, or land a new commit so the refresh opens a new release PR.

Never delete a tag whose version is on npm.

### npm published, GitHub release missing

npm accepted the package and creating the GitHub release then failed. The version cannot be published again, and re-running the pipeline cannot create the release. Do not delete the tag, and do not try to republish.

1. Confirm the state. The version must be on npm with the OIDC publisher, and the release must be absent:

   ```bash
   npm view @fro.bot/systematic@X.Y.Z _npmUser --json
   gh release view vX.Y.Z --json author,tagName
   git ls-remote --tags origin vX.Y.Z
   ```

   If `gh release view` finds a release, this is not the partial state; stop.

2. If the tag is missing, create it on the `chore(release): vX.Y.Z` merge commit and push it.

3. Create the release from the existing tag, using the `X.Y.Z` entry of `CHANGELOG.md` as the notes:

   ```bash
   gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file <notes>
   ```

4. The release is now authored by you, not the release App. `release-notes.yaml`, `docs.yaml` and `publish-claude-code-plugin.yaml` act only on a release authored by `vars.RELEASE_AUTHOR_LOGIN` (default `systematic-release[bot]`), so a release event skips them and a dispatch fails. To run them, set `RELEASE_AUTHOR_LOGIN` to your login, dispatch each (see above), then restore the variable. Otherwise leave them unrun and the next release covers them.
