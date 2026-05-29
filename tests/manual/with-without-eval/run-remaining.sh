#!/usr/bin/env bash
# run-remaining.sh — runs the 7 remaining eval trials sequentially (council's cut):
#   OAuth: gpt-5.5 {baseline,treatment} + kimi {baseline,treatment}
#   Controls (headline cell = gpt-5.5 DB migration):
#     - prompt-parity baseline (no plugin, workflow-worded prompt)
#     - baseline variance run #2 and #3
# Sequential to avoid rate-limit contention between concurrent frontier sessions.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
R=./run-arm.sh

run() { echo ""; echo "########## $1 ##########"; shift; "$R" "$@" 2>&1 | tail -5; echo "rc=${PIPESTATUS[0]}"; }

# OAuth — gpt-5.5
run "OAuth gpt-5.5 baseline"   baseline  openai/gpt-5.5        task-oauth-baseline.txt   results-oauth
run "OAuth gpt-5.5 treatment"  treatment openai/gpt-5.5        task-oauth-treatment.txt  results-oauth
# OAuth — kimi
run "OAuth kimi baseline"      baseline  opencode-go/kimi-k2.6 task-oauth-baseline.txt   results-oauth-kimi
run "OAuth kimi treatment"     treatment opencode-go/kimi-k2.6 task-oauth-treatment.txt  results-oauth-kimi
# Controls on headline cell (gpt-5.5 DB migration)
run "DB prompt-parity (no plugin, workflow-worded)" baseline openai/gpt-5.5 task-db-promptparity.txt results-promptparity
run "DB baseline variance #2"  baseline  openai/gpt-5.5        task-baseline.txt         results-var2
run "DB baseline variance #3"  baseline  openai/gpt-5.5        task-baseline.txt         results-var3

echo ""; echo "########## ALL 7 RUNS COMPLETE ##########"
