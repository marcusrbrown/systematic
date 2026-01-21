#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo " Systematic Plugin Test Suite"
echo "========================================"
echo ""

tests=(
    "test-plugin-loading.sh"
    "test-skills-core.sh"
)

passed=0
failed=0

for test in "${tests[@]}"; do
    echo "----------------------------------------"
    echo "Running: $test"
    echo "----------------------------------------"

    if [ ! -f "$SCRIPT_DIR/$test" ]; then
        echo "  [SKIP] Test file not found"
        continue
    fi

    chmod +x "$SCRIPT_DIR/$test"

    if bash "$SCRIPT_DIR/$test"; then
        echo "  [PASS]"
        passed=$((passed + 1))
    else
        echo "  [FAIL]"
        failed=$((failed + 1))
    fi
    echo ""
done

echo "========================================"
echo " Results: $passed passed, $failed failed"
echo "========================================"

if [ $failed -gt 0 ]; then
    exit 1
fi
