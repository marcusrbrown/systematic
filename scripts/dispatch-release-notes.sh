#!/usr/bin/env bash
# Invoked by @semantic-release/exec successCmd. Receives target tag as $1.
# Dispatches fro-bot.yaml workflow and waits for the narrative rewrite.
# Fails soft for narrative-quality issues, fails hard for security-relevant issues.
# See docs/solutions/best-practices/release-notes-narrative-ci-automation-architecture-2026-05-23.md
# for the full design.

set -Eeuo pipefail

RELEASE_VERSION="${1:-}"
if [[ -z "$RELEASE_VERSION" ]]; then
  echo "::error::Missing required argument: target tag (e.g. v2.23.2)"
  exit 1
fi

# Validate the tag shape before any interpolation or dispatch.
# A malformed value could indicate a tag-spoofing attempt or a semantic-release
# plugin upgrade that changed the gitTag contract.
if ! echo "$RELEASE_VERSION" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$'; then
  echo "::error::Invalid RELEASE_VERSION shape: $RELEASE_VERSION"
  exit 1
fi

# Generate a UUID to uniquely identify this dispatch. The token is passed both
# as a workflow input field and embedded in the prompt so Fro Bot echoes it as
# its first log line. Polling matches by scanning early log lines for this token,
# eliminating same-second collision ambiguity.
# Test escape hatch: integration tests set RELEASE_NOTES_TEST_CORRELATION_ID to
# a known UUID so mock-gh fixtures can include the same value in their log output.
# Production runs never set this; uuidgen / /proc/sys/kernel/random/uuid is the
# real source of correlation tokens.
if [[ -n "${RELEASE_NOTES_TEST_CORRELATION_ID:-}" ]]; then
  CORRELATION_ID="$RELEASE_NOTES_TEST_CORRELATION_ID"
elif command -v uuidgen >/dev/null 2>&1; then
  CORRELATION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
else
  CORRELATION_ID="$(cat /proc/sys/kernel/random/uuid)"
fi

