#!/usr/bin/env bash
#
# Decide whether a release workflow (docs.yaml, release-notes.yaml) may act on a
# release, before any target ref is checked out.
#
# Inputs (env):
#   EVENT_NAME         `release` or `workflow_dispatch`
#   RELEASE_TAG        tag of the published release (release events)
#   INPUT_TAG          tag named by the operator (workflow_dispatch)
#   RELEASE_AUTHOR     author of the published release (release events)
#   EXPECTED_AUTHOR    the only trusted release author
#   REQUIRE_LATEST     `true` when the tag must be the repo's Latest release
#                      (docs deploy), `false` otherwise (narration)
#   GH_TOKEN           token for `gh`
#   GITHUB_REPOSITORY  owner/name
#   GITHUB_OUTPUT      step output file
#   NPM_RETRY_DELAY    seconds between the 6 npm lookups (default 10)
#
# Outputs (GITHUB_OUTPUT): `proceed`, and when proceeding `tag` and `version`.
#
# A release event is automatic, so an untrusted author or a non-latest tag ends
# cleanly with proceed=false. A workflow_dispatch is a deliberate request, so
# the same conditions fail the job with ::error:: where someone will see them.

set -euo pipefail

PACKAGE='@fro.bot/systematic'

fail() {
  echo "::error::$*"
  exit 1
}

skip() {
  echo "::notice::$*"
  echo "proceed=false" >> "$GITHUB_OUTPUT"
  exit 0
}

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"

case "${EVENT_NAME:-}" in
  release) is_release=true ;;
  workflow_dispatch) is_release=false ;;
  *) fail "Unsupported event '${EVENT_NAME:-}': expected release or workflow_dispatch" ;;
esac

case "${REQUIRE_LATEST:-}" in
  true | false) ;;
  *) fail "REQUIRE_LATEST must be 'true' or 'false', got '${REQUIRE_LATEST:-}'" ;;
esac

[ -n "${EXPECTED_AUTHOR:-}" ] || fail "EXPECTED_AUTHOR must not be empty"
[ -n "${GITHUB_REPOSITORY:-}" ] || fail "GITHUB_REPOSITORY must be set"

if [ "$is_release" = true ]; then
  tag="${RELEASE_TAG:-}"
  if [ "${RELEASE_AUTHOR:-}" != "$EXPECTED_AUTHOR" ]; then
    skip "Skipping: release author '${RELEASE_AUTHOR:-}' is not the expected release author '${EXPECTED_AUTHOR}'."
  fi
else
  tag="${INPUT_TAG:-}"
fi

if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid release tag '${tag}': expected vX.Y.Z"
fi

if [ "$is_release" = false ]; then
  # A dispatch carries no release payload: the release must exist, be published
  # and stable, and be authored by the trusted release author.
  if ! info=$(gh release view "$tag" --repo "$GITHUB_REPOSITORY" --json isDraft,isPrerelease,author --jq '"\(.isDraft) \(.isPrerelease) \(.author.login)"'); then
    fail "No release found for tag '${tag}'"
  fi
  read -r is_draft is_prerelease author <<< "$info"
  if [ "${is_draft} ${is_prerelease}" != "false false" ]; then
    fail "Release '${tag}' is not a published, non-prerelease release (isDraft isPrerelease = ${is_draft} ${is_prerelease})"
  fi
  if [ "$author" != "$EXPECTED_AUTHOR" ]; then
    fail "Release '${tag}' author '${author}' is not the expected release author '${EXPECTED_AUTHOR}'"
  fi
fi

if [ "$REQUIRE_LATEST" = true ]; then
  # With no tag argument, `gh release view` returns the release marked Latest.
  if ! latest=$(gh release view --repo "$GITHUB_REPOSITORY" --json tagName --jq .tagName); then
    fail "Could not resolve the latest release of ${GITHUB_REPOSITORY}"
  fi
  if [ "$tag" != "$latest" ]; then
    if [ "$is_release" = true ]; then
      skip "Skipping: release '${tag}' is not the latest release '${latest}'."
    fi
    fail "Release '${tag}' is not the latest release '${latest}'; refusing to act on a historical release"
  fi
fi

version="${tag#v}"
# The registry can lag a publish by a few seconds, so retry before giving up.
# npm's own stderr stays visible so a registry outage is not mistaken for a
# missing version.
published=false
for attempt in 1 2 3 4 5 6; do
  if npm view "${PACKAGE}@${version}" version; then
    published=true
    break
  fi
  if [ "$attempt" -lt 6 ]; then
    echo "${PACKAGE}@${version} not on npm yet (attempt ${attempt}/6)"
    sleep "${NPM_RETRY_DELAY:-10}"
  fi
done
if [ "$published" != true ]; then
  fail "${PACKAGE}@${version} is not published to npm; refusing to continue"
fi

{
  echo "proceed=true"
  echo "tag=${tag}"
  echo "version=${version}"
} >> "$GITHUB_OUTPUT"
