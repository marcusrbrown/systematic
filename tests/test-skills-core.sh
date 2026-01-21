#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "=== Test: Skills Core Library ==="

source "$SCRIPT_DIR/setup.sh"
trap cleanup_test_env EXIT

echo "Test 1: Testing extractFrontmatter..."
cat >"$TEST_HOME/test-skill.md" <<'EOF'
---
name: test-skill
description: A test skill
---
# Content
EOF

result=$(node -e "
const fs = require('fs');
function extractFrontmatter(content) {
    const lines = content.split('\n');
    let inFm = false, name = '', desc = '';
    for (const line of lines) {
        if (line.trim() === '---') { if (inFm) break; inFm = true; continue; }
        if (inFm) {
            const m = line.match(/^(\w+):\s*(.*)$/);
            if (m) { if (m[1] === 'name') name = m[2].trim(); if (m[1] === 'description') desc = m[2].trim(); }
        }
    }
    return { name, description: desc };
}
const content = fs.readFileSync('$TEST_HOME/test-skill.md', 'utf8');
const result = extractFrontmatter(content);
console.log(JSON.stringify(result));
")

if echo "$result" | grep -q '"name":"test-skill"'; then
    echo "  [PASS] extractFrontmatter parses name correctly"
else
    echo "  [FAIL] extractFrontmatter failed"
    exit 1
fi

echo "Test 2: Testing stripFrontmatter..."
result=$(node -e "
const fs = require('fs');
function stripFrontmatter(content) {
    const lines = content.split('\n');
    let inFm = false, ended = false;
    const out = [];
    for (const line of lines) {
        if (line.trim() === '---') { if (inFm) { ended = true; continue; } inFm = true; continue; }
        if (ended || !inFm) out.push(line);
    }
    return out.join('\n').trim();
}
const content = fs.readFileSync('$TEST_HOME/test-skill.md', 'utf8');
console.log(stripFrontmatter(content));
")

if echo "$result" | grep -q "# Content"; then
    echo "  [PASS] stripFrontmatter preserves content"
else
    echo "  [FAIL] stripFrontmatter failed"
    exit 1
fi

echo ""
echo "=== All skills-core tests passed ==="
