#!/usr/bin/env bash
# Mock for the `gh` CLI used in release-notes-ci integration tests.
#
# Behavior is driven by environment variables set per-scenario:
#
#   MOCK_GH_RUN_LIST_JSON          JSON array for `gh run list` output
#   MOCK_GH_RUN_VIEW_LOG           Log text for `gh run view --log`
#   MOCK_GH_RUN_VIEW_CONCLUSION    JSON for `gh run view --json conclusion`
#   MOCK_GH_RUN_WATCH_EXIT         Exit code for `gh run watch`
#   MOCK_GH_RELEASE_VIEW_BODY_LEN  Integer body length for `gh release view --json body`
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
        # gh release view $TAG --json body --jq '.body | length'
        BODY_LEN="${MOCK_GH_RELEASE_VIEW_BODY_LEN:-800}"
        echo "$BODY_LEN"
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
