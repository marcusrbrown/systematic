#!/usr/bin/env bash
# Mock for the `gh` CLI used in release-notes-ci integration tests.
#
# Behavior is driven by environment variables set per-scenario:
#
#   MOCK_GH_RUN_LIST_JSON          JSON array for `gh run list` output
#   MOCK_GH_RUN_VIEW_LOG           Log text for `gh run view --log`
#   MOCK_GH_RUN_VIEW_CONCLUSION    JSON for `gh run view --json conclusion`
#   MOCK_GH_RUN_WATCH_EXIT         Exit code for `gh run watch`
#   MOCK_GH_RELEASE_VIEW_BODY_LEN  Integer body length, returned only when `gh release view` is
#                                  called with a `--jq` expression containing `length` (legacy)
#   MOCK_GH_RELEASE_VIEW_BODY_BEFORE  Release body returned by `gh release view` until
#                                  `gh workflow run` has been called (default: raw notes)
#   MOCK_GH_RELEASE_VIEW_BODY_AFTER   Release body returned after `gh workflow run`
#                                  (default: same as BEFORE)
#   MOCK_GH_STATE_DIR              Directory for cross-invocation state (the dispatched flag);
#                                  when unset, AFTER is always returned if set, else BEFORE
#   MOCK_GH_WORKFLOW_RUN_EXIT      Non-zero exit code makes `gh workflow run` fail (dispatch failure)
#   MOCK_GH_WORKFLOW_RUN_PROMPT       File path where the dispatched prompt is written
#   MOCK_GH_WORKFLOW_RUN_CORRELATION  File path where the dispatched correlation-id is written
#
# Subcommand dispatch: $1 = top-level subcommand (workflow, run, release)

set -Eeuo pipefail

SUBCOMMAND="${1:-}"

case "$SUBCOMMAND" in

  workflow)
    # gh workflow run ...
    WORKFLOW_SUB="${2:-}"
    if [[ "$WORKFLOW_SUB" == "run" ]]; then
      # Capture the prompt argument if MOCK_GH_WORKFLOW_RUN_PROMPT is set.
      # Capture the correlation-id argument if MOCK_GH_WORKFLOW_RUN_CORRELATION is set.
      # The two captures are independent so scenarios can verify the dispatch
      # forwards both fields, not just the prompt.
      for arg in "$@"; do
        if [[ -n "${MOCK_GH_WORKFLOW_RUN_PROMPT:-}" && "$arg" == prompt=* ]]; then
          printf '%s' "${arg#prompt=}" > "$MOCK_GH_WORKFLOW_RUN_PROMPT"
        elif [[ -n "${MOCK_GH_WORKFLOW_RUN_CORRELATION:-}" && "$arg" == correlation-id=* ]]; then
          printf '%s' "${arg#correlation-id=}" > "$MOCK_GH_WORKFLOW_RUN_CORRELATION"
        fi
      done
      if [[ -n "${MOCK_GH_WORKFLOW_RUN_EXIT:-}" && "$MOCK_GH_WORKFLOW_RUN_EXIT" != "0" ]]; then
        echo "mock-gh: workflow dispatch failed" >&2
        exit "$MOCK_GH_WORKFLOW_RUN_EXIT"
      fi
      if [[ -n "${MOCK_GH_STATE_DIR:-}" ]]; then
        : > "$MOCK_GH_STATE_DIR/dispatched"
      fi
      echo "Created workflow_dispatch event for fro-bot.yaml at refs/heads/main"
      exit 0
    fi
    echo "mock-gh: unhandled workflow subcommand: $WORKFLOW_SUB" >&2
    exit 1
    ;;

  run)
    RUN_SUB="${2:-}"
    case "$RUN_SUB" in
      list)
        # gh run list --workflow=... --branch=... --json ... --limit ...
        echo "${MOCK_GH_RUN_LIST_JSON:-[]}"
        exit 0
        ;;
      view)
        # Detect --log vs --json conclusion vs plain view
        LOG_FLAG=0
        JSON_FLAG=0
        for arg in "$@"; do
          [[ "$arg" == "--log" ]] && LOG_FLAG=1
          [[ "$arg" == "--json" ]] && JSON_FLAG=1
        done

        if [[ "$LOG_FLAG" == "1" ]]; then
          echo "${MOCK_GH_RUN_VIEW_LOG:-}"
          exit 0
        fi

        if [[ "$JSON_FLAG" == "1" ]]; then
          CONCLUSION="${MOCK_GH_RUN_VIEW_CONCLUSION:-success}"
          # Check if --jq flag is present to extract just the value
          JQ_FLAG=0
          for arg in "$@"; do
            [[ "$arg" == "--jq" ]] && JQ_FLAG=1
          done
          if [[ "$JQ_FLAG" == "1" ]]; then
            # Return just the conclusion string (simulating jq extraction)
            echo "$CONCLUSION"
          else
            echo "{\"conclusion\":\"${CONCLUSION}\"}"
          fi
          exit 0
        fi

        # Plain view — not used in tests but handle gracefully
        echo "mock-gh: gh run view (plain) not mocked" >&2
        exit 1
        ;;
      watch)
        WATCH_EXIT="${MOCK_GH_RUN_WATCH_EXIT:-0}"
        exit "$WATCH_EXIT"
        ;;
      *)
        echo "mock-gh: unhandled run subcommand: $RUN_SUB" >&2
        exit 1
        ;;
    esac
    ;;

  release)
    RELEASE_SUB="${2:-}"
    case "$RELEASE_SUB" in
      view)
        # gh release view $TAG --json body --jq '.body'
        JQ_EXPR=""
        PREV_ARG=""
        for arg in "$@"; do
          [[ "$PREV_ARG" == "--jq" ]] && JQ_EXPR="$arg"
          PREV_ARG="$arg"
        done

        # Legacy length query (pre-marker script versions)
        if [[ "$JQ_EXPR" == *length* ]]; then
          echo "${MOCK_GH_RELEASE_VIEW_BODY_LEN:-800}"
          exit 0
        fi

        BODY_BEFORE="${MOCK_GH_RELEASE_VIEW_BODY_BEFORE-Raw auto-generated release notes}"
        BODY_AFTER="${MOCK_GH_RELEASE_VIEW_BODY_AFTER-$BODY_BEFORE}"
        if [[ -n "${MOCK_GH_STATE_DIR:-}" ]]; then
          if [[ -f "$MOCK_GH_STATE_DIR/dispatched" ]]; then
            printf '%s\n' "$BODY_AFTER"
          else
            printf '%s\n' "$BODY_BEFORE"
          fi
        else
          printf '%s\n' "${MOCK_GH_RELEASE_VIEW_BODY_AFTER-$BODY_BEFORE}"
        fi
        exit 0
        ;;
      *)
        echo "mock-gh: unhandled release subcommand: $RELEASE_SUB" >&2
        exit 1
        ;;
    esac
    ;;

  *)
    echo "mock-gh: unhandled subcommand: $SUBCOMMAND" >&2
    exit 1
    ;;
esac
