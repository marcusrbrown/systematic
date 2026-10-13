#!/usr/bin/env bash
# Invoked by .github/workflows/release-notes.yaml (on `release: published`, or a
# manual dispatch for re-narration). Receives target tag as $1.
# Dispatches fro-bot.yaml workflow and waits for the narrative rewrite.
#
# Terminal rule: exits 0 ONLY when the re-read release body starts with
# "## What's new" (already narrated, or successfully rewritten). Every other
# non-security outcome logs `narrative-not-applied` plus a reason and exits 2.
# Security-relevant outcomes (off-target edits, auth failures, ...) exit 1.
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

# A release body is narrated iff it starts with this heading. It is the single
# success signal for this script (no length heuristics).
NARRATIVE_MARKER="## What's new"

# Exit code for every non-security outcome where the narrative was not applied.
NARRATIVE_NOT_APPLIED_EXIT=2

# Log a narrative-not-applied outcome with its reason label and exit non-zero.
# This script runs in its own workflow job, so a non-zero exit is what makes the
# failure visible; security-class outcomes use `exit 1` directly instead.
narrative_not_applied() {
  echo "::error::narrative-not-applied: $1"
  exit "$NARRATIVE_NOT_APPLIED_EXIT"
}

# Read the current release body; empty on any failure.
read_release_body() {
  gh release view "$RELEASE_VERSION" --json body --jq '.body' 2>/dev/null || true
}

# Scratch directory: the ONLY place the dispatched agent may write scratch files.
# The agent runs on a different runner, and its runtime denies every external
# path except $RUNNER_TEMP/fro-bot-response/*. The prompt therefore names the
# path with $RUNNER_TEMP left literal; the agent resolves it on its own runner
# and creates the directory there. Nothing is created on this runner.
# shellcheck disable=SC2016  # $RUNNER_TEMP must stay unexpanded
SCRATCH_PATH='$RUNNER_TEMP/fro-bot-response/release-notes'

# Idempotency: skip dispatch entirely when the release is already narrated.
BODY_BEFORE="$(read_release_body)"
if [[ "$BODY_BEFORE" == "$NARRATIVE_MARKER"* ]]; then
  echo "No-action-taken (already narrated; skipping dispatch): tag=$RELEASE_VERSION"
  exit 0
fi

