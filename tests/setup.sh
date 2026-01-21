#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export TEST_HOME=$(mktemp -d)
export HOME="$TEST_HOME"
export XDG_CONFIG_HOME="$TEST_HOME/.config"

echo "Building plugin..."
cd "$REPO_ROOT"
bun run build

echo "Setting up test environment..."
mkdir -p "$HOME/.config/opencode/systematic/skills"
mkdir -p "$HOME/.config/opencode/systematic/agents"
mkdir -p "$HOME/.config/opencode/systematic/commands"

# Copy built assets for testing
cp -r "$REPO_ROOT/skills" "$HOME/.config/opencode/systematic/" 2>/dev/null || mkdir -p "$HOME/.config/opencode/systematic/skills"
cp -r "$REPO_ROOT/agents" "$HOME/.config/opencode/systematic/" 2>/dev/null || mkdir -p "$HOME/.config/opencode/systematic/agents"
cp -r "$REPO_ROOT/commands" "$HOME/.config/opencode/systematic/" 2>/dev/null || mkdir -p "$HOME/.config/opencode/systematic/commands"

# Create test user skill
mkdir -p "$HOME/.config/opencode/systematic/skills/user-test"
cat >"$HOME/.config/opencode/systematic/skills/user-test/SKILL.md" <<'EOF'
---
name: user-test
description: Test user skill for verification
---
# User Test Skill
USER_SKILL_MARKER_12345
EOF

# Create test project
mkdir -p "$TEST_HOME/test-project/.opencode/systematic/skills/project-test"
cat >"$TEST_HOME/test-project/.opencode/systematic/skills/project-test/SKILL.md" <<'EOF'
---
name: project-test
description: Test project skill for verification
---
# Project Test Skill
PROJECT_SKILL_MARKER_67890
EOF

echo "Setup complete: $TEST_HOME"
export REPO_ROOT

cleanup_test_env() {
    if [ -n "${TEST_HOME:-}" ] && [ -d "$TEST_HOME" ]; then
        rm -rf "$TEST_HOME"
    fi
}
export -f cleanup_test_env
