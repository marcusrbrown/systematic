#!/usr/bin/env bash
# run-arm.sh — run one arm of the with/without-Systematic evaluation in an
# isolated OpenCode session and capture the full JSON transcript.
#
# Usage:
#   run-arm.sh <baseline|treatment> <model> <prompt-file> <out-dir>
#
# Isolation follows the "minimum that matters" recipe
# (docs/solutions/best-practices/reliable-cli-integration-testing-2026-04-26.md):
#   - OPENCODE_CONFIG_DIR=<empty temp>  skips the user's ~/.config/opencode
#   - OPENCODE_CONFIG_CONTENT controls the plugin array per arm
#   - paid model (free models rate-limit and masquerade as failures)
#   - --format json captures the raw event stream
#
# baseline arm:  --pure + {"plugin":[]}            → Systematic MUST be absent
# treatment arm: {"plugin":["file://dist/index.js"]} → Systematic MUST be present
set -euo pipefail

ARM="${1:?arm required: baseline|treatment}"
MODEL="${2:?model required, e.g. openai/gpt-5.5}"
PROMPT_FILE="${3:?prompt file required}"
OUT_DIR="${4:?output dir required}"
SEED_DIR="${5:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DIST_PLUGIN="$REPO_ROOT/dist/index.js"

[ -f "$DIST_PLUGIN" ] || { echo "ERROR: $DIST_PLUGIN missing — run 'bun run build'"; exit 1; }
[ -f "$PROMPT_FILE" ] || { echo "ERROR: prompt file $PROMPT_FILE missing"; exit 1; }

mkdir -p "$OUT_DIR"
CONFIG_DIR="$(mktemp -d)"
PROJECT_DIR="$(mktemp -d)"     # fresh empty workspace, same shape for both arms
# Vanilla isolation: redirect ONLY XDG_CONFIG_HOME so the user's global
# ~/.config/opencode/opencode.json (which defines MCP servers like context7,
# tavily, etc.) does NOT leak into either arm. We deliberately do NOT redirect
# XDG_DATA_HOME (holds auth.json — needed to authenticate the paid model) or
# XDG_CACHE_HOME (holds the models.dev catalog — needed to resolve openai/gpt-5.5).
# Redirecting those breaks provider/model resolution (ProviderModelNotFoundError).
# Both arms get the same vanilla config; treatment adds Systematic via the plugin array.
XDG_CONFIG="$(mktemp -d)"
trap 'rm -rf "$CONFIG_DIR" "$PROJECT_DIR" "$XDG_CONFIG"' EXIT

if [ -n "$SEED_DIR" ]; then
  [ -d "$SEED_DIR" ] || { echo "ERROR: seed dir $SEED_DIR missing"; exit 1; }
  cp -R "$SEED_DIR"/. "$PROJECT_DIR"/
  echo "seeded project_dir from $SEED_DIR"
fi

PROMPT="$(cat "$PROMPT_FILE")"
JSONL="$OUT_DIR/$ARM.jsonl"
LOG="$OUT_DIR/$ARM.log"

if [ "$ARM" = "baseline" ]; then
  PLUGIN_JSON='{"plugin":[],"snapshot":false}'
  PURE_FLAG="--pure"
else
  PLUGIN_JSON="{\"plugin\":[\"file://$DIST_PLUGIN\"],\"snapshot\":false}"
  PURE_FLAG=""
fi

echo "=== arm=$ARM model=$MODEL ==="
echo "config_dir=$CONFIG_DIR project_dir=$PROJECT_DIR"
echo "plugin_json=$PLUGIN_JSON pure=${PURE_FLAG:-<none>}"

set +e
OPENCODE_CONFIG_DIR="$CONFIG_DIR" \
OPENCODE_CONFIG_CONTENT="$PLUGIN_JSON" \
XDG_CONFIG_HOME="$XDG_CONFIG" \
opencode run $PURE_FLAG --format json --print-logs --log-level INFO \
  -m "$MODEL" --dir "$PROJECT_DIR" "$PROMPT" >"$JSONL" 2>"$LOG"
RC=$?
set -e

echo "exit=$RC  jsonl_bytes=$(wc -c <"$JSONL")  log_bytes=$(wc -c <"$LOG")"

# Plugin-load verification: did systematic_skill register / get used?
SYS_HITS=$({ grep -c 'systematic_skill' "$JSONL" "$LOG" 2>/dev/null || true; } | awk -F: '{s+=$2} END{print s+0}')
if [ "$ARM" = "baseline" ]; then
  if [ "$SYS_HITS" -eq 0 ]; then echo "✓ baseline clean (no systematic_skill)"; else echo "✗ baseline CONTAMINATED ($SYS_HITS systematic_skill hits)"; fi
else
  if [ "$SYS_HITS" -gt 0 ]; then echo "✓ treatment loaded Systematic ($SYS_HITS systematic_skill hits)"; else echo "⚠ treatment shows no systematic_skill — verify plugin load"; fi
fi

exit "$RC"
