#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "=== Test: Plugin Loading ==="

source "$SCRIPT_DIR/setup.sh"
trap cleanup_test_env EXIT

echo "Test 1: Checking plugin file exists..."
if [ -f "$REPO_ROOT/dist/plugin/systematic.js" ]; then
    echo "  [PASS] Plugin file exists"
else
    echo "  [FAIL] Plugin file not found at dist/plugin/systematic.js"
    exit 1
fi

echo "Test 2: Checking plugin JavaScript syntax..."
if node --check "$REPO_ROOT/dist/plugin/systematic.js" 2>/dev/null; then
    echo "  [PASS] Plugin JavaScript syntax is valid"
else
    echo "  [FAIL] Plugin has JavaScript syntax errors"
    exit 1
fi

echo "Test 3: Checking dist/lib/skills-core.js exists..."
if [ -f "$REPO_ROOT/dist/lib/skills-core.js" ]; then
    echo "  [PASS] skills-core.js exists"
else
    echo "  [FAIL] skills-core.js not found"
    exit 1
fi

echo ""
echo "=== All plugin loading tests passed ==="