# Generate a UUID to uniquely identify this dispatch. The token is passed as a
# workflow input field (correlation-id, declared on fro-bot.yaml) and remains
# visible in the dispatched run's inputs metadata for auditing. fro-bot.yaml's
# `run-name` embeds it in the run title, and the polling loop below matches on it
# (plus DISPATCH_EPOCH) so concurrent narrations never pick up each other's runs.
# Test escape hatch: integration tests set RELEASE_NOTES_TEST_CORRELATION_ID to
# a known UUID so mock-gh fixtures can assert it is forwarded verbatim through
# the -f correlation-id=... argument to gh workflow run.
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
# workflow-expression syntax (e.g. github.repository) here — those are only interpolated in
# workflow YAML, not inside this script, which runs on the runner after YAML preprocessing.
PROMPT=$(cat <<PROMPT_EOF
correlation=$CORRELATION_ID

You are running the release-notes-narrative skill against a just-published GitHub release.
The dispatching workflow identifies this run by timestamp via gh run list, so no
specific echo is required of you — the correlation value above is for audit only.

Target release tag: $RELEASE_VERSION
Target repository: $GITHUB_REPOSITORY

Scratch directory: $SCRATCH_PATH
- This is the ONLY directory you may write scratch files to (pre-edit snapshot, rendered
  body file, anything temporary). Do NOT write to /tmp, /tmp/opencode, or any other path;
  every other external path is denied.
- \$RUNNER_TEMP is resolved on your runner, not this one. Before using any file tool
  (which needs absolute paths), run \`echo "\$RUNNER_TEMP"\` and use the printed value
  in place of \$RUNNER_TEMP. Create the directory with \`mkdir -p\`.
- Set \`SCRATCH_DIR="$SCRATCH_PATH"\` (with \$RUNNER_TEMP expanded) before running the
  skill's bash snippets; the skill uses it in place of its default local paths.

Idempotency check (do this FIRST):
- Fetch the current release body: \`gh release view $RELEASE_VERSION --json body --jq '.body'\`
- If the body starts with the heading \`## What's new\`, the narrative has already been applied.
  Log "already-applied; short-circuiting" and exit cleanly. Conclusion will be reported as \`neutral\`.

Procedure (only if idempotency check did NOT short-circuit):
1. Load the skill at .agents/skills/release-notes-narrative/SKILL.md from this checkout.
2. Execute the 13-step procedure against tag $RELEASE_VERSION.
3. Apply the rendered body via \`gh release edit $RELEASE_VERSION --notes-file <file in the scratch directory>\`.

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
# fro-bot.yaml created strictly after this timestamp whose displayTitle contains
# our correlation id (fro-bot.yaml's run-name embeds the correlation-id input).
# The title match is what keeps concurrent narrations (different tags, manual
# re-narration) from selecting each other's runs.
#
# Previous strategy (log-scanning for correlation token echo) did not work in
# production: Fro Bot's agent takes several minutes to bootstrap (bun install,
# model download, MCP server startup) before it emits any prompt-derived log
# content, so a 90-second log scan budget completed before the correlation
# token ever appeared in the logs. Title/timestamp-based identification is robust
# against arbitrary agent boot times since gh run list reflects run creation
# time and title, not first-log time.
DISPATCH_EPOCH=$(date +%s)
if ! gh workflow run --ref main fro-bot.yaml \
  -f "prompt=$PROMPT" \
  -f "correlation-id=$CORRELATION_ID"; then
  narrative_not_applied "Workflow dispatch failed (correlation=$CORRELATION_ID)"
fi

# Poll up to 180 seconds for a workflow_dispatch run on fro-bot.yaml that was
# created strictly after DISPATCH_EPOCH with our correlation id in its title. Once
# found, this is our dispatched run.
# Test escape hatches: RELEASE_NOTES_TEST_POLL_BUDGET_SECS and
# RELEASE_NOTES_TEST_POLL_INTERVAL_SECS shorten the loop for unit tests.
# Production runs always use 180s budget / 5s interval.
POLL_BUDGET_SECS="${RELEASE_NOTES_TEST_POLL_BUDGET_SECS:-180}"
POLL_INTERVAL_SECS="${RELEASE_NOTES_TEST_POLL_INTERVAL_SECS:-5}"
RUN_ID=""
POLL_DEADLINE=$(( $(date +%s) + POLL_BUDGET_SECS ))
while [ "$(date +%s)" -lt "$POLL_DEADLINE" ]; do
  # Find the newest workflow_dispatch run on main whose createdAt is strictly
  # after DISPATCH_EPOCH. gh run list returns ISO-8601 timestamps; convert each
  # to epoch via `date -d` and compare numerically.
  # Only a run whose displayTitle carries OUR correlation id counts: fro-bot.yaml's
  # run-name embeds the id, so concurrent narrations for other tags (whose runs are
  # also newer than DISPATCH_EPOCH) are never picked up, watched, or log-scanned.
  # A failed lookup (transient gh/API error) must yield an empty candidate so the
  # loop sleeps and retries until POLL_DEADLINE, not abort under errexit/pipefail.
  CANDIDATE_ID="$(gh run list --workflow=fro-bot.yaml --branch=main --event=workflow_dispatch \
    --json databaseId,createdAt,displayTitle --limit 10 2>/dev/null \
    | jq -r --argjson cutoff "$DISPATCH_EPOCH" --arg cid "$CORRELATION_ID" \
      '[.[] | . + {epoch: (.createdAt | fromdateiso8601)}]
       | map(select(.epoch > $cutoff and ((.displayTitle // "") | contains($cid))))
        | sort_by(.epoch) | reverse | .[0].databaseId // empty' || true)"
  if [ -n "$CANDIDATE_ID" ] && [ "$CANDIDATE_ID" != "null" ]; then
    RUN_ID="$CANDIDATE_ID"
    break
  fi
  sleep "$POLL_INTERVAL_SECS"
done

if [ -z "$RUN_ID" ]; then
  narrative_not_applied "Dispatch was sent but its run could not be confirmed within ${POLL_BUDGET_SECS}s (correlation=$CORRELATION_ID, dispatched_at_epoch=$DISPATCH_EPOCH). The narration may still run asynchronously, but the release body was not verified."
fi

# Wait for the run to complete, hard-bounded at 10 minutes.
# Test escape hatch: RELEASE_NOTES_TEST_WATCH_TIMEOUT_SECS shortens the wait.
# Disable errexit around `timeout` so a non-zero exit (e.g., 124 for timeout)
# is captured into WATCH_EXIT rather than killing the script.
# No --exit-status: with it, gh exits non-zero for a failed or cancelled run, which
# would be misread below as an unexpected watch error (security class). Without it,
# WATCH_EXIT is 0 once the run completes, 124 on timeout, or a real gh/runner error;
# the outcome is classified from the run conclusion instead.
WATCH_TIMEOUT_SECS="${RELEASE_NOTES_TEST_WATCH_TIMEOUT_SECS:-600}"
set +e
timeout "$WATCH_TIMEOUT_SECS" gh run watch "$RUN_ID"
WATCH_EXIT=$?
set -e

# Fetch conclusion and full log (ANSI codes stripped) for classification. This runs
# whatever WATCH_EXIT is, so the security scans below also cover a timed-out run.
CONCLUSION="$(gh run view "$RUN_ID" --json conclusion --jq '.conclusion' 2>/dev/null || echo 'unknown')"
RAW_LOG=""
if ! RAW_LOG="$(gh run view "$RUN_ID" --log 2>/dev/null)"; then
  RAW_LOG=""
  echo "::warning::Run log unavailable (run=$RUN_ID); the text-based security scan (off-target edits, auth failures) was skipped. The release body re-read decides the outcome."
fi
LOG="$(printf '%s\n' "$RAW_LOG" | sed 's/\x1b\[[0-9;]*m//g')"

# Check for off-target release edits: any 'release edit vX.Y.Z' line that is NOT
# our target tag is a security signal (Fro Bot edited the wrong release).
OFF_TARGET="$(echo "$LOG" | grep -E 'release edit v[0-9]+\.[0-9]+\.[0-9]+' \
  | grep -v "release edit $RELEASE_VERSION" || true)"

# Check for auth/permission failure keywords in the log.
AUTH_FAIL=0
if echo "$LOG" | grep -qE 'HTTP 401|HTTP 403|Bad credentials|Resource not accessible|requires authentication|permission denied'; then
  AUTH_FAIL=1
fi

# Classify outcome by precedence. Security-relevant failures exit 1 with ::error::
# and always win, including over a timeout. Every other non-security outcome logs
# narrative-not-applied and exits 2. The only exit-0 path is success/neutral with a
# release body that starts with the marker, re-read from GitHub after the run (never
# trust the run conclusion alone).
# WATCH_EXIT semantics: 0 = run completed (classify by CONCLUSION below),
# 124 = timeout (narrative-not-applied), any other non-zero = unexpected (security-relevant).
# The "unexpected" branch covers runner crashes, gh CLI bugs, signal propagation, and
# any future gh run watch exit codes we haven't anticipated. Without this branch,
# an unexpected WATCH_EXIT falls through to CONCLUSION classification which may
# report "unknown" and silently exit 0.
if [ -n "$OFF_TARGET" ]; then
  echo "::error::Off-target release edit detected (run=$RUN_ID): $OFF_TARGET"
  exit 1
elif [ "$AUTH_FAIL" -eq 1 ]; then
  echo "::error::Auth failure in dispatched run (run=$RUN_ID, correlation=$CORRELATION_ID). Check FRO_BOT_PAT scope."
  exit 1
elif [ "$WATCH_EXIT" -eq 124 ]; then
  narrative_not_applied "Fro Bot run timed out after 10 minutes (run=$RUN_ID, correlation=$CORRELATION_ID)"
elif [ "$WATCH_EXIT" -ne 0 ]; then
  echo "::error::Unexpected gh run watch exit (WATCH_EXIT=$WATCH_EXIT, run=$RUN_ID, correlation=$CORRELATION_ID). May indicate a runner crash, gh CLI bug, or signal propagation."
  exit 1
elif [ "$CONCLUSION" = "action_required" ]; then
  echo "::error::Workflow requires manual intervention (run=$RUN_ID, conclusion=$CONCLUSION)"
  exit 1
elif [ "$CONCLUSION" = "skipped" ]; then
  echo "::error::Workflow was skipped — likely blocked by policy/branch protection (run=$RUN_ID)"
  exit 1
elif [ "$CONCLUSION" = "success" ] || [ "$CONCLUSION" = "neutral" ]; then
  BODY_AFTER="$(read_release_body)"
  if [[ "$BODY_AFTER" != "$NARRATIVE_MARKER"* ]]; then
    if [ "$BODY_AFTER" = "$BODY_BEFORE" ]; then
      narrative_not_applied "Run reported $CONCLUSION but the release body is unchanged (run=$RUN_ID, tag=$RELEASE_VERSION)"
    fi
    narrative_not_applied "Run reported $CONCLUSION but the release body does not start with '$NARRATIVE_MARKER' (run=$RUN_ID, tag=$RELEASE_VERSION)"
  fi
  if [ "$CONCLUSION" = "success" ]; then
    echo "Narrative applied: tag=$RELEASE_VERSION run=$RUN_ID correlation=$CORRELATION_ID"
  else
    echo "No-action-taken (already-applied idempotency short-circuit): tag=$RELEASE_VERSION run=$RUN_ID"
  fi
  exit 0
elif [ "$CONCLUSION" = "cancelled" ]; then
  narrative_not_applied "Workflow cancelled (run=$RUN_ID, correlation=$CORRELATION_ID)"
elif [ "$CONCLUSION" = "failure" ]; then
  narrative_not_applied "Fro Bot run failed (narrative-failure, no security signals detected): run=$RUN_ID"
else
  narrative_not_applied "Unknown conclusion: $CONCLUSION (run=$RUN_ID, correlation=$CORRELATION_ID)"
fi
