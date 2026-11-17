#!/usr/bin/env bash
# run-arm.sh — run one arm of the with/without-Systematic evaluation in an
# isolated OpenCode session and capture the full JSON transcript.
#
# Usage:
#   run-arm.sh <baseline|treatment> <model> <prompt-file> <out-dir>
#
# Isolation is the minimum that keeps the user's config out of both arms while
# OpenCode's auth and model catalog keep working (see
# .agents/skills/running-with-without-evals/SKILL.md):
#   - HOME=<private temp>  so os.homedir() has an empty .config/opencode; this is
#     what keeps the user's systematic.jsonc (agent/model overlays) out of the
#     treatment arm, because Systematic reads <homedir>/.config/opencode itself
#   - OPENCODE_CONFIG_DIR=<empty temp>  (a second, empty custom config dir)
#   - OPENCODE_CONFIG_CONTENT controls the plugin array per arm
#   - paid model (free models rate-limit and masquerade as failures)
#   - --format json captures the raw event stream
#
# A private HOME also flattens per-agent routing: every subagent runs the arm
# model. <arm>.models.txt records what actually ran.
#
# baseline arm:  --pure + {"plugin":[]}            → Systematic MUST be absent
# treatment arm: {"plugin":["file://dist/index.js"]} → Systematic MUST be present
#
# CLIProxy route (opt-in): when CLIPROXY_API_KEY is set, both arms declare the
# built-in anthropic and openai providers with baseURL https://cliproxy.fro.bot/v1
# (same block in both arms; the plugin array stays the only arm difference), so
# the model is the usual provider/model id, e.g. anthropic/claude-sonnet-5-5. The
# key goes only into a mode-0600 auth.json in a private data dir that is deleted
# on exit. It never reaches argv, config, logs, or opencode's environment, and
# the run fails after scanning <out-dir> for it if it shows up. Unset = default
# route (the real XDG_DATA_HOME auth.json).
#
# After each run, <out-dir>/<arm>.models.txt lists the model of every child
# (task) session the run spawned, so a report can state which models ran.
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
command -v jq >/dev/null || { echo "ERROR: jq is required (model extraction, CLIProxy config)"; exit 1; }

mkdir -p "$OUT_DIR"
CONFIG_DIR="$(mktemp -d)"
PROJECT_DIR="$(mktemp -d)"     # fresh empty workspace, same shape for both arms
# Both arms run under a private temp HOME. Redirecting only XDG_CONFIG_HOME is
# not enough: Systematic reads its user config from <os.homedir()>/.config/opencode
# (plus OPENCODE_CONFIG_DIR), so the real ~/.config/opencode/systematic.jsonc
# would still reach the treatment arm and re-route subagents to other models.
# A private HOME makes homedir() point at an empty .config/opencode. It also
# hides the user's global opencode.json (MCP servers) and ~/.agents, ~/.claude
# skill dirs from both arms.
# The data and cache dirs are pinned to the user's real ones, because they hold
# auth.json (authenticates the paid model) and the models.dev catalog (resolves
# the model id); redirecting them gives ProviderModelNotFoundError. auth.json is
# read in place, never copied (except on the CLIProxy route, which uses a private
# data dir instead). Both arms get the same treatment; treatment adds Systematic
# through the plugin array.
REAL_HOME="$HOME"
PRIVATE_HOME="$(mktemp -d)"
mkdir -p "$PRIVATE_HOME/.config/opencode"
REAL_XDG_DATA_HOME="${XDG_DATA_HOME:-$REAL_HOME/.local/share}"
REAL_XDG_CACHE_HOME="${XDG_CACHE_HOME:-$REAL_HOME/.cache}"
trap 'rm -rf "$CONFIG_DIR" "$PROJECT_DIR" "$PRIVATE_HOME"' EXIT

