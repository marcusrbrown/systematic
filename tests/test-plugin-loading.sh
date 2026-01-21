#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "=== Test: Plugin Loading ==="

source "$SCRIPT_DIR/setup.sh"
trap cleanup_test_env EXIT

echo "Test 1: Checking plugin file exists..."
if [ -f "$REPO_ROOT/dist/index.js" ]; then
    echo "  [PASS] Plugin file exists"
else
    echo "  [FAIL] Plugin file not found at dist/index.js"
    exit 1
fi

echo "Test 2: Checking plugin JavaScript syntax..."
if node --check "$REPO_ROOT/dist/index.js" 2>/dev/null; then
    echo "  [PASS] Plugin JavaScript syntax is valid"
else
    echo "  [FAIL] Plugin has JavaScript syntax errors"
    exit 1
fi

echo "Test 3: Checking dist/cli.js exists..."
if [ -f "$REPO_ROOT/dist/cli.js" ]; then
    echo "  [PASS] cli.js exists"
else
    echo "  [FAIL] cli.js not found"
    exit 1
fi

echo "Test 4: Checking bundled skills exist at top level..."
if [ -d "$REPO_ROOT/skills" ] && [ -d "$REPO_ROOT/agents" ] && [ -d "$REPO_ROOT/commands" ]; then
    echo "  [PASS] bundled content directories exist"
else
    echo "  [FAIL] bundled content directories not found at top level"
    exit 1
fi

echo ""
echo "=== All plugin loading tests passed ==="