# Construct the prompt. $RELEASE_VERSION, $CORRELATION_ID, and $GITHUB_REPOSITORY
# are runtime bash env vars expanded by the heredoc. Do NOT use GitHub Actions
# workflow-expression syntax (e.g. github.repository) here — those are not interpolated inside successCmd
# strings, which run on the runner after YAML preprocessing is complete.
PROMPT=$(cat <<PROMPT_EOF
correlation=$CORRELATION_ID

You are running the release-notes-narrative skill against a just-published GitHub release.
First, echo the line "correlation=$CORRELATION_ID" to stdout (the line above this prompt) so
the dispatching workflow can identify this run. This is mandatory.

Target release tag: $RELEASE_VERSION
Target repository: $GITHUB_REPOSITORY

Idempotency check (do this FIRST):
- Fetch the current release body: \`gh release view $RELEASE_VERSION --json body --jq '.body'\`
- If the body starts with the heading \`## What's new\`, the narrative has already been applied.
  Log "already-applied; short-circuiting" and exit cleanly. Conclusion will be reported as \`neutral\`.

Procedure (only if idempotency check did NOT short-circuit):
1. Load the skill at .agents/skills/release-notes-narrative/SKILL.md from this checkout.
2. Execute the 13-step procedure against tag $RELEASE_VERSION.
3. Apply the rendered body via \`gh release edit $RELEASE_VERSION --notes-file <tmpfile>\`.

Scope constraints (do not violate):
- Do NOT comment on any PR, issue, or discussion.
- Do NOT open or close any issue.
- Do NOT edit any release body OTHER than $RELEASE_VERSION.
- Do NOT modify any file in the repository.
- Do NOT push commits, create branches, or create tags.

Report back with: the target tag, the chars-before and chars-after counts, and the
GitHub release URL.
PROMPT_EOF
)

# Capture dispatch timestamp BEFORE issuing the workflow_run call.
# We identify our dispatched run by selecting the newest workflow_dispatch run on
# fro-bot.yaml created strictly after this timestamp. The correlation-id input
# is also passed (and declared on fro-bot.yaml as an optional input) so that the
# value is visible in the run's inputs metadata for auditing, but the primary
# identification mechanism is timestamp-based.
#
# Previous strategy (log-scanning for correlation token echo) did not work in
# production: Fro Bot's agent takes several minutes to bootstrap (bun install,
# model download, MCP server startup) before it emits any prompt-derived log
# content, so a 90-second log scan budget completed before the correlation
# token ever appeared in the logs. Timestamp-based identification is robust
# against arbitrary agent boot times since gh run list reflects run creation
# time, not first-log time.
DISPATCH_EPOCH=$(date +%s)
gh workflow run --ref main fro-bot.yaml \
  -f "prompt=$PROMPT" \
  -f "correlation-id=$CORRELATION_ID"

# Poll up to 90 seconds for a workflow_dispatch run on fro-bot.yaml that was
# created strictly after DISPATCH_EPOCH. Once found, this is our dispatched run
# (no other dispatchers race against this from main.yaml's Release job).
# Test escape hatches: RELEASE_NOTES_TEST_POLL_BUDGET_SECS and
# RELEASE_NOTES_TEST_POLL_INTERVAL_SECS shorten the loop for unit tests.
# Production runs always use 90s budget / 5s interval.
POLL_BUDGET_SECS="${RELEASE_NOTES_TEST_POLL_BUDGET_SECS:-90}"
POLL_INTERVAL_SECS="${RELEASE_NOTES_TEST_POLL_INTERVAL_SECS:-5}"
RUN_ID=""
POLL_DEADLINE=$(( $(date +%s) + POLL_BUDGET_SECS ))
while [ "$(date +%s)" -lt "$POLL_DEADLINE" ]; do
  # Find the newest workflow_dispatch run on main whose createdAt is strictly
  # after DISPATCH_EPOCH. gh run list returns ISO-8601 timestamps; convert each
  # to epoch via `date -d` and compare numerically.
  CANDIDATE_ID="$(gh run list --workflow=fro-bot.yaml --branch=main --event=workflow_dispatch \
    --json databaseId,createdAt --limit 10 2>/dev/null \
    | jq -r --argjson cutoff "$DISPATCH_EPOCH" \
      '[.[] | . + {epoch: (.createdAt | fromdateiso8601)}]
       | map(select(.epoch > $cutoff))
       | sort_by(.epoch) | reverse | .[0].databaseId // empty')"
  if [ -n "$CANDIDATE_ID" ] && [ "$CANDIDATE_ID" != "null" ]; then
    RUN_ID="$CANDIDATE_ID"
    break
  fi
  sleep "$POLL_INTERVAL_SECS"
done

if [ -z "$RUN_ID" ]; then
  echo "::error::Dispatched workflow run not found within ${POLL_BUDGET_SECS}s (correlation=$CORRELATION_ID, dispatched_at_epoch=$DISPATCH_EPOCH). GitHub may have rejected the dispatch or the workflow never started."
  exit 1
fi

# Wait for the run to complete, hard-bounded at 10 minutes.
# Test escape hatch: RELEASE_NOTES_TEST_WATCH_TIMEOUT_SECS shortens the wait.
# Disable errexit around `timeout` so a non-zero exit (e.g., 124 for timeout)
# is captured into WATCH_EXIT rather than killing the script.
WATCH_TIMEOUT_SECS="${RELEASE_NOTES_TEST_WATCH_TIMEOUT_SECS:-600}"
set +e
timeout "$WATCH_TIMEOUT_SECS" gh run watch "$RUN_ID" --exit-status
WATCH_EXIT=$?
set -e

# Fetch conclusion and full log (ANSI codes stripped) for classification.
CONCLUSION="$(gh run view "$RUN_ID" --json conclusion --jq '.conclusion' 2>/dev/null || echo 'unknown')"
LOG="$(gh run view "$RUN_ID" --log 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g')"

# Check for off-target release edits: any 'release edit vX.Y.Z' line that is NOT
# our target tag is a security signal (Fro Bot edited the wrong release).
OFF_TARGET="$(echo "$LOG" | grep -E 'release edit v[0-9]+\.[0-9]+\.[0-9]+' \
  | grep -v "release edit $RELEASE_VERSION" || true)"

# Check for auth/permission failure keywords in the log.
AUTH_FAIL=0
if echo "$LOG" | grep -qE 'HTTP 401|HTTP 403|Bad credentials|Resource not accessible|requires authentication|permission denied'; then
  AUTH_FAIL=1
fi

# Post-write integrity check: if Fro Bot reported success, verify the release body
# is substantive (>=200 chars). A short body means the write silently failed or
# produced a partial/empty result.
BODY_LEN=0
if [ "$CONCLUSION" = "success" ]; then
  BODY_LEN="$(gh release view "$RELEASE_VERSION" --json body \
    --jq '.body | length' 2>/dev/null || echo 0)"
fi

# Classify outcome by precedence. Security-relevant failures exit 1 with ::error::.
# Narrative failures exit 0 with ::warning::. Happy path exits 0 with plain stdout.
# WATCH_EXIT semantics: 0 = run completed (classify by CONCLUSION below),
# 124 = timeout (narrative-failure), any other non-zero = unexpected (security-relevant).
# The "unexpected" branch covers runner crashes, gh CLI bugs, signal propagation, and
# any future gh run watch exit codes we haven't anticipated. Without this branch,
# an unexpected WATCH_EXIT falls through to CONCLUSION classification which may
# report "unknown" and silently exit 0.
if [ "$WATCH_EXIT" -eq 124 ]; then
  echo "::warning::Fro Bot run timed out after 10 minutes (run=$RUN_ID, correlation=$CORRELATION_ID)"
  exit 0
elif [ "$WATCH_EXIT" -ne 0 ]; then
  echo "::error::Unexpected gh run watch exit (WATCH_EXIT=$WATCH_EXIT, run=$RUN_ID, correlation=$CORRELATION_ID). May indicate a runner crash, gh CLI bug, or signal propagation."
  exit 1
elif [ -n "$OFF_TARGET" ]; then
  echo "::error::Off-target release edit detected (run=$RUN_ID): $OFF_TARGET"
  exit 1
elif [ "$AUTH_FAIL" -eq 1 ]; then
  echo "::error::Auth failure in dispatched run (run=$RUN_ID, correlation=$CORRELATION_ID). Check FRO_BOT_PAT scope."
  exit 1
elif [ "$CONCLUSION" = "action_required" ]; then
  echo "::error::Workflow requires manual intervention (run=$RUN_ID, conclusion=$CONCLUSION)"
  exit 1
elif [ "$CONCLUSION" = "skipped" ]; then
  echo "::error::Workflow was skipped — likely blocked by policy/branch protection (run=$RUN_ID)"
  exit 1
elif [ "$CONCLUSION" = "success" ] && [ "$BODY_LEN" -lt 200 ]; then
  echo "::error::Reported success but body integrity check failed (BODY_LEN=$BODY_LEN, run=$RUN_ID, tag=$RELEASE_VERSION)"
  exit 1
elif [ "$CONCLUSION" = "success" ]; then
  echo "Narrative applied: tag=$RELEASE_VERSION run=$RUN_ID correlation=$CORRELATION_ID"
  exit 0
elif [ "$CONCLUSION" = "neutral" ]; then
  echo "No-action-taken (already-applied idempotency short-circuit): tag=$RELEASE_VERSION run=$RUN_ID"
  exit 0
elif [ "$CONCLUSION" = "cancelled" ]; then
  echo "::warning::Workflow cancelled (run=$RUN_ID, correlation=$CORRELATION_ID)"
  exit 0
elif [ "$CONCLUSION" = "failure" ]; then
  echo "::warning::Fro Bot run failed (narrative-failure, no security signals detected): run=$RUN_ID"
  exit 0
else
  echo "::warning::Unknown conclusion: $CONCLUSION (run=$RUN_ID, correlation=$CORRELATION_ID)"
  exit 0
fi