CLIPROXY_URL="https://cliproxy.fro.bot/v1"
DATA_HOME="$REAL_XDG_DATA_HOME"
PROVIDER_JSON='{}'
PERMISSION_JSON='{}'
if [ -n "${CLIPROXY_API_KEY:-}" ]; then
  DATA_HOME="$PRIVATE_HOME/data"
  mkdir -p "$DATA_HOME/opencode"
  # The key reaches jq through its environment, never argv, and lands only in
  # this mode-0600 file.
  ( umask 077; jq -n '{anthropic: {type: "api", key: env.CLIPROXY_API_KEY}, openai: {type: "api", key: env.CLIPROXY_API_KEY}}' >"$DATA_HOME/opencode/auth.json" )
  PROVIDER_JSON="{\"anthropic\":{\"options\":{\"baseURL\":\"$CLIPROXY_URL\"}},\"openai\":{\"options\":{\"baseURL\":\"$CLIPROXY_URL\"}}}"
  PERMISSION_JSON='{"read":{"*":"allow","**/auth.json":"deny"}}'
fi

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
if [ -n "${CLIPROXY_API_KEY:-}" ]; then
  PLUGIN_JSON="$(jq -c --argjson p "$PROVIDER_JSON" --argjson perm "$PERMISSION_JSON" '. + {provider: $p, permission: $perm}' <<<"$PLUGIN_JSON")"
fi

echo "=== arm=$ARM model=$MODEL ==="
echo "config_dir=$CONFIG_DIR project_dir=$PROJECT_DIR private_home=$PRIVATE_HOME"
echo "data_home=$DATA_HOME cache_home=$REAL_XDG_CACHE_HOME route=$([ -n "${CLIPROXY_API_KEY:-}" ] && echo cliproxy || echo auth.json)"
echo "plugin_json=$PLUGIN_JSON pure=${PURE_FLAG:-<none>}"

set +e
HOME="$PRIVATE_HOME" \
XDG_CONFIG_HOME="$PRIVATE_HOME/.config" \
XDG_DATA_HOME="$DATA_HOME" \
XDG_CACHE_HOME="$REAL_XDG_CACHE_HOME" \
OPENCODE_CONFIG_DIR="$CONFIG_DIR" \
OPENCODE_CONFIG_CONTENT="$PLUGIN_JSON" \
env -u CLIPROXY_API_KEY opencode run $PURE_FLAG --format json --print-logs --log-level INFO \
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

# CLIProxy route: the key must not appear in any file under the output dir.
# This runs before model extraction, so every run that wrote output is scanned.
MODELS="$OUT_DIR/$ARM.models.txt"
if [ -n "${CLIPROXY_API_KEY:-}" ]; then
  NEEDLE="$PRIVATE_HOME/needle"
  ( umask 077; printf %s "$CLIPROXY_API_KEY" >"$NEEDLE" )
  # grep exits 0 on a match, 1 on none, >1 when the scan itself failed.
  set +e
  LEAKS="$(grep -rlF -f "$NEEDLE" "$OUT_DIR")"
  SCAN_RC=$?
  set -e
  if [ "$SCAN_RC" -gt 1 ]; then
    echo "ERROR: key scan of $OUT_DIR failed (grep exit $SCAN_RC); deleting this arm's output"
    rm -f "$JSONL" "$LOG" "$MODELS"
    exit 4
  fi
  KEY_LEAK_FILES="$(printf '%s' "$LEAKS" | grep -c . || true)"
  echo "key_leak_files=$KEY_LEAK_FILES"
  if [ "$KEY_LEAK_FILES" -ne 0 ]; then
    echo "ERROR: the CLIProxy key appears in $KEY_LEAK_FILES file(s) under $OUT_DIR; deleting this arm's output"
    rm -f "$JSONL" "$LOG" "$MODELS"
    exit 4
  fi
fi

# Effective routing: model of every child (task) session, one line each as
# "<provider>/<model>\t<subagent_type>\t<child session id>". The file exists
# even when the run spawned no children (empty file = no subagents ran).
if ! jq -rR 'fromjson?
  | select(.part.tool == "task" and (.part.state.metadata.model // null) != null)
  | .part.state
  | [(.metadata.model.providerID + "/" + .metadata.model.modelID),
     (.input.subagent_type // "-"),
     (.metadata.sessionId // "-")]
  | @tsv' "$JSONL" >"$MODELS.raw"; then
  echo "ERROR: model extraction failed; $MODELS not written"
  rm -f "$MODELS.raw" "$MODELS"
  exit 5
fi
sort -u "$MODELS.raw" >"$MODELS"
rm -f "$MODELS.raw"
echo "child models ($(wc -l <"$MODELS" | tr -d ' ') sessions) → $MODELS"

exit "$RC"
